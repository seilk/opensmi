from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

ENV_STATE_DIR = "MICVGPUS_STATE_DIR"
DEFAULT_STATE_DIRNAME = ".micvgpus"


def get_state_dir(state_dir: Optional[str] = None) -> Path:
    """Return the state dir.

    Default is ~/.micvgpus (intended to live on NFS home on the cluster).
    Override priority:
      1) CLI flag --state-dir
      2) env MICVGPUS_STATE_DIR
      3) ~/.micvgpus
    """
    if state_dir:
        return Path(state_dir).expanduser().resolve()

    env = os.environ.get(ENV_STATE_DIR)
    if env:
        return Path(env).expanduser().resolve()

    return (Path.home() / DEFAULT_STATE_DIRNAME).resolve()


def ensure_state_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def config_path(state_dir: Path) -> Path:
    return state_dir / "config.json"


def latest_snapshot_path(state_dir: Path) -> Path:
    return state_dir / "latest_snapshot.json"
