process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseKimiUsage } from "../parsers/kimi.js";
import { tildePath } from "../util.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "kimi");
const NOW = new Date("2026-07-06T12:00:00.000Z");
const SOURCE = tildePath(baseDir);

function pick(records, model, window) {
  return records.find((r) => r.model === model && r.window === window && r.metricType === "measured_tokens");
}

test("aggregates Kimi Code per-turn usage by model and window", async () => {
  const records = await parseKimiUsage({ baseDir, now: NOW });

  const today = pick(records, "kimi-code/k3", "today");
  assert.ok(today, "expected kimi-code/k3 today measured tokens");
  assert.equal(today.provider, "kimi");
  assert.equal(today.source, SOURCE);
  assert.equal(today.id, "kimi:kimi-code/k3:today:measured_tokens");
  assert.equal(today.inputTokens, 1500);
  assert.equal(today.outputTokens, 300);
  assert.equal(today.cacheTokens, 450);
  assert.equal(today.requests, 2);
  assert.equal(today.confidence, "high");
  assert.equal(today.costUSD, null);
  assert.ok(today.warnings.some((w) => w.includes("counts LLM turns")));

  // The 2026-07-02 turn joins the 7d/30d windows; the 2026-05-01 turn is outside 30d.
  const seven = pick(records, "kimi-code/k3", "7d");
  assert.ok(seven, "expected kimi-code/k3 7d measured tokens");
  assert.equal(seven.inputTokens, 1800);
  assert.equal(seven.outputTokens, 360);
  assert.equal(seven.cacheTokens, 470);
  assert.equal(seven.requests, 3);

  const thirty = pick(records, "kimi-code/k3", "30d");
  assert.equal(thirty.inputTokens, 1800);
  assert.equal(thirty.requests, 3);
});

test("picks up subagent wire files and other models", async () => {
  const records = await parseKimiUsage({ baseDir, now: NOW });
  const sub = pick(records, "kimi-code/k2", "today");
  assert.ok(sub, "expected kimi-code/k2 from the subagent wire.jsonl");
  assert.equal(sub.inputTokens, 700);
  assert.equal(sub.outputTokens, 150);
  assert.equal(sub.cacheTokens, 30);
  assert.equal(sub.requests, 1);
});

test("skips non-turn usage scopes and malformed lines", async () => {
  const records = await parseKimiUsage({ baseDir, now: NOW });
  // The fixture's usageScope:"session" record (777 input tokens) must not appear anywhere.
  for (const r of records) {
    assert.ok(r.inputTokens < 7000, "session-scoped aggregate leaked into a window");
  }
});

test("missing Kimi sessions directory is empty", async () => {
  assert.deepEqual(await parseKimiUsage({ baseDir: "/no/such/kimi", now: NOW }), []);
});
