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
// Codex `token_count` events also carry `rate_limits` (plan_type + used_percent for a 5h
// "primary" window and a weekly "secondary" window) — a real subscription-quota signal.
// We surface the most recent rate_limits as `quota_percent` records (M7).

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
  rateLimits: any | null; // latest rate_limits object seen in the session
  rateLimitsTs: number; // epoch ms of that rate_limits event
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
  let rateLimits: any | null = null;
  let rateLimitsTs = 0;

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
    } else if (type === "event_msg" && payload.type === "token_count") {
      const ts = Date.parse(o.timestamp ?? "");
      const tsMs = Number.isNaN(ts) ? 0 : ts;
      const total = payload.info?.total_token_usage;
      if (total && (!best || num(total.total_tokens) >= num(best.usage.total_tokens))) {
        best = { ts: tsMs, usage: total };
      }
      if (payload.rate_limits && tsMs >= rateLimitsTs) {
        rateLimits = payload.rate_limits;
        rateLimitsTs = tsMs;
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
    rateLimits,
    rateLimitsTs,
  };
}

// window_minutes → human label (300 → "5h", 10080 → "Weekly").
function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// Build a quota_percent record from one rate-limit window, or null if absent.
function quotaRecord(
  source: string,
  win: any,
  planType: string | null,
  updatedAt: string,
): UsageRecord | null {
  if (!win || typeof win.used_percent !== "number") return null;
  const label = windowLabel(num(win.window_minutes));
  const resetsAt = win.resets_at ? new Date(num(win.resets_at) * 1000).toISOString() : undefined;
  return {
    id: `codex::quota:${label.toLowerCase()}:quota_percent`,
    provider: "codex",
    model: null,
    metricType: "quota_percent",
    source,
    window: "today",
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    requests: 0,
    costUSD: null,
    balance: null,
    currency: null,
    usedPercent: win.used_percent,
    windowLabel: label,
    resetsAt,
    planType: planType ?? undefined,
    updatedAt,
    confidence: "high",
    warnings: [],
  };
}

// Build a balance record from the `credits` block (used by credits-based plans where
// primary/secondary windows are null). Without this, such accounts show no Codex quota.
function creditsRecord(
  source: string,
  credits: any,
  planType: string | null,
  updatedAt: string,
): UsageRecord | null {
  if (!credits || typeof credits !== "object") return null;
  const unlimited = credits.unlimited === true;
  const bal = Number(credits.balance);
  if (!unlimited && !Number.isFinite(bal)) return null;
  return {
    id: `codex::credits:balance`,
    provider: "codex",
    model: null,
    metricType: "balance",
    source,
    window: "today",
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    requests: 0,
    costUSD: null,
    balance: unlimited ? null : bal,
    currency: "credits",
    planType: planType ?? undefined,
    updatedAt,
    confidence: "high",
    warnings: unlimited ? ["unlimited credits"] : [],
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

  // Quota: surface the single most recent rate_limits across all sessions.
  let latestRL: SessionUsage | null = null;
  for (const s of sessions) {
    if (s.rateLimits && (!latestRL || s.rateLimitsTs > latestRL.rateLimitsTs)) latestRL = s;
  }
  if (latestRL?.rateLimits) {
    const rl = latestRL.rateLimits;
    const plan = typeof rl.plan_type === "string" ? rl.plan_type : null;
    for (const win of [rl.primary, rl.secondary]) {
      const rec = quotaRecord(source, win, plan, updatedAt);
      if (rec) records.push(rec);
    }
    // Credits-based plans have null primary/secondary; surface the credits balance so
    // Codex still appears (e.g. balance 0) instead of vanishing from the Quota section.
    const creditsRec = creditsRecord(source, rl.credits, plan, updatedAt);
    if (creditsRec) records.push(creditsRec);
  }

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
