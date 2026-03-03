#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v git >/dev/null 2>&1; then
  echo "git not found" >&2
  exit 2
fi

version=${1:-}
if [ -z "$version" ]; then
  echo "Usage: ./scripts/release.sh X.Y.Z" >&2
  exit 2
fi

tag="v${version}"

# ── Version bump ───────────────────────────────────────────────────
# Automatically update version strings in source files before tagging.

INIT_FILE="src/opensmi/__init__.py"
TOML_FILE="pyproject.toml"

old_init=$(grep -oP '(?<=__version__ = ")[^"]+' "$INIT_FILE" 2>/dev/null || \
           sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$INIT_FILE")
old_toml=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$TOML_FILE" | head -1)

if [ "$old_init" != "$version" ] || [ "$old_toml" != "$version" ]; then
  echo "Bumping version: $old_init → $version"

  # __init__.py
  sed -i.bak "s/__version__ = \"${old_init}\"/__version__ = \"${version}\"/" "$INIT_FILE"
  rm -f "${INIT_FILE}.bak"

  # pyproject.toml (only the project version line, not dependency versions)
  sed -i.bak "0,/^version = \"${old_toml}\"/s//version = \"${version}\"/" "$TOML_FILE"
  rm -f "${TOML_FILE}.bak"

  new_init=$(sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$INIT_FILE")
  new_toml=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$TOML_FILE" | head -1)

  if [ "$new_init" != "$version" ]; then
    echo "ERROR: Failed to bump $INIT_FILE (got '$new_init', expected '$version')" >&2
    exit 2
  fi
  if [ "$new_toml" != "$version" ]; then
    echo "ERROR: Failed to bump $TOML_FILE (got '$new_toml', expected '$version')" >&2
    exit 2
  fi

  git add "$INIT_FILE" "$TOML_FILE"
  git commit -m "chore: bump version to ${version}"
  echo "✅ Version bumped and committed"
else
  echo "Version already at $version — no bump needed"
fi

# ── Pre-tag checks ─────────────────────────────────────────────────

# Ensure clean working tree (after version bump commit)
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash first." >&2
  git status --porcelain >&2
  exit 2
fi

# Final sanity: verify all version sources agree
final_init=$(sed -n 's/^__version__ = "\([^"]*\)"/\1/p' "$INIT_FILE")
final_toml=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$TOML_FILE" | head -1)

if [ "$final_init" != "$version" ] || [ "$final_toml" != "$version" ]; then
  echo "ERROR: Version mismatch detected before tagging!" >&2
  echo "  __init__.py:   $final_init" >&2
  echo "  pyproject.toml: $final_toml" >&2
  echo "  expected:       $version" >&2
  exit 2
fi

# Run checks
./scripts/check.sh

# Create annotated tag
if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Tag already exists: $tag" >&2
  exit 2
fi

git tag -a "$tag" -m "$tag"

echo "✅ Created tag $tag"

echo "Next:"

echo "  git push origin main --tags"

echo "Then create a GitHub Release for $tag (or use: gh release create $tag)."
