import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDeepSeekUsage } from "../parsers/deepseek.js";

const NOW = new Date("2026-05-26T12:00:00.000Z");

function stubFetch(status, body) {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
}

test("no API key → no records (provider simply absent)", async () => {
  const records = await parseDeepSeekUsage({ now: NOW, resolveKey: async () => undefined });
  assert.deepEqual(records, []);
});

test("resolveKey supplies the key when apiKey is not passed", async () => {
  const records = await parseDeepSeekUsage({
    now: NOW,
    resolveKey: async () => "from-config",
    fetchImpl: stubFetch(200, { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00" }] }),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].balance, 9);
});

test("parses a single-currency balance", async () => {
  const records = await parseDeepSeekUsage({
    apiKey: "k",
    now: NOW,
    fetchImpl: stubFetch(200, {
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "110.00" }],
    }),
  });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.provider, "deepseek");
  assert.equal(r.metricType, "balance");
  assert.equal(r.balance, 110);
  assert.equal(r.currency, "CNY");
  assert.equal(r.window, "today");
  assert.equal(r.id, "deepseek::today:balance:cny");
  assert.equal(r.model, null);
});

test("emits one record per currency", async () => {
  const records = await parseDeepSeekUsage({
    apiKey: "k",
    now: NOW,
    fetchImpl: stubFetch(200, {
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00" },
        { currency: "USD", total_balance: "5.50" },
      ],
    }),
  });
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => [r.currency, r.balance]),
    [
      ["CNY", 110],
      ["USD", 5.5],
    ],
  );
});

test("is_available=false adds a warning", async () => {
  const records = await parseDeepSeekUsage({
    apiKey: "k",
    now: NOW,
    fetchImpl: stubFetch(200, {
      is_available: false,
      balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
    }),
  });
  assert.ok(records[0].warnings.some((w) => w.includes("not available")));
});

test("HTTP error throws", async () => {
  await assert.rejects(
    parseDeepSeekUsage({ apiKey: "k", now: NOW, fetchImpl: stubFetch(401, {}) }),
    /HTTP 401/,
  );
});
