process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { symlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseTraeXUsage } from "../parsers/traex.js";
import { tildePath } from "../util.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "traex");
const NOW = new Date("2026-07-06T12:00:00.000Z");
const SOURCE = tildePath(baseDir);

function pick(records, model, window) {
  return records.find((r) => r.model === model && r.window === window && r.metricType === "measured_tokens");
}

test("aggregates TraeX cumulative token usage by model and window", async () => {
  const records = await parseTraeXUsage({ baseDir, now: NOW });

  const today = pick(records, "GPT-5.5", "today");
  assert.ok(today, "expected GPT-5.5/today measured tokens");
  assert.equal(today.provider, "traex");
  assert.equal(today.source, SOURCE);
  assert.equal(today.id, "traex:GPT-5.5:today:measured_tokens");
  assert.equal(today.inputTokens, 1100);
  assert.equal(today.cacheTokens, 700);
  assert.equal(today.outputTokens, 400);
  assert.equal(today.requests, 1);
  assert.equal(today.confidence, "high");
  assert.ok(today.warnings.some((w) => w.includes("counts sessions")));

  const seven = pick(records, "Doubao-Seed-2.1-Pro", "7d");
  assert.ok(seven, "expected older TraeX session in 7d");
  assert.equal(seven.inputTokens, 325);
  assert.equal(seven.cacheTokens, 75);
  assert.equal(seven.outputTokens, 100);
  assert.equal(pick(records, "Doubao-Seed-2.1-Pro", "today"), undefined);
});

test("surfaces TraeX rate_limits as quota percent and credits balance", async () => {
  const records = await parseTraeXUsage({ baseDir, now: NOW });

  const quota = records.filter((r) => r.metricType === "quota_percent");
  assert.equal(quota.length, 2);
  const five = quota.find((q) => q.windowLabel === "5h");
  assert.equal(five.id, "traex::quota:5h:quota_percent");
  assert.equal(five.provider, "traex");
  assert.equal(five.source, SOURCE);
  assert.equal(five.usedPercent, 32);
  assert.equal(five.planType, "trae-pro");
  assert.equal(five.resetsAt, "2026-07-06T14:00:00.000Z");
  assert.equal(five.updatedAt, "2026-07-06T10:05:00.000Z");

  const weekly = quota.find((q) => q.windowLabel === "Weekly");
  assert.equal(weekly.usedPercent, 66);

  const balance = records.find((r) => r.metricType === "balance");
  assert.ok(balance, "expected TraeX credits balance");
  assert.equal(balance.id, "traex::credits:balance");
  assert.equal(balance.balance, 10);
  assert.equal(balance.currency, "credits");
  assert.equal(balance.planType, "trae-pro");
});

test("missing TraeX sessions directory is empty", async () => {
  assert.deepEqual(await parseTraeXUsage({ baseDir: "/no/such/trae", now: NOW }), []);
});

test("uses TRAE_CLI_HOME as the default TraeX root", async () => {
  const prevCliHome = process.env.TRAE_CLI_HOME;
  const prevHome = process.env.TRAE_HOME;
  const dir = await mkdtemp(join(tmpdir(), "omt-traex-home-"));
  try {
    await symlink(join(baseDir, "sessions"), join(dir, "sessions"), "dir");
    process.env.TRAE_CLI_HOME = dir;
    delete process.env.TRAE_HOME;

    const records = await parseTraeXUsage({ now: NOW });
    const today = pick(records, "GPT-5.5", "today");
    assert.ok(today, "expected parser to read sessions under TRAE_CLI_HOME");
    assert.equal(today.source, tildePath(dir));
  } finally {
    if (prevCliHome === undefined) delete process.env.TRAE_CLI_HOME;
    else process.env.TRAE_CLI_HOME = prevCliHome;
    if (prevHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses TRAE_HOME directly when it contains sessions", async () => {
  const prevCliHome = process.env.TRAE_CLI_HOME;
  const prevHome = process.env.TRAE_HOME;
  const dir = await mkdtemp(join(tmpdir(), "omt-traex-home-direct-"));
  try {
    await symlink(join(baseDir, "sessions"), join(dir, "sessions"), "dir");
    delete process.env.TRAE_CLI_HOME;
    process.env.TRAE_HOME = dir;

    const records = await parseTraeXUsage({ now: NOW });
    const today = pick(records, "GPT-5.5", "today");
    assert.ok(today, "expected parser to read sessions directly under TRAE_HOME");
    assert.equal(today.source, tildePath(dir));
  } finally {
    if (prevCliHome === undefined) delete process.env.TRAE_CLI_HOME;
    else process.env.TRAE_CLI_HOME = prevCliHome;
    if (prevHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});
