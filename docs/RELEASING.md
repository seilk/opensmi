# Releasing micvgpus

This project uses **Semantic Versioning** and **git tags**.

## Versioning rules

- `MAJOR`: breaking changes in CLI flags, config schema, TUI keybindings that users rely on
- `MINOR`: new features, backwards-compatible
- `PATCH`: bug fixes, performance, docs

## Pre-release checklist

1. Update `CHANGELOG.md`
2. Bump version in:
   - `pyproject.toml` (`[project].version`)
   - `micvgpus/__init__.py` (`__version__`)
3. Run checks:

```bash
./scripts/check.sh
```

## Create a release

```bash
git checkout main
git pull

# commit version + changelog
git commit -am "chore(release): vX.Y.Z"

git tag -a vX.Y.Z -m "vX.Y.Z"

git push origin main --tags
```

Then create a GitHub Release from the tag (or via `gh release create`).

## Optional: automate

You can automate releases with GitHub Actions (recommended):
- CI on PRs (`.github/workflows/ci.yml`)
- Release workflow on tags (`.github/workflows/release.yml`) to create GitHub Releases

Publishing to PyPI is optional; if you want it, add a `PYPI_API_TOKEN` secret and enable the job.
