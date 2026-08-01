import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Standalone Kimi Code plan-usage fetch: reuse the LOCAL Kimi Code CLI's managed OAuth
// token (~/.kimi-code/credentials/kimi-code.json) to call the same endpoint the CLI's
// /usage panel uses — no browser needed. Bob approved this exception to the usual
// "never read ~/.kimi-code/credentials/" rule (2026-07-31, see AGENTS.md): read ONLY
// this one file, never log or persist the token anywhere else.
//
// The token rotates on every refresh (the response carries a NEW refresh_token), so a
// refresh must be written back to the same file — the CLI reads it on its next refresh.
// If our refresh races the CLI's (invalid_grant), re-read the file once and retry.

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"; // public device-flow client id (from the CLI)
const REFRESH_SKEW_S = 60; // refresh when the access token expires within a minute

function kimiHome() {
  const override = process.env.KIMI_CODE_HOME;
  return override && override.length > 0 ? override : join(homedir(), ".kimi-code");
}
function credentialsPath() {
  return process.env.OMT_KIMI_CREDENTIALS || join(kimiHome(), "credentials", "kimi-code.json");
}
function oauthHost() {
  return (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST || "https://auth.kimi.com").replace(
    /\/+$/,
    "",
  );
}
function usageUrl() {
  const base = (process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/+$/, "");
  return `${base}/usages`;
}

async function readTokenFile() {
  const parsed = JSON.parse(await readFile(credentialsPath(), "utf8"));
  if (typeof parsed?.access_token !== "string" || typeof parsed?.refresh_token !== "string") {
    throw new Error("no managed token");
  }
  return parsed;
}
async function writeTokenFile(tok) {
  // Same keys the CLI writes; keep the file owner-only.
  await writeFile(credentialsPath(), JSON.stringify(tok, null, 2) + "\n", { mode: 0o600 });
}

