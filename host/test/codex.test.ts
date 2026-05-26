// Fix TZ so "today" (local-day) assertions are deterministic across machines.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCodexUsage } from "../parsers/codex.ts";
import type { UsageRecord, TimeWindow } from "../../shared/schema.ts";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseCodexUsage({ baseDir, now: NOW });
}
function pick(records: UsageRecord[], model: string, window: TimeWindow) {
  return records.find((r) => r.model === model && r.window === window);
}

test("uses the final (cumulative) total_token_usage per session", async () => {
  const r = pick(await run(), "gpt-5.5", "today")!;
  assert.ok(r, "expected gpt-5.5/today");
  // final total: input 3000 (− cached 1000) = 2000 input, cache 1000, output 600+150 reasoning = 750
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.cacheTokens, 1000);
  assert.equal(r.outputTokens, 750);
  assert.equal(r.requests, 1);
});

test("dedups a session present in both sessions/ and archived_sessions/", async () => {
  const r = pick(await run(), "gpt-5.4", "7d")!;
  assert.ok(r);
  assert.equal(r.requests, 1); // not 2
  assert.equal(r.inputTokens, 400); // 500 − 100 cached
  assert.equal(r.cacheTokens, 100);
  assert.equal(r.outputTokens, 100); // 80 + 20 reasoning
});

test("cost is null for Codex with explicit warnings", async () => {
  const r = pick(await run(), "gpt-5.5", "today")!;
  assert.equal(r.costUSD, null);
  assert.equal(r.currency, null);
  assert.ok(r.warnings.some((w) => w.includes("cost not estimated")));
  assert.ok(r.warnings.some((w) => w.includes("counts sessions")));
});

test("windows: out-of-30d session excluded; gpt-5.4 not in today", async () => {
  const records = await run();
  // cccc3333 is 2026-03-01 → outside 30d, so its gpt-5.5 tokens must not inflate 30d
  const gpt55_30 = pick(records, "gpt-5.5", "30d")!;
  assert.equal(gpt55_30.inputTokens, 2000); // only session1, not the 9999 one
  assert.equal(gpt55_30.requests, 1);
  // gpt-5.4 session is 2026-05-22 → in 7d/30d, not today
  assert.equal(pick(records, "gpt-5.4", "today"), undefined);
  assert.ok(pick(records, "gpt-5.4", "30d"));
});

test("id rule and missing-dir safety", async () => {
  const r = pick(await run(), "gpt-5.4", "7d")!;
  assert.equal(r.id, "codex:gpt-5.4:7d:measured_tokens");
  assert.deepEqual(await parseCodexUsage({ baseDir: "/no/such/dir", now: NOW }), []);
});

test("falls back to filename-derived session id when session_meta is absent", async () => {
  const noMetaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-nometa");
  const records = await parseCodexUsage({ baseDir: noMetaDir, now: NOW });
  const r = records.find((x) => x.model === "gpt-5.5" && x.window === "today")!;
  assert.ok(r, "session without session_meta should still be parsed via filename id");
  assert.equal(r.inputTokens, 500); // 700 − 200 cached
  assert.equal(r.cacheTokens, 200);
  assert.equal(r.outputTokens, 100); // 90 + 10 reasoning
  assert.equal(r.requests, 1);
});
