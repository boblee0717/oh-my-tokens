# oh-my-tokens — Agent Memory

Key decisions and incident records shared across agent sessions.


## 2026-08-01: Menu-bar quota-bucket title + Kimi standalone quota (PR #3)

- **Bucket title** (`menubar/format.mjs`): opt-in style, default stays the classic 🎫
  headline. One independent mini-bucket per quota window, visually grouped by provider
  (shortest window first); each bucket keeps its remaining-% badge and the provider badge
  is centred once below the group. A 1px knockout halo keeps badges readable over full
  buckets.
  Pure-Node PNG (zlib + hand-rolled chunks + 3x5 bitmap font — NO deps) emitted as
  SwiftBar `templateImage`. Style persisted in `~/.oh-my-tokens/menubar-prefs.json`
  via the plugin's `--set-style` action; `OMT_TITLE_STYLE` overrides; tests must
  isolate `OMT_MENUBAR_PREFS`. Quota merge moved BEFORE title rendering.
  The badge font covers 0-9, `%` and all of A-Z; H/M/N/W are deliberately differentiated
  by where the weight sits, since 3 columns can't hold real diagonals. `quotaBuckets()`
  renders providers outside `PROVIDER_ORDER` after the known ones instead of dropping
  them, so a cache from a newer extension doesn't silently lose buckets.
- **Kimi standalone quota** (`host/kimi-quota.js`, wired into `refresh-quota.js` at a
  90s throttle): `GET api.kimi.com/coding/v1/usages` — the endpoint behind the CLI's
  `/usage` panel, reverse-engineered from the CLI binary. Payload is proto-JSON:
  numeric strings, weekly summary has `limit`+`remaining` (used = limit − remaining),
  the 5h window arrives as 300 minutes. Maps to quota_percent "weekly" + "5h",
  planType from `user.membership.level`.
- **Bob approved reading `~/.kimi-code/credentials/kimi-code.json`** (option C, re-confirmed
  2026-08-01 when PR #3 merged) — a narrow exception to the 2026-07-20 "never read
  credentials/" rule, which now points here: this ONE file
  only; the token is never logged or persisted elsewhere; on refresh (tokens live
  900s) the rotated tokens are written BACK like the CLI. That write-back overwrites the
  CLI's own file, so `writeTokenFile()` spreads the previously-read object under the
  refresh response (keeping fields we don't manage) and swaps the file in via temp +
  `rename` — a truncated write would log the user out of the CLI. `invalid_grant`
  → re-read once and retry. Refresh = `POST auth.kimi.com/api/oauth/token`; the
  server REQUIRES `client_id` (400 invalid_request without it) — the public
  device-flow id is NOT hardcoded in our repo: `resolveClientId()` extracts it from
  the local CLI binary at runtime (exactly one `clientId: "<uuid>"` in the embedded
  JS), scanning it in 1MB chunks with an 80-char carry (never a 160MB read) and caching
  by binary mtime in `~/.oh-my-tokens/kimi-client-id.json` (`OMT_KIMI_CLIENT_ID`
  overrides).
- **`needs_login` means the credential is genuinely bad**, nothing else: a missing or
  unparseable credentials file, an unresolvable client id, or a rejected grant (401/403/
  `invalid_grant`). Timeouts and other token-endpoint statuses return `error`, because a
  `needs_login` there would put a "Log in to Kimi Code" prompt in the menu bar while the
  session is fine. Errors carry a `needsLogin` flag (`loginError()`) rather than being
  classified by message.

## 2026-07-20: Kimi Code integration

- **Kimi Code — local parser** (`host/parsers/kimi.js`): reads `~/.kimi-code/sessions/**/wire.jsonl`
  (one wire file per agent per session, subagents included). `{"type":"usage.record"}` lines are
  **per-turn deltas** (`usage.inputOther` → input, `output` → output, `inputCacheRead +
  inputCacheCreation` → cache, ms `time`), so window totals are plain sums — no cumulative-snapshot
  delta logic like Codex/TraeX. Only `usageScope: "turn"` counts (session-scoped aggregates would
  double-count). `requests` = LLM turns, not user prompts. No cost estimate (no authoritative
  Kimi Code price source yet — same stance as early Codex). Provider id `kimi`, label "Kimi Code",
  appended at the end of every provider list (popup/background/options/menubar/schema).
- Never read `~/.kimi-code/oauth/`, and the *parser* never touches `credentials/` — it only
  walks `sessions/**/wire.jsonl`. The single approved exception is
  `credentials/kimi-code.json`, read by `host/kimi-quota.js` alone (see the 2026-08-01 entry);
  nothing else may widen it.

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
