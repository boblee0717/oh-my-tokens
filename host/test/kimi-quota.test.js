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

test("resolveClientId extracts the id from the CLI binary and caches it by mtime", async () => {
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveClientId } = await import("../kimi-quota.js");

  const dir = await mkdtemp(join(tmpdir(), "omt-kimi-clientid-"));
  const bin = join(dir, "bin", "kimi");
  const cache = join(dir, "client-id.json");
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(bin, 'noise… KIMI_CODE_FLOW_CONFIG = { name: "kimi-code", clientId: "deadbeef-0000-0000-0000-000000000000" } …');

  const savedEnv = { ...process.env };
  try {
    process.env.OMT_KIMI_CLI_BINARY = bin;
    process.env.OMT_KIMI_CLIENT_ID_CACHE = cache;
    delete process.env.OMT_KIMI_CLIENT_ID;

    assert.equal(await resolveClientId(), "deadbeef-0000-0000-0000-000000000000");
    // cache was written and is reused (binary replaced with garbage -> mtime change -> re-extract -> null)
    const cached = JSON.parse(await readFile(cache, "utf8"));
    assert.equal(cached.clientId, "deadbeef-0000-0000-0000-000000000000");
    await writeFile(bin, "garbage without an id");
    assert.equal(await resolveClientId(), null);
    // env override wins
    process.env.OMT_KIMI_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
    assert.equal(await resolveClientId(), "11111111-2222-3333-4444-555555555555");
  } finally {
    for (const k of ["OMT_KIMI_CLI_BINARY", "OMT_KIMI_CLIENT_ID_CACHE", "OMT_KIMI_CLIENT_ID"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
});

test("resolveClientId finds an id straddling a read-stream chunk boundary", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { resolveClientId } = await import("../kimi-quota.js");

  const dir = await mkdtemp(join(tmpdir(), "omt-kimi-chunk-"));
  const bin = join(dir, "kimi");
  const cache = join(dir, "client-id.json");
  // The real binary is scanned a megabyte at a time; park the constant so it spans the
  // first chunk boundary, which only matches if the carry-over between chunks is kept.
  const constant = 'clientId: "deadbeef-1111-2222-3333-444444444444"';
  await writeFile(bin, "x".repeat((1 << 20) - 24) + constant + "x".repeat(1024));

  const savedEnv = { ...process.env };
  try {
    process.env.OMT_KIMI_CLI_BINARY = bin;
    process.env.OMT_KIMI_CLIENT_ID_CACHE = cache;
    delete process.env.OMT_KIMI_CLIENT_ID;
    assert.equal(await resolveClientId(), "deadbeef-1111-2222-3333-444444444444");
  } finally {
    for (const k of ["OMT_KIMI_CLI_BINARY", "OMT_KIMI_CLIENT_ID_CACHE", "OMT_KIMI_CLIENT_ID"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
});

test("fetchKimiQuota only reports needs_login for real auth failures", async () => {
  const { mkdtemp, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fetchKimiQuota } = await import("../kimi-quota.js");

  const dir = await mkdtemp(join(tmpdir(), "omt-kimi-status-"));
  const creds = join(dir, "kimi-code.json");
  const stored = { access_token: "expired", refresh_token: "r1", expires_at: 1 };
  await writeFile(creds, JSON.stringify(stored));

  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const jsonResponse = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  try {
    process.env.OMT_KIMI_CREDENTIALS = creds;
    process.env.OMT_KIMI_CLIENT_ID = "deadbeef-0000-0000-0000-000000000000";

    // The access token is expired, so every case below goes through the refresh endpoint.
    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    assert.deepEqual(await fetchKimiQuota(), { status: "error", records: [] });

    globalThis.fetch = async () => jsonResponse(503, {});
    assert.deepEqual(await fetchKimiQuota(), { status: "error", records: [] });

    globalThis.fetch = async () => jsonResponse(400, { error: "invalid_grant" });
    assert.deepEqual(await fetchKimiQuota(), { status: "needs_login", records: [] });

    // A failed refresh must never rewrite the CLI's credentials.
    assert.deepEqual(JSON.parse(await readFile(creds, "utf8")), stored);

    process.env.OMT_KIMI_CREDENTIALS = join(dir, "absent.json");
    globalThis.fetch = async () => jsonResponse(200, {});
    assert.deepEqual(await fetchKimiQuota(), { status: "needs_login", records: [] });
  } finally {
    globalThis.fetch = savedFetch;
    for (const k of ["OMT_KIMI_CREDENTIALS", "OMT_KIMI_CLIENT_ID"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
});

test("writeTokenFile keeps fields the refresh response doesn't cover and leaves no temp file", async () => {
  const { mkdtemp, readdir, readFile, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeTokenFile } = await import("../kimi-quota.js");

  const dir = await mkdtemp(join(tmpdir(), "omt-kimi-creds-"));
  const creds = join(dir, "kimi-code.json");
  // The CLI owns this file; anything it stores beyond the token keys must survive our write.
  const previous = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: 1_700_000_000,
    account_id: "acct_42",
    endpoint: "https://api.kimi.com",
  };
  await writeFile(creds, JSON.stringify(previous, null, 2) + "\n");

  const savedEnv = process.env.OMT_KIMI_CREDENTIALS;
  try {
    process.env.OMT_KIMI_CREDENTIALS = creds;
    await writeTokenFile(previous, {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: 1_800_000_000,
      scope: "",
      token_type: "Bearer",
      expires_in: 900,
    });

    const after = JSON.parse(await readFile(creds, "utf8"));
    assert.equal(after.access_token, "new-access");
    assert.equal(after.refresh_token, "new-refresh");
    assert.equal(after.expires_at, 1_800_000_000);
    assert.equal(after.account_id, "acct_42"); // preserved
    assert.equal(after.endpoint, "https://api.kimi.com"); // preserved
    assert.deepEqual(await readdir(dir), ["kimi-code.json"]); // atomic swap, temp cleaned up
  } finally {
    if (savedEnv === undefined) delete process.env.OMT_KIMI_CREDENTIALS;
    else process.env.OMT_KIMI_CREDENTIALS = savedEnv;
  }
});
