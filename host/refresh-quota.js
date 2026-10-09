// Standalone quota refresh, run by the menu-bar plugin each cycle. Fetches login-gated
// plan usage % without the browser (Codex via its authenticated app-server, Cursor
// via the saved cookie, Kimi Code via the local CLI's managed OAuth token) and merges it
// into the quota cache the menu bar reads.
// Best-effort and self-throttling — never throws, never blocks the menu bar for long.
import { fetchCursorQuota } from "./cursor-quota.js";
import { fetchCursorUsageRecords } from "./cursor-usage.js";
import { fetchKimiQuota } from "./kimi-quota.js";
import { fetchCodexQuota, CODEX_QUOTA_SOURCE } from "./codex-quota.js";
import { mergeQuotaCache, readQuotaCache } from "./quota-cache.js";
import { writeUsageCache, readUsageCache } from "./usage-cache.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const QUOTA_THROTTLE_MS = 90_000; // usage-summary is light → refresh ~every minute
const USAGE_THROTTLE_MS = 300_000; // events are heavier (paginated) → ~every 5 minutes

function newest(records, provider) {
  const ts = records.filter((r) => r.provider === provider).map((r) => Date.parse(r.updatedAt) || 0);
  return ts.length ? Math.max(...ts) : 0;
}

(async () => {
  let hidden = [];
  try {
    const prefs = JSON.parse(await readFile(process.env.OMT_MENUBAR_PREFS || join(homedir(), ".oh-my-tokens", "menubar-prefs.json"), "utf8"));
    if (Array.isArray(prefs.hiddenProviders)) hidden = prefs.hiddenProviders;
  } catch {}
  // Use the last active read for throttling: new log snapshots must not suppress polling.
  try {
    const q = await readQuotaCache();
    const active = q.records.filter((r) => r.source === CODEX_QUOTA_SOURCE);
    if (!hidden.includes("codex") && Date.now() - newest(active, "codex") >= QUOTA_THROTTLE_MS) {
      const r = await fetchCodexQuota();
      if (r.status === "ok") await mergeQuotaCache(r.records, ["codex"]);
    }
  } catch {}
  // Cursor plan usage % (light) → quota cache.
  try {
    const q = await readQuotaCache();
    if (!hidden.includes("cursor") && Date.now() - newest(q.records, "cursor") >= QUOTA_THROTTLE_MS) {
      const r = await fetchCursorQuota();
      if (r.status === "ok" || r.status === "needs_login") await mergeQuotaCache(r.records, ["cursor"]);
    }
  } catch {}

  // Cursor per-model tokens + estimated cost (heavier) → usage cache.
  try {
    const u = await readUsageCache();
    if (!hidden.includes("cursor") && Date.now() - newest(u.records, "cursor") >= USAGE_THROTTLE_MS) {
      const r = await fetchCursorUsageRecords();
      if (r.status === "ok" || r.status === "needs_login") await writeUsageCache(r.records);
    }
  } catch {}

  // Kimi Code plan usage % (light) → quota cache.
  try {
    const q = await readQuotaCache();
    if (!hidden.includes("kimi") && Date.now() - newest(q.records, "kimi") >= QUOTA_THROTTLE_MS) {
      const r = await fetchKimiQuota();
      if (r.status === "ok" || r.status === "needs_login") await mergeQuotaCache(r.records, ["kimi"]);
    }
  } catch {}
})();
