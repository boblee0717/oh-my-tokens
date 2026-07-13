# Codex Quota Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking; completed work is marked `[x]`.

**Goal:** Ensure Codex plan usage only comes from the canonical local rate-limit family and cannot be overwritten by `codex_bengalfox`.

**Architecture:** The Codex parser keeps the newest raw rate-limit snapshot for credits, but uses a separately selected canonical `limit_id: "codex"` snapshot for plan quota. An empty or missing legacy ID is used only if no canonical snapshot exists. SwiftBar continues to render the parser output unchanged.

**Tech Stack:** Node.js ESM, `node:test`, Chrome MV3 manifest, SwiftBar.

---

### Task 1: Reproduce the changed alternate-limit payload

**Files:**
- Modify: `host/fixtures/codex-bengalfox/sessions/2026/05/26/rollout-2026-05-26T09-00-00-ffff6666-0000-0000-0000-000000000006.jsonl:3`
- Modify: `host/test/codex.test.js:108-119`
- Create: `host/fixtures/codex-rate-limit-source/sessions/2026/05/26/rollout-2026-05-26T09-00-00-11112222-0000-0000-0000-000000000007.jsonl`
- Create: `host/fixtures/codex-canonical-zero/sessions/2026/05/26/rollout-2026-05-26T09-00-00-33334444-0000-0000-0000-000000000008.jsonl`

- [x] Changed the alternate fixture's `plan_type` from `null` to `"prolite"`, preserving its `limit_id: "codex_bengalfox"` and `used_percent: 0`.
- [x] Added a test that expects no quota record for that fixture.
- [x] Added the single-session `codex-rate-limit-source` fixture: its earlier canonical `limit_id: "codex"` record reports 5h `18` and Weekly `44`, while its later `codex_bengalfox` record reports `0` with `plan_type: "prolite"`. The regression asserts exactly two quota records (5h and Weekly), both at the canonical timestamp, with no extra `0` record.
- [x] Added `codex-canonical-zero` to verify a real canonical reset still renders 0%.
- [x] Ran `node --test host/test/codex.test.js` before production changes: 10 passed, 2 failed for the intended bengalfox cases.

### Task 2: Select the canonical plan quota source

**Files:**
- Modify: `host/parsers/codex.js:36-275`

- [x] Kept the newest rate-limit snapshot over all sessions for `creditsRecord`.
- [x] Preserved each rate-limit snapshot and select the newest canonical `limit_id === "codex"` snapshot, falling back to an empty or missing ID only when no canonical snapshot exists.
- [x] Generated `quotaRecord` values from the canonical snapshot, or from legacy only when canonical is absent. Other non-empty IDs do not generate plan quota.
- [x] Removed the `used_percent === 0 && planType == null` suppression so a real canonical reset displays `0%`.
- [x] Re-ran `node --test host/test/codex.test.js`: 12 passed, 0 failed.

### Task 3: Version and end-to-end verification

**Files:**
- Modify: `extension/manifest.json:4`

- [x] Bumped the extension version from `0.6.6` to `0.6.7`, matching the project's previous host-parser bugfix release practice.
- [x] Ran `node --test host/test/*.test.js`: 58 passed, 0 failed, 1 Windows-only test skipped. After the final documentation update, `node --test host/test/codex.test.js` passed 12/12 and `node --test menubar/format.test.mjs` passed 8/8.
- [x] Fixture-based regression verifies that local quota is canonical rather than `codex_bengalfox`; a live `host/index.js` report cannot expose the source `limit_id` and is not used as that proof.
- [x] Ran `git diff --check` after the final documentation update; it completed without output.
- [ ] After review and release approval: use `host/install-macos.sh` and `menubar/install-menubar.sh` to sync the fixed native host and formatter into the installed runtime before validating direct SwiftBar output.
