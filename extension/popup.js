import { getUsageReport, DEFAULT_HOST_NAME } from "./usage-client.js";
import { fetchClaudeQuota } from "./claude-web.js";

const PROVIDER_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  deepseek: "DeepSeek",
};
const PROVIDER_ORDER = ["claude-code", "codex", "deepseek"];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Escape anything interpolated into innerHTML; model names / currencies / warnings
// originate from logs or external APIs, so treat them as untrusted.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function money(n, ccy) {
  try {
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
  const sameDay = d.toDateString() === now.toDateString();
  const when = sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `resets ${when}`;
}

let report = null;
let currentWindow = "7d";

async function getSettings() {
  try {
    const s = await chrome.storage.local.get(["hostName", "window", "deepseekApiKey"]);
    return {
      hostName: s.hostName || DEFAULT_HOST_NAME,
      window: s.window || "7d",
      deepseekApiKey: s.deepseekApiKey || "",
    };
  } catch {
    return { hostName: DEFAULT_HOST_NAME, window: "7d", deepseekApiKey: "" };
  }
}

function metric(label, value, cls = "") {
  return `<span class="metric ${cls}"><span class="label">${label}</span> <span class="value">${value}</span></span>`;
}

function quotaRowsHtml(records) {
  return records
    .map((q) => {
      const pct = Math.max(0, Math.min(100, Number(q.usedPercent) || 0));
      const cls = pct >= 80 ? "high" : pct >= 50 ? "warn" : "";
      const reset = formatReset(q.resetsAt);
      return `<div class="quota-row">
        <div class="top">
          <span class="label">${esc(q.windowLabel || "")}</span>
          <span class="pct">${pct}%</span>
        </div>
        <div class="bar ${cls}"><span style="width:${pct}%"></span></div>
        ${reset ? `<div class="reset">${esc(reset)}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderQuota() {
  const section = document.getElementById("quota-section");
  const box = document.getElementById("quota");
  const quota = (report?.records || []).filter((r) => r.metricType === "quota_percent");
  if (!quota.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  // One block per provider (Codex, Claude Code) so windows don't get mixed up.
  const html = PROVIDER_ORDER.map((p) => {
    const recs = quota.filter((q) => q.provider === p);
    if (!recs.length) return "";
    const plan = recs.find((q) => q.planType)?.planType;
    const note = distinctWarnings(recs)[0]; // e.g. "account-level plan usage…"
    return `<div class="quota-group">
      <div class="quota-provider">${esc(PROVIDER_NAMES[p] || p)}${plan ? `<span class="plan">${esc(plan)}</span>` : ""}</div>
      ${quotaRowsHtml(recs)}
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
  const costs = records.filter((r) => r.metricType === "estimated_cost");
  const balances = records.filter((r) => r.metricType === "balance");

  let rows = "";
  for (const m of measured) {
    const cost = costs.find((c) => c.model === m.model);
    const parts = [
      metric("in", compact.format(m.inputTokens)),
      metric("out", compact.format(m.outputTokens)),
      metric("cache", compact.format(m.cacheTokens)),
    ];
    if (cost) parts.push(metric("cost", esc(money(cost.costUSD, cost.currency)), "cost"));
    rows += `<div class="model-row"><div class="model-name">${esc(m.model)}</div><div class="metrics">${parts.join("")}</div></div>`;
  }
  for (const b of balances) {
    rows += `<div class="model-row"><div class="metrics">${metric("balance", esc(money(b.balance, b.currency)), "balance")}</div></div>`;
  }

  const reqTotal = measured.reduce((s, r) => s + (r.requests || 0), 0);
  const meta = measured.length ? `${compact.format(reqTotal)} req` : "";
  const warns = distinctWarnings(records);
  const warnHtml = warns.length
    ? `<div class="warn-note" title="${warns.map(esc).join("&#10;")}">⚠ ${warns.length} note${warns.length > 1 ? "s" : ""}</div>`
    : "";

  return `<section class="card"><h2>${esc(PROVIDER_NAMES[provider] || provider)}<span class="provider-meta">${meta}</span></h2>${rows || '<div class="model-name">no data</div>'}${warnHtml}</section>`;
}

function render() {
  const cards = document.getElementById("cards");
  const status = document.getElementById("status");
  const banner = document.getElementById("preview-banner");
  if (!report) {
    cards.innerHTML = '<div class="empty">Loading…</div>';
    return;
  }
  banner.classList.toggle("hidden", report._source !== "sample");
  renderQuota();

  // Token cards filtered to the selected window (quota/balance are shown elsewhere/always).
  const tokenRecords = report.records.filter(
    (r) => r.window === currentWindow && r.metricType !== "quota_percent",
  );
  const balances = report.records.filter((r) => r.metricType === "balance");
  const visible = [...tokenRecords, ...balances.filter((b) => !tokenRecords.includes(b))];

  const html = PROVIDER_ORDER.map((p) => {
    const recs = visible.filter((r) => r.provider === p);
    return recs.length ? renderProviderCard(p, recs) : "";
  }).join("");
  cards.innerHTML = html || '<div class="empty">No usage in this window.</div>';

  const when = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "";
  status.textContent = `${report._source === "sample" ? "sample" : "updated"} ${when}`;
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
  render();

  // Claude account-level quota % comes from claude.ai (not local logs); merge it in.
  // Skipped in sample/preview mode so we don't mix mock + live data.
  if (report._source !== "sample") {
    try {
      const claudeQuota = await fetchClaudeQuota();
      if (claudeQuota.length) {
        report.records = [...report.records, ...claudeQuota];
        render();
      }
    } catch {}
  }
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

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  try { chrome.runtime.openOptionsPage(); } catch {}
});

load();
