import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { estimateCostUSD } from "../pricing.js";
import { windowCutoff, tildePath } from "../util.js";

const SYNTHETIC_MODEL = "<synthetic>";

async function findJsonl(dir) {
  const out = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) out.push(...(await findJsonl(p)));
    else if (it.isFile() && it.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function extractEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (o?.type !== "assistant") continue;
    const msg = o.message ?? {};
    const u = msg.usage ?? {};
    const model = msg.model ?? "unknown";
    if (model === SYNTHETIC_MODEL) continue;
    const messageId = msg.id ?? o.uuid ?? "";
    const requestId = o.requestId ?? "";
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts)) continue;
    const inputTokens = num(u.input_tokens);
    const outputTokens = num(u.output_tokens);
    const cacheCreationTokens = num(u.cache_creation_input_tokens);
    const cacheReadTokens = num(u.cache_read_input_tokens);
    const total = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
    if (total === 0) continue;
    entries.push({
      key: `${messageId}::${requestId}`,
      model,
      ts,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      total,
    });
  }
  return entries;
}

function dedup(entries) {
  const best = new Map();
  for (const e of entries) {
    const prev = best.get(e.key);
    if (!prev || e.total > prev.total) best.set(e.key, e);
  }
  return [...best.values()];
}

export async function parseClaudeUsage(opts = {}) {
  const baseDir = opts.baseDir ?? join(homedir(), ".claude", "projects");
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? ["today", "7d", "30d"];
  const source = tildePath(baseDir);

  const files = await findJsonl(baseDir);
  const all = [];
  for (const f of files) {
    try {
      all.push(...extractEntries(await readFile(f, "utf8")));
    } catch {
    }
  }
  const entries = dedup(all);

  const records = [];
  const updatedAt = now.toISOString();

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map();
    for (const e of entries) {
      if (e.ts < cutoff) continue;
      const arr = byModel.get(e.model) ?? [];
      arr.push(e);
      byModel.set(e.model, arr);
    }
    for (const [model, group] of byModel) {
      const inputTokens = group.reduce((s, e) => s + e.inputTokens, 0);
      const outputTokens = group.reduce((s, e) => s + e.outputTokens, 0);
      const cacheCreationTokens = group.reduce((s, e) => s + e.cacheCreationTokens, 0);
      const cacheReadTokens = group.reduce((s, e) => s + e.cacheReadTokens, 0);
      const costUSD = estimateCostUSD(model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
      });

      const tokenWarnings = [];
      if (costUSD === null) {
        tokenWarnings.push(`no price table for model "${model}"; cost not estimated`);
      }
      records.push({
        id: `claude-code:${model}:${window}:measured_tokens`,
        provider: "claude-code",
        model,
        metricType: "measured_tokens",
        source,
        window,
        inputTokens,
        outputTokens,
        cacheTokens: cacheCreationTokens + cacheReadTokens,
        requests: group.length,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: tokenWarnings,
      });

      if (costUSD !== null) {
        records.push({
          id: `claude-code:${model}:${window}:estimated_cost`,
          provider: "claude-code",
          model,
          metricType: "estimated_cost",
          source,
          window,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          requests: group.length,
          costUSD,
          balance: null,
          currency: "USD",
          updatedAt,
          confidence: "low",
          warnings: [
            "estimated from a static price table; not authoritative billing; reconcile via LiteLLM/ccusage",
          ],
        });
      }
    }
  }
  return records;
}
