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
    usedPercent: Math.max(0, Math.min(100, Number(usedPercent) || 0)),
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

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

// Returns quota_percent records for Claude, or [] on any failure.
export async function fetchClaudeQuota() {
  try {
    if (typeof fetch !== "function") return [];
    const orgUuid = firstOrgUuid(await getJson("/api/account"));
    if (!orgUuid) return [];
    const usage = await getJson(`/api/organizations/${encodeURIComponent(orgUuid)}/usage`);
    return mapUsage(usage);
  } catch {
    return []; // not logged in / blocked / shape changed → Claude shows tokens only
  }
}
