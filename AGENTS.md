# oh-my-tokens — Agent Memory

Key decisions and incident records shared across agent sessions.

## 2026-08-01: Menu bar render/data separation (instant style switch)

- **Incident**: the SwiftBar plugin ran `host/index.js` synchronously on every render.
  The Codex parser full-scans `~/.codex/sessions/**/*.jsonl` (7+ GB here) each run, so
  one render took ~40s of CPU every minute → sustained 1+ core load, thermal pressure,
  and style switches that only appeared after the next 40s pipeline finished.
- **Fix** (`menubar/`): the plugin script now renders from a cached report
  (`~/.oh-my-tokens/report-cache.json`, `OMT_REPORT_CACHE` override) and never waits on
  the host. New `menubar/refresh-report.sh` rebuilds that cache DETACHED (spawned via
  `nohup bash … &` with fully redirected fds — SwiftBar must never inherit the pipe),
  guarded by a `mkdir` lock dir (`$CACHE.lock`, 10-min stale recovery), atomic replace
  via tmp+`mv`. It also runs `refresh-quota.js` (moved out of the render path).
- Plugin behavior: `--set-style` unchanged (writes prefs, exits; the menu items already
  carry `refresh=true`, so the re-render reads the new prefs from cache instantly).
  New `--refresh` arg forces a background refresh; the formatter's footer Refresh item
  invokes it (`bash=$OMT_PLUGIN_SCRIPT param1=--refresh refresh=true`, falls back to
  plain `refresh=true` without `OMT_PLUGIN_SCRIPT`). Otherwise a background refresh is
  kicked when the cache is missing or older than 1 min (`find -mmin +1`); with no cache
  at all (first install) the plugin does ONE synchronous host run, seeding the cache
  via `tee`. Measured: render 40s → ~0.1s; style switch effectively instant.
- `menubar/install-menubar.sh` copies `refresh-report.sh` into the support dir (+x).
- Note: `format.test.mjs` has locale-sensitive date assertions that fail under a zh-CN
  system locale — run with `LANG=en_US.UTF-8` (pre-existing, unrelated to this change).

## 2026-07-31: Kimi Code quota buckets (managed OAuth exception)

- **Kimi Code — standalone quota** (`host/kimi-quota.js`): the CLI's `/usage` panel calls
  `GET https://api.kimi.com/coding/v1/usages` with the managed OAuth Bearer token — same
  call, reverse-engineered from the CLI binary (`~/.kimi-code/bin/kimi`, embedded JS in
  `packages/oauth/src/managed-usage.ts`). Real payload is proto-JSON: numeric strings,
  `usage` = weekly summary (`limit`+`remaining`, `resetTime`, NO `used` → used = limit −
  remaining), `limits[]` = `{detail, window:{duration, timeUnit: "TIME_UNIT_*"}}` with the
  5-hour window expressed as **300 minutes** (fold whole hours in labels). Records map to
  `quota_percent` ("weekly" + "5h"), `planType` from `user.membership.level`
  (LEVEL_ADVANCED → "Kimi Advanced"). `boosterWallet` ignored for now.
- **Bob approved reading the CLI's managed token** (option C, 2026-07-31) — an exception to
  the 2026-07-20 "never read ~/.kimi-code/credentials/" rule. Boundaries: read ONLY
  `credentials/kimi-code.json`; never log/persist the token elsewhere; on refresh (tokens
  live 900s) write the rotated `access_token`+`refresh_token` BACK to the same file
  (mode 600), exactly like the CLI; on `invalid_grant` re-read once and retry (the CLI may
  have rotated first). Refresh = `POST auth.kimi.com/api/oauth/token` form
  `{client_id: 17e5f671-…-5516cb48c098 (public device client), grant_type: refresh_token}`.
- Wired into `host/refresh-quota.js` (90s throttle, provider "kimi") → quota cache → menu-bar
  buckets. Verified live: 3 buckets (Codex Weekly + Kimi weekly + Kimi 5h).

## 2026-07-31: Menu-bar quota buckets

- The SwiftBar title shows **grouped quota buckets**: one bucket per quota window,
  buckets of a provider adjacent (shortest window first — 5h before weekly). Each
  bucket carries its remaining % as a top-right corner badge and the provider short
  name as a bottom-right corner badge; both stick 3px onto the bucket with the same
  1px knockout halo (readable over full buckets). 3x5 bitmap font baked into the PNG;
  cells widen to fit the wider badge so neighbours never collide. Built from the same
  merged quota records as the PLAN USAGE dropdown — merge moved BEFORE title rendering
  in `menubar/format.mjs`. No quota data → classic 🎫 cost/tokens headline.
