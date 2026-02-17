# QUEUE-J Testing Guide

**Task**: Test queued mode: submit job, wait for GPU free, verify auto-start

## Prerequisites

1. opensmi installed and configured with at least one GPU node
2. Python environment set up: `PYTHONPATH=src`
3. TUI dependencies installed: `cd tui && bun install`

## Test Methods

### Method 1: Automated Integration Test

Run the comprehensive integration test:

```bash
cd /Users/seil/git-wt/opensmi-dev/raven
PYTHONPATH=src python3 -m pytest tests/test_queue_autodispatch.py::test_queued_mode_autodispatch -v
```

This test:
1. Submits a blocker job to occupy GPUs
2. Submits a queued job that should wait
3. Waits for blocker to finish
4. Verifies dispatcher auto-starts the queued job

**Expected output**: `PASSED`

### Method 2: Manual CLI Test

Run the manual test script:

```bash
cd /Users/seil/git-wt/opensmi-dev/raven
./tests/manual_queue_test.sh
```

This script demonstrates the queue workflow but requires the TUI to be running for auto-dispatch.

### Method 3: Interactive TUI Test

**Step 1: Start TUI**
```bash
cd /Users/seil/git-wt/opensmi-dev/raven
make tui
```

**Step 2: In another terminal, submit blocker job**
```bash
cd /Users/seil/git-wt/opensmi-dev/raven
PYTHONPATH=src python3 -m src.opensmi job submit \
  --command "sleep 15" \
  --auto-gpus 1 \
  --tmux \
  --json
```

**Step 3: Submit queued job**
```bash
PYTHONPATH=src python3 -m src.opensmi job submit \
  --command "echo 'Auto-started!'" \
  --auto-gpus 1 \
  --queue \
  --tmux \
  --json
```

**Step 4: Watch in TUI**
1. Press `j` to open Jobs tab
2. Observe the queued job status
3. Wait for blocker to finish (15 seconds)
4. Watch the queued job transition to "running" (dispatcher auto-starts it)

**Expected behavior**:
- Queued job shows status "queued" with queue_mode="queued"
- After blocker finishes, dispatcher picks up queued job
- Queued job transitions to "running" status
- TUI shows status notification: "Auto-dispatched job {id}: {command}..."

## Verification Checklist

- [ ] Queued job is created with status="queued" and queue_mode="queued"
- [ ] Job stays in queued status while GPUs are occupied
- [ ] When GPUs become available, dispatcher detects it
- [ ] Dispatcher assigns GPUs to queued job
- [ ] Job transitions to "running" status
- [ ] Job has gpus assigned and started_at timestamp set
- [ ] TUI displays status notification for auto-dispatch
- [ ] Jobs tab shows the state transition correctly

## Common Issues

### Dispatcher doesn't run
- Ensure TUI is running (dispatcher is part of pollCluster cycle)
- Check poll interval is reasonable (not too long)

### Job stays queued forever
- Check if GPUs are actually available: `PYTHONPATH=src python3 -m src.opensmi poll`
- Verify `findAvailableGpus()` returns results
- Check dispatcher logic in `tui/index.ts::dispatchQueuedJobs()`

### Job starts immediately despite queue mode
- Verify `--queue` flag is passed
- Check job's queue_mode field: `PYTHONPATH=src python3 -m src.opensmi job status {id} --json`
- Ensure job has requested_gpu_count or gpus set

## Success Criteria

QUEUE-J is complete when:
1. ✅ Jobs can be submitted with `--queue` flag
2. ✅ Queued jobs stay in "queued" status when no GPUs available
3. ✅ Dispatcher detects when GPUs become available
4. ✅ Dispatcher auto-starts queued jobs (FIFO order)
5. ✅ Status notifications appear in TUI
6. ✅ Jobs tab shows correct status transitions
