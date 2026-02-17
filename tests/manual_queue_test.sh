#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "=== Manual Queue Mode Test (QUEUE-J) ==="
echo "This script demonstrates the queued mode auto-dispatch functionality."
echo ""

echo "Step 1: Cleaning up any existing test jobs..."
python3 -m src.opensmi job list --json 2>/dev/null | \
  python3 -c "import sys, json; jobs = json.load(sys.stdin).get('jobs', []); [print(j['id']) for j in jobs if 'TEST_MANUAL' in j.get('command', '')]" | \
  xargs -I {} python3 -m src.opensmi job delete {} 2>/dev/null || true

echo ""
echo "Step 2: Submitting blocker job (immediate mode, sleeps 10s)..."
BLOCKER_OUTPUT=$(python3 -m src.opensmi job submit \
  --command "echo 'TEST_MANUAL_BLOCKER: Occupying GPU' && sleep 10 && echo 'TEST_MANUAL_BLOCKER: Done'" \
  --auto-gpus 1 \
  --tmux \
  --json)

BLOCKER_ID=$(echo "$BLOCKER_OUTPUT" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Blocker job ID: $BLOCKER_ID"

sleep 2

echo ""
echo "Step 3: Checking blocker status..."
python3 -m src.opensmi job status "$BLOCKER_ID"

echo ""
echo "Step 4: Submitting queued job (should wait for GPU to free)..."
QUEUED_OUTPUT=$(python3 -m src.opensmi job submit \
  --command "echo 'TEST_MANUAL_QUEUED: Auto-started!' && date && echo 'TEST_MANUAL_QUEUED: Done'" \
  --auto-gpus 1 \
  --queue \
  --tmux \
  --json)

QUEUED_ID=$(echo "$QUEUED_OUTPUT" | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Queued job ID: $QUEUED_ID"

echo ""
echo "Step 5: Verifying queued job is in 'queued' status..."
python3 -m src.opensmi job status "$QUEUED_ID"

echo ""
echo "Step 6: Listing all jobs..."
python3 -m src.opensmi job list

echo ""
echo "Step 7: Waiting for blocker to finish (~10 seconds)..."
for i in {1..12}; do
  sleep 1
  STATUS=$(python3 -m src.opensmi job status "$BLOCKER_ID" --json 2>/dev/null | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" || echo "unknown")
  echo -n "."
  if [[ "$STATUS" == "done" ]] || [[ "$STATUS" == "failed" ]]; then
    echo ""
    echo "Blocker finished with status: $STATUS"
    break
  fi
done

echo ""
echo "Step 8: Waiting for dispatcher to auto-start queued job..."
echo "The TUI dispatcher polls periodically and should pick up the queued job."
echo ""
echo "NOTE: This test script ONLY demonstrates the queue submission."
echo "To verify auto-dispatch, you need to:"
echo "  1. Run 'opensmi' (TUI) in another terminal"
echo "  2. Watch the Jobs tab (press 'j')"
echo "  3. Observe the queued job transition to 'running' status"
echo ""

echo "Monitoring queued job status for 30 seconds..."
for i in {1..30}; do
  sleep 1
  STATUS=$(python3 -m src.opensmi job status "$QUEUED_ID" --json 2>/dev/null | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" || echo "unknown")
  echo "[$i/30] Status: $STATUS"
  
  if [[ "$STATUS" == "running" ]]; then
    echo ""
    echo "SUCCESS! Queued job was auto-dispatched and is now running!"
    python3 -m src.opensmi job status "$QUEUED_ID"
    break
  fi
done

echo ""
echo "Step 9: Final job list..."
python3 -m src.opensmi job list

echo ""
echo "Cleanup: Cancelling and deleting test jobs..."
python3 -m src.opensmi job cancel "$BLOCKER_ID" 2>/dev/null || true
python3 -m src.opensmi job cancel "$QUEUED_ID" 2>/dev/null || true
python3 -m src.opensmi job delete "$BLOCKER_ID" 2>/dev/null || true
python3 -m src.opensmi job delete "$QUEUED_ID" 2>/dev/null || true

echo ""
echo "=== Manual Test Complete ==="
echo ""
echo "IMPORTANT: Auto-dispatch only works when the TUI is running!"
echo "If the queued job did not auto-start, ensure:"
echo "  1. The TUI (opensmi) is running in a terminal"
echo "  2. The dispatcher is integrated into pollCluster cycle"
echo "  3. GPUs are available in your cluster"