- Two title styles (`png` default / `classic`; the short-lived `unicode` text style was
  removed 2026-08-01 — unknown style values fall back to `png`), persisted in
  `~/.oh-my-tokens/menubar-prefs.json` (`OMT_MENUBAR_PREFS` / `OMT_TITLE_STYLE`
  override). The dropdown's **Menu bar style** actions re-invoke the plugin script as
  `bash=<self> param1=--set-style param2=<style>`; `oh-my-tokens.1m.sh` handles that
  arg before anything else and exports `OMT_PLUGIN_SCRIPT` so the formatter can build
  the action lines.
- The `png` style draws its own image in pure Node (`deflateSync` + a hand-rolled
  CRC32/PNG-chunk writer — NO deps, the formatter must stay dependency-free) and emits
  it as SwiftBar `templateImage` (alpha-only ink, so macOS re-tints light/dark).
- Tests (`menubar/format.test.mjs`) must isolate `OMT_MENUBAR_PREFS` from the dev
  machine's real prefs file.

## 2026-07-20: Kimi Code integration

- **Kimi Code — local parser** (`host/parsers/kimi.js`): reads `~/.kimi-code/sessions/**/wire.jsonl`
  (one wire file per agent per session, subagents included). `{"type":"usage.record"}` lines are
  **per-turn deltas** (`usage.inputOther` → input, `output` → output, `inputCacheRead +
  inputCacheCreation` → cache, ms `time`), so window totals are plain sums — no cumulative-snapshot
  delta logic like Codex/TraeX. Only `usageScope: "turn"` counts (session-scoped aggregates would
  double-count). `requests` = LLM turns, not user prompts. No cost estimate (no authoritative
  Kimi Code price source yet — same stance as early Codex). Provider id `kimi`, label "Kimi Code",
  appended at the end of every provider list (popup/background/options/menubar/schema).
- Never read `~/.kimi-code/credentials/` or `~/.kimi-code/oauth/` — secrets; the parser only
  walks `sessions/**/wire.jsonl`.

## PUSH POLICY (2026-06-26, updated by Bob)

**`claudeOpus` and Codex may push to this repo (master and all branches).** All agents on this
machine share the same `boblee0717` SSH identity, so GitHub can't enforce this — it is a
**convention every agent must follow**. Codex should verify tests and inspect the final diff
before pushing. Other agents (Cherry, openDSFlashV4, …): do NOT `git push`. They should do
reviews, real-browser verification, and endpoint/issue investigation, then hand the diff/patch
or a precise description to claudeOpus or Codex, who integrates and pushes.
(Rationale: avoids the repeated branch/master collisions seen 2026-05-26 — logo, manifest key,
while allowing Bob's active Codex sessions to ship verified local fixes directly.)

## 2026-05-27: Cursor integration & web-login prompts

- **Cursor — local parser** (`host/parsers/cursor.js`): reads `~/.cursor/ai-tracking/ai-code-tracking.db`
  via `/usr/bin/sqlite3`. One AI request fans out to many code-hash rows, so requests are counted as
  **DISTINCT `requestId`** (counting rows over-counted ~100x). `metricType: "request_count"`, zero tokens,
  warned as "request counts, not tokens" + a CLI/Composer split. Cursor exposes no local token data.
- **Cursor — web connector** (`extension/cursor-web.js`): the PRIMARY source (Bob: "cursor 全部从 api").
  Two endpoints via `credentials:"include"` (host_permission `https://cursor.com/*`, never reads/stores the
  WorkOS cookie):
  - `GET /api/usage-summary` → plan usage % (`quota_percent`: Plan + API %, billing cycle, membershipType).
  - `POST /api/dashboard/get-filtered-usage-events` (body `{startDate,endDate,page,pageSize}`, bounded to
    10 pages × 1000) → per-model `measured_tokens` + `estimated_cost` (tokenUsage.{input,output,cacheWrite+
    cacheRead}, totalCents/100). Bucketed into today/7d/30d by event timestamp.
  - Field names are reverse-engineered + cross-checked vs the Cursor app's proto names (`GetFilteredUsageEvents`,
    `GetAggregatedUsageEvents`, `GetMonthlyInvoice`) — NOT a captured live response (all automated capture
    failed: Chrome-skill down, computer-use `cgWindowNotFound`, AppleScript blocked, curl→Cloudflare). So
    extraction is tolerant of camel/snake_case + `usageEventsDisplay/usage_events_display` + `tokenUsage/
    token_usage`, degrades to `[]`, and the quota result never fails on an events error. **Needs Bob's
    logged-in reload to confirm the real field names** (verified live only: unauth → 401 `not_authenticated`).
  - When the web connector returns token data, the popup DROPS the local parser's `request_count` records
    for Cursor (web supersedes the local fallback).
- **Cursor — local parser** (`host/parsers/cursor.js`): now a FALLBACK only — shows per-model request counts
  (DISTINCT requestId) when the web API is unavailable / not signed in.
