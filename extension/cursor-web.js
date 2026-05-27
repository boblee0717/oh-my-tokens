// Cursor web connector. Cursor's account usage % lives at cursor.com (the dashboard),
// not in local logs — the local host parser (host/parsers/cursor.js) only sees per-model
// request counts. We fetch the plan usage from the extension using the user's existing
// cursor.com session (host_permissions: https://cursor.com/*; fetch with credentials:"include").
// We never read or store the WorkOS session cookie — the browser attaches it automatically.
//
// Endpoint: GET https://cursor.com/api/usage-summary
//   Unauthenticated → HTTP 401 + { error: "not_authenticated", ... } (verified 2026-05-27).
//   Authenticated shape is reverse-engineered (membershipType, plan used/limit/remaining,
//   apiPercentUsed/totalPercentUsed, billing cycle), so field extraction is intentionally
//   tolerant of several key spellings and degrades to [] rather than guessing.
//
// Returns { status, records, loginUrl } — same contract as fetchClaudeQuota:
//   "ok" | "needs_login" | "error".

const BASE = "https://cursor.com";
export const CURSOR_LOGIN_URL = "https://cursor.com/dashboard";

function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
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

// usage-summary JSON → quota_percent records (exported for unit testing).
// Tolerant of field-name variants since the authenticated shape is reverse-engineered.
export function mapUsageSummary(json) {
  if (!json || typeof json !== "object") return [];
  if (json.error) return []; // e.g. { error: "not_authenticated" }

  const plan = firstString(json, ["membershipType", "plan", "planType", "tier"]);
  const cycleEnd = firstString(json, ["billingCycleEnd", "cycleEnd", "periodEnd", "resetsAt", "endDate"]);

  const out = [];

  // Primary signal: an explicit percent. Prefer total, then api-specific.
  const totalPct = firstNumber(json, ["totalPercentUsed", "percentUsed", "usagePercent"]);
  const apiPct = firstNumber(json, ["apiPercentUsed"]);

  if (totalPct != null) {
    out.push(quotaRecord({ label: "Plan usage", usedPercent: totalPct, resetsAt: cycleEnd, planType: plan }));
  }
  if (apiPct != null && apiPct !== totalPct) {
    out.push(quotaRecord({ label: "API usage", usedPercent: apiPct, resetsAt: cycleEnd, planType: plan }));
  }

  // Fallback: derive a percent from used / limit when no explicit percent is present.
  if (!out.length) {
    const used = firstNumber(json, ["used", "usedRequests", "numRequests", "requestsUsed"]);
    const limit = firstNumber(json, ["limit", "maxRequests", "requestLimit", "hardLimit"]);
    if (used != null && limit && limit > 0) {
      out.push(
        quotaRecord({ label: "Plan usage", usedPercent: (used / limit) * 100, resetsAt: cycleEnd, planType: plan }),
      );
    }
  }

  return out;
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

// Returns { status, records, loginUrl } for Cursor.
// `fetchImpl` is injectable so the auth/login-state branches are unit-testable.
export async function fetchCursorUsage(fetchImpl = typeof fetch === "function" ? fetch : null) {
  if (!fetchImpl) return { status: "error", records: [] };
  try {
    const summary = await getJson("/api/usage-summary", fetchImpl);
    if (summary?.error === "not_authenticated") {
      return { status: "needs_login", records: [], loginUrl: CURSOR_LOGIN_URL };
    }
    return { status: "ok", records: mapUsageSummary(summary) };
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      return { status: "needs_login", records: [], loginUrl: CURSOR_LOGIN_URL };
    }
    return { status: "error", records: [] };
  }
}
