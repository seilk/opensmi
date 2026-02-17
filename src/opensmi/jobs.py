from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .config import load_config
from .models import ClusterConfig, NodeConfig
from .sshutil import ssh_run
from .state import ensure_state_dir

JOBS_FILENAME = "jobs.json"


@dataclass
class Job:
    """Job data model for GPU workload tracking.

    Represents a submitted GPU job with full lifecycle tracking from submission
    to completion. Supports both immediate execution and queued auto-dispatch modes.
    """

    id: str  # 8-character short uuid
    command: str  # Command for single distribution mode
    commands: List[str] = field(default_factory=list)  # Commands for one-to-one mode
    gpus: List[Tuple[str, int]] = field(
        default_factory=list
    )  # [(node_alias, gpu_idx), ...]
    requested_gpu_count: int = 0  # For queued mode: number of GPUs needed
    dist_mode: str = "single"  # "single" | "one-to-one"
    exec_mode: str = "tmux"  # "direct" | "tmux"
    tmux_sessions: List[str] = field(default_factory=list)  # Created tmux session names
    status: str = "queued"  # "queued" | "running" | "done" | "failed" | "cancelled"
    submitted_at: str = ""  # ISO timestamp
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    exit_codes: List[int] = field(default_factory=list)  # Exit code per GPU
    error: Optional[str] = None
    user: str = ""  # OPERATOR who submitted the job
    restart_policy: str = "never"  # "never" | "on-failure" | "always"
    retry_count: int = 0
    max_retries: int = 3
    tags: List[str] = field(default_factory=list)  # User-defined tags
    queue_mode: str = "immediate"  # "immediate" | "queued"

    @staticmethod
    def new_id() -> str:
        """Generate a new 8-character job ID."""
        return uuid.uuid4().hex[:8]


# ============================================================================
# Job Store Functions
# ============================================================================


def jobs_path(state_dir: Path) -> Path:
    """Get path to jobs.json file."""
    return state_dir / JOBS_FILENAME


def load_jobs(state_dir: Path) -> List[Job]:
    """Load all jobs from persistent storage.

    Returns:
        List of Job objects, or empty list if file doesn't exist or is invalid
    """
    path = jobs_path(state_dir)
    if not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        jobs_data = data.get("jobs", [])
        return [Job(**j) for j in jobs_data]
    except (json.JSONDecodeError, ValueError, OSError, TypeError):
        return []


def save_jobs(state_dir: Path, jobs: List[Job]) -> None:
    """Save all jobs to persistent storage.

    Args:
        state_dir: State directory path
        jobs: List of Job objects to save
    """
    ensure_state_dir(state_dir)
    path = jobs_path(state_dir)
    serializable = {"jobs": [asdict(j) for j in jobs]}
    with path.open("w", encoding="utf-8") as f:
        json.dump(serializable, f, indent=2)


def upsert_job(jobs: List[Job], job: Job) -> List[Job]:
    """Insert or update a job in the list.

    If a job with the same ID exists, it is replaced. Otherwise, the job is appended.

    Args:
        jobs: Current list of jobs
        job: Job to insert or update

    Returns:
        New list with the job upserted
    """
    out = [j for j in jobs if j.id != job.id]
    out.append(job)
    return out


def get_job(jobs: List[Job], job_id: str) -> Optional[Job]:
    """Get a job by ID.

    Args:
        jobs: List of jobs to search
        job_id: Job ID to find

    Returns:
        Job object if found, None otherwise
    """
    for j in jobs:
        if j.id == job_id:
            return j
    return None


# ============================================================================
# Job Health Checking
# ============================================================================


async def check_job_alive(job: Job, cfg: ClusterConfig) -> bool:
    """Check if a job is still running by verifying its tmux sessions.

    For tmux jobs, this checks if any of the job's tmux sessions still exist
    on their respective nodes via SSH.

    Args:
        job: Job to check
        cfg: Cluster configuration for node access

    Returns:
        True if at least one tmux session is alive, False otherwise
    """
    if job.exec_mode != "tmux" or not job.tmux_sessions:
        return False

    for session_name in job.tmux_sessions:
        # Get the node for this session (assuming first GPU's node)
        node_alias = job.gpus[0][0] if job.gpus else None
        if not node_alias:
            continue

        # Find node config
        node = None
        for n in cfg.nodes:
            if n.alias == node_alias:
                node = n
                break
        if not node:
            continue

        # Check if tmux session exists
        try:
            rc, _, _ = await ssh_run(
                node, ["tmux", "has-session", "-t", session_name], timeout_s=5
            )
            if rc == 0:
                return True
        except Exception:
            continue

    return False


# ============================================================================
# Job Lifecycle Operations
# ============================================================================


async def cancel_job(job: Job, cfg: ClusterConfig) -> bool:
    """Cancel a running or queued job.

    For running jobs, this kills their tmux sessions. For queued jobs,
    it simply marks them as cancelled.

    Args:
        job: Job to cancel
        cfg: Cluster configuration for node access

    Returns:
        True if cancellation succeeded, False if job wasn't in a cancellable state
    """
    if job.status not in ("running", "queued"):
        return False

    # Queued jobs can be cancelled immediately
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = datetime.now(timezone.utc).isoformat()
        return True

    # Running jobs: kill their tmux sessions
    for session in job.tmux_sessions:
        node_alias = job.gpus[0][0] if job.gpus else None
        if not node_alias:
            continue

        # Find node config
        node = None
        for n in cfg.nodes:
            if n.alias == node_alias:
                node = n
                break
        if not node:
            continue

        # Kill tmux session
        try:
            await ssh_run(node, ["tmux", "kill-session", "-t", session], timeout_s=5)
        except Exception:
            pass

    job.status = "cancelled"
    job.finished_at = datetime.now(timezone.utc).isoformat()
    return True


def retry_job(job: Job) -> Job:
    """Create a new job from a failed or cancelled job for retry.

    This creates a fresh job with the same parameters but a new ID,
    allowing the original job to remain in history.

    Args:
        job: Job to retry

    Returns:
        New Job object ready to be queued
    """
    new_job = Job(
        id=Job.new_id(),
        command=job.command,
        commands=list(job.commands),
        gpus=list(job.gpus),  # Retry on same GPUs
        requested_gpu_count=job.requested_gpu_count,
        dist_mode=job.dist_mode,
        exec_mode=job.exec_mode,
        status="queued",
        submitted_at=datetime.now(timezone.utc).isoformat(),
        user=job.user,
        restart_policy=job.restart_policy,
        tags=list(job.tags),
        queue_mode=job.queue_mode,
    )
    return new_job
