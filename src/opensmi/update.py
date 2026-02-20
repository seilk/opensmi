from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Tuple


@dataclass
class ReleaseInfo:
    tag: str
    tui_url: Optional[str]
    wheel_url: Optional[str]
    pyz_url: Optional[str]
    sha_url: Optional[str]


class UpdateError(RuntimeError):
    pass


def _default_bin_dir() -> Path:
    return Path(os.environ.get("OPENSMI_BIN_DIR") or (Path.home() / ".local" / "bin")).expanduser().resolve()


def _share_dir() -> Path:
    return (Path.home() / ".local" / "share" / "opensmi").expanduser().resolve()


def _os_arch_suffix() -> str:
    os_name = platform.system().lower()
    if os_name.startswith("darwin"):
        os_name = "darwin"
    elif os_name.startswith("linux"):
        os_name = "linux"
    else:
        raise UpdateError(f"Unsupported OS: {platform.system()}")

    arch = platform.machine().lower()
    if arch in {"x86_64", "amd64"}:
        arch = "x64"
    elif arch in {"aarch64", "arm64"}:
        arch = "arm64"
    else:
        raise UpdateError(f"Unsupported architecture: {platform.machine()}")

    return f"{os_name}-{arch}"


def _maybe_auth_headers(url: str) -> Dict[str, str]:
    token = os.environ.get("OPENSMI_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    if token and url.startswith("https://api.github.com/"):
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "opensmi-update",
        }
    return {"User-Agent": "opensmi-update"}


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=_maybe_auth_headers(url))
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        hint = ""
        if e.code == 403:
            hint = " (possible rate limit; set OPENSMI_GITHUB_TOKEN)"
        raise UpdateError(f"GitHub API error {e.code} for {url}{hint}: {body[:200]}") from e
    except urllib.error.URLError as e:
        raise UpdateError(f"Network error for {url}: {e}") from e


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=_maybe_auth_headers(url))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            dest.write_bytes(r.read())
    except urllib.error.HTTPError as e:
        raise UpdateError(f"Download failed ({e.code}) for {url}") from e
    except urllib.error.URLError as e:
        raise UpdateError(f"Network error downloading {url}: {e}") from e


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_sha256sums(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # format: <hex>  <filename>
        parts = line.split()
        if len(parts) < 2:
            continue
        hx = parts[0]
        name = parts[-1]
        if len(hx) == 64:
            out[name] = hx
    return out


def get_release_info(*, repo: str, version: str) -> ReleaseInfo:
    if version == "latest":
        api = f"https://api.github.com/repos/{repo}/releases/latest"
    else:
        tag = version
        if not tag.startswith("v"):
            tag = f"v{tag}"
        api = f"https://api.github.com/repos/{repo}/releases/tags/{tag}"

    data = _fetch_json(api)
    tag_name = str(data.get("tag_name") or "").strip()
    if not tag_name:
        raise UpdateError("Failed to detect tag_name from GitHub API")

    assets = data.get("assets") or []

    suffix = _os_arch_suffix()
    want_tui = f"opensmi-tui-{suffix}"

    tui_url = None
    wheel_url = None
    pyz_url = None
    sha_url = None

    for a in assets:
        name = a.get("name")
        url = a.get("browser_download_url")
        if not name or not url:
            continue
        if name == want_tui:
            tui_url = url
        if name.endswith(".whl") and wheel_url is None:
            wheel_url = url
        if name == "opensmi.pyz":
            pyz_url = url
        if name in {"SHA256SUMS.txt", "SHA256SUMS"}:
            sha_url = url

    return ReleaseInfo(tag=tag_name, tui_url=tui_url, wheel_url=wheel_url, pyz_url=pyz_url, sha_url=sha_url)


def _verify(name: str, file_path: Path, sha_map: Dict[str, str]) -> None:
    expected = sha_map.get(name)
    if not expected:
        return
    actual = _sha256(file_path)
    if actual != expected:
        raise UpdateError(f"Checksum mismatch for {name}: expected {expected}, got {actual}")


def install_tui(*, url: str, bin_dir: Path, sha_map: Dict[str, str], verify: bool) -> None:
    suffix = _os_arch_suffix()
    asset = f"opensmi-tui-{suffix}"

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / asset
        _download(url, tmp)
        if verify:
            _verify(asset, tmp, sha_map)

        tmp.chmod(0o755)
        bin_dir.mkdir(parents=True, exist_ok=True)
        if not os.access(str(bin_dir), os.W_OK):
            raise UpdateError(f"Bin dir not writable: {bin_dir}")

        dest = bin_dir / asset
        shutil.move(str(tmp), str(dest))
        stable = bin_dir / "opensmi-tui"
        if stable.exists() or stable.is_symlink():
            stable.unlink()
        stable.symlink_to(dest)


def _pip_install_wheel(wheel_path: Path) -> None:
    py = sys.executable or "python3"
    # Ensure pip exists
    try:
        subprocess.check_call([py, "-m", "pip", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        raise UpdateError("pip is not available; use --cli-method pyz") from e

    subprocess.check_call([py, "-m", "pip", "install", "--user", "--upgrade", str(wheel_path)])


def install_cli_pyz(*, url: str, bin_dir: Path, sha_map: Dict[str, str], verify: bool) -> None:
    asset = "opensmi.pyz"
    share = _share_dir()
    share.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / asset
        _download(url, tmp)
        if verify:
            _verify(asset, tmp, sha_map)

        dest = share / asset
        shutil.move(str(tmp), str(dest))
        dest.chmod(0o755)

    # Install wrapper
    bin_dir.mkdir(parents=True, exist_ok=True)
    if not os.access(str(bin_dir), os.W_OK):
        raise UpdateError(f"Bin dir not writable: {bin_dir}")

    wrapper = bin_dir / "opensmi"
    wrapper.write_text(
        "#!/bin/sh\n"
        'PYTHON_BIN="${OPENSMI_PYTHON:-python3}"\n'
        'exec "$PYTHON_BIN" "${HOME%/}/.local/share/opensmi/opensmi.pyz" "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)


def install_cli_pip(*, url: str, bin_dir: Path, sha_map: Dict[str, str], verify: bool) -> None:
    asset = os.path.basename(url)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / asset
        _download(url, tmp)
        if verify:
            _verify(asset, tmp, sha_map)

        _pip_install_wheel(tmp)

    # Try to symlink into bin_dir if pip installs scripts elsewhere
    # This is best-effort; users may already have it on PATH.
    py = sys.executable or "python3"
    try:
        scripts_dir = subprocess.check_output(
            [
                py,
                "-c",
                "import sysconfig; print(sysconfig.get_path('scripts', scheme='posix_user'))",
            ],
            text=True,
        ).strip()
        src = Path(scripts_dir) / "opensmi"
        if src.exists() and src.is_file():
            bin_dir.mkdir(parents=True, exist_ok=True)
            dst = bin_dir / "opensmi"
            if dst.exists() or dst.is_symlink():
                dst.unlink()
            dst.symlink_to(src)
    except Exception:
        pass


def update(
    *,
    repo: str,
    version: str = "latest",
    bin_dir: Optional[Path] = None,
    install_tui_flag: bool = True,
    install_cli_flag: bool = True,
    cli_method: str = "auto",  # auto|pip|pyz
    verify: bool = True,
) -> Tuple[str, str]:
    bin_dir = (bin_dir or _default_bin_dir()).expanduser().resolve()

    rel = get_release_info(repo=repo, version=version)

    sha_map: Dict[str, str] = {}
    if verify and rel.sha_url:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "SHA256SUMS.txt"
            _download(rel.sha_url, tmp)
            sha_map = _parse_sha256sums(tmp.read_text(encoding="utf-8", errors="replace"))

    if install_tui_flag:
        if not rel.tui_url:
            raise UpdateError("TUI asset not found for this platform in the release")
        install_tui(url=rel.tui_url, bin_dir=bin_dir, sha_map=sha_map, verify=verify)

    if install_cli_flag:
        method = cli_method
        if method == "auto":
            method = "pyz" if rel.pyz_url else "pip"

        if method == "pyz":
            if not rel.pyz_url:
                raise UpdateError("opensmi.pyz not found in the release")
            install_cli_pyz(url=rel.pyz_url, bin_dir=bin_dir, sha_map=sha_map, verify=verify)
        elif method == "pip":
            if not rel.wheel_url:
                raise UpdateError("wheel (.whl) not found in the release")
            install_cli_pip(url=rel.wheel_url, bin_dir=bin_dir, sha_map=sha_map, verify=verify)
        else:
            raise UpdateError(f"Unknown cli_method: {cli_method}")

    return rel.tag, str(bin_dir)
