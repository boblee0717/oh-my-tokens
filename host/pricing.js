const FAMILY_PRICES = {
  opus: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

export function priceForModel(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const family of Object.keys(FAMILY_PRICES)) {
    if (m.includes(family)) return FAMILY_PRICES[family];
  }
  return null;
}

export function estimateCostUSD(model, t) {
  const p = priceForModel(model);
  if (!p) return null;
  return (
    (t.inputTokens * p.inputPerMTok +
      t.outputTokens * p.outputPerMTok +
      t.cacheCreationTokens * p.cacheWritePerMTok +
      t.cacheReadTokens * p.cacheReadPerMTok) /
    1_000_000
  );
}
