// Parses Claude Code session logs (~/.claude/projects/**/*.jsonl) into normalized
// UsageRecords. Tokens are MEASURED from the logs; cost is an ESTIMATE.
//
// Dedup note: Claude Code streams an assistant message across multiple log lines
// that share the same (message.id, requestId). Counting every line double-counts
// tokens, so we keep one entry per key (the one with the most tokens). This mirrors
// how `ccusage` reconciles its totals.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UsageRecord, TimeWindow } from "../../shared/schema.ts";
import { estimateCostUSD } from "../pricing.ts";

const SYNTHETIC_MODEL = "<synthetic>";

interface Entry {
  key: string; // `${messageId}::${requestId}`
  model: string;
  ts: number; // epoch ms
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  total: number;
}

export interface ParseOptions {
  baseDir?: string; // default ~/.claude/projects
  now?: Date; // injectable for tests
  windows?: TimeWindow[];
}

async function findJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir → no data
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) out.push(...(await findJsonl(p)));
    else if (it.isFile() && it.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function extractEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue; // tolerate partial/corrupt lines
    }
    if (o?.type !== "assistant") continue;
    const msg = o.message ?? {};
    const u = msg.usage ?? {};
    const model: string = msg.model ?? "unknown";
    if (model === SYNTHETIC_MODEL) continue;
    const messageId = msg.id ?? o.uuid ?? "";
    const requestId = o.requestId ?? "";
    const ts = Date.parse(o.timestamp ?? "");
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

// Keep one entry per (message.id, requestId): the one with the most tokens.
function dedup(entries: Entry[]): Entry[] {
  const best = new Map<string, Entry>();
  for (const e of entries) {
    const prev = best.get(e.key);
    if (!prev || e.total > prev.total) best.set(e.key, e);
  }
  return [...best.values()];
}

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function windowCutoff(window: TimeWindow, now: Date): number {
  const ms = now.getTime();
  switch (window) {
    case "today":
      return startOfUTCDay(now);
    case "7d":
      return ms - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return ms - 30 * 24 * 60 * 60 * 1000;
  }
}

export async function parseClaudeUsage(opts: ParseOptions = {}): Promise<UsageRecord[]> {
  const baseDir = opts.baseDir ?? join(homedir(), ".claude", "projects");
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? (["today", "7d", "30d"] as TimeWindow[]);

  const files = await findJsonl(baseDir);
  const all: Entry[] = [];
  for (const f of files) {
    try {
      all.push(...extractEntries(await readFile(f, "utf8")));
    } catch {
      // skip unreadable file
    }
  }
  const entries = dedup(all);

  const records: UsageRecord[] = [];
  const updatedAt = now.toISOString();

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map<string, Entry[]>();
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
      const warnings: string[] = [];
      if (costUSD === null) {
        warnings.push(`no price table for model "${model}"; cost not estimated`);
      } else {
        warnings.push(
          "costUSD is a provisional estimate from a static price table and is not authoritative billing",
        );
      }
      records.push({
        id: `claude-code:${model}:${window}:measured_tokens`,
        provider: "claude-code",
        model,
        metricType: "measured_tokens",
        source: baseDir,
        window,
        inputTokens,
        outputTokens,
        cacheTokens: cacheCreationTokens + cacheReadTokens,
        requests: group.length,
        costUSD,
        balance: null,
        currency: costUSD === null ? null : "USD",
        updatedAt,
        confidence: costUSD === null ? "medium" : "high",
        warnings,
      });
    }
  }
  return records;
}
