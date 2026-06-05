import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnalyticsText, parseResetToISO, fetchCodexQuota } from "../codex-web.js";

// Representative innerText of chatgpt.com/codex/cloud/settings/analytics (zh, 2026-06-01).
// The page shows REMAINING %. Main plan renders before the GPT-5.3-Codex-Spark section.
const PAGE = `Codex 用量分析
主套餐
5 小时使用限额
37% 剩余
重置时间：19:11
每周使用限额
86% 剩余
重置时间：2026年6月8日 3:10
GPT-5.3-Codex-Spark
5 小时使用限额
100% 剩余
每周使用限额
100% 剩余
剩余额度
0`;

test("parses main-plan 5h + weekly as used% = 100 - remaining; ignores Spark + credits", () => {
  const recs = parseAnalyticsText(PAGE);
  assert.equal(recs.length, 2, "only 5h + weekly, no Spark/credits");

  const five = recs.find((r) => r.windowLabel === "5h");
  assert.ok(five, "5h record");
  assert.equal(five.provider, "codex");
  assert.equal(five.metricType, "quota_percent");
  assert.equal(five.usedPercent, 63); // 100 - 37 remaining

  const weekly = recs.find((r) => r.windowLabel === "Weekly");
  assert.ok(weekly, "weekly record");
  assert.equal(weekly.usedPercent, 14); // 100 - 86 remaining

  // reset times parsed from "重置时间：…" (5h = same-day time, weekly = full date)
  assert.ok(five.resetsAt, "5h has resetsAt");
  const fr = new Date(five.resetsAt);
  assert.equal(fr.getHours(), 19);
  assert.equal(fr.getMinutes(), 11);
  const wr = new Date(weekly.resetsAt);
  assert.equal(wr.getFullYear(), 2026);
  assert.equal(wr.getMonth(), 5); // June (0-based)
  assert.equal(wr.getDate(), 8);
  assert.equal(wr.getHours(), 3);
  assert.equal(wr.getMinutes(), 10);

  // No Spark windows leaked in (Spark 5h/weekly were 100% remaining = 0% used).
  assert.equal(recs.some((r) => /Spark/i.test(r.windowLabel)), false);
  assert.equal(recs.some((r) => r.usedPercent === 0), false);
});

test("parseResetToISO: time-only → today (next day if past); full date parsed", () => {
  const now = new Date(2026, 5, 5, 11, 0, 0); // Jun 5, 11:00 local
  const future = new Date(parseResetToISO("19:11", now));
  assert.equal(future.getDate(), 5);
  assert.equal(future.getHours(), 19);
  assert.equal(future.getMinutes(), 11);
  const past = new Date(parseResetToISO("03:00", now)); // already past 11:00 → next day
  assert.equal(past.getDate(), 6);
  const full = new Date(parseResetToISO("2026年6月8日 3:10", now));
  assert.equal(full.getMonth(), 5);
  assert.equal(full.getDate(), 8);
  assert.equal(full.getHours(), 3);
  assert.equal(parseResetToISO("", now), undefined);
  assert.equal(parseResetToISO("no time here", now), undefined);
});

test("empty / non-matching text → no records", () => {
  assert.deepEqual(parseAnalyticsText(""), []);
  assert.deepEqual(parseAnalyticsText("登录 ChatGPT"), []);
});

// Injected deps so the hidden-tab flow is testable without a browser.
function deps({ texts }) {
  let i = 0;
  return {
    createTab: async () => ({ id: 42 }),
    removeTab: async () => {},
    readText: async () => texts[Math.min(i++, texts.length - 1)],
    sleep: async () => {},
  };
}

test("fetchCodexQuota: returns ok with records once the limit section renders", async () => {
  // First two polls: page still loading (no limit text); then the real page.
  const r = await fetchCodexQuota(deps({ texts: ["", "加载中", PAGE] }));
  assert.equal(r.status, "ok");
  assert.equal(r.records.length, 2);
  assert.equal(r.records.find((x) => x.windowLabel === "5h").usedPercent, 63);
});

test("fetchCodexQuota: never-renders / logged-out → needs_login (not a fake 0%)", async () => {
  const r = await fetchCodexQuota(deps({ texts: ["请登录 ChatGPT 以继续 sign in"] }));
  assert.equal(r.status, "needs_login");
  assert.equal(r.records.length, 0);
  assert.ok(r.loginUrl);
});

test("fetchCodexQuota: no browser deps → error (host keeps token usage)", async () => {
  const r = await fetchCodexQuota(null);
  assert.equal(r.status, "error");
  assert.deepEqual(r.records, []);
});
