from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional

from . import __version__
from .allocations import (
    Allocation,
    load_allocations,
    remove_allocation,
    save_allocations,
    upsert_allocation,
)
from .collector import fetch_users, poll_cluster, snapshot_to_jsonable
from .models import (
    NodeTarget,
    PreflightCheck,
    PreflightCheckType,
    RemoteExecutionContext,
)
from .config import default_config_data, load_all_clusters, load_config
from .sshutil import SSHRunError, ssh_bash_script, ssh_run
from .executor import (
    inject_cuda_visible_devices,
    route_command_to_target,
    run_preflight_checks,
)
from .state import (
    atomic_write_text,
    ensure_state_dir,
    get_state_dir,
    latest_snapshot_path,
    resolve_config_path,
)
from .violations import find_violations
from .update import UpdateError, update as update_release
from .uninstall import UninstallError, run_uninstall
from .jobs import (
    Job,
    cancel_job,
    check_job_alive,
    cleanup_tmux_artifacts_for_sessions,
    cleanup_old_jobs,
    get_job,
    load_jobs,
    retry_job,
    save_jobs,
    upsert_job,
)
from datetime import datetime, timezone
import time


def _current_operator() -> str:
    # Prefer original user when running under sudo.
    return os.environ.get("SUDO_USER") or os.environ.get("USER") or "unknown"


def _is_config_admin(cfg) -> bool:
    admins = dict(getattr(cfg, "admins", {}) or {})
    master = str(admins.get("master") or "").strip()
    members = admins.get("members")
    if isinstance(members, str):
        members_list = [members]
    elif isinstance(members, list):
        members_list = [str(x) for x in members]
    else:
        members_list = []

    op = _current_operator()
    if not op:
        return False

    if master and op == master:
        return True
    return op in set(members_list)


def _remote_sudo_groups(cfg) -> set[str]:
    admins = dict(getattr(cfg, "admins", {}) or {})
    raw = admins.get("remote_sudo_groups")
    if isinstance(raw, str):
        groups = [raw]
    elif isinstance(raw, list):
        groups = [str(x) for x in raw]
    else:
        groups = ["sudo", "wheel"]

    return {g.strip() for g in groups if str(g).strip()}


def _find_node(cfg, alias: str):
    # Sanitize input alias to match config (config aliases are sanitized at load time)
    safe = alias.replace("#", "-").replace(":", "-")
    for n in cfg.nodes:
        if n.alias == safe:
            return n
    raise ValueError(f"Unknown node alias: {alias}")


def _check_remote_sudo_group(
    cfg, node_alias: str, *, timeout_s: int = 8
) -> tuple[bool, list[str]]:
    """Return (ok, groups) for the SSH user on that node."""
    node = _find_node(cfg, node_alias)

    rc, stdout, stderr = asyncio.run(ssh_run(node, ["id", "-nG"], timeout_s=timeout_s))
    if rc != 0:
        raise SSHRunError(stderr.strip() or f"id -nG failed (rc={rc})")

    groups = [g for g in stdout.strip().split() if g]
    required = _remote_sudo_groups(cfg)
    ok = any(g in required for g in groups)
    return ok, groups


def _require_admin(
    cfg, action: str, *, node_aliases: Optional[list[str]] = None
) -> None:
    """Require admin.

    Policy:
      - Must be config-admin (admins.master/members)
      - Must have remote sudo-group membership on target nodes (admins.remote_sudo_groups)
    """
    if not _is_config_admin(cfg):
        op = _current_operator()
        admins = dict(getattr(cfg, "admins", {}) or {})
        master = str(admins.get("master") or "").strip()
        members = admins.get("members")
        members_list = members if isinstance(members, list) else []

        print(
            f"Permission denied: '{op}' is not an admin for action '{action}'.\n"
            f"Configure admins in opensmi.json (admins.master / admins.members).\n"
            f"Current: master={master!r}, members={members_list!r}",
            file=sys.stderr,
        )
        raise SystemExit(3)

    if not node_aliases:
        return

    required = ",".join(sorted(_remote_sudo_groups(cfg)))
    failures: list[str] = []

    for alias in node_aliases:
        try:
            ok, groups = _check_remote_sudo_group(cfg, alias)
        except Exception as e:
            failures.append(f"{alias} (check failed: {e})")
            continue

        if not ok:
            failures.append(f"{alias} (groups: {' '.join(groups)})")

    if failures:
        print(
            "Permission denied: admin actions require the SSH user to be in a sudo-capable group on the target node(s).\n"
            f"Required groups: {required}\n"
            "Failing nodes:\n  - " + "\n  - ".join(failures),
            file=sys.stderr,
        )
        raise SystemExit(3)


def _cmd_init(args: argparse.Namespace) -> int:
    """Deprecated — use 'opensmi onboard' instead."""
    print(
        "\033[33mWarning:\033[0m 'opensmi init' is deprecated."
        " Use 'opensmi onboard' instead.",
        file=sys.stderr,
    )
    return _cmd_onboard(args)


# ── ANSI helpers (tty-safe) ────────────────────────────────────────────────
def _ob_c(code: str) -> str:
    return f"\033[{code}m" if sys.stdout.isatty() else ""


_OB_GREEN = _ob_c("32")
_OB_YELLOW = _ob_c("33")
_OB_BOLD = _ob_c("1")
_OB_DIM = _ob_c("2")
_OB_RESET = _ob_c("0")


def _ob_box_row(text: str, W: int = 44, style: str = "") -> str:
    return (
        f"  {_OB_GREEN}│{_OB_RESET}  {style}{text[:W].ljust(W)}{_OB_RESET}"
        f"{_OB_GREEN}│{_OB_RESET}"
    )


def _ob_prompt(label: str, hint: str, default: str) -> str:
    """Return a formatted prompt string."""
    hint_str = f"  {_OB_DIM}{hint}{_OB_RESET}\n" if hint else ""
    default_str = f" [{_OB_DIM}{default}{_OB_RESET}]" if default else ""
    return f"{hint_str}  {_OB_BOLD}{label}{_OB_RESET}{default_str}: "


_SSH_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


def _ob_ssh_test(
    address: str,
    user: str,
    *,
    port: int = 22,
    identityfile: str = "",
    proxyjump: str = "",
    timeout: int = 5,
) -> tuple[bool, str]:
    cmd = [
        "ssh",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=no",
    ]
    if int(port) > 0 and int(port) != 22:
        cmd += ["-p", str(int(port))]
    if identityfile:
        cmd += ["-i", identityfile]
    if proxyjump:
        cmd += ["-o", f"ProxyJump={proxyjump}"]
    cmd += [f"{user}@{address}", "true"]

    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout + 1,
        )
        if r.returncode == 0:
            return True, ""
        err = (r.stderr or "").strip() or (r.stdout or "").strip() or "ssh failed"
        return False, err
    except Exception as e:
        return False, str(e)


_KNOWN_SERVICE_DOMAINS = frozenset({
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "sourceforge.net",
    "heroku.com",
    "aws.amazon.com",
})

_AUTH_FAILURE_KEYWORDS = ("Permission denied", "publickey", "password", "authentication failed")


def _ob_is_auth_failure(stderr: str) -> bool:
    low = stderr.lower()
    return any(kw.lower() in low for kw in _AUTH_FAILURE_KEYWORDS)


def _ob_find_local_pubkey() -> Optional[str]:
    ssh_dir = Path.home() / ".ssh"
    for name in ("id_ed25519.pub", "id_rsa.pub", "id_ecdsa.pub", "id_dsa.pub"):
        candidate = ssh_dir / name
        if candidate.exists():
            return str(candidate)
    return None


def _ob_generate_ssh_key() -> Optional[str]:
    key_path = Path.home() / ".ssh" / "id_ed25519"
    try:
        r = subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key_path)],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            pub = str(key_path) + ".pub"
            if Path(pub).exists():
                return pub
    except Exception:
        pass
    return None


def _ob_copy_id(address: str, user: str, port: int, pubkey_path: str) -> tuple[bool, str]:
    import shutil as _shutil
    if not _shutil.which("ssh-copy-id"):
        print(
            f"  {_OB_YELLOW}⚠{_OB_RESET}  ssh-copy-id not found. Add the key manually:\n"
            f"    cat {pubkey_path} | ssh -p {port} {user}@{address}"
            f" 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys'"
        )
        return False, "ssh-copy-id not available"
    cmd = ["ssh-copy-id", "-i", pubkey_path, "-p", str(port), f"{user}@{address}"]
    print(f"  Running: {' '.join(cmd)}")
    try:
        r = subprocess.run(cmd)  # no capture_output — TTY passthrough for password
        if r.returncode == 0:
            return True, ""
        return False, f"ssh-copy-id exited with code {r.returncode}"
    except Exception as e:
        return False, str(e)


def _ob_filter_ssh_hosts(hosts: list[dict]) -> tuple[list[dict], list[dict]]:
    """Filter known service hosts from SSH config hosts.

    Pass 1: static domain blacklist (no network).
    Pass 2: parallel quick probe (ConnectTimeout=3).
    Returns (kept, filtered).
    """
    import asyncio

    kept: list[dict] = []
    filtered: list[dict] = []

    # Pass 1: static blacklist
    pass1_kept: list[dict] = []
    for host in hosts:
        addr = str(host.get("address") or "").lower().rstrip(".")
        is_service = any(addr == d or addr.endswith("." + d) for d in _KNOWN_SERVICE_DOMAINS)
        if is_service:
            filtered.append(dict(host, _filter_reason="known service domain"))
        else:
            pass1_kept.append(host)

    if not pass1_kept:
        return kept, filtered

    # Pass 2: parallel quick probe
    async def _probe(host: dict) -> tuple[dict, str]:
        user = str(host.get("user") or "")
        address = str(host.get("address") or "")
        port = int(host.get("port") or 22)
        identityfile = str(host.get("identityfile") or "")
        proxyjump = str(host.get("proxyjump") or "")
        cmd = [
            "ssh",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=3",
            "-o", "StrictHostKeyChecking=no",
        ]
        if port != 22:
            cmd += ["-p", str(port)]
        if identityfile:
            cmd += ["-i", identityfile]
        if proxyjump:
            cmd += ["-o", f"ProxyJump={proxyjump}"]
        cmd += [f"{user}@{address}", "echo __opensmi__"]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=6)
            out = (stdout_b or b"").decode(errors="replace")
            err = (stderr_b or b"").decode(errors="replace")
            if "__opensmi__" in out:
                return host, "keep"
            combined = out + err
            if (
                "does not provide shell access" in combined
                or "PTY allocation request failed" in combined
            ):
                return host, "filter:no shell access"
            if _ob_is_auth_failure(err):
                return host, "keep"
            return host, "unknown"
        except Exception:
            return host, "unknown"

    async def _run_probes(host_list: list[dict]) -> list[tuple[dict, str]]:
        return list(await asyncio.gather(*[_probe(h) for h in host_list]))

    try:
        results = asyncio.run(_run_probes(pass1_kept))
    except Exception:
        return pass1_kept + kept, filtered

    for host, status in results:
        if status.startswith("filter:"):
            reason = status[len("filter:"):]
            filtered.append(dict(host, _filter_reason=reason))
        else:
            kept.append(host)

    return kept, filtered


def _ob_arrow_select(options: list[str], default: int = 0) -> int:
    """Horizontal arrow-key selector. Left/right moves highlight, Enter confirms.

    Falls back to number entry if stdin is not a tty. Returns the selected index.
    """
    import termios
    import tty

    n = len(options)

    if not sys.stdin.isatty():
        for i, opt in enumerate(options, 1):
            print(f"  {i}. {opt}")
        while True:
            raw = input(f"  Choice [1-{n}]: ").strip()
            if raw.isdigit() and 1 <= int(raw) <= n:
                return int(raw) - 1
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Enter 1–{n}.")

    idx = default

    def _render() -> None:
        parts = []
        for i, opt in enumerate(options):
            if i == idx:
                parts.append(f"{_OB_BOLD}\033[7m {opt} \033[27m{_OB_RESET}")
            else:
                parts.append(f"{_OB_DIM} {opt} {_OB_RESET}")
        sys.stdout.write("\r  " + "  ".join(parts) + "   ")
        sys.stdout.flush()

    _render()
    fd = sys.stdin.fileno()
    old_attrs = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        while True:
            ch = sys.stdin.read(1)
            if ch in ("\r", "\n"):
                break
            if ch == "\x03":
                raise KeyboardInterrupt
            if ch == "\x1b":
                seq = sys.stdin.read(2)
                if seq == "[D":   # left arrow
                    idx = (idx - 1) % n
                elif seq == "[C": # right arrow
                    idx = (idx + 1) % n
            _render()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_attrs)
    sys.stdout.write("\n")
    return idx


