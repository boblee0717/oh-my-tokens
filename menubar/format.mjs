#!/usr/bin/env node
// oh-my-tokens menu-bar formatter.
// Reads the native-host usage report (JSON) on stdin and prints SwiftBar/xbar
// plugin output on stdout. It renders host/index.js, merges cached quota %, and
// appends privacy-safe aggregate samples for quota-vs-token slope analysis.
//
// SwiftBar format: the first line is the menu-bar title; everything after the
// first `---` is the dropdown. `--` nests a submenu. `| key=val` sets params.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const PROVIDER_LABEL = {
  "claude-code": "Claude Code",
  codex: "Codex",
  traex: "TraeX",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  kimi: "Kimi Code",
};
const PROVIDER_ORDER = ["claude-code", "codex", "traex", "cursor", "deepseek", "kimi"];

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

// ----- menu-bar title: classic 🎫 cost/tokens headline by default; an opt-in
// "buckets" style draws one independent bucket per quota window, visually grouped
// by provider and filled with the REMAINING capacity (100 - usedPercent). Switchable
// from the dropdown (persisted in menubar-prefs.json) or OMT_TITLE_STYLE.


// Minimal PNG encoder (8-bit RGBA, filter "none") — no deps, so the formatter can
// draw the buckets image itself. SwiftBar's templateImage only uses the alpha
// channel, so we emit pure alpha "ink" and macOS re-tints it for light/dark menus.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// 3x5 bitmap font for the corner badges (one 3-bit row per entry, MSB = left). Digits +
// "%" + the full uppercase alphabet, so a provider id we haven't seen yet still renders
// (lowercase is out — 3x5 has no room for descenders like "p"). At this size a few pairs
// need deliberate asymmetry to stay apart: M is top-heavy vs W bottom-heavy, and N keeps
// only the top diagonal so it doesn't collide with either.
const GLYPHS = {
  "0": [7, 5, 5, 5, 7],
  "1": [2, 6, 2, 2, 7],
  "2": [7, 1, 7, 4, 7],
  "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7],
  "6": [7, 4, 7, 5, 7],
  "7": [7, 1, 2, 2, 2],
  "8": [7, 5, 7, 5, 7],
  "9": [7, 5, 7, 1, 7],
  "%": [5, 1, 2, 4, 5],
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [3, 4, 4, 4, 3],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3],
  H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [5, 7, 5, 5, 5],
  O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 5, 3],
  R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
};
const PROVIDER_SHORT = { "claude-code": "claude" };
function providerShort(p) {
  // Drop anything the font can't draw: an unrenderable char would still reserve badge
  // width and then leave a hole (a provider id with a digit or letter is unaffected).
  return [...(PROVIDER_SHORT[p] || p).toUpperCase()].filter((ch) => GLYPHS[ch]).join("");
}

function normalizedWindowLabel(label) {
  return String(label || "").trim().toLowerCase();
}

// A provider group contains one small bucket per quota window (shortest window first).
// Every bucket keeps its own remaining-% badge, while the provider short name is
// centred once below the group.
function bucketsPng(buckets) {
  const BUCKET_W = 9, BUCKET_H = 11, BUCKET_Y = 3;
  const WINDOW_GAP = 3, GROUP_GAP = 7, NAME_Y = 15, HEIGHT = 20;
  const textW = (t) => (t.length ? t.length * 4 - 1 : 0);
  // ---- layout ----
  const laid = [];
  const badges = []; // { text, left, top }
  let x = 0;
  for (const b of buckets) {
    const name = providerShort(b.provider);
    const percentages = b.windows.map((w) => `${Math.round(w.remaining)}%`);
    const windowsW = percentages.reduce(
      (width, pct) => width + BUCKET_W - 3 + textW(pct) + WINDOW_GAP,
      0,
    ) - WINDOW_GAP;
    const groupW = Math.max(windowsW, textW(name));
    let bucketX = x + Math.floor((groupW - windowsW) / 2);
    let chamberX = bucketX;
    b.windows.forEach((window, i) => {
      const pct = percentages[i];
      laid.push({ window, x: chamberX });
      badges.push({ text: pct, left: chamberX + BUCKET_W - 3, top: 0 });
      chamberX += BUCKET_W - 3 + textW(pct) + WINDOW_GAP;
    });
    if (name) badges.push({ text: name, left: x + Math.floor((groupW - textW(name)) / 2), top: NAME_Y });
    x += groupW + GROUP_GAP;
  }
  const width = x - GROUP_GAP;
  const px = new Uint8Array(width * HEIGHT * 4);
  const ink = (xx, yy) => {
    if (xx >= 0 && xx < width && yy >= 0 && yy < HEIGHT) px[(yy * width + xx) * 4 + 3] = 255;
  };
  const erase = (xx, yy) => {
    if (xx >= 0 && xx < width && yy >= 0 && yy < HEIGHT) px[(yy * width + xx) * 4 + 3] = 0;
  };
  const drawText = ({ text, left, top }) => {
    for (let yy = top - 1; yy <= top + 5; yy++)
      for (let xx = left - 1; xx <= left + textW(text); xx++) erase(xx, yy);
    [...text].forEach((ch, ci) => {
      const g = GLYPHS[ch];
      if (!g) return;
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 3; c++) if (g[r] & (4 >> c)) ink(left + ci * 4 + c, top + r);
    });
  };
  // ---- draw ----
  for (const { window, x: x0 } of laid) {
    for (let xx = 0; xx < BUCKET_W; xx++) {
      ink(x0 + xx, BUCKET_Y);
      ink(x0 + xx, BUCKET_Y + BUCKET_H - 1);
    }
    for (let yy = 0; yy < BUCKET_H; yy++) {
      ink(x0, BUCKET_Y + yy);
      ink(x0 + BUCKET_W - 1, BUCKET_Y + yy);
    }
    const innerH = BUCKET_H - 2;
    const fill = Math.round((Math.max(0, Math.min(100, Number(window.remaining) || 0)) / 100) * innerH);
    for (let f = 0; f < fill; f++) {
      const yy = BUCKET_Y + BUCKET_H - 2 - f;
      for (let xx = 1; xx < BUCKET_W - 1; xx++) ink(x0 + xx, yy);
    }
  }
  for (const bd of badges) drawText(bd);
  return encodePng(width, HEIGHT, px);
}

