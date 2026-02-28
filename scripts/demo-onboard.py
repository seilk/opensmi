#!/usr/bin/env python3
"""
demo-onboard.py — Simulated walkthrough of `opensmi onboard` as a new user.

Runs the REAL onboard wizard with pre-programmed inputs piped in.
No SSH connections are made (SSH test will show ⚠ unreachable, user continues).
No files are written (temp dir is used and discarded).

Usage:
    python3 scripts/demo-onboard.py                  # manual entry mode
    python3 scripts/demo-onboard.py --mode auto       # SSH-import mode
    python3 scripts/demo-onboard.py --slow            # typed character-by-character
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO   = Path(__file__).resolve().parent.parent
PYTHON = sys.executable

# ── ANSI ─────────────────────────────────────────────────────────────────────
def _c(c): return f"\033[{c}m" if sys.stdout.isatty() else ""
DIM, BOLD, CYAN, YELLOW, RESET = _c("2"), _c("1"), _c("36"), _c("33"), _c("0")

# ── argument parse ─────────────────────────────────────────────────────────────
ap = argparse.ArgumentParser(description="demo-onboard: simulate new-user onboarding")
ap.add_argument("--mode", choices=["manual", "auto"], default="manual")
ap.add_argument("--slow", action="store_true", help="type-effect delay")
opt = ap.parse_args()

# ── demo inputs ────────────────────────────────────────────────────────────────
# Each string maps to one interactive prompt in order.
# "\n" = press Enter (accept default).

if opt.mode == "auto":
    INPUTS = [
        "My GPU Lab\n",   # Cluster label
        "a\n",            # Node setup mode: a=auto import from ~/.ssh/config
        "\n",             # SSH config path (default ~/.ssh/config)
        "all\n",          # Select all discovered hosts
        "ubuntu\n",       # Admin username
        "n\n",            # Skip verify (no real nodes)
    ]
else:
    INPUTS = [
        "My GPU Lab\n",   # Cluster label
        "m\n",            # Node setup mode: manual
        "2\n",            # Number of GPU nodes
        # Node 1 — 127.0.0.1:19998 gives instant "Connection refused"
        "GPU-01\n",       # Alias
        "127.0.0.1\n",    # Address
        "ubuntu\n",       # SSH user
        "19998\n",        # SSH port (nothing listening → instant fail)
        "y\n",            # SSH unreachable → continue anyway
        # Node 2
        "GPU-02\n",       # Alias
        "127.0.0.1\n",    # Address
        "ubuntu\n",       # SSH user
        "19999\n",        # SSH port
        "y\n",            # SSH unreachable → continue anyway
        # Post-nodes
        "ubuntu\n",       # Admin username
        "n\n",            # Skip verify
    ]

stdin_data = "".join(INPUTS)

# ── header ─────────────────────────────────────────────────────────────────────
print(f"\n{BOLD}{'─'*56}{RESET}")
print(f"{BOLD}  opensmi onboard  —  new user simulation{RESET}")
print(f"{DIM}  Mode: {opt.mode}  ·  No files written  ·  SSH tests simulated{RESET}")
print(f"{BOLD}{'─'*56}{RESET}\n")
time.sleep(0.4)

# Show what the user would type
print(f"{DIM}  Scripted inputs:{RESET}")
labels = {
    0: "Cluster label",
    1: "Node setup mode",
}
for i, inp in enumerate(INPUTS):
    val = inp.strip() or "(Enter — use default)"
    print(f"  {DIM}{str(i+1).rjust(2)}.{RESET}  {CYAN}{val}{RESET}")

print(f"\n{DIM}{'─'*56}{RESET}\n")
sys.stdout.flush()
time.sleep(0.6 if opt.slow else 0.2)

# ── run the real wizard ────────────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as tmp:
    env = {
        **os.environ,
        "PYTHONPATH": str(REPO / "src"),
        "OPENSMI_STATE_DIR": tmp,
        # Force color output even though stdin is piped
        "FORCE_COLOR": "1",
        "TERM": os.environ.get("TERM", "xterm-256color"),
    }

    proc = subprocess.run(
        [PYTHON, "-m", "opensmi", "--state-dir", tmp, "onboard"],
        input=stdin_data,
        env=env,
        cwd=str(REPO),
        text=True,
        capture_output=False,   # stream directly to terminal
    )

    print(f"\n{DIM}{'─'*56}{RESET}")
    written = Path(tmp) / "opensmi.json"
    if written.exists():
        import json
        data = json.loads(written.read_text())
        print(f"{BOLD}  Config written to: {tmp}/opensmi.json{RESET}")
        print(f"{DIM}  cluster_name : {data.get('cluster_name')}{RESET}")
        nodes = data.get("nodes") or []
        print(f"{DIM}  nodes        : {len(nodes)}{RESET}")
        for n in nodes:
            print(f"{DIM}               · {n['alias']} → {n['user']}@{n['address']}{RESET}")
        print(f"{DIM}  (temp dir will be deleted){RESET}")
    else:
        print(f"{YELLOW}  No config written (wizard may have exited early){RESET}")

    print(f"\n{DIM}  exit code: {proc.returncode}{RESET}")

print(f"{BOLD}{'─'*56}{RESET}\n")
