import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const formatScript = join(here, "format.mjs");

function runFormat(report, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [formatScript], {
      env: { ...process.env, OMT_DISABLE_QUOTA_SAMPLING: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`format exited ${code}: ${stderr}`));
    });
    child.stdin.end(JSON.stringify(report));
  });
}

test("headline displays today's total tokens from all models beside today's estimated cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-headline-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(quotaCache, JSON.stringify({ records: [] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [
        {
          id: "codex:gpt-5.5:today:measured_tokens",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "measured_tokens",
          window: "today",
          inputTokens: 800000,
          outputTokens: 100000,
          cacheTokens: 5000000,
        },
        {
          id: "claude-code:claude-sonnet-4-6:today:measured_tokens",
          provider: "claude-code",
          model: "claude-sonnet-4-6",
          metricType: "measured_tokens",
          window: "today",
          inputTokens: 1000,
          outputTokens: 2000,
          cacheTokens: 0,
        },
        {
          id: "cursor:composer-2.5:today:measured_tokens",
          provider: "cursor",
          model: "composer-2.5",
          metricType: "measured_tokens",
          window: "today",
          inputTokens: 100000,
          outputTokens: 20000,
          cacheTokens: 70000,
        },
        {
          id: "codex:gpt-5.5:today:estimated_cost",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 2.75,
        },
        {
          id: "cursor:composer-2.5:today:estimated_cost",
          provider: "cursor",
          model: "composer-2.5",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 0.25,
        },
        {
          id: "codex:gpt-5.5:7d:measured_tokens",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "measured_tokens",
          window: "7d",
          inputTokens: 9000000000,
          outputTokens: 0,
          cacheTokens: 0,
        },
      ],
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.equal(out.split("\n")[0], "🎫 $3.00 · 6.1M tok | sfimage=ticket");
});

test("PLAN USAGE prefers newer quota records from the host report over stale cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-06-26T07:03:29.204Z",
      records: [
        {
          id: "codex::quota:5h:quota_percent",
          provider: "codex",
          metricType: "quota_percent",
          usedPercent: 14,
          windowLabel: "5h",
          resetsAt: "2026-06-26T07:03:00.000Z",
          planType: "Codex",
          updatedAt: "2026-06-26T06:58:29.137Z",
        },
      ],
    }),
  );

  const out = await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [
        {
          id: "codex::quota:5h:quota_percent",
          provider: "codex",
          metricType: "quota_percent",
          usedPercent: 2,
          windowLabel: "5h",
          resetsAt: "2026-06-26T12:03:27.000Z",
          planType: "Codex",
          updatedAt: "2026-06-26T07:06:13.799Z",
        },
      ],
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.match(out, /Codex · Codex/);
  assert.match(out, /5h\s+2%/);
  assert.doesNotMatch(out, /5h\s+14%/);
});

test("appends quota samples with displayed quota and provider token totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-sample-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  const sampleLog = join(dir, "quota-samples.jsonl");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-06-26T07:03:29.204Z",
      records: [
        {
          id: "codex::quota:5h:quota_percent",
          provider: "codex",
          metricType: "quota_percent",
          usedPercent: 14,
          windowLabel: "5h",
          updatedAt: "2026-06-26T06:58:29.137Z",
        },
      ],
    }),
  );

  await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [
        {
          id: "codex::quota:5h:quota_percent",
          provider: "codex",
          metricType: "quota_percent",
          usedPercent: 2,
          windowLabel: "5h",
          resetsAt: "2026-06-26T12:03:27.000Z",
          planType: "Codex",
          source: "~/.codex",
          updatedAt: "2026-06-26T07:06:13.799Z",
        },
        {
          id: "codex:gpt-5.5:today:measured_tokens",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "measured_tokens",
          window: "today",
          requests: 6,
          inputTokens: 800000,
          outputTokens: 100000,
          cacheTokens: 5000000,
        },
        {
          id: "codex:gpt-5.5:today:estimated_cost",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 2.75,
        },
      ],
    },
    {
      OMT_QUOTA_CACHE: quotaCache,
      OMT_USAGE_CACHE: usageCache,
      OMT_DISABLE_QUOTA_SAMPLING: "0",
      OMT_QUOTA_SAMPLE_LOG: sampleLog,
    },
  );

  const lines = (await readFile(sampleLog, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const sample = JSON.parse(lines[0]);
  assert.equal(sample.sampledAt, "2026-06-26T07:06:12.562Z");
  assert.equal(sample.provider, "codex");
  assert.equal(sample.planType, "Codex");
  assert.equal(sample.quota["5h"].usedPercent, 2);
  assert.equal(sample.quota["5h"].source, "~/.codex");
  assert.equal(sample.today.requests, 6);
  assert.equal(sample.today.totalTokens, 5900000);
  assert.equal(sample.today.estimatedCostUSD, 2.75);
  assert.deepEqual(sample.models, [
    {
      model: "gpt-5.5",
      requests: 6,
      inputTokens: 800000,
      outputTokens: 100000,
      cacheTokens: 5000000,
      totalTokens: 5900000,
    },
  ]);
});

test("renders update section with one-click update command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-update-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  const updateScript = join(dir, "update-now.sh");
  await writeFile(quotaCache, JSON.stringify({ records: [] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [],
      update: {
        status: "available",
        localRef: "be13e53",
        remoteRef: "63d528c",
        message: "Update available",
        canApply: true,
      },
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_UPDATE_SCRIPT: updateScript },
  );

  assert.match(out, /UPDATE AVAILABLE/);
  assert.match(out, /be13e53 -> 63d528c/);
  assert.match(out, new RegExp(`Update now \\| bash=${updateScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} refresh=true`));
});

test("renders blocked update state inline with Updated footer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-update-blocked-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(quotaCache, JSON.stringify({ records: [] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [],
      update: {
        status: "dirty",
        message: "Local changes present; automatic update is disabled",
        canApply: false,
      },
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.doesNotMatch(out, /^Update check:/m);
  assert.match(out, /Updated Jun 26, 03:06 PM GMT\+8 · update blocked: local changes/);
});

test("footer rows avoid icon gutter so text aligns cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-footer-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(quotaCache, JSON.stringify({ records: [] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-06-26T07:06:12.562Z",
      errors: [],
      records: [
        {
          id: "codex:gpt-5.5:today:estimated_cost",
          provider: "codex",
          model: "gpt-5.5",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 2.75,
          confidence: "low",
        },
      ],
      update: {
        status: "dirty",
        message: "Local changes present; automatic update is disabled",
      },
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.match(out, /^Estimated costs, not billing \|/m);
  assert.match(out, /^Updated Jun 26, 03:06 PM GMT\+8 · update blocked: local changes \|/m);
  assert.match(out, /^Refresh \| refresh=true$/m);
  assert.doesNotMatch(out, /sfimage=arrow\.clockwise/);
  assert.doesNotMatch(out, /^⚠︎ costs are estimated/m);
});
