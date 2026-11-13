import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);

test("menu actions redraw saved choices from cache without collecting usage again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omt-menu-redraw-"));
  const prefs = join(dir, "prefs.json");
  const reportCache = join(dir, "report-cache.json");
  const emptyCache = join(dir, "empty.json");
  const calls = join(dir, "calls.txt");
  const host = join(dir, "host.mjs");
  const report = { generatedAt: "2026-06-01T00:00:00Z", records: [
    { provider: "claude-code", metricType: "estimated_cost", window: "today", costUSD: 3 },
  ] };
  await writeFile(prefs, JSON.stringify({ titleStyle: "classic", hiddenProviders: [] }));
  await writeFile(emptyCache, JSON.stringify({ records: [] }));
  await writeFile(host, [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.env.OMT_TEST_CALLS, "collect\\n");',
    'if (process.env.OMT_TEST_FAIL === "1") process.exit(1);',
    `console.log(${JSON.stringify(JSON.stringify(report))});`,
  ].join("\n"));
  const env = {
    ...process.env, OMT_MENUBAR_PREFS: prefs, OMT_REPORT_CACHE: reportCache,
    OMT_HOST_CLI: host, OMT_FORMAT: join(here, "format.mjs"),
    OMT_QUOTA_CACHE: emptyCache, OMT_USAGE_CACHE: emptyCache,
    OMT_DISABLE_QUOTA_SAMPLING: "1", OMT_TEST_CALLS: calls,
  };
  const run = (args = [], reason = "MenuAction", extraEnv = {}) => exec("bash", [join(here, "oh-my-tokens.1m.sh"), ...args], {
    env: { ...env, SWIFTBAR_PLUGIN_REFRESH_REASON: reason, ...extraEnv },
  });

  // A first menu action has no cache yet, so it must seed a real report.
  await run();
  assert.deepEqual(JSON.parse(await readFile(reportCache, "utf8")), report);
  await run(["--toggle-provider", "claude-code"]);
  const { stdout } = await run();
  assert.match(stdout, /^Claude Code · Off \|.*checked=false/m);
  assert.equal(await readFile(calls, "utf8"), "collect\n", "toggling must not trigger another host scan");
  assert.match(stdout, /Refresh \|.*param1=--refresh/);

  await run(["--refresh"]);
  await run(); // SwiftBar redraws after the explicit refresh action finishes.
  assert.equal(await readFile(calls, "utf8"), "collect\ncollect\n");
  await run([], "Schedule");
  assert.equal(await readFile(calls, "utf8"), "collect\ncollect\ncollect\n", "timer refreshes still collect new usage");

  const goodCache = await readFile(reportCache, "utf8");
  await assert.rejects(run([], "Schedule", { OMT_TEST_FAIL: "1" }));
  assert.equal(await readFile(reportCache, "utf8"), goodCache, "a failed collection must preserve the last usable report");
  assert.match((await run()).stdout, /^Claude Code · Off \|.*checked=false/m);
});
