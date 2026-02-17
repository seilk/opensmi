# Ralph Tasks

Add your tasks below using: `ralph --add-task "description"`

## Phase 1: Job Persistence (COMPLETE ✅)
- [x] Job data model and store (jobs.py)
- [x] Job health checking (check_job_alive)
- [x] Job lifecycle operations (cancel, retry)
- [x] CLI commands (list, submit, status, cancel, retry, delete, log)
- [x] Unit tests for jobs module

## Phase 2: Jobs Tab UI (IN PROGRESS)
- [x] TUI-A: Create Job type definitions in index.ts matching Python Job model
- [x] TUI-B: Add loadJobsFromCLI() function to fetch jobs via `opensmi job list --json`
- [x] TUI-C: Register "jobs" tab in tabRegistry with shortcut "j"
- [x] TUI-D: Implement renderJobsListView() with status icons (○ queued, ● running, ✓ done, ✗ failed, ⊘ cancelled)
- [x] TUI-E: Implement job selection navigation (j/k keys)
- [x] TUI-F: Implement renderJobDetailView() with full job information
- [x] TUI-G: Add keyboard handlers for job actions (c=cancel, r=retry, d=delete, Enter=detail)
- [x] TUI-H: Add job status polling in pollCluster cycle
- [x] TUI-I: Add formatJobDuration() and formatJobTimestamp() helper functions
- [x] TUI-J: Verify Jobs tab UI works end-to-end with test data

## Phase 3: Job Queue with Auto-dispatch (NOT STARTED)
- [x] QUEUE-A: Add launchQueueMode state variable ("immediate" | "queued") in index.ts
- [x] QUEUE-B: Add queue mode toggle UI in command runner pane (Q key)
- [x] QUEUE-C: Modify executeLaunch() to create Job object and save to store
- [x] QUEUE-D: Implement saveJobToStore() function calling `opensmi job submit` with appropriate flags
- [x] QUEUE-E: Add findAvailableGpus() function using existing rank_gpus logic
- [x] QUEUE-F: Implement dispatchQueuedJobs() function with FIFO queue processing
- [x] QUEUE-G: Integrate dispatcher into pollCluster cycle (after snapshot update)
- [x] QUEUE-H: Add executeJobRemote() to launch queued jobs on selected GPUs
- [x] QUEUE-I: Add status notifications for auto-dispatch events
- [x] QUEUE-J: Test queued mode: submit job, wait for GPU free, verify auto-start

## Phase 4: Job Lifecycle Management (NOT STARTED)
- [ ] WATCH-A: Implement watchRunningJobs() function to monitor tmux session health
- [ ] WATCH-B: Add auto-restart logic based on restart_policy (on-failure, always)
- [ ] WATCH-C: Integrate watchdog into pollCluster cycle
- [ ] WATCH-D: Add retry_count tracking and max_retries enforcement
- [ ] WATCH-E: Add status message notifications for job state changes (died, requeued, failed)
- [ ] WATCH-F: Implement job cleanup for stale tmux sessions
- [ ] WATCH-G: Test restart policies: never, on-failure (with kill), always

## Integration & Polish (NOT STARTED)
- [ ] INT-A: Update command runner to use queue mode by default for multi-GPU jobs
- [ ] INT-B: Add job creation feedback in runner (show job ID after submission)
- [ ] INT-C: Add "View in Jobs tab" shortcut after job submission
- [ ] INT-D: Update TUI README with Jobs tab documentation
- [ ] INT-E: Add end-to-end integration test for full workflow
- [ ] INT-F: Performance test with 50+ jobs in queue
- [ ] INT-G: Add job queue metrics to dashboard status bar

## Testing & Documentation (NOT STARTED)
- [ ] TEST-A: Write unit tests for TUI job functions (loadJobsFromCLI, findAvailableGpus, etc.)
- [ ] TEST-B: Write integration tests for dispatcher loop
- [ ] TEST-C: Write integration tests for watchdog loop
- [ ] TEST-D: Test concurrent job submissions from CLI and TUI
- [ ] TEST-E: Test file locking for jobs.json concurrent access
- [ ] DOC-A: Update JOB_QUEUE_STATUS.md with Phase 2-4 completion
- [ ] DOC-B: Add usage examples to README
- [ ] DOC-C: Create TROUBLESHOOTING.md for common job queue issues
