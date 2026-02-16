"""GPU ranking logic for automatic GPU selection.

Ranks GPUs by:
1. last_used_at (oldest first; never-used = highest priority)
2. active process count (fewer is better)
3. GPU utilization (lower is better)
4. GPU index (ascending)
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from opensmi.models import ClusterSnapshot, GPUInfo, NodeSnapshot


def rank_gpus(
    snapshot: ClusterSnapshot,
    launch_history: Optional[Dict[str, Dict[int, str]]] = None,
) -> List[Tuple[str, int, GPUInfo]]:
    """Rank all GPUs in the cluster for automatic allocation.

    Args:
        snapshot: Current cluster state
        launch_history: Optional dict of {node_alias: {gpu_index: iso_timestamp}}

    Returns:
        List of (node_alias, gpu_index, gpu_info) tuples, sorted by priority
        (best candidates first)
    """
    launch_history = launch_history or {}
    candidates: List[Tuple[str, int, GPUInfo, str, int, int]] = []

    for node in snapshot.nodes:
        if node.error:
            continue  # Skip unreachable nodes

        # Count active processes per GPU
        process_counts: Dict[str, int] = {}
        for proc in node.processes:
            process_counts[proc.gpu_uuid] = process_counts.get(proc.gpu_uuid, 0) + 1

        for gpu in node.gpus:
            # Extract ranking keys
            last_used = _get_last_used(launch_history, node.node_alias, gpu.index)
            active_count = process_counts.get(gpu.uuid, 0)
            utilization = gpu.utilization_gpu_percent or 0

            candidates.append(
                (node.node_alias, gpu.index, gpu, last_used, active_count, utilization)
            )

    # Sort by: (1) last_used (oldest first), (2) active_count, (3) utilization, (4) gpu.index
    candidates.sort(key=lambda x: (x[3], x[4], x[5], x[2].index))

    return [(alias, idx, gpu) for alias, idx, gpu, _, _, _ in candidates]


def _get_last_used(
    history: Dict[str, Dict[int, str]], node_alias: str, gpu_index: int
) -> str:
    """Get last_used timestamp for a GPU.

    Returns:
        ISO timestamp string, or "" for never-used (sorts first)
    """
    node_hist = history.get(node_alias, {})
    return node_hist.get(gpu_index, "")  # Empty string = never used = highest priority


def select_top_gpus(
    snapshot: ClusterSnapshot,
    n: int,
    launch_history: Optional[Dict[str, Dict[int, str]]] = None,
) -> List[Tuple[str, int]]:
    """Select the top N GPUs for allocation.

    Args:
        snapshot: Current cluster state
        n: Number of GPUs to select
        launch_history: Optional launch history

    Returns:
        List of (node_alias, gpu_index) tuples for the top N GPUs
    """
    ranked = rank_gpus(snapshot, launch_history)
    return [(alias, idx) for alias, idx, _ in ranked[:n]]
