# host

The local Native Messaging host. It reads local usage logs and (later) the DeepSeek
API, normalizes everything to [`shared/schema.ts`](../shared/schema.ts), and returns
JSON to the extension. Runs on demand — no daemon, no open port.

> **Scope so far:** Claude Code parser (M1) + Codex parser (M2). DeepSeek (M3),
> extension UI (M4) and the Native-Messaging wrapper / packaging (M5) come later.

## Requirements

Node ≥ 22 (TypeScript runs directly; this repo is developed on Node 26). No build
step and no dependencies.

## Run

```bash
# Print a UsageReport for Claude Code (defaults to ~/.claude/projects)
node host/index.ts

# Point at a specific logs dir
node host/index.ts /path/to/.claude/projects
```

## Test

```bash
node --test host/test/claude.test.ts host/test/codex.test.ts
```

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

> Codex `token_count` events also carry `rate_limits` (`plan_type` + `used_percent` over a
> 5h and a weekly window) — the closest thing to a real subscription-quota signal. Surfacing
> it is a candidate for M4; M2 is token usage only.

### Codex reconciliation note vs `ccusage`

My Codex totals run **~25-30% below `ccusage`**. Investigated: within a session the
cumulative `total_token_usage` is monotonic (e.g. one real session grows to 1.24B total
tokens with zero resets), while summing per-event `last_token_usage` deltas gives 1.64B —
because Codex emits **duplicate `token_count` events** that repeat a delta. We use the
final cumulative total (Codex's own authoritative session figure); `ccusage` appears to sum
deltas including duplicates, which over-counts. I believe the cumulative total is the more
correct number, but the divergence is flagged here rather than claimed as a match — an
item to confirm with the `ccusage` maintainers' intent.

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
