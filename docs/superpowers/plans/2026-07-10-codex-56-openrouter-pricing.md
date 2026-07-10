# Codex 5.6 OpenRouter Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit and display OpenRouter-list-price estimated cost for local GPT-5.6 Codex usage in the Chrome extension and macOS menu bar.

**Architecture:** `host/pricing.js` resolves exact 5.6 Luna, Terra, and Sol model names before the existing family fallback. `host/report.js` emits a shared `estimated_cost` record, which the extension popup and SwiftBar formatter already render.

**Tech Stack:** Node.js ESM, `node:test`, Chrome MV3 extension, SwiftBar.

---

### Task 1: Pin exact price selection

**Files:** Create `host/test/pricing.test.js`; modify `host/pricing.js:1-21`.

- [ ] Write a failing `node:test` asserting `priceForModel("gpt-5.6-sol")` has input 5, output 30, cache write 6.25, cache read 0.5 (all USD/MTok), and four 1M token categories total `41.75` USD.
- [ ] Add another test that `gpt-5.6-sol-pro` charges `5` USD for 1M uncached input tokens.
- [ ] Run `node --test host/test/pricing.test.js`; it must fail because the generic `gpt` rate is currently selected.
- [ ] Add exact lowercase keys `gpt-5.6-sol` and `gpt-5.6-sol-pro` to `MODEL_PRICES`, then look up `MODEL_PRICES[m]` before the current family loop. Use `{ inputPerMTok: 5, outputPerMTok: 30, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 }` for each.
- [ ] Re-run `node --test host/test/pricing.test.js`; it must pass.
- [ ] Commit only `host/pricing.js` and `host/test/pricing.test.js` with `fix: price Codex 5.6 Sol from OpenRouter`.

### Task 2: Prove shared host output reaches both consumers

**Files:** Modify `host/report.js:9-45`, `host/test/native-host.test.js`, `menubar/format.test.mjs`, and `extension/test/usage-client.test.mjs`.

- [ ] Write a failing native-host test using a temporary `HOME/.codex/sessions/2026/07/10` fixture with model `gpt-5.6-sol`, 1M input, 1M cached input, and 1M output. Assert the framed `getUsage` response has `costUSD === 35.5` and a warning containing `OpenRouter list price`.
- [ ] Add a formatter test whose report contains that `estimated_cost` record and whose first output line includes `$35.50`.
- [ ] Add an extension usage-client test asserting that a Codex `estimated_cost` record is retained after report normalization.
- [ ] Run `node --test host/test/native-host.test.js menubar/format.test.mjs extension/test/usage-client.test.mjs`; it must fail because the host warning says `assumed price table`.
- [ ] Replace the report warning with `estimated from the OpenRouter list price; not authoritative billing`; retain cache-token handling as cache reads because Codex logs expose no cache-write count.
- [ ] Re-run the focused tests; all must pass.
- [ ] Commit these integration changes with `test: verify Codex 5.6 cost consumers`.

### Task 3: Document and verify locally

**Files:** Modify `README.md:152-158`.

- [ ] Replace the Codex statement about an assumed GPT-tier table with: exact supported models use static OpenRouter list prices, and unknown models retain the existing generic estimate.
- [ ] Run `node --test host/test/*.test.js`, `node --test extension/test/*.test.mjs`, and `node --test menubar/format.test.mjs`; all must pass.
- [ ] Run `node host/index.js | jq '.records[] | select(.provider == "codex" and .model == "gpt-5.6-sol" and .metricType == "estimated_cost")'`. If no current session is within a report window, record that fact and use the framed-host test as the authoritative local display-chain proof.
- [ ] Run `git diff --check`, inspect `git diff --stat`, and commit `README.md` with `docs: document Codex OpenRouter pricing`.