def _ob_handle_auth_failure_recovery(
    node: dict,
    result: dict,
    *,
    identityfile: str = "",
) -> str:
    """Show [1/2/3] recovery menu for an auth-failed node.

    Returns: "added", "skipped", or "added_anyway".
    """
    alias = str(result.get("alias") or node.get("alias") or "node")
    address = str(node.get("address") or "")
    user = str(node.get("user") or "")
    port = int(node.get("port") or 22)

    print(f"\n  {_OB_BOLD}─── {alias}{_OB_RESET}  {_OB_DIM}{user}@{address}:{port} — key auth required{_OB_RESET}")

    pubkey: Optional[str] = None
    if identityfile:
        candidate = identityfile + ".pub"
        if Path(candidate).exists():
            pubkey = candidate
    if not pubkey:
        pubkey = _ob_find_local_pubkey()

    while True:
        key_hint = pubkey or "no key in ~/.ssh/"
        print(f"\n  {_OB_DIM}key: {key_hint}{_OB_RESET}")
        _sel = _ob_arrow_select(["copy key", "skip", "add anyway"])
        choice = str(_sel + 1)  # 0→"1", 1→"2", 2→"3"

        if choice == "1":
            if not pubkey:
                raw_gen = (
                    input(
                        f"  {_OB_DIM}No key found. Generate a new ed25519 key?{_OB_RESET} [Y/n]: "
                    )
                    .strip()
                    .lower()
                )
                if raw_gen not in ("n", "no"):
                    pubkey = _ob_generate_ssh_key()
                    if not pubkey:
                        print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Key generation failed.")
                        continue
                    print(f"  Generated: {pubkey}")
                else:
                    print(
                        f"  {_OB_DIM}Tip: run 'ssh-copy-id {user}@{address}' then re-run 'opensmi onboard'{_OB_RESET}"
                    )
                    return "skipped"

            ok, copy_err = _ob_copy_id(address, user, port, pubkey)
            if not ok:
                print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Key copy failed: {copy_err}")
                raw_retry = input("  Try again? [y/N]: ").strip().lower()
                if raw_retry in ("y", "yes"):
                    continue
                print(
                    f"  {_OB_DIM}Tip: run 'ssh-copy-id {user}@{address}' then re-run 'opensmi onboard'{_OB_RESET}"
                )
                return "skipped"

            sys.stdout.write(f"  Retesting {alias}... ")
            sys.stdout.flush()
            ok2, msg2 = _ob_ssh_test(
                address, user, port=port, identityfile=identityfile or ""
            )
            if ok2:
                print(f"{_OB_GREEN}✓ Connected{_OB_RESET}")
                return "added"
            print(f"{_OB_YELLOW}⚠ still failing: {msg2}{_OB_RESET}")
            print("  Key was copied but SSH test still fails. Adding node anyway.")
            return "added_anyway"

        elif choice == "2":
            print(
                f"  {_OB_DIM}Tip: run 'ssh-copy-id {user}@{address}' then re-run 'opensmi onboard'{_OB_RESET}"
            )
            return "skipped"

        elif choice == "3":
            print(
                f"  {_OB_YELLOW}⚠{_OB_RESET}  Node added. Run 'ssh-copy-id {user}@{address}' to enable polling.\n"
                f"  {_OB_DIM}Note: Password auth won't work — opensmi requires key-based auth for background polling.{_OB_RESET}"
            )
            return "added_anyway"

        else:
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Enter 1, 2, or 3.")


def _is_valid_ssh_alias(token: str) -> bool:
    t = (token or "").strip()
    if not t:
        return False
    if t.startswith("!"):
        return False
    if any(ch in t for ch in "*?"):
        return False
    return bool(_SSH_ALIAS_RE.match(t))


def _parse_ssh_host_aliases(config_text: str) -> list[str]:
    aliases: list[str] = []
    seen: set[str] = set()

    for raw_line in config_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        if parts[0].lower() != "host":
            continue

        for token in parts[1].split():
            if not _is_valid_ssh_alias(token):
                continue
            if token not in seen:
                aliases.append(token)
                seen.add(token)

    return aliases


def _parse_ssh_g_output(stdout: str) -> dict:
    out: dict[str, object] = {
        "address": "",
        "user": "",
        "port": 22,
        "identityfile": "",
        "proxyjump": "",
    }
    identityfiles: list[str] = []

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        key, sep, value = line.partition(" ")
        if not sep:
            continue
        k = key.lower().strip()
        v = value.strip()
        if not v:
            continue

        if k == "hostname":
            out["address"] = v
        elif k == "user":
            out["user"] = v
        elif k == "port":
            try:
                p = int(v)
                if p > 0:
                    out["port"] = p
            except ValueError:
                pass
        elif k == "identityfile" and v.lower() != "none":
            identityfiles.append(v)
        elif k == "proxyjump" and v.lower() != "none":
            out["proxyjump"] = v

    if identityfiles:
        out["identityfile"] = identityfiles[0]
    return out


def _resolve_ssh_host_effective(alias: str, ssh_path: Path) -> Optional[dict]:
    try:
        r = subprocess.run(
            ["ssh", "-G", "-F", str(ssh_path), alias],
            capture_output=True,
            text=True,
            timeout=8,
        )
    except Exception:
        return None

    if r.returncode != 0:
        return None

    parsed = _parse_ssh_g_output(r.stdout)
    address = str(parsed.get("address") or "").strip()
    if not address or any(ch in address for ch in "*?"):
        return None

    user = str(parsed.get("user") or os.environ.get("USER") or "root").strip() or "root"
    port = int(parsed.get("port") or 22)
    return {
        "alias": alias,
        "address": address,
        "user": user,
        "port": port,
        "identityfile": str(parsed.get("identityfile") or ""),
        "proxyjump": str(parsed.get("proxyjump") or ""),
    }


def _discover_ssh_config_hosts(ssh_config_path: str) -> tuple[Path, list[dict]]:
    ssh_path = Path(ssh_config_path).expanduser().resolve()
    if not ssh_path.exists():
        raise FileNotFoundError(f"SSH config not found: {ssh_path}")

    text = ssh_path.read_text(encoding="utf-8")
    aliases = _parse_ssh_host_aliases(text)

    hosts: list[dict] = []
    seen_aliases: set[str] = set()
    for alias in aliases:
        host = _resolve_ssh_host_effective(alias, ssh_path)
        if not host:
            continue
        a = str(host["alias"])
        if a in seen_aliases:
            continue
        hosts.append(host)
        seen_aliases.add(a)

    return ssh_path, hosts


def _parse_selection_input(raw: str, total: int) -> list[int]:
    if total <= 0:
        raise ValueError("No items to select")

    txt = (raw or "").strip().lower()
    if txt in ("", "all", "a", "*"):
        return list(range(1, total + 1))

    selected: set[int] = set()
    for part in txt.split(","):
        token = part.strip()
        if not token:
            raise ValueError("Empty token")

        if "-" in token:
            start_s, end_s = token.split("-", 1)
            if not start_s.isdigit() or not end_s.isdigit():
                raise ValueError("Invalid range token")
            start = int(start_s)
            end = int(end_s)
            if start > end:
                raise ValueError("Range start must be <= end")
            for idx in range(start, end + 1):
                if idx < 1 or idx > total:
                    raise ValueError("Selection out of bounds")
                selected.add(idx)
            continue

        if not token.isdigit():
            raise ValueError("Invalid index token")
        idx = int(token)
        if idx < 1 or idx > total:
            raise ValueError("Selection out of bounds")
        selected.add(idx)

    if not selected:
        raise ValueError("No selection")
    return sorted(selected)


def _host_to_config_node(host: dict) -> dict:
    node: dict[str, object] = {
        "alias": str(host.get("alias") or "").strip(),
        "address": str(host.get("address") or "").strip(),
        "user": str(host.get("user") or "root").strip() or "root",
    }
    port = int(host.get("port") or 22)
    if port != 22:
        node["port"] = port
    return node


def _verify_nodes(nodes: list[dict], *, timeout: int = 5) -> list[dict]:
    results: list[dict] = []
    for idx, node in enumerate(nodes):
        address = str(node.get("address") or "").strip()
        user = str(node.get("user") or os.environ.get("USER") or "ubuntu").strip()
        port = int(node.get("port") or 22)
        identityfile = str(node.get("identityfile") or "").strip()
        proxyjump = str(node.get("proxyjump") or "").strip()
        ok, message = _ob_ssh_test(
            address,
            user,
            port=port,
            identityfile=identityfile,
            proxyjump=proxyjump,
            timeout=timeout,
        )
        results.append(
            {
                "index": idx,
                "alias": str(node.get("alias") or f"node-{idx + 1}"),
                "target": f"{user}@{address}:{port}",
                "ok": ok,
                "message": message,
            }
        )
    return results


def _summarize_verify_results(results: list[dict]) -> dict:
    total = len(results)
    ok = sum(1 for r in results if bool(r.get("ok")))
    failed = total - ok
    return {"total": total, "ok": ok, "failed": failed}


def _print_verify_summary(results: list[dict]) -> None:
    summary = _summarize_verify_results(results)
    print(f"\n  {_OB_BOLD}Connectivity verify summary{_OB_RESET}")
    for r in results:
        mark = f"{_OB_GREEN}✓{_OB_RESET}" if r["ok"] else f"{_OB_YELLOW}✗{_OB_RESET}"
        print(f"  {mark} {r['alias']}: {r['target']}")
        if not r["ok"] and r.get("message"):
            print(f"    {_OB_DIM}{r['message']}{_OB_RESET}")
    print(
        f"  {_OB_DIM}Result:{_OB_RESET} "
        f"{summary['ok']}/{summary['total']} reachable, {summary['failed']} failed"
    )


def _reedit_node(node: dict) -> dict:
    current_alias = str(node.get("alias") or "GPU-01")
    current_address = str(node.get("address") or "")
    current_user = str(node.get("user") or os.environ.get("USER") or "ubuntu")
    current_port = int(node.get("port") or 22)
    current_identity = str(node.get("identityfile") or "")
    current_proxyjump = str(node.get("proxyjump") or "")

    while True:
        alias = input(_ob_prompt("  Alias", "", current_alias)).strip() or current_alias
        address = (
            input(_ob_prompt("  Address", "IP or hostname", current_address)).strip()
            or current_address
        )
        user = input(_ob_prompt("  SSH user", "", current_user)).strip() or current_user
        raw_port = input(
            _ob_prompt("  SSH port", "", str(current_port))
        ).strip() or str(current_port)
        try:
            port = int(raw_port)
            if port <= 0:
                raise ValueError
        except ValueError:
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  SSH port must be a positive integer.")
            continue

        identityfile = (
            input(_ob_prompt("  Identity file", "Optional", current_identity)).strip()
            or current_identity
        )
        proxyjump = (
            input(_ob_prompt("  ProxyJump", "Optional", current_proxyjump)).strip()
            or current_proxyjump
        )

        sys.stdout.write(
            f"  {_OB_DIM}Testing SSH ({user}@{address}:{port})...{_OB_RESET}  "
        )
        sys.stdout.flush()
        ok, message = _ob_ssh_test(
            address,
            user,
            port=port,
            identityfile=identityfile,
            proxyjump=proxyjump,
        )
        if ok:
            print(f"{_OB_GREEN}✓ connected{_OB_RESET}")
            return {
                "alias": alias,
                "address": address,
                "user": user,
                "port": port,
                "identityfile": identityfile,
                "proxyjump": proxyjump,
            }

        print(f"{_OB_YELLOW}⚠ unreachable{_OB_RESET}")
        if message:
            print(f"  {_OB_DIM}{message}{_OB_RESET}")
        raw_keep = (
            input(f"  {_OB_DIM}Keep these values anyway?{_OB_RESET} [y/N]: ")
            .strip()
            .lower()
        )
        if raw_keep == "y":
            return {
                "alias": alias,
                "address": address,
                "user": user,
                "port": port,
                "identityfile": identityfile,
                "proxyjump": proxyjump,
            }
        print(f"  {_OB_DIM}Re-enter node details.{_OB_RESET}\n")


def _cmd_onboard(args: argparse.Namespace) -> int:
    """Onboarding wizard to create opensmi.json (interactive)."""
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)

    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)

    if cfg_path.exists() and not bool(args.force):
        print(
            f"{_OB_YELLOW}Config already exists:{_OB_RESET} {cfg_path}\n"
            f"  To add a node:   opensmi node add\n"
            f"  To reconfigure:  opensmi onboard --force",
            file=sys.stderr,
        )
        return 2

    if getattr(args, "from_ssh_config", None):
        return _init_from_ssh_config(cfg_path, args.from_ssh_config)

    if getattr(args, "defaults", False):
        import json as _json

        base = default_config_data()
        cluster = {
            "cluster_name": str(base.get("cluster_name") or "GPU-Cluster"),
            "nodes": list(base.get("nodes") or []),
        }
        data = {
            "clusters": [cluster],
            "admins": dict(base.get("admins") or {}),
            "users": list(base.get("users") or []),
            "policy": dict(base.get("policy") or {}),
            "slurm_clusters": [],
        }
        atomic_write_text(cfg_path, _json.dumps(data, indent=2, sort_keys=False) + "\n")
        print(f"Config created: {cfg_path}")
        print("Edit it, then run: opensmi poll")
        return 0

    return _init_wizard(cfg_path, n_nodes=getattr(args, "nodes", None))


