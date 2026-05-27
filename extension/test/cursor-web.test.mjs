import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsageSummary, fetchCursorUsage } from "../cursor-web.js";

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const fetchReturning = (r) => async () => r;

test("mapUsageSummary: explicit total percent → one quota record", () => {
  const recs = mapUsageSummary({ membershipType: "pro", totalPercentUsed: 42, billingCycleEnd: "2026-06-01T00:00:00Z" });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].provider, "cursor");
  assert.equal(recs[0].metricType, "quota_percent");
  assert.equal(recs[0].usedPercent, 42);
  assert.equal(recs[0].planType, "pro");
  assert.equal(recs[0].resetsAt, "2026-06-01T00:00:00Z");
});

test("mapUsageSummary: distinct api + total percents → two records", () => {
  const recs = mapUsageSummary({ totalPercentUsed: 30, apiPercentUsed: 80 });
  assert.equal(recs.length, 2);
  assert.deepEqual(
    recs.map((r) => [r.windowLabel, r.usedPercent]),
    [["Plan usage", 30], ["API usage", 80]],
  );
});

test("mapUsageSummary: derives percent from used/limit when no explicit percent", () => {
  const recs = mapUsageSummary({ used: 250, limit: 500 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].usedPercent, 50);
});

test("mapUsageSummary: percent clamped to 0..100", () => {
  assert.equal(mapUsageSummary({ totalPercentUsed: 150 })[0].usedPercent, 100);
});

test("mapUsageSummary: error body / junk → []", () => {
  assert.deepEqual(mapUsageSummary({ error: "not_authenticated" }), []);
  assert.deepEqual(mapUsageSummary(null), []);
  assert.deepEqual(mapUsageSummary({}), []);
});

test("fetchCursorUsage: 401 → needs_login with loginUrl", async () => {
  const out = await fetchCursorUsage(fetchReturning(res(401, { error: "not_authenticated" })));
  assert.equal(out.status, "needs_login");
  assert.match(out.loginUrl, /cursor\.com/);
});

test("fetchCursorUsage: 200 not_authenticated body → needs_login", async () => {
  const out = await fetchCursorUsage(fetchReturning(res(200, { error: "not_authenticated" })));
  assert.equal(out.status, "needs_login");
});

test("fetchCursorUsage: success → ok with records", async () => {
  const out = await fetchCursorUsage(fetchReturning(res(200, { membershipType: "pro", totalPercentUsed: 12 })));
  assert.equal(out.status, "ok");
  assert.equal(out.records.length, 1);
});

test("fetchCursorUsage: 500 → error", async () => {
  const out = await fetchCursorUsage(fetchReturning(res(500, {})));
  assert.equal(out.status, "error");
});
