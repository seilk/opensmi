#!/usr/bin/env python3
"""
demo-onboard.py — Preview of `opensmi onboard` wizard UI
No SSH connections are made. No files are written.
Run:  python3 scripts/demo-onboard.py
"""
import sys
import time

# ── ANSI helpers ──────────────────────────────────────────────────────────────
def _c(code: str) -> str:
    return f"\033[{code}m" if sys.stdout.isatty() else ""

GREEN  = _c("32")
YELLOW = _c("33")
BOLD   = _c("1")
DIM    = _c("2")
RESET  = _c("0")

W    = 44
LINE = "─" * W

def box_row(text: str, style: str = "") -> str:
    return f"  {GREEN}│{RESET}  {style}{text[:W].ljust(W)}{RESET}{GREEN}│{RESET}"

def prompt(label: str, hint: str, default: str) -> str:
    hint_str    = f"  {DIM}{hint}{RESET}\n" if hint else ""
    default_str = f" [{DIM}{default}{RESET}]" if default else ""
    return f"{hint_str}  {BOLD}{label}{RESET}{default_str}: "


# ── header ────────────────────────────────────────────────────────────────────
print(f"\n  {GREEN}╭{LINE}╮{RESET}")
print(box_row("opensmi onboard", BOLD))
print(box_row("Set up your GPU cluster config.", DIM))
print(f"  {GREEN}╰{LINE}╯{RESET}\n")


# ── cluster label ──────────────────────────────────────────────────────────────
raw = input(prompt(
    "Cluster label",
    "Shown in the dashboard header — any name you like.",
    "GPU-Cluster",
)).strip()
cluster_name = raw or "GPU-Cluster"


# ── node count ─────────────────────────────────────────────────────────────────
raw_n = input(prompt("Number of GPU nodes", "", "2")).strip() or "2"
try:
    n_nodes = max(1, int(raw_n))
except ValueError:
    n_nodes = 2


# ── nodes ──────────────────────────────────────────────────────────────────────
nodes = []
print(f"\n  {BOLD}Add GPU nodes{RESET}  {DIM}({n_nodes} total){RESET}\n")

for idx in range(1, n_nodes + 1):
    default_alias = f"GPU-{idx:02d}"
    print(f"  {DIM}── Node #{idx} ──────────────────────────────────{RESET}")

    alias   = input(prompt("  Alias",   "", default_alias)).strip() or default_alias
    address = input(prompt("  Address", "IP or hostname", "")).strip() or "192.168.1.10"
    user    = input(prompt("  SSH user","", "ubuntu")).strip() or "ubuntu"

    # Simulated SSH test
    sys.stdout.write(f"  {DIM}Testing SSH ({user}@{address})...{RESET}  ")
    sys.stdout.flush()
    time.sleep(0.8)  # simulate latency
    print(f"{GREEN}✓ connected{RESET}")

    nodes.append({"alias": alias, "address": address, "user": user})
    print()


# ── admin ──────────────────────────────────────────────────────────────────────
default_admin = nodes[0]["user"] if nodes else "ubuntu"
admin = input(prompt(
    "Admin username",
    "SSH user who manages the cluster.",
    default_admin,
)).strip() or default_admin


# ── done card ──────────────────────────────────────────────────────────────────
cfg_path = "~/.opensmi/opensmi.json"
print(f"\n  {GREEN}╭{LINE}╮{RESET}")
print(box_row("✓  Config saved", BOLD))
print(box_row(f"   {cfg_path}", DIM))
print(box_row("", ""))
print(box_row("Next steps:", DIM))
print(box_row("  opensmi poll          # verify SSH + GPUs", ""))
print(box_row("  opensmi alloc seed    # seed from live usage", ""))
print(f"  {GREEN}╰{LINE}╯{RESET}\n")

print(f"{DIM}(demo mode — no files written, SSH tests simulated){RESET}\n")
