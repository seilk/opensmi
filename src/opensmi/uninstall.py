from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


class UninstallError(RuntimeError):
    pass


def _default_bin_dir() -> Path:
    return Path(os.environ.get("OPENSMI_BIN_DIR") or (Path.home() / ".local" / "bin")).expanduser().resolve()


def _share_dir() -> Path:
    return (Path.home() / ".local" / "share" / "opensmi").expanduser().resolve()


def _state_dir(state_dir: Optional[str] = None) -> Path:
    # Keep this logic minimal to avoid circular imports.
    if state_dir:
        return Path(state_dir).expanduser().resolve()
    env = os.environ.get("OPENSMI_STATE_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".opensmi").expanduser().resolve()


def _os_arch_suffix() -> str:
    os_name = platform.system().lower()
    if os_name.startswith("darwin"):
        os_name = "darwin"
    elif os_name.startswith("linux"):
        os_name = "linux"
    else:
        os_name = platform.system().lower()

    arch = platform.machine().lower()
    if arch in {"x86_64", "amd64"}:
        arch = "x64"
    elif arch in {"aarch64", "arm64"}:
        arch = "arm64"

    return f"{os_name}-{arch}"


@dataclass
class UninstallPlan:
    bin_dir: Path
    remove_paths: List[Path]
    purge_state_dir: Optional[Path]


def _is_our_opensmi_wrapper(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        data = path.read_text("utf-8", errors="ignore")[:2048]
        # Wrapper content used by installer (pyz).
        return "opensmi.pyz" in data and "local/share/opensmi" in data
    except Exception:
        return False


def _collect_tui_paths(bin_dir: Path) -> List[Path]:
    # Always remove stable symlink if present.
    out: List[Path] = []
    stable = bin_dir / "opensmi-tui"
    if stable.exists() or stable.is_symlink():
        out.append(stable)

    # Remove any versioned binaries in the same prefix.
    for p in sorted(bin_dir.glob("opensmi-tui-*")):
        if p.is_file() or p.is_symlink():
            out.append(p)

    return out


def _collect_cli_paths(bin_dir: Path) -> List[Path]:
    out: List[Path] = []
    exe = bin_dir / "opensmi"
    if exe.exists() or exe.is_symlink():
        out.append(exe)

    # pyz in share dir
    pyz = _share_dir() / "opensmi.pyz"
    if pyz.exists() or pyz.is_symlink():
        out.append(pyz)

    # Optional: if share dir becomes empty, we can remove it at the end.
    share = _share_dir()
    if share.exists() and share.is_dir():
        out.append(share)

    return out


def plan_uninstall(
    *,
    bin_dir: Optional[Path] = None,
    uninstall_tui: bool = True,
    uninstall_cli: bool = True,
    purge_state: bool = False,
    state_dir: Optional[str] = None,
    force: bool = False,
) -> UninstallPlan:
    b = (bin_dir or _default_bin_dir()).expanduser().resolve()
    paths: List[Path] = []

    if uninstall_tui:
        paths.extend(_collect_tui_paths(b))

    if uninstall_cli:
        paths.extend(_collect_cli_paths(b))

    # Deduplicate while preserving order.
    seen = set()
    uniq: List[Path] = []
    for p in paths:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)

    # Safety: only remove the opensmi executable if it's our wrapper, unless forced.
    if uninstall_cli:
        exe = b / "opensmi"
        if (exe in uniq) and exe.exists() and not force:
            if not _is_our_opensmi_wrapper(exe):
                # Skip removing to avoid deleting a pip/conda-provided opensmi.
                uniq = [p for p in uniq if p != exe]

    purge_path = _state_dir(state_dir) if purge_state else None

    return UninstallPlan(bin_dir=b, remove_paths=uniq, purge_state_dir=purge_path)


def _remove_one(p: Path) -> Tuple[bool, str]:
    try:
        if p.is_symlink() or p.is_file():
            p.unlink(missing_ok=True)  # py>=3.8
            return True, "removed"
        if p.is_dir():
            shutil.rmtree(p)
            return True, "removed"
        return False, "not found"
    except Exception as e:
        return False, f"failed: {e}"


def run_uninstall(
    *,
    bin_dir: Optional[Path] = None,
    uninstall_tui: bool = True,
    uninstall_cli: bool = True,
    purge_state: bool = False,
    state_dir: Optional[str] = None,
    yes: bool = False,
    force: bool = False,
    dry_run: bool = False,
) -> str:
    plan = plan_uninstall(
        bin_dir=bin_dir,
        uninstall_tui=uninstall_tui,
        uninstall_cli=uninstall_cli,
        purge_state=purge_state,
        state_dir=state_dir,
        force=force,
    )

    lines: List[str] = []
    suffix = _os_arch_suffix()

    lines.append(f"Bin dir: {plan.bin_dir}")
    if uninstall_tui:
        lines.append(f"TUI:     opensmi-tui-{suffix} (and symlink opensmi-tui)")
    if uninstall_cli:
        lines.append("CLI:     opensmi (wrapper) and opensmi.pyz")
    if purge_state:
        lines.append(f"State:   {plan.purge_state_dir} (purge)")

    if dry_run:
        lines.append("")
        lines.append("Dry run — would remove:")
        for p in plan.remove_paths:
            lines.append(f"  - {p}")
        if plan.purge_state_dir is not None:
            lines.append(f"  - {plan.purge_state_dir}")
        return "\n".join(lines)

    # Execute removals
    removed_any = False
    lines.append("")

    for p in plan.remove_paths:
        ok, msg = _remove_one(p)
        if ok:
            removed_any = True
            lines.append(f"✓ {p} ({msg})")

    # Purge state
    if plan.purge_state_dir is not None:
        if not yes:
            raise UninstallError("Refusing to purge state without --yes")
        ok, msg = _remove_one(plan.purge_state_dir)
        if ok:
            removed_any = True
            lines.append(f"✓ {plan.purge_state_dir} ({msg})")

    if not removed_any:
        lines.append("(nothing to remove)")

    return "\n".join(lines)
