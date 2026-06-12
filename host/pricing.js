const FAMILY_PRICES = {
  // Claude Fable 5 / Mythos 5 — $10 in / $50 out per MTok; cache write 1.25x, cache read 0.1x input
  fable: { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
  mythos: { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 1 },
  // Opus 4.6/4.7/4.8 — $5 in / $25 out per MTok (the old $15/$75 was Claude 3 Opus, retired Jan 2026)
  opus: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  sonnet: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  haiku: { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
  // Codex / OpenAI GPT — ASSUMED rates (GPT-5 tier). Adjust here if you know the real
  // numbers; used only for the "estimated cost" figure, never for billing.
  gpt: { inputPerMTok: 1.25, outputPerMTok: 10, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.125 },
  codex: { inputPerMTok: 1.25, outputPerMTok: 10, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.125 },
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
