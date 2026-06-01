import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { windowCutoff, tildePath } from "../util.js";

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

function sessionIdFromFilename(file) {
  const name = basename(file).replace(/\.jsonl$/, "");
  const parts = name.split("-");
  return parts.length >= 5 ? parts.slice(-5).join("-") : name;
}

function parseSession(file, text) {
  let sessionId = sessionIdFromFilename(file);
  let model = "unknown";
  let best = null;
  let rateLimits = null;
  let rateLimitsTs = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o;
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

function windowLabel(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function quotaRecord(source, win, planType, updatedAt) {
  if (!win || typeof win.used_percent !== "number") return null;
  // New Codex limit families (e.g. codex_bengalfox) report used_percent=0 with no plan_type:
  // that is absent quota data, NOT a real "0% used". Drop it so the popup shows
  // "quota data unavailable" instead of a misleading 0% bar. The Codex client UI gets the
  // real % from its own live source, which the session jsonl does not expose.
  if (win.used_percent === 0 && planType == null) return null;
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

function creditsRecord(source, credits, planType, updatedAt) {
  if (!credits || typeof credits !== "object") return null;
  const unlimited = credits.unlimited === true;
  // balance == null/undefined means "no credits info", not 0. Number(null) === 0 would slip
  // through the finite check below and render a misleading "0 credits", so reject it explicitly.
  if (!unlimited && credits.balance == null) return null;
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

export async function parseCodexUsage(opts = {}) {
  const baseDir = opts.baseDir ?? join(homedir(), ".codex");
  const now = opts.now ?? new Date();
  const windows = opts.windows ?? ["today", "7d", "30d"];
  const source = tildePath(baseDir);

  const files = [
    ...(await findJsonl(join(baseDir, "sessions"))),
    ...(await findJsonl(join(baseDir, "archived_sessions"))),
  ];

  const bySession = new Map();
  for (const f of files) {
    let session = null;
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

  const records = [];
  const updatedAt = now.toISOString();

  let latestRL = null;
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
    const creditsRec = creditsRecord(source, rl.credits, plan, updatedAt);
    if (creditsRec) records.push(creditsRec);
  }

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const byModel = new Map();
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
        requests: group.length,
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
