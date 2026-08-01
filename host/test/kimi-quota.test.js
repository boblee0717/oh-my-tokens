import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsagePayload } from "../kimi-quota.js";

// Mirrors the live GET /coding/v1/usages response (proto-JSON: numeric strings,
// limit+remaining without used, resetTime, window.timeUnit, 300-minute windows).
test("mapUsagePayload maps the weekly summary and rate-limit windows to quota records", () => {
  const recs = mapUsagePayload({
    user: { membership: { level: "LEVEL_ADVANCED" } },
    usage: { limit: "100", remaining: "100", resetTime: "2026-08-07T18:16:34Z" },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "37", remaining: "63", resetTime: "2026-07-31T20:16:34Z" },
      },
      {
        window: { duration: 1, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "30", used: "3" },
      },
    ],
    boosterWallet: { status: "STATUS_DISABLED" },
  });

  assert.equal(recs.length, 3);
  const weekly = recs.find((r) => r.windowLabel === "weekly");
  assert.equal(weekly.provider, "kimi");
  assert.equal(weekly.metricType, "quota_percent");
  assert.equal(weekly.usedPercent, 0); // derived: limit 100 - remaining 100
  assert.equal(weekly.resetsAt, "2026-08-07T18:16:34Z");
  assert.equal(weekly.planType, "Kimi Advanced");
  assert.equal(weekly.id, "kimi::quota:weekly:quota_percent");

  const fiveHour = recs.find((r) => r.windowLabel === "5h"); // 300 minutes folded to 5h
  assert.equal(fiveHour.usedPercent, 37);
  assert.equal(fiveHour.resetsAt, "2026-07-31T20:16:34Z");

  const minute = recs.find((r) => r.windowLabel === "1m");
  assert.equal(minute.usedPercent, 10);
});

test("mapUsagePayload skips rows without a usable limit and tolerates junk", () => {
  assert.deepEqual(mapUsagePayload(null), []);
  assert.deepEqual(mapUsagePayload({}), []);
  const recs = mapUsagePayload({
    usage: { used: 10, limit: 0 }, // limit 0 -> skipped
    limits: [
      { detail: { used: 1 }, window: { duration: 5, unit: "hour" } }, // no limit -> skipped
      "garbage",
      { detail: { used: 2, limit: 4, reset_at: "2026-08-01T00:00:00Z" }, window: { duration: 2, unit: "week" } },
    ],
  });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].windowLabel, "2w");
  assert.equal(recs[0].usedPercent, 50);
  assert.equal(recs[0].resetsAt, "2026-08-01T00:00:00Z"); // snake_case reset_at accepted
  assert.equal(recs[0].planType, "Kimi Code"); // no membership info -> default
});
