#!/usr/bin/env bash
# opensmi installer UI demo  —  progress bar + spinner + summary card
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

# ── Progress Bar ──────────────────────────────────────────────────
# draw_progress  label  current_bytes  total_bytes
# Outputs: "  Downloading opensmi-tui  ■■■■■■■■･･ 80%  1.2 MB"
draw_progress() {
  local label="$1"
  local cur="$2"
  local total="$3"
  local bar_w=20   # total chars for bar

  local pct=0
  [[ $total -gt 0 ]] && pct=$(( cur * 100 / total ))
  local on=$(( pct * bar_w / 100 ))
  local off=$(( bar_w - on ))

  local filled="" empty=""
  [[ $on  -gt 0 ]] && filled="$(printf '■%.0s' $(seq 1 $on))"
  [[ $off -gt 0 ]] && empty="$(printf '･%.0s'  $(seq 1 $off))"

  # Human-readable size
  local size_str=""
  if   [[ $cur -ge 1048576 ]]; then
    size_str="$(awk "BEGIN{printf \"%.1f MB\", $cur/1048576}")"
  elif [[ $cur -ge 1024 ]]; then
    size_str="$(awk "BEGIN{printf \"%.0f KB\", $cur/1024}")"
  else
    size_str="${cur} B"
  fi

  printf "\r  ${C_DIM}%-36s${C_RESET}  ${C_GREEN}%s%s${C_RESET}  ${C_BOLD}%3d%%${C_RESET}  ${C_DIM}%s${C_RESET}" \
    "$label" "$filled" "$empty" "$pct" "$size_str"
}

# Simulate a download with progress bar (demo only — real version uses curl -w)
# simulate_download  label  total_bytes  duration_ms
simulate_download() {
  local label="$1"
  local total="$2"
  local dur_ms="$3"
  local steps=40
  local step_ms=$(( dur_ms / steps ))
  local step_bytes=$(( total / steps ))

  cursor_hide
  local i=0
  while [[ $i -le $steps ]]; do
    local cur=$(( i * step_bytes ))
    [[ $cur -gt $total ]] && cur=$total
    draw_progress "$label" "$cur" "$total"
    sleep "$(awk "BEGIN{printf \"%.3f\", $step_ms/1000}")"
    i=$(( i + 1 ))
  done
  # Ensure 100% is shown
  draw_progress "$label" "$total" "$total"
  printf "\r\033[K"   # clear line
  cursor_show
  printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$label"
}

# ── Spinner  (Line/Clock: | / - \)  ──────────────────────────────
# Used for non-download steps (fetch, verify, install path writes)
_SPINNER_PID=""
_SPINNER_MSG=""

spin_start() {
  _SPINNER_MSG="$1"
  local msg="$1"

  if [[ $IS_TTY -eq 0 ]]; then
    printf "  | %s\n" "$msg"
    return
  fi

  cursor_hide
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
    printf "\r\033[K"
    cursor_show
  fi
}

spin_ok()   { _spin_stop; printf "  ${C_GREEN}✓${C_RESET}  %s\n" "$_SPINNER_MSG"; }
spin_fail() { _spin_stop; printf "  ${C_RED}✗${C_RESET}  %s\n"   "$_SPINNER_MSG"; }

# Restore cursor on unexpected exit
trap 'cursor_show' EXIT

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
sleep 0.8
spin_ok

# Downloads: progress bar  (label, total_bytes, duration_ms)
simulate_download "Downloading opensmi CLI..."        "2621440"  "1500"   # 2.5 MB
simulate_download "Downloading opensmi-tui (arm64)..." "15728640" "2000"  # 15 MB

spin_start "Verifying SHA256 checksums..."
sleep 0.6
spin_ok

spin_start "Installing to ~/.local/bin..."
sleep 0.4
spin_ok

spin_start "Updating PATH in ~/.zshrc..."
sleep 0.3
spin_ok

print_summary "v0.3.1" "~/.local/bin"
