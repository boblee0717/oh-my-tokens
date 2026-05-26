import { getDeepSeekApiKey } from "../config.js";

export async function parseDeepSeekUsage(opts = {}) {
  const apiKey = opts.apiKey ?? (await (opts.resolveKey ?? getDeepSeekApiKey)());
  if (!apiKey) return [];

  const now = opts.now ?? new Date();
  const baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DeepSeek balance HTTP ${res.status}`);
  }
  const body = await res.json();

  const updatedAt = now.toISOString();
  const infos = body.balance_infos ?? [];
  const warnings = ["balance is a point-in-time figure, not a usage total"];
  if (body.is_available === false) warnings.push("DeepSeek reports the account as not available");

  return infos.map((info) => {
    const currency = info.currency ?? "";
    const balance = Number.parseFloat(info.total_balance ?? "");
    return {
      id: `deepseek::today:balance:${currency.toLowerCase()}`,
      provider: "deepseek",
      model: null,
      metricType: "balance",
      source: `${baseUrl}/user/balance`,
      window: "today",
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      requests: 0,
      costUSD: null,
      balance: Number.isFinite(balance) ? balance : null,
      currency: currency || null,
      updatedAt,
      confidence: "high",
      warnings,
    };
  });
}
