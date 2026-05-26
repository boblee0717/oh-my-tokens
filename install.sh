#!/usr/bin/env bash
# One-command setup for oh-my-tokens (macOS).
#
# Usage:
#   ./install.sh [--browser chrome|beta|canary|chromium|edge] [--deepseek-key sk-...] [--launch]
#
# Does everything that can be scripted:
#   - registers the Native Messaging host (with the fixed Extension ID)
#   - optionally writes the DeepSeek key to ~/.oh-my-tokens/config.json
#   - with --launch, relaunches Chrome with the extension preloaded
#
# The one step Chrome won't allow from the CLI is loading an unpacked extension; without
# --launch this script prints that single manual step at the end.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="obmkhlamcmbmacadoolbfaagmojdobah" # fixed via manifest "key"
EXT_DIR="${DIR}/extension"
BROWSER="chrome"
DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
LAUNCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --browser) BROWSER="$2"; shift 2 ;;
    --deepseek-key) DEEPSEEK_KEY="$2"; shift 2 ;;
    --launch) LAUNCH=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# 1. Native messaging host (reads ~/.claude and ~/.codex; calls nothing else).
"${DIR}/host/install-macos.sh" "${EXT_ID}" "${BROWSER}"

# 2. Optional DeepSeek key — kept out of the browser, in a local config file.
if [ -n "${DEEPSEEK_KEY}" ]; then
  mkdir -p "${HOME}/.oh-my-tokens"
  printf '{\n  "deepseekApiKey": "%s"\n}\n' "${DEEPSEEK_KEY}" > "${HOME}/.oh-my-tokens/config.json"
  chmod 600 "${HOME}/.oh-my-tokens/config.json"
  echo "Wrote DeepSeek key to ~/.oh-my-tokens/config.json"
fi

# 3. Load the extension.
if [ "${LAUNCH}" = "1" ]; then
  echo "Launching Chrome with the extension preloaded (a full Chrome restart may be needed if it's already running)…"
  open -na "Google Chrome" --args --load-extension="${EXT_DIR}" >/dev/null 2>&1 || true
  echo "If Chrome was already open, fully quit it and run this again, or load it manually (below)."
fi

cat <<MSG

oh-my-tokens host is registered (Extension ID: ${EXT_ID}).
Final step — load the extension in Chrome (Chrome can't do this from the CLI):
  1. Open chrome://extensions and enable "Developer mode"
  2. Click "Load unpacked" and select:
       ${EXT_DIR}
  3. Click the oh-my-tokens toolbar icon.

(DeepSeek balance is optional: set it now with --deepseek-key, in the Options page, or in ~/.oh-my-tokens/config.json.)
MSG
