"""Backend command executor for remote GPU workloads.

This module provides targeted command routing to selected nodes/GPUs
with support for environment variable injection and execution modes.
"""

from __future__ import annotations

from typing import Optional

from .models import GPUEnvConfig, NodeTarget, RemoteExecutionContext
from .sshutil import RemoteExecResult, ssh_exec_remote


def inject_cuda_visible_devices(
    target: NodeTarget,
    additional_env: Optional[dict[str, str]] = None,
) -> GPUEnvConfig:
    """Inject CUDA_VISIBLE_DEVICES environment configuration for a target node.

    This function creates a GPUEnvConfig object with CUDA_VISIBLE_DEVICES
    set to the GPU indices specified in the target. It validates that GPU
    indices are valid (non-negative integers).

    Args:
        target: NodeTarget specifying which GPUs to expose
        additional_env: Optional dict of additional environment variables

    Returns:
        GPUEnvConfig with CUDA_VISIBLE_DEVICES and additional env vars

    Raises:
        ValueError: If any GPU index is negative

    Example:
        >>> target = NodeTarget(
        ...     node_alias="gpu01",
        ...     gpu_indices=[0, 2, 3],
        ... )
        >>> env_config = inject_cuda_visible_devices(target)
        >>> env_config.cuda_visible_devices
        '0,2,3'
        >>> env_config.to_env_dict()
        {'CUDA_VISIBLE_DEVICES': '0,2,3'}
    """
    # Validate GPU indices
    if any(idx < 0 for idx in target.gpu_indices):
        invalid = [idx for idx in target.gpu_indices if idx < 0]
        raise ValueError(
            f"GPU indices must be non-negative, got invalid indices: {invalid}"
        )

    # Create GPUEnvConfig with gpu_indices
    # The __post_init__ will auto-generate cuda_visible_devices
    return GPUEnvConfig(
        gpu_indices=target.gpu_indices,
        additional_env=additional_env or {},
    )


async def route_command_to_target(
    context: RemoteExecutionContext,
) -> RemoteExecResult:
    """Route a command to a target node with GPU assignment.

    This function orchestrates the execution of a command on a remote node,
    handling environment variable injection (e.g., CUDA_VISIBLE_DEVICES)
    and respecting the specified execution mode (direct vs tmux).

    Args:
        context: RemoteExecutionContext specifying target, command, env vars,
                 execution mode, and timeout

    Returns:
        RemoteExecResult with execution status, stdout, stderr

    Raises:
        ValueError: If target node config is missing
        SSHRunError: On SSH connection/execution failures
        SSHRetryExhausted: When all retry attempts are exhausted

    Example:
        >>> from opensmi.models import NodeTarget, RemoteExecutionContext
        >>> target = NodeTarget(
        ...     node_alias="gpu01",
        ...     gpu_indices=[0, 1],
        ...     node_config=node_config,
        ... )
        >>> context = RemoteExecutionContext(
        ...     target=target,
        ...     command="python train.py",
        ...     env_vars={"CUDA_VISIBLE_DEVICES": "0,1"},
        ...     execution_mode="direct",
        ... )
        >>> result = await route_command_to_target(context)
        >>> print(result.success, result.stdout)
    """
    if not context.target.node_config:
        raise ValueError(
            f"NodeTarget for {context.target.node_alias} missing node_config"
        )

    # For direct execution mode, simply execute the command with env vars
    if context.execution_mode == "direct":
        return await ssh_exec_remote(
            node=context.target.node_config,
            command=context.command,
            env_vars=context.env_vars,
            timeout_s=context.timeout_s,
        )

    # For tmux execution mode, wrap the command in tmux session creation
    elif context.execution_mode == "tmux":
        if not context.tmux_session:
            raise ValueError("tmux_session name required for tmux execution mode")

        # Build the command with environment variable injection
        if context.env_vars:
            env_prefix = " ".join(f"{k}={v}" for k, v in context.env_vars.items())
            wrapped_command = f"{env_prefix} {context.command}"
        else:
            wrapped_command = context.command

        # Create a detached tmux session with the command
        # Using -d (detached) and shell-command format
        tmux_cmd = f"tmux new-session -d -s {context.tmux_session} '{wrapped_command}'"

        return await ssh_exec_remote(
            node=context.target.node_config,
            command=tmux_cmd,
            timeout_s=context.timeout_s,
        )

    else:
        raise ValueError(f"Unknown execution_mode: {context.execution_mode}")
