from __future__ import annotations

import argparse
import asyncio
import json
import os
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
from .config import load_config, save_default_config
from .sshutil import SSHRunError, ssh_bash_script, ssh_run
from .executor import (
    inject_cuda_visible_devices,
    route_command_to_target,
    run_preflight_checks,
)
from .state import (
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
    for n in cfg.nodes:
        if n.alias == alias:
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
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)

    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)

    if args.wizard:
        return _init_wizard(cfg_path, n_nodes=args.nodes)

    if args.from_ssh_config:
        return _init_from_ssh_config(cfg_path, args.from_ssh_config)

    save_default_config(cfg_path, force=bool(args.force))
    print(f"Config created: {cfg_path}")
    print(f"Edit it, then run: opensmi poll")
    return 0


def _cmd_onboard(args: argparse.Namespace) -> int:
    """Onboarding wizard to create opensmi.json (interactive)."""
    state_dir = get_state_dir(args.state_dir)
    ensure_state_dir(state_dir)

    cfg_path = resolve_config_path(state_dir=state_dir, cli_config=args.config)

    if cfg_path.exists() and not bool(args.force):
        print(
            f"Config already exists: {cfg_path} (use --force to overwrite)",
            file=sys.stderr,
        )
        return 2

    if args.from_ssh_config:
        return _init_from_ssh_config(cfg_path, args.from_ssh_config)

    return _init_wizard(cfg_path, n_nodes=args.nodes)


