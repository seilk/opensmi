# Contributing

Thanks for your interest in contributing!

## Development setup

### Python (CLI)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

### TUI (OpenTUI)

```bash
cd tui
bun install
bun index.ts
```

## Running checks

```bash
./scripts/check.sh
```

## Commit style

Recommended: Conventional Commits (helps automation later)
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `chore:` tooling/maintenance

## Pull requests

- Keep PRs small and focused
- Update docs when changing UX/commands
- Add or update tests for bug fixes (where possible)
