# opensmi TUI

Interactive terminal dashboard for `opensmi`, built with [Bun](https://bun.sh) and [OpenTUI](https://github.com/nicholasgasior/opentui).

## Requirements

- [Bun](https://bun.sh) v1.0+
- A working `opensmi` Python CLI (the TUI shells out to `python3 -m opensmi poll --json`)

## Install & Run

```bash
cd tui
bun install
bun index.ts
```

Or from the project root:

```bash
make tui
```

## Keybindings

| Key | Action |
|-----|--------|
| `↑`/`↓` or `j`/`k` | Navigate |
| `Enter` | Open node detail (select GPU) |
| `l` | Launch command with auto GPU assignment |
| `a` | Allocate GPU to user |
| `x` | Clear allocation |
| `Shift+K` | Kill violator processes |
| `r` | Refresh data |
| `?` | Help |
| `Esc` | Back |
| `q` | Quit |

## Command Runner

Press `l` to open the Command Runner pane at the bottom of the dashboard/detail screen. The runner provides automatic GPU selection and command execution with full orchestration:

### Features

- **Auto GPU Selection**: Automatically ranks and selects the best available GPUs based on:
  1. Last used time (never-used GPUs prioritized)
  2. Active process count (fewer is better)
  3. GPU utilization (lower is better)
  4. GPU index (ascending)

- **Execution Modes** (toggle with `Tab`):
  - **direct**: Run command directly in background
  - **tmux**: Run in tmux session (create or reuse)

- **Distribution Modes** (toggle with `Shift+Tab`):
  - **single**: One command across N GPUs
  - **one-to-one**: Different command per GPU (multi-line input)

### Keybindings

- `l` - Open runner pane
- `Ctrl+R` - Toggle runner open/close
- `Ctrl+J` / `Ctrl+K` - Decrease/increase pane height
- `Ctrl+L` - Maximize runner toggle
- `Tab` - Toggle execution mode (direct/tmux)
- `Shift+Tab` - Toggle distribution mode (single/one-to-one)
- `+`/`-` - Adjust GPU count
- `Enter` - Execute command

### Usage

1. Press `l` or `Ctrl+R` to open the runner pane
2. Enter command(s) - supports multiline paste
3. Adjust GPU count with `+`/`-`
4. Toggle modes with `Tab` (execution) and `Shift+Tab` (distribution)
5. Review preflight checks (tmux installed, command valid, GPUs available)
6. Press `Enter` to execute

The pane shows:
- GPU selection reasoning (e.g., "idle GPU, no active processes")
- Preflight validation with hints on failures
- State machine: QUEUED → PREPARING → SENT → RUNNING / FAILED
- Status strip with start time, tmux session, attach command, stderr preview

### Examples

**Single command, 2 GPUs, direct mode:**
```
Command: python train.py --epochs 100
Number of GPUs: 2
```
Executes: `CUDA_VISIBLE_DEVICES=0,1 python train.py --epochs 100`

**One-to-one mode, 3 GPUs, tmux:**
```
Command 1: python train.py --fold 0
Command 2: python train.py --fold 1
Command 3: python train.py --fold 2
Number of GPUs: 3
Mode: tmux
```
Creates 3 separate tmux sessions, each with one GPU.

### Launch History

Launch history is saved to `~/.opensmi/launch_history.json` to optimize future GPU selection. GPUs with older last-used timestamps are prioritized.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSMI_PYTHON` | `python3` | Python interpreter path |
| `OPENSMI_STATE_DIR` | `~/.opensmi` | State directory |
