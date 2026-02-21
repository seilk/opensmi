from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

ENV_STATE_DIR = "OPENSMI_STATE_DIR"
ENV_CONFIG_PATH = "OPENSMI_CONFIG"
DEFAULT_STATE_DIRNAME = ".opensmi"
DEFAULT_CONFIG_NAME = "opensmi.json"


def get_state_dir(state_dir: Optional[str] = None) -> Path:
    """Return the state dir.

    Default is ~/.opensmi (intended to live on NFS home on the cluster).
    Override priority:
      1) CLI flag --state-dir
      2) env OPENSMI_STATE_DIR
      3) ~/.opensmi
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
    return state_dir / DEFAULT_CONFIG_NAME


def find_repo_root(start: Optional[Path] = None) -> Optional[Path]:
    """Find opensmi repo root (pyproject.toml + src/opensmi/).

    This is best-effort and only intended for dev/checkouts.
    """
    start = (start or Path.cwd()).expanduser().resolve()
    for p in (start, *start.parents):
        if (p / "pyproject.toml").exists() and (p / "src" / "opensmi").is_dir():
            return p
    return None


def resolve_config_path(*, state_dir: Path, cli_config: Optional[str] = None) -> Path:
    """Resolve config path.

    Priority:
      1) CLI flag --config
      2) env OPENSMI_CONFIG
      3) <state_dir>/opensmi.json
    """
    if cli_config:
        return Path(cli_config).expanduser().resolve()

    env = os.environ.get(ENV_CONFIG_PATH)
    if env:
        return Path(env).expanduser().resolve()

    return config_path(state_dir)


def latest_snapshot_path(state_dir: Path) -> Path:
    return state_dir / "latest_snapshot.json"
