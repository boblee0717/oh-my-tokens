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

// Merge: replace the cached quota records for the providers present in `providers`
// (or, if omitted, the providers found in newRecords) while leaving every other
// provider's records untouched. This lets independent writers coexist — e.g. the host
// refreshes Cursor standalone every minute while Claude/Codex come from the extension —
// without clobbering each other. Each record keeps its own updatedAt for per-provider age.
export async function mergeQuotaCache(newRecords, providers, savedAt = new Date().toISOString()) {
  const fresh = (Array.isArray(newRecords) ? newRecords : []).filter(
    (r) => r && r.metricType === "quota_percent"
  );
  const replace = new Set(providers && providers.length ? providers : fresh.map((r) => r.provider));
  const existing = (await readQuotaCache()).records.filter((r) => !replace.has(r.provider));
  const merged = [...existing, ...fresh];
  await mkdir(quotaCacheDir(), { recursive: true });
  await writeFile(quotaCachePath(), JSON.stringify({ savedAt, records: merged }, null, 2));
  return merged;
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
