import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const formatScript = join(here, "format.mjs");

test("hidden providers stay hidden across cache, report, errors, and style changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-hidden-"));
  const prefs = join(dir, "prefs.json");
  const quotaCache = join(dir, "quota.json");
  const usageCache = join(dir, "usage.json");
  await writeFile(prefs, JSON.stringify({ hiddenProviders: ["kimi"], titleStyle: "png" }));
  await writeFile(quotaCache, JSON.stringify({ records: [
    { provider: "kimi", metricType: "quota_percent", windowLabel: "weekly", usedPercent: 0 },
    { provider: "cursor", metricType: "quota_percent", windowLabel: "Plan usage", usedPercent: 0.5 },
  ] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await promisify(execFile)("bash", [join(here, "oh-my-tokens.1m.sh"), "--set-style", "classic"], {
    env: { ...process.env, OMT_MENUBAR_PREFS: prefs },
  });
  assert.deepEqual(JSON.parse(await readFile(prefs, "utf8")), { hiddenProviders: ["kimi"], titleStyle: "classic" });
  const out = await runFormat({ errors: [{ provider: "kimi", message: "Kimi failed" }], records: [
    { provider: "kimi", metricType: "measured_tokens", window: "today", inputTokens: 9999999, model: "hidden-model" },
    { provider: "kimi", metricType: "quota_percent", windowLabel: "5h", usedPercent: 50 },
    { provider: "codex", metricType: "estimated_cost", window: "today", costUSD: 2 },
  ] }, { OMT_MENUBAR_PREFS: prefs, OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache });
  assert.match(out, /Cursor/);
  assert.match(out, /Plan usage\s+0\.5%/);
  assert.doesNotMatch(out, /kimi|hidden-model|10M tok/i);
  assert.match(out.split("\n")[0], /\$2/);
});

function runFormat(report, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [formatScript], {
      env: {
        ...process.env,
        OMT_DISABLE_QUOTA_SAMPLING: "1",
        // Isolate from any real ~/.oh-my-tokens/menubar-prefs.json on the dev machine.
        OMT_MENUBAR_PREFS: join(tmpdir(), "omt-test-menubar-prefs-absent.json"),
        ...env,
      },
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

function pngAlphaAt(png, x, y) {
  const width = png.readUInt32BE(16);
  const idat = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  assert.equal(raw[y * stride], 0, "test PNG should use filter type 0");
  return raw[y * stride + 1 + x * 4 + 3];
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

test("headline includes a Codex 5.6 Sol estimated-cost record from the host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-codex-56-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(quotaCache, JSON.stringify({ records: [] }));
  await writeFile(usageCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-07-10T09:00:00.000Z",
      errors: [],
      records: [
        {
          id: "codex:gpt-5.6-sol:today:measured_tokens",
          provider: "codex",
          model: "gpt-5.6-sol",
          metricType: "measured_tokens",
          window: "today",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheTokens: 1_000_000,
        },
        {
          id: "codex:gpt-5.6-sol:today:estimated_cost",
          provider: "codex",
          model: "gpt-5.6-sol",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 35.5,
          currency: "USD",
          confidence: "low",
        },
      ],
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.equal(out.split("\n")[0], "🎫 $35.50 · 3.0M tok | sfimage=ticket");
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

test("renders and samples TraeX provider records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-traex-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  const sampleLog = join(dir, "quota-samples.jsonl");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(quotaCache, JSON.stringify({ records: [] }));

  const out = await runFormat(
    {
      generatedAt: "2026-07-06T12:00:00.000Z",
      errors: [],
      records: [
        {
          id: "traex::quota:5h:quota_percent",
          provider: "traex",
          metricType: "quota_percent",
          usedPercent: 32,
          windowLabel: "5h",
          resetsAt: "2026-07-06T14:00:00.000Z",
          planType: "trae-pro",
          source: "~/.trae/cli",
          updatedAt: "2026-07-06T10:05:00.000Z",
        },
        {
          id: "traex:GPT-5.5:today:measured_tokens",
          provider: "traex",
          model: "GPT-5.5",
          metricType: "measured_tokens",
          window: "today",
          requests: 1,
          inputTokens: 1100,
          outputTokens: 500,
          cacheTokens: 700,
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

  assert.match(out, /TraeX · trae-pro/);
  assert.match(out, /GPT-5\.5\s+1 req/);

  const lines = (await readFile(sampleLog, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const sample = JSON.parse(lines[0]);
  assert.equal(sample.provider, "traex");
  assert.equal(sample.quota["5h"].usedPercent, 32);
  assert.equal(sample.today.totalTokens, 2300);
});

test("png style groups one provider's quota windows under one shared label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-png-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: [
        {
          id: "claude-code::quota:weekly:quota_percent",
          provider: "claude-code",
          metricType: "quota_percent",
          usedPercent: 50,
          windowLabel: "Weekly",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
        {
          id: "claude-code::quota:5h:quota_percent",
          provider: "claude-code",
          metricType: "quota_percent",
          usedPercent: 14,
          windowLabel: "5h",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
    }),
  );

  const out = await runFormat(
    { generatedAt: "2026-07-31T08:01:00.000Z", errors: [], records: [] },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_TITLE_STYLE: "png" },
  );

  const title = out.split("\n")[0];
  const m = title.match(/^\s*\| templateImage=(.+)$/);
  assert.ok(m, `unexpected title: ${title.slice(0, 80)}`);
  const png = Buffer.from(m[1], "base64");
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  // Two independent 9px buckets share one centred CLAUDE label. Repeating the
  // provider badge made this 61px wide; the grouped treatment is 37px.
  assert.equal(png.readUInt32BE(16), 37);
  assert.equal(png.readUInt32BE(20), 20);
  assert.equal(pngAlphaAt(png, 2, 7), 255, "5h bucket should sort first and be filled at this height");
  assert.equal(pngAlphaAt(png, 10, 7), 0, "quota windows should remain separate mini buckets");
  assert.equal(pngAlphaAt(png, 20, 7), 255, "second bucket should keep its own outline");
  assert.equal(pngAlphaAt(png, 22, 7), 0, "Weekly bucket should sort second and still be empty at this height");
});

test("buckets image keeps different providers in separate buckets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-order-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: [
        {
          id: "cursor::quota:plan:quota_percent",
          provider: "cursor",
          metricType: "quota_percent",
          usedPercent: 20,
          windowLabel: "plan",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
        {
          id: "claude-code::quota:5h:quota_percent",
          provider: "claude-code",
          metricType: "quota_percent",
          usedPercent: 40,
          windowLabel: "5h",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
    }),
  );

  const out = await runFormat(
    { generatedAt: "2026-07-31T08:01:00.000Z", errors: [], records: [] },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_TITLE_STYLE: "png" },
  );

  const m = out.split("\n")[0].match(/^\s*\| templateImage=(.+)$/);
  assert.ok(m, "title should be a template image");
  const png = Buffer.from(m[1], "base64");
  // Two 23px provider groups (claude + cursor) separated by the 7px group gap.
  assert.equal(png.readUInt32BE(16), 53);
  assert.equal(png.readUInt32BE(20), 20);
});

test("eight-bucket cap keeps a window from later providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-fair-cap-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  const providers = ["claude-code", "codex", "traex", "cursor", "kimi"];
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: providers.flatMap((provider) => [
        { id: `${provider}:5h`, provider, metricType: "quota_percent", usedPercent: 20, windowLabel: "5h" },
        { id: `${provider}:weekly`, provider, metricType: "quota_percent", usedPercent: 40, windowLabel: "Weekly" },
      ]),
    }),
  );

  const out = await runFormat(
    { generatedAt: "2026-07-31T08:01:00.000Z", errors: [], records: [] },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_TITLE_STYLE: "png" },
  );

  const m = out.split("\n")[0].match(/^\s*\| templateImage=(.+)$/);
  assert.ok(m, "title should be a template image");
  const png = Buffer.from(m[1], "base64");
  // Claude/Codex/TraeX get two buckets; Cursor and later Kimi still get one.
  assert.equal(png.readUInt32BE(16), 179);
});

