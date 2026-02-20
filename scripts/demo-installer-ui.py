#!/usr/bin/env python3
"""
opensmi update UI demo — Line/Clock spinner + summary card
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


# ── Spinner ───────────────────────────────────────────────────────
class Spinner:
    """Line/Clock spinner: | / - \\  in green.

    Follows tw93/Mole pattern:
    - frames redrawn with \\r each tick (same line length → no erase in loop)
    - thread clears the line (\\r\\033[K) right before it exits
    - __exit__ prints final ✓ / ✗ on the now-blank line
    """

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
            # \r redraws over the previous frame (same length every time)
            sys.stdout.write(f"\r  {GREEN}{c}{RESET}  {self.msg}")
            sys.stdout.flush()
            time.sleep(self.INTERVAL)
            i += 1

        # Clear the spinner line so __exit__ can print on a blank line
        sys.stdout.write("\r\033[K")
        sys.stdout.flush()

    def __enter__(self) -> "Spinner":
        self._t.start()
        return self

    def __exit__(self, exc_type, *_) -> None:
        self._stop.set()
        self._t.join()    # wait until thread has cleared the line
        if exc_type:
            print(f"  {RED}✗{RESET}  {self.msg}")
        else:
            print(f"  {GREEN}✓{RESET}  {self.msg}")


# ── Summary Card ──────────────────────────────────────────────────
def print_summary(version: str, bin_dir: str) -> None:
    W    = 44
    line = "─" * W

    def row(text: str = "", style: str = "") -> str:
        padded = text[:W].ljust(W)
        return f"  {GREEN}│{RESET}  {style}{padded}{RESET}{GREEN}│{RESET}"

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

    steps = [
        ("Fetching latest release from GitHub...", 1.2),
        ("Downloading opensmi-tui (darwin-arm64)...", 1.8),
        ("Verifying SHA256 checksums...", 0.8),
        ("Installing to ~/.local/bin...", 0.6),
        ("Updating PATH in ~/.zshrc...", 0.4),
    ]

    for msg, duration in steps:
        with Spinner(msg):
            time.sleep(duration)

    print_summary("v0.3.1", "~/.local/bin")


if __name__ == "__main__":
    main()