async function postTokenForm(params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${oauthHost()}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshOnce(refreshToken) {
  const { status, data } = await postTokenForm({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (status === 200 && typeof data?.access_token === "string" && typeof data?.refresh_token === "string") {
    const expiresIn = Number(data.expires_in) || 0;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      scope: typeof data.scope === "string" ? data.scope : "",
      token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
      expires_in: expiresIn,
    };
  }
  const err = new Error(`refresh failed (HTTP ${status})`);
  err.invalidGrant = status === 401 || status === 403 || data?.error === "invalid_grant";
  throw err;
}

// Returns a valid access token, refreshing (and persisting the rotated tokens) when needed.
async function ensureAccessToken() {
  const tok = await readTokenFile();
  const nowS = Math.floor(Date.now() / 1000);
  if (Number(tok.expires_at) - nowS > REFRESH_SKEW_S) return tok.access_token;
  try {
    const fresh = await refreshOnce(tok.refresh_token);
    await writeTokenFile(fresh);
    return fresh.access_token;
  } catch (e) {
    if (!e?.invalidGrant) throw e;
    // We raced another refresher (likely the CLI): re-read the rotated token and retry once.
    const tok2 = await readTokenFile();
    if (Number(tok2.expires_at) - Math.floor(Date.now() / 1000) > REFRESH_SKEW_S) return tok2.access_token;
    const fresh2 = await refreshOnce(tok2.refresh_token);
    await writeTokenFile(fresh2);
    return fresh2.access_token;
  }
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function normalizeUnit(raw) {
  switch (raw) {
    case "minute":
    case "TIME_UNIT_MINUTE":
      return "minute";
    case "hour":
    case "TIME_UNIT_HOUR":
      return "hour";
    case "day":
    case "TIME_UNIT_DAY":
      return "day";
    case "week":
    case "TIME_UNIT_WEEK":
      return "week";
    default:
      return null;
  }
}
// "weekly" for the 1-week summary; compact "5h" / "7d" / "30m" for rate-limit windows.
// The API expresses long windows in minutes (300m), so fold whole hours first.
function windowLabel(window) {
  let unit = normalizeUnit(window?.unit ?? window?.timeUnit ?? window?.time_unit);
  let duration = toInt(window?.duration);
  if (!unit || !duration || duration <= 0) return null;
  if (unit === "minute" && duration % 60 === 0) {
    unit = "hour";
    duration = duration / 60;
  }
  if (unit === "week" && duration === 1) return "weekly";
  const suffix = { minute: "m", hour: "h", day: "d", week: "w" }[unit];
  return `${duration}${suffix}`;
}
function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
// Proto-JSON leaks through as numeric strings ("37") and sometimes only gives
// limit+remaining (no used) — normalize all of it.
function rowNumbers(row) {
  const limit = toInt(row?.limit);
  let used = toInt(row?.used);
  if (used === null) {
    const remaining = toInt(row?.remaining);
    if (limit !== null && remaining !== null) used = limit - remaining;
  }
  return { used, limit };
}
function planLabel(payload) {
  const level = firstString(payload?.user?.membership ?? {}, ["level"]);
  if (!level) return "Kimi Code";
  const word = level.replace(/^LEVEL_/, "").toLowerCase();
  return word ? `Kimi ${word[0].toUpperCase()}${word.slice(1)}` : "Kimi Code";
}

function quotaRecord({ label, usedPercent, resetsAt, planType }) {
  return {
    id: `kimi::quota:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:quota_percent`,
    provider: "kimi",
    model: null,
    metricType: "quota_percent",
    source: "api.kimi.com/coding/v1/usages",
    window: "today",
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    requests: 0,
    costUSD: null,
    balance: null,
    currency: null,
    usedPercent: Math.round(Math.max(0, Math.min(100, usedPercent)) * 10) / 10,
    windowLabel: label,
    resetsAt: resetsAt || undefined,
    planType: planType || "Kimi Code",
    updatedAt: new Date().toISOString(),
    confidence: "high",
    warnings: ["Kimi Code account plan usage from the managed API (fetched standalone)"],
  };
}

function rowToRecord(row, { fallbackLabel, name, window, planType } = {}) {
  if (!row || typeof row !== "object") return null;
  const { used, limit } = rowNumbers(row);
  if (used === null || !limit || limit <= 0) return null;
  const label = windowLabel(window) || (typeof name === "string" && name) || fallbackLabel;
  if (!label) return null;
  return quotaRecord({
    label,
    usedPercent: (used / limit) * 100,
    resetsAt: firstString(row, ["resetTime", "reset_at", "resetAt"]),
    planType,
  });
}

// Pure mapping (exported for tests): the /usages payload -> quota_percent records.
// Real payload (proto-JSON): `usage` = weekly summary (no window, limit+remaining as
// strings), `limits[]` = rate-limit rows ({detail, window:{duration,timeUnit}}).
// `boosterWallet` (Extra Usage balance) is ignored — quota buckets only.
export function mapUsagePayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const planType = planLabel(payload);
  const out = [];
  const summary = rowToRecord(payload.usage, { fallbackLabel: "weekly", planType });
  if (summary) out.push(summary);
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== "object") continue;
    const rec = rowToRecord(item.detail ?? item, {
      name: firstString(item, ["name"]) ?? firstString(item.detail ?? {}, ["name"]),
      window: item.window,
      planType,
    });
    if (rec) out.push(rec);
  }
  return out;
}

// Returns { status: "ok"|"needs_login"|"error", records }.
export async function fetchKimiQuota() {
  let token;
  try {
    token = await ensureAccessToken();
  } catch {
    return { status: "needs_login", records: [] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(usageUrl(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { status: "needs_login", records: [] };
    if (!res.ok) return { status: "error", records: [] };
    return { status: "ok", records: mapUsagePayload(await res.json()) };
  } catch {
    return { status: "error", records: [] };
  } finally {
    clearTimeout(timer);
  }
}
