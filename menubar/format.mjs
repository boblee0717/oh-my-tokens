#!/usr/bin/env node
// oh-my-tokens menu-bar formatter.
// Reads the native-host usage report (JSON) on stdin and prints SwiftBar/xbar
// plugin output on stdout. No new data logic — it just renders host/index.js,
// plus the login-gated quota % from the host's quota cache (written by the popup).
//
// SwiftBar format: the first line is the menu-bar title; everything after the
// first `---` is the dropdown. `--` nests a submenu. `| key=val` sets params.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROVIDER_LABEL = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  deepseek: "DeepSeek",
};
const PROVIDER_ORDER = ["claude-code", "codex", "cursor", "deepseek"];

function abbr(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function money(n) {
  n = Number(n) || 0;
  return n >= 100 ? "$" + n.toFixed(0) : "$" + n.toFixed(2);
}
function pctStr(n) {
  n = Math.max(0, Math.min(100, Number(n) || 0));
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
// 8-cell unicode bar for a 0–100 percentage (menu menus can't draw real bars).
// Keep it short: in macOS menus, dense bars read more like noise than signal.
function bar(n) {
  const filled = Math.round(Math.max(0, Math.min(100, Number(n) || 0)) / 12.5);
  return "▰".repeat(filled) + "▱".repeat(8 - filled);
}
// System-inspired colors as SwiftBar adaptive "light,dark" pairs: the menu re-tints
// live when the system appearance changes, so a render from a minute ago (or an Auto
// appearance flip) can never show dark-mode text on a light menu. Apple-semantic-ish:
// high contrast primary, calm secondary, status colors only where they carry meaning.
// Menus are vibrancy-translucent, so light-mode status colors run darker than the
// usual system palette — pale tints lose contrast against whatever bleeds through.
const COL = {
  primary: "#1d1d1f,#f5f5f7",
  dim: "#56565b,#a1a1aa",
  muted: "#6e6e73,#98989d",
  warn: "#7a4f00,#ffd60a",
  high: "#b3261e,#ff453a",
};
const item = ({ color = COL.primary, size = 12, font = "" } = {}) =>
  `${font ? ` font=${font}` : ""} size=${size} color=${color}`;
// Color carries meaning only when something needs attention; healthy rows stay in
// primary text (the ▰▱ bar already shows the level) so the menu isn't a wall of tint.
function pctColor(n) {
  n = Number(n) || 0;
  return n >= 80 ? COL.high : n >= 50 ? COL.warn : COL.primary;
}
// Login-gated quota % is written to a cache by the popup (the host can't fetch it).
function readQuotaCache() {
  try {
    const p = process.env.OMT_QUOTA_CACHE || join(homedir(), ".oh-my-tokens", "quota-cache.json");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { savedAt: parsed?.savedAt ?? null, records: Array.isArray(parsed?.records) ? parsed.records : [] };
  } catch {
    return { savedAt: null, records: [] };
  }
}
// Standalone web-fetched token/cost usage (currently Cursor), written by refresh-quota.js.
function readUsageCache() {
  try {
    const p = process.env.OMT_USAGE_CACHE || join(homedir(), ".oh-my-tokens", "usage-cache.json");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed?.records) ? parsed.records : [];
  } catch {
    return [];
  }
}
function ageStr(savedAt) {
  if (!savedAt) return "";
  const ms = Date.now() - new Date(savedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
function formatReset(resetsAt) {
  if (!resetsAt) return "";
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  // Cross-day: compact numeric date + time (locale-stable), e.g. "6/15 00:39".
  const when = sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return `resets ${when}`;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  });
}

const out = [];
const line = (s = "") => out.push(s);

(async () => {
  let report;
  try {
    report = JSON.parse(await readStdin());
  } catch (e) {
    line(`⚠️ oh-my-tokens | sfimage=exclamationmark.triangle color=${COL.high}`);
    line("---");
    line(`Host returned no/invalid data | color=${COL.dim}`);
    line(`${String(e).slice(0, 120)} | font=Menlo size=11 color=${COL.dim}`);
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  let recs = Array.isArray(report.records) ? report.records : [];
  const errs = Array.isArray(report.errors) ? report.errors : [];

  // Merge standalone Cursor usage (real tokens + estimated cost the host fetched from
  // cursor.com), replacing the local request-count-only records so Cursor shows tokens +
  // cost and contributes to the headline total.
  const cursorUsage = readUsageCache().filter((r) => r.provider === "cursor");
  if (cursorUsage.length) recs = recs.filter((r) => r.provider !== "cursor").concat(cursorUsage);

  // ----- menu-bar headline: today's estimated cost, else today's tokens -----
  const todayCost = recs
    .filter((r) => r.window === "today" && r.metricType === "estimated_cost")
    .reduce((s, r) => s + (Number(r.costUSD) || 0), 0);
  const todayTokens = recs
    .filter((r) => r.window === "today" && r.metricType === "measured_tokens")
    .reduce(
      (s, r) =>
        s + (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0) + (Number(r.cacheTokens) || 0),
      0
    );
  const headline =
    todayCost > 0 ? money(todayCost) : todayTokens > 0 ? abbr(todayTokens) + " tok" : "—";
  line(`🎫 ${headline} | sfimage=ticket`);
  line("---");
  line(`oh-my-tokens · today |${item({ color: COL.dim, size: 11 })}`);

  // ----- plan usage % (login-gated; from the popup-written quota cache) -----
  const quota = readQuotaCache();
  if (quota.records.length) {
    line("---");
    line(`PLAN USAGE |${item({ color: COL.muted, size: 10 })}`);
    const byProv = {};
    for (const q of quota.records) (byProv[q.provider] ??= []).push(q);
    for (const p of PROVIDER_ORDER) {
      if (!byProv[p]) continue;
      const recs = byProv[p];
      const plan = recs.find((q) => q.planType)?.planType;
      // Per-provider freshness: Cursor refreshes standalone every minute; Claude/Codex
      // only update while Chrome is open, so a single global timestamp would mislead.
      const newest = Math.max(...recs.map((q) => Date.parse(q.updatedAt) || 0));
      const age = newest ? ageStr(new Date(newest).toISOString()) : "";
      const stale = newest && Date.now() - newest > 24 * 3600e3;
      const meta = [plan, age && `${age}${stale ? " (stale)" : ""}`].filter(Boolean).join(" · ");
      // Quota rows are rendered at the TOP level (no `--`) so they're visible the moment
      // the dropdown opens — one glance, no submenu drill-down.
      line(`▸ ${PROVIDER_LABEL[p] || p}${meta ? ` · ${meta}` : ""} |${item({ color: COL.primary, size: 12 })}`);
      const width = Math.max(...recs.map((q) => (q.windowLabel || "usage").length));
      for (const q of recs) {
        const n = Number(q.usedPercent) || 0;
        const label = (q.windowLabel || "usage").padEnd(width);
        const reset = formatReset(q.resetsAt);
        const pct = `${pctStr(n)}%`.padStart(6);
        line(`${label} ${pct}  ${bar(n)}${reset ? `  ${reset}` : ""} |${item({ color: pctColor(n), size: 12, font: "Menlo" })}`);
      }
    }
  }

  // ----- usage by provider/model (today), rendered FLAT (top level, one step) -----
  let anyEstimated = false;
  const present = PROVIDER_ORDER.filter((p) => recs.some((r) => r.provider === p));
  for (const p of present) {
    const pr = recs.filter((r) => r.provider === p);
    const provCost = pr
      .filter((r) => r.window === "today" && r.metricType === "estimated_cost")
      .reduce((s, r) => s + (Number(r.costUSD) || 0), 0);
    line("---");
    line(`${PROVIDER_LABEL[p] || p}${provCost > 0 ? ` · ${money(provCost)} today` : ""} |${item({ color: COL.primary, size: 12 })}`);

    const bal = pr.find((r) => r.metricType === "balance");
    if (bal) line(`Balance  ${abbr(bal.balance)} ${bal.currency || ""} |${item({ color: COL.primary, size: 12, font: "Menlo" })}`);

    const today = pr.filter((r) => r.window === "today");
    const models = [...new Set(today.map((r) => r.model).filter(Boolean))];
    if (!models.length && !bal) line(`no activity today |${item({ color: COL.dim, size: 11 })}`);
    for (const m of models) {
      const mt = today.filter((r) => r.model === m);
      const tok = mt.find((r) => r.metricType === "measured_tokens");
      const cost = mt.find((r) => r.metricType === "estimated_cost");
      const reqs = tok?.requests ?? mt.find((r) => r.metricType === "request_count")?.requests ?? 0;
      const parts = [`${reqs} req`];
      if (cost) {
        parts.push(money(cost.costUSD));
        if (cost.confidence === "low") anyEstimated = true;
      }
      if (tok) parts.push(`${abbr((tok.inputTokens || 0) + (tok.outputTokens || 0) + (tok.cacheTokens || 0))} tok`);
      line(`${m}  ${parts.join(" · ")} |${item({ color: COL.primary, size: 12, font: "Menlo" })}`);
    }

    // 7d / 30d rollup on a single compact top-level line.
    const roll = [];
    for (const w of ["7d", "30d"]) {
      const wr = pr.filter((r) => r.window === w);
      if (!wr.length) continue;
      const wcost = wr
        .filter((r) => r.metricType === "estimated_cost")
        .reduce((s, r) => s + (Number(r.costUSD) || 0), 0);
      const wreq = wr
        .filter((r) => r.metricType === "measured_tokens" || r.metricType === "request_count")
        .reduce((s, r) => s + (Number(r.requests) || 0), 0);
      roll.push(`${w} ${wcost > 0 ? money(wcost) + " · " : ""}${wreq} req`);
    }
    if (roll.length) line(`${roll.join("    ")} |${item({ color: COL.dim, size: 11, font: "Menlo" })}`);
  }

  // ----- footer -----
  line("---");
  if (anyEstimated) {
    line(`⚠︎ costs are estimated, not billing |${item({ color: COL.warn, size: 11 })}`);
  }
  if (errs.length) {
    line(`⚠ ${errs.length} source error(s) |${item({ color: COL.high, size: 11 })}`);
    for (const e of errs) line(`--${e.provider}: ${String(e.message).slice(0, 100)} |${item({ color: COL.dim, size: 11, font: "Menlo" })}`);
  }
  // Show the update time in the user's LOCAL timezone (like the reset times), not UTC.
  const gd = report.generatedAt ? new Date(report.generatedAt) : null;
  const gen = gd && !Number.isNaN(gd.getTime())
    ? gd.toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      })
    : "";
  line(`Updated ${gen} |${item({ color: COL.dim, size: 11 })}`);
  line("Refresh | refresh=true sfimage=arrow.clockwise");

  process.stdout.write(out.join("\n") + "\n");
})();
