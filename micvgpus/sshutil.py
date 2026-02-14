from __future__ import annotations

import asyncio
from typing import List, Optional, Tuple

from .models import NodeConfig


class SSHRunError(RuntimeError):
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
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(stdin_bytes), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        raise SSHRunError(f"SSH timeout after {timeout_s}s")

    rc = int(proc.returncode or 0)
    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    return rc, stdout, stderr


async def ssh_bash_script(
    node: NodeConfig,
    script: str,
    *,
    timeout_s: int = 15,
) -> Tuple[int, str, str]:
    return await ssh_run(node, ["bash", "-s"], stdin_bytes=script.encode("utf-8"), timeout_s=timeout_s)
