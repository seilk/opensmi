# Releasing micvgpus

This project uses **Semantic Versioning** and **git tags**.

## Version locations

Version must be identical in both files:
- `pyproject.toml` → `[project].version`
- `micvgpus/__init__.py` → `__version__`

Run `python scripts/verify_version.py` to check consistency.

## Versioning rules

- `MAJOR`: breaking changes (CLI flags, config schema, TUI keybindings)
- `MINOR`: new features, backwards-compatible
- `PATCH`: bug fixes, performance, docs

## Release artifacts

Each tagged release produces:

| Artifact | Description |
|----------|-------------|
| `micvgpus-X.Y.Z.tar.gz` | Python sdist |
| `micvgpus-X.Y.Z-py3-none-any.whl` | Python wheel |
| `micvgpus-tui-linux-x64` | TUI binary (Linux x64) |
| `micvgpus-tui-linux-arm64` | TUI binary (Linux ARM64) |
| `micvgpus-tui-darwin-arm64` | TUI binary (macOS Apple Silicon) |
| `micvgpus-tui-darwin-x64` | TUI binary (macOS Intel) |

## Full release process

### 1. Update changelog

Edit `CHANGELOG.md`:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Changed / Fixed
- ...
```

### 2. Bump version

```bash
# pyproject.toml
version = "X.Y.Z"

# micvgpus/__init__.py
__version__ = "X.Y.Z"
```

### 3. Run checks

```bash
./scripts/check.sh
```

### 4. Commit + tag + push

```bash
git commit -am "chore(release): vX.Y.Z"
./scripts/release.sh X.Y.Z
git push origin main --tags
```

### 5. Verify

GitHub Actions will:
1. Run CI (Python 3.8-3.12 + TUI typecheck)
2. Build sdist + wheel
3. Cross-compile TUI binaries on 4 platforms
4. Create a GitHub Release with all artifacts

### 6. (Optional) Publish to PyPI

Uncomment the PyPI step in `.github/workflows/release.yml` and add `PYPI_API_TOKEN` secret.

## Local TUI build

Build for your current platform only:

```bash
./scripts/build-tui.sh
# → dist/micvgpus-tui-<os>-<arch>
```
