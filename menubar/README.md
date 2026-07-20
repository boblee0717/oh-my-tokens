# oh-my-tokens — macOS menu bar (SwiftBar plugin)

Shows your AI coding tool usage (Claude Code / Codex / TraeX / Cursor / DeepSeek / Kimi Code) in the macOS
menu bar, without opening Chrome. It reuses the existing native host for local token / cost /
request numbers and canonical Codex `rate_limits` quota snapshots. A popup-written browser
analytics cache can add Claude.ai usage and replace an older Codex quota record for the same
window (see "Plan usage %" below).

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

## Plan usage % (quota)
Cursor and Claude.ai plan usage are login-gated. Codex is different: when local
`token_count` events contain canonical `limit_id: "codex"` `rate_limits`, the native host
emits its 5h and weekly quota directly. That snapshot is log-driven, not a live server fetch.
Browser analytics sit behind Cloudflare, so the extension can also cache Codex analytics (and
Claude.ai usage) in `~/.oh-my-tokens/quota-cache.json`:

- **Cursor — standalone, no browser needed.** Each refresh the plugin runs
  `refresh-quota.js`, which reads your saved `cursor.com` cookie from the browser cookie
  store (macOS Keychain, one-time "Always Allow"), calls `cursor.com/api/usage-summary`
  itself, and merges the result. So Cursor stays current even with Chrome closed.
  (`chrome-cookies.js` does the read/decrypt; `cursor-quota.js` does the fetch/map.)
- **Claude.ai — via the extension.** Cloudflare bot protection rejects a standalone fetch,
  so the Chrome extension pushes browser-derived quota to the host (`{type:"saveQuota"}`)
  when it runs.
- **Codex — local snapshot first; extension analytics when newer.** The host ignores
  auxiliary non-canonical local limit families for plan quota. When the extension can read
  Codex analytics in the browser, it caches those records; the menu bar can use them when
  they are newer for the same 5h or weekly window.

The cache **merges per provider** (`mergeQuotaCache`), so the standalone Cursor refresh and
the extension's Claude/Codex pushes never clobber each other. On each menu refresh, the
formatter merges cached and host quota **per quota window**, keeping the record with the newer
`updatedAt`. Each provider line shows its own freshness ("just now" / "31m ago", "(stale)"
after 24h). A provider with no data yet is simply omitted.

## Cost and tokens (menu-bar total)
The 🎫 menu-bar number shows **today's total estimated cost and today's total tokens across
all providers/models**, and the dropdown shows each provider/model flat (one glance, no submenu):
- **Claude Code** — tokens from local logs × the Claude price table.
- **Codex** — tokens from local logs × an **assumed GPT price** (`host/pricing.js`, `gpt`
  family — edit if you know the real rates).
- **TraeX** — tokens from local logs × the same assumed price table when the model name is priced.
- **Cursor** — real per-model tokens + cost fetched standalone from cursor.com's usage
  events (`cursor-usage.js`); the cost is Cursor's own reported per-event value.
- **Kimi Code** — tokens from local logs (`~/.kimi-code` wire files), no cost (no price source yet).
All costs are **estimates, not billing** (flagged in the dropdown).

## Scope / limits
- Codex/TraeX/Cursor costs use assumed/derived rates — directional, not invoices.
- Quota % freshness: Cursor is live (standalone); TraeX is local when `rate_limits` exist;
  Codex is as fresh as its newest local canonical `token_count` snapshot unless newer browser
  analytics are cached for that window; Claude.ai is popup-driven.
- Update checks are read from the native host's report and cached briefly so the 1-minute
  menu refresh does not run `git fetch` every time. **Update now** performs a fast-forward
  only and reinstalls the native host/menu-bar files.

## Uninstall
```bash
./install-menubar.sh --uninstall   # removes our plugin + formatter, leaves SwiftBar
brew uninstall --cask swiftbar      # optional: only if you don't use SwiftBar otherwise
```
