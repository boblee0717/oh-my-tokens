import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseClaudeUsage } from "../parsers/claude.ts";
import type { UsageRecord, TimeWindow } from "../../shared/schema.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseClaudeUsage({ baseDir: fixturesDir, now: NOW });
}

function pick(records: UsageRecord[], model: string, window: TimeWindow) {
  return records.find((r) => r.model === model && r.window === window);
}

test("dedup: same (message.id, requestId) counted once, keeping the fuller line", async () => {
  const sonnetToday = pick(await run(), "claude-sonnet-4-6", "today")!;
  assert.ok(sonnetToday, "expected a sonnet/today record");
  assert.equal(sonnetToday.requests, 1); // two log lines, one logical message
  assert.equal(sonnetToday.inputTokens, 100);
  assert.equal(sonnetToday.outputTokens, 50); // the fuller line's output, not 0
  assert.equal(sonnetToday.cacheTokens, 1200); // 200 creation + 1000 read
});

test("estimated cost for a known model (sonnet today)", async () => {
  const r = pick(await run(), "claude-sonnet-4-6", "today")!;
  // (100*3 + 50*15 + 200*3.75 + 1000*0.3) / 1e6 = 2100/1e6
  assert.ok(r.costUSD !== null);
  assert.ok(Math.abs(r.costUSD! - 0.0021) < 1e-9);
  assert.equal(r.currency, "USD");
  assert.equal(r.confidence, "high");
  assert.equal(r.metricType, "measured_tokens");
});

test("unknown model: tokens measured, cost null + warning + medium confidence", async () => {
  const r = pick(await run(), "some-unknown-model", "today")!;
  assert.equal(r.inputTokens, 5);
  assert.equal(r.costUSD, null);
  assert.equal(r.currency, null);
  assert.equal(r.confidence, "medium");
  assert.equal(r.warnings.length, 1);
});

test("synthetic and zero-token entries are skipped", async () => {
  const records = await run();
  assert.equal(pick(records, "<synthetic>", "today"), undefined);
});

test("time windows are nested (today subset of 7d subset of 30d)", async () => {
  const records = await run();
  // opus only appears on 2026-05-24 → in 7d and 30d, not today
  assert.equal(pick(records, "claude-opus-4-7", "today"), undefined);
  assert.ok(pick(records, "claude-opus-4-7", "7d"));
  assert.ok(pick(records, "claude-opus-4-7", "30d"));

  // sonnet 30d aggregates today's message (msg_A) + the 2026-05-10 one (msg_C),
  // but excludes 2026-03-01 (msg_D, outside 30d).
  const sonnet30 = pick(records, "claude-sonnet-4-6", "30d")!;
  assert.equal(sonnet30.requests, 2);
  assert.equal(sonnet30.inputTokens, 101); // 100 + 1
  assert.equal(sonnet30.outputTokens, 52); // 50 + 2

  // sonnet 7d excludes the 2026-05-10 message → same as today.
  const sonnet7 = pick(records, "claude-sonnet-4-6", "7d")!;
  assert.equal(sonnet7.requests, 1);
  assert.equal(sonnet7.inputTokens, 100);
});

test("id follows the documented rule", async () => {
  const r = pick(await run(), "claude-opus-4-7", "7d")!;
  assert.equal(r.id, "claude-code:claude-opus-4-7:7d:measured_tokens");
});

test("missing baseDir yields no records, not a throw", async () => {
  const records = await parseClaudeUsage({ baseDir: "/no/such/dir/xyz", now: NOW });
  assert.deepEqual(records, []);
});
