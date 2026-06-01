// Standalone quota refresh, run by the menu-bar plugin each cycle. Fetches login-gated
// plan usage % that the host CAN reach without the browser (currently Cursor, via the
// saved cursor.com cookie) and merges it into the quota cache the menu bar reads.
// Best-effort and self-throttling — never throws, never blocks the menu bar for long.
import { fetchCursorQuota } from "./cursor-quota.js";
import { mergeQuotaCache, readQuotaCache } from "./quota-cache.js";

const THROTTLE_MS = 90_000;

async function freshEnough(provider) {
  const { records } = await readQuotaCache();
  const ts = records
    .filter((r) => r.provider === provider)
    .map((r) => Date.parse(r.updatedAt) || 0);
  return ts.length > 0 && Date.now() - Math.max(...ts) < THROTTLE_MS;
}

(async () => {
  try {
    if (await freshEnough("cursor")) return; // refreshed recently — skip the network call
    const r = await fetchCursorQuota();
    // ok → write records; needs_login → write [] to clear stale (logged out);
    // error (transient/network) → leave the existing cursor cache untouched.
    if (r.status === "ok" || r.status === "needs_login") {
      await mergeQuotaCache(r.records, ["cursor"]);
    }
  } catch {
    // never let a refresh failure break the menu bar
  }
})();
