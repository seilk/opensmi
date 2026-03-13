# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-03-14

### Added
- **Onboarding wizard**: Added Slurm login-node SSH port capture and persistence during `opensmi onboard`
- **Onboarding wizard**: Added safe WSL SSH config copy prompt when WSL has no `~/.ssh/config`

### Changed
- **Onboarding wizard**: Replaced letter-based discrete choices with left/right selection and Enter confirmation
- **GPU detail view**: Process commands now wrap across continuation lines instead of truncating to a short fixed width

### Fixed
- **Slurm submit popup**: Removed the synthetic default QoS entry and cycle only real QoS values
- **Slurm submit popup**: Distinguish real QoS lookup failures from partitions that simply expose no QoS
- **Slurm submit popup**: Thread configured Slurm login-node SSH ports through lookup, submit, poll, and cancel paths

---

## [0.4.2] - 2026-03-10

### Fixed
- **`opensmi alloc set/seed`**: Fixed `ImportError` crash caused by stale import of removed `_now_iso` from `allocations` module
- **`load_allocations`**: Acquire advisory lock before reading to prevent torn reads under concurrent CLI + TUI access

### Performance
- **Collector**: Single-pass section marker index replaces 5× O(n) scans in `_parse_remote_output`
- **Collector**: `_int_or_none`/`_float_or_none` hoisted out of GPU parse loop (no per-iteration function creation)
- **Collector**: `_redact_cmdline` replaced O(tokens×flags) nested loop with frozenset O(1) lookup
- **Violations**: Pre-grouped `(gpu_uuid, user)→pids` index eliminates O(p×g×u) scan
- **GPU ranker**: `select_gpus_per_node` now makes a single `rank_gpus` call instead of N separate full-snapshot passes

### Refactored
- `_KST`/`_now_iso` deduplicated into `state.now_kst_iso()` (was copied in `allocations`, `collector`, `slurm`)
- TUI: Removed dead `updateGpuIdleTracking` export (logic already inlined in `pollCluster`)
- TUI: Extracted `_sortNodesByAlias` helper; removed duplicated sort in `pollCluster`/`pollExtraCluster`
- TUI: Replaced modulo-counter anti-pattern with direct hourly `setInterval` for cleanup
- TUI: Flattened unreachable nested try-catch in `loadAllocations`

---

## [0.2.4] - 2026-02-20

### Fixed
- **`opensmi update`**: pyz wrapper was still regenerated as `#!/usr/bin/env bash` after update — now correctly writes `#!/bin/sh` (POSIX). zsh/bash/sh users all get the fixed wrapper after running `opensmi update`.

---

## [0.2.3] - 2026-02-20

### Added
- **TUI header**: `user@hostname` now shown in the top bar

### Changed
- **TUI header**: Removed `Expiring<24h` field

### Fixed
- **install.sh / install-cli.sh**: Shell compatibility overhaul
  - pyz wrapper POSIX-ified (`#!/bin/sh`, no bash required)
  - Shell auto-detection: precise PATH hint per shell (zsh/bash/fish/sh)
  - Interactive TTY: auto-append to profile with `[Y/n]` prompt
  - Bash guard: clear error when run with `sh` by mistake

---

## [0.2.2] - 2026-02-20

### Added
- **`is_local_node()`**: Bypass SSH for local GPU server — faster execution, no SSH config needed
- **Jobs tab**: tmux session cleanup action for finished sessions
- **Jobs tab**: Retry selected session command from detail view

### Fixed
- **Setup**: Block dispatch when setup save fails (prevents data loss)
- **Setup**: Persist setup edits before job submit/dispatch

---

## [0.2.1] - 2026-02-20

### Fixed
- **Security**: Eliminate OPERATOR injection in Python inline scripts — switched to tmpFile JSON pattern (P0-1)
- **Watchdog**: nvidia-smi fallback when PID check reports all-dead — prevents DataParallel false termination (P1-2)
- **Dispatch**: dispatch+watchdog now run on all tabs, not just dashboard/jobs — jobs no longer stall on setup/help screen (P1-5)
- **Cleanup**: Stale tmpFiles older than 5 min auto-removed on TUI startup (P1-1)
- **Stability**: Kill orphaned tmux sessions on partial execution failure (P1-6)
- **Portability**: Guard `fcntl` import for Windows compatibility (P1-4)

