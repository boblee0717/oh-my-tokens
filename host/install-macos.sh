#!/usr/bin/env bash
# Register the native messaging host with Chrome on macOS.
# Usage: ./install-macos.sh [EXTENSION_ID] [BROWSER]
#   EXTENSION_ID defaults to the fixed ID from manifest.json.
#   BROWSER (default "chrome"): chrome | beta | canary | chromium | edge
set -euo pipefail

EXTENSION_ID="${1:-obmkhlamcmbmacadoolbfaagmojdobah}"
BROWSER="${2:-chrome}"

case "${BROWSER}" in
  chrome)   APP_SUPPORT="Google/Chrome" ;;
  beta)     APP_SUPPORT="Google/Chrome Beta" ;;
  canary)   APP_SUPPORT="Google/Chrome Canary" ;;
  chromium) APP_SUPPORT="Chromium" ;;
  edge)     APP_SUPPORT="Microsoft Edge" ;;
  *) echo "unknown browser: ${BROWSER}" >&2; exit 1 ;;
esac

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${DIR}/.." && pwd)"
INSTALL_ROOT="${HOME}/.oh-my-tokens/native-host"
INSTALL_HOST_DIR="${INSTALL_ROOT}/host"
INSTALL_SHARED_DIR="${INSTALL_ROOT}/shared"

# Chrome may launch the native host from a much more restricted environment than
# the user's shell. Install the runtime under HOME instead of pointing Chrome at
# the arbitrary clone location (for example ~/Documents, which can be TCC-gated).
rm -rf "${INSTALL_ROOT}"
mkdir -p "${INSTALL_HOST_DIR}" "${INSTALL_SHARED_DIR}"
cp "${DIR}"/*.js "${INSTALL_HOST_DIR}/"
cp "${DIR}/package.json" "${INSTALL_HOST_DIR}/"
cp "${DIR}/run-host.sh" "${INSTALL_HOST_DIR}/"
cp "${DIR}/update-now.sh" "${INSTALL_HOST_DIR}/"
cp -R "${DIR}/parsers" "${INSTALL_HOST_DIR}/"
find "${INSTALL_HOST_DIR}/parsers" -type f ! -name '*.js' -delete
cp "${REPO_ROOT}/shared"/*.js "${INSTALL_SHARED_DIR}/"
chmod +x "${INSTALL_HOST_DIR}/run-host.sh"
chmod +x "${INSTALL_HOST_DIR}/update-now.sh"
HOST_PATH="${INSTALL_HOST_DIR}/run-host.sh"

TARGET_DIR="${HOME}/Library/Application Support/${APP_SUPPORT}/NativeMessagingHosts"
mkdir -p "${TARGET_DIR}"
TARGET="${TARGET_DIR}/com.ohmytokens.host.json"

sed -e "s#__HOST_PATH__#${HOST_PATH}#" \
    -e "s#__EXTENSION_ID__#${EXTENSION_ID}#" \
    "${DIR}/com.ohmytokens.host.json.template" > "${TARGET}"

NODE_BIN="$(command -v node || true)"
if [ -n "${NODE_BIN}" ]; then
  OMT_SOURCE_ROOT="${REPO_ROOT}" \
  OMT_EXTENSION_ID="${EXTENSION_ID}" \
  OMT_BROWSER="${BROWSER}" \
  OMT_NATIVE_HOST_INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    "${NODE_BIN}" "${DIR}/install-metadata.js"
fi

echo "Installed native host manifest:"
echo "  ${TARGET}"
echo "  runtime     = ${INSTALL_ROOT}"
echo "  path        = ${HOST_PATH}"
echo "  allowed for = chrome-extension://${EXTENSION_ID}/"
echo
echo "Reload the extension at chrome://extensions, then open the popup."
