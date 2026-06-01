// Codex web connector. Codex's real plan quota (5h / weekly remaining %) lives at
// chatgpt.com/codex/cloud/settings/analytics, rendered client-side. The backing
// wham/usage APIs require an internal app bearer (a plain credentials:"include" fetch
// returns 401 "Access token is missing"), so unlike claude-web/cursor-web we can't fetch
// JSON — we open the analytics page in a hidden background tab and read the already-rendered
// text via chrome.scripting.executeScript, then regex-parse it. We never read cookies/tokens;
// only the visible page text.
//
// IMPORTANT: the page shows REMAINING percent ("37% 剩余"); the popup's quota_percent record
// is usedPercent, so usedPercent = 100 - remaining.
//
// Produces quota_percent UsageRecords (same shape the host emits) so the popup renders the
// real Codex quota instead of "quota data unavailable". Any failure (not logged in, layout
// changed, tab/scripting error) yields needs_login/error → Codex falls back to just tokens.
//
// Captured 2026-06-01 (zh locale). Labels are locale-dependent; English fallback can be added.

const ANALYTICS_URL = "https://chatgpt.com/codex/cloud/settings/analytics";
export const CODEX_LOGIN_URL = "https://chatgpt.com/codex/cloud/settings/analytics";

function clampPct(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function quotaRecord(label, remainingPercent, planType) {
  const remaining = clampPct(remainingPercent);
  if (remaining === null) return null;
  return {
    id: `codex::quota:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:quota_percent`,
    provider: "codex",
    model: null,
    metricType: "quota_percent",
    source: "chatgpt.com/codex/cloud/settings/analytics",
    window: "today",
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    requests: 0,
    costUSD: null,
    balance: null,
    currency: null,
    // page gives remaining; popup wants used
    usedPercent: Math.round((100 - remaining) * 10) / 10,
    windowLabel: label,
    resetsAt: undefined,
    planType: planType || undefined,
    updatedAt: new Date().toISOString(),
    confidence: "high",
    warnings: ["Codex account plan quota (from analytics page; shown as used = 100 − remaining)"],
  };
}

// Rendered page text → quota_percent records (main plan only: 5h + weekly). Exported for
// unit testing. Page renders REMAINING %; converted to used inside quotaRecord. We only want
// the MAIN plan, not the "GPT-5.3-Codex-Spark" windows, so we take the "N% 剩余" match whose
// preceding text isn't the Spark model name. Robust to main/Spark render order.
export function parseAnalyticsText(text) {
  if (!text || typeof text !== "string") return [];
  // The main plan windows render before the "GPT-5.3-Codex-Spark" section; take the first
  // "N% 剩余" for the label that appears before that marker (or anywhere if no Spark section).
  const sparkIdx = text.indexOf("GPT-5.3-Codex-Spark");
  const mainRemaining = (labelPattern) => {
    const re = new RegExp(labelPattern + "[\\s\\S]{0,40}?(\\d+)%\\s*剩余", "g");
    let m;
    while ((m = re.exec(text))) {
      if (sparkIdx < 0 || m.index < sparkIdx) return Number(m[1]);
    }
    return null;
  };
  const out = [];
  const push = (label, rem) => {
    const rec = quotaRecord(label, rem, "Codex");
    if (rec) out.push(rec);
  };
  const r5 = mainRemaining("5\\s*小时使用限额");
  const rW = mainRemaining("每周使用限额");
  if (r5 !== null) push("5h", r5);
  if (rW !== null) push("Weekly", rW);
  return out;
}

// Default browser deps (chrome.tabs + chrome.scripting). Injectable for tests.
function defaultDeps() {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.scripting) return null;
  return {
    createTab: (url) => chrome.tabs.create({ url, active: false }),
    removeTab: (id) => chrome.tabs.remove(id).catch(() => {}),
    readText: async (tabId) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body ? document.body.innerText : "",
      });
      return res?.result || "";
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// Open the analytics page in a hidden tab, poll its text until the limit section renders,
// parse it, and clean up. Returns { status, records, loginUrl }:
//   "ok"          → records is the quota_percent list
//   "needs_login" → page never showed the limit section (likely not signed in)
//   "error"       → tab/scripting failure
export async function fetchCodexQuota(deps = defaultDeps()) {
  if (!deps) return { status: "error", records: [] };
  let tabId;
  try {
    const tab = await deps.createTab(ANALYTICS_URL);
    tabId = tab?.id;
    if (tabId == null) return { status: "error", records: [] };
    // Poll for up to ~12s: the analytics SPA fetches + renders after load.
    for (let i = 0; i < 24; i++) {
      await deps.sleep(500);
      let text = "";
      try {
        text = await deps.readText(tabId);
      } catch {
        continue; // tab not ready yet
      }
      if (/使用限额/.test(text)) {
        const records = parseAnalyticsText(text);
        if (records.length) return { status: "ok", records };
      }
      // Login wall: the page bounces to a login screen with no limit text.
      if (/登录|log in|sign in/i.test(text) && !/使用限额/.test(text) && i > 6) {
        return { status: "needs_login", records: [], loginUrl: CODEX_LOGIN_URL };
      }
    }
    return { status: "needs_login", records: [], loginUrl: CODEX_LOGIN_URL };
  } catch {
    return { status: "error", records: [] };
  } finally {
    if (tabId != null) await deps.removeTab(tabId);
  }
}
