import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCursorUsage, resolveSqlite3 } from "../parsers/cursor.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cursor");
const NOW = new Date("2026-05-26T12:00:00.000Z");

// The fixture-backed tests need the sqlite3 CLI to read the .db. It isn't installed by
// default on Windows; skip there (the local parser is a documented fallback) rather than
// fail the suite. The missing-DB test below runs regardless.
const noSqlite = resolveSqlite3() ? false : "sqlite3 CLI not available on this platform";

function run() {
  return parseCursorUsage({ now: NOW, dbPath: join(fixturesDir, "ai-code-tracking.db") });
}

test("counts requests per model per time window from local SQLite", { skip: noSqlite }, async () => {
  const records = await run();
  const r1 = records.find((r) => r.model === "composer-2.5" && r.window === "today");
  assert.equal(r1, undefined, "composer-2.5 should not be in today (data is 2026-05-14)");

  const r2 = records.find((r) => r.model === "composer-2.5" && r.window === "7d");
  assert.equal(r2, undefined, "composer-2.5 should not be in 7d (data is 2026-05-14)");

  const r3 = records.find((r) => r.model === "composer-2.5" && r.window === "30d");
  assert.ok(r3, "composer-2.5 should be in 30d");
  assert.equal(r3.requests, 2); // h1, h2 — h4 is outside 30d (2026-04-19)
  assert.equal(r3.metricType, "request_count");
  assert.equal(r3.provider, "cursor");
  assert.equal(r3.inputTokens, 0);
  assert.equal(r3.confidence, "high");
});

test("handles multiple models correctly", { skip: noSqlite }, async () => {
  const records = await run();
  const opus = records.find((r) => r.model === "claude-opus-4-7" && r.window === "30d");
  assert.ok(opus, "claude-opus-4-7 should be in 30d");
  assert.equal(opus.requests, 1); // h3
});

test("missing DB yields no records, not a throw", async () => {
  const records = await parseCursorUsage({
    now: NOW,
    dbPath: "/no/such/db.sqlite",
  });
  assert.deepEqual(records, []);
});
