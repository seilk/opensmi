#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$ROOT_DIR/.build/opensmi-pyz"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR"

# Copy the package
cp -R "$ROOT_DIR/src/opensmi" "$BUILD_DIR/opensmi"

# Add a top-level __main__.py for zipapp
cat > "$BUILD_DIR/__main__.py" <<'PY'
from opensmi.cli import main

if __name__ == "__main__":
    main()
PY

python3 -m zipapp "$BUILD_DIR" \
  -p "/usr/bin/env python3" \
  -o "$DIST_DIR/opensmi.pyz"

echo "Built: $DIST_DIR/opensmi.pyz"
