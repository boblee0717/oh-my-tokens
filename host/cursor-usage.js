import { getCookies, cookieHeader } from "./chrome-cookies.js";

// Standalone Cursor token/cost: cursor.com's per-model usage lives on the dashboard, not in
// local logs. Reuse the saved cursor.com cookie to call the same events endpoint the
// extension uses, and map to measured_tokens + estimated_cost. Mapping mirrors
// extension/cursor-web.js `mapUsageEvents` (kept in sync — Chrome sandboxes the extension
// so it can't import host code). Cost is Cursor's own per-event cents (an estimate of value,
// not a bill). Page-capped + time-bounded so the menu bar never blocks for long.

const BASE = "https://cursor.com";
const DAY_MS = 86400000;
const EVENTS_PAGE_SIZE = 1000;
const EVENTS_MAX_PAGES = 5; // cap so a heavy account never paginates unbounded each refresh

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
  for (const k of keys) if (Array.isArray(obj?.[k])) return obj[k];
  return null;
}
const eventModel = (e) => firstString(e, ["model", "model_id", "modelId"]) || "unknown";
const eventTokenUsage = (e) => e?.tokenUsage || e?.token_usage || {};
function eventTimestampMs(e) {
  const t = e?.timestamp ?? e?.timestampMs ?? e?.timestamp_ms ?? e?.createdAt;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function mapUsageEvents(json, now = new Date(), partial = false) {
  const events = firstArray(json, ["usageEventsDisplay", "usage_events_display", "events"]);
  if (!events) return [];
  const cutoff = {
    today: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(),
    "7d": now.getTime() - 7 * DAY_MS,
    "30d": now.getTime() - 30 * DAY_MS,
  };
  const updatedAt = now.toISOString();
  const baseWarn = partial
    ? ["Cursor usage from cursor.com dashboard (fetched standalone)", "partial: only recent events fetched"]
    : ["Cursor usage from cursor.com dashboard (fetched standalone)"];
  const records = [];
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
          confidence: "low",
          warnings: [...baseWarn, "cost is Cursor's reported per-event value, not authoritative billing"],
        });
      }
    }
  }
  return records;
}

export async function fetchCursorUsageRecords(now = new Date()) {
  const cookies = getCookies("%cursor.com%");
  if (!cookies.WorkosCursorSessionToken) return { status: "needs_login", records: [] };
  const cookie = cookieHeader(cookies);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const endDate = now.getTime();
    const startDate = endDate - 30 * DAY_MS;
    let all = [];
    let total = null;
    for (let page = 1; page <= EVENTS_MAX_PAGES; page++) {
      const res = await fetch(`${BASE}/api/dashboard/get-filtered-usage-events`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "Content-Type": "application/json",
          // cursor.com rejects state-changing POSTs without a same-origin Origin header.
          Origin: BASE,
          Referer: `${BASE}/dashboard`,
        },
        body: JSON.stringify({ startDate: String(startDate), endDate: String(endDate), page, pageSize: EVENTS_PAGE_SIZE }),
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) return { status: "needs_login", records: [] };
      if (!res.ok) return { status: "error", records: [] };
      const json = await res.json();
      const events = firstArray(json, ["usageEventsDisplay", "usage_events_display", "events"]) || [];
      total = firstNumber(json, ["totalUsageEventsCount", "total_usage_events_count"]);
      all = all.concat(events);
      if (events.length < EVENTS_PAGE_SIZE) break;
    }
    const partial = total != null && all.length < total;
    return { status: "ok", records: mapUsageEvents({ usageEventsDisplay: all }, now, partial) };
  } catch {
    return { status: "error", records: [] };
  } finally {
    clearTimeout(timer);
  }
}
