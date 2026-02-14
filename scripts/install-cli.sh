#!/usr/bin/env bash
set -euo pipefail

# Installs a curl-friendly CLI launcher without requiring pip.
# Places:
#  - ~/.local/share/opensmi/opensmi.pyz
#  - ~/.local/bin/opensmi  (wrapper)

PREFIX_BIN="${HOME}/.local/bin"
PREFIX_SHARE="${HOME}/.local/share/opensmi"

mkdir -p "$PREFIX_BIN" "$PREFIX_SHARE"

# Expect opensmi.pyz to be in the same directory as this script (release asset layout)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SRC_PYZ="$SCRIPT_DIR/../dist/opensmi.pyz"

if [[ ! -f "$SRC_PYZ" ]]; then
  echo "ERROR: $SRC_PYZ not found. Build it first: ./scripts/build-cli-pyz.sh" >&2
  exit 1
fi

install -m 0755 "$SRC_PYZ" "$PREFIX_SHARE/opensmi.pyz"

cat > "$PREFIX_BIN/opensmi" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${OPENSMI_PYTHON:-python3}"
exec "$PYTHON_BIN" "${HOME}/.local/share/opensmi/opensmi.pyz" "$@"
SH
chmod 0755 "$PREFIX_BIN/opensmi"

echo "Installed opensmi CLI: $PREFIX_BIN/opensmi"
echo "Make sure $PREFIX_BIN is on your PATH."
