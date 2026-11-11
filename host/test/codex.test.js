process.env.TZ = "UTC";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseCodexUsage } from "../parsers/codex.js";

const baseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex");
const NOW = new Date("2026-05-26T12:00:00.000Z");

function run() {
  return parseCodexUsage({ baseDir, now: NOW });
}
function pick(records, model, window) {
  return records.find((r) => r.model === model && r.window === window);
}

async function writeRollouts(t, files) {
  const dir = await mkdtemp(join(tmpdir(), "omt-codex-models-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [file, rows] of Object.entries(files)) {
    const path = join(dir, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  return dir;
}

function context(timestamp, model, ordinal) {
  return { timestamp, ordinal, type: "turn_context", payload: { model } };
}

function usage(timestamp, input, cache, output, reasoning, ordinal) {
  return { timestamp, ordinal, type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: input, cached_input_tokens: cache,
      output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output + reasoning },
  } } };
}

test("attributes cumulative deltas to the model active at each event across day boundaries", async (t) => {
  const dir = await writeRollouts(t, { "sessions/switched.jsonl": [
    context("2026-05-25T23:00:00Z", "gpt-6-astra"),
    usage("2026-05-25T23:01:00Z", 1000, 400, 100, 20),
    usage("2026-05-26T09:00:00Z", 1400, 600, 140, 30),
    context("2026-05-26T09:01:00Z", "gpt-6.1-sol"),
    usage("2026-05-26T09:02:00Z", 1400, 600, 140, 30), // repeated snapshot after switching
    usage("2026-05-26T09:03:00Z", 2000, 900, 200, 40),
    context("2026-05-26T09:04:00Z", "gpt-6-astra"), // no usage for this switch
  ] });
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  const tokens = (model, window) => {
    const r = pick(records, model, window);
    return [r.inputTokens, r.cacheTokens, r.outputTokens, r.requests];
  };
  assert.deepEqual(tokens("gpt-6-astra", "today"), [200, 200, 50, 1]);
  assert.deepEqual(tokens("gpt-6.1-sol", "today"), [300, 300, 70, 1]);
  assert.deepEqual(tokens("gpt-6-astra", "7d"), [800, 600, 170, 1]);
  assert.deepEqual(tokens("gpt-6.1-sol", "7d"), [300, 300, 70, 1]);
});

test("keeps child identity despite copied parent metadata and dedups archived child rollouts", async (t) => {
  const child = [
    { type: "session_meta", ordinal: 0, payload: { id: "child", session_id: "parent", subagent_history_start_ordinal: 4 } },
    { type: "session_meta", ordinal: 1, payload: { id: "parent" } },
    context("2026-05-26T09:00:00Z", "gpt-6-astra", 2),
    usage("2026-05-26T09:00:01Z", 5000, 2000, 500, 100, 4),
    context("2026-05-26T09:00:02Z", "gpt-6.1-sol", 5),
    usage("2026-05-26T09:00:03Z", 1000, 400, 100, 20, 6), // child counter starts at zero
  ];
  const dir = await writeRollouts(t, {
    "sessions/parent.jsonl": [
      { type: "session_meta", payload: { id: "parent" } },
      context("2026-05-26T09:00:00Z", "gpt-6-astra"),
      usage("2026-05-26T09:00:01Z", 5000, 2000, 500, 100),
    ],
    "sessions/child.jsonl": child,
    "archived_sessions/child.jsonl": child,
  });
  const records = await parseCodexUsage({ baseDir: dir, now: NOW, windows: ["today"] });
  const parent = pick(records, "gpt-6-astra", "today");
  const subagent = pick(records, "gpt-6.1-sol", "today");
  assert.deepEqual([parent.inputTokens, parent.cacheTokens, parent.outputTokens, parent.requests], [3000, 2000, 600, 1]);
  assert.deepEqual([subagent.inputTokens, subagent.cacheTokens, subagent.outputTokens, subagent.requests], [600, 400, 120, 1]);
});

test("uses inherited token snapshots only as a baseline when a child continues the counter", async (t) => {
  const dir = await writeRollouts(t, { "sessions/child.jsonl": [
    { type: "session_meta", ordinal: 0, payload: { id: "child", subagent_history_start_ordinal: 2 } },
    context("2026-05-26T09:00:00Z", "gpt-6-astra", 1),
    usage("2026-05-26T09:00:01Z", 5000, 2000, 500, 100, 2),
    context("2026-05-26T09:00:02Z", "gpt-6.1-sol", 3),
    usage("2026-05-26T09:00:03Z", 5000, 2000, 500, 100, 4),
    usage("2026-05-26T09:00:04Z", 6000, 2400, 600, 120, 5),
  ] });
  const records = await parseCodexUsage({ baseDir: dir, now: NOW, windows: ["today"] });
  assert.equal(pick(records, "gpt-6-astra", "today"), undefined);
  const r = pick(records, "gpt-6.1-sol", "today");
  assert.deepEqual([r.inputTokens, r.cacheTokens, r.outputTokens, r.requests], [600, 400, 120, 1]);
});

test("uses the final (cumulative) total_token_usage per session", async () => {
  const r = pick(await run(), "gpt-5.5", "today");
  assert.ok(r, "expected gpt-5.5/today");
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.cacheTokens, 1000);
  assert.equal(r.outputTokens, 750);
  assert.equal(r.requests, 1);
});

