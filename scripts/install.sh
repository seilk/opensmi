#!/usr/bin/env bash
set -euo pipefail

# opensmi installer
# - Installs Python CLI (wheel) + TUI binary from GitHub Releases
# - Places binaries in a common bin directory and creates a stable symlink
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install.sh | bash
#   bash scripts/install.sh --version v0.1.0
#
# Options:
#   --repo OWNER/REPO        (default: seil/opensmi)
#   --version TAG|latest     (default: latest)
#   --bin-dir PATH           (default: ~/.local/bin)
#   --tui-only               install only TUI binary
#   --cli-only               install only Python CLI
#   --no-verify              skip SHA256SUMS verification

REPO_DEFAULT="seil/opensmi"
REPO="${OPENSMI_REPO:-$REPO_DEFAULT}"
VERSION="${OPENSMI_VERSION:-latest}"
BIN_DIR="${OPENSMI_BIN_DIR:-}"
INSTALL_TUI=1
INSTALL_CLI=1
VERIFY=1

PYTHON="${OPENSMI_PYTHON:-python3}"

usage() {
  cat <<EOF
opensmi installer

Usage:
  $0 [options]

Options:
  --repo OWNER/REPO        GitHub repo (default: ${REPO_DEFAULT})
  --version TAG|latest     Release tag (e.g. v0.1.0) or "latest" (default: latest)
  --bin-dir PATH           Install directory for binaries (default: ~/.local/bin)
  --tui-only               Install only opensmi-tui
  --cli-only               Install only opensmi (Python CLI)
  --no-verify              Skip SHA256SUMS verification
  -h, --help               Show help

Env:
  OPENSMI_REPO, OPENSMI_VERSION, OPENSMI_BIN_DIR, OPENSMI_PYTHON
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"; shift 2 ;;
    --version)
      VERSION="$2"; shift 2 ;;
    --bin-dir)
      BIN_DIR="$2"; shift 2 ;;
    --tui-only)
      INSTALL_CLI=0; shift ;;
    --cli-only)
      INSTALL_TUI=0; shift ;;
    --no-verify)
      VERIFY=0; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "python not found: $PYTHON" >&2
  exit 2
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: ${ARCH_RAW}" >&2
    exit 2
    ;;
 esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "Unsupported OS: ${OS}" >&2
    exit 2
    ;;
esac

SUFFIX="${OS}-${ARCH}"
TUI_ASSET="opensmi-tui-${SUFFIX}"

PY_USER_BIN="$($PYTHON - <<'PY'
import sysconfig
print(sysconfig.get_path("scripts", scheme="posix_user"))
PY
)"

if [[ -z "$BIN_DIR" ]]; then
  # Common user-writable bin dir used by many OSS installers
  BIN_DIR="$HOME/.local/bin"
fi

mkdir -p "$BIN_DIR"

# downloader
fetch() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$out" "$url"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
    return 0
  fi
  echo "Need curl or wget" >&2
  return 2
}

# sha256 helper (mac uses shasum)
sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  return 2
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fetch release JSON
if [[ "$VERSION" == "latest" ]]; then
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
else
  TAG="$VERSION"
  [[ "$TAG" == v* ]] || TAG="v${TAG}"
  API_URL="https://api.github.com/repos/${REPO}/releases/tags/${TAG}"
fi

echo "Repo:    ${REPO}"
echo "Version: ${VERSION}"
echo "OS/Arch: ${OS}/${ARCH}"
echo "Bin dir: ${BIN_DIR}"

fetch "$API_URL" "$TMP/release.json"

# Parse assets via Python (no jq)
mapfile -t _RELINFO < <(
  "$PYTHON" - "$OS" "$ARCH" < "$TMP/release.json" <<'PY'
import json, sys
os = sys.argv[1]
arch = sys.argv[2]

data = json.load(sys.stdin)
tag = data.get("tag_name", "")
assets = [(a.get("name"), a.get("browser_download_url")) for a in data.get("assets", [])]

want_tui = f"opensmi-tui-{os}-{arch}"

tui_url = ""
wheel_url = ""
sha_url = ""

for name, url in assets:
    if name == want_tui:
        tui_url = url
    if name and name.endswith(".whl") and not wheel_url:
        wheel_url = url
    if name in ("SHA256SUMS.txt", "SHA256SUMS"):
        sha_url = url

print(tag)
print(tui_url)
print(wheel_url)
print(sha_url)
PY
)

