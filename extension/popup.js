import { applyUpdate, getUsageReport, DEFAULT_HOST_NAME, saveQuotaToHost } from "./usage-client.js";
import { fetchClaudeQuota } from "./claude-web.js";
import { fetchDeepSeekUsage } from "./deepseek-usage.js";
import { fetchCursorUsage } from "./cursor-web.js";
import { fetchCodexQuota } from "./codex-web.js";
import { updateBannerModel } from "./update-ui.js";

const PROVIDER_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  deepseek: "DeepSeek",
  cursor: "Cursor",
};
const ALL_PROVIDERS = ["claude-code", "codex", "deepseek", "cursor"];
let activeProviders = ALL_PROVIDERS;

const _compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
function fmtCompact(n) {
  return _compact.format(n).replace(/\.0(?=[KMBTkmt])/, "");
}

// Escape anything interpolated into innerHTML; model names / currencies / warnings
// originate from logs or external APIs, so treat them as untrusted.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function money(n, ccy) {
  try {
    const abs = Math.abs(n);
    if (abs > 0 && abs < 0.01) {
      return new Intl.NumberFormat("en", {
        style: "currency", currency: ccy || "USD",
        minimumFractionDigits: 4, maximumFractionDigits: 4,
      }).format(n);
    }
    return new Intl.NumberFormat("en", { style: "currency", currency: ccy || "USD" }).format(n);
  } catch {
    return `${n} ${ccy || ""}`.trim();
  }
}

