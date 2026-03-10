from __future__ import annotations

import asyncio
import base64
import csv
import io
from dataclasses import asdict
from typing import Dict, List, Optional, Tuple

from .models import ClusterConfig, ClusterSnapshot, GPUInfo, GPUProcess, NodeConfig, NodeSnapshot
from .state import now_kst_iso


REMOTE_SCRIPT = r"""#!/usr/bin/env bash
set -u

echo "__OPENSMI_BEGIN__"

# meta
hn=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)
echo "hostname=${hn}"

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "os=${PRETTY_NAME:-${NAME:-unknown}}"
else
  echo "os=unknown"
fi

echo "__GPUS__"
(nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null) || true

echo "__PROCS__"
(nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null) || true

echo "__OWNERS__"
up=$(cut -d' ' -f1 /proc/uptime 2>/dev/null || echo "")
hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
(nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits 2>/dev/null | sort -u) | while read -r pid; do
  [ -n "$pid" ] || continue
  user=$(stat -c "%U" "/proc/$pid" 2>/dev/null || echo unknown)

  # Best-effort runtime (seconds) from /proc
  st=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo "")
  runtime=""
  if [ -n "$up" ] && [ -n "$st" ] && [ -n "$hz" ]; then
    runtime=$(awk -v up="$up" -v st="$st" -v hz="$hz" 'BEGIN{ if(hz==0){print ""} else { r=up-(st/hz); if(r<0) r=0; printf "%.0f", r } }')
  fi

  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || echo "")
  cmdline_b64=$(printf '%s' "$cmdline" | base64 | tr -d '\n')

  echo "$pid,$user,$runtime,$cmdline_b64"
done

echo "__OPENSMI_END__"
"""


REMOTE_USERS_SCRIPT = r"""#!/usr/bin/env bash
set -u

echo "__OPENSMI_USERS_BEGIN__"
(getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null || true) | sed 's/:.*//' | sort -u
echo "__OPENSMI_USERS_END__"
"""


class SSHError(RuntimeError):
    pass


