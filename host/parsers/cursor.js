import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_DB = join(homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");

// Cursor stores its tracking data in SQLite; we shell out to the `sqlite3` CLI rather than
// bundle a native dependency (the host stays plain JS, no build step). The binary lives at
// different places per platform — and on Windows it usually isn't installed at all — so
// resolve it dynamically and degrade to no records when it's absent. The Cursor *web*
// connector is the primary source; this local parser is only a fallback (see AGENTS.md).
export function resolveSqlite3() {
  const isWin = process.platform === "win32";
  const known = isWin
    ? []
    : ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3", "/usr/local/bin/sqlite3"];
  for (const c of known) {
    if (existsSync(c)) return c;
  }
  try {
    const locator = isWin ? "where" : "which";
    const out = execFileSync(locator, [isWin ? "sqlite3.exe" : "sqlite3"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  } catch {
  }
  return null;
}

const SQLITE3 = resolveSqlite3();

function sql(dbPath, query) {
  if (!SQLITE3) return null;
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

  // One AI request produces many code-hash rows (one per file/snippet), so requests are
  // counted as DISTINCT requestId — counting rows over-counts by ~100x.
  const rows = sql(dbPath, "SELECT model, source, requestId, createdAt FROM ai_code_hashes");
  if (!rows || !rows.length) return [];

  const records = [];
  const updatedAt = now.toISOString();
  const source = "~/.cursor/ai-tracking/ai-code-tracking.db";

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map();
    for (const r of rows) {
      if (r.createdAt < cutoff || !r.requestId) continue;
      const model = r.model || "unknown";
      const acc = byModel.get(model) ?? { all: new Set(), cli: new Set(), composer: new Set() };
      acc.all.add(r.requestId);
      if (r.source === "cli") acc.cli.add(r.requestId);
      else if (r.source === "composer") acc.composer.add(r.requestId);
      byModel.set(model, acc);
    }
    for (const [model, acc] of byModel) {
      if (!acc.all.size) continue;
      records.push({
        id: `cursor:${model}:${window}:request_count`,
        provider: "cursor",
        model,
        metricType: "request_count",
        source,
        window,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        requests: acc.all.size,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: [
          "Cursor tracks request counts, not token counts; fields below show requests",
          `CLI: ${acc.cli.size}  Composer: ${acc.composer.size}`,
        ],
      });
    }
  }
  return records;
}
