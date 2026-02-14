# Security Policy

## Reporting a Vulnerability

If you discover a security issue, please **do not** open a public GitHub issue.

Instead, contact the maintainers privately (recommended) or use GitHub's private vulnerability reporting if enabled.

## Operational note

`opensmi` can execute remote commands via SSH (including signaling processes). Treat the machine where you run it as an admin workstation.

- Prefer SSH keys
- Limit admin access
- Use `sudoers` carefully if enabling passwordless sudo
