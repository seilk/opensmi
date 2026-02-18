# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/seilk/opensmi/releases/tag/v0.2.0
[0.1.1]: https://github.com/seilk/opensmi/releases/tag/v0.1.1
[0.1.0]: https://github.com/seilk/opensmi/releases/tag/v0.1.0
