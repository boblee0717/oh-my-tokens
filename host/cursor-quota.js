import { getCookies, cookieHeader } from "./chrome-cookies.js";

// Standalone Cursor plan-usage fetch: reuse the user's cursor.com login cookie (read from
// the browser) to call the same dashboard endpoint the extension uses — no browser needed.
// The mapping below mirrors extension/cursor-web.js `mapUsageSummary` (kept in sync; the
// extension can't import host code because Chrome sandboxes it to the extension dir).

const URL = "https://cursor.com/api/usage-summary";

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
    usedPercent: Math.round(Math.max(0, Math.min(100, Number(usedPercent) || 0)) * 10) / 10,
    windowLabel: label,
    resetsAt: resetsAt || undefined,
    planType: planType || "Cursor",
    updatedAt: new Date().toISOString(),
    confidence: "high",
    warnings: ["Cursor account-level plan usage from the dashboard (fetched standalone)"],
  };
}

export function mapUsageSummary(json) {
  if (!json || typeof json !== "object") return [];
  if (json.error) return [];
  const nests = [json, json.individualUsage, json.usage, json.plan, json.individualUsage?.plan].filter(
    (x) => x && typeof x === "object"
  );
  const pick = (keys) => {
    for (const n of nests) {
      const v = firstNumber(n, keys);
      if (v != null) return v;
    }
    return null;
  };
  const plan =
    firstString(json, ["membershipType", "plan", "planType", "tier"]) ||
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

// Returns { status: "ok"|"needs_login"|"error", records }.
export async function fetchCursorQuota() {
  const cookies = getCookies("%cursor.com%");
  if (!cookies.WorkosCursorSessionToken) return { status: "needs_login", records: [] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(URL, {
      headers: { Cookie: cookieHeader(cookies), Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "needs_login", records: [] };
    if (!res.ok) return { status: "error", records: [] };
    return { status: "ok", records: mapUsageSummary(await res.json()) };
  } catch {
    return { status: "error", records: [] };
  } finally {
    clearTimeout(timer);
  }
}
