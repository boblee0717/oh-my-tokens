// Cursor web connector — Cursor's usage lives on the cursor.com dashboard, not in local
// logs. We fetch it from the extension using the user's existing cursor.com session
// (host_permissions: https://cursor.com/*; fetch with credentials:"include"). We never read
// or store the WorkOS session cookie — the browser attaches it automatically.
//
// Two endpoints (authenticated shapes are reverse-engineered + cross-checked against the
// Cursor app's proto names, NOT a captured live response — so all field extraction is
// tolerant of camelCase/snake_case variants and degrades to [] rather than guessing):
//   GET  /api/usage-summary                     → plan usage % (quota_percent)
//   POST /api/dashboard/get-filtered-usage-events → per-model token/cost (measured_tokens + estimated_cost)
//
// Unauthenticated → HTTP 401 + { error: "not_authenticated" } (verified live 2026-05-27).
// Returns { status, records, loginUrl }: "ok" | "needs_login" | "error".

const BASE = "https://cursor.com";
export const CURSOR_LOGIN_URL = "https://cursor.com/dashboard";

const DAY_MS = 86400000;
const EVENTS_PAGE_SIZE = 1000;
const EVENTS_MAX_PAGES = 10; // hard cap so the popup never paginates unbounded

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

function firstArray(obj, keys) {
  for (const k of keys) {
    if (Array.isArray(obj?.[k])) return obj[k];
  }
  return null;
}

function quotaRecord({ label, usedPercent, resetsAt, planType }) {
  return {
    id: `cursor::quota:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:quota_percent`,
    provider: "cursor",
    model: null,
    metricType: "quota_percent",
    source: "cursor.com/api/usage-summary",
    window: "today",
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    requests: 0,
    costUSD: null,
    balance: null,
    currency: null,
    usedPercent: Math.max(0, Math.min(100, Number(usedPercent) || 0)),
    windowLabel: label,
    resetsAt: resetsAt || undefined,
    planType: planType || "Cursor",
    updatedAt: new Date().toISOString(),
    confidence: "high",
    warnings: ["Cursor account-level plan usage from the dashboard"],
  };
}

// usage-summary JSON → quota_percent records. Tolerant of nested/flat + camel/snake variants.
export function mapUsageSummary(json) {
  if (!json || typeof json !== "object") return [];
  if (json.error) return []; // e.g. { error: "not_authenticated" }

  // The percent fields may sit at the top level or under individualUsage / plan / usage.
  const nests = [json, json.individualUsage, json.usage, json.plan, json.individualUsage?.plan].filter(
    (x) => x && typeof x === "object",
  );
  const pick = (keys) => {
    for (const n of nests) {
      const v = firstNumber(n, keys);
      if (v != null) return v;
    }
    return null;
  };

  const plan = firstString(json, ["membershipType", "plan", "planType", "tier"]) ||
    firstString(json.individualUsage || {}, ["membershipType", "planType"]);
  const cycleEnd = firstString(json, [
    "billingCycleEnd", "cycleEnd", "periodEnd", "resetsAt", "endDate", "periodEndMs", "period_end_ms",
  ]);

  const out = [];
  const totalPct = pick(["totalPercentUsed", "percentUsed", "usagePercent", "totalCostPercent", "total_cost_percent"]);
  const apiPct = pick(["apiPercentUsed", "api_percent_used"]);

  if (totalPct != null) out.push(quotaRecord({ label: "Plan usage", usedPercent: totalPct, resetsAt: cycleEnd, planType: plan }));
  if (apiPct != null && apiPct !== totalPct) out.push(quotaRecord({ label: "API usage", usedPercent: apiPct, resetsAt: cycleEnd, planType: plan }));

  if (!out.length) {
    const used = pick(["used", "usedRequests", "numRequests", "requestsUsed", "usedTokens"]);
    const limit = pick(["limit", "maxRequests", "requestLimit", "hardLimit", "tokenLimit"]);
    if (used != null && limit && limit > 0) {
      out.push(quotaRecord({ label: "Plan usage", usedPercent: (used / limit) * 100, resetsAt: cycleEnd, planType: plan }));
    }
  }
  return out;
}

