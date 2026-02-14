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

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree not clean. Commit or stash first." >&2
  git status --porcelain >&2
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
