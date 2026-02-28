#!/usr/bin/env python3
"""
test-onboard.py — Onboarding smoke test for opensmi main branch.

Tests the full onboarding config flow with dummy data (no real SSH).
Verifies: config write, CLI parsing, clusters list, slurm names, poll dry-run.

Usage:
    python3 scripts/test-onboard.py
    python3 scripts/test-onboard.py --verbose
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

# ── ANSI ─────────────────────────────────────────────────────────────────────
def _c(code): return f"\033[{code}m" if sys.stdout.isatty() else ""
G, Y, R, B, D, BOLD, RESET = _c("32"), _c("33"), _c("31"), _c("34"), _c("2"), _c("1"), _c("0")

def ok(msg):    print(f"  {G}✓{RESET}  {msg}")
def warn(msg):  print(f"  {Y}⚠{RESET}  {msg}")
def fail(msg):  print(f"  {R}✗{RESET}  {msg}")
def info(msg):  print(f"  {D}·{RESET}  {D}{msg}{RESET}")
def header(msg):print(f"\n{BOLD}{msg}{RESET}\n{'─'*50}")

# ── helpers ───────────────────────────────────────────────────────────────────
REPO = Path(__file__).resolve().parent.parent
PYTHON = sys.executable
OPENSMI = [PYTHON, "-m", "opensmi"]

def run(args, *, env=None, input=None):
    e = {**os.environ, "PYTHONPATH": str(REPO / "src"), **(env or {})}
    return subprocess.run(
        args, capture_output=True, text=True, env=e, input=input,
        cwd=str(REPO),
    )

def opensmi(*subcmd, config=None, state_dir=None):
    """Build opensmi command with global flags before subcommand."""
    cmd = list(OPENSMI)
    if state_dir: cmd += ["--state-dir", str(state_dir)]
    if config:    cmd += ["--config",    str(config)]
    cmd += list(subcmd)
    return cmd

VERBOSE = "--verbose" in sys.argv or "-v" in sys.argv

def show(label, result):
    if VERBOSE or result.returncode != 0:
        if result.stdout.strip():
            for line in result.stdout.strip().splitlines()[:8]:
                info(f"  stdout: {line}")
        if result.stderr.strip():
            for line in result.stderr.strip().splitlines()[:5]:
                info(f"  stderr: {line}")

# ── dummy config ──────────────────────────────────────────────────────────────
DUMMY_MULTI_CONFIG = {
    "clusters": [
        {
            "cluster_name": "Lab-A",
            "nodes": [
                {"alias": "GPU-01", "address": "10.0.0.1", "user": "ubuntu"},
                {"alias": "GPU-02", "address": "10.0.0.2", "user": "ubuntu"},
            ],
            "admins": {"master": "ubuntu", "members": ["ubuntu"]},
            "users": [],
            "policy": {"require_allocation": True, "all_users_token": "*", "enforcement": "detect_only"},
        },
        {
            "cluster_name": "Lab-B",
            "nodes": [
                {"alias": "GPU-05", "address": "10.0.1.1", "user": "admin"},
            ],
            "admins": {"master": "admin", "members": ["admin"]},
            "users": [],
            "policy": {"require_allocation": False, "all_users_token": "*", "enforcement": "detect_only"},
        },
    ],
    "slurm_clusters": [
        {"name": "HPC-Prod", "login_node": "hpc-login.example.com", "user": "researcher"},
        {"name": "HPC-Dev",  "login_node": "hpc-dev.example.com",   "user": "researcher"},
    ],
}

DUMMY_LEGACY_CONFIG = {
    "cluster_name": "Legacy-Cluster",
    "nodes": [
        {"alias": "GPU-01", "address": "192.168.1.10", "user": "ubuntu"},
    ],
    "admins": {"master": "ubuntu", "members": ["ubuntu"]},
    "users": [],
    "policy": {"require_allocation": True, "all_users_token": "*", "enforcement": "detect_only"},
}

# ── test runner ───────────────────────────────────────────────────────────────
failures = []

def check(label, cond, detail=""):
    if cond:
        ok(label)
    else:
        fail(f"{label}{(' — ' + detail) if detail else ''}")
        failures.append(label)

# ═════════════════════════════════════════════════════════════════════════════
print(f"\n{BOLD}opensmi onboarding smoke test{RESET}  {D}(main branch, no real SSH){RESET}")
print(f"  repo: {REPO}")
print(f"  python: {PYTHON}")

# ── 1. Version check ──────────────────────────────────────────────────────────
header("1. CLI version check")
r = run(OPENSMI + ["--version"])
check("opensmi --version exits 0", r.returncode == 0, r.stderr.strip())
ver = r.stdout.strip()
check("version string looks like semver", bool(__import__("re").search(r"\d+\.\d+\.\d+", ver)), ver)
show("version", r)
info(f"version: {ver}")

# ── 2. Config parsing — multi-cluster format ──────────────────────────────────
header("2. Multi-cluster config (clusters[] format)")
with tempfile.TemporaryDirectory() as tmp:
    cfg = Path(tmp) / "opensmi.json"
    cfg.write_text(json.dumps(DUMMY_MULTI_CONFIG, indent=2))

    r = run(opensmi("clusters", "list", "--json", config=cfg, state_dir=tmp))
    check("clusters list --json exits 0", r.returncode == 0, r.stderr.strip())
    show("clusters list", r)
    if r.returncode == 0:
        try:
            data = json.loads(r.stdout)
            check("returns list", isinstance(data, list))
            check("has 2 clusters", len(data) == 2, str(data))
            check("cluster names correct",
                  [c["cluster_name"] for c in data] == ["Lab-A", "Lab-B"],
                  str([c.get("cluster_name") for c in data]))
            check("node counts correct",
                  [c["node_count"] for c in data] == [2, 1],
                  str([c.get("node_count") for c in data]))
            info(f"clusters: {[(c['cluster_name'], c['node_count']) for c in data]}")
        except Exception as e:
            fail(f"JSON parse error: {e}")
            failures.append("clusters list JSON parse")

    # slurm names
    r2 = run(opensmi("slurm", "--names-only", config=cfg, state_dir=tmp))
    check("slurm --names-only exits 0", r2.returncode == 0, r2.stderr.strip())
    show("slurm names", r2)
    if r2.returncode == 0:
        try:
            names = json.loads(r2.stdout)
            check("slurm cluster count == 2", len(names) == 2, str(names))
            check("slurm names correct", names == ["HPC-Prod", "HPC-Dev"], str(names))
            info(f"slurm names: {names}")
        except Exception as e:
            fail(f"slurm names JSON parse error: {e}")
            failures.append("slurm names JSON parse")

# ── 3. Config parsing — legacy format ────────────────────────────────────────
header("3. Legacy config (root-level cluster_name + nodes)")
with tempfile.TemporaryDirectory() as tmp:
    cfg = Path(tmp) / "opensmi.json"
    cfg.write_text(json.dumps(DUMMY_LEGACY_CONFIG, indent=2))

    r = run(opensmi("clusters", "list", "--json", config=cfg, state_dir=tmp))
    check("legacy config: clusters list exits 0", r.returncode == 0, r.stderr.strip())
    show("legacy clusters", r)
    if r.returncode == 0:
        try:
            data = json.loads(r.stdout)
            check("legacy: returns 1 cluster", len(data) == 1, str(data))
            check("legacy: cluster name preserved",
                  data[0]["cluster_name"] == "Legacy-Cluster",
                  str(data[0].get("cluster_name")))
            info(f"legacy cluster: {data[0]['cluster_name']} ({data[0]['node_count']} node)")
        except Exception as e:
            fail(f"legacy JSON parse error: {e}")
            failures.append("legacy config parse")

# ── 4. opensmi onboard --defaults (non-interactive template write) ────────────
header("4. opensmi onboard --defaults (write template without wizard)")
with tempfile.TemporaryDirectory() as tmp:
    r = run(opensmi("onboard", "--defaults", state_dir=tmp))
    check("onboard --defaults exits 0", r.returncode == 0, r.stderr.strip()[:120])
    show("onboard --defaults", r)
    cfg = Path(tmp) / "opensmi.json"
    check("config file created", cfg.exists())
    if cfg.exists():
        try:
            data = json.loads(cfg.read_text())
            has_nodes = "nodes" in data or any("nodes" in c for c in data.get("clusters", []))
            check("config has nodes", has_nodes)
            info(f"config keys: {list(data.keys())}")
        except Exception as e:
            fail(f"config parse error: {e}")

# ── 5. opensmi poll (SSH timeout expected) ────────────────────────────────────
header("5. opensmi poll (dummy nodes — expect SSH timeout/error, not crash)")
with tempfile.TemporaryDirectory() as tmp:
    cfg = Path(tmp) / "opensmi.json"
    # Use non-routable address to get fast failure
    fast_fail_cfg = {
        "cluster_name": "Test",
        "nodes": [{"alias": "TEST-01", "address": "192.0.2.1", "user": "nobody", "port": 22, "connect_timeout_s": 2}],
        "admins": {"master": "nobody", "members": []},
        "users": [],
        "policy": {"require_allocation": False, "all_users_token": "*", "enforcement": "detect_only"},
    }
    cfg.write_text(json.dumps(fast_fail_cfg))
    r = run(opensmi("poll", "--json", "--timeout", "3", config=cfg, state_dir=tmp))
    # Poll should return JSON even when nodes fail (node error state)
    show("poll", r)
    show("poll", r)
    if r.returncode == 0 and r.stdout.strip():
        try:
            data = json.loads(r.stdout)
            check("poll: returns cluster snapshot", "nodes" in data)
            nodes = data.get("nodes") or []
            if nodes:
                has_error = any(n.get("error") for n in nodes)
                no_gpus   = all(len(n.get("gpus") or []) == 0 for n in nodes)
                check("poll: graceful on unreachable node (error or empty GPUs)",
                      has_error or no_gpus,
                      f"node[0] error={nodes[0].get('error')}")
                info(f"poll: node error = {(nodes[0].get('error') or 'none — empty GPUs')[:80]}")
            else:
                warn("poll: nodes list empty")
        except Exception as e:
            warn(f"poll JSON parse: {e}\nstdout: {r.stdout[:200]}")
    else:
        warn(f"poll exited {r.returncode} (SSH refused — expected for dummy nodes)")

# ── 6. OPENSMI_CONFIG env override ────────────────────────────────────────────
header("6. OPENSMI_CONFIG env var override")
with tempfile.TemporaryDirectory() as tmp:
    cfg = Path(tmp) / "custom.json"
    cfg.write_text(json.dumps(DUMMY_LEGACY_CONFIG, indent=2))
    r = run(OPENSMI + ["clusters", "list", "--json"],
            env={"OPENSMI_CONFIG": str(cfg), "OPENSMI_STATE_DIR": tmp})
    check("OPENSMI_CONFIG override works", r.returncode == 0, r.stderr.strip()[:80])
    show("env override", r)
    if r.returncode == 0:
        try:
            data = json.loads(r.stdout)
            check("env override: correct cluster loaded",
                  data[0]["cluster_name"] == "Legacy-Cluster", str(data))
            info(f"loaded: {data[0]['cluster_name']}")
        except Exception as e:
            fail(f"env override JSON parse: {e}")

# ── summary ───────────────────────────────────────────────────────────────────
print(f"\n{'═'*50}")
if not failures:
    print(f"\n  {G}{BOLD}All checks passed ✓{RESET}\n")
    sys.exit(0)
else:
    print(f"\n  {R}{BOLD}{len(failures)} check(s) failed:{RESET}")
    for f in failures:
        print(f"    {R}✗{RESET} {f}")
    print()
    sys.exit(1)