function greeting(d) {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function formatReset(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  // Cross-day: compact numeric date + time (locale-stable), e.g. "6/15 00:39".
  const when = sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `resets ${when}`;
}

let report = null;
let currentWindow = "7d";
let updateState = null;
// provider → login URL, for web sources that report the user isn't signed in.
let loginPrompts = {};
const PREVIEW_TEXT = "Preview data — the local host isn't connected yet. See the README to install it.";

async function getSettings() {
  try {
    const s = await chrome.storage.local.get(["hostName", "window", "deepseekApiKey", "enabledProviders"]);
    return {
      hostName: s.hostName || DEFAULT_HOST_NAME,
      window: s.window || "7d",
      deepseekApiKey: s.deepseekApiKey || "",
      enabledProviders: Array.isArray(s.enabledProviders) ? s.enabledProviders : ALL_PROVIDERS,
    };
  } catch {
    return { hostName: DEFAULT_HOST_NAME, window: "7d", deepseekApiKey: "", enabledProviders: ALL_PROVIDERS };
  }
}

function metric(label, value, cls = "") {
  return `<span class="metric ${cls}"><span class="label">${label}</span> <span class="value">${value}</span></span>`;
}

function quotaRowsHtml(records) {
  return records
    .map((q) => {
      const pctNum = Math.max(0, Math.min(100, Number(q.usedPercent) || 0));
      const pctStr = Number.isInteger(pctNum) ? String(pctNum) : pctNum.toFixed(1);
      const cls = pctNum >= 80 ? "high" : pctNum >= 50 ? "warn" : "";
      const reset = formatReset(q.resetsAt);
      return `<div class="quota-row">
        <div class="top">
          <span class="label">${esc(q.windowLabel || "")}</span>
          <span class="pct">${pctStr}%</span>
        </div>
        <div class="bar ${cls}"><span style="width:${pctNum}%"></span></div>
        ${reset ? `<div class="reset">${esc(reset)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function balanceRowsHtml(records) {
  return records
    .map(
      (b) =>
        `<div class="quota-row"><div class="top"><span class="label">balance</span><span class="pct balance">${esc(money(b.balance, b.currency))}</span></div></div>`,
    )
    .join("");
}

function loginPromptHtml(provider) {
  const url = loginPrompts[provider];
  if (!url) return "";
  return `<div class="login-prompt">Not signed in. <a class="login-link" href="#" data-url="${esc(url)}">Log in to ${esc(PROVIDER_NAMES[provider] || provider)} →</a></div>`;
}

function renderQuota() {
  const section = document.getElementById("quota-section");
  const box = document.getElementById("quota");
  const items = (report?.records || []).filter(
    (r) => r.metricType === "quota_percent" || r.metricType === "balance",
  );
  const promptProviders = Object.keys(loginPrompts);
  if (!items.length && !promptProviders.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  const hasProviderData = (p) => (report?.records || []).some((r) => r.provider === p);

  const html = activeProviders.map((p) => {
    const pctRecs = items.filter((q) => q.provider === p && q.metricType === "quota_percent");
    const balRecs = items.filter((q) => q.provider === p && q.metricType === "balance");
    const needsLogin = !!loginPrompts[p];
    if (!pctRecs.length && !balRecs.length && !hasProviderData(p) && !needsLogin) return "";
    const all = [...pctRecs, ...balRecs];
    const plan = all.find((q) => q.planType)?.planType;
    const note = distinctWarnings(all)[0];
    const login = loginPromptHtml(p);
    // "quota data unavailable" is only meaningful for a provider that *should* have a quota %
    // but doesn't. Balance-only providers (e.g. DeepSeek is prepaid, no % concept) show their
    // balance below instead — don't label them as unavailable.
    const quotaHtml = pctRecs.length
      ? quotaRowsHtml(pctRecs)
      : login || (hasProviderData(p) && !balRecs.length
        ? '<div class="quota-row"><span class="label-empty">quota data unavailable</span></div>'
        : "");
    return `<div class="quota-group">
      <div class="quota-provider">${esc(PROVIDER_NAMES[p] || p)}${plan ? `<span class="plan">${esc(plan)}</span>` : ""}</div>
      ${quotaHtml}
      ${balanceRowsHtml(balRecs)}
      ${note ? `<div class="quota-note">${esc(note)}</div>` : ""}
    </div>`;
  }).join("");
  box.innerHTML = html;
}

function distinctWarnings(records) {
  return [...new Set(records.flatMap((r) => r.warnings || []))];
}

function renderProviderCard(provider, records) {
  const measured = records.filter((r) => r.metricType === "measured_tokens");
  const reqCounted = records.filter((r) => r.metricType === "request_count");
  const costs = records.filter((r) => r.metricType === "estimated_cost");

  let rows = "";
  for (const m of measured) {
    const cost = costs.find((c) => c.model === m.model);
    const parts = [
      metric("in", fmtCompact(m.inputTokens)),
      metric("out", fmtCompact(m.outputTokens)),
      metric("cache", fmtCompact(m.cacheTokens)),
    ];
    if (cost) parts.push(metric("cost", esc(money(cost.costUSD, cost.currency)), "cost"));
    rows += `<div class="model-row"><div class="model-name">${esc(m.model)}</div><div class="metrics">${parts.join("")}</div></div>`;
  }
  for (const m of reqCounted) {
    rows += `<div class="model-row"><div class="model-name">${esc(m.model)}</div><div class="metrics">${metric("req", fmtCompact(m.requests))}</div></div>`;
  }

  const reqTotal = measured.reduce((s, r) => s + (r.requests || 0), 0) + reqCounted.reduce((s, r) => s + (r.requests || 0), 0);
  const meta = measured.length ? `${fmtCompact(reqTotal)} req` : "";
  const warns = distinctWarnings(records);
  const warnHtml = warns.length
    ? `<div class="warn-note" title="${warns.map(esc).join("&#10;")}">⚠ ${warns.length} note${warns.length > 1 ? "s" : ""}</div>`
    : "";

  const login = loginPromptHtml(provider);

  return `<section class="card"><h2>${esc(PROVIDER_NAMES[provider] || provider)}<span class="provider-meta">${meta}</span></h2>${rows || login || '<div class="model-name">no data</div>'}${warnHtml}</section>`;
}

// Inline provider toggles (also editable in Options). A filled pill = shown, a muted
// pill = hidden; clicking flips the provider and persists to the same `enabledProviders`.
function renderProviderFilter() {
  const bar = document.getElementById("provider-filter");
  if (!bar) return;
  bar.innerHTML = ALL_PROVIDERS.map((p) => {
    const on = activeProviders.includes(p);
    return `<button type="button" class="provider-pill${on ? "" : " off"}" data-provider="${p}" aria-pressed="${on}" title="${on ? "Click to hide" : "Click to show"}">${esc(PROVIDER_NAMES[p] || p)}</button>`;
  }).join("");
}

function render() {
  renderProviderFilter();
  renderUpdateBanner();
  const cards = document.getElementById("cards");
  const status = document.getElementById("status");
  const banner = document.getElementById("preview-banner");
  if (!report) {
    cards.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }
  if (report._source === "sample") {
    banner.textContent = report._nativeError
      ? `Preview data — native host unavailable: ${report._nativeError}`
      : PREVIEW_TEXT;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
    banner.textContent = PREVIEW_TEXT;
  }
  renderQuota();

  // Usage cards: token/request records for the selected window only. Quota % and
  // balance live in the Quota section above, so a provider with only those gets
  // no empty Usage card.
  const tokenRecords = report.records.filter(
    (r) =>
      r.window === currentWindow &&
      (r.metricType === "measured_tokens" ||
        r.metricType === "estimated_cost" ||
        r.metricType === "request_count"),
  );

  const html = activeProviders.map((p) => {
    const recs = tokenRecords.filter((r) => r.provider === p);
    return recs.length ? renderProviderCard(p, recs) : "";
  }).join("");
  if (!activeProviders.length) {
    cards.innerHTML = '<div class="empty">No providers enabled. <a id="open-options-inline" href="#">Open Options</a> to enable the ones you use.</div>';
  } else {
    cards.innerHTML = html || '<div class="empty">No usage in this window.</div>';
  }

  const when = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "";
  status.textContent = `${report._source === "sample" ? "sample" : "updated"} ${when}`;
}

function renderUpdateBanner() {
  const banner = document.getElementById("update-banner");
  const title = document.getElementById("update-title");
  const detail = document.getElementById("update-detail");
  const action = document.getElementById("update-action");
  if (!banner || !title || !detail || !action) return;
  const model = updateBannerModel(updateState || report?.update);
  banner.classList.toggle("hidden", !model.visible);
  banner.classList.toggle("warn", model.tone === "warn");
  banner.classList.toggle("success", model.tone === "success");
  title.textContent = model.title;
  detail.textContent = model.detail;
  action.hidden = !model.canUpdate;
  action.disabled = !model.canUpdate;
}

async function load() {
  const now = new Date();
  document.getElementById("greeting").textContent = greeting(now);
  document.getElementById("date").textContent = now.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const settings = await getSettings();
  activeProviders = ALL_PROVIDERS.filter((p) => settings.enabledProviders.includes(p));
  currentWindow = settings.window;
  for (const b of document.querySelectorAll(".windows button")) {
    b.classList.toggle("active", b.dataset.window === currentWindow);
  }
  report = null;
  render();
  report = await getUsageReport({
    hostName: settings.hostName,
    deepseekApiKey: settings.deepseekApiKey,
  });
  updateState = report.update || null;
  render();

  // Web-sourced data (not from local logs / native host). Skipped in sample/preview mode
  // so we don't mix mock + live data. Each fetch is independent and merges as it resolves.
  // Each connector returns { status, records, loginUrl }: needs_login surfaces a login
  // prompt in the popup (task #6) instead of silently showing nothing.
  // Only fetches for providers the user has enabled.
  if (report._source !== "sample") {
    loginPrompts = {};
    if (activeProviders.includes("claude-code")) await applyWebResult("claude-code", () => fetchClaudeQuota());
    if (activeProviders.includes("cursor")) await applyWebResult("cursor", () => fetchCursorUsage());
    if (activeProviders.includes("deepseek")) await applyWebResult("deepseek", () => fetchDeepSeekUsage());
    if (activeProviders.includes("codex")) await applyWebResult("codex", () => fetchCodexQuota());

    // Cache the freshly-fetched quota % so the macOS menu-bar plugin can show it too.
    // Push when we have quota, or when a provider is explicitly logged out (to clear a
    // stale cache); skip on transient total failure so a good cache isn't wiped.
    const quotaNow = report.records.filter((r) => r.metricType === "quota_percent");
    if (quotaNow.length || Object.keys(loginPrompts).length) {
      saveQuotaToHost(report.records, { hostName: settings.hostName });
    }
  }
}

// Run one web connector, merge its records, and track login state. Failures are swallowed
// so one broken source never blocks the others.
async function applyWebResult(provider, fetcher) {
  let result;
  try {
    result = await fetcher();
  } catch {
    return;
  }
  if (!result) return;
  if (result.status === "needs_login") {
    if (result.loginUrl) loginPrompts[provider] = result.loginUrl;
  } else if (result.records?.length) {
    // Web data supersedes the local fallback: when the web source returns token data for
    // this provider, drop the native host's request_count fallback records for it (e.g.
    // Cursor's local sqlite request counts give way to the dashboard's per-model tokens).
    const hasTokens = result.records.some((r) => r.metricType === "measured_tokens");
    const hasQuota = result.records.some((r) => r.metricType === "quota_percent");
    const base = report.records.filter(
      (r) =>
        r.provider !== provider ||
        !(
          (hasTokens && r.metricType === "request_count") ||
          (hasQuota && r.metricType === "quota_percent")
        ),
    );
    report.records = [...base, ...result.records];
  }
  render();
}

document.getElementById("windows").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-window]");
  if (!btn) return;
  currentWindow = btn.dataset.window;
  for (const b of document.querySelectorAll(".windows button")) {
    b.classList.toggle("active", b === btn);
  }
  try { chrome.storage.local.set({ window: currentWindow }); } catch {}
  render();
});

// Login prompts (task #6): open the provider's login page in a new tab.
document.body.addEventListener("click", (e) => {
  const link = e.target.closest(".login-link[data-url]");
  if (!link) return;
  e.preventDefault();
  const url = link.dataset.url;
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, "_blank");
  }
});

// Toggle a provider directly from the popup. Persists to the shared `enabledProviders`
// so Options stays in sync. Re-enabling a web-sourced provider re-fetches its data
// (the initial load skipped it); disabling just hides what's already loaded.
document.getElementById("provider-filter").addEventListener("click", async (e) => {
  const btn = e.target.closest(".provider-pill[data-provider]");
  if (!btn) return;
  const p = btn.dataset.provider;
  const enabled = new Set(activeProviders);
  const enabling = !enabled.has(p);
  if (enabling) enabled.add(p);
  else enabled.delete(p);
  activeProviders = ALL_PROVIDERS.filter((x) => enabled.has(x));
  if (!enabling) delete loginPrompts[p];
  try { await chrome.storage.local.set({ enabledProviders: activeProviders }); } catch {}
  render();
  if (enabling && report && report._source !== "sample") {
    const fetchers = { "claude-code": fetchClaudeQuota, cursor: fetchCursorUsage, deepseek: fetchDeepSeekUsage, codex: fetchCodexQuota };
    if (fetchers[p]) await applyWebResult(p, () => fetchers[p]());
  }
});

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("update-action").addEventListener("click", async () => {
  const settings = await getSettings();
  updateState = { status: "applying" };
  renderUpdateBanner();
  try {
    const result = await applyUpdate({ hostName: settings.hostName, nativeTimeoutMs: 120000 });
    updateState = result.update || {
      status: result.ok ? "applied" : "apply_failed",
      message: result.error || "Update failed.",
    };
    renderUpdateBanner();
    if (result.ok) {
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch {}
      }, 1200);
    }
  } catch (e) {
    updateState = {
      status: "apply_failed",
      message: e instanceof Error ? e.message : String(e),
    };
    renderUpdateBanner();
  }
});
document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  try { chrome.runtime.openOptionsPage(); } catch {}
});
document.body.addEventListener("click", (e) => {
  const link = e.target.closest("#open-options-inline");
  if (!link) return;
  e.preventDefault();
  try { chrome.runtime.openOptionsPage(); } catch {}
});

load();
