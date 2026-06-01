import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostPath = join(repoRoot, "host", "native-host.js");

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

const QUOTA = {
  id: "cursor::quota:plan-usage:quota_percent",
  provider: "cursor",
  metricType: "quota_percent",
  window: "today",
  usedPercent: 13.7,
  windowLabel: "Plan usage",
  planType: "Pro",
};
const TOKENS = { id: "x", provider: "cursor", metricType: "measured_tokens", inputTokens: 5 };

test("writeQuotaCache keeps only quota_percent records; readQuotaCache round-trips", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-quota-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    // import after HOME is set so os.homedir() resolves to the temp dir
    const { writeQuotaCache, readQuotaCache, quotaCachePath } = await import(
      "../quota-cache.js?case=roundtrip"
    );
    const saved = await writeQuotaCache([QUOTA, TOKENS], "2026-06-01T00:00:00.000Z");
    assert.equal(saved.records.length, 1, "non-quota records are dropped");

    const onDisk = JSON.parse(await readFile(quotaCachePath(), "utf8"));
    assert.equal(onDisk.savedAt, "2026-06-01T00:00:00.000Z");
    assert.equal(onDisk.records[0].usedPercent, 13.7);

    const read = await readQuotaCache();
    assert.deepEqual(read.records, [QUOTA]);

    // empty / missing → safe default
    await writeQuotaCache([], "2026-06-01T01:00:00.000Z");
    assert.deepEqual((await readQuotaCache()).records, []);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("mergeQuotaCache replaces only the named providers, keeps the rest", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-quota-merge-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const { mergeQuotaCache, readQuotaCache } = await import("../quota-cache.js?case=merge");
    const claude = { ...QUOTA, id: "claude::q", provider: "claude-code" };
    const cursorOld = { ...QUOTA, usedPercent: 10 };
    await mergeQuotaCache([claude, cursorOld]); // seed: claude + cursor
    // Host refreshes ONLY cursor → claude must survive, cursor must update.
    const cursorNew = { ...QUOTA, usedPercent: 42 };
    await mergeQuotaCache([cursorNew], ["cursor"]);
    const { records } = await readQuotaCache();
    const byProv = Object.fromEntries(records.map((r) => [r.provider, r]));
    assert.equal(records.length, 2);
    assert.equal(byProv["claude-code"].usedPercent, 13.7, "claude untouched");
    assert.equal(byProv["cursor"].usedPercent, 42, "cursor replaced");
    // needs_login for cursor → empty merge clears only cursor, claude stays.
    await mergeQuotaCache([], ["cursor"]);
    const after = (await readQuotaCache()).records;
    assert.deepEqual(after.map((r) => r.provider), ["claude-code"]);
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    await rm(home, { recursive: true, force: true });
  }
});

test("native host saveQuota caches quota_percent and acks, without building a report", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-quota-host-"));
  const child = spawn(process.execPath, [hostPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, USERPROFILE: home, DEEPSEEK_API_KEY: "", TZ: "UTC" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (c) => stdout.push(c));
  child.stderr.on("data", (c) => stderr.push(c));
  child.stdin.end(frame({ type: "saveQuota", records: [QUOTA, TOKENS] }));

  let timeout;
  try {
    const exit = await Promise.race([
      new Promise((resolve) => child.on("exit", (code) => resolve(code))),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("native host did not exit")), 5000);
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(exit, 0, Buffer.concat(stderr).toString("utf8"));

    const raw = Buffer.concat(stdout);
    const length = raw.readUInt32LE(0);
    const resp = JSON.parse(raw.subarray(4, 4 + length).toString("utf8"));
    assert.deepEqual(resp, { ok: true, saved: 1 });

    const cache = JSON.parse(await readFile(join(home, ".oh-my-tokens", "quota-cache.json"), "utf8"));
    assert.equal(cache.records.length, 1);
    assert.equal(cache.records[0].provider, "cursor");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
