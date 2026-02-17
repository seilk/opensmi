# Job Queue Implementation Status

This document tracks the implementation progress of the Job Queue & Lifecycle Management feature as outlined in [JOB_QUEUE_PLAN.md](./JOB_QUEUE_PLAN.md).

## ✅ Phase 1: Job Persistence & Status Tracking (COMPLETE)

### What's Been Implemented

#### 1. Core Data Model (`src/opensmi/jobs.py`)

- **Job dataclass** with comprehensive lifecycle tracking:
  - 8-character UUID-based job IDs
  - Command storage (single and one-to-one modes)
  - GPU assignment tracking
  - Full status lifecycle: queued → running → done/failed/cancelled
  - Timestamp tracking (submitted, started, finished)
  - User tracking (OPERATOR who submitted)
  - Restart policies (never, on-failure, always)
  - Retry counting and limits
  - User-defined tags

#### 2. Persistent Storage

- **Job store functions**:
  - `load_jobs()` - Load all jobs from `~/.opensmi/jobs.json`
  - `save_jobs()` - Persist jobs with atomic writes
  - `upsert_job()` - Insert or update a job
  - `get_job()` - Retrieve job by ID

- **Storage location**: `~/.opensmi/jobs.json`
- **Format**: JSON with schema validation
- **Survivability**: Jobs persist across TUI restarts

#### 3. Job Health Monitoring

- **`check_job_alive()`** - SSH-based tmux session health checks
- Verifies if tmux sessions are still running on remote nodes
- Used for status updates and auto-restart policies

#### 4. Job Lifecycle Operations

- **`cancel_job()`** - Cancel running or queued jobs
  - Kills tmux sessions for running jobs
  - Marks queued jobs as cancelled immediately
- **`retry_job()`** - Create new job from failed/cancelled job
  - Preserves original configuration
  - Generates new job ID for tracking

#### 5. CLI Commands

All commands available via `opensmi job <subcommand>`:

| Command | Description | Example |
|---------|-------------|---------|
| `list` | List all jobs with filtering | `opensmi job list --status running` |
| `submit` | Submit a new job | `opensmi job submit gpu01 --gpus 0,1 --command "python train.py"` |
| `status` | Show detailed job status | `opensmi job status a3f2b1c4` |
| `cancel` | Cancel a running/queued job | `opensmi job cancel a3f2b1c4` |
| `retry` | Retry a failed job | `opensmi job retry a3f2b1c4` |
| `delete` | Remove job from history | `opensmi job delete a3f2b1c4` |
| `log` | Fetch tmux session output | `opensmi job log a3f2b1c4 --lines 100` |

**Submit Options**:
- `--gpus`: Comma-separated GPU indices (e.g., `0,1,2`)
- `--auto-gpus N`: Auto-select N GPUs (queued mode)
- `--queue`: Queue for auto-dispatch when GPUs available
- `--tmux`: Use tmux sessions (default)
- `--restart`: Restart policy (`never`|`on-failure`|`always`)
- `--json`: Output JSON for scripting

#### 6. Testing

- ✅ All existing tests pass (155 tests)
- ✅ CLI commands verified functional
- ✅ Job persistence verified
- ✅ Syntax validation complete

### Usage Examples

```bash
# Submit immediate job
opensmi job submit gpu01 --gpus 0,1 --command "python train.py --epochs 100"

# Submit queued job (auto-dispatch)
opensmi job submit --auto-gpus 2 --command "python train.py" --queue

# List running jobs
opensmi job list --status running

# View job details
opensmi job status a3f2b1c4

# Fetch job logs
opensmi job log a3f2b1c4 --lines 50

# Cancel job
opensmi job cancel a3f2b1c4

# Retry failed job
opensmi job retry a3f2b1c4
```

### Files Changed

- `src/opensmi/jobs.py` (new) - 260 lines
- `src/opensmi/cli.py` - Added job subcommands (300+ lines added)

### Git Commit

```
c843a74 feat(jobs): add Job data model and CLI commands for job management
```

---

## 🚧 Phase 2: Jobs Tab UI (PENDING)

### What Needs to Be Done

1. **Register Jobs tab** in TUI tab registry
2. **Job list view** with status icons and filtering
3. **Job detail view** with full information
4. **Keyboard shortcuts** for navigation and actions
5. **Status polling** to update job states in real-time

### Implementation Notes

- TUI is TypeScript-based using OpenTUI framework
- Main file: `tui/index.ts` (4365 lines)
- Tab registry: `tui/tabRegistry.ts`
- Need to shell out to `opensmi job list --json` for data
- Follow existing tab patterns (Dashboard, My GPU View)

---

## 🚧 Phase 3: Job Queue with Auto-dispatch (PENDING)

### What Needs to Be Done

1. **Queue mode toggle** in command runner
2. **Dispatcher loop** in TUI poll cycle
3. **GPU availability finder** using existing ranker
4. **FIFO queue processing** with priority support

### Key Features

- "GPU 비면 내 학습 자동으로 시작" - Auto-start when GPUs become available
- Dispatcher checks every poll cycle (configurable interval)
- Respects user allocations and GPU preferences
- Queue priority: FIFO by default, extensible for user priority

---

## 🚧 Phase 4: Job Lifecycle Management (PENDING)

### What Needs to Be Done

1. **Auto-restart watchdog** in poll cycle
2. **Restart policy enforcement** (on-failure, always)
3. **Exit code tracking** from tmux sessions
4. **Job cleanup** for completed jobs

### Key Features

- Monitors tmux session health
- Auto-retries based on restart policy
- Respects retry limits (max_retries)
- Cleans up stale tmux sessions

---

## Current State Summary

### ✅ Working Now

- Job submission via CLI (immediate execution)
- Job persistence across restarts
- Job status tracking
- Job cancellation
- Job retry
- Job logs from tmux
- Full CLI interface

### 🚧 Not Yet Implemented

- TUI Jobs tab UI
- Auto-dispatch queue mode
- Auto-restart watchdog
- TUI integration with command runner

### 🎯 Next Steps

1. Implement Jobs tab in TUI for visibility
2. Add queue mode to command runner
3. Implement dispatcher loop for auto-scheduling
4. Add watchdog for auto-restart

---

## Design Philosophy

Following the Karpathy guidelines from the plan:

1. **Think Before Coding** - Phase 1 carefully designed data model
2. **Simplicity First** - JSON file storage (no database)
3. **Surgical Changes** - Minimal CLI modifications, new module
4. **Goal-Driven Execution** - Each phase has clear success criteria

All changes maintain backward compatibility. No breaking changes to existing functionality.
