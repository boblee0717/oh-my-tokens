import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Browser-level end-to-end: load the real unpacked extension in a Chromium browser, open
// the popup, and assert it renders LIVE native-host data (not the bundled sample) — i.e.
// the browser found our HKCU registry entry, launched run-host.cmd, and got a framed
// UsageReport back. This is the one leg the unit tests can't reach.
//
// Branded Google Chrome removed --load-extension under automation (March 2025), but
// Microsoft Edge still honors it, so we drive Edge. The test SKIPS unless: Windows + Edge
// installed + the host registered for Edge (`install.ps1 -Browser edge`) + a CDP-capable
// Node (global WebSocket, Node 22+). That keeps it green on macOS/Linux/CI by default and
// only runs where a real install exists.

const EXT_ID = "obmkhlamcmbmacadoolbfaagmojdobah";
const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "extension");
const POPUP = `chrome-extension://${EXT_ID}/popup.html`;
const PORT = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function hostRegisteredForEdge() {
  try {
    execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.ohmytokens.host"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const edge = process.platform === "win32" ? findEdge() : null;
const skip =
  process.platform !== "win32"
    ? "browser-level e2e is Windows-only (Edge honors --load-extension)"
    : typeof WebSocket === "undefined"
      ? "needs a Node with global WebSocket (>= 22) for the DevTools protocol"
      : !edge
        ? "Microsoft Edge not installed"
        : !hostRegisteredForEdge()
          ? "host not registered for Edge — run: install.ps1 -Browser edge"
          : false;

test("extension popup renders live native-host data in Edge", { skip }, async () => {
  const profile = await mkdtemp(join(tmpdir(), "omt-browser-e2e-"));
  const browser = spawn(edge, [
    `--user-data-dir=${profile}`,
    "--headless=new", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`,
    `--remote-debugging-port=${PORT}`, "about:blank",
  ], { stdio: "ignore" });

  let ws;
  try {
    let version;
    for (let i = 0; i < 80; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
      catch { await sleep(250); }
    }
    assert.ok(version, "Edge DevTools endpoint never came up");

    ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP websocket error")); });

    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const msg = { id: ++id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        pending.set(msg.id, { resolve, reject });
        ws.send(JSON.stringify(msg));
      });

    const { targetId } = await send("Target.createTarget", { url: POPUP });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Runtime.enable", {}, sessionId);
    await sleep(5000); // popup queries the native host on load

    const expr = `JSON.stringify({
      href: location.href,
      status: document.getElementById('status')?.textContent || '',
      bannerHidden: document.getElementById('preview-banner')?.classList.contains('hidden')
    })`;
    const { result } = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
    const dom = JSON.parse(result.value);

    assert.ok(dom.href.startsWith(`chrome-extension://${EXT_ID}/`), `extension didn't load (href=${dom.href})`);
    // popup.js sets status "updated …" only when the native host responded; "sample …" (and
    // a visible preview banner) means it fell back. This is the live-vs-sample signal.
    assert.ok(dom.status.startsWith("updated"), `popup is not on native data (status=${dom.status})`);
    assert.equal(dom.bannerHidden, true, "preview banner visible — native host did not connect");
  } finally {
    try { ws?.close(); } catch {}
    try { browser.kill(); } catch {}
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
});
