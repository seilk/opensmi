"""GPU ranking logic for automatic GPU selection.

Multi-tier priority ranking:
1. Tier 1: GPUs explicitly allocated to current user
2. Tier 2: GPUs allocated to '*' (all users)
3. Tier 3: Unallocated idle GPUs (proc=0, util=0)
4. Tier 4: Unallocated light-load GPUs
5. Tier 5: Busy GPUs (last resort)

Within each tier, sort by idle time (last_used, oldest first).
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from opensmi.models import ClusterSnapshot, GPUInfo, NodeSnapshot


def rank_gpus(
    snapshot: ClusterSnapshot,
    launch_history: Optional[Dict[str, Dict[int, str]]] = None,
    allocations: Optional[List[Dict]] = None,
    current_user: Optional[str] = None,
) -> List[Tuple[str, int, GPUInfo]]:
    """Rank all GPUs in the cluster for automatic allocation.

    Args:
        snapshot: Current cluster state
        launch_history: Optional dict of {node_alias: {gpu_index: iso_timestamp}}
        allocations: Optional list of allocation dicts
        current_user: Optional current user for priority ranking

    Returns:
        List of (node_alias, gpu_index, gpu_info) tuples, sorted by priority
        (best candidates first)
    """
    launch_history = launch_history or {}
    allocations = allocations or []
    current_user = current_user or ""
    
    # Build allocation map: (node, gpu_idx) -> target
    alloc_map: Dict[Tuple[str, int], str] = {}
    for alloc in allocations:
        node = alloc.get("node_alias", "")
        gpu_idx = alloc.get("gpu_index", -1)
        target = alloc.get("target", "")
        if node and gpu_idx >= 0:
            alloc_map[(node, gpu_idx)] = target
    
    # Tier lists
    tier1: List[Tuple[str, int, GPUInfo, str, int, int]] = []  # My explicit allocation
    tier2: List[Tuple[str, int, GPUInfo, str, int, int]] = []  # '*' allocation
    tier3: List[Tuple[str, int, GPUInfo, str, int, int]] = []  # Unallocated idle
    tier4: List[Tuple[str, int, GPUInfo, str, int, int]] = []  # Unallocated light
    tier5: List[Tuple[str, int, GPUInfo, str, int, int]] = []  # Busy

    for node in snapshot.nodes:
        if node.error:
            continue  # Skip unreachable nodes

        # Count active processes per GPU
        process_counts: Dict[str, int] = {}
        for proc in node.processes:
            process_counts[proc.gpu_uuid] = process_counts.get(proc.gpu_uuid, 0) + 1

        for gpu in node.gpus:
            last_used = _get_last_used(launch_history, node.node_alias, gpu.index)
            active_count = process_counts.get(gpu.uuid, 0)
            utilization = gpu.utilization_gpu_percent or 0
            
            key = (node.node_alias, gpu.index)
            alloc_target = alloc_map.get(key, "")
            
            entry = (node.node_alias, gpu.index, gpu, last_used, active_count, utilization)
            
            # Tier 1: My explicit allocation
            if alloc_target == current_user:
                tier1.append(entry)
            # Tier 2: All-user allocation
            elif alloc_target == "*":
                tier2.append(entry)
            # Tier 3: Unallocated + idle
            elif not alloc_target and active_count == 0 and utilization == 0:
                tier3.append(entry)
            # Tier 4: Unallocated + light load
            elif not alloc_target:
                tier4.append(entry)
            # Tier 5: Allocated to someone else (fallback)
            else:
                tier5.append(entry)
    
    # Sort each tier by: (last_used, active_count, utilization, gpu.index)
    def sort_key(x):
        return (x[3], x[4], x[5], x[2].index)
    
    tier1.sort(key=sort_key)
    tier2.sort(key=sort_key)
    tier3.sort(key=sort_key)
    tier4.sort(key=sort_key)
    tier5.sort(key=sort_key)
    
    # Combine tiers
    all_tiers = tier1 + tier2 + tier3 + tier4 + tier5
    
    return [(alias, idx, gpu) for alias, idx, gpu, _, _, _ in all_tiers]


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
    allocations: Optional[List[Dict]] = None,
    current_user: Optional[str] = None,
) -> List[Tuple[str, int]]:
    """Select the top N GPUs for allocation.

    Args:
        snapshot: Current cluster state
        n: Number of GPUs to select
        launch_history: Optional launch history
        allocations: Optional list of allocation dicts
        current_user: Optional current user name

    Returns:
        List of (node_alias, gpu_index) tuples for the top N GPUs,
        with multi-tier priority ranking
    """
    ranked = rank_gpus(snapshot, launch_history, allocations, current_user)
    return [(alias, idx) for alias, idx, _ in ranked[:n]]
