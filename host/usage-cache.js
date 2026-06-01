import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Cache for token/cost usage that the host fetches standalone from a web dashboard
// (currently Cursor's usage events — cursor.com gives no usage in local logs). Kept
// separate from quota-cache.json (which holds quota_percent). The menu bar merges these
// records into the local report so Cursor shows real tokens + an estimated cost.

export function usageCachePath() {
  return join(homedir(), ".oh-my-tokens", "usage-cache.json");
}

export async function writeUsageCache(records, savedAt = new Date().toISOString()) {
  const recs = Array.isArray(records) ? records : [];
  await mkdir(join(homedir(), ".oh-my-tokens"), { recursive: true });
  await writeFile(usageCachePath(), JSON.stringify({ savedAt, records: recs }, null, 2));
  return recs;
}

export async function readUsageCache() {
  try {
    const parsed = JSON.parse(await readFile(usageCachePath(), "utf8"));
    return {
      savedAt: parsed?.savedAt ?? null,
      records: Array.isArray(parsed?.records) ? parsed.records : [],
    };
  } catch {
    return { savedAt: null, records: [] };
  }
}
