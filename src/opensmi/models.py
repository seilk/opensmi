from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class NodeConfig:
    alias: str
    address: str
    user: str
    port: int = 22
    connect_timeout_s: int = 6


@dataclass
class ClusterConfig:
    cluster_name: str
    nodes: List[NodeConfig]
    admins: Dict[str, object] = field(default_factory=dict)
    users: List[str] = field(default_factory=list)
    policy: Dict[str, object] = field(default_factory=dict)


@dataclass
class GPUInfo:
    index: int
    uuid: str
    name: str
    memory_total_mib: Optional[int] = None
    memory_used_mib: Optional[int] = None
    memory_free_mib: Optional[int] = None
    utilization_gpu_percent: Optional[int] = None
    temperature_c: Optional[int] = None
    power_draw_w: Optional[float] = None


@dataclass
class GPUProcess:
    gpu_uuid: str
    pid: int
    process_name: str
    used_memory_mib: Optional[int] = None
    user: str = "unknown"
    runtime_s: Optional[int] = None


@dataclass
class NodeSnapshot:
    node_alias: str
    address: str
    hostname: Optional[str] = None
    os: Optional[str] = None
    timestamp: Optional[str] = None
    gpus: List[GPUInfo] = field(default_factory=list)
    processes: List[GPUProcess] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class ClusterSnapshot:
    cluster_name: str
    timestamp: str
    nodes: List[NodeSnapshot]
