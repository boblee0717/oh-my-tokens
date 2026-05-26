// DeepSeek token usage (approach B): the platform usage API needs an Authorization
// Bearer web token (not cookies), so a background fetch can't authenticate. Instead we
// open platform.deepseek.com in a hidden tab and inject a script that runs in that origin
// — where it can read the web token and call the API — then return only aggregated usage
// and close the tab. The token is never surfaced to the extension or stored.
//
// Needs: host_permissions https://platform.deepseek.com/*, and "scripting" + "tabs".
// Endpoint (captured): GET /api/v0/usage/amount?month=M&year=Y
//   → data.biz_data.total[] (per-model monthly) + data.biz_data.days[] (per-day),
//     each model usage[] has REQUEST / RESPONSE_TOKEN / PROMPT_CACHE_MISS_TOKEN /
//     PROMPT_CACHE_HIT_TOKEN.
//
// Heavier and more fragile than the Claude connector (opens a tab each refresh); chosen
// deliberately for always-fresh data. Any failure → [] (DeepSeek shows balance only).

const USAGE_PAGE = "https://platform.deepseek.com/usage";

function waitForTabComplete(tabId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("deepseek tab load timeout"));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Runs INSIDE the platform.deepseek.com page (isolated world: shares origin + localStorage).
// Self-contained — no outer references. Returns the usage JSON or null. The web token lives
// in localStorage "userToken" as { value, __version }; we use it only here, never persist it.
function fetchUsageInPage(month, year) {
  let token = null;
  try {
    const raw = localStorage.getItem("userToken");
    token = raw ? JSON.parse(raw).value : null;
  } catch {
    token = null;
  }
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`/api/v0/usage/amount?month=${month}&year=${year}`, { headers })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function numAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// usage JSON → measured_tokens UsageRecords, aggregating data.biz_data.days[] into
// today / 7d / 30d per model. Mapping (matches the platform's own token total):
//   RESPONSE_TOKEN → output, PROMPT_CACHE_MISS_TOKEN → input (fresh),
//   PROMPT_CACHE_HIT_TOKEN → cache, REQUEST → requests. Provider "deepseek".
// `amount` is a string in the API; coerced via Number.
export function mapDeepSeekUsage(json, now = new Date()) {
  const days = json?.data?.biz_data?.days;
  if (!Array.isArray(days)) return [];

  const DAY = 86400000;
  const cutoff = {
    today: ymd(now),
    "7d": ymd(new Date(now.getTime() - 6 * DAY)),
    "30d": ymd(new Date(now.getTime() - 29 * DAY)),
  };

  const records = [];
  const updatedAt = now.toISOString();

  for (const window of ["today", "7d", "30d"]) {
    const min = cutoff[window];
    const byModel = new Map();
    for (const day of days) {
      if (!day?.date || day.date < min) continue; // ISO YYYY-MM-DD compares lexicographically
      for (const entry of day.data ?? []) {
        const model = entry.model || "deepseek";
        const a = byModel.get(model) ?? { req: 0, resp: 0, miss: 0, hit: 0 };
        for (const u of entry.usage ?? []) {
          const amt = numAmount(u.amount);
          if (u.type === "REQUEST") a.req += amt;
          else if (u.type === "RESPONSE_TOKEN") a.resp += amt;
          else if (u.type === "PROMPT_CACHE_MISS_TOKEN") a.miss += amt;
          else if (u.type === "PROMPT_CACHE_HIT_TOKEN") a.hit += amt;
        }
        byModel.set(model, a);
      }
    }
    for (const [model, a] of byModel) {
      if (!a.req && !a.resp && !a.miss && !a.hit) continue;
      records.push({
        id: `deepseek:${model}:${window}:measured_tokens`,
        provider: "deepseek",
        model,
        metricType: "measured_tokens",
        source: "platform.deepseek.com/api/v0/usage",
        window,
        inputTokens: a.miss,
        outputTokens: a.resp,
        cacheTokens: a.hit,
        requests: a.req,
        costUSD: null,
        balance: null,
        currency: null,
        updatedAt,
        confidence: "high",
        warnings: [],
      });
    }
  }
  return records;
}

export async function fetchDeepSeekUsage(now = new Date()) {
  if (typeof chrome === "undefined" || !chrome.tabs?.create || !chrome.scripting?.executeScript) {
    return [];
  }
  let tabId;
  try {
    const tab = await chrome.tabs.create({ url: USAGE_PAGE, active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchUsageInPage,
      args: [now.getMonth() + 1, now.getFullYear()],
    });
    return mapDeepSeekUsage(res?.result, now);
  } catch {
    return [];
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  }
}
