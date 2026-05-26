// Builds the aggregate UsageReport across all providers. Shared by the CLI
// (index.ts) and the Native Messaging host (native-host.ts).

import type { UsageReport } from "../shared/schema.ts";
import { parseClaudeUsage } from "./parsers/claude.ts";
import { parseCodexUsage } from "./parsers/codex.ts";
import { parseDeepSeekUsage } from "./parsers/deepseek.ts";

export async function buildUsageReport(hostVersion: string): Promise<UsageReport> {
  const report: UsageReport = {
    generatedAt: new Date().toISOString(),
    hostVersion,
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
  return report;
}
