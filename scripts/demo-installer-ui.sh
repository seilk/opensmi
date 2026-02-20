#!/usr/bin/env bash
# opensmi installer UI demo  —  spinner + summary card
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

# ── Spinner  (Line/Clock: | / - \)  ──────────────────────────────
# Pattern from tw93/Mole:
#   - spinner char + message redrawn each frame with \r (same length → no erase needed)
#   - stop clears the whole line with \r\033[K, caller prints result separately

_SPINNER_PID=""
_SPINNER_MSG=""

spin_start() {
  _SPINNER_MSG="$1"
  local msg="$1"

  if [[ $IS_TTY -eq 0 ]]; then
    # Non-TTY: print once and return (no animation)
    printf "  | %s\n" "$msg"
    return
  fi

  (
    i=0
    while true; do
      case $((i % 4)) in
        0) c='|' ;; 1) c='/' ;; 2) c='-' ;; 3) c='\\' ;;
      esac
      printf "\r  ${C_GREEN}%s${C_RESET}  %s" "$c" "$msg"
      sleep 0.12
      i=$(( i + 1 ))
    done
  ) &
  _SPINNER_PID=$!
}

_spin_stop() {
  if [[ -n "$_SPINNER_PID" ]]; then
    kill "$_SPINNER_PID" 2>/dev/null || true
    wait "$_SPINNER_PID" 2>/dev/null || true
    _SPINNER_PID=""
    printf "\r\033[K"   # cursor to col-0, erase to end of line
  fi
}

spin_ok()   {
  _spin_stop
  printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$_SPINNER_MSG"
}
spin_fail() {
  _spin_stop
  printf "  ${C_RED}✗${C_RESET}  %s\n" "$_SPINNER_MSG"
}

# ── Summary Card ──────────────────────────────────────────────────
print_summary() {
  local version="${1:-v0.3.1}"
  local bin_dir="${2:-~/.local/bin}"
  local W=44
  local line
  line="$(printf '─%.0s' $(seq 1 $W))"

  box_row() {
    local content="${1:-}"
    local style="${2:-}"
    printf "  ${C_GREEN}│${C_RESET}  ${style}%-${W}s${C_RESET}${C_GREEN}│${C_RESET}\n" "$content"
  }

  printf "\n"
  printf "  ${C_GREEN}╭%s╮${C_RESET}\n" "$line"
  box_row "opensmi ${version} installed" "${C_BOLD}"
  box_row ""
  box_row "CLI  →  ${bin_dir}/opensmi"
  box_row "TUI  →  ${bin_dir}/opensmi-tui"
  box_row ""
  box_row "Run: opensmi --help" "${C_DIM}"
  printf "  ${C_GREEN}╰%s╯${C_RESET}\n" "$line"
  printf "\n"
}

# ── Demo ──────────────────────────────────────────────────────────
printf "\n  ${C_BOLD}Installing opensmi${C_RESET}  ${C_DIM}(demo)${C_RESET}\n\n"

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
