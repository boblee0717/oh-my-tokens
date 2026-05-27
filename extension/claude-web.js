// Claude web connector. Claude's usage % lives at claude.ai/settings/usage, not in the
// local CLI logs, so we fetch it from the extension using the user's existing claude.ai
// session (host_permissions: https://claude.ai/*; fetch with credentials:"include").
// We never read or store cookies — the browser attaches the session automatically.
//
// Produces quota_percent UsageRecords (same shape the host emits for Codex) so the popup
// renders Claude alongside Codex in the Quota section. Any failure (not logged in, endpoint
// changed, shape changed) yields [] — Claude then just shows tokens from the host.
//
// NOTE: this is the Claude *account* plan usage (current session + weekly limits), not
// Claude Code CLI usage specifically.
//
// Endpoints (captured 2026-05-26):
//   GET /api/account                          → memberships[].organization.uuid
//   GET /api/organizations/{uuid}/usage       → { five_hour, seven_day, seven_day_sonnet, ... }
// Each window: { utilization: <0-100 percent>, resets_at: <ISO|null> }.

const BASE = "https://claude.ai";

// Which usage keys to surface, in display order, with their labels.
const WINDOW_LABELS = [
  ["five_hour", "5h"],
  ["seven_day", "Weekly"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
  ["seven_day_opus", "Weekly · Opus"],
];

function quotaRecord(label, usedPercent, resetsAt) {
  return {
    id: `claude-code::quota:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:quota_percent`,
    provider: "claude-code",
    model: null,
    metricType: "quota_percent",
    source: "claude.ai/api/organizations/{org}/usage",
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
    planType: "Claude",
    updatedAt: new Date().toISOString(),
    confidence: "high",
    warnings: ["Claude account-level plan usage (not Claude Code CLI specifically)"],
  };
}

// usage JSON → quota records (exported for unit testing).
export function mapUsage(json) {
  if (!json || typeof json !== "object") return [];
  const out = [];
  for (const [key, label] of WINDOW_LABELS) {
    const win = json[key];
    if (win && typeof win.utilization === "number") {
      out.push(quotaRecord(label, win.utilization, win.resets_at));
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

function firstOrgUuid(account) {
  const m = account?.memberships;
  if (Array.isArray(m)) {
    for (const x of m) {
      const uuid = x?.organization?.uuid;
      if (uuid) return uuid;
    }
  }
  return account?.organization?.uuid ?? null;
}

export const CLAUDE_LOGIN_URL = "https://claude.ai/login";

// Returns { status, records, loginUrl }:
//   "ok"          → records is the quota_percent list
//   "needs_login" → user isn't signed in to claude.ai (401/403 or no org); UI prompts login
//   "error"       → endpoint/shape changed or network failure; UI stays quiet
// `fetchImpl` is injectable so the auth/login-state branches are unit-testable.
export async function fetchClaudeQuota(fetchImpl = typeof fetch === "function" ? fetch : null) {
  if (!fetchImpl) return { status: "error", records: [] };
  try {
    const orgUuid = firstOrgUuid(await getJson("/api/account", fetchImpl));
    if (!orgUuid) return { status: "needs_login", records: [], loginUrl: CLAUDE_LOGIN_URL };
    const usage = await getJson(
      `/api/organizations/${encodeURIComponent(orgUuid)}/usage`,
      fetchImpl,
    );
    return { status: "ok", records: mapUsage(usage) };
  } catch (e) {
    if (e && (e.status === 401 || e.status === 403)) {
      return { status: "needs_login", records: [], loginUrl: CLAUDE_LOGIN_URL };
    }
    return { status: "error", records: [] };
  }
}
