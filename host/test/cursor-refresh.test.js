import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("unreadable browser cookies retain cached Cursor quota and usage", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-cookie-error-"));
  try {
    const base = join(home, ".oh-my-tokens");
    await mkdir(base);
    const quota = { records: [{ provider: "cursor", metricType: "quota_percent", usedPercent: 4.7, updatedAt: "2026-01-01T00:00:00Z" }] };
    const usage = { records: [{ provider: "cursor", metricType: "measured_tokens", inputTokens: 123, updatedAt: "2026-01-01T00:00:00Z" }] };
    await writeFile(join(base, "quota-cache.json"), JSON.stringify(quota));
    await writeFile(join(base, "usage-cache.json"), JSON.stringify(usage));
    await writeFile(join(base, "menubar-prefs.json"), JSON.stringify({ hiddenProviders: ["kimi"] }));
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../refresh-quota.js", import.meta.url))], {
      env: { ...process.env, HOME: home, USERPROFILE: home, OMT_MENUBAR_PREFS: join(base, "menubar-prefs.json") },
    });
    assert.deepEqual(JSON.parse(await readFile(join(base, "quota-cache.json"), "utf8")), quota);
    assert.deepEqual(JSON.parse(await readFile(join(base, "usage-cache.json"), "utf8")), usage);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