test("counts only the cumulative token delta inside each window for resumed sessions", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-window-delta");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });

  const today = pick(records, "gpt-5.5", "today");
  assert.ok(today, "expected resumed session to contribute today's delta");
  assert.equal(today.inputTokens, 800);
  assert.equal(today.cacheTokens, 400);
  assert.equal(today.outputTokens, 150);
  assert.equal(today.requests, 1);

  const seven = pick(records, "gpt-5.5", "7d");
  assert.ok(seven, "expected resumed session to contribute 7d delta");
  assert.equal(seven.inputTokens, 1800);
  assert.equal(seven.cacheTokens, 1400);
  assert.equal(seven.outputTokens, 450);
  assert.equal(seven.requests, 1);
});

test("dedups a session present in both sessions/ and archived_sessions/", async () => {
  const r = pick(await run(), "gpt-5.4", "7d");
  assert.ok(r);
  assert.equal(r.requests, 1);
  assert.equal(r.inputTokens, 400);
  assert.equal(r.cacheTokens, 100);
  assert.equal(r.outputTokens, 100);
});

test("cost is null for Codex with explicit warnings", async () => {
  const r = pick(await run(), "gpt-5.5", "today");
  assert.equal(r.costUSD, null);
  assert.equal(r.currency, null);
  assert.ok(r.warnings.some((w) => w.includes("cost not estimated")));
  assert.ok(r.warnings.some((w) => w.includes("counts sessions")));
});

test("windows: out-of-30d session excluded; gpt-5.4 not in today", async () => {
  const records = await run();
  const gpt55_30 = pick(records, "gpt-5.5", "30d");
  assert.equal(gpt55_30.inputTokens, 2000);
  assert.equal(gpt55_30.requests, 1);
  assert.equal(pick(records, "gpt-5.4", "today"), undefined);
  assert.ok(pick(records, "gpt-5.4", "30d"));
});

test("id rule and missing-dir safety", async () => {
  const r = pick(await run(), "gpt-5.4", "7d");
  assert.equal(r.id, "codex:gpt-5.4:7d:measured_tokens");
  assert.deepEqual(await parseCodexUsage({ baseDir: "/no/such/dir", now: NOW }), []);
});

test("surfaces the latest rate_limits as quota_percent records (5h + weekly)", async () => {
  const records = await run();
  const quota = records.filter((r) => r.metricType === "quota_percent");
  assert.equal(quota.length, 2);

  const five = quota.find((q) => q.windowLabel === "5h");
  assert.equal(five.usedPercent, 18);
  assert.equal(five.planType, "plus");
  assert.equal(five.provider, "codex");
  assert.equal(five.model, null);
  assert.ok(five.resetsAt);
  assert.equal(five.updatedAt, "2026-05-26T10:05:00.000Z");

  const weekly = quota.find((q) => q.windowLabel === "Weekly");
  assert.equal(weekly.usedPercent, 42);
  assert.equal(weekly.updatedAt, "2026-05-26T10:05:00.000Z");
});

test("credits plan (null primary/secondary) surfaces a credits balance record", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-credits");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  const bal = records.find((r) => r.metricType === "balance" && r.provider === "codex");
  assert.ok(bal, "expected a Codex credits balance record");
  assert.equal(bal.balance, 0);
  assert.equal(bal.currency, "credits");
  assert.equal(bal.planType, "prolite");
  assert.equal(records.some((r) => r.metricType === "quota_percent"), false);
});

test("non-canonical bengalfox limits do not produce main-plan quota records", async () => {
  // codex_bengalfox is an auxiliary limit family. It can carry plan_type=prolite and 0%,
  // but must not be rendered as the Codex subscription quota.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-bengalfox");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  assert.equal(records.some((r) => r.metricType === "quota_percent"), false, "no 0% quota rows");
  assert.equal(records.some((r) => r.metricType === "balance"), false, "no '0 credits' balance row");
  const tokens = records.find((r) => r.model === "gpt-5.5" && r.metricType === "measured_tokens");
  assert.ok(tokens, "token usage is still reported");
  assert.equal(tokens.inputTokens, 100);
});

test("canonical Codex quota is not overwritten by a later bengalfox limit", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-rate-limit-source");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  const quota = records.filter((r) => r.metricType === "quota_percent");
  assert.deepEqual(
    quota
      .map(({ windowLabel, usedPercent, planType, updatedAt }) => ({ windowLabel, usedPercent, planType, updatedAt }))
      .sort((a, b) => a.windowLabel.localeCompare(b.windowLabel)),
    [
      {
        windowLabel: "5h",
        usedPercent: 18,
        planType: "prolite",
        updatedAt: "2026-05-26T09:00:02.000Z",
      },
      {
        windowLabel: "Weekly",
        usedPercent: 44,
        planType: "prolite",
        updatedAt: "2026-05-26T09:00:02.000Z",
      },
    ],
  );
});

test("canonical Codex zero-percent quota remains visible", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-canonical-zero");
  const records = await parseCodexUsage({ baseDir: dir, now: NOW });
  const weekly = records.find((r) => r.metricType === "quota_percent" && r.windowLabel === "Weekly");
  assert.ok(weekly, "expected a real canonical Codex weekly quota");
  assert.equal(weekly.usedPercent, 0);
  assert.equal(weekly.planType, "prolite");
});

test("falls back to filename-derived session id when session_meta is absent", async () => {
  const noMetaDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-nometa");
  const records = await parseCodexUsage({ baseDir: noMetaDir, now: NOW });
  const r = records.find((x) => x.model === "gpt-5.5" && x.window === "today");
  assert.ok(r, "session without session_meta should still be parsed via filename id");
  assert.equal(r.inputTokens, 500);
  assert.equal(r.cacheTokens, 200);
  assert.equal(r.outputTokens, 100);
  assert.equal(r.requests, 1);
});