def _init_wizard_legacy(cfg_path: Path, *, n_nodes: Optional[int] = None) -> int:
    """Interactive onboarding wizard — fancy edition."""
    import json as _json

    W = 44
    line = "─" * W

    # ── header ────────────────────────────────────────────────────────────
    print(f"\n  {_OB_GREEN}╭{line}╮{_OB_RESET}")
    print(_ob_box_row("opensmi onboard", W, _OB_BOLD))
    print(_ob_box_row("Set up your GPU cluster config.", W, _OB_DIM))
    print(f"  {_OB_GREEN}╰{line}╯{_OB_RESET}\n")

    # ── cluster label ──────────────────────────────────────────────────────
    raw = input(
        _ob_prompt(
            "Cluster label",
            "Shown in the dashboard header — any name you like.",
            "GPU-Cluster",
        )
    ).strip()
    cluster_name = raw or "GPU-Cluster"

    nodes: list[dict] = []
    mode_default = "a"
    mode_raw = (
        input(
            _ob_prompt(
                "Node setup mode",
                "a=auto import from ~/.ssh/config, m=manual entry",
                mode_default,
            )
        )
        .strip()
        .lower()
        or mode_default
    )
    setup_mode = "manual" if mode_raw.startswith("m") else "auto"

    if setup_mode == "auto":
        ssh_raw = input(_ob_prompt("SSH config path", "", "~/.ssh/config")).strip()
        ssh_cfg = ssh_raw or "~/.ssh/config"

        try:
            ssh_path, discovered = _discover_ssh_config_hosts(ssh_cfg)
        except FileNotFoundError as e:
            print(str(e), file=sys.stderr)
            return 2

        if not discovered:
            print(
                f"  {_OB_YELLOW}⚠{_OB_RESET}  No importable hosts found in {ssh_path}"
            )
            raw_fallback = (
                input(f"  {_OB_DIM}Switch to manual entry?{_OB_RESET} [Y/n]: ")
                .strip()
                .lower()
            )
            if raw_fallback == "n":
                return 2
            setup_mode = "manual"
        else:
            print(
                f"\n  {_OB_BOLD}Discovered SSH hosts{_OB_RESET}  {_OB_DIM}({len(discovered)} total){_OB_RESET}"
            )
            for i, host in enumerate(discovered, start=1):
                port = int(host.get("port") or 22)
                extra = []
                if host.get("identityfile"):
                    extra.append("id")
                if host.get("proxyjump"):
                    extra.append("jump")
                extra_str = (
                    f"  {_OB_DIM}[{','.join(extra)}]{_OB_RESET}" if extra else ""
                )
                print(
                    f"  {str(i).rjust(2)}. {host['alias']:<16} "
                    f"{host['user']}@{host['address']}:{port}{extra_str}"
                )

            while True:
                raw_sel = input(
                    _ob_prompt(
                        "Select hosts",
                        "all or 1,3-5",
                        "all",
                    )
                ).strip()
                try:
                    picks = _parse_selection_input(raw_sel, len(discovered))
                    nodes = [dict(discovered[idx - 1]) for idx in picks]
                    break
                except ValueError:
                    print(
                        f"  {_OB_YELLOW}⚠{_OB_RESET}  Invalid selection. "
                        "Use all or index/range list like 1,3-5."
                    )

            print(
                f"\n  {_OB_DIM}Imported {len(nodes)} node(s) from {ssh_path}.{_OB_RESET}\n"
            )

    if setup_mode == "manual":
        if n_nodes is None:
            while True:
                raw_n = input(_ob_prompt("Number of GPU nodes", "", "2")).strip() or "2"
                try:
                    n_nodes = int(raw_n)
                    if n_nodes <= 0:
                        raise ValueError
                    break
                except ValueError:
                    print(
                        f"  {_OB_YELLOW}⚠{_OB_RESET}  Please enter a positive integer."
                    )
        else:
            if int(n_nodes) <= 0:
                print("--nodes must be a positive integer", file=sys.stderr)
                return 2
            n_nodes = int(n_nodes)

        print(
            f"\n  {_OB_BOLD}Add GPU nodes{_OB_RESET}  {_OB_DIM}({n_nodes} total){_OB_RESET}\n"
        )
        for idx in range(1, n_nodes + 1):
            default_alias = f"GPU-{idx:02d}"
            print(
                f"  {_OB_DIM}── Node #{idx} ──────────────────────────────────{_OB_RESET}"
            )
            while True:
                alias = (
                    input(_ob_prompt("  Alias", "", default_alias)).strip()
                    or default_alias
                )
                address = input(_ob_prompt("  Address", "IP or hostname", "")).strip()
                if not address:
                    print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Address is required.")
                    continue
                default_user = os.environ.get("USER", "ubuntu")
                user = (
                    input(_ob_prompt("  SSH user", "", default_user)).strip()
                    or default_user
                )
                raw_port = input(_ob_prompt("  SSH port", "", "22")).strip() or "22"
                try:
                    port = int(raw_port)
                    if port <= 0:
                        raise ValueError
                except ValueError:
                    print(
                        f"  {_OB_YELLOW}⚠{_OB_RESET}  SSH port must be a positive integer."
                    )
                    continue

                sys.stdout.write(
                    f"  {_OB_DIM}Testing SSH ({user}@{address}:{port})...{_OB_RESET}  "
                )
                sys.stdout.flush()
                ok, _msg = _ob_ssh_test(address, user, port=port)
                if ok:
                    print(f"{_OB_GREEN}✓ connected{_OB_RESET}")
                    nodes.append(
                        {
                            "alias": alias,
                            "address": address,
                            "user": user,
                            "port": port,
                        }
                    )
                    break

                print(f"{_OB_YELLOW}⚠ unreachable{_OB_RESET}")
                _node_draft = {"alias": alias, "address": address, "user": user, "port": port}
                _fake_result = {"alias": alias, "index": 0, "target": f"{user}@{address}:{port}", "ok": False, "message": _msg}
                if _ob_is_auth_failure(_msg):
                    _outcome = _ob_handle_auth_failure_recovery(_node_draft, _fake_result)
                    if _outcome in ("added", "added_anyway"):
                        nodes.append(_node_draft)
                        break
                    # skipped: re-enter node details
                    print(f"  {_OB_DIM}Re-enter node details.{_OB_RESET}\n")
                else:
                    raw_cont = (
                        input(f"  {_OB_DIM}Continue anyway?{_OB_RESET} [y/N]: ")
                        .strip()
                        .lower()
                    )
                    if raw_cont == "y":
                        nodes.append(_node_draft)
                        break
                    print(f"  {_OB_DIM}Re-enter node details.{_OB_RESET}\n")

            print()

    if not nodes:
        print(f"{_OB_YELLOW}No nodes added. Aborting.{_OB_RESET}")
        return 1

    # ── admin ──────────────────────────────────────────────────────────────
    _admin_raw = (
        input(
            _ob_prompt(
                "Admin username",
                "SSH user who manages the cluster. Enter 'idk' to skip.",
                "idk",
            )
        ).strip()
        or "idk"
    )
    admin: Optional[str] = None if _admin_raw.lower() == "idk" else _admin_raw

    # Always verify — mandatory before saving config
    print(f"\n  {_OB_BOLD}Verifying nodes...{_OB_RESET}")
    verify_results = _verify_nodes(nodes)
    _print_verify_summary(verify_results)
    failed = [r for r in verify_results if not bool(r.get("ok"))]
    if failed:
        print(f"\n  {_OB_BOLD}Resolving failed nodes...{_OB_RESET}")
        _legacy_to_remove: list[int] = []
        for r in failed:
            _idx = int(r["index"])
            _n = nodes[_idx]
            _err = str(r.get("message") or "")
            if _ob_is_auth_failure(_err):
                _outcome = _ob_handle_auth_failure_recovery(_n, r)
                if _outcome == "skipped":
                    _legacy_to_remove.append(_idx)
            else:
                print(
                    f"\n  {_OB_BOLD}─── {r.get('alias', 'node')}{_OB_RESET}"
                    f"  {_OB_DIM}network error: {_err}{_OB_RESET}"
                )
                _nc = "23"[_ob_arrow_select(["skip", "add anyway"])]
                if _nc == "2":
                    _legacy_to_remove.append(_idx)
                else:
                    print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Node added with warning.")
        for _idx in sorted(_legacy_to_remove, reverse=True):
            nodes.pop(_idx)

    config_nodes = [_host_to_config_node(n) for n in nodes]

    # ── write config ───────────────────────────────────────────────────────
    data = {
        "cluster_name": cluster_name,
        "nodes": config_nodes,
        "admins": {"master": admin, "members": ([admin] if admin else [])},
        "users": [],
        "policy": {
            "require_allocation": True,
            "all_users_token": "*",
            "enforcement": "detect_only",
        },
    }

    atomic_write_text(cfg_path, _json.dumps(data, indent=2, sort_keys=False) + "\n")

    # ── done card ──────────────────────────────────────────────────────────
    print(f"\n  {_OB_GREEN}╭{line}╮{_OB_RESET}")
    print(_ob_box_row(f"✓  Config saved", W, _OB_BOLD))
    print(_ob_box_row(f"   {cfg_path}", W, _OB_DIM))
    print(_ob_box_row("", W))
    print(_ob_box_row("Next steps:", W, _OB_DIM))
    print(_ob_box_row("  opensmi poll          # verify SSH + GPUs", W))
    print(_ob_box_row("  opensmi                # launch TUI", W))
    print(_ob_box_row("  opensmi alloc seed    # seed from live usage", W))
    print(f"  {_OB_GREEN}╰{line}╯{_OB_RESET}\n")

    return 0


