import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCodexQuota, parseCodexQuota, CODEX_QUOTA_SOURCE } from "../codex-quota.js";

const snapshot = { rateLimitsByLimitId: { codex: {
  limitId: "codex", planType: "plus",
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791467822 },
  secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1792031613 },
} } };
const server = `
const rl = require('node:readline').createInterface({input:process.stdin});
let initialized = false;
rl.on('line', s => {
  const x = JSON.parse(s);
  if (x.method === 'initialize') console.log(JSON.stringify({id:x.id,result:{}}));
  else if (x.method === 'initialized') initialized = true;
  else if (x.method === 'account/rateLimits/read' && initialized) console.log(JSON.stringify({id:x.id,result:${JSON.stringify(snapshot)}}));
  else process.exit(9);
});`;

test("maps the canonical bucket and window durations, including zero usage", () => {
  const records = parseCodexQuota({ ...snapshot, rateLimits: { limitId: "spark", primary: { usedPercent: 99, windowDurationMins: 300 } } });
  assert.deepEqual(records.map(r => [r.windowLabel, r.usedPercent]), [["5h", 0], ["Weekly", 12]]);
  assert.equal(records[0].source, CODEX_QUOTA_SOURCE);
  assert.equal(records[0].resetsAt, "2026-10-08T13:57:02.000Z");
  assert.deepEqual(parseCodexQuota({rateLimitsByLimitId:{spark:snapshot.rateLimitsByLimitId.codex}}), []);
  assert.deepEqual(parseCodexQuota({rateLimits:{limitId:"spark",primary:{usedPercent:5,windowDurationMins:300}}}), []);
  assert.equal(parseCodexQuota({rateLimits:snapshot.rateLimitsByLimitId.codex}).length, 2);
  assert.deepEqual(parseCodexQuota({rateLimits:{primary:{usedPercent:null,windowDurationMins:300}}}), []);
});

test("performs the handshake and quota read without starting inference", async () => {
  const result = await fetchCodexQuota({spawnProcess:() => spawn(process.execPath, ["-e", server])});
  assert.equal(result.status, "ok");
  assert.equal(result.records.length, 2);
});

test("ignores server requests with matching ids and accepts a reply before immediate exit", async () => {
  const exitServer = `
  require('node:readline').createInterface({input:process.stdin}).on('line', s => {
    const x = JSON.parse(s);
    if (x.method === 'initialize') console.log(JSON.stringify({id:x.id,result:{}}));
    if (x.method === 'account/rateLimits/read') {
      console.log(JSON.stringify({id:2,method:'server/request',params:{}}));
      process.stdout.write(JSON.stringify({id:2,result:${JSON.stringify(snapshot)}})+'\\n', () => process.exit(0));
    }
  });`;
  const result = await fetchCodexQuota({spawnProcess:() => spawn(process.execPath, ["-e", exitServer])});
  assert.equal(result.status, "ok");
  assert.equal(result.records.length, 2);
});

test("timeout and RPC error terminate the child and return no replacement records", async () => {
  for (const script of ["setInterval(()=>{},1000)", "console.log(JSON.stringify({id:1,error:{code:-1}}));setInterval(()=>{},1000)"]) {
    let child;
    const result = await fetchCodexQuota({timeoutMs:150,spawnProcess:() => (child = spawn(process.execPath,["-e",script]))});
    assert.deepEqual(result, {status:"error",records:[]});
    await new Promise(resolve => child.exitCode != null || child.signalCode != null ? resolve() : child.once("exit",resolve));
  }
  assert.deepEqual(await fetchCodexQuota({command:"/missing/omt-codex"}), {status:"error",records:[]});
});

test("scheduled refresh polls despite fresh log quota, throttles active reads, and retains cache on failure", async () => {
  const home = await mkdtemp(join(tmpdir(),"omt-codex-refresh-"));
  try {
    const base = join(home,".oh-my-tokens");
    await mkdir(base);
    const binary = join(home,"codex");
    const calls = join(home,"calls");
    const mark = `require('node:fs').appendFileSync(${JSON.stringify(calls)},'call\\n');`;
    await writeFile(binary, `#!/usr/bin/env node\n${mark}\n${server}`, {mode:0o755});
    await writeFile(join(base,"menubar-prefs.json"), JSON.stringify({hiddenProviders:["cursor","kimi"]}));
    const path = join(base,"quota-cache.json");
    const old = {provider:"codex",metricType:"quota_percent",source:"~/.codex",usedPercent:48,updatedAt:new Date().toISOString()};
    const other = {provider:"claude-code",metricType:"quota_percent",usedPercent:1};
    await writeFile(path,JSON.stringify({records:[old,other]}));
    const run = () => promisify(execFile)(process.execPath,[fileURLToPath(new URL("../refresh-quota.js",import.meta.url))], {
      env:{...process.env,PATH:"/usr/bin:/bin",HOME:home,USERPROFILE:home,OMT_CODEX_BIN:binary,OMT_MENUBAR_PREFS:join(base,"menubar-prefs.json")},
    });
    await run();
    const fresh = await readFile(path,"utf8");
    const records = JSON.parse(fresh).records;
    assert.deepEqual(records.find(r=>r.provider==="claude-code"),other);
    assert.deepEqual(records.filter(r=>r.provider==="codex").map(r=>r.usedPercent),[0,12]);
    await writeFile(binary, `#!${process.execPath}\n${mark}\nprocess.exit(3)`, {mode:0o755});
    await run();
    assert.equal(await readFile(path,"utf8"),fresh);
    assert.equal(await readFile(calls,"utf8"),"call\n");
    const stale = JSON.parse(fresh);
    for (const r of stale.records) if(r.provider==="codex") r.updatedAt="2026-01-01T00:00:00Z";
    await writeFile(path,JSON.stringify(stale));
    await run();
    assert.deepEqual(JSON.parse(await readFile(path,"utf8")),stale);
    assert.equal(await readFile(calls,"utf8"),"call\ncall\n");
  } finally { await rm(home,{recursive:true,force:true}); }
});
