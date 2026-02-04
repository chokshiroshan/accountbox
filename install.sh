#!/usr/bin/env bash
set -euo pipefail

# macOS-first installer.
# - Installs `accountbox` to ~/.local/bin by default (no sudo).
# - Checks for a Docker-compatible runtime; recommends OrbStack for performance.

PREFIX_BIN="${PREFIX_BIN:-$HOME/.local/bin}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf "%s\n" "$*"; }
err() { printf "ERROR: %s\n" "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This installer is currently macOS-focused. You can still install via npm: npm i -g accountbox"
  exit 1
fi

mkdir -p "$PREFIX_BIN"

# Link the node CLI entrypoint
install -m 0755 "$SRC_DIR/bin/accountbox.js" "$PREFIX_BIN/accountbox"

say "Installed accountbox to: $PREFIX_BIN/accountbox"

if command -v docker >/dev/null 2>&1; then
  if docker ps >/dev/null 2>&1; then
    say "Docker runtime: OK"
  else
    say "Docker CLI found, but runtime not reachable yet. Start OrbStack/Docker Desktop and retry: docker ps"
  fi
else
  say "No docker-compatible runtime found (docker not in PATH)."
  say "Recommended (fast on macOS): OrbStack"
  say "If you have Homebrew: brew install --cask orbstack"
  say "Then start OrbStack and confirm: docker ps"
fi

say "Done. Ensure $PREFIX_BIN is on PATH (e.g., add to ~/.zshrc):"
say "  export PATH=\"$PREFIX_BIN:\$PATH\""