def _init_wizard(cfg_path: Path, *, n_nodes: Optional[int] = None) -> int:
    import json as _json

    if n_nodes is not None and int(n_nodes) <= 0:
        print("--nodes must be a positive integer", file=sys.stderr)
        return 2

    W = 44
    line = "─" * W
    manual_default_nodes = int(n_nodes) if n_nodes is not None else 1
    current_user = os.environ.get("USER") or "ubuntu"

    def _build_payload(ssh_clusters: list[dict], slurm_clusters: list[dict]) -> dict:
        return {
            "clusters": [
                {
                    "cluster_name": str(c.get("cluster_name") or "GPU-Cluster"),
                    "nodes": [_host_to_config_node(n) for n in (c.get("nodes") or [])],
                }
                for c in ssh_clusters
            ],
            "admins": {
                "master": current_user,
                "members": [current_user],
                "remote_sudo_groups": ["sudo", "wheel"],
            },
            "users": [],
            "policy": {
                "require_allocation": True,
                "all_users_token": "*",
                "enforcement": "detect_only",
            },
            "slurm_clusters": list(slurm_clusters),
        }

    def _parse_host_and_port(raw: str) -> tuple[str, Optional[int]]:
        text = (raw or "").strip()
        if not text:
            return "", None
        if text.startswith("[") and "]:" in text:
            host_part, sep, port_part = text.rpartition("]:")
            if sep and host_part.startswith("[") and port_part.isdigit():
                port = int(port_part)
                if port > 0:
                    return host_part[1:], port
        if text.count(":") == 1:
            host_part, port_part = text.rsplit(":", 1)
            if host_part and port_part.isdigit():
                port = int(port_part)
                if port > 0:
                    return host_part, port
        return text, None

    def _prompt_nodes_for_cluster(default_count: int) -> list[dict]:
        mode_raw = (
            input(
                _ob_prompt(
                    "Node setup: (a)uto from ~/.ssh/config  or  (m)anual?",
                    "",
                    "a",
                )
            )
            .strip()
            .lower()
            or "a"
        )
        setup_mode = "manual" if mode_raw.startswith("m") else "auto"

        if setup_mode == "auto":
            try:
                ssh_path, discovered = _discover_ssh_config_hosts("~/.ssh/config")
            except FileNotFoundError:
                print(
                    f"  {_OB_YELLOW}⚠{_OB_RESET}  SSH config not found at ~/.ssh/config; switching to manual entry."
                )
                discovered = []
                ssh_path = Path("~/.ssh/config").expanduser()

            if discovered:
                kept, filtered_out = _ob_filter_ssh_hosts(discovered)
                if filtered_out:
                    print(
                        f"  {_OB_DIM}Filtered {len(filtered_out)} service host(s) "
                        f"({', '.join(h.get('alias', '') for h in filtered_out)}){_OB_RESET}"
                    )
                display = kept if kept else discovered
                print(
                    f"\n  {_OB_BOLD}SSH config hosts{_OB_RESET}  {_OB_DIM}({len(display)} found){_OB_RESET}"
                )
                for i, host in enumerate(display, start=1):
                    port = int(host.get("port") or 22)
                    port_str = f":{port}" if port != 22 else ""
                    status = ""
                    if host.get("_filter_reason"):
                        status = f"  {_OB_DIM}[filtered]{_OB_RESET}"
                    print(
                        f"  {str(i).rjust(2)}. {host['alias']:<16} "
                        f"{host['user']}@{host['address']}{port_str}{status}"
                    )

                while True:
                    raw_sel = input(
                        _ob_prompt("Select hosts", "all or 1,3-5", "all")
                    ).strip()
                    try:
                        picks = _parse_selection_input(raw_sel, len(display))
                        # Keep raw dicts (with identityfile) so SSH testing can use them
                        nodes = [dict(display[idx - 1]) for idx in picks]
                        break
                    except ValueError:
                        print(
                            f"  {_OB_YELLOW}⚠{_OB_RESET}  Invalid selection. Use all or index/range list like 1,3-5."
                        )

                print(
                    f"\n  {_OB_DIM}Imported {len(nodes)} node(s) from {ssh_path}.{_OB_RESET}\n"
                )
                return nodes

            print(
                f"  {_OB_YELLOW}⚠{_OB_RESET}  No importable hosts found; switching to manual entry."
            )

        while True:
            raw_n = input(
                _ob_prompt("How many nodes?", "", str(default_count))
            ).strip() or str(default_count)
            try:
                node_count = int(raw_n)
                if node_count <= 0:
                    raise ValueError
                break
            except ValueError:
                print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Please enter a positive integer.")

        nodes: list[dict] = []
        print(
            f"\n  {_OB_BOLD}Add nodes{_OB_RESET}  {_OB_DIM}({node_count} total){_OB_RESET}\n"
        )
        for idx in range(1, node_count + 1):
            default_alias = f"GPU-{idx:02d}"
            print(
                f"  {_OB_DIM}── Node #{idx} ──────────────────────────────────{_OB_RESET}"
            )
            while True:
                alias = (
                    input(_ob_prompt("Alias", "", default_alias)).strip()
                    or default_alias
                )
                raw_target = input(_ob_prompt("Hostname or IP", "", "")).strip()
                if not raw_target:
                    print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Hostname or IP is required.")
                    continue
                address, parsed_port = _parse_host_and_port(raw_target)
                if not address:
                    print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Hostname or IP is required.")
                    continue
                user = (
                    input(_ob_prompt("SSH user", "", current_user)).strip()
                    or current_user
                )
                node: dict[str, object] = {
                    "alias": alias,
                    "address": address,
                    "user": user,
                }
                if parsed_port is not None and parsed_port != 22:
                    node["port"] = parsed_port
                nodes.append(node)
                break
            print()
        return nodes

    def _prompt_slurm_cluster(existing: Optional[dict] = None) -> dict:
        default_name = str((existing or {}).get("name") or "HPC Cluster")
        default_login = str((existing or {}).get("login_node") or "")
        default_user = str((existing or {}).get("user") or current_user)

        name = (
            input(_ob_prompt("Slurm cluster name", "", default_name)).strip()
            or default_name
        )
        mode_raw = (
            input(
                _ob_prompt(
                    "Login node: (s)elect from SSH config  or  (m)anual?",
                    "",
                    "s",
                )
            )
            .strip()
            .lower()
            or "s"
        )
        manual_mode = mode_raw.startswith("m")
        select_mode = not manual_mode

        login_node = default_login
        if select_mode:
            try:
                _ssh_path, discovered = _discover_ssh_config_hosts("~/.ssh/config")
            except FileNotFoundError:
                discovered = []

            if discovered:
                print(
                    f"\n  {_OB_BOLD}SSH config hosts{_OB_RESET}  {_OB_DIM}({len(discovered)} found){_OB_RESET}"
                )
                for i, host in enumerate(discovered, start=1):
                    print(f"  {str(i).rjust(2)}. {host['alias']:<16} {host['address']}")
                while True:
                    raw_pick = (
                        input(_ob_prompt("Pick login node", "index", "1")).strip()
                        or "1"
                    )
                    if not raw_pick.isdigit():
                        print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Enter a valid index.")
                        continue
                    pick = int(raw_pick)
                    if pick < 1 or pick > len(discovered):
                        print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Selection out of range.")
                        continue
                    login_node = str(discovered[pick - 1]["alias"])
                    break
            else:
                print(
                    f"  {_OB_YELLOW}⚠{_OB_RESET}  No importable hosts found; switching to manual entry."
                )
                manual_mode = True

        if manual_mode:
            while True:
                raw_login = (
                    input(_ob_prompt("Login node hostname", "", default_login)).strip()
                    or default_login
                )
                if raw_login:
                    login_node = raw_login
                    break
                print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Login node is required.")

        user = (
            input(_ob_prompt("SSH user for login node", "", default_user)).strip()
            or default_user
        )
        return {"name": name, "login_node": login_node, "user": user}

    def _print_review(ssh_clusters: list[dict], slurm_clusters: list[dict]) -> None:
        print(f"\n  {_OB_BOLD}Final review{_OB_RESET}")
        print("  SSH Clusters:")
        for idx, cluster in enumerate(ssh_clusters, start=1):
            nodes = list(cluster.get("nodes") or [])
            aliases = [
                str(n.get("alias") or f"node-{i + 1}") for i, n in enumerate(nodes)
            ]
            joined = ", ".join(aliases) if aliases else "(none)"
            print(
                f"    {idx}. {cluster.get('cluster_name', f'Cluster-{idx}')} "
                f"({len(nodes)} nodes: {joined})"
            )
        print("  Slurm Clusters:")
        if not slurm_clusters:
            print("    (none)")
        for idx, sc in enumerate(slurm_clusters, start=1):
            print(
                f"    {idx}. {sc.get('name', 'Slurm Cluster')}  →  "
                f"{sc.get('login_node', '')} (user: {sc.get('user', '')})"
            )

    print(f"\n  {_OB_GREEN}╭{line}╮{_OB_RESET}")
    print(_ob_box_row("opensmi onboard", W, _OB_BOLD))
    print(_ob_box_row("Set up your GPU cluster config.", W, _OB_DIM))
    print(f"  {_OB_GREEN}╰{line}╯{_OB_RESET}\n")

    while True:
        raw_clusters = (
            input(_ob_prompt("How many SSH clusters?", "", "1")).strip() or "1"
        )
        try:
            cluster_count = int(raw_clusters)
            if cluster_count <= 0:
                raise ValueError
            break
        except ValueError:
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Please enter a positive integer.")

    ssh_clusters: list[dict] = []
    if cluster_count == 1:
        name = (
            input(_ob_prompt("Cluster name", "", "GPU-Cluster")).strip()
            or "GPU-Cluster"
        )
        ssh_clusters.append({"cluster_name": name, "nodes": []})
    else:
        for i in range(1, cluster_count + 1):
            default_name = f"Cluster-{i}"
            name = (
                input(_ob_prompt(f"Cluster name #{i}", "", default_name)).strip()
                or default_name
            )
            ssh_clusters.append({"cluster_name": name, "nodes": []})

    for idx, cluster in enumerate(ssh_clusters, start=1):
        print(f"\n  {_OB_BOLD}Cluster {idx}: {cluster['cluster_name']}{_OB_RESET}")
        nodes = _prompt_nodes_for_cluster(manual_default_nodes)
        if not nodes:
            print(f"{_OB_YELLOW}No nodes added. Aborting.{_OB_RESET}")
            return 1
        cluster["nodes"] = nodes

    # ── Mandatory SSH connectivity test ────────────────────────────────────
    all_nodes_flat: list[tuple[int, int, dict]] = []  # (cluster_idx, node_idx, node)
    for _ci, _cluster in enumerate(ssh_clusters):
        for _ni, _node in enumerate(list(_cluster.get("nodes") or [])):
            all_nodes_flat.append((_ci, _ni, _node))

    if all_nodes_flat:
        print(f"\n  {_OB_BOLD}Testing SSH connectivity...{_OB_RESET}")
        flat_nodes = [t[2] for t in all_nodes_flat]
        verify_results = _verify_nodes(flat_nodes)
        _print_verify_summary(verify_results)

        failed_results = [r for r in verify_results if not r.get("ok")]
        if failed_results:
            print(f"\n  {_OB_BOLD}Resolving failed nodes...{_OB_RESET}")
            to_skip: set[int] = set()

            for r in failed_results:
                flat_idx = int(r["index"])
                _ci, _ni, _node = all_nodes_flat[flat_idx]
                err_msg = str(r.get("message") or "")

                if _ob_is_auth_failure(err_msg):
                    _identityfile = str(_node.get("identityfile") or "")
                    outcome = _ob_handle_auth_failure_recovery(
                        _node, r, identityfile=_identityfile
                    )
                    if outcome == "skipped":
                        to_skip.add(flat_idx)
                else:
                    _alias = str(r.get("alias") or "node")
                    _address = str(_node.get("address") or "")
                    _user = str(_node.get("user") or "")
                    _port = int(_node.get("port") or 22)
                    print(
                        f"\n  {_OB_BOLD}─── {_alias}{_OB_RESET}"
                        f"  {_OB_DIM}{_user}@{_address}:{_port} — network error: {err_msg}{_OB_RESET}"
                    )
                    _net_choice = "23"[_ob_arrow_select(["skip", "add anyway"])]
                    if _net_choice == "2":
                        print(
                            f"  {_OB_DIM}Fix network access, then re-run 'opensmi onboard'{_OB_RESET}"
                        )
                        to_skip.add(flat_idx)
                    else:
                        print(
                            f"  {_OB_YELLOW}⚠{_OB_RESET}  Node added with warning. "
                            f"Fix network access, then re-run 'opensmi onboard --force'."
                        )

            # Remove skipped nodes in reverse flat-index order to preserve indices
            for flat_idx in sorted(to_skip, reverse=True):
                _ci, _ni, _ = all_nodes_flat[flat_idx]
                ssh_clusters[_ci]["nodes"].pop(_ni)

    slurm_clusters: list[dict] = []
    raw_has_slurm = (
        input(_ob_prompt("Do you have any Slurm-managed clusters?", "", "N"))
        .strip()
        .lower()
    )
    if raw_has_slurm in ("y", "yes"):
        while True:
            slurm_clusters.append(_prompt_slurm_cluster())
            raw_more = (
                input(_ob_prompt("Add another Slurm cluster?", "", "N")).strip().lower()
            )
            if raw_more not in ("y", "yes"):
                break

    while True:
        _print_review(ssh_clusters, slurm_clusters)

        action = (
            input(_ob_prompt("Looks good? (c)onfirm / (e)dit / (q)uit", "", "c"))
            .strip()
            .lower()
            or "c"
        )
        if action.startswith("q"):
            print(f"  {_OB_YELLOW}Aborted. No config written.{_OB_RESET}")
            return 1
        if action.startswith("c"):
            break
        if not action.startswith("e"):
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Enter c, e, or q.")
            continue

        print(f"\n  {_OB_BOLD}Editable items{_OB_RESET}")
        editable: list[tuple[str, int]] = []
        for idx, cluster in enumerate(ssh_clusters, start=1):
            editable.append(("ssh", idx - 1))
            print(f"  {len(editable)}. SSH cluster: {cluster['cluster_name']}")
        for idx, sc in enumerate(slurm_clusters, start=1):
            editable.append(("slurm", idx - 1))
            print(
                f"  {len(editable)}. Slurm cluster: {sc.get('name', 'Slurm Cluster')}"
            )

        if not editable:
            print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Nothing to edit.")
            continue

        while True:
            raw_pick = input(_ob_prompt("Edit which?", "", "1")).strip() or "1"
            if not raw_pick.isdigit():
                print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Enter a valid number.")
                continue
            pick = int(raw_pick)
            if pick < 1 or pick > len(editable):
                print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Selection out of range.")
                continue
            kind, index = editable[pick - 1]
            if kind == "ssh":
                current = ssh_clusters[index]
                current_name = str(current.get("cluster_name") or "GPU-Cluster")
                new_name = (
                    input(_ob_prompt("Cluster name", "", current_name)).strip()
                    or current_name
                )
                current["cluster_name"] = new_name
                default_count = max(1, len(list(current.get("nodes") or [])))
                current["nodes"] = _prompt_nodes_for_cluster(default_count)
            else:
                slurm_clusters[index] = _prompt_slurm_cluster(slurm_clusters[index])
            break

    data = _build_payload(ssh_clusters, slurm_clusters)
    atomic_write_text(cfg_path, _json.dumps(data, indent=2, sort_keys=False) + "\n")

    print(f"\n  {_OB_GREEN}╭{line}╮{_OB_RESET}")
    print(_ob_box_row("✓  Config saved", W, _OB_BOLD))
    print(_ob_box_row(f"   {cfg_path}", W, _OB_DIM))
    print(_ob_box_row("", W))
    print(_ob_box_row("Next steps:", W, _OB_DIM))
    print(_ob_box_row("  opensmi poll          # verify SSH + GPUs", W))
    print(_ob_box_row("  opensmi                # launch TUI", W))
    print(_ob_box_row("  opensmi alloc seed    # seed from live usage", W))
    print(f"  {_OB_GREEN}╰{line}╯{_OB_RESET}\n")
    return 0


def _init_from_ssh_config(cfg_path: Path, ssh_config_path: str) -> int:
    """Parse ~/.ssh/config for GPU node entries."""
    import json as _json

    try:
        ssh_path, hosts = _discover_ssh_config_hosts(ssh_config_path)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 2

    if not hosts:
        print(f"No hosts found in {ssh_path}", file=sys.stderr)
        return 2

    print(f"Found {len(hosts)} host(s) in {ssh_path}:")
    for h in hosts:
        alias = str(h["alias"])
        addr = str(h["address"])
        user = str(h.get("user") or "root")
        port = int(h.get("port") or 22)
        print(f"  {alias} → {user}@{addr}:{port}")

    print(f"\n  {_OB_BOLD}Testing SSH connectivity (parallel)...{_OB_RESET}")
    verify_results = _verify_nodes(hosts)
    _print_verify_summary(verify_results)

    failed_results = [r for r in verify_results if not r.get("ok")]
    to_skip: set[int] = set()
    if failed_results:
        print(f"\n  {_OB_BOLD}Resolving failed nodes...{_OB_RESET}")
        for r in failed_results:
            flat_idx = int(r["index"])
            h = hosts[flat_idx]
            err_msg = str(r.get("message") or "")
            identityfile = str(h.get("identityfile") or "")
            if _ob_is_auth_failure(err_msg):
                outcome = _ob_handle_auth_failure_recovery(h, r, identityfile=identityfile)
                if outcome == "skipped":
                    to_skip.add(flat_idx)
            else:
                alias = str(h.get("alias") or "node")
                user = str(h.get("user") or "")
                address = str(h.get("address") or "")
                port = int(h.get("port") or 22)
                print(
                    f"\n  {_OB_BOLD}─── {alias}{_OB_RESET}"
                    f"  {_OB_DIM}{user}@{address}:{port} — network error: {err_msg}{_OB_RESET}"
                )
                nc = "23"[_ob_arrow_select(["skip", "add anyway"])]
                if nc == "2":
                    to_skip.add(flat_idx)
                else:
                    print(f"  {_OB_YELLOW}⚠{_OB_RESET}  Node added with warning.")

    nodes = [
        _host_to_config_node(h)
        for idx, h in enumerate(hosts)
        if idx not in to_skip
    ]
    if not nodes:
        print("No nodes added. Aborting.", file=sys.stderr)
        return 1

    admin: Optional[str] = None

    data = {
        "clusters": [
            {
                "cluster_name": "GPU-Cluster",
                "nodes": nodes,
            }
        ],
        "admins": {
            "master": admin,
            "members": [],
            "remote_sudo_groups": ["sudo", "wheel"],
        },
        "users": [],
        "policy": {
            "require_allocation": True,
            "all_users_token": "*",
            "enforcement": "detect_only",
        },
        "slurm_clusters": [],
    }

    atomic_write_text(cfg_path, _json.dumps(data, indent=2, sort_keys=False) + "\n")
    print(f"\n✅ Config written: {cfg_path}")
    print(f"Next: Run  opensmi poll  or just  opensmi  to launch the TUI.")
    return 0


def _users_on_gpu(node_snap, gpu_uuid: str):
    users = []
    seen = set()
    for p in node_snap.processes:
        if p.gpu_uuid != gpu_uuid:
            continue
        if p.user in seen:
            continue
        seen.add(p.user)
        users.append(p.user)
    return users


