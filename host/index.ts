// Minimal CLI: print a UsageReport (Claude Code + Codex + DeepSeek) as JSON.
// Usage: node host/index.ts
// DeepSeek balance requires DEEPSEEK_API_KEY in the environment.

import { buildUsageReport } from "./report.ts";

const HOST_VERSION = "0.0.0-m5";

async function main(): Promise<void> {
  const report = await buildUsageReport(HOST_VERSION);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
