import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsageEvents } from "../cursor-usage.js";
import { estimateCostUSD } from "../pricing.js";

test("mapUsageEvents aggregates per-model tokens + cost from events", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  const todayMs = new Date(2026, 5, 1, 1, 0, 0).getTime(); // local today
  const events = [
    { timestamp: String(todayMs), model: "composer-2.5", tokenUsage: { inputTokens: 100, outputTokens: 50, totalCents: 250 } },
    { timestamp: String(todayMs), model: "composer-2.5", tokenUsage: { inputTokens: 10, outputTokens: 5, totalCents: 50 } },
  ];
  const recs = mapUsageEvents({ usageEventsDisplay: events }, now);
  const today = recs.filter((r) => r.window === "today");
  const tok = today.find((r) => r.metricType === "measured_tokens");
  const cost = today.find((r) => r.metricType === "estimated_cost");
  assert.equal(tok.provider, "cursor");
  assert.equal(tok.inputTokens, 110);
  assert.equal(tok.outputTokens, 55);
  assert.equal(tok.requests, 2);
  assert.equal(cost.costUSD, 3); // (250 + 50) cents
});

test("estimateCostUSD prices gpt/codex models (Codex cost estimate)", () => {
  const c = estimateCostUSD("gpt-5.5", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  assert.equal(c, 1.25 + 10); // input 1.25/M + output 10/M
  assert.equal(estimateCostUSD("unknown-model", { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }), null);
});