def _render_dashboard(cluster_snap) -> str:
    # Dynamic layout: pick the union of GPU indices across the cluster so
    # nodes with different GPU counts still render in one table.
    gpu_indices = sorted(
        {g.index for n in cluster_snap.nodes if not n.error for g in n.gpus}
    )

    header = ["Node"] + [f"GPU{i}" for i in gpu_indices] + ["Free"]
    rows = []

    for n in cluster_snap.nodes:
        if n.error:
            rows.append([n.node_alias] + ["ERR"] * len(gpu_indices) + ["-"])
            continue

        # Map index -> uuid
        idx_to_uuid = {g.index: g.uuid for g in n.gpus}

        gpu_cells = []
        free = 0
        total = 0

        for i in gpu_indices:
            uuid = idx_to_uuid.get(i)
            if not uuid:
                gpu_cells.append("-")
                continue

            total += 1
            users = _users_on_gpu(n, uuid)
            if not users:
                gpu_cells.append("-")
                free += 1
            else:
                cell = "+".join(users)
                if len(cell) > 14:
                    cell = cell[:13] + "…"
                gpu_cells.append(cell)

        # Fallback if gpu_indices is empty (or all GPUs are non-standard indices)
        if total == 0:
            total = len(n.gpus)

        rows.append([n.node_alias] + gpu_cells + [f"{free}/{total}"])

    # column widths
    widths = [len(h) for h in header]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(str(c)))

    def fmt_row(r):
        parts = []
        for i, c in enumerate(r):
            s = str(c)
            parts.append(s.ljust(widths[i]))
        return "  ".join(parts)

    out = [fmt_row(header), fmt_row(["-" * w for w in widths])]
    out += [fmt_row(r) for r in rows]
    return "\n".join(out)


def _cmd_poll(args: argparse.Namespace) -> int:
    from .logging import get_logger

    log = get_logger("cli.poll")
    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    log.info("poll start — config=%s", cfg_path)

    if not cfg_path.exists():
        print(
            f"Config not found: {cfg_path}\n"
            f"Run: opensmi init (writes ~/.opensmi/opensmi.json by default)\n"
            f"Tip: override with --config or OPENSMI_CONFIG",
            file=sys.stderr,
        )
        return 2

    clusters = load_all_clusters(cfg_path)
    cluster_idx = int(getattr(args, "cluster_idx", 0) or 0)
    if cluster_idx < 0 or cluster_idx >= len(clusters):
        print(
            f"Invalid --cluster-idx {cluster_idx}; expected 0..{len(clusters) - 1}",
            file=sys.stderr,
        )
        return 2

    cfg = clusters[cluster_idx]

    cluster_snap = asyncio.run(poll_cluster(cfg, timeout_s=int(args.timeout)))

    if args.json:
        print(json.dumps(snapshot_to_jsonable(cluster_snap), indent=2, sort_keys=False))
    else:
        print(_render_dashboard(cluster_snap))

    if args.write_latest:
        ensure_state_dir(state_dir)
        out_path = latest_snapshot_path(state_dir)
        atomic_write_text(
            out_path,
            json.dumps(snapshot_to_jsonable(cluster_snap), indent=2, sort_keys=False)
            + "\n",
        )

    return 0


def _cmd_clusters_list(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)

    if not cfg_path.exists():
        print(
            f"Config not found: {cfg_path}\n"
            f"Run: opensmi init\n"
            f"Tip: override with --config or OPENSMI_CONFIG",
            file=sys.stderr,
        )
        return 2

    clusters = load_all_clusters(cfg_path)
    payload = [
        {"cluster_name": c.cluster_name, "node_count": len(c.nodes)} for c in clusters
    ]

    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=False))
    else:
        for c in payload:
            print(f"{c['cluster_name']}\t{c['node_count']}")
    return 0


def _load_cfg(args: argparse.Namespace):
    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(
        state_dir=state_dir, cli_config=getattr(args, "config", None)
    )

    if not cfg_path.exists():
        print(
            f"Config not found: {cfg_path}\n"
            f"Run: opensmi init\n"
            f"Tip: override with --config or OPENSMI_CONFIG",
            file=sys.stderr,
        )
        raise SystemExit(2)

    return state_dir, load_config(cfg_path)


# ── alloc ──────────────────────────────────────────────────────────


def _cmd_alloc_list(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    allocs = load_allocations(state_dir)
    if not allocs:
        print("No allocations yet. Use: opensmi alloc set <NODE> <GPU#> <USER>")
        return 0

    header = ["Node", "GPU", "User", "By", "At", "Notes"]
    rows = []
    for a in sorted(allocs, key=lambda x: (x.node_alias, x.gpu_index)):
        rows.append(
            [
                a.node_alias,
                str(a.gpu_index),
                a.target,
                a.assigned_by,
                a.assigned_at[:16],
                a.notes or "",
            ]
        )

    widths = [len(h) for h in header]
    for r in rows:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(str(c)))

    def fmt(r):
        return "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r))

    print(fmt(header))
    print(fmt(["-" * w for w in widths]))
    for r in rows:
        print(fmt(r))
    return 0


def _cmd_alloc_set(args: argparse.Namespace) -> int:
    from .state import now_kst_iso

    state_dir, cfg = _load_cfg(args)
    _require_admin(cfg, "alloc set", node_aliases=[args.node])

    ensure_state_dir(state_dir)

    target = str(args.user or "").strip()
    if not target or target.lower() == "none":
        target = "*"

    allocs = load_allocations(state_dir)
    new_alloc = Allocation(
        node_alias=args.node,
        gpu_index=int(args.gpu),
        target=target,
        assigned_by=args.by or _current_operator() or "admin",
        assigned_at=now_kst_iso(),
        notes=args.notes or "",
    )
    allocs = upsert_allocation(allocs, new_alloc)
    save_allocations(state_dir, allocs)
    print(f"OK: {args.node} GPU{args.gpu} → {target}")
    return 0


def _cmd_alloc_clear(args: argparse.Namespace) -> int:
    state_dir, cfg = _load_cfg(args)
    _require_admin(cfg, "alloc clear", node_aliases=[args.node])

    allocs = load_allocations(state_dir)
    before = len(allocs)
    allocs = remove_allocation(allocs, node_alias=args.node, gpu_index=int(args.gpu))
    save_allocations(state_dir, allocs)
    if len(allocs) < before:
        print(f"Cleared: {args.node} GPU{args.gpu}")
    else:
        print(f"Nothing to clear for {args.node} GPU{args.gpu}")
    return 0


# ── violations ─────────────────────────────────────────────────────


def _cmd_violations(args: argparse.Namespace) -> int:
    state_dir, cfg = _load_cfg(args)
    allocs = load_allocations(state_dir)
    cluster_snap = asyncio.run(poll_cluster(cfg, timeout_s=int(args.timeout)))

    viols = find_violations(cfg, cluster_snap, allocs)

    if not viols:
        print("✅ No violations.")
        return 0

    print(f"⚠️  {len(viols)} violation(s):\n")
    for v in viols:
        exp = f" (expected: {v.expected})" if v.expected else ""
        pids = ",".join(str(p) for p in v.pids)
        print(
            f"  {v.node_alias} GPU{v.gpu_index}: {v.user} [{v.reason}]{exp}  PIDs={pids}"
        )

    return 1


# ── kill ───────────────────────────────────────────────────────────


def _cmd_kill(args: argparse.Namespace) -> int:
    _state_dir, cfg = _load_cfg(args)
    _require_admin(cfg, "kill", node_aliases=[args.node])

    try:
        node = _find_node(cfg, args.node)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2

    try:
        pids = [int(p) for p in args.pids]
    except ValueError:
        print("All PIDs must be integers", file=sys.stderr)
        return 2

    sig = str(args.signal).upper().strip()
    allowed = {"TERM", "KILL", "INT", "HUP"}
    if sig not in allowed:
        print(
            f"Unsupported signal: {sig} (allowed: {', '.join(sorted(allowed))})",
            file=sys.stderr,
        )
        return 2

    use_sudo = not bool(args.no_sudo)

    pids_str = " ".join(str(p) for p in pids)
    sudo_flag = "1" if use_sudo else "0"

    script = f"""#!/usr/bin/env bash
set -u

signal=\"{sig}\"
use_sudo=\"{sudo_flag}\"

pids=({pids_str})

echo \"__OPENSMI_KILL_BEGIN__\"

for pid in \"${{pids[@]}}\"; do
  owner=$(stat -c \"%U\" \"/proc/$pid\" 2>/dev/null || echo unknown)

  if [ ! -d \"/proc/$pid\" ]; then
    echo \"NOT_FOUND $pid $owner\"
    continue
  fi

  if [ \"$use_sudo\" = \"1\" ]; then
    sudo_out=$(sudo -n kill -s \"$signal\" \"$pid\" 2>&1)
    sudo_rc=$?

    if [ $sudo_rc -eq 0 ]; then
      echo \"OK_SUDO $pid $owner\"
      continue
    fi

    # fallback: may still succeed if the SSH user owns the process
    if kill -s \"$signal\" \"$pid\" 2>/dev/null; then
      echo \"OK $pid $owner\"
      continue
    fi

    if echo \"$sudo_out\" | grep -qi \"password is required\"; then
      echo \"FAIL_SUDO_PASSWORD $pid $owner\"
    else
      echo \"FAIL $pid $owner\"
    fi
  else
    if kill -s \"$signal\" \"$pid\" 2>/dev/null; then
      echo \"OK $pid $owner\"
    else
      echo \"FAIL $pid $owner\"
    fi
  fi

done

echo \"__OPENSMI_KILL_END__\"
"""

    try:
        rc, stdout, stderr = asyncio.run(
            ssh_bash_script(node, script, timeout_s=int(args.timeout))
        )
    except SSHRunError as e:
        print(f"SSH_ERROR: {e}", file=sys.stderr)
        return 2

    if stdout.strip():
        print(stdout.strip())
    if stderr.strip():
        print(stderr.strip(), file=sys.stderr)

    # Decide success based on parsed output (even if ssh rc=0)
    ok = True
    for line in stdout.splitlines():
        if line.startswith("FAIL") or line.startswith("NOT_FOUND"):
            ok = False
            break

    if rc != 0:
        ok = False

    return 0 if ok else 1


# ── alloc seed ─────────────────────────────────────────────────────


def _cmd_alloc_seed(args: argparse.Namespace) -> int:
    """Seed allocations from current live GPU usage."""
    from .state import now_kst_iso

    state_dir, cfg = _load_cfg(args)
    _require_admin(cfg, "alloc seed", node_aliases=[n.alias for n in cfg.nodes])
    ensure_state_dir(state_dir)

    cluster_snap = asyncio.run(poll_cluster(cfg, timeout_s=int(args.timeout)))
    allocs = load_allocations(state_dir)
    by = args.by or "admin"

    count = 0
    for node in cluster_snap.nodes:
        if node.error:
            print(f"  {node.node_alias}: SKIP (error: {node.error})", file=sys.stderr)
            continue

        for g in node.gpus:
            gpu_index = int(g.index)
            uuid = g.uuid

            users = list({p.user for p in node.processes if p.gpu_uuid == uuid})

            # Already allocated?
            existing = None
            for a in allocs:
                if a.node_alias == node.node_alias and int(a.gpu_index) == gpu_index:
                    existing = a
                    break

            if existing and not args.force:
                continue

            target: str
            if len(users) == 1:
                target = users[0]
            elif len(users) > 1:
                if args.multi == "star":
                    target = "*"
                else:
                    target = users[0]
                    print(
                        f"  {node.node_alias} GPU{gpu_index}: multi-user ({','.join(users)}), assigned → {target}",
                        file=sys.stderr,
                    )
            else:
                if args.idle == "star":
                    target = "*"
                elif args.idle == "skip":
                    continue
                else:
                    target = "*"

            new_alloc = Allocation(
                node_alias=node.node_alias,
                gpu_index=gpu_index,
                target=target,
                assigned_by=by,
                assigned_at=now_kst_iso(),
                notes="seeded",
            )
            allocs = upsert_allocation(allocs, new_alloc)
            count += 1
            print(f"  {node.node_alias} GPU{gpu_index} → {target}")

    save_allocations(state_dir, allocs)
    print(f"\n✅ {count} allocation(s) seeded.")
    return 0


# ── watch ──────────────────────────────────────────────────────────


def _cmd_watch(args: argparse.Namespace) -> int:
    """Poll periodically, report violations to stdout and optionally Slack."""
    import time
    import urllib.request
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td

    _KST = _tz(_td(hours=9))

    def _kst_time() -> str:
        return _dt.now(_KST).strftime("%H:%M:%S")

    state_dir, cfg = _load_cfg(args)
    interval = int(args.interval)
    webhook = args.slack_webhook or ""

    notified: set = set()

    def send_slack(text: str) -> None:
        if not webhook:
            return
        data = json.dumps({"text": text}).encode("utf-8")
        req = urllib.request.Request(
            webhook,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10):
                pass
        except Exception as e:
            print(f"Slack error: {e}", file=sys.stderr)

    print(f"Watching every {interval}s (Ctrl+C to stop)…")
    if webhook:
        print(f"Slack webhook: {webhook[:40]}…")

    while True:
        try:
            allocs = load_allocations(state_dir)
            cluster_snap = asyncio.run(poll_cluster(cfg, timeout_s=int(args.timeout)))
            viols = find_violations(cfg, cluster_snap, allocs)

            new_viols = []
            current_keys: set = set()
            for v in viols:
                vkey = f"{v.node_alias}:{v.gpu_index}:{v.user}"
                current_keys.add(vkey)
                if vkey not in notified:
                    new_viols.append(v)
                    notified.add(vkey)

            # Remove resolved
            notified = notified & current_keys

            if new_viols:
                ts = _kst_time()
                lines = [f"[{ts}] ⚠️ {len(new_viols)} new violation(s):"]
                for v in new_viols:
                    exp = f" (expected: {v.expected})" if v.expected else ""
                    pids = ",".join(str(p) for p in v.pids)
                    lines.append(
                        f"  {v.node_alias} GPU{v.gpu_index}: {v.user} [{v.reason}]{exp} PIDs={pids}"
                    )

                msg = "\n".join(lines)
                print(msg)
                send_slack(msg)
            else:
                ts = _kst_time()
                total = len(viols)
                if total:
                    print(f"[{ts}] {total} ongoing violation(s), no new.")
                else:
                    print(f"[{ts}] ✅ No violations.")

            time.sleep(interval)

        except KeyboardInterrupt:
            print("\nStopped.")
            return 0


