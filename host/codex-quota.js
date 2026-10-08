// Read quota through the installed Codex client's own authenticated app-server.
// No inference turns, credential-file reads, or browser interaction.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, constants } from "node:fs";
import { dirname, delimiter } from "node:path";

export const CODEX_QUOTA_SOURCE = "codex app-server account/rateLimits/read";

function codexCommand() {
  if (process.env.OMT_CODEX_BIN) return process.env.OMT_CODEX_BIN;
  for (const path of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try { accessSync(path, constants.X_OK); return path; } catch {}
  }
  return "codex";
}

export function parseCodexQuota(result, updatedAt = new Date().toISOString()) {
  const buckets = result?.rateLimitsByLimitId;
  const rl = buckets != null ? buckets.codex : result?.rateLimits;
  if (!rl || (rl.limitId != null && rl.limitId !== "codex")) return [];
  const records = [];
  for (const win of [rl.primary, rl.secondary]) {
    const mins = win?.windowDurationMins;
    if (!Number.isFinite(win?.usedPercent) || !Number.isInteger(mins) || mins <= 0) continue;
    const label = mins === 10080 ? "Weekly" : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
    const reset = Number.isFinite(win.resetsAt) ? new Date(win.resetsAt * 1000) : null;
    records.push({
      id: `codex::quota:${label.toLowerCase()}:quota_percent`,
      provider: "codex", model: null, metricType: "quota_percent",
      source: CODEX_QUOTA_SOURCE, window: "today",
      inputTokens: 0, outputTokens: 0, cacheTokens: 0, requests: 0,
      costUSD: null, balance: null, currency: null,
      usedPercent: Math.max(0, Math.min(100, win.usedPercent)), windowLabel: label,
      resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined,
      planType: rl.planType ?? undefined, updatedAt, confidence: "high", warnings: [],
    });
  }
  return records;
}

export function fetchCodexQuota({ command = codexCommand(), spawnProcess = spawn, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child, lines, timer, killTimer, settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines?.close();
      if (child && child.exitCode == null) {
        child.kill();
        killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
        killTimer.unref();
      }
      resolve(result);
    };
    const error = () => finish({ status: "error", records: [] });
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    try {
      // npm's Codex launcher uses /usr/bin/env node; SwiftBar's PATH may omit Node.
      child = spawnProcess(command, ["app-server"], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}` },
      });
      timer = setTimeout(error, timeoutMs);
      child.on("error", error);
      child.on("close", () => { clearTimeout(killTimer); error(); });
      child.stdin.on("error", error);
      lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let response;
        try { response = JSON.parse(line); } catch { return; }
        if (response.method !== undefined) return;
        if (response.id !== 1 && response.id !== 2) return;
        if (response.error) return error();
        if (response.id === 1) {
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "account/rateLimits/read" });
        } else {
          const records = parseCodexQuota(response.result);
          finish({ status: records.length ? "ok" : "error", records });
        }
      });
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "oh_my_tokens", version: "0.6.11" } } });
    } catch { error(); }
  });
}
