import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { windowCutoff, tildePath } from "../util.js";

// Kimi Code CLI writes one `wire.jsonl` per agent per session:
//   ~/.kimi-code/sessions/<workspace>/session_<uuid>/agents/<agent>/wire.jsonl
// Each {"type":"usage.record"} line is a per-turn token delta (not cumulative):
//   {"model":"kimi-code/k3","usage":{"inputOther":N,"output":N,
//    "inputCacheRead":N,"inputCacheCreation":N},"usageScope":"turn","time":<ms>}
// so window totals are plain sums — no session-snapshot delta logic needed.

async function findWireFiles(dir) {
  const out = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) out.push(...(await findWireFiles(p)));
    else if (it.isFile() && it.name === "wire.jsonl") out.push(p);
  }
  return out;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseUsageEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (o?.type !== "usage.record") continue;
    // Only per-turn deltas are additive; a session-scoped aggregate would
    // double-count alongside the turn records, so skip non-turn scopes.
    if (o.usageScope != null && o.usageScope !== "turn") continue;
    const ts = num(o.time);
    const u = o.usage ?? {};
    const inputTokens = num(u.inputOther);
    const outputTokens = num(u.output);
    const cacheTokens = num(u.inputCacheRead) + num(u.inputCacheCreation);
    if (!ts || inputTokens + outputTokens + cacheTokens === 0) continue;
    events.push({
      ts,
      model: typeof o.model === "string" && o.model ? o.model : "unknown",
      inputTokens,
      outputTokens,
      cacheTokens,
    });
  }
  return events;
}

export async function parseKimiUsage(opts = {}) {
  const baseDir = opts.baseDir ?? join(homedir(), ".kimi-code");
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? ["today", "7d", "30d"];
  const source = tildePath(baseDir);

  const events = [];
  for (const f of await findWireFiles(join(baseDir, "sessions"))) {
    let text;
    try {
      text = await readFile(f, "utf8");
    } catch {
      continue;
    }
    events.push(...parseUsageEvents(text));
  }

  const records = [];
  const updatedAt = now.toISOString();
  const nowMs = now.getTime();
  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map();
    for (const e of events) {
      if (e.ts < cutoff || e.ts > nowMs) continue;
      const arr = byModel.get(e.model) ?? [];
      arr.push(e);
      byModel.set(e.model, arr);
    }
    for (const [model, group] of byModel) {
      records.push({
        id: `kimi:${model}:${window}:measured_tokens`,
        provider: "kimi",
        model,
        metricType: "measured_tokens",
        source,
        window,
        inputTokens: group.reduce((s, e) => s + e.inputTokens, 0),
        outputTokens: group.reduce((s, e) => s + e.outputTokens, 0),
        cacheTokens: group.reduce((s, e) => s + e.cacheTokens, 0),
        requests: group.length,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: [
          "cost not estimated for Kimi Code (no authoritative price source yet)",
          "`requests` counts LLM turns (main agent + subagents), not user prompts",
        ],
      });
    }
  }
  return records;
}