def _cmd_users(args: argparse.Namespace) -> int:
    state_dir, cfg = _load_cfg(args)

    users = asyncio.run(fetch_users(cfg, timeout_s=int(args.timeout)))

    if args.json:
        print(json.dumps({"users": users}, indent=2, sort_keys=False))
    else:
        for u in users:
            print(u)

    return 0


def _cmd_sudo_check(args: argparse.Namespace) -> int:
    _state_dir, cfg = _load_cfg(args)

    try:
        ok, groups = _check_remote_sudo_group(
            cfg, args.node, timeout_s=int(args.timeout)
        )
    except Exception as e:
        if args.json:
            print(
                json.dumps({"node": args.node, "ok": False, "error": str(e)}, indent=2)
            )
        else:
            print(f"ERROR: {e}", file=sys.stderr)
        return 2

    if args.json:
        print(
            json.dumps(
                {
                    "node": args.node,
                    "ok": bool(ok),
                    "groups": groups,
                    "required_groups": sorted(_remote_sudo_groups(cfg)),
                },
                indent=2,
            )
        )
    else:
        status = "OK" if ok else "NO"
        print(f"{args.node}: {status} (groups: {' '.join(groups)})")

    return 0


def _cmd_job_list(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    jobs = load_jobs(state_dir)

    jobs = cleanup_old_jobs(jobs)
    save_jobs(state_dir, jobs)

    if args.status:
        jobs = [j for j in jobs if j.status == args.status]

    if args.json:
        print(
            json.dumps(
                {
                    "jobs": [
                        {
                            "id": j.id,
                            "command": j.command,
                            "commands": j.commands,
                            "gpus": j.gpus,
                            "requested_gpu_count": j.requested_gpu_count,
                            "status": j.status,
                            "submitted_at": j.submitted_at,
                            "started_at": j.started_at,
                            "finished_at": j.finished_at,
                            "exit_codes": j.exit_codes,
                            "user": j.user,
                            "exec_mode": j.exec_mode,
                            "dist_mode": j.dist_mode,
                            "tmux_sessions": j.tmux_sessions,
                            "restart_policy": j.restart_policy,
                            "retry_count": j.retry_count,
                            "max_retries": j.max_retries,
                            "tags": j.tags,
                            "queue_mode": j.queue_mode,
                            "error": j.error,
                        }
                        for j in jobs
                    ]
                },
                indent=2,
            )
        )
    else:
        if not jobs:
            print("No jobs found.")
            return 0

        for j in jobs:
            gpu_str = (
                ", ".join(f"{alias}:{idx}" for alias, idx in j.gpus)
                if j.gpus
                else f"(auto×{j.requested_gpu_count})"
            )
            cmd_str = (
                j.command[:40]
                if j.command
                else (j.commands[0][:40] if j.commands else "")
            )
            status_icon = {
                "queued": "○",
                "running": "●",
                "done": "✓",
                "failed": "✗",
                "cancelled": "⊘",
            }.get(j.status, "?")
            print(f"{j.id}  {status_icon} {j.status:9s}  {gpu_str:20s}  {cmd_str}")

    return 0


def _cmd_job_submit(args: argparse.Namespace) -> int:
    from .logging import get_logger

    log = get_logger("cli.job")
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)
    log.info(
        "job submit — command=%s node=%s gpus=%s queue=%s",
        args.command,
        getattr(args, "node", None),
        getattr(args, "gpus", None),
        getattr(args, "queue", False),
    )
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    jobs = load_jobs(state_dir)

    gpus = []
    requested_gpu_count = 0

    if args.auto_gpus:
        requested_gpu_count = int(args.auto_gpus)
        queue_mode = "queued"
    elif args.node and args.gpus:
        node_alias = args.node
        gpu_indices = _parse_gpu_csv(args.gpus)
        gpus = [(node_alias, idx) for idx in gpu_indices]
        queue_mode = "queued" if args.queue else "immediate"
    else:
        print(
            "ERROR: Either provide --node and --gpus, or --auto-gpus", file=sys.stderr
        )
        return 2

    job = Job(
        id=Job.new_id(),
        command=str(args.command),
        gpus=gpus,
        requested_gpu_count=requested_gpu_count,
        dist_mode="single",
        exec_mode="tmux" if args.tmux else "direct",
        status="queued",
        submitted_at=datetime.now(timezone.utc).isoformat(),
        user=_current_operator(),
        restart_policy=str(args.restart),
        queue_mode=queue_mode,
    )

    if not args.queue and args.node and args.gpus:
        node = _find_node(cfg, args.node)
        gpu_indices = _parse_gpu_csv(args.gpus)

        target = NodeTarget(
            node_alias=args.node, gpu_indices=gpu_indices, node_config=node
        )
        safe_node = args.node.replace("#", "-").replace(":", "-").replace(".", "-")
        session = f"opensmi-{job.id}-{safe_node}" if args.tmux else None
        env_cfg = inject_cuda_visible_devices(target)

        ctx = RemoteExecutionContext(
            target=target,
            command=str(args.command),
            env_vars=env_cfg.to_env_dict(),
            execution_mode="tmux" if args.tmux else "direct",
            tmux_session=session,
            timeout_s=300,
        )

        result = asyncio.run(route_command_to_target(ctx))

        if result.success:
            job.status = "running"
            job.started_at = datetime.now(timezone.utc).isoformat()
            if session:
                job.tmux_sessions = [session]
        else:
            if session:
                cleanup_tmux_artifacts_for_sessions([session])
            job.status = "failed"
            job.error = result.stderr or "Execution failed"
            job.finished_at = datetime.now(timezone.utc).isoformat()

    jobs = upsert_job(jobs, job)
    save_jobs(state_dir, jobs)

    if args.json:
        print(json.dumps({"job_id": job.id, "status": job.status}, indent=2))
    else:
        print(f"Job {job.id} submitted: {job.status}")
        if job.tmux_sessions:
            print(f"Attach: tmux attach -t {job.tmux_sessions[0]}")

    return 0


