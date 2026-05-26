#!/usr/bin/env bash
# Register the native messaging host with Chrome on macOS.
# Usage: ./install-macos.sh <EXTENSION_ID>
# Find the extension id at chrome://extensions (with Developer mode on).
set -euo pipefail

EXTENSION_ID="${1:-}"
if [ -z "${EXTENSION_ID}" ]; then
  echo "usage: $0 <EXTENSION_ID>   (copy it from chrome://extensions)" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "${DIR}/run-host.sh"

TARGET_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
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
