from __future__ import annotations

import asyncio
import re
import shlex
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .models import NodeConfig

_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_env_vars(env_vars: Dict[str, str]) -> None:
    for k in env_vars.keys():
        if not _ENV_KEY_RE.match(str(k)):
            raise ValueError(f"Invalid env var key: {k!r}")



class SSHRunError(RuntimeError):
    pass


class SSHRetryExhausted(SSHRunError):
    """Raised when all SSH retry attempts have been exhausted."""

    pass


def _ssh_base_cmd(node: NodeConfig) -> List[str]:
    cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        f"ConnectTimeout={int(node.connect_timeout_s)}",
    ]
    if node.port and int(node.port) != 22:
        cmd += ["-p", str(int(node.port))]
    return cmd


async def ssh_run(
    node: NodeConfig,
    remote_args: List[str],
    *,
    stdin_bytes: Optional[bytes] = None,
    timeout_s: int = 15,
) -> Tuple[int, str, str]:
    """Run a remote command over SSH.

    Returns (rc, stdout, stderr).
    """
    target = f"{node.user}@{node.address}"
    cmd = _ssh_base_cmd(node) + [target] + remote_args

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(stdin_bytes), timeout=timeout_s
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise SSHRunError(f"SSH timeout after {timeout_s}s")

    rc = int(proc.returncode or 0)
    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    return rc, stdout, stderr


async def ssh_run_with_retry(
    node: NodeConfig,
    remote_args: List[str],
    *,
    stdin_bytes: Optional[bytes] = None,
    timeout_s: int = 15,
    max_retries: int = 3,
) -> Tuple[int, str, str]:
    """Run SSH command with exponential backoff retry on connection failures.

    Retries on: connection timeouts, connection refused, network unreachable.
    Does NOT retry on: authentication failures, command errors (rc != 0).
    """
    attempt = 0
    last_error: Optional[Exception] = None

    while attempt < max_retries:
        attempt += 1
        try:
            return await ssh_run(
                node,
                remote_args,
                stdin_bytes=stdin_bytes,
                timeout_s=timeout_s,
            )
        except SSHRunError as e:
            last_error = e
            err_msg = str(e).lower()

            is_retryable = any(
                keyword in err_msg
                for keyword in [
                    "timeout",
                    "connection refused",
                    "connection timed out",
                    "no route to host",
                    "network is unreachable",
                ]
            )

            if not is_retryable:
                raise

            if attempt >= max_retries:
                raise SSHRetryExhausted(
                    f"SSH failed after {max_retries} attempts: {e}"
                ) from e

            delay_s = 2 ** (attempt - 1)
            print(
                f"[ssh-retry] {node.alias} attempt {attempt}/{max_retries} failed: {e}. "
                f"Retrying in {delay_s}s...",
                file=sys.stderr,
            )
            await asyncio.sleep(delay_s)

    if last_error:
        raise SSHRetryExhausted(
            f"SSH failed after {max_retries} attempts: {last_error}"
        ) from last_error

    raise SSHRetryExhausted(f"SSH failed after {max_retries} attempts")


async def ssh_bash_script(
    node: NodeConfig,
    script: str,
    *,
    timeout_s: int = 15,
    max_retries: int = 1,
) -> Tuple[int, str, str]:
    return await ssh_run_with_retry(
        node,
        ["bash", "-s"],
        stdin_bytes=script.encode("utf-8"),
        timeout_s=timeout_s,
        max_retries=max_retries,
    )


@dataclass
class RemoteExecResult:
    """Result of a remote command execution."""

    exit_code: int
    stdout: str
    stderr: str
    node_alias: str
    command: str
    success: bool = field(init=False)

    def __post_init__(self):
        self.success = self.exit_code == 0


async def ssh_exec_remote(
    node: NodeConfig,
    command: str,
    *,
    env_vars: Optional[Dict[str, str]] = None,
    timeout_s: int = 300,
    max_retries: int = 1,
) -> RemoteExecResult:
    """Execute a remote command with environment variable injection and result capture.

    Args:
        node: Target node configuration
        command: Shell command to execute
        env_vars: Optional environment variables to inject (e.g., {"CUDA_VISIBLE_DEVICES": "0,1"})
        timeout_s: Execution timeout in seconds (default: 300s for long-running commands)
        max_retries: Number of retry attempts on connection failures (default: 1)

    Returns:
        RemoteExecResult with exit_code, stdout, stderr, and success status

    Raises:
        SSHRunError: On SSH connection/execution failures
        SSHRetryExhausted: When all retry attempts are exhausted
    """
    # Build the command with environment variable injection
    if env_vars:
        _validate_env_vars(env_vars)

    # Use shlex.quote() to prevent shell injection via env var values
    if env_vars:
        env_prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env_vars.items())
        full_command = f"{env_prefix} {command}"
    else:
        full_command = command

    # Execute via bash to ensure proper shell expansion and environment handling
    rc, stdout, stderr = await ssh_run_with_retry(
        node,
        ["bash", "-c", full_command],
        timeout_s=timeout_s,
        max_retries=max_retries,
    )

    return RemoteExecResult(
        exit_code=rc,
        stdout=stdout,
        stderr=stderr,
        node_alias=node.alias,
        command=command,
    )
