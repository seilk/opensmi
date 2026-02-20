#!/usr/bin/env bash
# opensmi installer UI demo  —  spinner + summary card (no vertical bars)
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

cursor_hide() { [[ $IS_TTY -eq 1 ]] && printf '\033[?25l'; }
cursor_show() { [[ $IS_TTY -eq 1 ]] && printf '\033[?25h'; }
trap 'cursor_show' EXIT

# ── Spinner  (Line/Clock: | / - \) ───────────────────────────────
_SPINNER_PID=""
_SPINNER_MSG=""

spin_start() {
  _SPINNER_MSG="$1"
  local msg="$1"
  if [[ $IS_TTY -eq 0 ]]; then
    printf '  => %s\n' "$msg"; return
  fi
  cursor_hide
  (
    i=0
    while true; do
      case $((i % 4)) in
        0) c='|' ;; 1) c='/' ;; 2) c='-' ;; 3) c="\\" ;;
      esac
      printf "\r  ${C_GREEN}%s${C_RESET}  %s" "$c" "$msg"
      sleep 0.06
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
    printf "\r\033[K"
    cursor_show
  fi
}

spin_ok()   { _spin_stop; printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$_SPINNER_MSG"; }
spin_fail() { _spin_stop; printf "  ${C_RED}✗${C_RESET}  %s\n"   "$_SPINNER_MSG"; }

# ── Summary Card (no vertical bars) ──────────────────────────────
print_summary() {
  local version="${1:-v0.3.1}"
  local bin_dir="${2:-~/.local/bin}"
  local config_dir="${3:-~/.opensmi}"
  local W=48
  local line
  line="$(printf '─%.0s' $(seq 1 $W))"

  printf "\n"
  printf "  ${C_GREEN}%s${C_RESET}\n" "$line"
  printf "\n"
  printf "  ${C_BOLD}opensmi %s${C_RESET}  ${C_DIM}installed${C_RESET}\n" "$version"
  printf "\n"
  printf "  ${C_DIM}%-8s${C_RESET}  %s\n" "CLI"    "${bin_dir}/opensmi"
  printf "  ${C_DIM}%-8s${C_RESET}  %s\n" "TUI"    "${bin_dir}/opensmi-tui"
  printf "  ${C_DIM}%-8s${C_RESET}  %s\n" "Config" "${config_dir}/opensmi.json"
  printf "\n"
  printf "  ${C_GREEN}Next:${C_RESET}  opensmi onboard\n"
  printf "\n"
  printf "  ${C_GREEN}%s${C_RESET}\n" "$line"
  printf "\n"
}

# ── Demo ──────────────────────────────────────────────────────────
printf "\n  ${C_BOLD}Installing opensmi${C_RESET}  ${C_DIM}(demo)${C_RESET}\n\n"

spin_start "Fetching latest release from GitHub..."
sleep 1.2
spin_ok

spin_start "Downloading opensmi CLI..."
sleep 1.5
spin_ok

spin_start "Downloading opensmi-tui (darwin-arm64)..."
sleep 2.0
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

print_summary "v0.3.1" "~/.local/bin" "~/.opensmi"
