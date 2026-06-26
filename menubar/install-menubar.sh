#!/usr/bin/env bash
# oh-my-tokens — macOS menu-bar installer (SwiftBar plugin).
#
# One command. An agent (or you) runs this; it:
#   1. ensures SwiftBar is present (free, already notarized — no Apple account, no $$)
#   2. installs the oh-my-tokens plugin + formatter into the right folders
#   3. points SwiftBar at the plugin folder (only if you don't already use one) and launches it
#
# Data source is the existing native host (host/index.js) — run the repo's main
# install.sh first so ~/.oh-my-tokens/native-host is registered. Because the app is
# built/installed locally (not browser-downloaded), macOS does NOT quarantine it, so
# there is no Gatekeeper "unidentified developer" prompt and no notarization needed.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
SUPPORTDIR="$HOME/.oh-my-tokens/menubar"
HOST_CLI="$HOME/.oh-my-tokens/native-host/host/index.js"

write_install_metadata() {
  local installed="$1"
  local helper="$REPO_ROOT/host/install-metadata.js"
  [ -f "$helper" ] || helper="$HOME/.oh-my-tokens/native-host/host/install-metadata.js"
  local node_bin
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] && [ -f "$helper" ] || return 0
  if [ "$installed" = "1" ]; then
    OMT_SOURCE_ROOT="$REPO_ROOT" \
    OMT_MENUBAR_INSTALLED="$installed" \
    OMT_MENUBAR_INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      "$node_bin" "$helper" >/dev/null 2>&1 || true
  else
    OMT_SOURCE_ROOT="$REPO_ROOT" \
    OMT_MENUBAR_INSTALLED="$installed" \
      "$node_bin" "$helper" >/dev/null 2>&1 || true
  fi
}

# --uninstall: remove just our plugin + formatter (leaves SwiftBar and any other
# plugins untouched; never auto-removes SwiftBar since the user may rely on it).
if [ "${1:-}" = "--uninstall" ]; then
  PD="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "$HOME/.oh-my-tokens/swiftbar-plugins")"
  rm -f "$PD/oh-my-tokens.1m.sh"
  rm -rf "$SUPPORTDIR"
  write_install_metadata 0
  echo "Removed oh-my-tokens menu-bar plugin from $PD and $SUPPORTDIR."
  echo "(SwiftBar left installed. To remove it too: brew uninstall --cask swiftbar)"
  osascript -e 'quit app "SwiftBar"' >/dev/null 2>&1 || true
  open -a SwiftBar >/dev/null 2>&1 || true
  exit 0
fi

echo "==> oh-my-tokens menu-bar installer"

# 0. host CLI present?
if [ ! -f "$HOST_CLI" ]; then
  echo "!! Native host not found at $HOST_CLI"
  echo "   Run the repo's ./install.sh first (registers the host), then re-run this."
  exit 1
fi

# 1. SwiftBar present? install it if not (brew cask, else notarized GitHub release).
if [ ! -d "/Applications/SwiftBar.app" ] && ! [ -d "$HOME/Applications/SwiftBar.app" ]; then
  echo "==> Installing SwiftBar (free, notarized)…"
  if command -v brew >/dev/null 2>&1; then
    brew install --cask swiftbar
  else
    echo "   Homebrew not found; downloading SwiftBar release…"
    TMP="$(mktemp -d)"
    curl -fsSL -o "$TMP/SwiftBar.zip" \
      "https://github.com/swiftbar/SwiftBar/releases/latest/download/SwiftBar.zip"
    /usr/bin/ditto -x -k "$TMP/SwiftBar.zip" /Applications/
    rm -rf "$TMP"
  fi
else
  echo "==> SwiftBar already installed."
fi

# 2. install plugin + formatter
mkdir -p "$SUPPORTDIR"
cp "$DIR/format.mjs" "$SUPPORTDIR/format.mjs"; chmod 644 "$SUPPORTDIR/format.mjs"

# Use the user's existing SwiftBar plugin folder if they have one; otherwise ours.
EXISTING_DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
if [ -n "$EXISTING_DIR" ] && [ -d "$EXISTING_DIR" ]; then
  PLUGINDIR="$EXISTING_DIR"
  echo "==> Using your existing SwiftBar plugin folder: $PLUGINDIR"
else
  PLUGINDIR="$HOME/.oh-my-tokens/swiftbar-plugins"
  mkdir -p "$PLUGINDIR"
  defaults write com.ameba.SwiftBar PluginDirectory "$PLUGINDIR"
  defaults write com.ameba.SwiftBar SwiftBarLaunchedBefore -bool true
  echo "==> Set SwiftBar plugin folder to: $PLUGINDIR"
fi
cp "$DIR/oh-my-tokens.1m.sh" "$PLUGINDIR/oh-my-tokens.1m.sh"
chmod +x "$PLUGINDIR/oh-my-tokens.1m.sh"
echo "==> Installed plugin: $PLUGINDIR/oh-my-tokens.1m.sh"
write_install_metadata 1

# 3. (re)launch SwiftBar so it picks up the plugin
osascript -e 'quit app "SwiftBar"' >/dev/null 2>&1 || true
open -a SwiftBar >/dev/null 2>&1 || true
echo "==> Launched SwiftBar. Look for the 🎫 item in your menu bar (refreshes every 1m)."
