import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end native-messaging test through the OS launcher the browser actually spawns:
// Windows -> `cmd.exe /c run-host.cmd`, elsewhere -> the bash `run-host.sh`. This is the
// same chain the extension popup exercises (wrapper -> node native-host.js -> framed
// UsageReport on stdout), and it specifically guards the Windows risk that a .cmd wrapper
// could corrupt the length-prefixed binary stream. (The in-browser leg — Chrome reading
// the registry and rendering the popup — is verified manually; branded Chrome won't load
// an unpacked extension under automation, so it can't run in CI.)

const hostDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const wrapper = isWin ? "run-host.cmd" : "run-host.sh";

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function spawnWrapper(env) {
  const path = join(hostDir, wrapper);
  // Match how the browser launches it: cmd.exe runs a .cmd; the .sh has a shebang but we
  // invoke bash explicitly so the test doesn't depend on the file's +x bit after a clone.
  const [cmd, args] = isWin ? ["cmd.exe", ["/c", path]] : ["bash", [path]];
  return spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
}

test(`${wrapper} returns one framed UsageReport over stdio`, async () => {
  // Isolate from real ~/.claude/~/.codex logs so records are deterministic. os.homedir()
  // reads HOME on POSIX but USERPROFILE on Windows, so set both.
  const home = await mkdtemp(join(tmpdir(), "oh-my-tokens-e2e-"));
  const child = spawnWrapper({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    DEEPSEEK_API_KEY: "",
    TZ: "UTC",
  });

  const out = [];
  const err = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  child.stdin.end(frame({ type: "getUsage" }));

  try {
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wrapper did not exit in time")), 10000);
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      child.on("error", reject);
    });

    const raw = Buffer.concat(out);
    assert.equal(exit, 0, Buffer.concat(err).toString("utf8") || "non-zero exit");
    assert.ok(raw.length >= 4, "no framed output on stdout");
    const len = raw.readUInt32LE(0);
    // The header length matching the body proves the wrapper didn't inject bytes into the
    // binary stream (the .cmd CRLF / stray-stdout corruption risk on Windows).
    assert.equal(raw.length, 4 + len, "stdout corrupted: header length != body length");

    const report = JSON.parse(raw.subarray(4).toString("utf8"));
    assert.equal(report.hostVersion, "0.0.0-m5");
    assert.ok(Array.isArray(report.records));
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.records, []); // isolated HOME -> no local logs -> empty
  } finally {
    child.kill("SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});
