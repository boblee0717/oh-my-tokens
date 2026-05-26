// Minimal CLI for M1: print a UsageReport for Claude Code as JSON.
// Usage: node host/index.ts [baseDir]
//   baseDir defaults to ~/.claude/projects
// (The Native Messaging host wrapper comes in a later milestone.)

import type { UsageReport } from "../shared/schema.ts";
import { parseClaudeUsage } from "./parsers/claude.ts";

async function main(): Promise<void> {
  const baseDir = process.argv[2];
  const report: UsageReport = {
    generatedAt: new Date().toISOString(),
    hostVersion: "0.0.0-m1",
    records: [],
    errors: [],
  };
  try {
    report.records = await parseClaudeUsage(baseDir ? { baseDir } : {});
  } catch (e) {
    report.errors.push({ provider: "claude-code", message: String(e) });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

main();