TAG_NAME="${_RELINFO[0]:-}"
TUI_URL="${_RELINFO[1]:-}"
WHEEL_URL="${_RELINFO[2]:-}"
SHA_URL="${_RELINFO[3]:-}"

if [[ -z "$TAG_NAME" ]]; then
  echo "Failed to detect release tag_name (bad API response?)" >&2
  exit 2
fi

if [[ $INSTALL_TUI -eq 1 && -z "$TUI_URL" ]]; then
  echo "TUI asset not found in release: ${TUI_ASSET}" >&2
  echo "Hint: ensure the Release workflow built/attached it." >&2
  exit 2
fi

if [[ $INSTALL_CLI -eq 1 && -z "$WHEEL_URL" ]]; then
  echo "Python wheel asset not found in release." >&2
  echo "Hint: ensure the Release workflow built/attached it." >&2
  exit 2
fi

# Optional: download checksums
if [[ $VERIFY -eq 1 ]]; then
  if [[ -z "$SHA_URL" ]]; then
    echo "WARN: SHA256SUMS not found; skipping verification." >&2
    VERIFY=0
  else
    fetch "$SHA_URL" "$TMP/SHA256SUMS.txt"
  fi
fi

verify_one() {
  local name="$1"
  local file="$2"

  if [[ $VERIFY -ne 1 ]]; then
    return 0
  fi

  local expected
  expected=$(grep -E "[[:xdigit:]]{64}  ${name}$" "$TMP/SHA256SUMS.txt" | head -n 1 | awk '{print $1}')
  if [[ -z "$expected" ]]; then
    echo "WARN: no checksum entry for ${name}; skipping." >&2
    return 0
  fi

  local actual
  actual=$(sha256_file "$file" || true)
  if [[ -z "$actual" ]]; then
    echo "WARN: sha256 tool not found; skipping verification." >&2
    return 0
  fi

  if [[ "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for ${name}" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 2
  fi
}

# Install TUI
if [[ $INSTALL_TUI -eq 1 ]]; then
  echo "\n== Installing opensmi-tui =="
  fetch "$TUI_URL" "$TMP/${TUI_ASSET}"
  chmod +x "$TMP/${TUI_ASSET}"
  verify_one "$TUI_ASSET" "$TMP/${TUI_ASSET}"

  mv "$TMP/${TUI_ASSET}" "$BIN_DIR/${TUI_ASSET}"
  ln -sf "$BIN_DIR/${TUI_ASSET}" "$BIN_DIR/opensmi-tui"

  echo "Installed: $BIN_DIR/${TUI_ASSET}"
  echo "Symlink:   $BIN_DIR/opensmi-tui"
fi

# Install CLI
if [[ $INSTALL_CLI -eq 1 ]]; then
  echo "\n== Installing opensmi (Python CLI) =="
  echo "Using: $PYTHON -m pip install --user"
  "$PYTHON" -m pip install -U pip >/dev/null 2>&1 || true

  WHEEL_ASSET="$(basename "$WHEEL_URL")"
  fetch "$WHEEL_URL" "$TMP/$WHEEL_ASSET"
  verify_one "$WHEEL_ASSET" "$TMP/$WHEEL_ASSET"

  "$PYTHON" -m pip install --user --upgrade "$TMP/$WHEEL_ASSET"
  echo "Installed Python package from: $WHEEL_ASSET"

  # Ensure the opensmi entrypoint is reachable from BIN_DIR
  if [[ -x "$PY_USER_BIN/opensmi" && "$PY_USER_BIN" != "$BIN_DIR" ]]; then
    ln -sf "$PY_USER_BIN/opensmi" "$BIN_DIR/opensmi" || true
    echo "Symlink:   $BIN_DIR/opensmi"
  fi
fi

# PATH hint
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "\nNOTE: '$BIN_DIR' is not in your PATH." >&2
  echo "Add this to your shell profile (~/.bashrc, ~/.zshrc):" >&2
  echo "  export PATH=\"$BIN_DIR:\$PATH\"" >&2
fi

echo "\n✅ opensmi installation complete."
echo "Next:" 
echo "  opensmi init --wizard" 
echo "  opensmi poll" 
echo "  opensmi-tui" 
