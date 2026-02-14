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
| `a` | Allocate GPU to user |
| `x` | Clear allocation |
| `Shift+K` | Kill violator processes |
| `r` | Refresh data |
| `?` | Help |
| `Esc` | Back |
| `q` | Quit |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSMI_PYTHON` | `python3` | Python interpreter path |
| `OPENSMI_STATE_DIR` | `~/.opensmi` | State directory |
