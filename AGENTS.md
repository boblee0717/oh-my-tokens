# oh-my-tokens — Agent Memory

Key decisions and incident records shared across agent sessions.

## PUSH POLICY (2026-05-26, set by Bob)

**Only `claudeOpus` pushes to this repo (master and all branches).** All agents on this
machine share the same `boblee0717` SSH identity, so GitHub can't enforce it — this is a
**convention every agent must follow**. Other agents (Cherry, openDSFlashV4, …): do NOT
`git push`. Do reviews, real-browser verification, and endpoint/issue investigation, then
hand the diff/patch or a precise description to claudeOpus, who integrates and pushes.
(Rationale: avoids the repeated branch/master collisions seen 2026-05-26 — logo, manifest key.)

## 2026-05-27: Cursor integration & web-login prompts

- **Cursor — local parser** (`host/parsers/cursor.js`): reads `~/.cursor/ai-tracking/ai-code-tracking.db`
  via `/usr/bin/sqlite3`. One AI request fans out to many code-hash rows, so requests are counted as
  **DISTINCT `requestId`** (counting rows over-counted ~100x). `metricType: "request_count"`, zero tokens,
  warned as "request counts, not tokens" + a CLI/Composer split. Cursor exposes no local token data.
- **Cursor — web connector** (`extension/cursor-web.js`): primary usage signal. Fetches
  `GET cursor.com/api/usage-summary` with `credentials:"include"` (host_permission `https://cursor.com/*`),
  maps plan usage % → `quota_percent`. Field names are reverse-engineered (unverified live), so extraction
  is tolerant and degrades to `[]`. Never reads/stores the WorkOS cookie.
- **Login prompts (task #6) — web-auth driven, NOT native host.** The three web connectors
  (`claude-web.js`, `deepseek-usage.js`, `cursor-web.js`) return `{ status: "ok"|"needs_login"|"error",
  records, loginUrl }`. `needs_login` (401/403, no org, no token, or `not_authenticated` body) → popup shows a
  clickable "Log in to X →" link. We deliberately do **not** infer login state from the native host
  ("no local logs" ≠ "not logged in" — would misfire). An earlier native-host `login_prompt` approach
  (in `9922acd`) was removed for this reason.
- Local parser is a supplement (request counts in the Usage section); the web connector is the quota source.

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
