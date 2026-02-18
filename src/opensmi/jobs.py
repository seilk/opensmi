from __future__ import annotations

import asyncio
import fcntl
import json
import os
import re
import shutil
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, List, Optional, Tuple

from .config import load_config
from .models import ClusterConfig, NodeConfig
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


@contextmanager
def _lock_jobs_file(state_dir: Path) -> Iterator[None]:
    """Context manager for file locking jobs.json during concurrent access.

    Uses fcntl.flock for advisory locking to prevent race conditions when
    both CLI and TUI access jobs.json simultaneously.
    """
    ensure_state_dir(state_dir)
    lock_path = state_dir / f"{JOBS_FILENAME}.lock"

    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def load_jobs(state_dir: Path) -> List[Job]:
    """Load all jobs from persistent storage.

    Returns:
        List of Job objects, or empty list if file doesn't exist or is invalid
    """
    path = jobs_path(state_dir)
    if not path.exists():
        return []

    try:
        with _lock_jobs_file(state_dir):
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            jobs_data = data.get("jobs", [])
            return [Job(**j) for j in jobs_data]
    except (json.JSONDecodeError, ValueError, OSError, TypeError):
        return []


def save_jobs(state_dir: Path, jobs: List[Job]) -> None:
    """Save all jobs to persistent storage with atomic write.

    Uses file locking and atomic replace to prevent corruption from concurrent access.

    Args:
        state_dir: State directory path
        jobs: List of Job objects to save
    """
    ensure_state_dir(state_dir)
    path = jobs_path(state_dir)

    with _lock_jobs_file(state_dir):
        serializable = {"jobs": [asdict(j) for j in jobs]}

        # Atomic write via temp file + rename
        fd, tmp_path = tempfile.mkstemp(prefix=f"{JOBS_FILENAME}.", dir=str(state_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(serializable, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass


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


def _find_tmux_binary() -> str:
    """Find tmux binary, checking common paths if not in PATH."""
    tmux = shutil.which("tmux")
    if tmux:
        return tmux
    for candidate in [
        "/opt/homebrew/bin/tmux",
        "/usr/local/bin/tmux",
        "/usr/bin/tmux",
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return "tmux"  # fallback, let OS raise if truly missing


async def check_gpu_liveness(
    job: Job, cfg: ClusterConfig
) -> dict[str, bool]:
    """Check which of the job's tmux sessions have live remote processes.

    Each tmux session writes a PID file on the remote node at
    /tmp/opensmi-<session>.pid. We SSH to each node and check
    `kill -0 <pid>` which is near-zero overhead (no nvidia-smi).

    Returns a dict mapping "node:gpu_idx" → alive (bool).
    """
    from .sshutil import ssh_run
    from .logging import get_logger
    log = get_logger(__name__)

    result: dict[str, bool] = {}

    for node_alias, gpu_idx in job.gpus:
        result[f"{node_alias}:{gpu_idx}"] = False

    if not job.tmux_sessions:
        log.info("watchdog: job %s has no tmux sessions, skipping", job.id)
        return result

    # Map sessions → GPUs.
    # Strategy: positional mapping (session[i] → gpu[i]) as primary,
    # since that's how both CLI and TUI create them.
    # For single-session jobs (1 session, N GPUs), that session covers all GPUs.
    session_gpu: dict[str, list[tuple[str, int]]] = {}

    if len(job.tmux_sessions) == len(job.gpus):
        # 1:1 mapping
        for i, session_name in enumerate(job.tmux_sessions):
            node_alias, gpu_idx = job.gpus[i]
            session_gpu.setdefault(session_name, []).append((node_alias, gpu_idx))
    elif len(job.tmux_sessions) == 1:
        # Single session covers all GPUs
        session_name = job.tmux_sessions[0]
        for node_alias, gpu_idx in job.gpus:
            session_gpu.setdefault(session_name, []).append((node_alias, gpu_idx))
    else:
        # Mismatch — best effort positional
        log.warning("watchdog: job %s session count (%d) != gpu count (%d), best-effort mapping",
                     job.id, len(job.tmux_sessions), len(job.gpus))
        for i, session_name in enumerate(job.tmux_sessions):
            if i < len(job.gpus):
                node_alias, gpu_idx = job.gpus[i]
                session_gpu.setdefault(session_name, []).append((node_alias, gpu_idx))

    # Group by node for batch SSH
    # node_alias → [(session_name, gpu_idx)]
    node_checks: dict[str, list[tuple[str, int]]] = {}
    for session_name, gpu_list in session_gpu.items():
        for node_alias, gpu_idx in gpu_list:
            node_checks.setdefault(node_alias, []).append((session_name, gpu_idx))

    for node_alias, checks_list in node_checks.items():
        node_cfg = None
        for n in cfg.nodes:
            if n.alias == node_alias:
                node_cfg = n
                break
        if not node_cfg:
            log.warning("watchdog: node %s not found in config", node_alias)
            continue

        # Build a single SSH script that checks all PID files for this node
        # Output: "ALIVE:<gpu_idx>" for each live process
        checks = []
        for session_name, gpu_idx in checks_list:
            # Sanitize session name for safe use in SSH remote commands
            safe_session = re.sub(r'[^a-zA-Z0-9_\-]', '-', session_name)
            pid_file = f"/tmp/opensmi-{safe_session}.pid"
            checks.append(
                f'if [ -f {pid_file} ] && kill -0 $(cat {pid_file}) 2>/dev/null; '
                f'then echo "ALIVE:{gpu_idx}"; fi'
            )
        check_script = "; ".join(checks)
        log.debug("watchdog: job %s node %s script: %s", job.id, node_alias, check_script)

        try:
            # Pass script via stdin to avoid remote shell (zsh/etc) parsing issues
            rc, stdout, _stderr = await ssh_run(
                node_cfg,
                ["bash"],
                stdin_bytes=check_script.encode("utf-8"),
                timeout_s=8,
            )
            log.debug("watchdog: job %s node %s rc=%d stdout=%r", job.id, node_alias, rc, stdout.strip())

            for line in stdout.strip().splitlines():
                line = line.strip()
                if line.startswith("ALIVE:"):
                    try:
                        idx = int(line.split(":")[1])
                        key = f"{node_alias}:{idx}"
                        if key in result:
                            result[key] = True
                    except (ValueError, IndexError):
                        pass
        except Exception:
            continue

    # Fallback: if PID check says all dead, verify with nvidia-smi on each node.
    # This catches DataParallel/multiprocessing cases where the parent PID exits
    # but child processes keep running on GPUs.
    if not any(result.values()) and job.gpus:
        log.info("watchdog: PID check says all dead for job %s, verifying with nvidia-smi", job.id)
        # Group GPUs by node
        node_gpus: dict[str, list[int]] = {}
        for node_alias, gpu_idx in job.gpus:
            node_gpus.setdefault(node_alias, []).append(gpu_idx)

        for node_alias, gpu_indices in node_gpus.items():
            node_cfg = None
            for n in cfg.nodes:
                if n.alias == node_alias:
                    node_cfg = n
                    break
            if not node_cfg:
                continue

            # Query nvidia-smi for compute processes on specific GPUs
            gpu_ids = ",".join(str(g) for g in gpu_indices)
            nvsmi_script = (
                f'nvidia-smi --id={gpu_ids} '
                f'--query-compute-apps=gpu_uuid,pid '
                f'--format=csv,noheader,nounits 2>/dev/null && echo "__OK__"'
            )
            try:
                rc, stdout, _stderr = await ssh_run(
                    node_cfg,
                    ["bash"],
                    stdin_bytes=nvsmi_script.encode("utf-8"),
                    timeout_s=10,
                )
                if rc == 0 and "__OK__" in stdout:
                    lines = [l.strip() for l in stdout.strip().splitlines()
                             if l.strip() and l.strip() != "__OK__"]
                    if lines:
                        # There are active compute processes on our GPUs
                        log.info("watchdog: nvidia-smi found %d active process(es) on job %s GPUs — overriding PID death", len(lines), job.id)
                        for gpu_idx in gpu_indices:
                            key = f"{node_alias}:{gpu_idx}"
                            if key in result:
                                result[key] = True
            except Exception:
                # nvidia-smi check failed — don't override PID result
                log.warning("watchdog: nvidia-smi fallback failed for node %s", node_alias)

    return result


async def check_job_alive(job: Job, cfg: ClusterConfig) -> bool:
    """Check if a job is still running via remote GPU process check.

    Uses nvidia-smi on remote nodes to check for active compute
    processes on assigned GPUs. This is the ground truth — no
    dependency on local tmux session state.

    Args:
        job: Job to check
        cfg: Cluster configuration for SSH access

    Returns:
        True if ANY assigned GPU has an active process, False otherwise
    """
    if not job.gpus:
        return False

    liveness = await check_gpu_liveness(job, cfg)
    return any(liveness.values())


# ============================================================================
# Job Lifecycle Operations
# ============================================================================


def _extract_node_from_session(session_name: str, job: Job) -> Optional[str]:
    """Extract node alias from tmux session name.

    Session names follow the pattern:
      - single mode:     opensmi-{job_id}-{node}
      - one-to-one mode: opensmi-{job_id}-{node}-gpu{idx}

    Example: "opensmi-abc12345-my-gpu-node-gpu0" → "my-gpu-node"

    Falls back to job.gpus[0] if pattern doesn't match.
    """
    import re

    prefix = f"opensmi-{job.id}-"
    if session_name.startswith(prefix):
        rest = session_name[len(prefix) :]
        match = re.match(r"^(.+)-gpu\d+$", rest)
        if match:
            return match.group(1)
        return rest
    return job.gpus[0][0] if job.gpus else None


async def cancel_job(job: Job, cfg: ClusterConfig) -> bool:
    """Cancel a running or queued job.

    For running jobs, this kills their tmux sessions on the correct nodes.
    For queued jobs, it simply marks them as cancelled.

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

    # Running jobs: kill their local tmux sessions
    tmux_bin = _find_tmux_binary()
    for session in job.tmux_sessions:
        try:
            proc = await asyncio.create_subprocess_exec(
                tmux_bin, "kill-session", "-t", session,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=5)
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


def cleanup_old_jobs(
    jobs: List[Job], max_done: int = 100, max_failed: int = 50
) -> List[Job]:
    """Remove old completed/failed jobs to prevent unbounded growth.

    Keeps the most recent jobs in each status category.

    Args:
        jobs: List of all jobs
        max_done: Maximum number of 'done' jobs to keep
        max_failed: Maximum number of 'failed' jobs to keep

    Returns:
        Filtered list with old jobs removed
    """
    done_jobs = sorted(
        [j for j in jobs if j.status == "done"],
        key=lambda x: x.finished_at or "",
        reverse=True,
    )
    failed_jobs = sorted(
        [j for j in jobs if j.status == "failed"],
        key=lambda x: x.finished_at or "",
        reverse=True,
    )
    other_jobs = [j for j in jobs if j.status not in ("done", "failed")]

    return other_jobs + done_jobs[:max_done] + failed_jobs[:max_failed]
