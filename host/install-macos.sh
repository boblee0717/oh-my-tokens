#!/usr/bin/env bash
# Register the native messaging host with Chrome on macOS.
# Usage: ./install-macos.sh <EXTENSION_ID> [BROWSER]
#   BROWSER (default "chrome"): chrome | beta | canary | chromium | edge
# Find the extension id at chrome://extensions (with Developer mode on).
set -euo pipefail

EXTENSION_ID="${1:-}"
BROWSER="${2:-chrome}"
if [ -z "${EXTENSION_ID}" ]; then
  echo "usage: $0 <EXTENSION_ID> [chrome|beta|canary|chromium|edge]" >&2
  exit 1
fi

case "${BROWSER}" in
  chrome)   APP_SUPPORT="Google/Chrome" ;;
  beta)     APP_SUPPORT="Google/Chrome Beta" ;;
  canary)   APP_SUPPORT="Google/Chrome Canary" ;;
  chromium) APP_SUPPORT="Chromium" ;;
  edge)     APP_SUPPORT="Microsoft Edge" ;;
  *) echo "unknown browser: ${BROWSER}" >&2; exit 1 ;;
esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "${DIR}/run-host.sh"

TARGET_DIR="${HOME}/Library/Application Support/${APP_SUPPORT}/NativeMessagingHosts"
mkdir -p "${TARGET_DIR}"
TARGET="${TARGET_DIR}/com.ohmytokens.host.json"

sed -e "s#__HOST_PATH__#${DIR}/run-host.sh#" \
    -e "s#__EXTENSION_ID__#${EXTENSION_ID}#" \
    "${DIR}/com.ohmytokens.host.json.template" > "${TARGET}"

echo "Installed native host manifest:"
echo "  ${TARGET}"
echo "  path        = ${DIR}/run-host.sh"
echo "  allowed for = chrome-extension://${EXTENSION_ID}/"
echo
echo "Reload the extension at chrome://extensions, then open the popup."
