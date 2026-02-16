import json
from pathlib import Path

from opensmi.launch_history import (
    launch_history_path,
    load_history,
    save_history,
    update_history,
)


def test_launch_history_path(tmp_path: Path):
    path = launch_history_path(tmp_path)
    assert path == tmp_path / "launch_history.json"


def test_load_history_missing_file(tmp_path: Path):
    history = load_history(tmp_path)
    assert history == {}


def test_load_history_invalid_json(tmp_path: Path):
    path = launch_history_path(tmp_path)
    path.write_text("invalid json")

    history = load_history(tmp_path)
    assert history == {}


def test_save_and_load_history(tmp_path: Path):
    data = {
        "node1": {0: "2025-01-01T00:00:00Z", 1: "2025-01-01T01:00:00Z"},
        "node2": {0: "2025-01-02T00:00:00Z"},
    }

    save_history(tmp_path, data)
    loaded = load_history(tmp_path)

    assert loaded == data


def test_save_history_creates_dir(tmp_path: Path):
    nested = tmp_path / "nested" / "dir"
    data = {"node1": {0: "2025-01-01T00:00:00Z"}}

    save_history(nested, data)

    assert nested.exists()
    assert (nested / "launch_history.json").exists()


def test_save_history_serializes_keys_as_strings(tmp_path: Path):
    data = {"node1": {0: "2025-01-01T00:00:00Z", 1: "2025-01-01T01:00:00Z"}}

    save_history(tmp_path, data)

    path = launch_history_path(tmp_path)
    raw = json.loads(path.read_text())

    assert raw == {"node1": {"0": "2025-01-01T00:00:00Z", "1": "2025-01-01T01:00:00Z"}}


def test_update_history_new_gpus(tmp_path: Path):
    initial = {"node1": {0: "2025-01-01T00:00:00Z"}}
    save_history(tmp_path, initial)

    update_history(tmp_path, [("node1", 1), ("node2", 0)])

    loaded = load_history(tmp_path)

    assert "node1" in loaded
    assert 0 in loaded["node1"]
    assert 1 in loaded["node1"]
    assert "node2" in loaded
    assert 0 in loaded["node2"]


def test_update_history_overwrites_timestamps(tmp_path: Path):
    initial = {"node1": {0: "2025-01-01T00:00:00Z"}}
    save_history(tmp_path, initial)

    update_history(tmp_path, [("node1", 0)])

    loaded = load_history(tmp_path)

    assert loaded["node1"][0] != "2025-01-01T00:00:00Z"


def test_update_history_creates_file_if_missing(tmp_path: Path):
    update_history(tmp_path, [("node1", 0)])

    loaded = load_history(tmp_path)

    assert "node1" in loaded
    assert 0 in loaded["node1"]
