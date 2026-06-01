# oh-my-tokens — macOS menu bar (SwiftBar plugin)

Shows your AI coding tool usage (Claude Code / Codex / Cursor / DeepSeek) in the macOS
menu bar, without opening Chrome. It reuses the existing native host — same local
token / cost / request numbers the Chrome popup shows.

## Why SwiftBar
- **One command, agent-installable** — `install-menubar.sh` does everything.
- **Free, no Apple account** — SwiftBar is free and already notarized; our part is just
  a script it runs. Installed locally → not quarantined → no Gatekeeper prompt, no $99.
- **Reuses the data layer** — pipes `host/index.js` JSON through `format.mjs`. No new
  data logic, no extra source of truth.

## Install
```bash
./install-menubar.sh        # after the repo's main ./install.sh has registered the host
```
A 🎫 item appears in the menu bar; the dropdown breaks usage down by provider/model and
shows 7d / 30d rollups. Refreshes every minute.

## Files
- `oh-my-tokens.1m.sh` — the SwiftBar plugin (1-minute refresh). Locates `node`, runs the
  installed host CLI, pipes to the formatter.
- `format.mjs` — renders the host's JSON report into SwiftBar's text format. Lives in a
  **support dir** (`~/.oh-my-tokens/menubar/`), NOT the plugin folder — SwiftBar runs every
  file in its plugin folder as a plugin, so the helper must live elsewhere.
- `install-menubar.sh` — installs SwiftBar if missing, places the plugin + formatter,
  points SwiftBar at the plugin folder (only if you don't already use one), launches it.

## Scope / limits (v1)
- Shows **local** data: tokens, estimated cost, request counts (Claude Code / Codex /
  Cursor-local / DeepSeek-by-key). Cost is estimated from a static price table, flagged
  in the dropdown — not authoritative billing.
- **Login-gated quota %** (Cursor plan %, claude.ai) is NOT shown — that data is fetched
  by the browser extension using your cookies and isn't available to a standalone app.
  A later bridge (extension writes quota JSON to a local file the plugin merges) can add it.

## Uninstall
```bash
./install-menubar.sh --uninstall   # removes our plugin + formatter, leaves SwiftBar
brew uninstall --cask swiftbar      # optional: only if you don't use SwiftBar otherwise
```
