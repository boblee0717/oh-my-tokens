// Estimated Anthropic pricing for Claude models, USD per 1M tokens.
// Public list prices, matched by model family (sonnet / opus / haiku) so that
// dated model ids like "claude-sonnet-4-6" still resolve. Update as prices change.
// These drive an ESTIMATE only — subscription billing is not token-metered.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number; // 5m cache write
  cacheReadPerMTok: number;
}

const FAMILY_PRICES: Record<string, ModelPrice> = {
  opus: { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

export function priceForModel(model: string | null): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const family of Object.keys(FAMILY_PRICES)) {
    if (m.includes(family)) return FAMILY_PRICES[family];
  }
  return null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// Returns estimated USD, or null when the model has no known price.
export function estimateCostUSD(model: string | null, t: TokenCounts): number | null {
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