### Changed
- Added CHANGELOG entry for v0.2.0 (was missing at release)
- Added `doc-should-fix/` to `.gitignore`

## [0.2.0] - 2026-02-19

### Added
- **Job Queue System**: Full lifecycle management — `job submit`, `job list`, `job status`, `job cancel`, `job retry`, `job delete`, `job log`
- **TUI Jobs Tab**: View queued/running/completed jobs, auto-dispatch to available GPUs
- **Setup Tab**: Per-node env config (`env_manager`, `env_name`, `work_dir`) editable from TUI
- **Watchdog**: PID-based liveness monitoring with 3-strike confirmation, 10s poll interval
- **Log Viewer**: View live process output via `tmux capture-pane` from job detail
- **Runner Pane**: Integrated terminal pane (`ctrl+x ↓`) for direct command execution
- **Auto-dispatch**: Queued jobs auto-assigned to idle GPUs based on ranking
- **Node env config**: `env_manager` (conda/venv/miniconda), `env_name`, `work_dir` per node
- **`opensmi update`**: Self-update command for existing installations
- **`opensmi onboard --nodes N`**: Quick setup for new clusters
- **Dynamic UI sizing**: All views adapt to terminal width/height
- **Mouse support**: Drag-to-copy (OSC52), double-click navigation, scrollbar
- **Multi-user allocation**: Comma-separated user assignment + Tab completion

### Changed
- **Architecture**: Tmux sessions created locally on opensmi machine (not remote nodes)
- **Execution**: Replaced bash wrapper with Python launcher (zero shell quoting issues)
- **Config**: `config.json` → `opensmi.json`, `opensmi/` → `src/opensmi/` (src-layout)
- **Node alias sanitization**: `#`, `:` in aliases auto-replaced with `-` at config load
- **Admin checks**: Config admin + remote node sudo-group membership (dual verification)

### Fixed
- Watchdog false-dead: SSH remote shell `#` comment interpretation, zsh compatibility
- Retry preserves original GPU assignment instead of auto-reassigning
- Session name sanitization (`;`, `` ` ``, `#` → safe chars)
- Setup/help blank screen rendering
- Backspace captured as navigation (P0 UX bug)
- SSH stability in tmux wrapper + retry triggers immediate dispatch

### Security
- OPERATOR value passed via tmpFile JSON (no string interpolation into Python `-c`)
- Shell injection vectors sanitized in session names and file paths
- `StrictHostKeyChecking=accept-new` for SSH (TOFU model)

## [0.1.1] - 2026-02-15

### Added
- Node detail: show per-PID runtime (best-effort from `/proc`)

## [0.1.0] - 2026-02-15

### Added
- Agentless cluster polling over SSH (`nvidia-smi` + `/proc` owner mapping)
- CLI:
  - `init` (default, wizard, import from `~/.ssh/config`)
  - `poll` (plain + JSON)
  - `alloc` (`list`, `set`, `clear`, `seed`)
  - `violations`
  - `kill` (best-effort remote signaling)
  - `watch` (Slack webhook notifications)
- TUI (Bun + OpenTUI): dashboard, node detail, allocation editor, kill action

[0.2.4]: https://github.com/seilk/opensmi/releases/tag/v0.2.4
[0.4.3]: https://github.com/seilk/opensmi/releases/tag/v0.4.3
[0.4.2]: https://github.com/seilk/opensmi/releases/tag/v0.4.2
[0.2.3]: https://github.com/seilk/opensmi/releases/tag/v0.2.3
[0.2.2]: https://github.com/seilk/opensmi/releases/tag/v0.2.2
[0.2.1]: https://github.com/seilk/opensmi/releases/tag/v0.2.1
[0.2.0]: https://github.com/seilk/opensmi/releases/tag/v0.2.0
[0.1.1]: https://github.com/seilk/opensmi/releases/tag/v0.1.1
[0.1.0]: https://github.com/seilk/opensmi/releases/tag/v0.1.0
