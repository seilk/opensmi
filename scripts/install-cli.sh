#!/usr/bin/env bash
set -euo pipefail

# S3: bash check
if [ -z "${BASH_VERSION:-}" ]; then
  echo "error: this script requires bash." >&2
  exit 1
fi

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
#!/bin/sh
PYTHON_BIN="${OPENSMI_PYTHON:-python3}"
exec "$PYTHON_BIN" "${HOME%/}/.local/share/opensmi/opensmi.pyz" "$@"
SH
chmod 0755 "$PREFIX_BIN/opensmi"

echo "Installed opensmi CLI: $PREFIX_BIN/opensmi"

# S1: shell-aware PATH hint
if [[ ":$PATH:" != *":$PREFIX_BIN:"* ]]; then
  shell_bin="$(basename "${SHELL:-bash}")"
  case "$shell_bin" in
    zsh)  PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then PROFILE="$HOME/.bash_profile"
      else PROFILE="$HOME/.bashrc"; fi ;;
    fish) PROFILE="$HOME/.config/fish/config.fish" ;;
    *)    PROFILE="$HOME/.profile" ;;
  esac

  if [[ "$shell_bin" == "fish" ]]; then
    PATH_LINE="set -gx PATH \"$PREFIX_BIN\" \$PATH"
  else
    PATH_LINE="export PATH=\"$PREFIX_BIN:\$PATH\""
  fi

  echo "warning: '$PREFIX_BIN' is not in your PATH"
  echo "Add this to ${PROFILE}:"
  echo "  ${PATH_LINE}"
fi
