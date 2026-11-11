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
  let hasSessionMeta = false;
  let inheritedThroughOrdinal = null;
  let model = "unknown";
  const events = [];
  let rateLimits = null;
  let rateLimitsTs = 0;
  const rateLimitCandidates = [];

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
    if (type === "session_meta") {
      // Forked rollouts can contain a copy of the parent's metadata after their own.
      if (!hasSessionMeta) {
        sessionId = payload.id ?? sessionId;
        inheritedThroughOrdinal = payload.subagent_history_start_ordinal ?? null;
        hasSessionMeta = true;
      }
      continue;
    }
    const inherited = typeof inheritedThroughOrdinal === "number" &&
      typeof o.ordinal === "number" && o.ordinal <= inheritedThroughOrdinal;
    if (type === "turn_context" && payload.model) {
      model = payload.model;
    } else if (type === "event_msg" && payload.type === "token_count") {
      const ts = Date.parse(o.timestamp ?? "");
      const tsMs = Number.isNaN(ts) ? 0 : ts;
      const total = payload.info?.total_token_usage;
      if (total) {
        const cached = num(total.cached_input_tokens);
        events.push({
          ts: tsMs,
          model,
          inherited,
          inputTokens: Math.max(0, num(total.input_tokens) - cached),
          cacheTokens: cached,
          outputTokens: num(total.output_tokens) + num(total.reasoning_output_tokens),
          totalTokens: num(total.total_tokens),
        });
      }
      if (inherited) continue;
      if (payload.rate_limits && tsMs >= rateLimitsTs) {
        rateLimits = payload.rate_limits;
        rateLimitsTs = tsMs;
      }
      if (payload.rate_limits) {
        rateLimitCandidates.push({ rateLimits: payload.rate_limits, rateLimitsTs: tsMs });
      }
    }
  }

  if (!events.length) return null;
  events.sort((a, b) => a.ts - b.ts || a.totalTokens - b.totalTokens);
  return {
    sessionId,
    events,
    rateLimits,
    rateLimitsTs,
    rateLimitCandidates,
  };
}

function mergeEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    byKey.set(
      `${event.ts}:${event.totalTokens}:${event.inputTokens}:${event.cacheTokens}:${event.outputTokens}`,
      event,
    );
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts || a.totalTokens - b.totalTokens);
}

function mergeSession(a, b) {
  const events = mergeEvents([...a.events, ...b.events]);
  const latestRateLimits = b.rateLimitsTs >= a.rateLimitsTs ? b : a;
  return {
    sessionId: a.sessionId,
    events,
    rateLimits: latestRateLimits.rateLimits,
    rateLimitsTs: latestRateLimits.rateLimitsTs,
    rateLimitCandidates: [...a.rateLimitCandidates, ...b.rateLimitCandidates],
  };
}

function sessionDeltasForWindow(session, cutoff, nowMs) {
  let before = null;
  const byModel = new Map();
  for (const event of session.events) {
    if (event.ts > nowMs) continue;
    // A child may continue the inherited counter or start its own at zero.
    if (before?.inherited && !event.inherited && event.totalTokens < before.totalTokens) {
      before = null;
    }
    if (before && !event.inherited && event.totalTokens < before.totalTokens) continue;
    if (!event.inherited && event.ts >= cutoff) {
      const inputTokens = Math.max(0, event.inputTokens - (before?.inputTokens ?? 0));
      const cacheTokens = Math.max(0, event.cacheTokens - (before?.cacheTokens ?? 0));
      const outputTokens = Math.max(0, event.outputTokens - (before?.outputTokens ?? 0));
      if (inputTokens + cacheTokens + outputTokens > 0) {
        const delta = byModel.get(event.model) ?? { inputTokens: 0, cacheTokens: 0, outputTokens: 0 };
        delta.inputTokens += inputTokens;
        delta.cacheTokens += cacheTokens;
        delta.outputTokens += outputTokens;
        byModel.set(event.model, delta);
      }
    }
    before = event;
  }
  return byModel;
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

function latestRateLimitCandidate(sessions, accepts) {
  let latest = null;
  for (const session of sessions) {
    for (const candidate of session.rateLimitCandidates) {
      if (!accepts(candidate.rateLimits)) continue;
      if (!latest || candidate.rateLimitsTs >= latest.rateLimitsTs) latest = candidate;
    }
  }
  return latest;
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
    bySession.set(session.sessionId, prev ? mergeSession(prev, session) : session);
  }
  const sessions = [...bySession.values()];

  const records = [];
  const updatedAt = now.toISOString();

  let latestRL = null;
  for (const s of sessions) {
    if (s.rateLimits && (!latestRL || s.rateLimitsTs > latestRL.rateLimitsTs)) latestRL = s;
  }
  const quotaRL =
    latestRateLimitCandidate(sessions, (rl) => rl.limit_id === "codex") ??
    latestRateLimitCandidate(sessions, (rl) => rl.limit_id == null || rl.limit_id === "");
  if (quotaRL) {
    const rl = quotaRL.rateLimits;
    const plan = typeof rl.plan_type === "string" ? rl.plan_type : null;
    const rateLimitsUpdatedAt = quotaRL.rateLimitsTs
      ? new Date(quotaRL.rateLimitsTs).toISOString()
      : updatedAt;
    for (const win of [rl.primary, rl.secondary]) {
      const rec = quotaRecord(source, win, plan, rateLimitsUpdatedAt);
      if (rec) records.push(rec);
    }
  }
  if (latestRL?.rateLimits) {
    const rl = latestRL.rateLimits;
    const plan = typeof rl.plan_type === "string" ? rl.plan_type : null;
    const rateLimitsUpdatedAt = latestRL.rateLimitsTs
      ? new Date(latestRL.rateLimitsTs).toISOString()
      : updatedAt;
    const creditsRec = creditsRecord(source, rl.credits, plan, rateLimitsUpdatedAt);
    if (creditsRec) records.push(creditsRec);
  }

  for (const window of windows) {
    const cutoff = windowCutoff(window, now);
    const nowMs = now.getTime();
    const byModel = new Map();
    for (const s of sessions) {
      for (const [model, delta] of sessionDeltasForWindow(s, cutoff, nowMs)) {
        const arr = byModel.get(model) ?? [];
        arr.push(delta);
        byModel.set(model, arr);
      }
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
          "`requests` counts sessions per model, not individual turns; a session using multiple models is counted once for each model",
        ],
      });
    }
  }
  return records;
}
