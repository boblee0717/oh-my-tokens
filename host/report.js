import { parseClaudeUsage } from "./parsers/claude.js";
import { parseCodexUsage } from "./parsers/codex.js";
import { parseDeepSeekUsage } from "./parsers/deepseek.js";
import { parseCursorUsage } from "./parsers/cursor.js";

export async function buildUsageReport(hostVersion, opts = {}) {
  const report = {
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
    report.records.push(...(await parseCursorUsage()));
  } catch (e) {
    report.errors.push({ provider: "cursor", message: String(e) });
  }
  try {
    report.records.push(...(await parseDeepSeekUsage({ apiKey: opts.deepseekApiKey })));
  } catch (e) {
    report.errors.push({ provider: "deepseek", message: String(e) });
  }
  return report;
}
