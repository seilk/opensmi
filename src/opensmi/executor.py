"""Backend command executor for remote GPU workloads.

This module provides targeted command routing to selected nodes/GPUs
with support for environment variable injection and execution modes.
"""

from __future__ import annotations

import asyncio
import shlex
from datetime import datetime, timezone
from typing import List, Optional

from .models import (
    GPUEnvConfig,
    NodeTarget,
    PreflightCheck,
    PreflightCheckType,
    PreflightResult,
    RemoteExecutionContext,
)
from .sshutil import RemoteExecResult, ssh_exec_remote, ssh_run


async def validate_gpu_availability(
    target: NodeTarget,
) -> List[int]:
    """Validate GPU index availability on target node.

    Queries the remote node via nvidia-smi to get the list of available
    GPU indices and returns them. This should be called before GPU injection
    to ensure requested GPUs actually exist on the target node.

    Args:
        target: NodeTarget with node_config and gpu_indices to validate

    Returns:
        List of available GPU indices on the target node

    Raises:
        ValueError: If target.node_config is None
        RuntimeError: If nvidia-smi query fails or returns invalid data

    Example:
        >>> target = NodeTarget(
        ...     node_alias="gpu01",
        ...     gpu_indices=[0, 1, 2],
        ...     node_config=node_config,
        ... )
        >>> available = await validate_gpu_availability(target)
        >>> available
        [0, 1, 2, 3, 4, 5, 6, 7]
        >>> invalid = [idx for idx in target.gpu_indices if idx not in available]
        >>> if invalid:
        ...     raise ValueError(f"Invalid GPU indices: {invalid}")
    """
    if not target.node_config:
        raise ValueError(
            f"NodeTarget for {target.node_alias} missing node_config "
            "for GPU availability validation"
        )

    query_cmd = "nvidia-smi --query-gpu=index --format=csv,noheader,nounits"

    result = await ssh_exec_remote(
        node=target.node_config,
        command=query_cmd,
        timeout_s=10,
    )

    if not result.success:
        raise RuntimeError(
            f"Failed to query GPU availability on {target.node_alias}: "
            f"{result.stderr or result.stdout}"
        )

    available_indices: List[int] = []
    for line in result.stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            gpu_idx = int(line)
            available_indices.append(gpu_idx)
        except ValueError:
            continue

    if not available_indices:
        raise RuntimeError(
            f"No GPUs detected on {target.node_alias}. "
            f"nvidia-smi output: {result.stdout}"
        )

    return available_indices


def validate_gpu_indices_against_available(
    requested_indices: List[int],
    available_indices: List[int],
    node_alias: str,
) -> None:
    """Validate that requested GPU indices are available on the node.

    Args:
        requested_indices: GPU indices requested by user
        available_indices: GPU indices available on the node
        node_alias: Node alias for error messages

    Raises:
        ValueError: If any requested GPU index is not available
    """
    invalid_indices = [idx for idx in requested_indices if idx not in available_indices]
    if invalid_indices:
        raise ValueError(
            f"Invalid GPU indices {invalid_indices} for node {node_alias}. "
            f"Available indices: {available_indices}"
        )


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
    if any(idx < 0 for idx in target.gpu_indices):
        invalid = [idx for idx in target.gpu_indices if idx < 0]
        raise ValueError(
            f"GPU indices must be non-negative, got invalid indices: {invalid}"
        )

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
        # Use shlex.quote() to prevent shell injection via env var values
        if context.env_vars:
            env_prefix = " ".join(
                f"{k}={shlex.quote(v)}" for k, v in context.env_vars.items()
            )
            wrapped_command = f"{env_prefix} {context.command}"
        else:
            wrapped_command = context.command

        # Create a detached tmux session with the command.
        # Build argv then shell-quote each argument to avoid injection and quoting bugs.
        # Run the payload through `bash -lc` so env prefix + shell features work as users expect.
        tmux_argv = [
            "tmux",
            "new-session",
            "-d",
            "-s",
            context.tmux_session,
            "bash",
            "-lc",
            wrapped_command,
        ]
        tmux_cmd = " ".join(shlex.quote(a) for a in tmux_argv)

        return await ssh_exec_remote(
            node=context.target.node_config,
            command=tmux_cmd,
            timeout_s=context.timeout_s,
        )

    else:
        raise ValueError(f"Unknown execution_mode: {context.execution_mode}")


