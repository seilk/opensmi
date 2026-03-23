from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional


@dataclass
class NodeConfig:
    alias: str
    address: str
    user: str
    port: int = 22
    connect_timeout_s: int = 6
    env_manager: str = ""       # "conda" | "micromamba" | "venv" | ""
    env_name: str = ""          # virtual env name (e.g. "ml", "torch2")
    work_dir: str = ""          # remote working directory (e.g. "~/projects")


@dataclass
class SlurmClusterConfig:
    """Config for a Slurm-managed cluster accessed via a login node."""
    name: str               # Display name, e.g. "SUMA HPC"
    login_node: str          # SSH alias or address for the login node
    user: str = ""           # SSH user (optional, defaults to current user)
    port: int = 22
    slurm_bin_prefix: str = ""  # e.g. "/opt/slurm-21.08/bin" for non-standard installs


@dataclass
class ClusterConfig:
    cluster_name: str
    nodes: List[NodeConfig]
    admins: Dict[str, object] = field(default_factory=dict)
    users: List[str] = field(default_factory=list)
    policy: Dict[str, object] = field(default_factory=dict)
    slurm_clusters: List[SlurmClusterConfig] = field(default_factory=list)


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
    cmdline: Optional[str] = None
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


@dataclass
class NodeTarget:
    """Specifies a target node and GPU(s) for remote execution."""

    node_alias: str
    gpu_indices: List[int]
    node_config: Optional[NodeConfig] = None


@dataclass
class RemoteExecutionContext:
    """Context for executing a command on a remote node with GPU assignment."""

    target: NodeTarget
    command: str
    env_vars: Dict[str, str] = field(default_factory=dict)
    execution_mode: str = "direct"  # "direct" or "tmux"
    tmux_session: Optional[str] = None
    timeout_s: int = 300


@dataclass
class GPUEnvConfig:
    """Configuration for GPU environment variable injection.

    This model encapsulates the logic for constructing CUDA_VISIBLE_DEVICES
    and related environment variables for remote GPU workload execution.
    """

    gpu_indices: List[int]
    cuda_visible_devices: Optional[str] = None
    additional_env: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        """Auto-generate CUDA_VISIBLE_DEVICES from gpu_indices if not provided."""
        if self.cuda_visible_devices is None and self.gpu_indices:
            self.cuda_visible_devices = ",".join(map(str, self.gpu_indices))

    def to_env_dict(self) -> Dict[str, str]:
        """Convert to environment variable dictionary for remote execution.

        Returns:
            Dict with CUDA_VISIBLE_DEVICES and any additional environment variables
        """
        env = {}
        if self.cuda_visible_devices is not None:
            env["CUDA_VISIBLE_DEVICES"] = self.cuda_visible_devices
        env.update(self.additional_env)
        return env


class PreflightCheckType(Enum):
    """Types of preflight checks for remote execution."""

    TMUX_AVAILABLE = "tmux_available"
    COMMAND_SYNTAX = "command_syntax"
    GPU_AVAILABILITY = "gpu_availability"


@dataclass
class PreflightCheck:
    """Specification for a preflight check to perform before remote execution.

    Preflight checks validate remote node readiness for command execution,
    including tmux availability, command syntax validation, and GPU state.
    """

    check_type: PreflightCheckType
    node_alias: str
    target_gpu_indices: Optional[List[int]] = None
    command_to_validate: Optional[str] = None
    node_config: Optional[NodeConfig] = None  # Required for actual SSH operations

    def __post_init__(self):
        """Validate check configuration."""
        if self.check_type == PreflightCheckType.GPU_AVAILABILITY:
            if not self.target_gpu_indices:
                raise ValueError("GPU_AVAILABILITY check requires target_gpu_indices")
        elif self.check_type == PreflightCheckType.COMMAND_SYNTAX:
            if not self.command_to_validate:
                raise ValueError("COMMAND_SYNTAX check requires command_to_validate")


@dataclass
class PreflightResult:
    """Result of a single preflight check.

    Contains check status, error details if failed, and optional metadata
    (e.g., tmux version, GPU state snapshot, command validation output).
    """

    check: PreflightCheck
    passed: bool
    error_message: Optional[str] = None
    metadata: Dict[str, object] = field(default_factory=dict)
    timestamp: Optional[str] = None

    def is_critical_failure(self) -> bool:
        """Determine if this failure should block execution.

        Returns:
            True if execution should be blocked, False otherwise
        """
        if self.passed:
            return False

        # All current check types are critical
        return self.check.check_type in {
            PreflightCheckType.TMUX_AVAILABLE,
            PreflightCheckType.COMMAND_SYNTAX,
            PreflightCheckType.GPU_AVAILABILITY,
        }
