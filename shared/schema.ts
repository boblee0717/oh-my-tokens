// Normalized usage schema shared by the native host and the extension.
// Draft for M0 — fields may evolve as parsers land (M1–M3).

export type Provider = "claude-code" | "codex" | "deepseek";

// How a number was obtained, so the UI never conflates a real balance with an estimate.
export type MetricType =
  | "measured_tokens" // counted directly from local logs
  | "estimated_cost" // derived from tokens × a model price table
  | "balance" // real account balance from a provider API (DeepSeek)
  | "unknown"; // source unavailable (e.g. subscription quota)

export type TimeWindow = "today" | "7d" | "30d";

export interface UsageRecord {
  // Stable identity for UI diffing / caching.
  // Rule: `${provider}:${model ?? ""}:${window}:${metricType}`
  // e.g. "claude-code:claude-sonnet-4-6:7d:measured_tokens", "deepseek::today:balance".
  id: string;

  provider: Provider;
  model: string | null; // null when not applicable (e.g. DeepSeek balance)
  metricType: MetricType;
  source: string; // e.g. "~/.claude/projects", "api.deepseek.com/user/balance"
  window: TimeWindow;

  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  requests: number;

  costUSD: number | null; // estimated for token-based providers; null if not computed
  balance: number | null; // real balance (DeepSeek); null otherwise
  currency: string | null; // e.g. "USD", "CNY" — for balance

  updatedAt: string; // ISO-8601 when this record was produced
  confidence: "high" | "medium" | "low";
  warnings: string[]; // e.g. ["no price table for model X", "subscription quota not available"]
}

// Top-level payload the host returns to the extension.
export interface UsageReport {
  generatedAt: string; // ISO-8601
  hostVersion: string;
  records: UsageRecord[];
  errors: { provider: Provider; message: string }[];
}