def _init_wizard(cfg_path: Path, *, n_nodes: Optional[int] = None) -> int:
    """Interactive setup wizard."""
    import json as _json

    print("=== opensmi init wizard ===\n")

    cluster_name = input("Cluster name [GPU-Cluster]: ").strip() or "GPU-Cluster"

    # Nodes
    if n_nodes is None:
        while True:
            raw_n = input("\nNumber of GPU nodes [2]: ").strip() or "2"
            try:
                n_nodes = int(raw_n)
                if n_nodes <= 0:
                    raise ValueError
                break
            except ValueError:
                print("Please enter a positive integer (e.g. 6).")
    else:
        if int(n_nodes) <= 0:
            print("--nodes must be a positive integer", file=sys.stderr)
            return 2
        n_nodes = int(n_nodes)

    nodes = []
    print("\nAdd GPU nodes:")

    for idx in range(1, n_nodes + 1):
        default_alias = f"GPU-{idx:02d}"

        while True:
            alias = (
                input(f"  Node #{idx} alias [{default_alias}]: ").strip()
                or default_alias
            )
            address = input(f"  Node #{idx} address (IP or hostname): ").strip()
            if not address:
                print("  Address required. Try again.")
                continue
            user = input(f"  Node #{idx} SSH user [seil]: ").strip() or "seil"
            nodes.append({"alias": alias, "address": address, "user": user})
            break

    if not nodes:
        print("No nodes added. Aborting.")
        return 1

    admin = input(
        f"\nMaster admin username [{nodes[0].get('user', 'admin')}]: "
    ).strip() or nodes[0].get("user", "admin")

    data = {
        "cluster_name": cluster_name,
        "nodes": nodes,
        "admins": {"master": admin, "members": [admin]},
        "users": [],
        "policy": {
            "require_allocation": True,
            "all_users_token": "*",
            "enforcement": "detect_only",
        },
    }

    cfg_path.write_text(
        _json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    print(f"\n✅ Config written: {cfg_path}")
    print(f"Next steps:")
    print(f"  opensmi poll            # verify connectivity")
    print(f"  opensmi alloc seed      # seed allocations from live usage")
    return 0


def _init_from_ssh_config(cfg_path: Path, ssh_config_path: str) -> int:
    """Parse ~/.ssh/config for GPU node entries."""
    import json as _json
    import re

    ssh_path = Path(ssh_config_path).expanduser().resolve()
    if not ssh_path.exists():
        print(f"SSH config not found: {ssh_path}", file=sys.stderr)
        return 2

    text = ssh_path.read_text(encoding="utf-8")
    # Simple parser: look for Host + HostName + User blocks
    hosts = []
    current: dict = {}

    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        m = re.match(r"Host\s+(.+)", line, re.IGNORECASE)
        if m:
            if current.get("alias") and current.get("address"):
                hosts.append(dict(current))

            raw = m.group(1).strip()
            tokens = raw.split()
            alias = None
            for t in tokens:
                # Ignore negations and wildcards (e.g. Host * / Host *.domain / Host !foo)
                if t.startswith("!"):
                    continue
                if any(ch in t for ch in "*?"):
                    continue
                alias = t
                break

            current = {"alias": alias} if alias else {}
            continue

        m = re.match(r"HostName\s+(.+)", line, re.IGNORECASE)
        if m:
            if not current:
                continue
            current["address"] = m.group(1).strip()
            continue

        m = re.match(r"User\s+(.+)", line, re.IGNORECASE)
        if m:
            if not current:
                continue
            current["user"] = m.group(1).strip()
            continue

    if current.get("alias") and current.get("address"):
        hosts.append(dict(current))

    if not hosts:
        print(f"No hosts found in {ssh_path}", file=sys.stderr)
        return 2

    print(f"Found {len(hosts)} host(s) in {ssh_path}:")
    nodes = []
    for h in hosts:
        alias = h["alias"]
        addr = h["address"]
        user = h.get("user", "root")
        print(f"  {alias} → {user}@{addr}")
        nodes.append({"alias": alias, "address": addr, "user": user})

    admin = nodes[0].get("user", "admin") if nodes else "admin"

    data = {
        "cluster_name": "GPU-Cluster",
        "nodes": nodes,
        "admins": {"master": admin, "members": [admin]},
        "users": [],
        "policy": {
            "require_allocation": True,
            "all_users_token": "*",
            "enforcement": "detect_only",
        },
    }

    cfg_path.write_text(
        _json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    print(f"\n✅ Config written: {cfg_path}")
    print(f"Next: opensmi poll")
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
            f"Run: opensmi init (writes ./opensmi.json in a repo checkout, or ~/.opensmi/opensmi.json when installed)\n"
            f"Tip: override with --config or OPENSMI_CONFIG",
            file=sys.stderr,
        )
        return 2

    cfg = load_config(cfg_path)

    cluster_snap = asyncio.run(poll_cluster(cfg, timeout_s=int(args.timeout)))

    if args.json:
        print(json.dumps(snapshot_to_jsonable(cluster_snap), indent=2, sort_keys=False))
    else:
        print(_render_dashboard(cluster_snap))

    if args.write_latest:
        ensure_state_dir(state_dir)
        out_path = latest_snapshot_path(state_dir)
        out_path.write_text(
            json.dumps(snapshot_to_jsonable(cluster_snap), indent=2, sort_keys=False)
            + "\n",
            encoding="utf-8",
        )

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
    from .allocations import _now_iso

    state_dir, cfg = _load_cfg(args)
    _require_admin(cfg, "alloc set", node_aliases=[args.node])

    ensure_state_dir(state_dir)

    allocs = load_allocations(state_dir)
    new_alloc = Allocation(
        node_alias=args.node,
        gpu_index=int(args.gpu),
        target=args.user,
        assigned_by=args.by or _current_operator() or "admin",
        assigned_at=_now_iso(),
        notes=args.notes or "",
    )
    allocs = upsert_allocation(allocs, new_alloc)
    save_allocations(state_dir, allocs)
    print(f"OK: {args.node} GPU{args.gpu} → {args.user}")
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
    from .allocations import _now_iso

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
                assigned_at=_now_iso(),
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
    log.info("job submit — command=%s node=%s gpus=%s queue=%s", args.command, getattr(args, 'node', None), getattr(args, 'gpus', None), getattr(args, 'queue', False))
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
        session = f"opensmi-{job.id}-{args.node}" if args.tmux else None
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
    if args.env_manager is not None or args.env_name is not None or args.work_dir is not None:
        ok = update_node_env(
            cfg_path,
            alias=args.node,
            env_manager=args.env_manager if args.env_manager is not None else node.env_manager,
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
    log.info("exec — node=%s command=%s mode=%s", getattr(args, 'node', None), getattr(args, 'command', None), getattr(args, 'mode', None))
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
        session = (
            str(args.session or "").strip() or f"opensmi-{args.node}-{int(time.time())}"
        )

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
        help="Config path (default: ./opensmi.json in a repo checkout, else <state-dir>/opensmi.json; override with OPENSMI_CONFIG)",
    )

    sub = p.add_subparsers(dest="cmd", required=False)

    sp_init = sub.add_parser("init", help="Create default opensmi.json")
    sp_init.add_argument(
        "--force", action="store_true", help="Overwrite existing config"
    )
    sp_init.add_argument(
        "--wizard", action="store_true", help="Interactive setup wizard"
    )
    sp_init.add_argument(
        "--nodes", type=int, default=None, help="Number of nodes (wizard only)"
    )
    sp_init.add_argument(
        "--from-ssh-config",
        default=None,
        metavar="PATH",
        help="Import nodes from ~/.ssh/config (e.g. --from-ssh-config ~/.ssh/config)",
    )
    sp_init.set_defaults(func=_cmd_init)

    sp_on = sub.add_parser(
        "onboard", help="Interactive onboarding to create opensmi.json"
    )
    sp_on.add_argument("--force", action="store_true", help="Overwrite existing config")
    sp_on.add_argument(
        "--nodes", type=int, default=None, help="Number of nodes (wizard only)"
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
    sp_poll.set_defaults(func=_cmd_poll)

    # ── alloc ──
    sp_alloc = sub.add_parser("alloc", help="Manage GPU allocations")
    alloc_sub = sp_alloc.add_subparsers(dest="alloc_cmd", required=True)

    sp_al = alloc_sub.add_parser("list", help="Show all allocations")
    sp_al.set_defaults(func=_cmd_alloc_list)

    sp_as = alloc_sub.add_parser("set", help="Assign a GPU to a user")
    sp_as.add_argument("node", help="Node alias (e.g. 'GPU-01')")
    sp_as.add_argument("gpu", type=int, help="GPU index (0-3)")
    sp_as.add_argument("user", help="Linux username or '*' for everyone")
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
    sp_ne = sub.add_parser("node-env", help="Get or set per-node env config (env_manager, env_name, work_dir)")
    sp_ne.add_argument("node", help="Node alias")
    sp_ne.add_argument("--env-manager", default=None, help="conda | miniconda | micromamba | venv | (empty to clear)")
    sp_ne.add_argument("--env-name", default=None, help="Virtual env name")
    sp_ne.add_argument("--work-dir", default=None, help="Remote working directory")
    sp_ne.add_argument("--json", dest="json", action="store_true", default=False)
    sp_ne.set_defaults(func=_cmd_node_env)

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
    log = get_logger("cli")
    log.info("opensmi %s — argv=%s", __version__, argv)

    parser = build_parser()
    args = parser.parse_args(argv)

    if not getattr(args, "cmd", None):
        # Still no subcommand (e.g., only global flags were used) → show help.
        parser.print_help()
        raise SystemExit(0)

    rc = int(args.func(args))
    raise SystemExit(rc)
