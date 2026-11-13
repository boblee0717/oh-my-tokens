import { test } from "node:test";
import assert from "node:assert/strict";
import { mapUsageSummary as mapHost } from "../cursor-quota.js";
import { mapUsageSummary as mapWeb } from "../../extension/cursor-web.js";

for (const [source, map] of [["host", mapHost], ["extension", mapWeb]]) {
  const onDemand = (value) => map({ individualUsage: { onDemand: value } }).find((r) => r.windowLabel === "On-demand");

  test(`${source}: dashboard summary maps on-demand cents separately from plan usage`, () => {
    const records = map({
      membershipType: "pro_plus", billingCycleEnd: "2026-06-01T00:00:00.000Z",
      individualUsage: {
        plan: { totalPercentUsed: 36.8, apiPercentUsed: 100 },
        onDemand: { enabled: true, used: 1234, limit: 5000, remaining: 3766 },
      },
      teamUsage: { onDemand: { used: 99999, limit: 100000 } },
    });
    assert.deepEqual(records.map((r) => [r.windowLabel, r.usedPercent]), [
      ["Plan usage", 36.8], ["API usage", 100], ["On-demand", 24.7],
    ]);
    const spend = records[2];
    assert.equal(spend.id, "cursor::quota:on-demand:quota_percent");
    assert.equal(spend.metricType, "quota_percent", "billing-cycle spend must not enter daily estimated-cost totals");
    assert.equal(spend.costUSD, 12.34);
    assert.equal(spend.limitUSD, 50);
    assert.equal(spend.currency, "USD");
    assert.equal(spend.resetsAt, "2026-06-01T00:00:00.000Z");
    assert.equal(spend.planType, "pro_plus");
  });

  test(`${source}: enabled zero spend and numeric strings are supported`, () => {
    assert.equal(onDemand({ enabled: true, used: "0", limit: "5000" }).costUSD, 0);
    assert.equal(onDemand({ used: "1234", limit: "5000" }).usedPercent, 24.7);
    const over = onDemand({ used: 6001, limit: 5000 });
    assert.equal(over.usedPercent, 100);
    assert.equal(over.costUSD, 60.01, "clamping the bar must not lose the actual spend");
  });

  test(`${source}: absent caps show spend without inventing a percentage`, () => {
    for (const limit of [undefined, null, 0, -1]) {
      const record = onDemand({ enabled: true, used: 1234, limit });
      assert.equal(record.costUSD, 12.34);
      assert.equal(record.usedPercent, null);
      assert.equal(record.limitUSD, null);
    }
  });

  test(`${source}: missing, invalid, and unused disabled on-demand data are omitted`, () => {
    for (const value of [undefined, {}, { used: null }, { used: "" }, { used: "bad" }, { used: -1 }, { enabled: false, used: 0 }]) {
      assert.equal(onDemand(value), undefined);
    }
    assert.equal(onDemand({ enabled: false, used: 100 }).costUSD, 1, "disabling on-demand must retain spend already incurred");
    assert.deepEqual(map({ used: 250, limit: 500, individualUsage: { onDemand: { enabled: true, used: 100 } } })
      .map((r) => r.windowLabel), ["Plan usage", "On-demand"]);
  });
}
