#!/usr/bin/env python3
"""
opensmi update UI demo — spinner + summary card (no vertical bars)
Usage: python3 scripts/demo-installer-ui.py
"""

from __future__ import annotations
import sys
import time
import threading

# ── ANSI helpers ──────────────────────────────────────────────────
IS_TTY = sys.stdout.isatty()

def _c(code: str) -> str:
    return f"\033[{code}m" if IS_TTY else ""

RESET = _c("0")
GREEN = _c("32")
DIM   = _c("2")
BOLD  = _c("1")
RED   = _c("31")

def cursor_hide() -> None:
    if IS_TTY: sys.stdout.write("\033[?25l"); sys.stdout.flush()

def cursor_show() -> None:
    if IS_TTY: sys.stdout.write("\033[?25h"); sys.stdout.flush()


# ── Spinner ───────────────────────────────────────────────────────
class Spinner:
    FRAMES   = ["|", "/", "-", "\\"]
    INTERVAL = 0.06

    def __init__(self, msg: str) -> None:
        self.msg   = msg
        self._stop = threading.Event()
        self._t    = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        if not IS_TTY:
            sys.stdout.write(f"  {self.msg}\n"); sys.stdout.flush(); return
        i = 0
        while not self._stop.is_set():
            c = self.FRAMES[i % len(self.FRAMES)]
            sys.stdout.write(f"\r  {GREEN}{c}{RESET}  {self.msg}")
            sys.stdout.flush()
            time.sleep(self.INTERVAL)
            i += 1
        sys.stdout.write("\r\033[K"); sys.stdout.flush()

    def __enter__(self) -> "Spinner":
        cursor_hide(); self._t.start(); return self

    def __exit__(self, exc_type, *_) -> None:
        self._stop.set(); self._t.join(); cursor_show()
        if exc_type:
            print(f"  {RED}✗{RESET}  {self.msg}")
        else:
            print(f"  {GREEN}✓{RESET}  {self.msg}")


# ── Summary Card (no vertical bars) ──────────────────────────────
def print_summary(version: str, bin_dir: str, config_dir: str) -> None:
    W    = 48
    line = "─" * W

    print()
    print(f"  {GREEN}{line}{RESET}")
    print()
    print(f"  {BOLD}opensmi {version}{RESET}  {DIM}installed{RESET}")
    print()
    print(f"  {DIM}{'CLI':<8}{RESET}  {bin_dir}/opensmi")
    print(f"  {DIM}{'TUI':<8}{RESET}  {bin_dir}/opensmi-tui")
    print(f"  {DIM}{'Config':<8}{RESET}  {config_dir}/opensmi.json")
    print()
    print(f"  {GREEN}Next:{RESET}  opensmi onboard")
    print()
    print(f"  {GREEN}{line}{RESET}")
    print()


# ── Demo ──────────────────────────────────────────────────────────
def main() -> None:
    print()
    print(f"  {BOLD}Installing opensmi{RESET}  {DIM}(demo){RESET}")
    print()

    steps = [
        ("Fetching latest release from GitHub...", 1.2),
        ("Downloading opensmi CLI...",             1.5),
        ("Downloading opensmi-tui (darwin-arm64)...", 2.0),
        ("Verifying SHA256 checksums...",          0.8),
        ("Installing to ~/.local/bin...",          0.6),
        ("Updating PATH in ~/.zshrc...",           0.4),
    ]

    for msg, duration in steps:
        with Spinner(msg):
            time.sleep(duration)

    print_summary("v0.3.1", "~/.local/bin", "~/.opensmi")


if __name__ == "__main__":
    main()
