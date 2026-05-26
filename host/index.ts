// Minimal CLI: print a UsageReport (Claude Code + Codex + DeepSeek) as JSON.
// Usage: node host/index.ts
// DeepSeek balance requires DEEPSEEK_API_KEY in the environment.
// (The Native Messaging host wrapper and packaging come in a later milestone.)

import type { UsageReport } from "../shared/schema.ts";
import { parseClaudeUsage } from "./parsers/claude.ts";
import { parseCodexUsage } from "./parsers/codex.ts";
import { parseDeepSeekUsage } from "./parsers/deepseek.ts";

async function main(): Promise<void> {
  const report: UsageReport = {
    generatedAt: new Date().toISOString(),
    hostVersion: "0.0.0-m3",
    records: [],
    errors: [],
  };
  try {
    report.records.push(...(await parseClaudeUsage()));
  } catch (e) {
    report.errors.push({ provider: "claude-code", message: String(e) });
  }
  try {
    report.records.push(...(await parseCodexUsage()));
  } catch (e) {
    report.errors.push({ provider: "codex", message: String(e) });
  }
  try {
    report.records.push(...(await parseDeepSeekUsage()));
  } catch (e) {
    report.errors.push({ provider: "deepseek", message: String(e) });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
