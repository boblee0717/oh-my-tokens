// Manual Windows check: spawn run-host.cmd exactly as Chrome would, send a framed
// native-messaging request, and validate the framed response survives the .cmd wrapper.
// Not part of the automated suite (Windows-only, touches the real shell). Run:
//   node host/test/winhost.manual.mjs
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("skip: winhost.manual.mjs is Windows-only");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const cmd = join(here, "..", "run-host.cmd");

function frame(message) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

const child = spawn("cmd.exe", ["/c", cmd], { stdio: ["pipe", "pipe", "pipe"] });
const out = [];
const err = [];
child.stdout.on("data", (c) => out.push(c));
child.stderr.on("data", (c) => err.push(c));
child.stdin.end(frame({ type: "getUsage" }));

child.on("exit", (code) => {
  const raw = Buffer.concat(out);
  const stderr = Buffer.concat(err).toString("utf8");
  if (raw.length < 4) {
    console.error("FAIL: no framed output. exit", code, "stderr:", stderr);
    process.exit(1);
  }
  const len = raw.readUInt32LE(0);
  if (raw.length !== 4 + len) {
    console.error(`FAIL: header says ${len} bytes but got ${raw.length - 4}. Stream corrupted by the wrapper?`);
    console.error("first bytes:", raw.subarray(0, 16));
    process.exit(1);
  }
  const report = JSON.parse(raw.subarray(4).toString("utf8"));
  console.log("PASS: framed response intact through run-host.cmd");
  console.log(`  exit=${code} headerLen=${len} records=${report.records.length} hostVersion=${report.hostVersion}`);
  if (stderr.trim()) console.log("  (stderr/log went to file, none leaked to stdout)");
});
