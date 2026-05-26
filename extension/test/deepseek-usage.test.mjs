process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapDeepSeekUsage } from "../deepseek-usage.js";

const NOW = new Date("2026-05-26T12:00:00.000Z");

// Shape captured from platform.deepseek.com/api/v0/usage/amount (2026-05-26).
const sample = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      total: [
        {
          model: "deepseek-v4-pro",
          usage: [
            { type: "REQUEST", amount: "310" },
            { type: "RESPONSE_TOKEN", amount: "12000000" },
            { type: "PROMPT_CACHE_MISS_TOKEN", amount: "18000000" },
            { type: "PROMPT_CACHE_HIT_TOKEN", amount: "11065434" },
          ],
        },
      ],
      days: [
        {
          date: "2026-05-26",
          data: [
            {
              model: "deepseek-v4-pro",
              usage: [
                { type: "REQUEST", amount: "12" },
                { type: "RESPONSE_TOKEN", amount: "345678" },
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "456789" },
                { type: "PROMPT_CACHE_HIT_TOKEN", amount: "567890" },
              ],
            },
          ],
        },
        {
          date: "2026-05-10",
          data: [
            {
              model: "deepseek-v4-pro",
              usage: [
                { type: "REQUEST", amount: "5" },
                { type: "RESPONSE_TOKEN", amount: "1000" },
                { type: "PROMPT_CACHE_MISS_TOKEN", amount: "2000" },
                { type: "PROMPT_CACHE_HIT_TOKEN", amount: "3000" },
              ],
            },
          ],
        },
      ],
    },
  },
};

function pick(records, model, window) {
  return records.find((r) => r.model === model && r.window === window);
}

test("maps days[] usage to measured_tokens with correct token mapping", () => {
  const today = pick(mapDeepSeekUsage(sample, NOW), "deepseek-v4-pro", "today");
  assert.ok(today);
  assert.equal(today.provider, "deepseek");
  assert.equal(today.requests, 12);
  assert.equal(today.outputTokens, 345678); // RESPONSE_TOKEN
  assert.equal(today.inputTokens, 456789); // PROMPT_CACHE_MISS_TOKEN
  assert.equal(today.cacheTokens, 567890); // PROMPT_CACHE_HIT_TOKEN
  assert.equal(today.id, "deepseek:deepseek-v4-pro:today:measured_tokens");
});

test("windows aggregate by date: 30d includes the 2026-05-10 day, 7d/today don't", () => {
  const recs = mapDeepSeekUsage(sample, NOW);
  // today/7d: only the 2026-05-26 day
  assert.equal(pick(recs, "deepseek-v4-pro", "7d").requests, 12);
  // 30d: 2026-05-26 (12) + 2026-05-10 (5) = 17
  assert.equal(pick(recs, "deepseek-v4-pro", "30d").requests, 17);
  assert.equal(pick(recs, "deepseek-v4-pro", "30d").outputTokens, 345678 + 1000);
});

test("amount strings are coerced to numbers", () => {
  const t = pick(mapDeepSeekUsage(sample, NOW), "deepseek-v4-pro", "today");
  assert.equal(typeof t.requests, "number");
  assert.equal(typeof t.outputTokens, "number");
});

test("bad / empty input yields []", () => {
  assert.deepEqual(mapDeepSeekUsage(null, NOW), []);
  assert.deepEqual(mapDeepSeekUsage({}, NOW), []);
  assert.deepEqual(mapDeepSeekUsage({ data: { biz_data: { days: [] } } }, NOW), []);
});
