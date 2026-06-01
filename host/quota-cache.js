import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Quota % (Cursor plan usage, claude.ai) is login-gated and can only be fetched by the
// browser extension using the user's cookies — the native host's local-log parsers never
// see it. The popup pushes those quota_percent records here so non-browser consumers (the
// macOS menu-bar plugin) can show plan usage too. We persist ONLY quota_percent records;
// tokens/cost/requests already come from local logs via the normal report.

export function quotaCacheDir() {
  return join(homedir(), ".oh-my-tokens");
}
export function quotaCachePath() {
  return join(quotaCacheDir(), "quota-cache.json");
}

export async function writeQuotaCache(records, savedAt = new Date().toISOString()) {
  const quota = (Array.isArray(records) ? records : []).filter(
    (r) => r && r.metricType === "quota_percent",
  );
  await mkdir(quotaCacheDir(), { recursive: true });
  const payload = { savedAt, records: quota };
  await writeFile(quotaCachePath(), JSON.stringify(payload, null, 2));
  return payload;
}

export async function readQuotaCache() {
  try {
    const parsed = JSON.parse(await readFile(quotaCachePath(), "utf8"));
    return {
      savedAt: parsed?.savedAt ?? null,
      records: Array.isArray(parsed?.records) ? parsed.records : [],
    };
  } catch {
    return { savedAt: null, records: [] };
  }
}
