import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyUpdate, checkUpdate, getUpdateForReport } from "../update-manager.js";

const NOW = "2026-06-26T10:00:00.000Z";
const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "..", "update-manager.js");

function fakeExec(outputs, calls = []) {
  return async (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd });
    const key = [file, ...args].join(" ");
    if (!(key in outputs)) throw new Error(`unexpected command: ${key}`);
    const out = outputs[key];
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "" };
  };
}

function gitOutputs({ status = "", upstream = "origin/master", head = "local1234567890", remote = "remote1234567890" } = {}) {
  return {
    "git rev-parse --is-inside-work-tree": "true\n",
    "git status --porcelain": status,
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": `${upstream}\n`,
    "git rev-parse HEAD": `${head}\n`,
    [`git rev-parse ${upstream}`]: `${remote}\n`,
    "git fetch --prune origin": "",
  };
}

test("checkUpdate reports available when upstream ref differs", async () => {
  const calls = [];
  const update = await checkUpdate({
    sourceRoot: "/repo",
    now: () => new Date(NOW),
    execFile: fakeExec(gitOutputs(), calls),
  });

  assert.equal(update.status, "available");
  assert.equal(update.localRef, "local12");
  assert.equal(update.remoteRef, "remote1");
  assert.equal(update.remote, "origin");
  assert.equal(update.remoteBranch, "master");
  assert.equal(update.branch, "master");
  assert.equal(update.canApply, true);
  assert.equal(update.checkedAt, NOW);
  assert.deepEqual(
    calls.map((c) => [c.file, ...c.args].join(" ")),
    [
      "git rev-parse --is-inside-work-tree",
      "git status --porcelain",
      "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
      "git fetch --prune origin",
      "git rev-parse HEAD",
      "git rev-parse origin/master",
    ],
  );
});

test("checkUpdate refuses auto-apply on dirty worktree", async () => {
  const update = await checkUpdate({
    sourceRoot: "/repo",
    now: () => new Date(NOW),
    execFile: fakeExec(gitOutputs({ status: " M extension/popup.js\n" })),
  });

  assert.equal(update.status, "dirty");
  assert.equal(update.canApply, false);
  assert.match(update.message, /local changes/i);
});

test("applyUpdate fast-forwards source repo and reinstalls native host and menubar", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-update-home-"));
  const installJson = join(home, ".oh-my-tokens", "install.json");
  await mkdir(join(home, ".oh-my-tokens"), { recursive: true });
  await writeFile(
    installJson,
    JSON.stringify({
      sourceRoot: "/repo",
      extensionId: "obmkhlamcmbmacadoolbfaagmojdobah",
      browser: "chrome",
      menubarInstalled: true,
    }),
  );

  const calls = [];
  const outputs = {
    ...gitOutputs(),
    "git merge --ff-only origin/master": "Updating local..remote\nFast-forward\n",
    "/repo/host/install-macos.sh obmkhlamcmbmacadoolbfaagmojdobah chrome": "",
    "/repo/menubar/install-menubar.sh": "",
  };

  const result = await applyUpdate({
    homeDir: home,
    now: () => new Date(NOW),
    execFile: fakeExec(outputs, calls),
    platform: "darwin",
  });

  assert.equal(result.ok, true);
  assert.equal(result.update.status, "applied");
  assert.equal(result.update.localRef, "remote1");
  assert.deepEqual(result.steps, [
    "fetch",
    "fast-forward",
    "install-native-host",
    "install-menubar",
  ]);
  assert.deepEqual(
    calls.map((c) => [c.file, ...c.args].join(" ")).filter((cmd) => cmd.includes("merge") || cmd.includes("install")),
    [
      "git merge --ff-only origin/master",
      "/repo/host/install-macos.sh obmkhlamcmbmacadoolbfaagmojdobah chrome",
      "/repo/menubar/install-menubar.sh",
    ],
  );

  const statusCache = JSON.parse(await readFile(join(home, ".oh-my-tokens", "update-status.json"), "utf8"));
  assert.equal(statusCache.status, "applied");
  assert.equal(statusCache.remoteRef, "remote1");
});

test("getUpdateForReport reuses fresh cached status instead of fetching every render", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-update-cache-home-"));
  await mkdir(join(home, ".oh-my-tokens"), { recursive: true });
  await writeFile(
    join(home, ".oh-my-tokens", "update-status.json"),
    JSON.stringify({
      status: "available",
      localRef: "aaaa111",
      remoteRef: "bbbb222",
      checkedAt: "2026-06-26T09:50:00.000Z",
      canApply: true,
      message: "Update available",
    }),
  );

  const update = await getUpdateForReport({
    homeDir: home,
    metadata: { sourceRoot: "/repo" },
    now: () => new Date(NOW),
    cacheTtlMs: 30 * 60 * 1000,
    execFile: async () => {
      throw new Error("should not fetch while cache is fresh");
    },
  });

  assert.equal(update.status, "available");
  assert.equal(update.localRef, "aaaa111");
  assert.equal(update.remoteRef, "bbbb222");
});

test("getUpdateForReport ignores fresh cache from a different source root", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-update-cache-mismatch-home-"));
  await mkdir(join(home, ".oh-my-tokens"), { recursive: true });
  await writeFile(
    join(home, ".oh-my-tokens", "update-status.json"),
    JSON.stringify({
      status: "apply_failed",
      sourceRoot: "/tmp/old-app",
      checkedAt: "2026-06-26T09:59:00.000Z",
      canApply: false,
      message: "stale status from another checkout",
    }),
  );

  const update = await getUpdateForReport({
    homeDir: home,
    metadata: { sourceRoot: "/repo" },
    now: () => new Date(NOW),
    cacheTtlMs: 30 * 60 * 1000,
    execFile: fakeExec(gitOutputs({ head: "same1234567890", remote: "same1234567890" })),
  });

  assert.equal(update.status, "current");
  assert.equal(update.sourceRoot, "/repo");
});

test("update-manager CLI works when launched through a symlink path", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-update-cli-symlink-home-"));
  const realDir = await mkdtemp(join(tmpdir(), "omt-update-cli-real-"));
  const linkDir = join(tmpdir(), `omt-update-cli-link-${Date.now()}`);
  await symlink(dirname(helper), join(realDir, "host-link"));
  await symlink(realDir, linkDir);
  const helperViaSymlink = join(linkDir, "host-link", "update-manager.js");

  const child = spawn(process.execPath, [helperViaSymlink, "check"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMT_SOURCE_ROOT: join(home, "missing-repo"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", reject);
  });
  assert.equal(exit, 0, stderr);

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.update.status, "not_git_repo");
});