async def _ssh_run(
    node: NodeConfig, script: str, timeout_s: int, max_retries: int = 2
) -> Tuple[int, str, str]:
    from .sshutil import SSHRunError, is_local_node, ssh_bash_script

    if is_local_node(node):
        # Local node: run the bash script directly without SSH overhead.
        proc = await asyncio.create_subprocess_exec(
            "bash", "-s",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(input=script.encode("utf-8")),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise SSHError(f"local script timed out after {timeout_s}s")
        return int(proc.returncode or 0), stdout_b.decode("utf-8", errors="replace"), stderr_b.decode("utf-8", errors="replace")

    try:
        return await ssh_bash_script(
            node,
            script,
            timeout_s=timeout_s,
            max_retries=max_retries,
        )
    except SSHRunError as e:
        raise SSHError(str(e)) from e


def _find_section(lines: List[str], marker: str) -> int:
    for i, line in enumerate(lines):
        if line.strip() == marker:
            return i
    return -1


def _parse_csv_lines(lines: List[str]) -> List[List[str]]:
    out: List[List[str]] = []
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        # nvidia-smi sometimes prints: "No running processes found"
        if s.lower().startswith("no running processes"):
            continue
        reader = csv.reader(io.StringIO(s))
        row = next(reader)
        out.append([c.strip() for c in row])
    return out


def _parse_users_output(stdout: str) -> List[str]:
    lines = stdout.splitlines()

    begin_i = _find_section(lines, "__OPENSMI_USERS_BEGIN__")
    end_i = _find_section(lines, "__OPENSMI_USERS_END__")
    if begin_i == -1 or end_i == -1 or end_i <= begin_i:
        # Best-effort fallback: treat entire stdout as username list
        begin_i, end_i = 0, len(lines)

    users: List[str] = []
    seen = set()
    for raw in lines[begin_i + 1 : end_i]:
        u = raw.strip()
        if not u:
            continue
        if u in seen:
            continue
        seen.add(u)
        users.append(u)

    return users


_SENSITIVE_FLAGS: frozenset[str] = frozenset({
    "--password",
    "--passwd",
    "--token",
    "--api-key",
    "--apikey",
    "--secret",
    "--access-key",
    "--auth-token",
})

# Pre-built prefix set: "--token=" etc., avoids per-token inner loop
_SENSITIVE_PREFIXES: tuple[str, ...] = tuple(f + "=" for f in _SENSITIVE_FLAGS)


def _redact_cmdline(cmdline: str) -> str:
    tokens = cmdline.split()
    if not tokens:
        return ""

    out: List[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        low = tok.lower()

        if low in _SENSITIVE_FLAGS:
            # --flag <value> form
            out.append(tok)
            if i + 1 < len(tokens):
                out.append("***REDACTED***")
                i += 1
        elif any(low.startswith(p) for p in _SENSITIVE_PREFIXES):
            # --flag=value form
            out.append(tok.split("=", 1)[0] + "=***REDACTED***")
        else:
            out.append(tok)
        i += 1
    return " ".join(out)


def _decode_cmdline_b64(value: str, *, max_len: int = 512) -> Optional[str]:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        decoded = base64.b64decode(raw, validate=False).decode("utf-8", errors="replace")
    except Exception:
        return None
    clean = " ".join(decoded.replace("\x00", " ").split())
    if not clean:
        return None
    redacted = _redact_cmdline(clean)
    if len(redacted) > max_len:
        return redacted[: max_len - 3] + "..."
    return redacted


def _int_or_none(val: str) -> Optional[int]:
    try:
        return int(val)
    except Exception:
        return None


def _float_or_none(val: str) -> Optional[float]:
    try:
        return float(val)
    except Exception:
        return None


async def fetch_users(
    config: ClusterConfig, *, timeout_s: int = 10, max_retries: int = 2
) -> List[str]:
    # Union usernames across nodes. No sudo required.
    tasks = [
        _ssh_run(n, REMOTE_USERS_SCRIPT, timeout_s=timeout_s, max_retries=max_retries)
        for n in config.nodes
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    out: List[str] = []
    seen = set()
    for r in results:
        if isinstance(r, Exception):
            continue
        rc, stdout, _stderr = r
        if int(rc) != 0:
            continue
        for u in _parse_users_output(stdout):
            if u in seen:
                continue
            seen.add(u)
            out.append(u)

    out.sort()
    return out


def _parse_remote_output(node: NodeConfig, stdout: str) -> Tuple[Dict[str, str], List[GPUInfo], List[GPUProcess]]:
    lines = stdout.splitlines()

    # Single-pass: find all known section markers at once
    _MARKERS = frozenset({
        "__OPENSMI_BEGIN__", "__OPENSMI_END__",
        "__GPUS__", "__PROCS__", "__OWNERS__",
    })
    idx: Dict[str, int] = {}
    for i, line in enumerate(lines):
        s = line.strip()
        if s in _MARKERS:
            idx[s] = i

    begin_i = idx.get("__OPENSMI_BEGIN__", -1)
    end_i = idx.get("__OPENSMI_END__", -1)
    if begin_i == -1 or end_i == -1 or end_i <= begin_i:
        raise ValueError("Unexpected remote output (missing begin/end markers)")

    gpus_i = idx.get("__GPUS__", -1)
    procs_i = idx.get("__PROCS__", -1)
    owners_i = idx.get("__OWNERS__", -1)
    if gpus_i == -1 or procs_i == -1 or owners_i == -1:
        raise ValueError("Unexpected remote output (missing section markers)")

    meta_lines = lines[begin_i + 1 : gpus_i]
    gpu_lines = lines[gpus_i + 1 : procs_i]
    proc_lines = lines[procs_i + 1 : owners_i]
    owner_lines = lines[owners_i + 1 : end_i]

    meta: Dict[str, str] = {}
    for raw in meta_lines:
        s = raw.strip()
        if not s or "=" not in s:
            continue
        k, v = s.split("=", 1)
        meta[k.strip()] = v.strip()

    gpus: List[GPUInfo] = []
    for row in _parse_csv_lines(gpu_lines):
        # index, uuid, name, memory.total, memory.used, utilization.gpu, temperature.gpu, power.draw
        if len(row) < 4:
            continue
        try:
            idx = int(row[0])
        except ValueError:
            continue

        mem_total = _int_or_none(row[3]) if len(row) > 3 else None
        mem_used = _int_or_none(row[4]) if len(row) > 4 else None
        mem_free = None
        if mem_total is not None and mem_used is not None:
            mem_free = mem_total - mem_used
        util = _int_or_none(row[5]) if len(row) > 5 else None
        temp = _int_or_none(row[6]) if len(row) > 6 else None
        power = _float_or_none(row[7]) if len(row) > 7 else None

        gpus.append(
            GPUInfo(
                index=idx,
                uuid=row[1],
                name=row[2],
                memory_total_mib=mem_total,
                memory_used_mib=mem_used,
                memory_free_mib=mem_free,
                utilization_gpu_percent=util,
                temperature_c=temp,
                power_draw_w=power,
            )
        )

    owners: Dict[int, str] = {}
    runtimes: Dict[int, Optional[int]] = {}
    cmdlines: Dict[int, Optional[str]] = {}
    for row in _parse_csv_lines(owner_lines):
        if len(row) < 2:
            continue
        try:
            pid = int(row[0])
        except ValueError:
            continue
        owners[pid] = row[1]

        rt: Optional[int] = None
        if len(row) >= 3:
            try:
                rt = int(row[2]) if str(row[2]).strip() else None
            except Exception:
                rt = None
        runtimes[pid] = rt
        cmdlines[pid] = _decode_cmdline_b64(row[3]) if len(row) >= 4 else None

    procs: List[GPUProcess] = []
    for row in _parse_csv_lines(proc_lines):
        # gpu_uuid,pid,process_name,used_memory
        if len(row) < 4:
            continue
        try:
            pid = int(row[1])
        except ValueError:
            continue
        used: Optional[int]
        try:
            used = int(row[3])
        except Exception:
            used = None

        procs.append(
            GPUProcess(
                gpu_uuid=row[0],
                pid=pid,
                process_name=row[2],
                cmdline=cmdlines.get(pid),
                used_memory_mib=used,
                user=owners.get(pid, "unknown"),
                runtime_s=runtimes.get(pid),
            )
        )

    return meta, gpus, procs


async def poll_node(node: NodeConfig, timeout_s: int, max_retries: int = 2) -> NodeSnapshot:
    snap = NodeSnapshot(node_alias=node.alias, address=node.address)
    snap.timestamp = now_kst_iso()

    try:
        rc, stdout, stderr = await _ssh_run(
            node, REMOTE_SCRIPT, timeout_s=timeout_s, max_retries=max_retries
        )
        if rc != 0:
            # Some SSH failures return rc=255
            err = (stderr.strip() or stdout.strip() or f"ssh exited {rc}")
            raise SSHError(err)

        meta, gpus, procs = _parse_remote_output(node, stdout)
        snap.hostname = meta.get("hostname")
        snap.os = meta.get("os")
        snap.gpus = gpus
        snap.processes = procs

    except Exception as e:
        snap.error = str(e)

    return snap


async def poll_cluster(
    config: ClusterConfig, *, timeout_s: int = 15, max_retries: int = 2
) -> ClusterSnapshot:
    tasks = [
        poll_node(n, timeout_s=timeout_s, max_retries=max_retries)
        for n in config.nodes
    ]
    nodes = await asyncio.gather(*tasks)

    return ClusterSnapshot(
        cluster_name=config.cluster_name,
        timestamp=now_kst_iso(),
        nodes=nodes,
    )


def snapshot_to_jsonable(snapshot: ClusterSnapshot) -> Dict[str, object]:
    return asdict(snapshot)
