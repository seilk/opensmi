from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional


ALLOCS_VERSION = 1


_KST = timezone(timedelta(hours=9))


def _now_iso() -> str:
    return datetime.now(_KST).isoformat(timespec="seconds")


@dataclass
class Allocation:
    node_alias: str
    gpu_index: int
    target: str  # linux username OR special token (e.g. "*")
    assigned_by: str
    assigned_at: str
    gpu_uuid: Optional[str] = None
    expires_at: Optional[str] = None
    notes: str = ""


def allocations_path(state_dir: Path) -> Path:
    return state_dir / "allocations.json"


def _default_allocs_doc() -> Dict[str, object]:
    return {
        "version": ALLOCS_VERSION,
        "updated_at": _now_iso(),
        "allocations": [],
    }


@contextmanager
def _locked(path: Path):
    """Best-effort advisory lock for NFS/local.

    On some NFS setups flock may be unreliable; we still do atomic replace on write.
    """
    try:
        import fcntl  # type: ignore

        path.parent.mkdir(parents=True, exist_ok=True)
        with open(str(path) + ".lock", "a+") as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            yield
    except Exception:
        # Fallback: no lock
        yield


def _normalize_target(raw: str) -> str:
    t = str(raw).strip()
    if not t:
        return "*"
    if t.lower() == "none":
        return "*"
    return t


def load_allocations(state_dir: Path) -> List[Allocation]:
    path = allocations_path(state_dir)
    if not path.exists():
        return []

    data = json.loads(path.read_text(encoding="utf-8"))
    allocs = []
    for raw in data.get("allocations", []):
        allocs.append(
            Allocation(
                node_alias=str(raw["node_alias"]),
                gpu_index=int(raw["gpu_index"]),
                target=_normalize_target(str(raw.get("target", "*"))),
                assigned_by=str(raw.get("assigned_by", "unknown")),
                assigned_at=str(raw.get("assigned_at", "")),
                gpu_uuid=raw.get("gpu_uuid"),
                expires_at=raw.get("expires_at"),
                notes=str(raw.get("notes", "")),
            )
        )
    return allocs


def save_allocations(state_dir: Path, allocs: List[Allocation]) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    path = allocations_path(state_dir)

    payload_allocs = []
    for a in allocs:
        d = asdict(a)
        d["target"] = _normalize_target(str(d.get("target", "*")))
        payload_allocs.append(d)

    doc: Dict[str, object] = {
        "version": ALLOCS_VERSION,
        "updated_at": _now_iso(),
        "allocations": payload_allocs,
    }

    payload = json.dumps(doc, indent=2, sort_keys=False) + "\n"

    with _locked(path):
        # atomic write
        fd, tmp_path = tempfile.mkstemp(prefix=path.name + ".", dir=str(state_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            except Exception:
                pass


def upsert_allocation(allocs: List[Allocation], new_alloc: Allocation) -> List[Allocation]:
    out: List[Allocation] = []
    replaced = False
    for a in allocs:
        if a.node_alias == new_alloc.node_alias and int(a.gpu_index) == int(new_alloc.gpu_index):
            out.append(new_alloc)
            replaced = True
        else:
            out.append(a)
    if not replaced:
        out.append(new_alloc)
    return out


def remove_allocation(allocs: List[Allocation], *, node_alias: str, gpu_index: int) -> List[Allocation]:
    return [a for a in allocs if not (a.node_alias == node_alias and int(a.gpu_index) == int(gpu_index))]
