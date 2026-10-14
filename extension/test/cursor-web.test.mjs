process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsageSummary, mapUsageEvents, fetchCursorUsage, fetchCursorQuota } from "../cursor-web.js";

test("background quota refresh only requests the summary using the browser session", async () => {
  const calls = [];
  const result = await fetchCursorQuota(async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, "include");
    assert.ok(options.signal instanceof AbortSignal);
    return res(200, { totalPercentUsed: 0.5 });
  });
  assert.equal(result.status, "ok");
  assert.equal(result.records[0].usedPercent, 0.5);
  assert.deepEqual(calls, ["https://cursor.com/api/usage-summary"]);
});

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
const fetchReturning = (r) => async () => r;

const NOW = new Date("2026-05-27T12:00:00.000Z");
const tsDaysAgo = (d) => String(NOW.getTime() - d * 86400000);
const tsHoursAgo = (h) => String(NOW.getTime() - h * 3600000);

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

// --- usage events (per-model tokens) ---

const eventsSample = {
  totalUsageEventsCount: 2,
  usageEventsDisplay: [
    {
      timestamp: tsHoursAgo(2),
      model: "claude-opus-4-7-high",
      tokenUsage: { inputTokens: 100, outputTokens: 200, cacheWriteTokens: 50, cacheReadTokens: 10, totalCents: 121 },
    },
    {
      timestamp: tsDaysAgo(20), // inside 30d, outside 7d/today
      model: "composer-2.5-fast",
      tokenUsage: { inputTokens: 5, outputTokens: 6, cacheWriteTokens: 0, totalCents: 0 },
    },
  ],
};

test("mapUsageEvents: aggregates tokens + cost per model per window", () => {
  const recs = mapUsageEvents(eventsSample, NOW);
  const opus7d = recs.find((r) => r.model === "claude-opus-4-7-high" && r.window === "7d" && r.metricType === "measured_tokens");
  assert.ok(opus7d);
  assert.equal(opus7d.provider, "cursor");
  assert.equal(opus7d.inputTokens, 100);
  assert.equal(opus7d.outputTokens, 200);
  assert.equal(opus7d.cacheTokens, 60); // write 50 + read 10
  assert.equal(opus7d.requests, 1);
  const opusCost = recs.find((r) => r.model === "claude-opus-4-7-high" && r.window === "7d" && r.metricType === "estimated_cost");
  assert.equal(opusCost.costUSD, 1.21); // 121 cents
  assert.equal(opusCost.currency, "USD");
});

test("mapUsageEvents: window bucketing by timestamp", () => {
  const recs = mapUsageEvents(eventsSample, NOW);
  // composer event is 20d ago → in 30d only
  assert.ok(recs.find((r) => r.model === "composer-2.5-fast" && r.window === "30d"));
  assert.equal(recs.find((r) => r.model === "composer-2.5-fast" && r.window === "7d"), undefined);
  // opus event is 1d ago → in today/7d/30d
  assert.ok(recs.find((r) => r.model === "claude-opus-4-7-high" && r.window === "today"));
});

test("mapUsageEvents: snake_case tolerance", () => {
  const recs = mapUsageEvents(
    { usage_events_display: [{ timestamp: tsDaysAgo(0), model_id: "x", token_usage: { input_tokens: 9, output_tokens: 1 } }] },
    NOW,
  );
  const r = recs.find((x) => x.model === "x" && x.window === "today");
  assert.ok(r);
  assert.equal(r.inputTokens, 9);
});

test("mapUsageEvents: partial flag adds a warning", () => {
  const recs = mapUsageEvents(eventsSample, NOW, true);
  assert.ok(recs[0].warnings.some((w) => /partial/.test(w)));
});

test("mapUsageEvents: bad input → []", () => {
  assert.deepEqual(mapUsageEvents(null, NOW), []);
  assert.deepEqual(mapUsageEvents({}, NOW), []);
});