function menubarPrefsPath() {
  return process.env.OMT_MENUBAR_PREFS || join(homedir(), ".oh-my-tokens", "menubar-prefs.json");
}
function hiddenProviders() {
  try {
    const hidden = JSON.parse(readFileSync(menubarPrefsPath(), "utf8"))?.hiddenProviders;
    return new Set(Array.isArray(hidden) ? hidden : []);
  } catch {
    return new Set();
  }
}
function titleStyle() {
  let s = process.env.OMT_TITLE_STYLE;
  if (!s) {
    try {
      s = JSON.parse(readFileSync(menubarPrefsPath(), "utf8"))?.titleStyle;
    } catch {
    }
  }
  s = String(s || "classic").toLowerCase();
  return ["png", "classic"].includes(s) ? s : "classic";
}
// Approximate window duration in minutes, for ordering a provider's buckets
// short-window-first (5h before weekly). Unknown labels sort last (stable).
function windowRank(label) {
  const s = normalizedWindowLabel(label);
  if (s.startsWith("weekly")) return 10080;
  if (s.startsWith("plan")) return 20000;
  if (s.startsWith("api")) return 20001;
  const m = /^(\d+)\s*([mhdw])/.exec(s);
  if (!m) return Number.POSITIVE_INFINITY;
  return Number(m[1]) * { m: 1, h: 60, d: 1440, w: 10080 }[m[2]];
}
// One visual group per provider (provider order, shortest window first within each
// group), with at most eight buckets total. Every visible provider gets one bucket
// before second windows are added, so early providers cannot crowd later ones out.
function quotaBuckets(quotaRecords) {
  const byProv = {};
  for (const q of quotaRecords) (byProv[q.provider] ??= []).push(q);
  // Known providers in the canonical order, then anything else the cache holds — a
  // provider written by a newer extension than this formatter still gets a bucket
  // instead of disappearing from the title.
  const order = [...PROVIDER_ORDER, ...Object.keys(byProv).filter((p) => !PROVIDER_ORDER.includes(p))];
  const groups = [];
  for (const p of order) {
    const windows = [];
    for (const q of byProv[p] || []) {
      const used = Number(q.usedPercent);
      if (!Number.isFinite(used)) continue;
      windows.push({
        label: q.windowLabel || q.model || "usage",
        remaining: 100 - Math.max(0, Math.min(100, used)),
      });
    }
    windows.sort((a, b) => windowRank(a.label) - windowRank(b.label));
    if (windows.length) groups.push({ provider: p, windows });
  }
  const visible = groups.slice(0, 8);
  const buckets = visible.map((g) => ({ provider: g.provider, windows: [g.windows[0]] }));
  let windowCount = buckets.length;
  for (let windowIndex = 1; windowCount < 8; windowIndex++) {
    let added = false;
    for (let i = 0; i < visible.length && windowCount < 8; i++) {
      const window = visible[i].windows[windowIndex];
      if (!window) continue;
      buckets[i].windows.push(window);
      windowCount++;
      added = true;
    }
    if (!added) break;
  }
  return buckets;
}
function renderTitleLine(headline, buckets, style) {
  if (!buckets.length || style === "classic") return `🎫 ${headline} | sfimage=ticket`;
  // Remaining percentages live in the image, so the title is image-only.
  const b64 = bucketsPng(buckets).toString("base64");
  return ` | templateImage=${b64}`;
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
// Login-gated quota % is written to a cache by the popup; local host quota records
// such as Codex rate_limits can still be fresher and are merged below.
function readQuotaCache() {
  try {
    const p = process.env.OMT_QUOTA_CACHE || join(homedir(), ".oh-my-tokens", "quota-cache.json");
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { savedAt: parsed?.savedAt ?? null, records: Array.isArray(parsed?.records) ? parsed.records : [] };
  } catch {
    return { savedAt: null, records: [] };
  }
}
function quotaRecordTime(q, fallback = 0) {
  const t = Date.parse(q?.updatedAt ?? "");
  return Number.isNaN(t) ? fallback : t;
}
function quotaRecordKey(q) {
  return q?.id || [q?.provider, q?.model ?? "", q?.windowLabel ?? ""].join(":");
}
function mergeQuotaRecords(cache, reportRecords) {
  const cacheFallback = Date.parse(cache.savedAt ?? "");
  const cacheTime = Number.isNaN(cacheFallback) ? 0 : cacheFallback;
  const byKey = new Map();
  const add = (q, fallback = 0) => {
    if (!q || q.metricType !== "quota_percent" || !q.provider) return;
    const key = quotaRecordKey(q);
    const t = quotaRecordTime(q, fallback);
    const prev = byKey.get(key);
    if (!prev || t >= prev.t) byKey.set(key, { q, t });
  };
  for (const q of cache.records) add(q, cacheTime);
  for (const q of reportRecords) add(q);
  return [...byKey.values()].map((x) => x.q);
}
function quotaSamplePath() {
  return process.env.OMT_QUOTA_SAMPLE_LOG || join(homedir(), ".oh-my-tokens", "quota-samples.jsonl");
}
function groupedTodayUsage(records, provider) {
  const measured = records.filter(
    (r) => r.provider === provider && r.window === "today" && r.metricType === "measured_tokens",
  );
  const costs = records.filter(
    (r) => r.provider === provider && r.window === "today" && r.metricType === "estimated_cost",
  );
  const models = measured.map((r) => {
    const inputTokens = Number(r.inputTokens) || 0;
    const outputTokens = Number(r.outputTokens) || 0;
    const cacheTokens = Number(r.cacheTokens) || 0;
    return {
      model: r.model || null,
      requests: Number(r.requests) || 0,
      inputTokens,
      outputTokens,
      cacheTokens,
      totalTokens: inputTokens + outputTokens + cacheTokens,
    };
  });
  return {
    requests: models.reduce((s, r) => s + r.requests, 0),
    inputTokens: models.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: models.reduce((s, r) => s + r.outputTokens, 0),
    cacheTokens: models.reduce((s, r) => s + r.cacheTokens, 0),
    totalTokens: models.reduce((s, r) => s + r.totalTokens, 0),
    estimatedCostUSD: Math.round(costs.reduce((s, r) => s + (Number(r.costUSD) || 0), 0) * 1e6) / 1e6,
    models,
  };
}
function writeQuotaSamples(report, records, quotaRecords) {
  if (process.env.OMT_DISABLE_QUOTA_SAMPLING === "1") return;
  const sampledAt = report.generatedAt || new Date().toISOString();
  const lines = [];
  for (const provider of PROVIDER_ORDER) {
    const providerQuota = quotaRecords.filter((q) => q.provider === provider);
    const today = groupedTodayUsage(records, provider);
    if (!providerQuota.length && !today.totalTokens && !today.requests) continue;
    const quota = {};
    for (const q of providerQuota) {
      const label = q.windowLabel || "usage";
      quota[label] = {
        usedPercent: Number(q.usedPercent) || 0,
        resetsAt: q.resetsAt || null,
        source: q.source || null,
        updatedAt: q.updatedAt || null,
      };
    }
    lines.push(JSON.stringify({
      sampledAt,
      provider,
      planType: providerQuota.find((q) => q.planType)?.planType || null,
      quota,
      today: {
        requests: today.requests,
        inputTokens: today.inputTokens,
        outputTokens: today.outputTokens,
        cacheTokens: today.cacheTokens,
        totalTokens: today.totalTokens,
        estimatedCostUSD: today.estimatedCostUSD,
      },
      models: today.models,
    }));
  }
  if (!lines.length) return;
  try {
    const p = quotaSamplePath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, lines.join("\n") + "\n", "utf8");
  } catch {
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
function updateScriptPath() {
  return process.env.OMT_UPDATE_SCRIPT || join(homedir(), ".oh-my-tokens", "native-host", "host", "update-now.sh");
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

function renderUpdate(update) {
  if (!update || update.status === "current") return;
  if (update.status === "available") {
    line("---");
    line(`UPDATE AVAILABLE |${item({ color: COL.warn, size: 10 })}`);
    const refs = update.localRef && update.remoteRef ? ` ${update.localRef} -> ${update.remoteRef}` : "";
    line(`oh-my-tokens${refs} |${item({ color: COL.primary, size: 12 })}`);
    if (update.canApply !== false) {
      line(`Update now | bash=${updateScriptPath()} refresh=true terminal=false sfimage=arrow.down.circle`);
    } else if (update.message) {
      line(`${String(update.message).slice(0, 100)} |${item({ color: COL.dim, size: 11 })}`);
    }
    return;
  }
}

function updateFooterSuffix(update) {
  if (!update || update.status === "current" || update.status === "available") return "";
  if (update.status === "dirty") return " · update blocked: local changes";
  if (update.status === "apply_failed") return " · update failed";
  if (update.status === "checking_failed" || update.status === "not_git_repo") return " · update check failed";
  return "";
}

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
  const hidden = hiddenProviders();
  const errs = (Array.isArray(report.errors) ? report.errors : []).filter((e) => !hidden.has(e.provider));

  // Merge standalone Cursor usage (real tokens + estimated cost the host fetched from
  // cursor.com), replacing the local request-count-only records so Cursor shows tokens +
  // cost and contributes to the headline total.
  const cursorUsage = readUsageCache().filter((r) => r.provider === "cursor");
  if (cursorUsage.length) recs = recs.filter((r) => r.provider !== "cursor").concat(cursorUsage);
  recs = recs.filter((r) => !hidden.has(r.provider));

  // ----- menu-bar title: one "bucket" per quota window showing REMAINING capacity.
  // Quota % is merged before the title so the title can use it; the dropdown reuses
  // the same merged records below. With no quota data (or the "classic" style), the
  // title falls back to today's estimated cost + total tokens.
  const quota = readQuotaCache();
  const quotaRecords = mergeQuotaRecords(quota, recs).filter((r) => !hidden.has(r.provider));
  const buckets = quotaBuckets(quotaRecords);
  const style = titleStyle();
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
  const headlineParts = [];
  if (todayCost > 0) headlineParts.push(money(todayCost));
  if (todayTokens > 0) headlineParts.push(`${abbr(todayTokens)} tok`);
  const headline = headlineParts.length ? headlineParts.join(" · ") : "—";
  const titleIsBuckets = buckets.length > 0 && style !== "classic";
  line(renderTitleLine(headline, buckets, style));
  line("---");
  // When the title shows buckets, keep the cost/token total one click away.
  line(`oh-my-tokens · today${titleIsBuckets && headline !== "—" ? ` · ${headline}` : ""} |${item({ color: COL.dim, size: 11 })}`);

  // ----- plan usage % (popup-written cache + any fresher host quota records) -----
  writeQuotaSamples(report, recs, quotaRecords);
  if (quotaRecords.length) {
    line("---");
    line(`PLAN USAGE |${item({ color: COL.muted, size: 10 })}`);
    const byProv = {};
    for (const q of quotaRecords) (byProv[q.provider] ??= []).push(q);
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

  // ----- menu-bar style switcher (writes menubar-prefs.json via the plugin script) -----
  const pluginScript = process.env.OMT_PLUGIN_SCRIPT;
  if (pluginScript) {
    line("---");
    line(`Menu bar style |${item({ color: COL.dim, size: 11 })}`);
    const opt = (name, val, img) =>
      line(
        `--${name}${style === val ? " ✓" : ""} | bash="${pluginScript}" param1=--set-style param2=${val} terminal=false refresh=true sfimage=${img}`,
      );
    opt("Quota buckets · image", "png", "square.lefthalf.filled");
    opt("Cost · tokens", "classic", "ticket");
  }

  // ----- footer -----
  line("---");
  if (anyEstimated) {
    line(`Estimated costs, not billing |${item({ color: COL.warn, size: 11 })}`);
  }
  if (errs.length) {
    line(`⚠ ${errs.length} source error(s) |${item({ color: COL.high, size: 11 })}`);
    for (const e of errs) line(`--${e.provider}: ${String(e.message).slice(0, 100)} |${item({ color: COL.dim, size: 11, font: "Menlo" })}`);
  }
  renderUpdate(report.update);
  // Show the update time in the user's LOCAL timezone (like the reset times), not UTC.
  const gd = report.generatedAt ? new Date(report.generatedAt) : null;
  const gen = gd && !Number.isNaN(gd.getTime())
    ? gd.toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      })
    : "";
  line(`Updated ${gen}${updateFooterSuffix(report.update)} |${item({ color: COL.dim, size: 11 })}`);
  line("Refresh | refresh=true");

  process.stdout.write(out.join("\n") + "\n");
})();
