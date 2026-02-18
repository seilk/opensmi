"""opensmi logging — unified file logging for CLI and TUI.

Log location: ~/.opensmi/logs/
  - cli.log      — Python CLI operations
  - tui.log      — TUI operations (written by Bun/TS)

Env overrides:
  OPENSMI_LOG_LEVEL=DEBUG|INFO|WARNING|ERROR  (default: INFO)
  OPENSMI_LOG_DIR=/path/to/logs               (default: <state_dir>/logs)

Usage (Python CLI):
    from opensmi.logging import get_logger
    log = get_logger("cli")
    log.info("polling cluster")
    log.debug("raw snapshot: %s", data)
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

from .state import get_state_dir

_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB per file
_BACKUP_COUNT = 3

_initialized = False


def log_dir(state_dir: Optional[Path] = None) -> Path:
    """Return the log directory, creating it if needed."""
    env = os.environ.get("OPENSMI_LOG_DIR")
    if env:
        d = Path(env).expanduser().resolve()
    else:
        d = (state_dir or get_state_dir()) / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _log_level() -> int:
    raw = os.environ.get("OPENSMI_LOG_LEVEL", "INFO").upper()
    return getattr(logging, raw, logging.INFO)


def _setup_root() -> None:
    global _initialized
    if _initialized:
        return
    _initialized = True

    from logging.handlers import RotatingFileHandler

    root = logging.getLogger("opensmi")
    root.setLevel(logging.DEBUG)  # handlers filter by level
    root.propagate = False

    # File handler — rotates at 5 MB, keeps 3 backups
    fh = RotatingFileHandler(
        str(log_dir() / "cli.log"),
        maxBytes=_MAX_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    fh.setLevel(_log_level())
    fh.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FORMAT))
    root.addHandler(fh)

    # Also log to stderr if DEBUG
    if _log_level() <= logging.DEBUG:
        sh = logging.StreamHandler()
        sh.setLevel(logging.DEBUG)
        sh.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATE_FORMAT))
        root.addHandler(sh)


def get_logger(name: str = "cli") -> logging.Logger:
    """Get a named logger under the opensmi namespace."""
    _setup_root()
    return logging.getLogger(f"opensmi.{name}")
