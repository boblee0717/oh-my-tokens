# extension

The MV3 Chrome extension — a popup that renders the `UsageReport` from the local
[host](../host), plus Claude's account quota fetched from claude.ai. It holds **no API keys**.
Permissions: `nativeMessaging` (host), `storage` (settings), and `host_permissions:
https://claude.ai/*` so it can read your Claude usage **using your existing logged-in
session** (`fetch(..., { credentials: "include" })`) — it never reads or stores cookies.

`claude-web.js` calls `/api/account` → `/api/organizations/{uuid}/usage` and maps the
`five_hour` / `seven_day` / `seven_day_sonnet` windows to quota bars. Any failure (not
logged in, shape changed) falls back to [] so Claude just shows tokens. This is Claude
**account-level** plan usage, not Claude Code CLI specifically.

`deepseek-usage.js` gets DeepSeek per-model token usage from `platform.deepseek.com`. That
API needs an `Authorization: Bearer` web token (not cookies), so we open the platform in a
**hidden tab** and `chrome.scripting.executeScript` an in-page fetch (it reads the token
from `localStorage.userToken` and calls `/api/v0/usage/amount`), then close the tab. The
token is used only in-page, never stored. `days[]` is aggregated into today/7d/30d
(RESPONSE_TOKEN→output, PROMPT_CACHE_MISS→input, PROMPT_CACHE_HIT→cache, REQUEST→requests).
Needs `scripting` + `tabs` + `host_permissions: https://platform.deepseek.com/*`.

## Load it (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Click the toolbar icon.

Until the native host is installed (see [host install docs](../host), M5), the popup shows
a **preview** using `sample-report.json` and a banner saying so. Once the host is
registered under the name in Options (default `com.ohmytokens.host`), the popup pulls live
data via `chrome.runtime.connectNative`.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (`nativeMessaging` + `storage`) |
| `popup.html/.css/.js` | the popup UI: per-provider cards, today/7d/30d toggle, refresh |
| `usage-client.js` | data layer — native host first, then the bundled sample fallback |
| `options.html/.js` | configure the native host name + default window |
| `sample-report.json` | synthetic preview data (no real usage) |

## Display rules

- **Quota %** (`quota_percent`, Codex `rate_limits`) is the hero: a progress bar per window
  (5h / Weekly) colored by level (green < 50, amber < 80, red ≥ 80) with reset time + plan badge.
  Always shown regardless of the selected token window.
- **Tokens** (`measured_tokens`) are shown plainly — these reconcile with `ccusage`.
- **Cost** (`estimated_cost`) is shown muted with an "est" tag — it is a provisional estimate.
- **Balance** (DeepSeek) is always shown regardless of the selected window (it's point-in-time).
- Per-provider `warnings` collapse into a single hover note, not loud banners.

Light theme, card-based layout with a time-of-day greeting.
