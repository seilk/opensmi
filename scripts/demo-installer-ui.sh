#!/usr/bin/env bash
# opensmi installer UI demo
# Usage: bash scripts/demo-installer-ui.sh

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────
IS_TTY=0; [[ -t 1 ]] && IS_TTY=1
C_RESET=""; C_GREEN=""; C_DIM=""; C_RED=""; C_BOLD=""
if [[ $IS_TTY -eq 1 ]]; then
  C_RESET=$'\033[0m'
  C_GREEN=$'\033[32m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_BOLD=$'\033[1m'
fi

ERASE_LINE=$'\033[2K'   # clear the entire current line

# ── Spinner (Line/Clock: - \ | /) ────────────────────────────────
_SPIN_BG=0
_SPIN_MSG=""

spin_start() {
  _SPIN_MSG="$1"
  local msg="$1"
  (
    trap '' INT TERM   # child ignores signals; parent kills it
    i=0
    while true; do
      case $((i % 4)) in
        0) c='-' ;; 1) c='\\' ;; 2) c='|' ;; 3) c='/' ;;
      esac
      # \033[2K clears entire line, \r moves cursor to column 0
      printf "\r${ERASE_LINE}  ${C_GREEN}%s${C_RESET}  %s" "$c" "$msg"
      sleep 0.12
      i=$(( i + 1 ))
    done
  ) &
  _SPIN_BG=$!
}

_spin_end() {
  local icon="$1" color="$2"
  if [[ $_SPIN_BG -ne 0 ]]; then
    kill "$_SPIN_BG" 2>/dev/null
    wait "$_SPIN_BG" 2>/dev/null || true
    _SPIN_BG=0
  fi
  # Clear the line the spinner was on, then print final status
  printf "\r${ERASE_LINE}  ${color}%s${C_RESET}  %s\n" "$icon" "$_SPIN_MSG"
}

spin_ok()   { _spin_end "✓" "${C_GREEN}"; }
spin_fail() { _spin_end "✗" "${C_RED}";   }

# ── Summary Card ──────────────────────────────────────────────────
print_summary() {
  local version="${1:-v0.3.1}"
  local bin_dir="${2:-~/.local/bin}"
  local W=44
  local line
  line="$(printf '─%.0s' $(seq 1 $W))"

  # helper: print one box row, auto-padding content to W chars
  box_row() {
    local content="$1"
    local style="${2:-}"
    # printf pads/truncates to exactly W chars
    printf "  ${C_GREEN}│${C_RESET}  ${style}%-${W}s${C_RESET}${C_GREEN}│${C_RESET}\n" "$content"
  }

  echo ""
  printf "  ${C_GREEN}╭%s╮${C_RESET}\n" "$line"
  box_row "opensmi ${version} installed" "${C_BOLD}"
  box_row ""
  box_row "CLI  →  ${bin_dir}/opensmi"
  box_row "TUI  →  ${bin_dir}/opensmi-tui"
  box_row ""
  box_row "Run: opensmi --help" "${C_DIM}"
  printf "  ${C_GREEN}╰%s╯${C_RESET}\n" "$line"
  echo ""
}

# ── Demo run ──────────────────────────────────────────────────────
echo ""
printf "  ${C_BOLD}Installing opensmi${C_RESET}  ${C_DIM}(demo)${C_RESET}\n"
echo ""

spin_start "Fetching latest release from GitHub..."
sleep 1.2
spin_ok

spin_start "Downloading opensmi-tui (darwin-arm64)..."
sleep 1.8
spin_ok

spin_start "Verifying SHA256 checksums..."
sleep 0.8
spin_ok

spin_start "Installing to ~/.local/bin..."
sleep 0.6
spin_ok

spin_start "Updating PATH in ~/.zshrc..."
sleep 0.4
spin_ok

print_summary "v0.3.1" "~/.local/bin"