def _cmd_job_status(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    jobs = load_jobs(state_dir)

    job = get_job(jobs, args.job_id)
    if not job:
        if args.json:
            print(json.dumps({"error": "Job not found"}, indent=2))
        else:
            print(f"Job {args.job_id} not found", file=sys.stderr)
        return 1

    if args.json:
        print(
            json.dumps(
                {
                    "id": job.id,
                    "command": job.command,
                    "commands": job.commands,
                    "gpus": job.gpus,
                    "tmux_sessions": job.tmux_sessions,
                    "status": job.status,
                    "submitted_at": job.submitted_at,
                    "started_at": job.started_at,
                    "finished_at": job.finished_at,
                    "user": job.user,
                    "exec_mode": job.exec_mode,
                    "dist_mode": job.dist_mode,
                    "restart_policy": job.restart_policy,
                    "retry_count": job.retry_count,
                    "max_retries": job.max_retries,
                    "queue_mode": job.queue_mode,
                    "error": job.error,
                },
                indent=2,
            )
        )
    else:
        print(f"Job {job.id}")
        print(f"  Status:    {job.status}")
        print(f"  Command:   {job.command or '(one-to-one mode)'}")
        if job.gpus:
            gpu_str = ", ".join(f"{alias}:GPU{idx}" for alias, idx in job.gpus)
            print(f"  GPUs:      {gpu_str}")
        print(f"  Mode:      {job.exec_mode} / {job.dist_mode}")
        if job.tmux_sessions:
            print(f"  Sessions:  {', '.join(job.tmux_sessions)}")
        print(f"  Submitted: {job.submitted_at}")
        if job.started_at:
            print(f"  Started:   {job.started_at}")
        if job.finished_at:
            print(f"  Finished:  {job.finished_at}")
        if job.error:
            print(f"  Error:     {job.error}")

    return 0


def _cmd_job_cancel(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    jobs = load_jobs(state_dir)
    job = get_job(jobs, args.job_id)

    if not job:
        print(f"Job {args.job_id} not found", file=sys.stderr)
        return 1

    success = asyncio.run(cancel_job(job, cfg))

    if success:
        jobs = upsert_job(jobs, job)
        save_jobs(state_dir, jobs)
        print(f"Job {job.id} cancelled")
        return 0
    else:
        print(
            f"Job {job.id} cannot be cancelled (status: {job.status})", file=sys.stderr
        )
        return 1


def _cmd_job_retry(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)

    jobs = load_jobs(state_dir)
    job = get_job(jobs, args.job_id)

    if not job:
        print(f"Job {args.job_id} not found", file=sys.stderr)
        return 1

    new_job = retry_job(job)
    jobs = upsert_job(jobs, new_job)
    save_jobs(state_dir, jobs)

    print(f"Job {job.id} retried as {new_job.id}")
    return 0


def _cmd_job_delete(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)

    jobs = load_jobs(state_dir)
    job = get_job(jobs, args.job_id)

    if not job:
        print(f"Job {args.job_id} not found", file=sys.stderr)
        return 1

    cleanup_tmux_artifacts_for_sessions(job.tmux_sessions)

    jobs = [j for j in jobs if j.id != args.job_id]
    save_jobs(state_dir, jobs)

    print(f"Job {job.id} deleted")
    return 0


def _cmd_job_log(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    jobs = load_jobs(state_dir)
    job = get_job(jobs, args.job_id)

    if not job:
        print(f"Job {args.job_id} not found", file=sys.stderr)
        return 1

    if not job.tmux_sessions:
        print(f"Job {job.id} has no tmux sessions", file=sys.stderr)
        return 1

    session = job.tmux_sessions[0]

    # Tmux sessions are local (on the opensmi machine), so capture directly.
    try:
        import shutil
        import subprocess as _sp

        tmux_bin = shutil.which("tmux") or "/opt/homebrew/bin/tmux"
        result = _sp.run(
            [tmux_bin, "capture-pane", "-t", session, "-p", "-S", f"-{args.lines}"],
            capture_output=True,
            text=True,
            timeout=10,
        )

        if result.returncode == 0:
            print(result.stdout)
            return 0
        else:
            print(f"Failed to capture tmux pane: {result.stderr}", file=sys.stderr)
            return 2
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2


def _cmd_update(args: argparse.Namespace) -> int:
    repo = args.repo or os.environ.get("OPENSMI_REPO") or "seilk/opensmi"

    try:
        tag, bin_dir = update_release(
            repo=repo,
            version=str(args.version),
            bin_dir=Path(args.bin_dir).expanduser().resolve() if args.bin_dir else None,
            install_tui_flag=not bool(args.cli_only),
            install_cli_flag=not bool(args.tui_only),
            cli_method=str(args.cli_method),
            verify=not bool(args.no_verify),
        )
    except UpdateError as e:
        print(f"Update failed: {e}", file=sys.stderr)
        return 2

    print(f"✅ Updated to {tag}")
    print(f"Bin dir: {bin_dir}")
    if not args.tui_only:
        print("Next: opensmi --help")
    if not args.cli_only:
        print("Next: opensmi")
    return 0


def _cmd_node_env(args: argparse.Namespace) -> int:
    """Get or set per-node environment configuration."""
    from .config import update_node_env

    state_dir = get_state_dir(args.state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    node = None
    for n in cfg.nodes:
        if n.alias == args.node:
            node = n
            break
    if not node:
        print(f"Node '{args.node}' not found", file=sys.stderr)
        return 1

    # If any setter flags provided, update
    if (
        args.env_manager is not None
        or args.env_name is not None
        or args.work_dir is not None
    ):
        ok = update_node_env(
            cfg_path,
            alias=args.node,
            env_manager=args.env_manager
            if args.env_manager is not None
            else node.env_manager,
            env_name=args.env_name if args.env_name is not None else node.env_name,
            work_dir=args.work_dir if args.work_dir is not None else node.work_dir,
        )
        if not ok:
            print(f"Failed to update node '{args.node}'", file=sys.stderr)
            return 1
        # Reload to show updated values
        cfg = load_config(cfg_path)
        for n in cfg.nodes:
            if n.alias == args.node:
                node = n
                break

    # Output
    info = {
        "alias": node.alias,
        "env_manager": node.env_manager,
        "env_name": node.env_name,
        "work_dir": node.work_dir,
    }
    if args.json:
        print(json.dumps(info))
    else:
        print(f"Node:        {node.alias}")
        print(f"Env Manager: {node.env_manager or '(none)'}")
        print(f"Env Name:    {node.env_name or '(none)'}")
        print(f"Work Dir:    {node.work_dir or '(none)'}")
    return 0


def _cmd_slurm(args: argparse.Namespace) -> int:
    """Show GPU usage across Slurm-managed nodes."""
    import shutil
    from .slurm import collect_slurm_snapshot, format_table, snapshot_to_json

    login_node = getattr(args, "login_node", None)

    # If --names-only, just print cluster names from config (no SSH)
    if getattr(args, "names_only", False):
        import json as _json

        state_dir = get_state_dir(args.state_dir)
        cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
        data = _json.loads(cfg_path.read_text(encoding="utf-8"))
        names = [
            sc.get("name", "Slurm Cluster") for sc in data.get("slurm_clusters", [])
        ]
        print(_json.dumps(names))
        return 0

    # If --all, load from config
    if getattr(args, "show_all", False):
        import json as _json

        state_dir = get_state_dir(args.state_dir)
        cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
        # Read slurm_clusters from root JSON (works for both legacy and clusters[] format)
        raw_data = _json.loads(cfg_path.read_text(encoding="utf-8"))
        raw_slurm = raw_data.get("slurm_clusters", [])
        if not raw_slurm:
            print("No slurm_clusters configured in opensmi.json", file=sys.stderr)
            return 1
        from .models import SlurmClusterConfig

        slurm_clusters = [
            SlurmClusterConfig(
                name=str(sc.get("name", "Slurm Cluster")),
                login_node=str(sc["login_node"]),
                user=str(sc.get("user", "")),
                port=int(sc.get("port", 22)),
            )
            for sc in raw_slurm
        ]
        results = []
        for sc in slurm_clusters:
            snap = collect_slurm_snapshot(
                partition_filter=args.partition,
                node_filter=args.node,
                timeout=15,
                login_node=sc.login_node,
                ssh_user=sc.user,
                ssh_port=sc.port,
                cluster_name=sc.name,
            )
            results.append(snap)
        if args.output_json:
            import json as _json

            print(
                _json.dumps(
                    [json.loads(snapshot_to_json(s)) for s in results], indent=2
                )
            )
        else:
            for snap in results:
                print(format_table(snap, compact=args.compact))
                print()
        return 0 if all(not s.errors for s in results) else 1

    if not login_node and not shutil.which("sinfo"):
        print(
            "Slurm CLI tools not found (sinfo/squeue/scontrol).\n"
            "Run on a Slurm login node or use --login-node <host>.",
            file=sys.stderr,
        )
        return 1

    snap = collect_slurm_snapshot(
        partition_filter=args.partition,
        node_filter=args.node,
        timeout=15,
        login_node=login_node,
        ssh_user=getattr(args, "ssh_user", ""),
        cluster_name="Slurm Cluster",
    )

    if args.output_json:
        print(snapshot_to_json(snap))
    else:
        print(format_table(snap, compact=args.compact))

    return 0 if not snap.errors else 1


def _cmd_uninstall(args: argparse.Namespace) -> int:
    try:
        out = run_uninstall(
            bin_dir=Path(args.bin_dir).expanduser().resolve() if args.bin_dir else None,
            uninstall_tui=not bool(args.cli_only),
            uninstall_cli=not bool(args.tui_only),
            purge_state=bool(args.purge_state),
            state_dir=args.state_dir,
            yes=bool(args.yes),
            force=bool(args.force),
            dry_run=bool(args.dry_run),
        )
        print(out)
        return 0
    except UninstallError as e:
        print(f"Uninstall failed: {e}", file=sys.stderr)
        return 2


def _parse_gpu_csv(raw: str) -> list[int]:
    raw = (raw or "").strip()
    if not raw:
        return []
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        out.append(int(part))
    return out


def _preflight_results_to_jsonable(results: list) -> list[dict]:
    out: list[dict] = []
    for r in results:
        out.append(
            {
                "check_type": getattr(
                    r.check.check_type, "value", str(r.check.check_type)
                ),
                "node_alias": r.check.node_alias,
                "passed": bool(r.passed),
                "error_message": r.error_message,
                "metadata": r.metadata or {},
                "timestamp": r.timestamp,
            }
        )
    return out


def _exec_result_to_jsonable(result) -> dict:
    return {
        "exit_code": int(result.exit_code),
        "stdout": result.stdout,
        "stderr": result.stderr,
        "node_alias": result.node_alias,
        "command": result.command,
        "success": bool(result.success),
    }


def _cmd_preflight(args: argparse.Namespace) -> int:
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    node = _find_node(cfg, args.node)
    gpus = _parse_gpu_csv(args.gpus) if args.gpus is not None else None

    checks: list[PreflightCheck] = []
    if args.mode == "tmux":
        checks.append(
            PreflightCheck(
                check_type=PreflightCheckType.TMUX_AVAILABLE,
                node_alias=args.node,
                node_config=node,
            )
        )

    if args.command:
        checks.append(
            PreflightCheck(
                check_type=PreflightCheckType.COMMAND_SYNTAX,
                node_alias=args.node,
                command_to_validate=str(args.command),
                node_config=node,
            )
        )

    if gpus is not None:
        checks.append(
            PreflightCheck(
                check_type=PreflightCheckType.GPU_AVAILABILITY,
                node_alias=args.node,
                target_gpu_indices=gpus,
                node_config=node,
            )
        )

    if not checks:
        if args.json:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "No preflight checks requested. Provide --mode tmux and/or --command and/or --gpus.",
                    }
                )
            )
        else:
            print(
                "No preflight checks requested. Provide --mode tmux and/or --command and/or --gpus.",
                file=sys.stderr,
            )
        return 2

    results = asyncio.run(run_preflight_checks(checks))

    if args.json:
        print(
            json.dumps(
                {
                    "ok": all(r.passed for r in results),
                    "results": _preflight_results_to_jsonable(results),
                }
            )
        )
    else:
        for r in results:
            status = "PASS" if r.passed else "FAIL"
            msg = r.error_message or ""
            print(
                f"{r.check.node_alias} {r.check.check_type.value}: {status} {msg}".rstrip()
            )

    return 0 if all(r.passed for r in results) else 3


def _cmd_log(args: argparse.Namespace) -> int:
    from .logging import log_dir

    ld = log_dir()

    if args.path:
        print(str(ld))
        return 0

    targets = []
    if args.target in ("cli", "all"):
        targets.append(ld / "cli.log")
    if args.target in ("tui", "all"):
        targets.append(ld / "tui.log")

    if args.follow:
        # Use tail -f
        import subprocess

        files = [str(f) for f in targets if f.exists()]
        if not files:
            print(f"No log files found in {ld}", file=sys.stderr)
            return 1
        try:
            subprocess.run(["tail", "-f"] + files)
        except KeyboardInterrupt:
            pass
        return 0

    # Print last N lines
    for log_file in targets:
        if not log_file.exists():
            print(f"# {log_file.name}: (no log yet)")
            continue

        lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
        tail = lines[-args.tail :] if len(lines) > args.tail else lines

        if len(targets) > 1:
            print(f"# ── {log_file.name} ({len(lines)} total lines) ──")
        for line in tail:
            print(line)
        if len(targets) > 1:
            print()

    return 0


def _cmd_exec(args: argparse.Namespace) -> int:
    from .logging import get_logger

    log = get_logger("cli.exec")
    log.info(
        "exec — node=%s command=%s mode=%s",
        getattr(args, "node", None),
        getattr(args, "command", None),
        getattr(args, "mode", None),
    )
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)
    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)
    cfg = load_config(cfg_path)

    node = _find_node(cfg, args.node)
    gpus = _parse_gpu_csv(args.gpus)

    preflight_results = []
    if not bool(args.skip_preflight):
        checks: list[PreflightCheck] = []
        if args.mode == "tmux":
            checks.append(
                PreflightCheck(
                    check_type=PreflightCheckType.TMUX_AVAILABLE,
                    node_alias=args.node,
                    node_config=node,
                )
            )

        checks.append(
            PreflightCheck(
                check_type=PreflightCheckType.COMMAND_SYNTAX,
                node_alias=args.node,
                command_to_validate=str(args.command),
                node_config=node,
            )
        )

        checks.append(
            PreflightCheck(
                check_type=PreflightCheckType.GPU_AVAILABILITY,
                node_alias=args.node,
                target_gpu_indices=gpus,
                node_config=node,
            )
        )

        preflight_results = asyncio.run(run_preflight_checks(checks))
        if any((not r.passed) and r.is_critical_failure() for r in preflight_results):
            payload = {
                "ok": False,
                "preflight": _preflight_results_to_jsonable(preflight_results),
                "result": None,
            }
            if args.json:
                print(json.dumps(payload))
            else:
                for r in preflight_results:
                    status = "PASS" if r.passed else "FAIL"
                    msg = r.error_message or ""
                    print(
                        f"{r.check.node_alias} {r.check.check_type.value}: {status} {msg}".rstrip()
                    )
            return 3

    target = NodeTarget(node_alias=args.node, gpu_indices=gpus, node_config=node)

    session = None
    if args.mode == "tmux":
        raw_session = (
            str(args.session or "").strip() or f"opensmi-{args.node}-{int(time.time())}"
        )
        # Sanitize: # and other special chars break SSH remote commands
        session = raw_session.replace("#", "-").replace(":", "-").replace(".", "-")

    env_cfg = inject_cuda_visible_devices(target)

    ctx = RemoteExecutionContext(
        target=target,
        command=str(args.command),
        env_vars=env_cfg.to_env_dict(),
        execution_mode=str(args.mode),
        tmux_session=session,
        timeout_s=int(args.timeout),
    )

    result = asyncio.run(route_command_to_target(ctx))

    payload = {
        "ok": bool(result.success),
        "preflight": _preflight_results_to_jsonable(preflight_results)
        if preflight_results
        else [],
        "result": _exec_result_to_jsonable(result),
    }

    if args.json:
        print(json.dumps(payload))
    else:
        print(json.dumps(payload, indent=2))

    return 0 if result.success else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="opensmi", description="GPU allocation manager")
    p.add_argument("--version", action="version", version=f"opensmi {__version__}")
    p.add_argument(
        "--state-dir",
        default=None,
        help="State dir (default: ~/.opensmi or OPENSMI_STATE_DIR)",
    )
    p.add_argument(
        "--config",
        default=None,
        help="Config path (default: ~/.opensmi/opensmi.json; override with OPENSMI_CONFIG)",
    )
    p.add_argument(
        "--experimental-slurm",
        action="store_true",
        default=False,
        help="[BETA] Enable Slurm personal allocation mode (requires SLURM_JOB_ID + CUDA_VISIBLE_DEVICES).",
    )

    sub = p.add_subparsers(dest="cmd", required=False)

    sp_init = sub.add_parser("init", help="[deprecated] Use 'opensmi onboard' instead")
    sp_init.add_argument(
        "--force", action="store_true", help="Overwrite existing config"
    )
    sp_init.add_argument("--wizard", action="store_true", help="[deprecated] ignored")
    sp_init.add_argument(
        "--defaults", action="store_true", help="Non-interactive: write defaults"
    )
    sp_init.add_argument("--nodes", type=int, default=None, help="Number of nodes")
    sp_init.add_argument(
        "--from-ssh-config",
        default=None,
        metavar="PATH",
        help="Import nodes from ~/.ssh/config",
    )
    sp_init.set_defaults(func=_cmd_init)

    sp_on = sub.add_parser(
        "onboard", help="Interactive onboarding to create opensmi.json"
    )
    sp_on.add_argument("--force", action="store_true", help="Overwrite existing config")
    sp_on.add_argument(
        "--defaults",
        action="store_true",
        help="Non-interactive: write default config (CI/automation use)",
    )
    sp_on.add_argument(
        "--nodes", type=int, default=None, help="Number of nodes (interactive wizard)"
    )
    sp_on.add_argument(
        "--from-ssh-config",
        default=None,
        metavar="PATH",
        help="Import nodes from ~/.ssh/config (non-interactive)",
    )
    sp_on.set_defaults(func=_cmd_onboard)

    sp_poll = sub.add_parser("poll", help="Poll cluster via SSH + nvidia-smi")
    sp_poll.add_argument(
        "--timeout", default=15, type=int, help="Per-node timeout seconds"
    )
    sp_poll.add_argument("--json", action="store_true", help="Print full JSON snapshot")
    sp_poll.add_argument(
        "--write-latest",
        action="store_true",
        help="Write <state-dir>/latest_snapshot.json",
    )
    sp_poll.add_argument(
        "--cluster-idx",
        default=0,
        type=int,
        help="Cluster index from config (default: 0)",
    )
    sp_poll.set_defaults(func=_cmd_poll)

    sp_clusters = sub.add_parser("clusters", help="Cluster config helpers")
    clusters_sub = sp_clusters.add_subparsers(dest="clusters_cmd", required=True)
    sp_clusters_list = clusters_sub.add_parser("list", help="List configured clusters")
    sp_clusters_list.add_argument("--json", action="store_true", help="Print JSON")
    sp_clusters_list.set_defaults(func=_cmd_clusters_list)

    # ── alloc ──
    sp_alloc = sub.add_parser("alloc", help="Manage GPU allocations")
    alloc_sub = sp_alloc.add_subparsers(dest="alloc_cmd", required=True)

    sp_al = alloc_sub.add_parser("list", help="Show all allocations")
    sp_al.set_defaults(func=_cmd_alloc_list)

    sp_as = alloc_sub.add_parser("set", help="Assign a GPU to a user")
    sp_as.add_argument("node", help="Node alias (e.g. 'GPU-01')")
    sp_as.add_argument("gpu", type=int, help="GPU index (0-3)")
    sp_as.add_argument(
        "user", help="Linux username (or '*' for everyone; 'none' is normalized to '*')"
    )
    sp_as.add_argument("--by", default=None, help="Admin performing the action")
    sp_as.add_argument("--notes", default=None, help="Optional note")
    sp_as.set_defaults(func=_cmd_alloc_set)

    sp_ac = alloc_sub.add_parser("clear", help="Remove allocation for a GPU")
    sp_ac.add_argument("node", help="Node alias")
    sp_ac.add_argument("gpu", type=int, help="GPU index")
    sp_ac.set_defaults(func=_cmd_alloc_clear)

    sp_seed = alloc_sub.add_parser("seed", help="Seed allocations from live GPU usage")
    sp_seed.add_argument(
        "--timeout", default=15, type=int, help="Per-node poll timeout"
    )
    sp_seed.add_argument("--by", default=None, help="Admin name for audit")
    sp_seed.add_argument(
        "--force", action="store_true", help="Overwrite existing allocations"
    )
    sp_seed.add_argument(
        "--multi",
        default="star",
        choices=["star", "first"],
        help="Multi-user GPU: * or first user",
    )
    sp_seed.add_argument(
        "--idle",
        default="star",
        choices=["star", "skip"],
        help="Idle GPU: * (open) or skip",
    )
    sp_seed.set_defaults(func=_cmd_alloc_seed)

    # ── violations ──
    sp_v = sub.add_parser(
        "violations", help="Check for allocation violations (polls live data)"
    )
    sp_v.add_argument(
        "--timeout", default=15, type=int, help="Per-node timeout seconds"
    )
    sp_v.set_defaults(func=_cmd_violations)

    # ── kill ──
    sp_k = sub.add_parser("kill", help="Signal (kill) remote PIDs on a node")
    sp_k.add_argument("node", help="Node alias (e.g. GPU-01)")
    sp_k.add_argument("pids", nargs="+", help="One or more PIDs")
    sp_k.add_argument(
        "--signal", default="TERM", help="Signal: TERM|KILL|INT|HUP (default TERM)"
    )
    sp_k.add_argument("--timeout", default=10, type=int, help="SSH timeout seconds")
    sp_k.add_argument(
        "--no-sudo",
        action="store_true",
        help="Do not use sudo -n (only kills own processes)",
    )
    sp_k.set_defaults(func=_cmd_kill)

    # ── watch ──
    sp_w = sub.add_parser("watch", help="Watch for violations and notify (Slack)")
    sp_w.add_argument(
        "--interval", default=60, type=int, help="Poll interval seconds (default 60)"
    )
    sp_w.add_argument("--timeout", default=15, type=int, help="Per-node poll timeout")
    sp_w.add_argument(
        "--slack-webhook", default=None, help="Slack incoming webhook URL"
    )
    sp_w.set_defaults(func=_cmd_watch)

    # ── users ──
    sp_u = sub.add_parser(
        "users", help="List usernames from cluster nodes (best-effort)"
    )
    sp_u.add_argument(
        "--timeout", default=10, type=int, help="Per-node timeout seconds"
    )
    sp_u.add_argument("--json", action="store_true", help="Print JSON")
    sp_u.set_defaults(func=_cmd_users)

    sp_sc = sub.add_parser(
        "sudo-check", help="Check if the SSH user is in a sudo-capable group on a node"
    )
    sp_sc.add_argument("node", help="Node alias")
    sp_sc.add_argument("--timeout", default=8, type=int, help="SSH timeout seconds")
    sp_sc.add_argument("--json", action="store_true", help="Print JSON")
    sp_sc.set_defaults(func=_cmd_sudo_check)

    # ── remote execution ──
    sp_pf = sub.add_parser("preflight", help="Run remote execution preflight checks")
    sp_pf.add_argument("node", help="Node alias")
    sp_pf.add_argument(
        "--gpus",
        default=None,
        help="GPU indices CSV (e.g. 0,1); omit to skip GPU check",
    )
    sp_pf.add_argument("--command", default=None, help="Command to syntax-check")
    sp_pf.add_argument(
        "--mode",
        default="tmux",
        choices=["direct", "tmux"],
        help="Execution mode (affects checks)",
    )
    sp_pf.add_argument("--json", action="store_true", help="Print JSON")
    sp_pf.set_defaults(func=_cmd_preflight)

    sp_ex = sub.add_parser(
        "exec", help="Execute a command on a node with GPU assignment"
    )
    sp_ex.add_argument("node", help="Node alias")
    sp_ex.add_argument("--gpus", required=True, help="GPU indices CSV (e.g. 0,1)")
    sp_ex.add_argument("--command", required=True, help="Command to execute")
    sp_ex.add_argument(
        "--mode", default="direct", choices=["direct", "tmux"], help="Execution mode"
    )
    sp_ex.add_argument(
        "--session", default=None, help="tmux session name (tmux mode only)"
    )
    sp_ex.add_argument(
        "--timeout", default=300, type=int, help="Execution timeout seconds"
    )
    sp_ex.add_argument(
        "--skip-preflight", action="store_true", help="Skip preflight checks"
    )
    sp_ex.add_argument("--json", action="store_true", help="Print JSON")
    sp_ex.set_defaults(func=_cmd_exec)

    # ── job ──
    sp_job = sub.add_parser("job", help="Manage GPU jobs")
    job_sub = sp_job.add_subparsers(dest="job_cmd", required=True)

    sp_jl = job_sub.add_parser("list", help="List jobs")
    sp_jl.add_argument(
        "--status",
        choices=["queued", "running", "done", "failed", "cancelled"],
        help="Filter by status",
    )
    sp_jl.add_argument("--json", action="store_true", help="Print JSON")
    sp_jl.set_defaults(func=_cmd_job_list)

    sp_js = job_sub.add_parser("submit", help="Submit a job")
    sp_js.add_argument("node", nargs="?", help="Node alias (optional with --auto-gpus)")
    sp_js.add_argument("--gpus", help="Comma-separated GPU indices")
    sp_js.add_argument("--auto-gpus", type=int, help="Auto-select N GPUs")
    sp_js.add_argument("--command", required=True, help="Command to execute")
    sp_js.add_argument("--queue", action="store_true", help="Queue for auto-dispatch")
    sp_js.add_argument(
        "--tmux", action="store_true", default=True, help="Use tmux (default)"
    )
    sp_js.add_argument(
        "--restart",
        choices=["never", "on-failure", "always"],
        default="never",
        help="Restart policy",
    )
    sp_js.add_argument("--json", action="store_true", help="Print JSON")
    sp_js.set_defaults(func=_cmd_job_submit)

    sp_jst = job_sub.add_parser("status", help="Show job status")
    sp_jst.add_argument("job_id", help="Job ID")
    sp_jst.add_argument("--json", action="store_true", help="Print JSON")
    sp_jst.set_defaults(func=_cmd_job_status)

    sp_jc = job_sub.add_parser("cancel", help="Cancel a job")
    sp_jc.add_argument("job_id", help="Job ID")
    sp_jc.set_defaults(func=_cmd_job_cancel)

    sp_jr = job_sub.add_parser("retry", help="Retry a failed job")
    sp_jr.add_argument("job_id", help="Job ID")
    sp_jr.set_defaults(func=_cmd_job_retry)

    sp_jd = job_sub.add_parser("delete", help="Delete a job from history")
    sp_jd.add_argument("job_id", help="Job ID")
    sp_jd.set_defaults(func=_cmd_job_delete)

    sp_jlog = job_sub.add_parser("log", help="Fetch job output from tmux")
    sp_jlog.add_argument("job_id", help="Job ID")
    sp_jlog.add_argument(
        "--lines", type=int, default=50, help="Number of lines to fetch (default: 50)"
    )
    sp_jlog.set_defaults(func=_cmd_job_log)

    # ── opensmi log ──────────────────────────────────────────────
    sp_log = sub.add_parser("log", help="View opensmi debug logs")
    sp_log.add_argument(
        "target",
        nargs="?",
        default="all",
        choices=["cli", "tui", "all"],
        help="Which log to show (default: all)",
    )
    sp_log.add_argument(
        "--tail", "-n", type=int, default=50, help="Number of lines (default: 50)"
    )
    sp_log.add_argument(
        "--follow", "-f", action="store_true", help="Follow log output (like tail -f)"
    )
    sp_log.add_argument(
        "--path", action="store_true", help="Print log directory path and exit"
    )
    sp_log.set_defaults(func=_cmd_log)

    sp_up = sub.add_parser(
        "update", help="Update opensmi (CLI and/or TUI) from GitHub Releases"
    )
    sp_up.add_argument(
        "--repo", default=None, help="GitHub repo OWNER/REPO (default: seilk/opensmi)"
    )
    sp_up.add_argument(
        "--version", default="latest", help="Tag (e.g. v0.1.0) or 'latest' (default)"
    )
    sp_up.add_argument(
        "--bin-dir",
        default=None,
        help="Install dir for binaries (default: ~/.local/bin)",
    )
    sp_up.add_argument(
        "--tui-only", action="store_true", help="Update only opensmi-tui"
    )
    sp_up.add_argument(
        "--cli-only", action="store_true", help="Update only opensmi CLI"
    )
    sp_up.add_argument(
        "--cli-method",
        default="auto",
        choices=["auto", "pip", "pyz"],
        help="CLI method",
    )
    sp_up.add_argument(
        "--no-verify", action="store_true", help="Skip SHA256SUMS verification"
    )
    sp_up.set_defaults(func=_cmd_update)

    sp_un = sub.add_parser(
        "uninstall", help="Uninstall opensmi (CLI and/or TUI) from this machine"
    )
    sp_un.add_argument(
        "--bin-dir", default=None, help="Bin dir to clean (default: ~/.local/bin)"
    )
    sp_un.add_argument(
        "--tui-only", action="store_true", help="Remove only opensmi-tui"
    )
    sp_un.add_argument(
        "--cli-only", action="store_true", help="Remove only opensmi CLI"
    )
    sp_un.add_argument(
        "--purge-state",
        action="store_true",
        help="Also delete state dir (~/.opensmi); requires --yes",
    )
    sp_un.add_argument(
        "--yes",
        action="store_true",
        help="Confirm destructive actions (required for --purge-state)",
    )
    sp_un.add_argument(
        "--force",
        action="store_true",
        help="Force removing opensmi from bin dir even if it doesn't look like our wrapper",
    )
    sp_un.add_argument(
        "--dry-run", action="store_true", help="Print what would be removed"
    )
    sp_un.set_defaults(func=_cmd_uninstall)

    # ── node-env: get/set per-node environment config ─────────────
    sp_ne = sub.add_parser(
        "node-env",
        help="Get or set per-node env config (env_manager, env_name, work_dir)",
    )
    sp_ne.add_argument("node", help="Node alias")
    sp_ne.add_argument(
        "--env-manager",
        default=None,
        help="conda | miniconda | micromamba | venv | (empty to clear)",
    )
    sp_ne.add_argument("--env-name", default=None, help="Virtual env name")
    sp_ne.add_argument("--work-dir", default=None, help="Remote working directory")
    sp_ne.add_argument("--json", dest="json", action="store_true", default=False)
    sp_ne.set_defaults(func=_cmd_node_env)

    # ── slurm: Slurm cluster GPU overview (no SSH) ────────────────
    sp_slurm = sub.add_parser(
        "slurm",
        help="Show GPU usage across Slurm-managed nodes (no SSH required)",
    )
    sp_slurm.add_argument(
        "--partition",
        "-p",
        default=None,
        help="Filter by partition name (substring match)",
    )
    sp_slurm.add_argument(
        "--node", "-n", default=None, help="Filter by node name (substring match)"
    )
    sp_slurm.add_argument(
        "--compact",
        "-c",
        action="store_true",
        default=False,
        help="Compact output: skip individual idle GPU lines for fully idle nodes",
    )
    sp_slurm.add_argument(
        "--json",
        dest="output_json",
        action="store_true",
        default=False,
        help="Output as JSON",
    )
    sp_slurm.add_argument(
        "--login-node",
        default=None,
        help="SSH alias/address of Slurm login node (runs commands remotely)",
    )
    sp_slurm.add_argument(
        "--ssh-user",
        default="",
        help="SSH user for login node",
    )
    sp_slurm.add_argument(
        "--all",
        dest="show_all",
        action="store_true",
        default=False,
        help="Show all configured Slurm clusters from opensmi.json",
    )
    sp_slurm.add_argument(
        "--names-only",
        dest="names_only",
        action="store_true",
        default=False,
        help="Print Slurm cluster names from config as JSON array (no SSH)",
    )
    sp_slurm.set_defaults(func=_cmd_slurm)

    return p


