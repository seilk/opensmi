#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python_cmd=${OPENSMI_PYTHON:-python3}

echo "== Python checks =="
"$python_cmd" -V

# Ensure version consistency
"$python_cmd" scripts/verify_version.py

# Bytecode compile
"$python_cmd" -m compileall -q opensmi

# Unit tests (stdlib)
"$python_cmd" -m unittest -v

echo

echo "== TUI (TypeScript) checks =="
if command -v bun >/dev/null 2>&1; then
  (cd tui && bun install --frozen-lockfile && bun run tsc --noEmit)
else
  echo "bun not found; skipping TUI checks" >&2
fi

echo

echo "✅ All checks passed."