- **Login prompts (task #6) — web-auth driven, NOT native host.** The three web connectors
  (`claude-web.js`, `deepseek-usage.js`, `cursor-web.js`) return `{ status: "ok"|"needs_login"|"error",
  records, loginUrl }`. `needs_login` (401/403, no org, no token, or `not_authenticated` body) → popup shows a
  clickable "Log in to X →" link. We deliberately do **not** infer login state from the native host
  ("no local logs" ≠ "not logged in" — would misfire). An earlier native-host `login_prompt` approach
  (in `9922acd`) was removed for this reason.

## 2026-05-30: Windows support (branch `feat/windows-support`)

Ported the native host + installer to Windows; the extension itself was already
platform-neutral. Key decisions, verified live on Windows 11 + Node 24:

- **Registration is via the registry, not a file.** `host/install-windows.ps1` writes
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ohmytokens.host` (Edge:
  `…\Microsoft\Edge\…`; Chromium: `…\Chromium\…`), default value = manifest path. HKCU =
  no admin. Create keys with `Test-Path` guards, **not `New-Item -Force`** — `-Force` on the
  already-existing `NativeMessagingHosts` key throws "unauthorized operation".
- **`run-host.cmd` replaces `run-host.sh`.** Chrome runs a `.cmd` via `cmd.exe /c`; node
  inherits the browser's binary pipes directly, so the length-prefixed protocol survives —
  *provided the wrapper writes nothing to stdout* (`@echo off`, all diagnostics → stderr →
  `~/.oh-my-tokens/host.log`). `native-host.js` needs no change (Node stdio is binary-safe).
  Manifest JSON written via `[IO.File]::WriteAllText` to avoid a UTF-8 **BOM** (a BOM breaks
  Chrome's parser). Verified framed request/response through the installed `.cmd`.
- **Cursor local parser:** `/usr/bin/sqlite3` was hardcoded. Now `resolveSqlite3()` probes
  known paths + `which`/`where`; Windows usually has no `sqlite3.exe`, so it degrades to no
  records (Cursor *web* connector is primary anyway). Cursor fixture tests self-skip when the
  CLI is absent.
- **`os.homedir()` ignores `HOME` on Windows (uses `USERPROFILE`).** `native-host.test.js`'s
  isolation set only `HOME`, so on Windows it read the dev's real `~/.claude`; fixed by also
  setting `USERPROFILE` in the test env. Claude/Codex/Cursor log dirs map cleanly to
  `%USERPROFILE%\.claude` etc. — no path changes needed (`path.join` + `homedir()` already used).
- Top-level `install.ps1` mirrors `install.sh` (`-Browser`, `-DeepSeekKey`, `-Launch`).
  `install.sh` (macOS) stays the Linux path too.

## DEPLOY NOTE: keep one canonical source

The native-messaging host runs whatever `run-host.sh` path the installed
`com.ohmytokens.host.json` points at, and Chrome runs whatever extension folder is loaded.
If these point at stale/separate worktrees, merged fixes won't appear (this caused a
"Codex not showing" false alarm 2026-05-26). Canonical source = claudeOpus's worktree on
`master`: `/Users/bytedance/.slock/agents/bb79aa65-5384-483a-81c6-3763fd1360c6/oh-my-tokens`.
After a fix lands, re-run `host/install-macos.sh` from there and reload the extension from
that same `extension/` folder (fixed ID `obmkhlamcmbmacadoolbfaagmojdobah`).

## 2026-05-26: Node version — "Native host has exited"

- Cause: `run-host.sh` ran `node native-host.ts` — running multi-file TypeScript needs
  Node ≈23.6+ (we dev on 26). On common Node 18/20/22 LTS the host crashed on launch →
  "Native host has exited" (a friend's install hit this).
- **Fix: the host runtime is plain JavaScript (ESM)** — `host/*.js` + `host/parsers/*.js`;
  `run-host.sh` does `exec node native-host.js`. Runs on **Node ≥ 18**, no build, no deps,
  no TS flags. (`host/*.ts` runtime files are now redundant dead weight — pending cleanup;
  `shared/schema.ts` stays as a types-only reference. Tests under `host/test/*.ts` are dev-only.)
- Hardening: `install.sh` preflights Node ≥ 18; `run-host.sh` appends host stderr to
  `~/.oh-my-tokens/host.log` so a failed launch is diagnosable.

## 2026-05-26: Private key accidentally committed in manifest `key` field

- commit `2610be7` (openDSFlashV4) added a PKCS#8 **private key** to `manifest.json`'s `"key"` field, instead of a public key.
- Fixed in `246aeb9` (claudeOpus): replaced with correct SubjectPublicKeyInfo public key. Extension ID changed from `pgahg...` to `obmkh...`.
- **Risk assessment**: Minimal — the key was random/gen'd for ID calculation only, unrelated to any account/credential. The leaked key corresponds to the **now-deprecated** extension ID (`pgahg...`), which nobody uses. No force-push rewrite performed per project decision.
- **Avoidance**: When generating a Chrome `manifest.json` `"key"`, use `openssl rsa -pubout -outform DER | base64` (public key only), not `openssl pkcs8 -topk8` (private key).
