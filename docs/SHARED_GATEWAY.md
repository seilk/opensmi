# Shared Gateway — Multi-User GPU Access

Running opensmi on a shared bastion/gateway server lets your entire team access
a GPU cluster without each user managing SSH keys to every node.

## Architecture

```
Team member laptops
  └─ ssh gateway-server
        └─ opensmi (TUI or CLI)
              │  SSH + nvidia-smi (agentless)
              ▼
        GPU nodes (no agent installed)
```

Admin sets up SSH keys **once** on the gateway.  
Users only need SSH access to the gateway — nothing else.

---

## Setup (Admin)

### 1. Install opensmi on the gateway server

```bash
pip install opensmi
# or: pip install opensmi[tui]  # includes TUI binary
```

### 2. Configure SSH keys (gateway → GPU nodes)

```bash
# On the gateway server, generate a key pair if needed
ssh-keygen -t ed25519 -f ~/.ssh/opensmi_id -N ""

# Copy public key to each GPU node
for node in gpu01 gpu02 gpu03; do
  ssh-copy-id -i ~/.ssh/opensmi_id.pub user@$node
done
```

### 3. Create opensmi.json

```json
{
  "cluster_name": "my-datacenter",
  "nodes": [
    { "alias": "gpu01", "address": "10.0.1.1", "user": "ubuntu", "ssh_key": "~/.ssh/opensmi_id" },
    { "alias": "gpu02", "address": "10.0.1.2", "user": "ubuntu", "ssh_key": "~/.ssh/opensmi_id" },
    { "alias": "gpu03", "address": "10.0.1.3", "user": "ubuntu", "ssh_key": "~/.ssh/opensmi_id" }
  ]
}
```

Place at `~/.opensmi/opensmi.json` or set `OPENSMI_CONFIG=/path/to/opensmi.json`.

### 4. (Optional) Keep TUI running persistently

```bash
# Run in a shared tmux session so anyone can attach
tmux new-session -d -s opensmi 'opensmi-tui'
tmux attach -t opensmi
```

---

## User Access

Each team member needs only SSH access to the gateway:

```bash
# Interactive TUI
ssh gateway-server -t 'opensmi-tui'

# Submit a job (CLI)
ssh gateway-server 'opensmi job submit gpu01 --gpus 0 --command "python train.py"'

# Auto-assign GPUs
ssh gateway-server 'opensmi job submit --auto-gpus 2 --command "python train.py" --queue'

# Check job status
ssh gateway-server 'opensmi job list'
```

Tip: add a shell alias on your laptop:

```bash
alias opensmi='ssh gateway-server opensmi'
alias opensmi-tui='ssh gateway-server -t opensmi-tui'
```

---

## Fairness & Resource Limits

opensmi tracks GPU allocations per user via the allocation system.  
Admins can set explicit allocations to prevent one user from taking all GPUs:

```bash
# Reserve gpu01:GPU0 for alice, gpu01:GPU1 for bob
opensmi alloc set gpu01 0 alice
opensmi alloc set gpu01 1 bob
```

For queue-based fairness (auto-GPU assignment), the job queue dispatches
in FIFO order — first submitted, first served.

---

## What's Next: HTTP API Mode (Future)

The current gateway pattern requires SSH access to the gateway server.
A future `opensmi serve` mode will expose an HTTP API so users can
submit jobs directly from their laptops without SSH:

```bash
# Future: no SSH needed
opensmi --remote http://gateway:8080 job submit --auto-gpus 2 --command "python train.py"
```

Tracked in: [GitHub Issue #7](https://github.com/seilk/opensmi/issues/7)

**Security requirements for HTTP mode** (when implemented):
- TLS mandatory — no plaintext job submission
- Token or mTLS authentication — no open endpoints
- Single-writer daemon for job state — no race conditions on concurrent submit

---

## Supported Configuration

| Pattern | Supported |
|---------|-----------|
| Single user, personal workstation | ✅ |
| Shared gateway server (this guide) | ✅ |
| Slurm-managed cluster | ❌ (see [scope](../README.md#scope--supported-environments)) |
| HTTP API / remote client mode | 🔜 (planned) |
