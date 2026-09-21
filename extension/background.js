// Background service worker: keep the login-gated plan-usage % fresh without opening the
// popup. Claude.ai / Codex quota can only be fetched from inside the browser (Cloudflare
// blocks the standalone host), so on a timer we fetch them here and push them to the native
// host's cache — the macOS menu bar then stays current while Chrome is running. Cursor
// also refreshes here because macOS may deny SwiftBar access to Chrome's cookie store.
import { fetchClaudeQuota } from "./claude-web.js";
import { fetchCodexQuota } from "./codex-web.js";
import { fetchCursorQuota } from "./cursor-web.js";
import { saveQuotaToHost, DEFAULT_HOST_NAME } from "./usage-client.js";

const ALL_PROVIDERS = ["claude-code", "codex", "traex", "deepseek", "cursor", "kimi"];
const ALARM = "omt-quota-refresh";
const PERIOD_MINUTES = 10;

async function getSettings() {
  try {
    const s = await chrome.storage.local.get(["hostName", "enabledProviders"]);
    return {
      hostName: s.hostName || DEFAULT_HOST_NAME,
      enabled: Array.isArray(s.enabledProviders) ? s.enabledProviders : ALL_PROVIDERS,
    };
  } catch {
    return { hostName: DEFAULT_HOST_NAME, enabled: ALL_PROVIDERS };
  }
}

// Fetch quota for enabled providers; saveQuotaToHost merges by provider.
async function refreshQuota() {
  const { hostName, enabled } = await getSettings();
  const jobs = [];
  if (enabled.includes("claude-code")) jobs.push(fetchClaudeQuota());
  if (enabled.includes("codex")) jobs.push(fetchCodexQuota());
  if (enabled.includes("cursor")) jobs.push(fetchCursorQuota());
  if (!jobs.length) return;
  const results = await Promise.allSettled(jobs);
  const records = [];
  for (const r of results) {
    if (r.status === "fulfilled" && Array.isArray(r.value?.records)) records.push(...r.value.records);
  }
  if (records.length) saveQuotaToHost(records, { hostName });
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshQuota();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshQuota();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refreshQuota();
});
