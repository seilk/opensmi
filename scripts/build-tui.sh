#!/usr/bin/env bash
set -euo pipefail
#
# Build the TUI as a standalone binary for the current platform.
# Cross-compilation requires platform-native OpenTUI packages,
# so multi-platform builds should use CI (see .github/workflows/release.yml).
#
# Usage:
#   ./scripts/build-tui.sh              # → dist/opensmi-tui
#   ./scripts/build-tui.sh custom-name  # → dist/custom-name
#

cd "$(dirname "${BASH_SOURCE[0]}")/.."

outname="${1:-opensmi-tui}"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "$arch" in
  x86_64)  arch="x64" ;;
  aarch64|arm64) arch="arm64" ;;
esac

suffix="${os}-${arch}"
outfile="dist/${outname}-${suffix}"

echo "Building TUI binary: ${outfile}"
echo "Platform: ${os}/${arch}"

mkdir -p dist

(cd tui && bun install --frozen-lockfile)

bun build \
  --compile \
  --production \
  --outfile="${outfile}" \
  tui/index.ts

echo ""
ls -lh "${outfile}"
echo "✅ Done: ${outfile}"