test("mapUsageSummary: nested individualUsage.plan percent", () => {
  const recs = mapUsageSummary({ membershipType: "pro", individualUsage: { plan: { totalPercentUsed: 36.8 } } });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].usedPercent, 36.8);
  assert.equal(recs[0].planType, "pro");
});

test("fetchCursorUsage: summary + events combine into quota + token records", async () => {
  const fetchImpl = async (url, opts) => {
    if (String(url).includes("usage-summary")) return res(200, { membershipType: "pro", totalPercentUsed: 12 });
    if (String(url).includes("get-filtered-usage-events")) return res(200, eventsSample);
    return res(404, {});
  };
  const out = await fetchCursorUsage(fetchImpl, NOW);
  assert.equal(out.status, "ok");
  assert.ok(out.records.some((r) => r.metricType === "quota_percent"));
  assert.ok(out.records.some((r) => r.metricType === "measured_tokens" && r.provider === "cursor"));
});

test("extension-origin 403 retries from a Cursor page and cleans up its tab", async () => {
  let attempts = 0;
  let removed;
  const deps = {
    createTab: async () => ({ id: 42 }),
    removeTab: async (id) => { removed = id; },
    sleep: async () => {},
    post: async (id, body) => {
      assert.equal(id, 42);
      assert.equal(body.page, 1);
      if (++attempts === 1) return null; // navigation not ready yet
      return { status: 200, json: { totalUsageEventsCount: 1, usageEventsDisplay: [{
        timestamp: String(NOW.getTime()), model: "claude-fable-5-1-thinking-high",
        tokenUsage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 56 },
      }] } };
    },
  };
  const result = await fetchCursorUsage(async (url) => url.endsWith("usage-summary")
    ? res(200, { totalPercentUsed: 4.3 }) : res(403, {}), NOW, deps);
  const fable = result.records.find(r => r.window === "today" && r.metricType === "measured_tokens");
  assert.ok(fable, "extension-origin 403 must not discard Fable tokens");
  assert.equal(fable.model, "claude-fable-5-1-thinking-high");
  assert.equal(fable.inputTokens + fable.outputTokens + fable.cacheTokens, 102);
  assert.equal(removed, 42);
});

test("failed same-origin request retains quota and closes its temporary tab", async () => {
  let removed;
  const result = await fetchCursorUsage(async (url) => url.endsWith("usage-summary")
    ? res(200, { totalPercentUsed: 4.3 }) : res(403, {}), NOW, {
    createTab: async () => ({ id: 43 }), removeTab: async (id) => { removed = id; },
    sleep: async () => {}, post: async () => ({ status: 401, json: null }),
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.records.map(r => r.metricType), ["quota_percent"]);
  assert.equal(removed, 43);
});

test("default browser fallback only posts to Cursor's fixed same-origin endpoint", async () => {
  const originalChrome = globalThis.chrome;
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  let removed;
  try {
    globalThis.location = { origin: "https://cursor.com" };
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://cursor.com/api/dashboard/get-filtered-usage-events");
      assert.equal(options.credentials, "include");
      assert.ok(options.signal instanceof AbortSignal);
      return res(200, eventsSample);
    };
    globalThis.chrome = {
      tabs: { create: async ({ url, active }) => {
        assert.equal(url, "https://cursor.com/dashboard");
        assert.equal(active, false);
        return { id: 44 };
      }, remove: async (id) => { removed = id; } },
      scripting: { executeScript: async ({ target, args, func }) => {
        assert.equal(target.tabId, 44);
        return [{ result: await func(...args) }];
      } },
    };
    const result = await fetchCursorUsage(async (url) => url.endsWith("usage-summary")
      ? res(200, { totalPercentUsed: 4.3 }) : res(403, {}), NOW);
    assert.ok(result.records.some(r => r.metricType === "measured_tokens"));
    assert.equal(removed, 44);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.location = originalLocation;
    globalThis.fetch = originalFetch;
  }
});
