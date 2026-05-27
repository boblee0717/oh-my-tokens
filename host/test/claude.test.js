process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeUsage } from "../parsers/claude.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseClaudeUsage({ baseDir: fixturesDir, now: NOW });
}

function pick(records, model, window, metric) {
  return records.find((r) => r.model === model && r.window === window && r.metricType === metric);
}

test("dedup: same (message.id, requestId) counted once, keeping the fuller line", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "measured_tokens");
  assert.ok(r, "expected a sonnet/today measured_tokens record");
  assert.equal(r.requests, 1);
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 50);
  assert.equal(r.cacheTokens, 1200);
  assert.equal(r.confidence, "high");
  assert.equal(r.costUSD, null);
});

test("cost is a separate estimated_cost record, low confidence", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "estimated_cost");
  assert.ok(r, "expected a sonnet/today estimated_cost record");
  assert.ok(Math.abs(r.costUSD - 0.0021) < 1e-9);
  assert.equal(r.currency, "USD");
  assert.equal(r.confidence, "low");
  assert.equal(r.inputTokens, 0);
  assert.equal(r.warnings.length, 1);
});

test("unknown model: measured tokens (high), no cost record, with warning", async () => {
  const records = await run();
  const r = pick(records, "some-unknown-model", "today", "measured_tokens");
  assert.equal(r.inputTokens, 5);
  assert.equal(r.confidence, "high");
  assert.equal(r.costUSD, null);
  assert.equal(r.warnings.length, 1);
  assert.equal(pick(records, "some-unknown-model", "today", "estimated_cost"), undefined);
});

test("synthetic and zero-token entries are skipped", async () => {
  const records = await run();
  assert.equal(records.some((r) => r.model === "<synthetic>"), false);
});

test("time windows use local day for today and are nested", async () => {
  const records = await run();
  assert.equal(pick(records, "claude-opus-4-7", "today", "measured_tokens"), undefined);
  assert.ok(pick(records, "claude-opus-4-7", "7d", "measured_tokens"));
  assert.ok(pick(records, "claude-opus-4-7", "30d", "measured_tokens"));

  const sonnet30 = pick(records, "claude-sonnet-4-6", "30d", "measured_tokens");
  assert.equal(sonnet30.requests, 2);
  assert.equal(sonnet30.inputTokens, 101);
  assert.equal(sonnet30.outputTokens, 52);

  const sonnet7 = pick(records, "claude-sonnet-4-6", "7d", "measured_tokens");
  assert.equal(sonnet7.requests, 1);
  assert.equal(sonnet7.inputTokens, 100);
});

test("source path is tilde-normalized (no username leak)", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "measured_tokens");
  assert.equal(r.source.includes("/Users/"), false);
});

test("id follows the documented rule for both metric types", async () => {
  const records = await run();
  assert.equal(
    pick(records, "claude-opus-4-7", "7d", "measured_tokens").id,
    "claude-code:claude-opus-4-7:7d:measured_tokens",
  );
  assert.equal(
    pick(records, "claude-opus-4-7", "7d", "estimated_cost").id,
    "claude-code:claude-opus-4-7:7d:estimated_cost",
  );
});

test("missing baseDir yields login_prompt records, not a throw", async () => {
  const records = await parseClaudeUsage({ baseDir: "/no/such/dir/xyz", now: NOW });
  assert.equal(records.length, 3); // one per time window
  assert.ok(records.every((r) => r.metricType === "login_prompt"));
  assert.ok(records.every((r) => r.warnings.length === 1));
});

test("missing baseDir login_prompt records include expected windows", async () => {
  const records = await parseClaudeUsage({ baseDir: "/no/such/dir/xyz", now: NOW });
  for (const w of ["today", "7d", "30d"]) {
    assert.ok(records.some((r) => r.window === w), `expected window ${w}`);
  }
});
