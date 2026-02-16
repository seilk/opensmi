#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux &> /dev/null; then
  echo "SKIP: tmux not installed"
  exit 0
fi

if [ -z "${TMUX:-}" ] && [ -z "${STY:-}" ] && [ ! -S /tmp/tmux-* 2>/dev/null ]; then
  if ! tmux -V &>/dev/null; then
    echo "SKIP: tmux not functional (no socket)"
    exit 0
  fi
fi

TEST_SESSION="opensmi-test-$$"

cleanup() {
  tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
}

trap cleanup EXIT

echo "✓ tmux found"

if ! tmux new-session -d -s "$TEST_SESSION" "sleep 5" 2>/dev/null; then
  echo "SKIP: Cannot create tmux session (might be in CI without PTY)"
  exit 0
fi

sleep 1

if ! tmux list-sessions 2>/dev/null | grep -q "$TEST_SESSION"; then
  echo "✗ Failed to create session"
  exit 1
fi

echo "✓ Session created"

if ! tmux send-keys -t "$TEST_SESSION" "echo 'hello from send-keys'" Enter 2>/dev/null; then
  echo "✗ send-keys failed"
  exit 1
fi

sleep 1

echo "✓ send-keys works"

if ! tmux list-sessions -F "#{session_name}" 2>/dev/null | grep -q "$TEST_SESSION"; then
  echo "✗ Session listing failed"
  exit 1
fi

echo "✓ Session listing works"

cleanup

if tmux list-sessions 2>/dev/null | grep -q "$TEST_SESSION"; then
  echo "✗ Failed to kill session"
  exit 1
fi

echo "✓ Session cleanup works"
echo ""
echo "All tmux integration tests passed"
