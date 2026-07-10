import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUSD, priceForModel } from "../pricing.js";

test("gpt-5.6-sol uses its OpenRouter list price ahead of the generic GPT fallback", () => {
  assert.deepEqual(priceForModel("gpt-5.6-sol"), {
    inputPerMTok: 5,
    outputPerMTok: 30,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  });
  assert.equal(
    estimateCostUSD("gpt-5.6-sol", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    }),
    41.75,
  );
});

test("gpt-5.6-sol-pro uses the same OpenRouter list price", () => {
  assert.equal(
    estimateCostUSD("gpt-5.6-sol-pro", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }),
    5,
  );
});
