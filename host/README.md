# host

The local Native Messaging host. It reads local usage logs and (later) the DeepSeek
API, normalizes everything to [`shared/schema.ts`](../shared/schema.ts), and returns
JSON to the extension. Runs on demand — no daemon, no open port.

> **M1 scope:** Claude Code parser only. Codex (M2), DeepSeek (M3) and the
> Native-Messaging wrapper / packaging (M5) come later.

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
node --test host/test/claude.test.ts
```

Tests run against a **desensitized synthetic fixture** (`fixtures/claude-sample.jsonl`),
not real logs, and cover dedup, cost estimation, unknown models, the synthetic/zero-token
skip, time-window nesting, and the missing-dir case.

## What the Claude parser does

- Scans `*.jsonl` under the base dir, keeps `type === "assistant"` entries.
- **Dedups by `(message.id, requestId)`** — Claude Code streams one logical message
  across several log lines; counting each line double-counts tokens. We keep the
  fullest entry per key. This matches how `ccusage` reconciles.
- Skips `<synthetic>` and zero-token entries.
- Aggregates tokens by model across `today` / `7d` / `30d` (UTC day boundaries).
- Estimates cost from a static per-family price table.

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