test("classic style keeps the cost headline even with quota data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-classic-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  const prefs = join(dir, "menubar-prefs.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(prefs, JSON.stringify({ titleStyle: "classic" }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: [
        {
          id: "codex::quota:5h:quota_percent",
          provider: "codex",
          metricType: "quota_percent",
          usedPercent: 14,
          windowLabel: "5h",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
    }),
  );

  const out = await runFormat(
    {
      generatedAt: "2026-07-31T08:01:00.000Z",
      errors: [],
      records: [
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
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_MENUBAR_PREFS: prefs },
  );

  assert.equal(out.split("\n")[0], "🎫 $2.75 | sfimage=ticket");
});

test("default style is the classic headline even with quota data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-default-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: [
        {
          id: "kimi::quota:weekly:quota_percent",
          provider: "kimi",
          metricType: "quota_percent",
          usedPercent: 2,
          windowLabel: "weekly",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
    }),
  );

  // No OMT_TITLE_STYLE, no prefs file -> classic ticket headline, buckets are opt-in.
  const out = await runFormat(
    {
      generatedAt: "2026-07-31T08:01:00.000Z",
      errors: [],
      records: [
        {
          id: "kimi:k3:today:estimated_cost",
          provider: "kimi",
          model: "k3",
          metricType: "estimated_cost",
          window: "today",
          costUSD: 1.5,
        },
      ],
    },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache },
  );

  assert.equal(out.split("\n")[0], "🎫 $1.50 | sfimage=ticket");
});

test("a provider missing from PROVIDER_ORDER still gets a bucket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-format-buckets-unknown-"));
  const quotaCache = join(dir, "quota-cache.json");
  const usageCache = join(dir, "usage-cache.json");
  await writeFile(usageCache, JSON.stringify({ records: [] }));
  // A cache written by a newer extension than this formatter: the provider isn't in
  // PROVIDER_ORDER, and its short name needs letters (G, N) the badge font must cover.
  await writeFile(
    quotaCache,
    JSON.stringify({
      savedAt: "2026-07-31T08:00:00.000Z",
      records: [
        {
          id: "gemini::quota:5h:quota_percent",
          provider: "gemini",
          metricType: "quota_percent",
          usedPercent: 40,
          windowLabel: "5h",
          updatedAt: "2026-07-31T08:00:00.000Z",
        },
      ],
    }),
  );

  const out = await runFormat(
    { generatedAt: "2026-07-31T08:01:00.000Z", errors: [], records: [] },
    { OMT_QUOTA_CACHE: quotaCache, OMT_USAGE_CACHE: usageCache, OMT_TITLE_STYLE: "png" },
  );

  const m = out.split("\n")[0].match(/^\s*\| templateImage=(.+)$/);
  assert.ok(m, "unknown provider should still render a bucket, not fall back to the headline");
  const png = Buffer.from(m[1], "base64");
  // One provider group: the 23px GEMINI label is wider than its 17px window cell.
  assert.equal(png.readUInt32BE(16), 23);
  assert.equal(png.readUInt32BE(20), 20);
});