async def run_preflight_checks(
    checks: List[PreflightCheck],
) -> List[PreflightResult]:
    """Run preflight checks before remote execution.

    Performs validation checks on target nodes to ensure they are ready for
    command execution. This includes checking tmux availability, command syntax
    validation, and GPU availability.

    Args:
        checks: List of PreflightCheck objects specifying which checks to run

    Returns:
        List of PreflightResult objects, one per check, in the same order as input

    Raises:
        ValueError: If checks list is empty or contains invalid check configurations

    Example:
        >>> checks = [
        ...     PreflightCheck(
        ...         check_type=PreflightCheckType.TMUX_AVAILABLE,
        ...         node_alias="gpu01",
        ...     ),
        ...     PreflightCheck(
        ...         check_type=PreflightCheckType.COMMAND_SYNTAX,
        ...         node_alias="gpu01",
        ...         command_to_validate="python train.py",
        ...     ),
        ...     PreflightCheck(
        ...         check_type=PreflightCheckType.GPU_AVAILABILITY,
        ...         node_alias="gpu01",
        ...         target_gpu_indices=[0, 1, 2],
        ...     ),
        ... ]
        >>> results = await run_preflight_checks(checks)
        >>> failed = [r for r in results if not r.passed]
        >>> if failed:
        ...     for result in failed:
        ...         print(f"Check failed: {result.error_message}")
    """
    if not checks:
        raise ValueError("checks list cannot be empty")

    # Execute all checks in parallel
    results = await asyncio.gather(
        *[_run_single_preflight_check(check) for check in checks],
        return_exceptions=False,
    )

    return results


async def _run_single_preflight_check(check: PreflightCheck) -> PreflightResult:
    """Run a single preflight check.

    Internal helper function that dispatches to the appropriate check handler
    based on check_type.

    Args:
        check: PreflightCheck specification

    Returns:
        PreflightResult with check status and metadata
    """
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    try:
        if check.check_type == PreflightCheckType.TMUX_AVAILABLE:
            return await _check_tmux_availability(check, timestamp)
        elif check.check_type == PreflightCheckType.COMMAND_SYNTAX:
            return await _check_command_syntax(check, timestamp)
        elif check.check_type == PreflightCheckType.GPU_AVAILABILITY:
            return await _check_gpu_availability(check, timestamp)
        else:
            return PreflightResult(
                check=check,
                passed=False,
                error_message=f"Unknown check type: {check.check_type}",
                timestamp=timestamp,
            )
    except Exception as e:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Check execution failed: {str(e)}",
            timestamp=timestamp,
        )


async def _check_tmux_availability(
    check: PreflightCheck, timestamp: str
) -> PreflightResult:
    """Check if tmux is available on the target node.

    Executes 'which tmux' on the remote node to verify tmux is installed
    and accessible in PATH.

    Returns:
        PreflightResult with passed=True if tmux is available, False otherwise.
        On success, metadata['tmux_path'] contains the path to tmux binary.
    """
    if not check.node_config:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Node configuration missing for {check.node_alias}",
            timestamp=timestamp,
        )

    try:
        rc, stdout, stderr = await ssh_run(
            node=check.node_config,
            remote_args=["which", "tmux"],
            timeout_s=10,
        )

        if rc == 0 and stdout.strip():
            tmux_path = stdout.strip()
            return PreflightResult(
                check=check,
                passed=True,
                metadata={"tmux_path": tmux_path},
                timestamp=timestamp,
            )
        else:
            error_msg = (
                f"tmux not found on {check.node_alias}. "
                f"Install with: sudo apt-get install tmux (Ubuntu/Debian) or sudo yum install tmux (RHEL/CentOS)"
            )
            return PreflightResult(
                check=check,
                passed=False,
                error_message=error_msg,
                timestamp=timestamp,
            )

    except Exception as e:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Failed to check tmux availability: {str(e)}",
            timestamp=timestamp,
        )


async def _check_command_syntax(
    check: PreflightCheck, timestamp: str
) -> PreflightResult:
    """Validate command syntax using remote `bash -n`.

    Notes:
      - This is a syntax-only check (it does not execute the command).
      - We still run it on the target node because remote shells can differ.
    """
    if not check.node_config:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Node configuration missing for {check.node_alias}",
            timestamp=timestamp,
        )

    try:
        rc, _stdout, stderr = await ssh_run(
            node=check.node_config,
            remote_args=["bash", "-n", "-c", check.command_to_validate or ""],
            timeout_s=10,
        )

        if rc == 0:
            return PreflightResult(
                check=check,
                passed=True,
                metadata={},
                timestamp=timestamp,
            )

        err = (stderr or "").strip()
        return PreflightResult(
            check=check,
            passed=False,
            error_message=err or f"Command syntax check failed (rc={rc})",
            timestamp=timestamp,
        )
    except Exception as e:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Failed to check command syntax: {str(e)}",
            timestamp=timestamp,
        )


async def _check_gpu_availability(
    check: PreflightCheck, timestamp: str
) -> PreflightResult:
    """Validate that requested GPU indices exist on the target node.

    This currently checks index existence (not 'free/idle').
    """
    if not check.node_config:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=f"Node configuration missing for {check.node_alias}",
            timestamp=timestamp,
        )

    try:
        # Reuse existing helpers for consistency.
        target = NodeTarget(
            node_alias=check.node_alias,
            gpu_indices=list(check.target_gpu_indices or []),
            node_config=check.node_config,
        )
        available = await validate_gpu_availability(target)
        validate_gpu_indices_against_available(
            requested_indices=target.gpu_indices,
            available_indices=available,
            node_alias=check.node_alias,
        )

        return PreflightResult(
            check=check,
            passed=True,
            metadata={"available_indices": available},
            timestamp=timestamp,
        )
    except Exception as e:
        return PreflightResult(
            check=check,
            passed=False,
            error_message=str(e),
            timestamp=timestamp,
        )


