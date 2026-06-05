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
// 10-cell unicode bar for a 0–100 percentage (menu menus can't draw real bars).
function bar(n) {
  const filled = Math.round(Math.max(0, Math.min(100, Number(n) || 0)) / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}
// Accent/dim colors adapt to the system appearance (the plugin passes OMT_APPEARANCE) so
// they stay legible in both light and dark menus. Plain (unset) text already adapts.
const DARK = process.env.OMT_APPEARANCE === "dark";
const COL = {
  dim: DARK ? "#9aa0a6" : "#6b6b6b",
  warn: DARK ? "#e6b450" : "#9a6a1a",
  high: DARK ? "#ff8a72" : "#c0392b",
};
function pctColor(n) {
  n = Number(n) || 0;
  return n >= 80 ? ` color=${COL.high}` : n >= 50 ? ` color=${COL.warn}` : "";
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
  const sameDay = d.toDateString() === now.toDateString();
  const when = sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
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
  line(`oh-my-tokens · today | size=11 color=${COL.dim}`);

  // ----- plan usage % (login-gated; from the popup-written quota cache) -----
  const quota = readQuotaCache();
  if (quota.records.length) {
    line("---");
    line(`Plan usage | size=11 color=${COL.dim}`);
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
      line(`${PROVIDER_LABEL[p] || p}${meta ? ` · ${meta}` : ""} | size=12 color=${COL.dim}`);
      const width = Math.max(...recs.map((q) => (q.windowLabel || "usage").length));
      for (const q of recs) {
        const n = Number(q.usedPercent) || 0;
        const label = (q.windowLabel || "usage").padEnd(width);
        const reset = formatReset(q.resetsAt);
        line(`${label}  ${bar(n)} ${pctStr(n)}%${reset ? ` · ${reset}` : ""} | font=Menlo size=13${pctColor(n)}`);
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
    line(`${PROVIDER_LABEL[p] || p}${provCost > 0 ? ` · ${money(provCost)} today` : ""} | size=12 color=${COL.dim}`);

    const bal = pr.find((r) => r.metricType === "balance");
    if (bal) line(`Balance: ${abbr(bal.balance)} ${bal.currency || ""} | font=Menlo size=12`);

    const today = pr.filter((r) => r.window === "today");
    const models = [...new Set(today.map((r) => r.model).filter(Boolean))];
    if (!models.length && !bal) line(`no activity today | size=11 color=${COL.dim}`);
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
      line(`${m}  ${parts.join(" · ")} | font=Menlo size=12`);
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
    if (roll.length) line(`${roll.join("    ")} | font=Menlo size=11 color=${COL.dim}`);
  }

  // ----- footer -----
  line("---");
  if (anyEstimated) {
    line(`⚠︎ costs are estimated, not billing | size=11 color=${COL.warn}`);
  }
  if (errs.length) {
    line(`⚠ ${errs.length} source error(s) | color=${COL.high} size=11`);
    for (const e of errs) line(`--${e.provider}: ${String(e.message).slice(0, 100)} | font=Menlo size=11`);
  }
  const gen = report.generatedAt ? report.generatedAt.replace("T", " ").slice(0, 16) + " UTC" : "";
  line(`Updated ${gen} | size=11 color=${COL.dim}`);
  line("Refresh | refresh=true sfimage=arrow.clockwise");

  process.stdout.write(out.join("\n") + "\n");
})();
