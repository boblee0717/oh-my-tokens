// Parses Codex CLI session logs (~/.codex/sessions/**, ~/.codex/archived_sessions/**)
// into normalized UsageRecords. Tokens are MEASURED from the logs.
//
// Each rollout-*.jsonl file is one session. A session emits `event_msg`/`token_count`
// events whose `info.total_token_usage` is CUMULATIVE, so the final one is the session
// total — we take the entry with the largest total_tokens. Sessions are deduped by
// session id so a session present in both sessions/ and archived_sessions/ is counted once.
//
// Cost is intentionally NOT estimated for Codex: there is no authoritative price source
// for the gpt-5.x models yet (see M1 reconciliation). Tokens are the trustworthy output.
//
// Note: Codex `token_count` events also carry `rate_limits` (plan_type + used_percent for
// a 5h and a weekly window) — the closest thing to a real subscription-quota signal.
// Surfacing that is left to a later milestone; M2 covers token usage only.

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { UsageRecord, TimeWindow } from "../../shared/schema.ts";
import { windowCutoff, tildePath } from "../util.ts";

interface SessionUsage {
  sessionId: string;
  model: string;
  ts: number; // epoch ms of the final token_count event
  inputTokens: number; // non-cached input
  cacheTokens: number; // cached_input_tokens
  outputTokens: number; // output + reasoning
  totalTokens: number;
}

export interface ParseOptions {
  baseDir?: string; // default ~/.codex
  now?: Date;
  windows?: TimeWindow[];
}

async function findJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
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

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function sessionIdFromFilename(file: string): string {
  // rollout-<timestamp>-<uuid>.jsonl → take the uuid (last 5 hyphen groups)
  const name = basename(file).replace(/\.jsonl$/, "");
  const parts = name.split("-");
  return parts.length >= 5 ? parts.slice(-5).join("-") : name;
}

// Parse one session file into its total usage, or null if it carries no token data.
function parseSession(file: string, text: string): SessionUsage | null {
  let sessionId = sessionIdFromFilename(file);
  let model = "unknown";
  let best: { ts: number; usage: any } | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = o?.type;
    const payload = o?.payload ?? {};
    if (type === "session_meta" && payload.id) {
      sessionId = payload.id;
    } else if (type === "turn_context" && payload.model) {
      model = payload.model;
    } else if (type === "event_msg" && payload.type === "token_count" && payload.info) {
      const total = payload.info.total_token_usage;
      if (total) {
        const ts = Date.parse(o.timestamp ?? "");
        const totalTokens = num(total.total_tokens);
        if (!best || totalTokens >= num(best.usage.total_tokens)) {
          best = { ts: Number.isNaN(ts) ? (best?.ts ?? 0) : ts, usage: total };
        }
      }
    }
  }

  if (!best) return null;
  const u = best.usage;
  const cached = num(u.cached_input_tokens);
  const input = Math.max(0, num(u.input_tokens) - cached);
  const output = num(u.output_tokens) + num(u.reasoning_output_tokens);
  return {
    sessionId,
    model,
    ts: best.ts,
    inputTokens: input,
    cacheTokens: cached,
    outputTokens: output,
    totalTokens: num(u.total_tokens),
  };
}

export async function parseCodexUsage(opts: ParseOptions = {}): Promise<UsageRecord[]> {
  const baseDir = opts.baseDir ?? join(homedir(), ".codex");
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? (["today", "7d", "30d"] as TimeWindow[]);
  const source = tildePath(baseDir);

  const files = [
    ...(await findJsonl(join(baseDir, "sessions"))),
    ...(await findJsonl(join(baseDir, "archived_sessions"))),
  ];

  // Dedup by session id, keeping the copy with the most tokens.
  const bySession = new Map<string, SessionUsage>();
  for (const f of files) {
    let session: SessionUsage | null = null;
    try {
      session = parseSession(f, await readFile(f, "utf8"));
    } catch {
      continue;
    }
    if (!session) continue;
    const prev = bySession.get(session.sessionId);
    if (!prev || session.totalTokens > prev.totalTokens) bySession.set(session.sessionId, session);
  }
  const sessions = [...bySession.values()];

  const records: UsageRecord[] = [];
  const updatedAt = now.toISOString();

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map<string, SessionUsage[]>();
    for (const s of sessions) {
      if (s.ts < cutoff) continue;
      const arr = byModel.get(s.model) ?? [];
      arr.push(s);
      byModel.set(s.model, arr);
    }
    for (const [model, group] of byModel) {
      records.push({
        id: `codex:${model}:${window}:measured_tokens`,
        provider: "codex",
        model,
        metricType: "measured_tokens",
        source,
        window,
        inputTokens: group.reduce((s, e) => s + e.inputTokens, 0),
        outputTokens: group.reduce((s, e) => s + e.outputTokens, 0),
        cacheTokens: group.reduce((s, e) => s + e.cacheTokens, 0),
        requests: group.length, // Codex granularity is per-session, so this counts sessions
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: [
          "cost not estimated for Codex (no authoritative price source for gpt-5.x yet)",
          "`requests` counts sessions, not individual turns",
        ],
      });
    }
  }
  return records;
}
