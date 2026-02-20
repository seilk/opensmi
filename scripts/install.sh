#!/usr/bin/env bash
set -euo pipefail

# S3: guard against `sh install.sh` misuse
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: opensmi installer requires bash. Re-run with:" >&2
  echo "  bash <(curl -fsSL https://raw.githubusercontent.com/seilk/opensmi/main/scripts/install.sh)" >&2
  exit 1
fi

# opensmi installer
# - Installs Python CLI (wheel) + TUI binary from GitHub Releases
# - Places binaries in a common bin directory and creates a stable symlink
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install.sh | bash
#   bash scripts/install.sh --version v0.1.0
#
# Options:
#   --repo OWNER/REPO        (default: seilk/opensmi)
#   --version TAG|latest     (default: latest)
#   --bin-dir PATH           (default: ~/.local/bin)
#   --tui-only               install only TUI binary
#   --cli-only               install only Python CLI
#   --no-verify              skip SHA256SUMS verification

REPO_DEFAULT="seilk/opensmi"
REPO="${OPENSMI_REPO:-$REPO_DEFAULT}"
VERSION="${OPENSMI_VERSION:-latest}"
BIN_DIR="${OPENSMI_BIN_DIR:-}"
INSTALL_TUI=1
INSTALL_CLI=1
VERIFY=1
CLI_METHOD="auto"  # auto|pip|pyz

PYTHON="${OPENSMI_PYTHON:-python3}"
TOKEN="${OPENSMI_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"

# ── logging helpers ───────────────────────────────────────────────
IS_TTY=0
if [[ -t 1 ]]; then IS_TTY=1; fi

C_RESET=""
C_BLUE=""
C_GREEN=""
C_YELLOW=""
C_RED=""

if [[ $IS_TTY -eq 1 ]]; then
  C_RESET=$'\033[0m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
fi

say()  { printf '%s\n' "$*"; }
info() { say "${C_BLUE}==>${C_RESET} $*"; }
ok()   { say "${C_GREEN}✓${C_RESET} $*"; }
warn() { say "${C_YELLOW}warning:${C_RESET} $*" >&2; }
die()  { say "${C_RED}error:${C_RESET} $*" >&2; exit 2; }

# S1: detect shell and return the appropriate profile file path
detect_shell_profile() {
  local shell_bin
  shell_bin="$(basename "${SHELL:-}")"
  case "$shell_bin" in
    zsh)  echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

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
  --cli-method auto|pip|pyz Choose CLI install method (default: auto)
  --no-verify              Skip SHA256SUMS verification
  -h, --help               Show help

Env:
  OPENSMI_REPO, OPENSMI_VERSION, OPENSMI_BIN_DIR, OPENSMI_PYTHON, OPENSMI_GITHUB_TOKEN
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
    --cli-method)
      CLI_METHOD="$2"; shift 2 ;;
    --no-verify)
      VERIFY=0; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      warn "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

info "opensmi installer"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  die "python not found: $PYTHON (set OPENSMI_PYTHON, e.g. python3.11)"
fi

# Require Python 3.8+ (CLI is stdlib-only but uses modern Python features).
py_version() {
  local bin="$1"
  "$bin" - <<'PY'
import sys
print(f"{sys.version_info[0]}.{sys.version_info[1]}.{sys.version_info[2]}")
PY
}

py_is_38plus() {
  local bin="$1"
  "$bin" - <<'PY'
import sys
sys.exit(0 if sys.version_info >= (3,8) else 1)
PY
}

PY_VER="$(py_version "$PYTHON")"
if ! py_is_38plus "$PYTHON"; then
  # Try common alternative python names automatically.
  for cand in python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$cand" >/dev/null 2>&1; then
      if py_is_38plus "$cand"; then
        warn "${PYTHON} is ${PY_VER}; using ${cand} ($(py_version "$cand")) instead."
        PYTHON="$cand"
        PY_VER="$(py_version "$PYTHON")"
        break
      fi
    fi
  done
fi

if ! py_is_38plus "$PYTHON"; then
  die "opensmi requires Python 3.8+ (detected: ${PYTHON} ${PY_VER}). Install a newer Python or set OPENSMI_PYTHON (e.g. python3.11)."
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    die "Unsupported architecture: ${ARCH_RAW}"
    ;;
 esac

case "$OS" in
  linux|darwin) ;;
  *)
    die "Unsupported OS: ${OS}"
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
  BIN_DIR="${HOME%/}/.local/bin"
fi

mkdir -p "$BIN_DIR"

if [[ ! -w "$BIN_DIR" ]]; then
  die "Bin dir is not writable: $BIN_DIR (use --bin-dir ${HOME%/}/.local/bin)"
