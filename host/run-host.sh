#!/usr/bin/env bash
# Wrapper Chrome launches as the native messaging host. Chrome gives child
# processes a minimal PATH, so resolve node explicitly.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN="$(command -v node || true)"
if [ -z "${NODE_BIN}" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "oh-my-tokens host: node not found on PATH" >&2
  exit 1
fi

# Log host stderr so a failed launch ("Native host has exited") is diagnosable.
# stdout is reserved for Chrome's length-prefixed native-messaging protocol.
mkdir -p "${HOME}/.oh-my-tokens" 2>/dev/null || true
exec "${NODE_BIN}" "${DIR}/native-host.js" "$@" 2>>"${HOME}/.oh-my-tokens/host.log"
