from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_pyproject_version() -> str:
    txt = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r"^version\s*=\s*\"([^\"]+)\"\s*$", txt, re.MULTILINE)
    if not m:
        raise SystemExit("Could not find version in pyproject.toml")
    return m.group(1)


def read_init_version() -> str:
    txt = (ROOT / "opensmi" / "__init__.py").read_text(encoding="utf-8")
    m = re.search(r"^__version__\s*=\s*\"([^\"]+)\"\s*$", txt, re.MULTILINE)
    if not m:
        raise SystemExit("Could not find __version__ in opensmi/__init__.py")
    return m.group(1)


def main() -> None:
    a = read_pyproject_version()
    b = read_init_version()
    if a != b:
        raise SystemExit(f"Version mismatch: pyproject={a} __init__={b}")


if __name__ == "__main__":
    main()
