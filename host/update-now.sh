#!/usr/bin/env bash
# Run a local oh-my-tokens update from SwiftBar/xbar. All output goes to a log so
# the menu command never pollutes SwiftBar's plugin output.
set -euo pipefail

find_node() {
  for c in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  for n in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$n" ] && { echo "$n"; return 0; }
  done
  return 1
}

NODE="$(find_node)"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$HOME/.oh-my-tokens/update.log"
mkdir -p "$(dirname "$LOG")"

{
  echo "==> $(date -u +"%Y-%m-%dT%H:%M:%SZ") update requested"
  "$NODE" "$DIR/update-manager.js" apply
} >>"$LOG" 2>&1
