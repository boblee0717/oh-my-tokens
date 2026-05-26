import { getUsageReport, DEFAULT_HOST_NAME } from "./usage-client.js";

const PROVIDER_NAMES = {
  "claude-code": "Claude Code",
  codex: "Codex",
  deepseek: "DeepSeek",
};
const PROVIDER_ORDER = ["claude-code", "codex", "deepseek"];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// Escape anything interpolated into innerHTML. Model names, currency codes and
// warnings originate from logs / external APIs, so treat them as untrusted.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function money(n, ccy) {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: ccy || "USD" }).format(n);
  } catch {
    return `${n} ${ccy || ""}`.trim(); // invalid currency code → plain
  }
}

let report = null;
let currentWindow = "7d";

async function getSettings() {
  try {
    const s = await chrome.storage.local.get(["hostName", "window"]);
    return { hostName: s.hostName || DEFAULT_HOST_NAME, window: s.window || "7d" };
  } catch {
    return { hostName: DEFAULT_HOST_NAME, window: "7d" };
  }
}

function distinctWarnings(records) {
  return [...new Set(records.flatMap((r) => r.warnings || []))];
}

function metric(label, value, cls = "") {
  return `<span class="metric ${cls}"><span class="label">${label}</span> <span class="value">${value}</span></span>`;
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

  const inWindow = report.records.filter((r) => r.window === currentWindow);
  // Balance records are point-in-time (window "today"); always show them.
  const balances = report.records.filter((r) => r.metricType === "balance");
  const visible = [...inWindow, ...balances.filter((b) => !inWindow.includes(b))];

  const html = PROVIDER_ORDER.map((p) => {
    const recs = visible.filter((r) => r.provider === p);
    return recs.length ? renderProviderCard(p, recs) : "";
  }).join("");

  cards.innerHTML = html || '<div class="empty">No usage in this window.</div>';
  const when = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "";
  status.textContent = `${report._source === "sample" ? "sample" : "updated"} ${when}`;
}

async function load() {
  const settings = await getSettings();
  currentWindow = settings.window;
  for (const b of document.querySelectorAll(".windows button")) {
    b.classList.toggle("active", b.dataset.window === currentWindow);
  }
  report = null;
  render();
  report = await getUsageReport({ hostName: settings.hostName });
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

document.getElementById("refresh").addEventListener("click", load);
document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  try { chrome.runtime.openOptionsPage(); } catch {}
});

load();
