#!/usr/bin/env python3
"""
opensmi update UI demo — progress bar + spinner + summary card
Following opencode's approach: progress bar for downloads, spinner for short ops.
Usage: python3 scripts/demo-installer-ui.py
"""

from __future__ import annotations
import sys
import time
import threading

# ── ANSI / cursor helpers ─────────────────────────────────────────
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


# ── Progress Bar ──────────────────────────────────────────────────
BAR_W = 20   # chars for the ■■･･ bar

def _fmt_bytes(n: int) -> str:
    if n >= 1_048_576: return f"{n/1_048_576:.1f} MB"
    if n >= 1_024:     return f"{n/1_024:.0f} KB"
    return f"{n} B"

def draw_progress(label: str, current: int, total: int) -> None:
    pct  = int(current * 100 / total) if total > 0 else 0
    on   = int(pct * BAR_W / 100)
    off  = BAR_W - on
    bar  = "■" * on + "･" * off
    size = _fmt_bytes(current)
    sys.stdout.write(
        f"\r  {DIM}{label:<36}{RESET}  "
        f"{GREEN}{bar}{RESET}  "
        f"{BOLD}{pct:3d}%{RESET}  "
        f"{DIM}{size}{RESET}"
    )
    sys.stdout.flush()

def simulate_download(label: str, total_bytes: int, duration_s: float) -> None:
    """Demo only — real version hooks into curl -w bytes progress."""
    steps     = 40
    step_s    = duration_s / steps
    step_b    = total_bytes // steps

    cursor_hide()
    try:
        for i in range(steps + 1):
            cur = min(i * step_b, total_bytes)
            draw_progress(label, cur, total_bytes)
            time.sleep(step_s)
        draw_progress(label, total_bytes, total_bytes)
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()
    finally:
        cursor_show()

    print(f"  {GREEN}✓{RESET}  {label}")


# ── Spinner (| / - \) ─────────────────────────────────────────────
class Spinner:
    """Line/Clock spinner for non-download steps."""

    FRAMES   = ["|", "/", "-", "\\"]
    INTERVAL = 0.12

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
    print(f"  {BOLD}Updating opensmi{RESET}  {DIM}(demo){RESET}")
    print()

    with Spinner("Fetching latest release from GitHub..."):
        time.sleep(0.8)

    # Downloads: progress bar
    simulate_download("Downloading opensmi CLI...",          2_621_440,  1.5)
    simulate_download("Downloading opensmi-tui (arm64)...", 15_728_640, 2.0)

    with Spinner("Verifying SHA256 checksums..."):
        time.sleep(0.6)

    with Spinner("Installing to ~/.local/bin..."):
        time.sleep(0.4)

    with Spinner("Updating PATH in ~/.zshrc..."):
        time.sleep(0.3)

    print_summary("v0.3.1", "~/.local/bin")


if __name__ == "__main__":
    main()
