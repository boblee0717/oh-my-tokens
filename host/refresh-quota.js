// Standalone quota refresh, run by the menu-bar plugin each cycle. Fetches login-gated
// plan usage % that the host CAN reach without the browser (currently Cursor, via the
// saved cursor.com cookie) and merges it into the quota cache the menu bar reads.
// Best-effort and self-throttling — never throws, never blocks the menu bar for long.
import { fetchCursorQuota } from "./cursor-quota.js";
import { fetchCursorUsageRecords } from "./cursor-usage.js";
import { mergeQuotaCache, readQuotaCache } from "./quota-cache.js";
import { writeUsageCache, readUsageCache } from "./usage-cache.js";

const QUOTA_THROTTLE_MS = 90_000; // usage-summary is light → refresh ~every minute
const USAGE_THROTTLE_MS = 300_000; // events are heavier (paginated) → ~every 5 minutes

function newest(records, provider) {
  const ts = records.filter((r) => r.provider === provider).map((r) => Date.parse(r.updatedAt) || 0);
  return ts.length ? Math.max(...ts) : 0;
}

(async () => {
  // Cursor plan usage % (light) → quota cache.
  try {
    const q = await readQuotaCache();
    if (Date.now() - newest(q.records, "cursor") >= QUOTA_THROTTLE_MS) {
      const r = await fetchCursorQuota();
      if (r.status === "ok" || r.status === "needs_login") await mergeQuotaCache(r.records, ["cursor"]);
    }
  } catch {}

  // Cursor per-model tokens + estimated cost (heavier) → usage cache.
  try {
    const u = await readUsageCache();
    if (Date.now() - newest(u.records, "cursor") >= USAGE_THROTTLE_MS) {
      const r = await fetchCursorUsageRecords();
      if (r.status === "ok" || r.status === "needs_login") await writeUsageCache(r.records);
    }
  } catch {}
})();
