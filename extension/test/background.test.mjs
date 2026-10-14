import { test } from "node:test";
import assert from "node:assert/strict";
import { saveUsageToHost } from "../usage-client.js";

test("background alarm syncs Fable tokens to the host using the browser session", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const listeners = {};
  const messages = [];
  let enabled = ["cursor"];
  let eventsFail = false;
  try {
    globalThis.chrome = {
      storage: { local: { get: async () => ({ enabledProviders: enabled }) } },
      runtime: {
        onInstalled: { addListener: (fn) => { listeners.install = fn; } },
        onStartup: { addListener: (fn) => { listeners.startup = fn; } },
        sendNativeMessage: (host, message, callback) => {
          assert.equal(host, "com.ohmytokens.host");
          messages.push(message);
          callback({ ok: true, saved: message.records.length });
        },
      },
      alarms: { create() {}, onAlarm: { addListener: (fn) => { listeners.alarm = fn; } } },
    };
    globalThis.fetch = async (url, options) => {
      assert.equal(options.credentials, "include");
      assert.ok(options.signal instanceof AbortSignal);
      const events = url.endsWith("get-filtered-usage-events");
      return {
        ok: !events || !eventsFail, status: events && eventsFail ? 500 : 200,
        json: async () => events ? {
          totalUsageEventsCount: 1,
          usageEventsDisplay: [{ timestamp: String(Date.now()), model: "claude-fable-5-1-thinking-high",
            tokenUsage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 56, totalCents: 25 } }],
        } : { totalPercentUsed: 4.3 },
      };
    };
    await import("../background.js");
    await listeners.alarm({ name: "omt-quota-refresh" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(messages[0].type, "saveQuota");
    const usage = messages.find((m) => m.type === "saveUsage");
    assert.ok(usage, "alarm must sync tokens, not just quota");
    const today = usage.records.find((r) => r.window === "today" && r.metricType === "measured_tokens");
    assert.equal(today.model, "claude-fable-5-1-thinking-high");
    assert.equal(today.inputTokens + today.outputTokens + today.cacheTokens, 102);

    messages.length = 0;
    eventsFail = true;
    await listeners.startup();
    assert.deepEqual(messages.map((m) => m.type), ["saveQuota"], "event errors must preserve the usage cache");
    messages.length = 0;
    enabled = [];
    await listeners.install();
    assert.deepEqual(messages, [], "disabled Cursor must not fetch or save");
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("usage sync rejects failed or incomplete native acknowledgements", async () => {
  const originalChrome = globalThis.chrome;
  try {
    for (const response of [{ ok: false }, { ok: true, saved: 0 }]) {
      globalThis.chrome = { runtime: { sendNativeMessage: (_, __, callback) => callback(response) } };
      await assert.rejects(saveUsageToHost([{ provider: "cursor", metricType: "measured_tokens" }]), /did not save/);
    }
  } finally {
    globalThis.chrome = originalChrome;
  }
});
