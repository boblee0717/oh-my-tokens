// Minimal CLI: print a UsageReport (Claude Code + Codex) as JSON.
// Usage: node host/index.ts
// (The Native Messaging host wrapper and DeepSeek come in later milestones.)

import type { UsageReport } from "../shared/schema.ts";
import { parseClaudeUsage } from "./parsers/claude.ts";
import { parseCodexUsage } from "./parsers/codex.ts";

async function main(): Promise<void> {
  const report: UsageReport = {
    generatedAt: new Date().toISOString(),
    hostVersion: "0.0.0-m2",
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
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
