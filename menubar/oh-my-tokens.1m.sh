#!/usr/bin/env bash
# oh-my-tokens — SwiftBar/xbar plugin. Refreshes every 1 minute (filename ".1m.").
#
# <xbar.title>oh-my-tokens</xbar.title>
# <xbar.desc>AI coding tool usage (Claude Code / Codex / Cursor / DeepSeek) in the menu bar.</xbar.desc>
# <xbar.author>oh-my-tokens</xbar.author>
# <swiftbar.hideAbout>false</swiftbar.hideAbout>
#
# It runs the existing native-host CLI (host/index.js) and pipes its JSON into
# format.mjs. No new data logic — same numbers the Chrome popup shows for local
# token/cost/request data. (Login-gated quota % lives in the browser extension.)

set -euo pipefail

# Resolve a node binary even under SwiftBar's minimal PATH.
find_node() {
  for c in node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  # nvm default, if present
  for n in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$n" ] && { echo "$n"; return 0; }
  done
  return 1
}

NODE="$(find_node || true)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# format.mjs lives in a support dir (NOT the SwiftBar plugin folder — SwiftBar
# would otherwise try to run it as its own plugin). Override with OMT_FORMAT.
FORMAT="${OMT_FORMAT:-$HOME/.oh-my-tokens/menubar/format.mjs}"
[ -f "${FORMAT}" ] || FORMAT="${HERE}/format.mjs"  # dev fallback: alongside the script
# Installed host CLI (install.sh copies the runtime here).
REPORT_CLI="${OMT_HOST_CLI:-$HOME/.oh-my-tokens/native-host/host/index.js}"
# Standalone quota refresh (fetches Cursor plan usage via the saved cookie — no browser).
REFRESH_CLI="$(dirname "${REPORT_CLI}")/refresh-quota.js"

if [ -z "${NODE}" ]; then
  echo "🎫 ⚠︎"
  echo "---"
  echo "Node not found on PATH | color=#e07a5f"
  echo "Install Node >= 18 and reload | size=11 color=#888"
  exit 0
fi
if [ ! -f "${REPORT_CLI}" ]; then
  echo "🎫 ⚠︎"
  echo "---"
  echo "Host CLI not found | color=#e07a5f"
  echo "${REPORT_CLI} | font=Menlo size=11 color=#888"
  echo "Run oh-my-tokens install.sh first | size=11 color=#888"
  exit 0
fi

# Refresh standalone quota first (best-effort, self-throttled, never blocks rendering).
[ -f "${REFRESH_CLI}" ] && "${NODE}" "${REFRESH_CLI}" 2>/dev/null || true

# Tell the formatter the system appearance so its accent/dim colors stay legible in a dark
# menu (the default text color already adapts; only the explicit colors need this).
if [ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" = "Dark" ]; then
  export OMT_APPEARANCE=dark
else
  export OMT_APPEARANCE=light
fi

"${NODE}" "${REPORT_CLI}" 2>/dev/null | "${NODE}" "${FORMAT}"
