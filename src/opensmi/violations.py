from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .allocations import Allocation
from .models import ClusterConfig, ClusterSnapshot, GPUProcess


@dataclass
class Violation:
    node_alias: str
    gpu_index: int
    gpu_uuid: Optional[str]
    user: str
    pids: List[int]
    reason: str
    expected: Optional[str] = None


def _alloc_lookup(allocs: List[Allocation]) -> Dict[Tuple[str, int], Allocation]:
    out: Dict[Tuple[str, int], Allocation] = {}
    for a in allocs:
        out[(a.node_alias, int(a.gpu_index))] = a
    return out


def _build_process_index(
    procs: List[GPUProcess],
) -> Dict[Tuple[str, str], List[int]]:
    """Build (gpu_uuid, user) -> [pids] index in a single O(p) pass."""
    index: Dict[Tuple[str, str], List[int]] = defaultdict(list)
    for p in procs:
        index[(p.gpu_uuid, p.user)].append(p.pid)
    return index


def find_violations(
    config: ClusterConfig,
    snapshot: ClusterSnapshot,
    allocs: List[Allocation],
) -> List[Violation]:
    policy = dict(config.policy or {})
    all_token = str(policy.get("all_users_token", "*"))
    require_allocation = bool(policy.get("require_allocation", True))

    alloc_map = _alloc_lookup(allocs)

    out: List[Violation] = []

    for node in snapshot.nodes:
        if node.error:
            continue

        # Pre-group processes: (gpu_uuid, user) -> [pids]  O(p) once per node
        proc_index = _build_process_index(node.processes)

        idx_to_uuid = {g.index: g.uuid for g in node.gpus}

        for gpu_index, gpu_uuid in idx_to_uuid.items():
            # Collect unique users on this GPU
            users = sorted({u for (guuid, u) in proc_index if guuid == gpu_uuid})
            if not users:
                continue

            alloc = alloc_map.get((node.node_alias, int(gpu_index)))

            if alloc is None:
                if not require_allocation:
                    continue
                for u in users:
                    out.append(
                        Violation(
                            node_alias=node.node_alias,
                            gpu_index=int(gpu_index),
                            gpu_uuid=gpu_uuid,
                            user=u,
                            pids=list(proc_index[(gpu_uuid, u)]),
                            reason="UNALLOCATED_IN_USE",
                        )
                    )
                continue

            if alloc.target == all_token:
                continue

            allowed = {t for t in str(alloc.target).replace(",", " ").split() if t}

            for u in users:
                if u not in allowed:
                    out.append(
                        Violation(
                            node_alias=node.node_alias,
                            gpu_index=int(gpu_index),
                            gpu_uuid=gpu_uuid,
                            user=u,
                            pids=list(proc_index[(gpu_uuid, u)]),
                            reason="WRONG_USER",
                            expected=alloc.target,
                        )
                    )

    return out
