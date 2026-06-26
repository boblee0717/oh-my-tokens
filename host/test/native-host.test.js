import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hostPath = join(repoRoot, "host", "native-host.js");

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

async function runNativeHost(message, env = {}) {
  const home = await mkdtemp(join(tmpdir(), "oh-my-tokens-home-"));
  const child = spawn(process.execPath, [hostPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DEEPSEEK_API_KEY: "",
      TZ: "UTC",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(frame(message));

  let timeout;
  try {
    const exit = await Promise.race([
      new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("native host did not exit")), 5000);
      }),
    ]);
    clearTimeout(timeout);
    assert.equal(exit.code, 0, Buffer.concat(stderr).toString("utf8"));
    assert.equal(exit.signal, null);

    const raw = Buffer.concat(stdout);
    assert.ok(raw.length >= 4);
    const length = raw.readUInt32LE(0);
    assert.equal(raw.length, 4 + length);
    return JSON.parse(raw.subarray(4).toString("utf8"));
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
}

test("native host writes one framed response and exits cleanly", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-my-tokens-home-"));
  const child = spawn(process.execPath, [hostPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      // os.homedir() reads HOME on macOS/Linux but USERPROFILE on Windows; set both so
      // the host is isolated from the developer's real ~/.claude logs on every platform.
      HOME: home,
      USERPROFILE: home,
      DEEPSEEK_API_KEY: "",
      TZ: "UTC",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  child.stdin.end(frame({ type: "getUsage" }));

  let timeout;
  try {
    const exit = await Promise.race([
      new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("native host did not exit")), 5000);
      }),
    ]);
    clearTimeout(timeout);

    assert.equal(exit.code, 0, Buffer.concat(stderr).toString("utf8"));
    assert.equal(exit.signal, null);

    const raw = Buffer.concat(stdout);
    assert.ok(raw.length >= 4);
    const length = raw.readUInt32LE(0);
    assert.equal(raw.length, 4 + length);

    const report = JSON.parse(raw.subarray(4).toString("utf8"));
    assert.equal(report.hostVersion, "0.0.0-m5");
    assert.deepEqual(report.records, []);
    assert.deepEqual(report.errors, []);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});

test("native host routes checkUpdate requests", async () => {
  const msg = await runNativeHost(
    { type: "checkUpdate" },
    { OMT_SOURCE_ROOT: join(tmpdir(), "oh-my-tokens-missing-source") },
  );

  assert.equal(msg.ok, true);
  assert.equal(msg.update.status, "not_git_repo");
  assert.equal(msg.update.canApply, false);
});

test("native host routes applyUpdate requests", async () => {
  const msg = await runNativeHost(
    { type: "applyUpdate" },
    { OMT_SOURCE_ROOT: join(tmpdir(), "oh-my-tokens-missing-source") },
  );

  assert.equal(msg.ok, false);
  assert.equal(msg.update.status, "apply_failed");
  assert.match(msg.error, /not a git repository/i);
});

test("usage reports include update state when a source root is configured", async () => {
  const report = await runNativeHost(
    { type: "getUsage" },
    { OMT_SOURCE_ROOT: join(tmpdir(), "oh-my-tokens-missing-source") },
  );

  assert.equal(report.hostVersion, "0.0.0-m5");
  assert.equal(report.update.status, "not_git_repo");
  assert.equal(report.update.canApply, false);
});
