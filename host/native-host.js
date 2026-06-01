import { buildUsageReport } from "./report.js";
import { writeQuotaCache } from "./quota-cache.js";

const HOST_VERSION = "0.0.0-m5";
const MAX_MESSAGE = 64 * 1024 * 1024;

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let need = -1;

    const onData = (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (need < 0 && buf.length >= 4) {
        need = buf.readUInt32LE(0);
        if (need > MAX_MESSAGE) {
          cleanup();
          reject(new Error(`message too large: ${need}`));
          return;
        }
      }
      if (need >= 0 && buf.length >= 4 + need) {
        cleanup();
        try {
          resolve(JSON.parse(buf.subarray(4, 4 + need).toString("utf8")));
        } catch (e) {
          reject(e);
        }
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
  });
}

function writeMessage(obj) {
  return new Promise((resolve, reject) => {
    const json = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    process.stdout.write(Buffer.concat([header, json]), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function main() {
  const req = (await readMessage());
  process.stdin.pause();

  // saveQuota: the popup pushes its browser-fetched quota_percent records so the
  // menu-bar plugin can show plan usage. Cache them and ack; don't build a report.
  if (req && req.type === "saveQuota") {
    const saved = await writeQuotaCache(req.records);
    await writeMessage({ ok: true, saved: saved.records.length });
    process.exitCode = 0;
    return;
  }

  const deepseekApiKey =
    req && typeof req.deepseekApiKey === "string" ? req.deepseekApiKey : undefined;
  const report = await buildUsageReport(HOST_VERSION, { deepseekApiKey });
  await writeMessage(report);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(`oh-my-tokens native host failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
});
