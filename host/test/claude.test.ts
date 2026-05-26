// Fix TZ so "today" (local-day) assertions are deterministic across machines.
process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeUsage } from "../parsers/claude.ts";
import type { UsageRecord, TimeWindow, MetricType } from "../../shared/schema.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseClaudeUsage({ baseDir: fixturesDir, now: NOW });
}

function pick(records: UsageRecord[], model: string, window: TimeWindow, metric: MetricType) {
  return records.find((r) => r.model === model && r.window === window && r.metricType === metric);
}

test("dedup: same (message.id, requestId) counted once, keeping the fuller line", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "measured_tokens")!;
  assert.ok(r, "expected a sonnet/today measured_tokens record");
  assert.equal(r.requests, 1); // two log lines, one logical message
  assert.equal(r.inputTokens, 100);
  assert.equal(r.outputTokens, 50); // the fuller line's output, not 0
  assert.equal(r.cacheTokens, 1200); // 200 creation + 1000 read
  assert.equal(r.confidence, "high");
  assert.equal(r.costUSD, null); // cost lives on a separate record
});

test("cost is a separate estimated_cost record, low confidence", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "estimated_cost")!;
  assert.ok(r, "expected a sonnet/today estimated_cost record");
  // (100*3 + 50*15 + 200*3.75 + 1000*0.3) / 1e6 = 2100/1e6
  assert.ok(Math.abs(r.costUSD! - 0.0021) < 1e-9);
  assert.equal(r.currency, "USD");
  assert.equal(r.confidence, "low");
  assert.equal(r.inputTokens, 0); // tokens are not duplicated onto the cost record
  assert.equal(r.warnings.length, 1);
});

test("unknown model: measured tokens (high), no cost record, with warning", async () => {
  const records = await run();
  const r = pick(records, "some-unknown-model", "today", "measured_tokens")!;
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
  // opus only on 2026-05-24 → in 7d and 30d, not today
  assert.equal(pick(records, "claude-opus-4-7", "today", "measured_tokens"), undefined);
  assert.ok(pick(records, "claude-opus-4-7", "7d", "measured_tokens"));
  assert.ok(pick(records, "claude-opus-4-7", "30d", "measured_tokens"));

  // sonnet 30d = today's msg_A + the 2026-05-10 msg_C; excludes 2026-03-01 msg_D
  const sonnet30 = pick(records, "claude-sonnet-4-6", "30d", "measured_tokens")!;
  assert.equal(sonnet30.requests, 2);
  assert.equal(sonnet30.inputTokens, 101);
  assert.equal(sonnet30.outputTokens, 52);

  // sonnet 7d excludes 2026-05-10 → same as today
  const sonnet7 = pick(records, "claude-sonnet-4-6", "7d", "measured_tokens")!;
  assert.equal(sonnet7.requests, 1);
  assert.equal(sonnet7.inputTokens, 100);
});

test("source path is tilde-normalized (no username leak)", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today", "measured_tokens")!;
  assert.equal(r.source.includes("/Users/"), false);
});

test("id follows the documented rule for both metric types", async () => {
  const records = await run();
  assert.equal(
    pick(records, "claude-opus-4-7", "7d", "measured_tokens")!.id,
    "claude-code:claude-opus-4-7:7d:measured_tokens",
  );
  assert.equal(
    pick(records, "claude-opus-4-7", "7d", "estimated_cost")!.id,
    "claude-code:claude-opus-4-7:7d:estimated_cost",
  );
});

test("missing baseDir yields no records, not a throw", async () => {
  assert.deepEqual(await parseClaudeUsage({ baseDir: "/no/such/dir/xyz", now: NOW }), []);
});
