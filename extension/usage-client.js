// Data layer for the popup. Prefers the local Native Messaging host; falls back to
// a bundled synthetic sample so the UI is viewable before the host is installed (M5).

export const DEFAULT_HOST_NAME = "com.ohmytokens.host";
export const DEFAULT_NATIVE_TIMEOUT_MS = 10000;

function nativeErrorMessage(error) {
  if (!error) return "unknown native host error";
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && typeof error.message === "string") return error.message;
  return String(error);
}

function requestPayload(deepseekApiKey) {
  const payload = { type: "getUsage" };
  if (deepseekApiKey) payload.deepseekApiKey = deepseekApiKey;
  return payload;
}

function viaSendNativeMessage(hostName, deepseekApiKey, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("native host timeout"));
    }, timeoutMs);

    try {
      chrome.runtime.sendNativeMessage(hostName, requestPayload(deepseekApiKey), (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "native host disconnected"));
          return;
        }
        if (!msg) {
          reject(new Error("native host returned no response"));
          return;
        }
        resolve(msg);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

function viaNativePort(hostName, deepseekApiKey, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS) {
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
    }, timeoutMs);

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

    port.postMessage(requestPayload(deepseekApiKey));
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
// `deepseekApiKey` (from extension options) is forwarded to the host for the balance lookup.
export async function getUsageReport({
  hostName = DEFAULT_HOST_NAME,
  deepseekApiKey,
  nativeTimeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  let nativeError = "native messaging API unavailable in this context";
  if (
    typeof chrome !== "undefined" &&
    (chrome.runtime?.sendNativeMessage || chrome.runtime?.connectNative)
  ) {
    try {
      const report = chrome.runtime?.sendNativeMessage
        ? await viaSendNativeMessage(hostName, deepseekApiKey, nativeTimeoutMs)
        : await viaNativePort(hostName, deepseekApiKey, nativeTimeoutMs);
      report._source = "native";
      return report;
    } catch (e) {
      nativeError = nativeErrorMessage(e);
      // host not installed yet → preview with the sample
    }
  }
  const report = await viaSample();
  report._nativeError = nativeError;
  return report;
}
