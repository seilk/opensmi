# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/seil/opensmi/releases/tag/v0.1.0
