// Fetches DeepSeek account balance via the platform API.
// Unlike Claude Code / Codex, DeepSeek leaves no local logs, so this is the one
// provider that talks to a remote API. The API key lives in the host's local config
// (env DEEPSEEK_API_KEY) and is never sent to the extension.
//
// Endpoint: GET https://api.deepseek.com/user/balance
//   Authorization: Bearer <key>
//   → { "is_available": bool, "balance_infos": [ { "currency", "total_balance", ... } ] }
//
// Balance is a point-in-time figure, not a windowed usage total. DeepSeek does not
// expose historical token usage via a simple API, so balance is the M3 deliverable.

import type { UsageRecord } from "../../shared/schema.ts";

export interface DeepSeekOptions {
  apiKey?: string; // default process.env.DEEPSEEK_API_KEY
  now?: Date;
  baseUrl?: string; // default https://api.deepseek.com
  fetchImpl?: typeof fetch; // injectable for tests
}

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
}

// Returns balance records (one per currency), or [] when no key is configured.
// Throws on HTTP / network failure so the caller can report it.
export async function parseDeepSeekUsage(opts: DeepSeekOptions = {}): Promise<UsageRecord[]> {
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return []; // not configured → simply absent

  const now = opts.now ?? new Date();
  const baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${baseUrl}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DeepSeek balance HTTP ${res.status}`);
  }
  const body = (await res.json()) as { is_available?: boolean; balance_infos?: BalanceInfo[] };

  const updatedAt = now.toISOString();
  const infos = body.balance_infos ?? [];
  const warnings: string[] = ["balance is a point-in-time figure, not a usage total"];
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
