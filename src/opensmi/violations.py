from __future__ import annotations

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


def _pids_for_user(procs: List[GPUProcess], *, gpu_uuid: str, user: str) -> List[int]:
    return [p.pid for p in procs if p.gpu_uuid == gpu_uuid and p.user == user]


def find_violations(
    config: ClusterConfig,
    snapshot: ClusterSnapshot,
    allocs: List[Allocation],
) -> List[Violation]:
    policy = dict(config.policy or {})
    all_token = str(policy.get("all_users_token", "*"))

    alloc_map = _alloc_lookup(allocs)

    out: List[Violation] = []

    for node in snapshot.nodes:
        if node.error:
            continue

        idx_to_uuid = {g.index: g.uuid for g in node.gpus}

        # Consider the GPUs that exist on this node
        for gpu_index, gpu_uuid in idx_to_uuid.items():
            users = sorted({p.user for p in node.processes if p.gpu_uuid == gpu_uuid})
            if not users:
                continue

            alloc = alloc_map.get((node.node_alias, int(gpu_index)))

            if alloc is None:
                # Default-open policy: before explicit admin allocation,
                # treat GPU as open-to-all.
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
                            pids=_pids_for_user(node.processes, gpu_uuid=gpu_uuid, user=u),
                            reason="WRONG_USER",
                            expected=alloc.target,
                        )
                    )

    return out