async def route_commands_one_to_one(
    contexts: List[RemoteExecutionContext],
) -> List[RemoteExecResult]:
    """Route multiple commands to multiple targets in one-to-one mode.

    This function orchestrates parallel execution of commands on remote nodes,
    where each command is routed to its corresponding GPU target. This is the
    core implementation of "one-to-one" distribution mode.

    Key behaviors:
    - Each command executes on exactly one GPU on one node
    - Commands execute in parallel using asyncio.gather
    - Each target gets its own CUDA_VISIBLE_DEVICES injection (auto-injected if not present)
    - Failures in individual executions do not block others

    Args:
        contexts: List of RemoteExecutionContext objects, one per command/target pair.
                  Length must match the number of targets.

    Returns:
        List of RemoteExecResult objects, one per execution, in the same order
        as the input contexts.

    Raises:
        ValueError: If contexts list is empty or contains invalid configurations
        SSHRunError: On SSH connection/execution failures (per-target)
        SSHRetryExhausted: When retry attempts are exhausted (per-target)

    Example:
        >>> # Three commands, three GPUs on different nodes
        >>> # CUDA_VISIBLE_DEVICES is auto-injected from gpu_indices
        >>> contexts = [
        ...     RemoteExecutionContext(
        ...         target=NodeTarget("gpu01", [0], node_config_01),
        ...         command="python train.py --fold 0",
        ...         execution_mode="tmux",
        ...         tmux_session="fold-0",
        ...     ),
        ...     RemoteExecutionContext(
        ...         target=NodeTarget("gpu01", [1], node_config_01),
        ...         command="python train.py --fold 1",
        ...         execution_mode="tmux",
        ...         tmux_session="fold-1",
        ...     ),
        ...     RemoteExecutionContext(
        ...         target=NodeTarget("gpu02", [0], node_config_02),
        ...         command="python train.py --fold 2",
        ...         execution_mode="tmux",
        ...         tmux_session="fold-2",
        ...     ),
        ... ]
        >>> results = await route_commands_one_to_one(contexts)
        >>> for i, result in enumerate(results):
        ...     print(f"Command {i}: {'SUCCESS' if result.success else 'FAILED'}")
    """
    if not contexts:
        raise ValueError("contexts list cannot be empty for one-to-one execution")

    # P1.4: Validate one-to-one constraint - each context should target exactly one GPU
    # Count total GPUs across all contexts
    total_gpus = sum(len(ctx.target.gpu_indices) for ctx in contexts)
    num_commands = len(contexts)

    if total_gpus != num_commands:
        raise ValueError(
            f"One-to-one mode requires command count to equal GPU count. "
            f"Got {num_commands} command(s) for {total_gpus} GPU(s). "
            f"Each context should target exactly one GPU."
        )

    # Validate all contexts have required fields and target exactly one GPU
    for i, ctx in enumerate(contexts):
        if not ctx.target.node_config:
            raise ValueError(
                f"Context {i}: NodeTarget for {ctx.target.node_alias} missing node_config"
            )
        if not ctx.command.strip():
            raise ValueError(f"Context {i}: command cannot be empty")

        # Ensure each context targets exactly one GPU in one-to-one mode
        if len(ctx.target.gpu_indices) != 1:
            raise ValueError(
                f"Context {i}: One-to-one mode requires exactly 1 GPU per context, "
                f"but target has {len(ctx.target.gpu_indices)} GPU(s): {ctx.target.gpu_indices}"
            )

    # Auto-inject CUDA_VISIBLE_DEVICES for each context if not already present
    # This is the core of P1.3: per-GPU CUDA_VISIBLE_DEVICES injection for one-to-one mode
    enriched_contexts = []
    for ctx in contexts:
        # If CUDA_VISIBLE_DEVICES is not in env_vars, inject it from gpu_indices
        if "CUDA_VISIBLE_DEVICES" not in ctx.env_vars:
            gpu_env_config = inject_cuda_visible_devices(
                ctx.target,
                additional_env=ctx.env_vars,
            )
            # Create a new context with the injected env vars
            enriched_ctx = RemoteExecutionContext(
                target=ctx.target,
                command=ctx.command,
                env_vars=gpu_env_config.to_env_dict(),
                execution_mode=ctx.execution_mode,
                tmux_session=ctx.tmux_session,
                timeout_s=ctx.timeout_s,
            )
            enriched_contexts.append(enriched_ctx)
        else:
            # CUDA_VISIBLE_DEVICES already present, use context as-is
            enriched_contexts.append(ctx)

    # Execute all commands in parallel
    # Use asyncio.gather to run all route_command_to_target calls concurrently
    # return_exceptions=False means exceptions will propagate (fail-fast behavior)
    results = await asyncio.gather(
        *[route_command_to_target(ctx) for ctx in enriched_contexts],
        return_exceptions=False,
    )

    return results
