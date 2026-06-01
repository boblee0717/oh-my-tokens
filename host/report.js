import { parseClaudeUsage } from "./parsers/claude.js";
import { parseCodexUsage } from "./parsers/codex.js";
import { parseDeepSeekUsage } from "./parsers/deepseek.js";
import { parseCursorUsage } from "./parsers/cursor.js";
import { estimateCostUSD } from "./pricing.js";

// Some parsers (e.g. Codex) emit token counts but not a cost. Fill in an estimated_cost
// for any measured_tokens record that lacks one and whose model has a price table entry,
// so the menu-bar total reflects all providers — not just Claude. Estimate only, flagged.
function fillEstimatedCosts(records) {
  const hasCost = new Set(
    records.filter((r) => r.metricType === "estimated_cost").map((r) => `${r.provider}:${r.model}:${r.window}`)
  );
  const extra = [];
  for (const r of records) {
    if (r.metricType !== "measured_tokens") continue;
    if (hasCost.has(`${r.provider}:${r.model}:${r.window}`)) continue;
    // Token totals carry a single cacheTokens; treat it as cached-read (the cheaper rate).
    const costUSD = estimateCostUSD(r.model, {
      inputTokens: r.inputTokens || 0,
      outputTokens: r.outputTokens || 0,
      cacheCreationTokens: 0,
      cacheReadTokens: r.cacheTokens || 0,
    });
    if (costUSD == null) continue;
    extra.push({
      id: `${r.provider}:${r.model}:${r.window}:estimated_cost`,
      provider: r.provider,
      model: r.model,
      metricType: "estimated_cost",
      source: r.source,
      window: r.window,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      requests: r.requests || 0,
      costUSD,
      balance: null,
      currency: "USD",
      updatedAt: r.updatedAt,
      confidence: "low",
      warnings: ["estimated from an assumed price table; not authoritative billing"],
    });
  }
  return extra;
}

export async function buildUsageReport(hostVersion, opts = {}) {
  const report = {
    generatedAt: new Date().toISOString(),
    hostVersion,
    records: [],
    errors: [],
  };
  try {
    report.records.push(...(await parseClaudeUsage()));
  } catch (e) {
    report.errors.push({ provider: "claude-code", message: String(e) });
  }
  try {
    report.records.push(...(await parseCodexUsage()));
  } catch (e) {
    report.errors.push({ provider: "codex", message: String(e) });
  }
  try {
    report.records.push(...(await parseCursorUsage()));
  } catch (e) {
    report.errors.push({ provider: "cursor", message: String(e) });
  }
  try {
    report.records.push(...(await parseDeepSeekUsage({ apiKey: opts.deepseekApiKey })));
  } catch (e) {
    report.errors.push({ provider: "deepseek", message: String(e) });
  }
  report.records.push(...fillEstimatedCosts(report.records));
  return report;
}