function eventModel(e) {
  return firstString(e, ["model", "model_id", "modelId"]) || "unknown";
}
function eventTokenUsage(e) {
  return e?.tokenUsage || e?.token_usage || {};
}
function eventTimestampMs(e) {
  const t = e?.timestamp ?? e?.timestampMs ?? e?.timestamp_ms ?? e?.createdAt;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// usage-events JSON → measured_tokens + estimated_cost per (model, window). Exported for tests.
// `partial` (more events exist than were fetched) adds a warning so totals aren't read as exact.
export function mapUsageEvents(json, now = new Date(), partial = false) {
  const events = firstArray(json, ["usageEventsDisplay", "usage_events_display", "events"]);
  if (!events) return [];

  const cutoff = {
    today: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    "7d": now.getTime() - 7 * DAY_MS,
    "30d": now.getTime() - 30 * DAY_MS,
  };
  const updatedAt = now.toISOString();
  const records = [];
  const baseWarn = partial
    ? ["Cursor usage from cursor.com dashboard API", "partial: only the most recent events were fetched"]
    : ["Cursor usage from cursor.com dashboard API"];

  for (const window of ["today", "7d", "30d"]) {
    const min = cutoff[window];
    const byModel = new Map();
    for (const e of events) {
      const ts = eventTimestampMs(e);
      if (ts == null || ts < min) continue;
      const model = eventModel(e);
      const tu = eventTokenUsage(e);
      const acc = byModel.get(model) ?? { input: 0, output: 0, cache: 0, cents: 0, reqs: 0 };
      acc.input += firstNumber(tu, ["inputTokens", "input_tokens"]) || 0;
      acc.output += firstNumber(tu, ["outputTokens", "output_tokens"]) || 0;
      acc.cache +=
        (firstNumber(tu, ["cacheWriteTokens", "cache_write_tokens"]) || 0) +
        (firstNumber(tu, ["cacheReadTokens", "cache_read_tokens"]) || 0);
      acc.cents += firstNumber(tu, ["totalCents", "total_cents"]) || firstNumber(e, ["chargedCents", "charged_cents"]) || 0;
      acc.reqs += 1;
      byModel.set(model, acc);
    }
    for (const [model, a] of byModel) {
      if (!a.input && !a.output && !a.cache && !a.reqs) continue;
      records.push({
        id: `cursor:${model}:${window}:measured_tokens`,
        provider: "cursor",
        model,
        metricType: "measured_tokens",
        source: "cursor.com/api/dashboard/get-filtered-usage-events",
        window,
        inputTokens: a.input,
        outputTokens: a.output,
        cacheTokens: a.cache,
        requests: a.reqs,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: baseWarn,
      });
      if (a.cents > 0) {
        records.push({
          id: `cursor:${model}:${window}:estimated_cost`,
          provider: "cursor",
          model,
          metricType: "estimated_cost",
          source: "cursor.com/api/dashboard/get-filtered-usage-events",
          window,
          inputTokens: 0,
          outputTokens: 0,
          cacheTokens: 0,
          requests: 0,
          costUSD: a.cents / 100,
          balance: null,
          currency: "USD",
          updatedAt,
          confidence: "high",
          warnings: baseWarn,
        });
      }
    }
  }
  return records;
}

async function getJson(path, fetchImpl) {
  const res = await fetchImpl(`${BASE}${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function postJson(path, body, fetchImpl) {
  const res = await fetchImpl(`${BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Fetch usage events for the last 30d, bounded pagination. Returns { records } or throws.
async function fetchEventRecords(fetchImpl, now) {
  const endDate = now.getTime();
  const startDate = endDate - 30 * DAY_MS;
  let all = [];
  let total = null;
  for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
    const json = await postJson(
      "/api/dashboard/get-filtered-usage-events",
      { startDate: String(startDate), endDate: String(endDate), page, pageSize: EVENTS_PAGE_SIZE },
      fetchImpl,
    );
    const events = firstArray(json, ["usageEventsDisplay", "usage_events_display", "events"]) || [];
    total = firstNumber(json, ["totalUsageEventsCount", "total_usage_events_count"]);
    all = all.concat(events);
    if (events.length < EVENTS_PAGE_SIZE) break; // last page
  }
  const partial = total != null && all.length < total;
  return mapUsageEvents({ usageEventsDisplay: all }, now, partial);
}

// Returns { status, records, loginUrl } for Cursor. Combines quota (usage-summary) and
// per-model tokens (usage events). `fetchImpl` injectable for unit testing.
export async function fetchCursorUsage(fetchImpl = typeof fetch === "function" ? fetch : null, now = new Date()) {
  if (!fetchImpl) return { status: "error", records: [] };
  let summary;
  try {
    summary = await getJson("/api/usage-summary", fetchImpl);
    if (summary?.error === "not_authenticated") {
      return { status: "needs_login", records: [], loginUrl: CURSOR_LOGIN_URL };
    }
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      return { status: "needs_login", records: [], loginUrl: CURSOR_LOGIN_URL };
    }
    return { status: "error", records: [] };
  }

  const records = mapUsageSummary(summary);
  // Per-model tokens are a best-effort add-on; never let them fail the (working) quota result.
  try {
    records.push(...(await fetchEventRecords(fetchImpl, now)));
  } catch {}
  return { status: "ok", records };
}
