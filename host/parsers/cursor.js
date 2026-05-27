import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const SQLITE3 = "/usr/bin/sqlite3";
const DEFAULT_DB = join(homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");

function sql(dbPath, query) {
  try {
    const out = execFileSync(SQLITE3, ["-json", dbPath, query], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function windowCutoff(window, now) {
  const ms = now.getTime();
  switch (window) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case "7d":
      return ms - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return ms - 30 * 24 * 60 * 60 * 1000;
  }
}

export async function parseCursorUsage(opts = {}) {
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? ["today", "7d", "30d"];
  const dbPath = opts.dbPath ?? DEFAULT_DB;

  const rows = sql(dbPath, "SELECT model, source, createdAt FROM ai_code_hashes");
  if (!rows || !rows.length) return [];

  const records = [];
  const updatedAt = now.toISOString();
  const source = "~/.cursor/ai-tracking/ai-code-tracking.db";

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map();
    for (const r of rows) {
      if (r.createdAt < cutoff) continue;
      const model = r.model || "unknown";
      const arr = byModel.get(model) ?? [];
      arr.push(r);
      byModel.set(model, arr);
    }
    for (const [model, group] of byModel) {
      const cli = group.filter((r) => r.source === "cli").length;
      const composer = group.filter((r) => r.source === "composer").length;
      records.push({
        id: `cursor:${model}:${window}:measured_tokens`,
        provider: "cursor",
        model,
        metricType: "request_count",
        source,
        window,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        requests: group.length,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: [
          "Cursor tracks request counts, not token counts; fields below show requests",
          `CLI: ${cli}  Composer: ${composer}`,
        ],
      });
    }
  }
  return records;
}
