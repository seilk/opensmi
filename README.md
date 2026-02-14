<p align="center">
  <h1 align="center">micvgpus</h1>
  <p align="center">
    Agentless multi-node GPU allocation manager — SSH + nvidia-smi only.
  </p>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Python 3.8+" src="https://img.shields.io/badge/python-3.8%2B-blue.svg">
  <img alt="Zero Dependencies" src="https://img.shields.io/badge/deps-zero-brightgreen.svg">
</p>

---

**micvgpus** monitors and manages GPU allocations across a multi-node cluster
entirely from your admin terminal. No agents, no daemons, no databases —
just SSH and `nvidia-smi`.

- **Dashboard** — real-time cluster overview via CLI or interactive TUI
- **Allocation** — assign GPUs to users, track ownership, seed from live usage
- **Violation detection** — flag unauthorized GPU usage instantly
- **Kill** — signal violator processes remotely via SSH
- **Slack alerts** — automatic webhook notifications on violations
- **Agentless** — nothing installed on GPU nodes

## Quick Start

### Install

```bash
git clone https://github.com/<org-or-user>/micvgpus.git
cd micvgpus
pip install -e .
```

> **Zero dependencies.** micvgpus uses only the Python standard library.

### Initialize

```bash
# Interactive wizard (recommended)
micvgpus init --wizard

# Or import from SSH config
micvgpus init --from-ssh-config ~/.ssh/config

# Or generate default template and edit manually
micvgpus init
$EDITOR ~/.micvgpus/config.json
```

### Verify

```bash
micvgpus poll          # cluster dashboard (table)
micvgpus poll --json   # full JSON snapshot
```

### Allocate

```bash
# Seed allocations from current live GPU usage
micvgpus alloc seed --by admin

# Manually assign a GPU
micvgpus alloc set 'GPU-01' 0 alice --by admin

# Open a GPU to everyone
micvgpus alloc set 'GPU-01' 1 '*' --by admin

# List / clear
micvgpus alloc list
micvgpus alloc clear 'GPU-01' 0
```

### Monitor

```bash
# One-shot violation check
micvgpus violations

# Continuous watch + Slack alerts
micvgpus watch --interval 60 --slack-webhook https://hooks.slack.com/services/...
```

### TUI (Interactive Dashboard)

Requires [Bun](https://bun.sh):

```bash
cd tui && bun install && bun index.ts
```

| Key | Action |
|-----|--------|
| `↑↓` / `jk` | Navigate nodes / GPUs |
| `Enter` | Open node detail |
| `a` | Allocate selected GPU |
| `x` | Clear allocation |
| `Shift+K` | Kill violator processes |
| `r` | Refresh |
| `?` | Help |
| `Esc` | Back |
| `q` | Quit |

## Architecture

```
Admin Terminal
  ├─ micvgpus CLI (Python)     ← poll, alloc, violations, kill, watch
  ├─ TUI (Bun + OpenTUI)      ← interactive dashboard
  └─ SSH ──→ GPU Nodes         ← agentless data collection
               └─ nvidia-smi   ← GPU & process info

State: ~/.micvgpus/
  ├─ config.json               ← cluster topology
  └─ allocations.json          ← GPU assignments
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Configuration

`~/.micvgpus/config.json`:

```jsonc
{
  "cluster_name": "My-Cluster",
  "nodes": [
    { "alias": "GPU-01", "address": "10.0.0.1", "user": "admin" },
    { "alias": "GPU-02", "address": "10.0.0.2", "user": "admin" }
  ],
  "admins": { "master": "admin", "members": ["admin"] },
  "policy": {
    "require_allocation": true,
    "all_users_token": "*",
    "enforcement": "detect_only"
  }
}
```

Override state directory:

```bash
export MICVGPUS_STATE_DIR=/nfs/shared/.micvgpus
# or
micvgpus --state-dir /path/to/state poll
```

## Requirements

| Component | Requirement |
|-----------|-------------|
| **CLI** | Python 3.8+ (stdlib only) |
| **TUI** | [Bun](https://bun.sh) v1.0+ |
| **Nodes** | SSH key access, `nvidia-smi` installed |

### Optional

- **Passwordless sudo** on nodes — needed to kill other users' processes
- **Slack incoming webhook** — for violation notifications

## Policy

| Policy | Description |
|--------|-------------|
| `require_allocation: true` | Any GPU usage without an allocation record is a violation |
| `all_users_token: "*"` | Allocating `*` means the GPU is open to everyone |
| `enforcement: "detect_only"` | Default: detect and report only (no auto-kill) |

## Project Structure

```
micvgpus/
├── micvgpus/             # Python CLI package
│   ├── cli.py            # Argument parser + subcommands
│   ├── collector.py      # SSH + nvidia-smi polling
│   ├── allocations.py    # Allocation CRUD
│   ├── violations.py     # Violation detection
│   ├── config.py         # Config loading
│   ├── models.py         # Data models
│   ├── state.py          # State directory management
│   └── sshutil.py        # SSH helpers (kill)
├── tui/                  # Interactive TUI (Bun + OpenTUI)
│   └── index.ts
├── tests/                # Unit tests (stdlib unittest)
├── scripts/              # CI / release helpers
├── docs/                 # Additional documentation
├── pyproject.toml
├── Makefile
└── CHANGELOG.md
```

## Development

```bash
# Install in editable mode
pip install -e .

# Run all checks (Python compile + tests + TUI typecheck)
make check

# Run tests only
make test

# Run TUI
make tui
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Releasing

Versioned with [Semantic Versioning](https://semver.org). See [docs/RELEASING.md](docs/RELEASING.md) for the full process.

```bash
# Tag a release
./scripts/release.sh 0.2.0
git push origin main --tags
```

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## Security

`micvgpus` executes remote commands via SSH. Treat the admin machine accordingly.
See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