def _find_tui_binary() -> Optional[str]:
    import shutil
    from pathlib import Path

    # Allow explicit override
    env = os.environ.get("OPENSMI_TUI_BIN")
    if env:
        return env

    # Prefer sibling next to the current launcher script
    try:
        here = Path(sys.argv[0]).expanduser().resolve()
        if here.parent.exists():
            cand = here.parent / "opensmi-tui"
            if cand.exists() and os.access(str(cand), os.X_OK):
                return str(cand)
    except Exception:
        pass

    # Common default install path
    cand = Path.home() / ".local" / "bin" / "opensmi-tui"
    if cand.exists() and os.access(str(cand), os.X_OK):
        return str(cand)

    # PATH
    return shutil.which("opensmi-tui")


def _launch_tui() -> None:
    # Only auto-launch in an interactive TTY.
    if not sys.stdout.isatty():
        print("No subcommand provided. Use --help for CLI usage.", file=sys.stderr)
        raise SystemExit(2)

    tui = _find_tui_binary()
    if not tui:
        print(
            "opensmi-tui not found. Install it via the installer or set OPENSMI_TUI_BIN.\n"
            "Examples:\n"
            "  curl -fsSL https://raw.githubusercontent.com/seilk/opensmi/main/scripts/install.sh | bash\n"
            "  OPENSMI_TUI_BIN=/path/to/opensmi-tui opensmi\n",
            file=sys.stderr,
        )
        raise SystemExit(2)

    os.execvp(tui, [tui])


def main(argv: Optional[list] = None) -> None:
    argv = list(argv) if argv is not None else sys.argv[1:]

    # If the user runs just `opensmi`, launch the TUI.
    if len(argv) == 0:
        _launch_tui()

    from .logging import get_logger
    from .slurm_beta import (
        SlurmBetaError,
        beta_resolved_mode_log_line,
        resolve_mode,
        require_slurm_beta_context,
    )

    log = get_logger("cli")
    log.info("opensmi %s — argv=%s", __version__, argv)

    parser = build_parser()
    args = parser.parse_args(argv)

    # --- Slurm beta wire-up (opt-in only) ---
    experimental_slurm = getattr(args, "experimental_slurm", False)
    config_mode: str | None = (
        None  # loaded later if needed; precedence check here uses env+cli only
    )

    resolved = resolve_mode(
        cli_experimental_slurm=bool(experimental_slurm),
        env=dict(os.environ),
        config_mode=config_mode,
    )
    log_line = beta_resolved_mode_log_line(resolved)
    if log_line:
        print(f"[BETA] {log_line}", file=sys.stderr)
        log.info("slurm-beta: %s", log_line)
        try:
            require_slurm_beta_context(dict(os.environ))
        except SlurmBetaError as exc:
            print(f"[BETA] {exc.code}: {exc}", file=sys.stderr)
            if exc.diagnostics:
                print(f"[BETA] diagnostics: {exc.diagnostics}", file=sys.stderr)
            raise SystemExit(5) from exc

    if not getattr(args, "cmd", None):
        # Still no subcommand (e.g., only global flags were used) → show help.
        parser.print_help()
        raise SystemExit(0)

    rc = int(args.func(args))
    raise SystemExit(rc)
