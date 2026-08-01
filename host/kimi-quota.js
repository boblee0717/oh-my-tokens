import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
//
// The OAuth client_id (required on refresh — the server rejects client_id-less
// requests with invalid_request) is NOT hardcoded here: it is a public device-flow
// identifier baked into the CLI binary, so we extract it from the local installation
// at runtime and cache it keyed by the binary's mtime.

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
function cliBinaryPath() {
  return process.env.OMT_KIMI_CLI_BINARY || join(kimiHome(), "bin", "kimi");
}
function clientIdCachePath() {
  return (
    process.env.OMT_KIMI_CLIENT_ID_CACHE || join(homedir(), ".oh-my-tokens", "kimi-client-id.json")
  );
}

const CLIENT_ID_RE = /clientId:\s*"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"/;
// Longest possible match is `clientId: "<36-char uuid>"` ≈ 50 chars; carrying this much
// text between chunks keeps a match that straddles a chunk boundary findable.
const CLIENT_ID_CARRY = 80;

// The CLI binary is ~160MB, so scan it a megabyte at a time instead of materialising the
// whole thing as a Buffer plus a latin1 string.
async function scanForClientId(bin) {
  const stream = createReadStream(bin, { highWaterMark: 1 << 20 });
  let carry = "";
  try {
    for await (const chunk of stream) {
      const text = carry + chunk.toString("latin1");
      const m = CLIENT_ID_RE.exec(text);
      if (m) return m[1];
      carry = text.slice(-CLIENT_ID_CARRY);
    }
  } finally {
    stream.destroy();
  }
  return null;
}

// Extract the CLI's public OAuth client_id from its own binary (exactly one
// `clientId: "<uuid>"` constant exists in the embedded JS), cached by binary mtime
// so the scan happens only after a CLI upgrade. OMT_KIMI_CLIENT_ID overrides.
export async function resolveClientId() {
  if (process.env.OMT_KIMI_CLIENT_ID) return process.env.OMT_KIMI_CLIENT_ID;
  const bin = cliBinaryPath();
  try {
    const st = await stat(bin);
    try {
      const cached = JSON.parse(await readFile(clientIdCachePath(), "utf8"));
      if (cached?.clientId && cached?.mtimeMs === st.mtimeMs) return cached.clientId;
    } catch {
    }
    const clientId = await scanForClientId(bin);
    if (!clientId) return null;
    await writeFile(
      clientIdCachePath(),
      JSON.stringify({ mtimeMs: st.mtimeMs, clientId }),
      { mode: 0o600 },
    ).catch(() => {});
    return clientId;
  } catch {
    return null;
  }
}

// Marks the failures that really mean "the user must sign in again", as opposed to a
// network blip or a bad day at the token endpoint — only these may surface a login prompt.
function loginError(message) {
  const e = new Error(message);
  e.needsLogin = true;
  return e;
}

async function readTokenFile() {
  let raw;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch {
    throw loginError("no Kimi Code credentials file");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw loginError("unreadable Kimi Code credentials file");
  }
  if (typeof parsed?.access_token !== "string" || typeof parsed?.refresh_token !== "string") {
    throw loginError("no managed token");
  }
  return parsed;
}
// We overwrite the CLI's own credentials file, so carry over every field we don't manage
// (the refresh response only covers the token keys) and swap the file in atomically — a
// half-written file here would log the user out of the Kimi Code CLI. Exported for tests.
export async function writeTokenFile(previous, fresh) {
  const path = credentialsPath();
  const tmp = `${path}.omt-${process.pid}.tmp`;
  // The mode applies to the fresh temp file, so the result is owner-only even though the
  // destination already exists (writeFile ignores mode for existing files).
  await writeFile(tmp, JSON.stringify({ ...previous, ...fresh }, null, 2) + "\n", { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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

async function refreshOnce(clientId, refreshToken) {
  const { status, data } = await postTokenForm({
    client_id: clientId,
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
  // A rejected grant means re-auth; any other status is the server's problem, not the
  // user's login, so it must not be reported as needs_login.
  err.needsLogin = err.invalidGrant;
  throw err;
}

// Returns a valid access token, refreshing (and persisting the rotated tokens) when needed.
async function ensureAccessToken() {
  const tok = await readTokenFile();
  const nowS = Math.floor(Date.now() / 1000);
  if (Number(tok.expires_at) - nowS > REFRESH_SKEW_S) return tok.access_token;
  const clientId = await resolveClientId();
  // No resolvable client id means no usable local CLI install — treat it like a missing
  // credential (prompt the user) rather than a transient failure.
  if (!clientId) throw loginError("cannot resolve the Kimi Code CLI's OAuth client id");
  try {
    const fresh = await refreshOnce(clientId, tok.refresh_token);
    await writeTokenFile(tok, fresh);
    return fresh.access_token;
  } catch (e) {
    if (!e?.invalidGrant) throw e;
    // We raced another refresher (likely the CLI): re-read the rotated token and retry once.
    const tok2 = await readTokenFile();
    if (Number(tok2.expires_at) - Math.floor(Date.now() / 1000) > REFRESH_SKEW_S) return tok2.access_token;
    const fresh2 = await refreshOnce(clientId, tok2.refresh_token);
    await writeTokenFile(tok2, fresh2);
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
  } catch (e) {
    // A timeout or a 5xx from the token endpoint would otherwise claim the session died
    // and put a "Log in to Kimi Code" prompt in the menu bar while nothing is wrong.
    return { status: e?.needsLogin ? "needs_login" : "error", records: [] };
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