fi

# downloader
fetch() {
  local url="$1"
  local out="$2"

  if command -v curl >/dev/null 2>&1; then
    local args=(-fsSL --retry 3 --retry-delay 1 -o "$out")
    # Optional token to avoid GitHub API rate limiting.
    if [[ -n "${TOKEN}" && "$url" == https://api.github.com/* ]]; then
      args+=(-H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json")
    fi
    curl "${args[@]}" "$url"
    return 0
  fi

  if command -v wget >/dev/null 2>&1; then
    local args=(-qO "$out")
    if [[ -n "${TOKEN}" && "$url" == https://api.github.com/* ]]; then
      args+=(--header="Authorization: Bearer ${TOKEN}" --header="Accept: application/vnd.github+json")
    fi
    wget "${args[@]}" "$url"
    return 0
  fi

  die "Need curl or wget"
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

info "Target:  ${REPO} (${VERSION})"
info "System:  ${OS}/${ARCH}"
info "Python:  ${PYTHON} (${PY_VER})"
info "Prefix:  ${BIN_DIR}"

fetch "$API_URL" "$TMP/release.json"

# Basic sanity check: empty or non-JSON responses happen on some networks/proxies.
if [[ ! -s "$TMP/release.json" ]]; then
  die "Failed to fetch GitHub release metadata (empty response). URL: $API_URL"
fi

# Parse assets via Python (no jq). Keep this robust: fail with a helpful error.
_RELINFO_STR="$(
  # NOTE: We pass the JSON file path as an argv because stdin is used for the Python program via heredoc.
  "$PYTHON" - "$OS" "$ARCH" "$TMP/release.json" <<'PY'
import json, sys
os = sys.argv[1]
arch = sys.argv[2]
path = sys.argv[3]

with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

tag = data.get("tag_name", "")
assets = [(a.get("name"), a.get("browser_download_url")) for a in data.get("assets", [])]

want_tui = f"opensmi-tui-{os}-{arch}"

tui_url = ""
wheel_url = ""
pyz_url = ""
sha_url = ""

for name, url in assets:
    if name == want_tui:
        tui_url = url
    if name and name.endswith(".whl") and not wheel_url:
        wheel_url = url
    if name == "opensmi.pyz":
        pyz_url = url
    if name in ("SHA256SUMS.txt", "SHA256SUMS"):
        sha_url = url

print(tag)
print(tui_url)
print(wheel_url)
print(pyz_url)
print(sha_url)
PY
)" || {
  warn "Failed to parse GitHub release metadata (not valid JSON?)."
  warn "URL: $API_URL"
  warn "First bytes: $(head -c 200 "$TMP/release.json" | tr '\n' ' ' 2>/dev/null || true)"
  die "Try setting OPENSMI_GITHUB_TOKEN to avoid API rate limits."
}

TAG_NAME="$(printf '%s\n' "$_RELINFO_STR" | sed -n '1p')"
TUI_URL="$(printf '%s\n' "$_RELINFO_STR" | sed -n '2p')"
WHEEL_URL="$(printf '%s\n' "$_RELINFO_STR" | sed -n '3p')"
PYZ_URL="$(printf '%s\n' "$_RELINFO_STR" | sed -n '4p')"
SHA_URL="$(printf '%s\n' "$_RELINFO_STR" | sed -n '5p')"

if [[ -z "$TAG_NAME" ]]; then
  die "Failed to detect release tag_name (bad API response?)"
fi

info "Release:  ${TAG_NAME}"

if [[ $INSTALL_TUI -eq 1 && -z "$TUI_URL" ]]; then
  die "TUI asset not found in release: ${TUI_ASSET}"
fi

if [[ $INSTALL_CLI -eq 1 ]]; then
  if [[ "$CLI_METHOD" == "pip" && -z "$WHEEL_URL" ]]; then
    die "Python wheel asset not found in release."
  fi
  if [[ "$CLI_METHOD" == "pyz" && -z "$PYZ_URL" ]]; then
    die "opensmi.pyz asset not found in release."
  fi
  if [[ "$CLI_METHOD" == "auto" && -z "$WHEEL_URL" && -z "$PYZ_URL" ]]; then
    die "No CLI asset found in release (wheel or opensmi.pyz)."
  fi
fi

# Optional: download checksums
if [[ $VERIFY -eq 1 ]]; then
  if [[ -z "$SHA_URL" ]]; then
    warn "SHA256SUMS not found; skipping verification."
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
    warn "no checksum entry for ${name}; skipping."
    return 0
  fi

  local actual
  actual=$(sha256_file "$file" || true)
  if [[ -z "$actual" ]]; then
    warn "sha256 tool not found; skipping verification."
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
  info "Installing TUI"
  fetch "$TUI_URL" "$TMP/${TUI_ASSET}"
  chmod +x "$TMP/${TUI_ASSET}"
  verify_one "$TUI_ASSET" "$TMP/${TUI_ASSET}"

  mv "$TMP/${TUI_ASSET}" "$BIN_DIR/${TUI_ASSET}"
  ln -sf "$BIN_DIR/${TUI_ASSET}" "$BIN_DIR/opensmi-tui"

  ok "opensmi-tui → $BIN_DIR/opensmi-tui"
fi

# Install CLI
if [[ $INSTALL_CLI -eq 1 ]]; then
  info "Installing CLI"

  # Decide method in auto mode
  if [[ "$CLI_METHOD" == "auto" ]]; then
    # Prefer pyz when available: works without pip and keeps installs simple.
    if [[ -n "$PYZ_URL" ]]; then
      CLI_METHOD="pyz"
    elif "$PYTHON" -m pip --version >/dev/null 2>&1 && [[ -n "$WHEEL_URL" ]]; then
      CLI_METHOD="pip"
    else
      CLI_METHOD="pyz"
    fi
  fi

  if [[ "$CLI_METHOD" == "pip" ]]; then
    info "CLI method: pip (wheel)"

    if ! "$PYTHON" -m pip --version >/dev/null 2>&1; then
      die "pip is not available for ${PYTHON}. Retry with: --cli-method pyz"
    fi

    WHEEL_ASSET="$(basename "$WHEEL_URL")"
    fetch "$WHEEL_URL" "$TMP/$WHEEL_ASSET"
    verify_one "$WHEEL_ASSET" "$TMP/$WHEEL_ASSET"

    "$PYTHON" -m pip install --user --upgrade "$TMP/$WHEEL_ASSET"
    ok "opensmi (pip) installed"

    # Ensure the opensmi entrypoint is reachable from BIN_DIR
    if [[ -x "$PY_USER_BIN/opensmi" && "$PY_USER_BIN" != "$BIN_DIR" ]]; then
      ln -sf "$PY_USER_BIN/opensmi" "$BIN_DIR/opensmi" || true
      ok "opensmi → $BIN_DIR/opensmi"
    fi

  elif [[ "$CLI_METHOD" == "pyz" ]]; then
    info "CLI method: pyz (zipapp)"

    PYZ_ASSET="$(basename "$PYZ_URL")"
    fetch "$PYZ_URL" "$TMP/$PYZ_ASSET"
    verify_one "$PYZ_ASSET" "$TMP/$PYZ_ASSET"

    SHARE_DIR="$HOME/.local/share/opensmi"
    mkdir -p "$SHARE_DIR"

    mv "$TMP/$PYZ_ASSET" "$SHARE_DIR/opensmi.pyz"
    chmod 0755 "$SHARE_DIR/opensmi.pyz"

    cat > "$BIN_DIR/opensmi" <<'SH'
#!/bin/sh
PYTHON_BIN="${OPENSMI_PYTHON:-python3}"
exec "$PYTHON_BIN" "${HOME%/}/.local/share/opensmi/opensmi.pyz" "$@"
SH
    chmod 0755 "$BIN_DIR/opensmi"

    ok "opensmi → $BIN_DIR/opensmi"

  else
    die "Unknown --cli-method: $CLI_METHOD (expected: auto|pip|pyz)"
  fi
fi

# S1 + S2: shell-aware PATH hint + optional auto-append
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  PROFILE="$(detect_shell_profile)"
  shell_bin="$(basename "${SHELL:-bash}")"

  if [[ "$shell_bin" == "fish" ]]; then
    PATH_LINE="set -gx PATH \"$BIN_DIR\" \$PATH"
  else
    PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
  fi

  warn "'$BIN_DIR' is not in your PATH"
  warn "Add this to ${PROFILE}:"
  warn "  ${PATH_LINE}"

  # S2: interactive TTY → offer to auto-append
  if [[ $IS_TTY -eq 1 ]]; then
    read -r -p "$(printf '%s' "${C_YELLOW}?${C_RESET} Add to ${PROFILE} automatically? [Y/n] ")" yn 2>/dev/tty || yn="n"
    if [[ "${yn:-Y}" =~ ^[Yy]$ ]]; then
      printf '\n# opensmi\n%s\n' "$PATH_LINE" >> "$PROFILE"
      ok "Added to ${PROFILE} — restart terminal or: source ${PROFILE}"
    fi
  fi
fi

ok "Installation complete"

say "Next:"
say "  opensmi onboard"
say "  opensmi poll"
say "  opensmi        # TUI"
say "  opensmi --help" 
