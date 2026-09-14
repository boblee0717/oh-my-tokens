import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsage, fetchClaudeQuota } from "../claude-web.js";

// Minimal Response-like stub for the injectable fetch.
function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
// Builds a fake fetch that maps a path substring → response.
function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, r] of routes) if (url.includes(needle)) return r;
    return res(404, {});
  };
}

// Real shape captured from claude.ai/api/organizations/{uuid}/usage (2026-05-26).
const sample = {
  five_hour: { utilization: 47, resets_at: "2026-05-26T11:00:01.044405+00:00" },
  seven_day: { utilization: 6, resets_at: "2026-05-29T20:00:01.044424+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 2, resets_at: "2026-05-29T20:00:00.044431+00:00" },
  seven_day_omelette: { utilization: 0, resets_at: null },
  extra_usage: { is_enabled: false },
};

test("maps known windows, skips nulls and internal codenames", () => {
  const recs = mapUsage(sample);
  // five_hour, seven_day, seven_day_sonnet → 3; opus/oauth null and omelette excluded
  assert.equal(recs.length, 3);
  assert.deepEqual(
    recs.map((r) => [r.windowLabel, r.usedPercent]),
    [
      ["5h", 47],
      ["Weekly", 6],
      ["Weekly · Sonnet", 2],
    ],
  );
});

test("records are claude-code quota_percent with the right shape", () => {
  const r = mapUsage(sample)[0];
  assert.equal(r.provider, "claude-code");
  assert.equal(r.metricType, "quota_percent");
  assert.equal(r.model, null);
  assert.equal(r.id, "claude-code::quota:5h:quota_percent");
  assert.equal(r.resetsAt, "2026-05-26T11:00:01.044405+00:00");
});

test("utilization is treated as a percent (47 → 47, not 4700) and clamped", () => {
  const recs = mapUsage({ five_hour: { utilization: 150 }, seven_day: { utilization: 47 } });
  assert.equal(recs.find((r) => r.windowLabel === "5h").usedPercent, 100); // clamped
  assert.equal(recs.find((r) => r.windowLabel === "Weekly").usedPercent, 47);
});

test("bad input yields []", () => {
  assert.deepEqual(mapUsage(null), []);
  assert.deepEqual(mapUsage(undefined), []);
  assert.deepEqual(mapUsage({}), []);
  assert.deepEqual(mapUsage({ five_hour: null }), []);
});

test("fetchClaudeQuota: 401 on account → needs_login with loginUrl", async () => {
  const f = fakeFetch([["/api/account", res(401, {})]]);
  const out = await fetchClaudeQuota(f);
  assert.equal(out.status, "needs_login");
  assert.match(out.loginUrl, /claude\.ai/);
  assert.deepEqual(out.records, []);
});

test("fetchClaudeQuota: account with no org → needs_login", async () => {
  const f = fakeFetch([["/api/account", res(200, { memberships: [] })]]);
  const out = await fetchClaudeQuota(f);
  assert.equal(out.status, "needs_login");
});

test("fetchClaudeQuota: success → ok with quota records", async () => {
  const f = fakeFetch([
    ["/api/account", res(200, { memberships: [{ organization: { uuid: "org-1" } }] })],
    ["/usage", res(200, sample)],
  ]);
  const out = await fetchClaudeQuota(f);
  assert.equal(out.status, "ok");
  assert.equal(out.records.length, 3);
});

test("fetchClaudeQuota: 500 → error (not needs_login)", async () => {
  const f = fakeFetch([["/api/account", res(500, {})]]);
  const out = await fetchClaudeQuota(f);
  assert.equal(out.status, "error");
});

test("403 for the first organization does not hide a later accessible plan", async () => {
  const calls = [];
  const fetcher = fakeFetch([
    ["/api/account", res(200, { memberships: [
      { organization: { uuid: "other-org" } },
      { organization: { uuid: "plan-org" } },
    ] })],
    ["/other-org/usage", res(403, { error: { type: "permission_error", message: "Invalid authorization for organization" } })],
    ["/plan-org/usage", res(200, sample)],
  ]);
  const result = await fetchClaudeQuota(async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, "include");
    assert.ok(options.signal);
    return fetcher(url);
  });
  assert.equal(result.status, "ok");
  assert.equal(result.records.length, 3);
  assert.deepEqual(calls, ["https://claude.ai/api/account", "https://claude.ai/api/organizations/other-org/usage", "https://claude.ai/api/organizations/plan-org/usage"]);
});

test("valid account with no accessible quota is an error, not a login prompt", async () => {
  const result = await fetchClaudeQuota(fakeFetch([
    ["/api/account", res(200, { memberships: [{ organization: { uuid: "other-org" } }] })],
    ["/usage", res(403, {})],
  ]));
  assert.deepEqual(result, { status: "error", records: [] });
});

test("empty usage tries the next unique membership and supports legacy organization", async () => {
  const calls = [];
  const f = fakeFetch([
    ["/api/account", res(200, { memberships: [{ organization: { uuid: "empty-org" } }, { organization: { uuid: "empty-org" } }, {}], organization: { uuid: "legacy-org" } })],
    ["/empty-org/usage", res(200, {})],
    ["/legacy-org/usage", res(200, sample)],
  ]);
  const result = await fetchClaudeQuota(async (url) => { calls.push(url); return f(url); });
  assert.equal(result.status, "ok");
  assert.equal(calls.length, 3);
});

test("transient usage failures do not silently switch to a different organization", async () => {
  const calls = [];
  const f = fakeFetch([
    ["/api/account", res(200, { memberships: [{ organization: { uuid: "first" } }, { organization: { uuid: "second" } }] })],
    ["/first/usage", res(500, {})],
    ["/second/usage", res(200, sample)],
  ]);
  const result = await fetchClaudeQuota(async (url) => { calls.push(url); return f(url); });
  assert.equal(result.status, "error");
  assert.equal(calls.length, 2);
});

test("expired account authentication still prompts login", async () => {
  const result = await fetchClaudeQuota(fakeFetch([["/api/account", res(403, {})]]));
  assert.equal(result.status, "needs_login");
});
