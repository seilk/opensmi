#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python_cmd=${OPENSMI_PYTHON:-python3}

echo "== Repo hygiene =="

# Fail if build artifacts are tracked.
if git ls-files dist | grep -q .; then
  echo "ERROR: files under dist/ are tracked by git. Release artifacts must not be committed." >&2
  git ls-files dist >&2
  exit 2
fi
if git ls-files tui/dist | grep -q .; then
  echo "ERROR: files under tui/dist/ are tracked by git. Do not commit TUI binaries." >&2
  git ls-files tui/dist >&2
  exit 2
fi


# Fail if a real config file is accidentally committed.
if git ls-files --error-unmatch opensmi.json >/dev/null 2>&1; then
  echo "ERROR: opensmi.json is tracked by git. Do not commit real cluster topology." >&2
  echo "Use opensmi.example.json as the template and keep opensmi.json untracked." >&2
  exit 2
fi

# Legacy name should also never be committed.
if git ls-files --error-unmatch config.json >/dev/null 2>&1; then
  echo "ERROR: config.json is tracked by git (legacy config name). Remove it." >&2
  exit 2
fi

echo

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
