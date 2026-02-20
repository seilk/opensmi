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

# ── Spinner (Line/Clock — - \ | /) ────────────────────────────────
_SPIN_BG=0
_SPIN_MSG=""

spin_start() {
  _SPIN_MSG="$1"
  (
    frames='- \ | /'
    i=0
    while true; do
      # frames is space-separated; pick by index mod 4
      case $((i % 4)) in
        0) c='-' ;; 1) c='\\' ;; 2) c='|' ;; 3) c='/' ;;
      esac
      printf "\r  ${C_GREEN}%s${C_RESET}  %s" "$c" "$_SPIN_MSG"
      sleep 0.12
      ((i++)) || true
    done
  ) &
  _SPIN_BG=$!
}

spin_ok() {
  [[ $_SPIN_BG -ne 0 ]] && { kill "$_SPIN_BG" 2>/dev/null; wait "$_SPIN_BG" 2>/dev/null || true; }
  printf "\r  ${C_GREEN}✓${C_RESET}  %s\n" "$_SPIN_MSG"
  _SPIN_BG=0
}

spin_fail() {
  [[ $_SPIN_BG -ne 0 ]] && { kill "$_SPIN_BG" 2>/dev/null; wait "$_SPIN_BG" 2>/dev/null || true; }
  printf "\r  ${C_RED}✗${C_RESET}  %s\n" "$_SPIN_MSG"
  _SPIN_BG=0
}

# ── Summary Card ──────────────────────────────────────────────────
print_summary() {
  local version="${1:-v0.3.1}"
  local bin_dir="${2:-$HOME/.local/bin}"
  local W=44

  # Build separator line of W dashes
  local line
  line="$(printf '─%.0s' $(seq 1 $W))"

  echo ""
  echo "  ${C_GREEN}╭${line}╮${C_RESET}"
  printf "  ${C_GREEN}│${C_RESET}  ${C_BOLD}%-${W}s${C_RESET}${C_GREEN}│${C_RESET}\n" "opensmi ${version} installed"
  printf "  ${C_GREEN}│${C_RESET}  %-${W}s${C_GREEN}│${C_RESET}\n" ""
  printf "  ${C_GREEN}│${C_RESET}  %-${W}s${C_GREEN}│${C_RESET}\n" "CLI  →  ${bin_dir}/opensmi"
  printf "  ${C_GREEN}│${C_RESET}  %-${W}s${C_GREEN}│${C_RESET}\n" "TUI  →  ${bin_dir}/opensmi-tui"
  printf "  ${C_GREEN}│${C_RESET}  %-${W}s${C_GREEN}│${C_RESET}\n" ""
  printf "  ${C_GREEN}│${C_RESET}  ${C_DIM}%-${W}s${C_RESET}${C_GREEN}│${C_RESET}\n" "Run: opensmi --help"
  echo "  ${C_GREEN}╰${line}╯${C_RESET}"
  echo ""
}

# ── Demo ──────────────────────────────────────────────────────────
echo ""
echo "  ${C_BOLD}Installing opensmi${C_RESET}  ${C_DIM}(demo)${C_RESET}"
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

print_summary "v0.3.1" "$HOME/.local/bin"
