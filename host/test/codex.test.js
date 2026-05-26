process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCodexUsage } from "../parsers/codex.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseCodexUsage({ baseDir, now: NOW });
}
function pick(records, model, window) {
  return records.find((r) => r.model === model && r.window === window);
}

test("uses the final (cumulative) total_token_usage per session", async () => {
  const r = pick(await run(), "gpt-5.5", "today");
  assert.ok(r, "expected gpt-5.5/today");
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.cacheTokens, 1000);
  assert.equal(r.outputTokens, 750);
  assert.equal(r.requests, 1);
});

test("dedups a session present in both sessions/ and archived_sessions/", async () => {
  const r = pick(await run(), "gpt-5.4", "7d");
  assert.ok(r);
  assert.equal(r.requests, 1);
  assert.equal(r.inputTokens, 400);
  assert.equal(r.cacheTokens, 100);
  assert.equal(r.outputTokens, 100);
});

test("cost is null for Codex with explicit warnings", async () => {
  const r = pick(await run(), "gpt-5.5", "today");
  assert.equal(r.costUSD, null);
  assert.equal(r.currency, null);
  assert.ok(r.warnings.some((w) => w.includes("cost not estimated")));
  assert.ok(r.warnings.some((w) => w.includes("counts sessions")));
});

test("windows: out-of-30d session excluded; gpt-5.4 not in today", async () => {
  const records = await run();
  const gpt55_30 = pick(records, "gpt-5.5", "30d");
  assert.equal(gpt55_30.inputTokens, 2000);
  assert.equal(gpt55_30.requests, 1);
  assert.equal(pick(records, "gpt-5.4", "today"), undefined);
  assert.ok(pick(records, "gpt-5.4", "30d"));
});

test("id rule and missing-dir safety", async () => {
  const r = pick(await run(), "gpt-5.4", "7d");
  assert.equal(r.id, "codex:gpt-5.4:7d:measured_tokens");
  assert.deepEqual(await parseCodexUsage({ baseDir: "/no/such/dir", now: NOW }), []);
});

test("surfaces the latest rate_limits as quota_percent records (5h + weekly)", async () => {
  const records = await run();
  const quota = records.filter((r) => r.metricType === "quota_percent");
  assert.equal(quota.length, 2);

  const five = quota.find((q) => q.windowLabel === "5h");
  assert.equal(five.usedPercent, 18);
  assert.equal(five.planType, "plus");
  assert.equal(five.provider, "codex");
  assert.equal(five.model, null);
  assert.ok(five.resetsAt);

  const weekly = quota.find((q) => q.windowLabel === "Weekly");
  assert.equal(weekly.usedPercent, 42);
});

test("credits plan (null primary/secondary) surfaces a credits balance record", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-credits");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  const bal = records.find((r) => r.metricType === "balance" && r.provider === "codex");
  assert.ok(bal, "expected a Codex credits balance record");
  assert.equal(bal.balance, 0);
  assert.equal(bal.currency, "credits");
  assert.equal(bal.planType, "prolite");
  assert.equal(records.some((r) => r.metricType === "quota_percent"), false);
});

test("falls back to filename-derived session id when session_meta is absent", async () => {
  const noMetaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-nometa");
  const records = await parseCodexUsage({ baseDir: noMetaDir, now: NOW });
  const r = records.find((x) => x.model === "gpt-5.5" && x.window === "today");
  assert.ok(r, "session without session_meta should still be parsed via filename id");
  assert.equal(r.inputTokens, 500);
  assert.equal(r.cacheTokens, 200);
  assert.equal(r.outputTokens, 100);
  assert.equal(r.requests, 1);
});
