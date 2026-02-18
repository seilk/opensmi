#!/usr/bin/env bash
set -euo pipefail
#
# dev-build.sh — Build opensmi from source and link for local testing
#
# Usage:
#   ./scripts/dev-build.sh              # Build CLI + TUI, symlink both
#   ./scripts/dev-build.sh --cli-only   # Build & link CLI only
#   ./scripts/dev-build.sh --tui-only   # Build & link TUI only
#   ./scripts/dev-build.sh --unlink     # Restore original binaries
#
# What it does:
#   1. Builds Python CLI (pip install -e . from source)
#   2. Builds TUI binary (bun build --compile)
#   3. Backs up current installed binaries
#   4. Symlinks dev builds into PATH
#
# Rollback:
#   ./scripts/dev-build.sh --unlink
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT_DIR/.dev-build-backup"

# Colors
if [[ -t 1 ]]; then
  C_R=$'\033[0m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_B=$'\033[34m'; C_D=$'\033[2m'
else
  C_R=""; C_G=""; C_Y=""; C_B=""; C_D=""
fi

info()  { printf '%s==>%s %s\n' "$C_B" "$C_R" "$*"; }
ok()    { printf '%s✓%s %s\n' "$C_G" "$C_R" "$*"; }
warn()  { printf '%swarning:%s %s\n' "$C_Y" "$C_R" "$*" >&2; }
die()   { printf '%serror:%s %s\n' "$C_Y" "$C_R" "$*" >&2; exit 1; }

# ── Detect current install locations ──────────────────────────────

find_binary() {
  command -v "$1" 2>/dev/null || true
}

CLI_BIN="$(find_binary opensmi)"
TUI_BIN="$(find_binary opensmi-tui)"

# Resolve TUI symlink target
TUI_REAL=""
if [[ -L "$TUI_BIN" ]]; then
  TUI_REAL="$(readlink "$TUI_BIN")"
  # Resolve relative symlinks
  if [[ "$TUI_REAL" != /* ]]; then
    TUI_REAL="$(cd "$(dirname "$TUI_BIN")" && cd "$(dirname "$TUI_REAL")" && pwd)/$(basename "$TUI_REAL")"
  fi
fi

CLI_DIR="$(dirname "${CLI_BIN:-/usr/local/bin/opensmi}")"
TUI_DIR="$(dirname "${TUI_BIN:-$HOME/.local/bin/opensmi-tui}")"

PYTHON="${OPENSMI_PYTHON:-python3}"

# ── Parse args ────────────────────────────────────────────────────

BUILD_CLI=1
BUILD_TUI=1
DO_UNLINK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cli-only) BUILD_TUI=0; shift ;;
    --tui-only) BUILD_CLI=0; shift ;;
    --unlink)   DO_UNLINK=1; shift ;;
    -h|--help)
      sed -n '2,/^$/{ s/^# //; s/^#//; p }' "$0"
      exit 0
      ;;
    *) die "Unknown arg: $1" ;;
  esac
done

# ── Unlink mode ───────────────────────────────────────────────────

if [[ $DO_UNLINK -eq 1 ]]; then
  info "Restoring original binaries"

  if [[ -f "$BACKUP_DIR/cli_path" ]]; then
    orig_cli="$(cat "$BACKUP_DIR/cli_path")"
    if [[ -f "$BACKUP_DIR/opensmi.bak" ]]; then
      cp "$BACKUP_DIR/opensmi.bak" "$orig_cli"
      chmod +x "$orig_cli"
      ok "CLI restored: $orig_cli"
    fi
  else
    warn "No CLI backup found"
  fi

  if [[ -f "$BACKUP_DIR/tui_symlink" ]]; then
    orig_tui_link="$(cat "$BACKUP_DIR/tui_symlink")"
    orig_tui_target="$(cat "$BACKUP_DIR/tui_target" 2>/dev/null || true)"
    if [[ -n "$orig_tui_target" ]]; then
      ln -sf "$orig_tui_target" "$orig_tui_link"
      ok "TUI symlink restored: $orig_tui_link → $orig_tui_target"
    fi
  else
    warn "No TUI backup found"
  fi

  # Uninstall editable pip install
  if "$PYTHON" -m pip show opensmi >/dev/null 2>&1; then
    info "Removing editable pip install"
    "$PYTHON" -m pip uninstall -y opensmi 2>/dev/null || true
  fi

  # Reinstall from wheel if backup exists
  if [[ -f "$BACKUP_DIR/pip_was_installed" ]]; then
    info "Reinstalling opensmi from PyPI/wheel"
    "$PYTHON" -m pip install opensmi 2>/dev/null || warn "Could not reinstall from PyPI; manual reinstall may be needed"
  fi

  ok "Unlink complete"
  exit 0
fi

# ── Pre-flight checks ────────────────────────────────────────────

info "opensmi dev-build"
info "Source:  $ROOT_DIR"
info "Python:  $PYTHON ($($PYTHON --version 2>&1))"

if [[ $BUILD_TUI -eq 1 ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
  fi
  info "Bun:     $(bun --version)"
fi

echo ""

# ── Backup current binaries ──────────────────────────────────────

mkdir -p "$BACKUP_DIR"

if [[ $BUILD_CLI -eq 1 && -n "$CLI_BIN" && -f "$CLI_BIN" ]]; then
  if [[ ! -f "$BACKUP_DIR/opensmi.bak" ]]; then
    cp "$CLI_BIN" "$BACKUP_DIR/opensmi.bak"
    echo "$CLI_BIN" > "$BACKUP_DIR/cli_path"
    # Track if it was pip-installed
    if "$PYTHON" -m pip show opensmi >/dev/null 2>&1; then
      touch "$BACKUP_DIR/pip_was_installed"
    fi
    ok "CLI backed up: $CLI_BIN → $BACKUP_DIR/opensmi.bak"
  fi
fi

if [[ $BUILD_TUI -eq 1 && -n "$TUI_BIN" ]]; then
  if [[ ! -f "$BACKUP_DIR/tui_symlink" ]]; then
    echo "$TUI_BIN" > "$BACKUP_DIR/tui_symlink"
    if [[ -n "$TUI_REAL" ]]; then
      echo "$TUI_REAL" > "$BACKUP_DIR/tui_target"
    fi
    ok "TUI symlink backed up: $TUI_BIN → ${TUI_REAL:-<direct>}"
  fi
fi

# ── Build CLI ─────────────────────────────────────────────────────

if [[ $BUILD_CLI -eq 1 ]]; then
  info "Building CLI (editable pip install)"

  cd "$ROOT_DIR"
  "$PYTHON" -m pip install -e . --quiet 2>&1 | tail -3

  # Verify
  cli_version="$("$PYTHON" -c "import opensmi; print(opensmi.__version__)" 2>/dev/null || echo "unknown")"

  # Find where pip put the entrypoint
  pip_cli="$("$PYTHON" -c "
import sysconfig
print(sysconfig.get_path('scripts', scheme='posix_user'))
" 2>/dev/null)/opensmi"

  # Also check common locations
  for candidate in "$pip_cli" "$(dirname "$("$PYTHON" -c "import sys; print(sys.executable)")")/opensmi"; do
    if [[ -x "$candidate" ]]; then
      pip_cli="$candidate"
      break
    fi
  done

  # Symlink to where the original CLI was
  if [[ -n "$CLI_BIN" && "$pip_cli" != "$CLI_BIN" ]]; then
    ln -sf "$pip_cli" "$CLI_BIN"
    ok "CLI linked: $CLI_BIN → $pip_cli (v${cli_version})"
  else
    ok "CLI installed: ${pip_cli:-$CLI_BIN} (v${cli_version})"
  fi

  echo ""
fi

# ── Build TUI ─────────────────────────────────────────────────────

if [[ $BUILD_TUI -eq 1 ]]; then
  info "Building TUI binary"

  cd "$ROOT_DIR/tui"
  bun install --frozen-lockfile 2>&1 | tail -1

  cd "$ROOT_DIR"

  ARCH_RAW="$(uname -m)"
  case "$ARCH_RAW" in
    x86_64)        ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) die "Unsupported arch: $ARCH_RAW" ;;
  esac
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  SUFFIX="${OS}-${ARCH}"

  OUT_BIN="$ROOT_DIR/dist/opensmi-tui-${SUFFIX}"
  mkdir -p "$ROOT_DIR/dist"

  bun build \
    --compile \
    --production \
    --outfile="$OUT_BIN" \
    tui/index.ts 2>&1 | tail -5

  if [[ ! -x "$OUT_BIN" ]]; then
    die "Build failed: $OUT_BIN not found"
  fi

  # Smoke test
  info "Running smoke test..."
  if OTUI_NO_NATIVE_RENDER=1 OTUI_USE_ALTERNATE_SCREEN=0 "$OUT_BIN" --smoke-test 2>/dev/null; then
    ok "Smoke test passed"
  else
    warn "Smoke test failed (binary may still work in real terminal)"
  fi

  # Symlink: opensmi-tui → dev build
  if [[ -n "$TUI_BIN" ]]; then
    # Point the symlink at our dev build
    ln -sf "$OUT_BIN" "$TUI_BIN"
    ok "TUI linked: $TUI_BIN → $OUT_BIN"
  else
    # No existing install — put it in ~/.local/bin
    TUI_INSTALL_DIR="$HOME/.local/bin"
    mkdir -p "$TUI_INSTALL_DIR"
    ln -sf "$OUT_BIN" "$TUI_INSTALL_DIR/opensmi-tui"
    ok "TUI linked: $TUI_INSTALL_DIR/opensmi-tui → $OUT_BIN"
  fi

  ls -lh "$OUT_BIN"
  echo ""
fi

# ── Summary ───────────────────────────────────────────────────────

info "Dev build complete"
echo ""
echo "  ${C_D}Source:${C_R}    $ROOT_DIR"
echo "  ${C_D}Commit:${C_R}    $(cd "$ROOT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "N/A")"

if [[ $BUILD_CLI -eq 1 ]]; then
  echo "  ${C_D}CLI:${C_R}       $(find_binary opensmi) (editable → src/opensmi/)"
fi
if [[ $BUILD_TUI -eq 1 ]]; then
  echo "  ${C_D}TUI:${C_R}       $(find_binary opensmi-tui) → $OUT_BIN"
fi

echo ""
echo "  ${C_G}opensmi --version${C_R}     # verify CLI"
echo "  ${C_G}opensmi-tui${C_R}           # launch TUI"
echo "  ${C_G}opensmi job list${C_R}      # test new job commands"
echo ""
echo "  ${C_Y}Rollback:${C_R} ./scripts/dev-build.sh --unlink"
