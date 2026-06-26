import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUpdate, checkUpdate, getUsageReport } from "../usage-client.js";

const sampleReport = {
  generatedAt: "2026-05-26T12:00:00.000Z",
  hostVersion: "0.0.0-sample",
  records: [],
  errors: [],
};

function listenerSet() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    emit(...args) {
      for (const fn of listeners) fn(...args);
    },
  };
}

test("sample fallback preserves the native host error for the UI", async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;

  const onMessage = listenerSet();
  const onDisconnect = listenerSet();
  const runtime = {
    lastError: null,
    getURL(path) {
      return `chrome-extension://test/${path}`;
    },
    connectNative(hostName) {
      assert.equal(hostName, "com.ohmytokens.host");
      return {
        onMessage,
        onDisconnect,
        postMessage() {
          runtime.lastError = { message: "Specified native messaging host not found." };
          queueMicrotask(() => onDisconnect.emit());
        },
        disconnect() {},
      };
    },
  };

  try {
    globalThis.chrome = { runtime };
    globalThis.fetch = async (url) => {
      assert.equal(url, "chrome-extension://test/sample-report.json");
      return { json: async () => ({ ...sampleReport }) };
    };

    const report = await getUsageReport();

    assert.equal(report._source, "sample");
    assert.match(report._nativeError, /Specified native messaging host not found/);
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});

test("native host response does not carry a fallback error", async () => {
  const originalChrome = globalThis.chrome;

  const onMessage = listenerSet();
  const onDisconnect = listenerSet();
  const runtime = {
    lastError: null,
    connectNative() {
      return {
        onMessage,
        onDisconnect,
        postMessage() {
          queueMicrotask(() => {
            onMessage.emit({ ...sampleReport, hostVersion: "0.0.0-native" });
            runtime.lastError = { message: "Native host has exited." };
            onDisconnect.emit();
          });
        },
        disconnect() {},
      };
    },
  };

  try {
    globalThis.chrome = { runtime };

    const report = await getUsageReport();

    assert.equal(report._source, "native");
    assert.equal(report._nativeError, undefined);
    assert.equal(report.hostVersion, "0.0.0-native");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("uses sendNativeMessage for one-shot native host requests when available", async () => {
  const originalChrome = globalThis.chrome;
  let sent = null;

  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      sent = { hostName, message };
      queueMicrotask(() => callback({ ...sampleReport, hostVersion: "0.0.0-native" }));
    },
    connectNative() {
      assert.fail("connectNative should not be used for a one-shot request");
    },
  };

  try {
    globalThis.chrome = { runtime };

    const report = await getUsageReport({ deepseekApiKey: "sk-test" });

    assert.deepEqual(sent, {
      hostName: "com.ohmytokens.host",
      message: { type: "getUsage", deepseekApiKey: "sk-test" },
    });
    assert.equal(report._source, "native");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("checkUpdate sends a native checkUpdate request", async () => {
  const originalChrome = globalThis.chrome;
  let sent = null;

  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      sent = { hostName, message };
      queueMicrotask(() => callback({ ok: true, update: { status: "available" } }));
    },
  };

  try {
    globalThis.chrome = { runtime };

    const result = await checkUpdate();

    assert.deepEqual(sent, {
      hostName: "com.ohmytokens.host",
      message: { type: "checkUpdate" },
    });
    assert.equal(result.update.status, "available");
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("applyUpdate sends a native applyUpdate request", async () => {
  const originalChrome = globalThis.chrome;
  let sent = null;

  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      sent = { hostName, message };
      queueMicrotask(() => callback({ ok: true, update: { status: "applied" }, steps: ["fetch"] }));
    },
  };

  try {
    globalThis.chrome = { runtime };

    const result = await applyUpdate();

    assert.deepEqual(sent, {
      hostName: "com.ohmytokens.host",
      message: { type: "applyUpdate" },
    });
    assert.equal(result.update.status, "applied");
    assert.deepEqual(result.steps, ["fetch"]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
