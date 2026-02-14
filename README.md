<p align="center">
  <h1 align="center">opensmi</h1>
  <p align="center">Agentless, multi-node GPU allocation manager (SSH + nvidia-smi only)</p>
  <p align="center">
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
    <img alt="Python" src="https://img.shields.io/badge/python-3.8%2B-blue.svg">
    <img alt="Dependencies" src="https://img.shields.io/badge/deps-zero-brightgreen.svg">
  </p>
</p>

<p align="center">
  <a href="README.kr.md">한국어</a>
</p>

<p align="center">
  <img src="assets/intro_A.png" width="31%" />
  <img src="assets/intro_B.png" width="31%" />
  <img src="assets/intro_C.png" width="31%" />
</p>
<p align="center"><sub><em>Screenshots are taken from a real environment; sensitive details (node names, usernames, file paths) have been redacted with Nano Banana.</em></sub></p>

---

`opensmi` helps admins monitor and enforce GPU allocations across a cluster **without installing anything on GPU nodes**.
It runs from your terminal, connects over SSH, and reads `nvidia-smi`.

## What you get

- **Interactive TUI**: dashboard, node detail, allocate/clear, kill violators
- **CLI**: poll, allocations, violations, watch (Slack alerts)
- **Policy**: unallocated GPU usage is a violation; `*` = open-to-all
- **No agents / daemons** on GPU nodes
- **Python stdlib only** (CLI has zero dependencies)

---

## Install

Recommended (installs both CLI + TUI):

```bash
curl -fsSL https://raw.githubusercontent.com/seilk/opensmi/main/scripts/install.sh | bash
```

This will place binaries in `~/.local/bin` (and print a PATH hint if needed).

**Requirements:** macOS/Linux, Python 3.8+, SSH access to GPU nodes with `nvidia-smi`.

### Update

Once installed:

```bash
opensmi update
```

If you hit GitHub API rate limits, set `OPENSMI_GITHUB_TOKEN`.

---

## Quick start

### 1) Create config

```bash
opensmi onboard
```

Config lives at:

- `~/.opensmi/opensmi.json` (default)

### 2) Run

- Launch the TUI:

```bash
opensmi
```

- Or use the CLI:

```bash
opensmi poll
opensmi violations
opensmi alloc list
opensmi --help
```

---

## Configuration

The config is plain JSON. Start from the template:

- [`opensmi.example.json`](opensmi.example.json)

(Keep your real `opensmi.json` private; the repo ignores it by default.)

Override state directory (for NFS/shared home):

```bash
export OPENSMI_STATE_DIR=/nfs/shared/.opensmi
```

---

## Docs

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Releasing: [`docs/RELEASING.md`](docs/RELEASING.md)
- Changelog: [`CHANGELOG.md`](CHANGELOG.md)

---

## Security notes

`opensmi` can execute remote commands over SSH (including process signals).
Treat the machine you run it on as an admin workstation.
See [`SECURITY.md`](SECURITY.md).

---

## License

MIT — see [`LICENSE`](LICENSE).
