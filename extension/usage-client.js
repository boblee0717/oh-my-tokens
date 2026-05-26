// Data layer for the popup. Prefers the local Native Messaging host; falls back to
// a bundled synthetic sample so the UI is viewable before the host is installed (M5).

export const DEFAULT_HOST_NAME = "com.ohmytokens.host";
const NATIVE_TIMEOUT_MS = 4000;

function viaNativeHost(hostName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;
    try {
      port = chrome.runtime.connectNative(hostName);
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      reject(new Error("native host timeout"));
    }, NATIVE_TIMEOUT_MS);

    port.onMessage.addListener((msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch {}
      resolve(msg);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(chrome.runtime.lastError?.message || "native host disconnected"));
    });

    port.postMessage({ type: "getUsage" });
  });
}

async function viaSample() {
  const url =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL("sample-report.json")
      : "sample-report.json";
  const res = await fetch(url);
  const report = await res.json();
  report._source = "sample";
  return report;
}

// Returns a UsageReport. `_source` is "native" or "sample" so the UI can flag preview mode.
export async function getUsageReport({ hostName = DEFAULT_HOST_NAME } = {}) {
  if (typeof chrome !== "undefined" && chrome.runtime?.connectNative) {
    try {
      const report = await viaNativeHost(hostName);
      report._source = "native";
      return report;
    } catch {
      // host not installed yet → preview with the sample
    }
  }
  return viaSample();
}
