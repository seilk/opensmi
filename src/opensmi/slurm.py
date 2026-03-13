"""Slurm cluster overview — no SSH required.

Parses sinfo / squeue / scontrol to build a per-node, per-GPU-index
usage map showing which user occupies which GPU.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple


# ── Data models ─────────────────────────────────────────────────────


@dataclass
class SlurmGPUSlot:
    """One GPU slot on a node."""

    index: int
    user: Optional[str] = None
    job_id: Optional[int] = None
    job_name: Optional[str] = None
    job_state: Optional[str] = None
    job_time: Optional[str] = None  # elapsed time string from squeue


@dataclass
class SlurmNodeInfo:
    """Aggregated info for one compute node."""

    name: str
    partition: str
    state: str  # idle / mixed / allocated / down / drain …
    gpu_type: str  # e.g. "RTX3090"
    gpu_total: int
    gpus: List[SlurmGPUSlot] = field(default_factory=list)

    @property
    def gpu_used(self) -> int:
        return sum(1 for g in self.gpus if g.user is not None)

    @property
    def gpu_free(self) -> int:
        return self.gpu_total - self.gpu_used


@dataclass
class SlurmClusterSnapshot:
    """Full cluster snapshot from Slurm."""

    cluster_name: str = "Slurm Cluster"
    timestamp: str = ""
    nodes: List[SlurmNodeInfo] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    login_node: Optional[str] = None
    ssh_user: str = ""
    ssh_port: int = 22


# ── Shell helpers ───────────────────────────────────────────────────


def _run(cmd: List[str], timeout: int = 15) -> str:
    """Run a command and return stdout. Raises on failure."""
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(
            f"{' '.join(cmd)} failed (rc={r.returncode}): {r.stderr.strip()}"
        )
    return r.stdout


def _run_remote(
    cmd: List[str], login_node: str, user: str = "", port: int = 22, timeout: int = 15
) -> str:
    """Run a command on a remote login node via SSH."""
    ssh_cmd = ["ssh", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes"]
    if port != 22:
        ssh_cmd += ["-p", str(port)]
    target = f"{user}@{login_node}" if user else login_node
    ssh_cmd.append(target)
    ssh_cmd.append(" ".join(cmd))
    r = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(
            f"ssh {target}: {r.stderr.strip() or f'exit {r.returncode}'}"
        )
    return r.stdout


# ── Parsers ─────────────────────────────────────────────────────────


def _parse_sinfo(raw: str) -> Dict[str, Tuple[str, str, str, int]]:
    """Parse `sinfo -N -o '%N %P %T %G'` output.

    Returns {node_name: (partition, state, gpu_type, gpu_count)}.
    Nodes without GPUs are excluded.
    """
    nodes: Dict[str, Tuple[str, str, str, int]] = {}
    for line in raw.strip().splitlines()[1:]:  # skip header
        parts = line.split()
        if len(parts) < 4:
            continue
        name, partition, state, gres = parts[0], parts[1], parts[2], parts[3]
        # gres example: gpu:RTX3090:8 or (null)
        m = re.match(r"gpu:([^:]+):(\d+)", gres)
        if not m:
            continue
        gpu_type = m.group(1)
        gpu_count = int(m.group(2))
        # A node may appear in multiple partitions; keep the first (or the one
        # with more GPUs, though they should be identical).
        if name not in nodes or gpu_count > nodes[name][3]:
            nodes[name] = (partition.rstrip("*"), state, gpu_type, gpu_count)
    return nodes


@dataclass
class _JobGPUAlloc:
    job_id: int
    user: str
    job_name: str
    state: str
    elapsed: str
    node: str
    gpu_indices: List[int]


def _parse_jobs(squeue_out: str, scontrol_fn) -> List[_JobGPUAlloc]:
    """Parse squeue + scontrol -d show job to get per-job GPU index allocations."""
    allocs: List[_JobGPUAlloc] = []

    for line in squeue_out.strip().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            job_id = int(parts[0])
        except ValueError:
            continue
        user = parts[1]
        state = parts[2]
        elapsed = parts[3]
        job_name = parts[4]

        # Get detailed info via scontrol
        try:
            detail = scontrol_fn(job_id)
        except Exception:
            continue

        # Parse nodes + GRES with IDX from scontrol -d output
        # Pattern: Nodes=node42 CPU_IDs=64-127 Mem=0 GRES=gpu:a100:4(IDX:0-3)
        for m in re.finditer(
            r"Nodes=(\S+)\s+.*?GRES=gpu:[^:]+:\d+\(IDX:([\d,\-]+)\)", detail
        ):
            node_name = m.group(1)
            idx_str = m.group(2)
            indices = _expand_idx(idx_str)
            allocs.append(
                _JobGPUAlloc(
                    job_id=job_id,
                    user=user,
                    job_name=job_name,
                    state=state,
                    elapsed=elapsed,
                    node=node_name,
                    gpu_indices=indices,
                )
            )

    return allocs


def _expand_idx(idx_str: str) -> List[int]:
    """Expand '0-3,5,7-8' → [0,1,2,3,5,7,8]."""
    result: List[int] = []
    for part in idx_str.split(","):
        if "-" in part:
            lo, hi = part.split("-", 1)
            result.extend(range(int(lo), int(hi) + 1))
        else:
            result.append(int(part))
    return sorted(result)


# ── Main entry ──────────────────────────────────────────────────────


def collect_slurm_snapshot(
    *,
    partition_filter: Optional[str] = None,
    node_filter: Optional[str] = None,
    timeout: int = 15,
    login_node: Optional[str] = None,
    ssh_user: str = "",
    ssh_port: int = 22,
    cluster_name: str = "Slurm Cluster",
) -> SlurmClusterSnapshot:
    """Collect a full Slurm cluster snapshot using only Slurm CLI tools.

    If login_node is provided, commands are run remotely via SSH.
    Otherwise, they are run locally (assumes we're on a Slurm login node).
    """
    from .state import now_kst_iso

    snap = SlurmClusterSnapshot(
        timestamp=now_kst_iso(),
        cluster_name=cluster_name,
        login_node=login_node,
        ssh_user=ssh_user,
        ssh_port=ssh_port,
    )

    def run_cmd(cmd: List[str]) -> str:
        if login_node:
            return _run_remote(
                cmd, login_node, user=ssh_user, port=ssh_port, timeout=timeout
            )
        return _run(cmd, timeout=timeout)

    # 1. sinfo — node list
    try:
        sinfo_raw = run_cmd(["sinfo", "-N", "-o", "'%N %P %T %G'"])
    except Exception as e:
        snap.errors.append(f"sinfo failed: {e}")
        return snap

    node_map = _parse_sinfo(sinfo_raw)

    # 2. squeue — running jobs
    try:
        squeue_raw = run_cmd(
            ["squeue", "--noheader", "-o", "'%i %u %T %M %j'", "--states=RUNNING"],
        )
    except Exception as e:
        snap.errors.append(f"squeue failed: {e}")
        squeue_raw = ""

    def _scontrol_detail(job_id: int) -> str:
        return run_cmd(["scontrol", "-d", "show", "job", str(job_id)])

    try:
        job_allocs = _parse_jobs(squeue_raw, _scontrol_detail)
    except Exception as e:
        snap.errors.append(f"job parsing failed: {e}")
        job_allocs = []

    # 3. Get per-node AllocTRES (allocated GPU count) via sinfo with AllocMem/GRES
    node_alloc_gpus: Dict[str, int] = {}
    try:
        # sinfo -N -o '%N %G' gives Gres, but AllocTRES needs scontrol or sinfo %aTRES
        sinfo_alloc_raw = run_cmd(["sinfo", "-N", "-o", "'%N %G %a %T %A'"])
        # Parse via scontrol show node for mixed/allocated nodes
        mixed_nodes = [
            n
            for n, (_, st, _, _) in node_map.items()
            if st.lower().rstrip("*") in ("mixed", "allocated")
        ]
        for mnode in mixed_nodes:
            try:
                detail = run_cmd(["scontrol", "show", "node", mnode])
                m = re.search(r"AllocTRES=.*?gres/gpu=(\d+)", detail)
                if m:
                    node_alloc_gpus[mnode] = int(m.group(1))
            except Exception:
                pass
    except Exception as e:
        snap.errors.append(f"node AllocTRES check failed: {e}")

    # 4. Build node objects
    # Index job allocs by node
    node_jobs: Dict[str, List[_JobGPUAlloc]] = {}
    for ja in job_allocs:
        node_jobs.setdefault(ja.node, []).append(ja)

    for name in sorted(node_map):
        partition, state, gpu_type, gpu_total = node_map[name]

        # Apply filters
        if partition_filter and partition_filter.lower() not in partition.lower():
            continue
        if node_filter and node_filter.lower() not in name.lower():
            continue

        # Build GPU slots
        slots: List[SlurmGPUSlot] = []
        for i in range(gpu_total):
            slots.append(SlurmGPUSlot(index=i))

        # Fill in job allocations
        for ja in node_jobs.get(name, []):
            for idx in ja.gpu_indices:
                if 0 <= idx < len(slots):
                    slots[idx].user = ja.user
                    slots[idx].job_id = ja.job_id
                    slots[idx].job_name = ja.job_name
                    slots[idx].job_state = ja.state
                    slots[idx].job_time = ja.elapsed

        # Check AllocTRES for non-Slurm GPU usage:
        # If node is mixed/allocated but some GPUs not explained by squeue jobs,
        # mark remaining occupied slots as "???" (non-Slurm or invisible job).
        if state.lower().rstrip("*") in ("mixed", "allocated"):
            alloc_gpus = node_alloc_gpus.get(name, 0)
            job_claimed = sum(1 for s in slots if s.user is not None)
            unaccounted = alloc_gpus - job_claimed
            if unaccounted > 0:
                # Fill first unaccounted idle slots as unknown
                filled = 0
                for slot in slots:
                    if filled >= unaccounted:
                        break
                    if slot.user is None:
                        slot.user = "???"
                        slot.job_name = "non-slurm"
                        filled += 1

        snap.nodes.append(
            SlurmNodeInfo(
                name=name,
                partition=partition,
                state=state,
                gpu_type=gpu_type,
                gpu_total=gpu_total,
                gpus=slots,
            )
        )

    return snap


def snapshot_to_json(snap: SlurmClusterSnapshot) -> str:
    """Serialize snapshot to JSON."""
    d = asdict(snap)
    # Add computed fields
    for node in d["nodes"]:
        used = sum(1 for g in node["gpus"] if g["user"] is not None)
        node["gpu_used"] = used
        node["gpu_free"] = node["gpu_total"] - used
    return json.dumps(d, indent=2, ensure_ascii=False)


# ── CLI formatter ───────────────────────────────────────────────────


def format_table(snap: SlurmClusterSnapshot, *, compact: bool = False) -> str:
    """Format snapshot as a human-readable table."""
    if snap.errors:
        lines = [f"⚠ {e}" for e in snap.errors]
        if not snap.nodes:
            return "\n".join(lines)

    lines: List[str] = []
    lines.append(f"{snap.cluster_name} — Slurm GPU Overview — {snap.timestamp}")
    lines.append("")

    for node in snap.nodes:
        used = node.gpu_used
        free = node.gpu_free
        state_icon = {
            "idle": "🟢",
            "mixed": "🟡",
            "allocated": "🔴",
            "down": "⚫",
            "drain": "⚫",
            "drained": "⚫",
        }.get(node.state.lower().split("*")[0], "⚪")

        header = (
            f"{state_icon} {node.name} ({node.partition}) — "
            f"{node.gpu_type} ×{node.gpu_total}  "
            f"[used {used}/{node.gpu_total}]"
        )
        lines.append(header)

        if compact and used == 0:
            lines.append(f"   All {node.gpu_total} GPUs idle")
            lines.append("")
            continue

        for slot in node.gpus:
            if slot.user:
                time_str = f" ({slot.job_time})" if slot.job_time else ""
                job_str = f" job:{slot.job_id}" if slot.job_id else ""
                lines.append(f"   GPU {slot.index}: {slot.user}{job_str}{time_str}")
            else:
                if not compact:
                    lines.append(f"   GPU {slot.index}: (idle)")
        lines.append("")

    # Summary
    total_gpus = sum(n.gpu_total for n in snap.nodes)
    total_used = sum(n.gpu_used for n in snap.nodes)
    total_free = total_gpus - total_used

    # Per-user summary
    user_counts: Dict[str, int] = {}
    for n in snap.nodes:
        for g in n.gpus:
            if g.user:
                user_counts[g.user] = user_counts.get(g.user, 0) + 1

    lines.append(f"Total: {total_used}/{total_gpus} GPUs in use, {total_free} free")
    if user_counts:
        user_parts = [
            f"{u}({c})" for u, c in sorted(user_counts.items(), key=lambda x: -x[1])
        ]
        lines.append(f"Users: {', '.join(user_parts)}")

    return "\n".join(lines)
