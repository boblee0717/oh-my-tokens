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
function pctColor(n) {
  n = Number(n) || 0;
  return n >= 80 ? " color=#e07a5f" : n >= 50 ? " color=#c08a3e" : "";
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
    line("⚠️ oh-my-tokens | sfimage=exclamationmark.triangle color=#e07a5f");
    line("---");
    line("Host returned no/invalid data | color=#888");
    line(`${String(e).slice(0, 120)} | font=Menlo size=11 color=#888`);
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  const recs = Array.isArray(report.records) ? report.records : [];
  const errs = Array.isArray(report.errors) ? report.errors : [];

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
  line(`oh-my-tokens · today | size=11 color=#888`);

  // ----- plan usage % (login-gated; from the popup-written quota cache) -----
  const quota = readQuotaCache();
  if (quota.records.length) {
    const age = ageStr(quota.savedAt);
    const stale = quota.savedAt && Date.now() - new Date(quota.savedAt).getTime() > 24 * 3600e3;
    line("---");
    line(`Plan usage${age ? ` · ${age}${stale ? " (stale)" : ""}` : ""} | size=11 color=#888`);
    const byProv = {};
    for (const q of quota.records) (byProv[q.provider] ??= []).push(q);
    for (const p of PROVIDER_ORDER) {
      if (!byProv[p]) continue;
      const plan = byProv[p].find((q) => q.planType)?.planType;
      line(`${PROVIDER_LABEL[p] || p}${plan ? ` · ${plan}` : ""}`);
      for (const q of byProv[p]) {
        const n = Number(q.usedPercent) || 0;
        line(`--${q.windowLabel || "usage"}  ${bar(n)}  ${pctStr(n)}% | font=Menlo size=12${pctColor(n)}`);
      }
    }
  }

  // ----- group by provider, then model, for the "today" window -----
  const present = PROVIDER_ORDER.filter((p) => recs.some((r) => r.provider === p));
  for (const p of present) {
    const pr = recs.filter((r) => r.provider === p);
    line("---");
    line(`${PROVIDER_LABEL[p] || p}`);
    // Some providers (Cursor) only expose request counts, not token totals.
    const tokenless = pr.length > 0 && pr.every((r) => r.metricType !== "measured_tokens");
    if (tokenless && pr.some((r) => r.metricType === "request_count")) {
      line(`--request counts only — not tokens | size=11 color=#888`);
    }

    // balance (e.g. Codex credits, DeepSeek)
    const bal = pr.find((r) => r.metricType === "balance");
    if (bal) {
      line(`--Balance: ${abbr(bal.balance)} ${bal.currency || ""} | font=Menlo size=12`);
    }

    // today rows per model
    const today = pr.filter((r) => r.window === "today");
    const models = [...new Set(today.map((r) => r.model).filter(Boolean))];
    if (models.length === 0 && !bal) {
      line(`--no activity today | color=#888 size=11`);
    }
    for (const m of models) {
      const mt = today.filter((r) => r.model === m);
      const tok = mt.find((r) => r.metricType === "measured_tokens");
      const cost = mt.find((r) => r.metricType === "estimated_cost");
      const reqRow = mt.find((r) => r.metricType === "request_count");
      const reqs = tok?.requests ?? reqRow?.requests ?? 0;
      const parts = [`${reqs} req`];
      if (cost) parts.push(money(cost.costUSD));
      line(`--${m} · ${parts.join(" · ")} | font=Menlo size=12`);
      if (tok) {
        line(
          `----in ${abbr(tok.inputTokens)} · out ${abbr(tok.outputTokens)} · cache ${abbr(
            tok.cacheTokens
          )} | font=Menlo size=11 color=#888`
        );
      }
      if (cost?.confidence === "low") {
        line(`----⚠︎ cost is estimated, not billing | size=11 color=#c08a3e`);
      }
    }

    // 7d / 30d rollup in a submenu
    for (const w of ["7d", "30d"]) {
      const wr = pr.filter((r) => r.window === w);
      if (!wr.length) continue;
      const wcost = wr
        .filter((r) => r.metricType === "estimated_cost")
        .reduce((s, r) => s + (Number(r.costUSD) || 0), 0);
      const wreq = wr
        .filter((r) => r.metricType === "measured_tokens" || r.metricType === "request_count")
        .reduce((s, r) => s + (Number(r.requests) || 0), 0);
      const summ = wcost > 0 ? `${money(wcost)} · ${wreq} req` : `${wreq} req`;
      line(`--${w}: ${summ} | font=Menlo size=11 color=#888`);
    }
  }

  // ----- footer -----
  line("---");
  if (errs.length) {
    line(`⚠ ${errs.length} source error(s) | color=#e07a5f size=11`);
    for (const e of errs) line(`--${e.provider}: ${String(e.message).slice(0, 100)} | font=Menlo size=11`);
  }
  const gen = report.generatedAt ? report.generatedAt.replace("T", " ").slice(0, 16) + " UTC" : "";
  line(`Updated ${gen} | size=11 color=#888`);
  line("Refresh | refresh=true sfimage=arrow.clockwise");

  process.stdout.write(out.join("\n") + "\n");
})();
