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
- **Reuses the data layer** — renders `host/index.js` JSON through `format.mjs`. No new
  data logic, no extra source of truth.
- **Instant redraws** — the plugin renders a cached report and rebuilds it in the
  background, so the slow host scan never blocks the menu (see below).

## Install
```bash
./install-menubar.sh        # after the repo's main ./install.sh has registered the host
```
A 🎫 item appears in the menu bar; the dropdown breaks usage down by provider/model and
shows 7d / 30d rollups. Refreshes every minute.

## Menu bar title: quota buckets
When plan-usage quota data exists (see below), the title groups quota windows by
provider. Each window keeps a separate small bucket (shortest window first — 5h before
weekly), while the provider name is centred once below the group (CODEX / KIMI / …).
Every bucket shows its own remaining percentage; full window names stay in the dropdown
instead of adding letter codes to the compact title. Badges use a knockout halo so they
stay readable at any fill level. With no quota data, the title
falls back to today's estimated cost + total tokens (🎫).

Two styles, switchable from the dropdown (**Menu bar style**, persisted in
`~/.oh-my-tokens/menubar-prefs.json`, overridable with `OMT_TITLE_STYLE`):
- **Quota buckets · image** (default) — `format.mjs` draws a tiny monochrome PNG
  itself (pure Node: zlib + a hand-rolled PNG chunk writer + a 3x5 bitmap font for the
  badges, no deps) and passes it as SwiftBar `templateImage`, so macOS re-tints it for
  light/dark menu bars.
- **Cost · tokens** — the classic 🎫 headline even when quota data exists.

## Files
- `oh-my-tokens.1m.sh` — the SwiftBar plugin (1-minute refresh). Locates `node`, renders
  the **cached** report (`~/.oh-my-tokens/report-cache.json`) through the formatter, and
  kicks a background cache rebuild when it's stale. Menu actions: `--set-style <style>`
  (writes prefs; SwiftBar's `refresh=true` redraws instantly from cache) and `--refresh`
  (forces a background data refresh). With no cache yet (first install) it does one
  synchronous host run to seed it.
- `refresh-report.sh` — background refresher: runs `refresh-quota.js` + `host/index.js`
  detached and atomically replaces the report cache (tmp + `mv`), guarded by a `mkdir`
  lock so overlapping runs can't stack.
- `format.mjs` — renders the host's JSON report into SwiftBar's text format. Lives in a
  **support dir** (`~/.oh-my-tokens/menubar/`), NOT the plugin folder — SwiftBar runs every
  file in its plugin folder as a plugin, so the helpers must live elsewhere.
- `install-menubar.sh` — installs SwiftBar if missing, places the plugin + helpers,
  points SwiftBar at the plugin folder (only if you don't already use one), launches it.

## Plan usage % (quota)
Cursor and Claude.ai plan usage are login-gated. Codex is different: when local
`token_count` events contain canonical `limit_id: "codex"` `rate_limits`, the native host
emits its 5h and weekly quota directly. The menu bar also actively reads the installed
Codex client's `account/rateLimits/read` via `codex app-server` every ~2 minutes,
even while no conversation is running. It reuses the client's login without reading
credentials or starting inference. Reads time out after 8 seconds; failures retain
the cached quota, and newer local log snapshots remain a fallback. Set `OMT_CODEX_BIN`
if the CLI is outside PATH and the usual Homebrew locations.
Browser analytics sit behind Cloudflare, so the extension can also cache Codex analytics (and
Claude.ai usage) in `~/.oh-my-tokens/quota-cache.json`:

- **Cursor — standalone, no browser needed.** Each background refresh runs
  `refresh-quota.js`, which reads your saved `cursor.com` cookie from the browser cookie
  store (macOS Keychain, one-time "Always Allow"), calls `cursor.com/api/usage-summary`
  itself, and merges the result. So Cursor stays current even with Chrome closed.
  (`chrome-cookies.js` does the read/decrypt; `cursor-quota.js` does the fetch/map.)
- **Kimi Code — standalone via the local CLI's token.** `refresh-quota.js` also calls
  `api.kimi.com/coding/v1/usages` (the same endpoint the CLI's `/usage` panel uses) with
  the managed OAuth token from `~/.kimi-code/credentials/kimi-code.json`, refreshing it
  (and writing the rotated tokens back) when it expires. Gives `weekly` + `5h` buckets.
  (`kimi-quota.js`; see AGENTS.md for the credentials-read exception scope.)
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
To hide a provider and skip its standalone quota refresh, add `"hiddenProviders": ["kimi"]`
to `~/.oh-my-tokens/menubar-prefs.json` (keep any existing `titleStyle`). This also excludes
its cached quota, usage, errors, and tokens from the menu-bar totals.

If macOS denies SwiftBar access to Chrome's cookie store, existing Cursor data is retained.
The Chrome extension also refreshes Cursor quota every 10 minutes while Chrome is running.

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
