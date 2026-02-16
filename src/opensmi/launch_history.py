"""Launch history tracking for GPU usage timestamps."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

from opensmi.state import ensure_state_dir, get_state_dir

LAUNCH_HISTORY_FILENAME = "launch_history.json"


def launch_history_path(state_dir: Path) -> Path:
    return state_dir / LAUNCH_HISTORY_FILENAME


def load_history(state_dir: Path) -> Dict[str, Dict[int, str]]:
    """Load launch history from disk.

    Returns:
        Dict of {node_alias: {gpu_index: iso_timestamp}}
    """
    path = launch_history_path(state_dir)
    if not path.exists():
        return {}

    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)

        result: Dict[str, Dict[int, str]] = {}
        for node_alias, gpu_dict in data.items():
            result[node_alias] = {int(k): v for k, v in gpu_dict.items()}
        return result
    except (json.JSONDecodeError, ValueError, OSError):
        return {}


def save_history(state_dir: Path, history: Dict[str, Dict[int, str]]) -> None:
    """Save launch history to disk."""
    ensure_state_dir(state_dir)
    path = launch_history_path(state_dir)

    serializable = {
        node_alias: {str(gpu_idx): timestamp for gpu_idx, timestamp in gpu_dict.items()}
        for node_alias, gpu_dict in history.items()
    }

    with path.open("w", encoding="utf-8") as f:
        json.dump(serializable, f, indent=2)


def update_history(
    state_dir: Path,
    launched_gpus: List[Tuple[str, int]],
) -> None:
    """Update launch history with current timestamp for given GPUs.

    Args:
        state_dir: State directory
        launched_gpus: List of (node_alias, gpu_index) tuples
    """
    history = load_history(state_dir)
    now = datetime.now(timezone.utc).isoformat()

    for node_alias, gpu_index in launched_gpus:
        if node_alias not in history:
            history[node_alias] = {}
        history[node_alias][gpu_index] = now

    save_history(state_dir, history)
