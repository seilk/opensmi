#!/usr/bin/env python3
"""
opensmi update UI demo — spinner + summary card
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
    """Line/Clock spinner: | / - \\
    - FRAMES uses "\\" which is a single backslash — correct in Python
    - Thread clears its line before exit → no race with ✓ print
    """

    FRAMES   = ["|", "/", "-", "\\"]   # "\\" = one backslash
    INTERVAL = 0.06                     # faster: was 0.12

    def __init__(self, msg: str) -> None:
        self.msg   = msg
        self._stop = threading.Event()
        self._t    = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        if not IS_TTY:
            sys.stdout.write(f"  |  {self.msg}\n")
            sys.stdout.flush()
            return
        i = 0
        while not self._stop.is_set():
            c = self.FRAMES[i % len(self.FRAMES)]
            sys.stdout.write(f"\r  {GREEN}{c}{RESET}  {self.msg}")
            sys.stdout.flush()
            time.sleep(self.INTERVAL)
            i += 1
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()

    def __enter__(self) -> "Spinner":
        cursor_hide()
        self._t.start()
        return self

    def __exit__(self, exc_type, *_) -> None:
        self._stop.set()
        self._t.join()
        cursor_show()
        if exc_type:
            print(f"  {RED}✗{RESET}  {self.msg}")
        else:
            print(f"  {GREEN}✓{RESET}  {self.msg}")


# ── Summary Card ──────────────────────────────────────────────────
def print_summary(version: str, bin_dir: str) -> None:
    W    = 44
    line = "─" * W

    def row(text: str = "", style: str = "") -> str:
        return f"  {GREEN}│{RESET}  {style}{text[:W].ljust(W)}{RESET}{GREEN}│{RESET}"

    print()
    print(f"  {GREEN}╭{line}╮{RESET}")
    print(row(f"opensmi {version} installed", BOLD))
    print(row())
    print(row(f"CLI  →  {bin_dir}/opensmi"))
    print(row(f"TUI  →  {bin_dir}/opensmi-tui"))
    print(row())
    print(row("Run: opensmi --help", DIM))
    print(f"  {GREEN}╰{line}╯{RESET}")
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

    print_summary("v0.3.1", "~/.local/bin")


if __name__ == "__main__":
    main()
