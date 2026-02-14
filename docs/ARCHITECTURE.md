# Architecture

`opensmi` is split into two layers:

1. **Backend (Python CLI)**
   - Poll nodes via SSH
   - Parse `nvidia-smi` output
   - Store allocations (JSON today; can migrate to SQLite)
   - Compute violations
   - Optional notifications (Slack)

2. **Frontend (TUI, Bun + OpenTUI)**
   - Renders dashboard/detail views
   - Calls the Python CLI for actions (`alloc set/clear`, `kill`)

## Agentless polling

The backend runs a small bash script over SSH:
- reads GPU inventory
- reads active compute processes
- maps PID → Linux user via `/proc/<pid>`

## State

Default state dir: `~/.opensmi/`
- `opensmi.json` (cluster topology)
- `allocations.json` (GPU assignments)

State dir is configurable via:
- `--state-dir`
- `OPENSMI_STATE_DIR`

## Safety notes

- `kill` is best-effort.
- Killing other users typically requires passwordless sudo or running as root.
