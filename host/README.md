# host

The local Native Messaging host. It reads local usage logs and (later) the DeepSeek
API, normalizes everything to [`shared/schema.ts`](../shared/schema.ts), and returns
JSON to the extension. Runs on demand — no daemon, no open port.

> **Scope:** Claude Code (M1) + Codex (M2) parsers, DeepSeek balance (M3), and the
> Native Messaging host wrapper + install (M5). The popup UI lives in [`../extension`](../extension).

## Requirements

Node ≥ 18. The host is plain JavaScript (ESM) — no build, no deps, no TS runtime.

## Run

```bash
# Print a UsageReport for Claude Code + Codex + DeepSeek
node host/index.js

# DeepSeek balance requires an API key in the environment
DEEPSEEK_API_KEY=sk-... node host/index.js
```

## Test

```bash
node --test host/test/claude.test.js host/test/codex.test.js host/test/deepseek.test.js host/test/native-host.test.js
```

## Install as a Chrome Native Messaging host (macOS)

This lets the extension pull live data instead of the bundled sample.

```bash
# 1. Load the extension unpacked (chrome://extensions → Load unpacked → ../extension)
#    and copy its Extension ID.
# 2. Register the host (default Chrome; pass a channel for others):
./host/install-macos.sh <EXTENSION_ID>           # stable Chrome
# ./host/install-macos.sh <EXTENSION_ID> canary  # chrome | beta | canary | chromium | edge
# 3. (optional) configure a DeepSeek key for balance — see below.
# 4. Reload the extension and open the popup.
```

### DeepSeek API key

The key stays on your machine (never synced). Resolution order:

1. **Extension Options** — paste it in the popup's Options page. Stored in
   `chrome.storage.local` and sent to the host over native messaging. Easiest; no file editing.
2. **`~/.oh-my-tokens/config.json`** (or `~/.config/oh-my-tokens/config.json`, or `host/config.json`):
   ```json
   { "deepseekApiKey": "sk-..." }
   ```
   See `host/config.example.json`. Keeps the key out of the browser entirely.
3. **`DEEPSEEK_API_KEY`** env var — handy for the CLI (`DEEPSEEK_API_KEY=sk-... node host/index.js`);
   note GUI Chrome on macOS does not inherit your shell env, so this rarely works for the popup.

`install-macos.sh` copies the host runtime to `~/.oh-my-tokens/native-host/` and writes
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ohmytokens.host.json`
pointing at that installed `run-host.sh` (which resolves `node` and runs `native-host.js`).
This avoids pointing Chrome at an arbitrary clone path such as `~/Documents`, where macOS
privacy controls can prevent Chrome's child process from opening the script. The host
speaks Chrome's length-prefixed stdio protocol: it reads one request and replies with the
`UsageReport`. Verified locally end-to-end with a framed request/response.

Tests run against **desensitized synthetic fixtures** (`fixtures/`), not real logs, and
cover dedup, cost estimation, unknown models, the synthetic/zero-token skip, time-window
nesting (local day), tilde source, and the missing-dir case. Tests pin `TZ=UTC` so the
local-day assertions are deterministic.

## What the Claude parser does

- Scans `*.jsonl` under the base dir, keeps `type === "assistant"` entries.
- **Dedups by `(message.id, requestId)`** — Claude Code streams one logical message
  across several log lines; counting each line double-counts tokens. We keep the
  fullest entry per key. This matches how `ccusage` reconciles.
- Skips `<synthetic>` and zero-token entries.
- Aggregates tokens by model across `today` / `7d` / `30d` (**local** day boundary for `today`).
- Emits **two records** per (model, window): a `measured_tokens` record (high confidence,
  reconciles with `ccusage`) and, when the model is priced, a separate `estimated_cost`
  record (low confidence) — so the UI never treats a token-derived dollar guess as billing.
- `source` is tilde-normalized (`~/.claude/projects`) so the UI never leaks the username.

## What the Codex parser does

- Scans `sessions/**` and `archived_sessions/**` under `~/.codex`.
- Each `rollout-*.jsonl` is one session; its `token_count` events carry a **cumulative**
  `info.total_token_usage`, so we take the entry with the largest `total_tokens` as the
  session total (it's monotonic). We map `cached_input_tokens` → cache, `input − cached`
  → input, `output + reasoning` → output.
- **Dedups by session id** so a session in both `sessions/` and `archived_sessions/` counts once.
- Cost is **not** estimated (no authoritative gpt-5.x prices yet); records carry a warning.
- `requests` counts **sessions**, not turns (flagged in `warnings`).

- **Quota (M7):** Codex `token_count` events carry `rate_limits` (`plan_type` + `used_percent`
  over a 5h "primary" and weekly "secondary" window). We surface the **most recent** one as
  `quota_percent` records (one per window) with `usedPercent`, `windowLabel`, `resetsAt`, `planType`.
  This is the real subscription-quota signal the popup shows as progress bars.

### Codex reconciliation note vs `ccusage`

My Codex totals run **~25-30% below `ccusage`**. Investigated: within a session the
cumulative `total_token_usage` is monotonic (e.g. one real session grows to 1.24B total
tokens with zero resets), while summing per-event `last_token_usage` deltas gives 1.64B —
because Codex emits **duplicate `token_count` events** that repeat a delta. We use the
final cumulative total (Codex's own authoritative session figure); `ccusage` appears to sum
deltas including duplicates, which over-counts. I believe the cumulative total is the more
correct number, but the divergence is flagged here rather than claimed as a match — an
item to confirm with the `ccusage` maintainers' intent.

## What the DeepSeek client does

- Calls `GET {baseUrl}/user/balance` with `Authorization: Bearer <key>` (key from the
  resolution order above: extension options → config file → env).
- Emits one `balance` record per currency (e.g. CNY, USD); `model` is null.
- No key configured → returns nothing (DeepSeek simply absent, not an error).
- `fetch` is injectable so the client is unit-tested without a live key / network.
- DeepSeek exposes no simple historical-usage API, so balance (point-in-time) is the
  M3 deliverable; token-level DeepSeek usage would require a proxy and is out of scope.

## Reconciliation vs `ccusage` (2026-05-26, real local logs)

| metric | this parser (30d) | `ccusage` (Claude only) | delta |
|--------|-------------------|-------------------------|-------|
| input tokens | 46,799 | 46,803 | ~0.01% |
| output tokens | 1,001,258 | 1,002,257 | ~0.10% |
| cache tokens | 364,762,677 | 365,216,130 | ~0.12% |
| **est. cost** | **$759.30** | **$308.35** | **~2.5×** |

**Tokens reconcile tightly.** Cost does **not**: our static family price table does not
match the actual 2026 model prices that `ccusage` pulls from LiteLLM. Therefore cost is
emitted as a clearly-labelled provisional estimate (`warnings[]` on every cost record),
and an authoritative price source (LiteLLM-style pricing, or reusing `ccusage`'s cost
engine) is a tracked follow-up. Token counts are the trustworthy M1 output.
