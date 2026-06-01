import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, rmSync } from "node:fs";

// Read & decrypt cookies from a Chromium browser's cookie store (macOS, "v10" scheme:
// AES-128-CBC with a key derived from the "<App> Safe Storage" Keychain password).
// Used so the host can reuse the user's existing site login (e.g. cursor.com) to fetch
// login-gated usage WITHOUT the browser being open. Cookie values stay local and are only
// sent to the site they belong to. Best-effort: any failure returns {} rather than throwing.

const BROWSERS = {
  chrome: {
    cookies: "Library/Application Support/Google/Chrome/Default/Cookies",
    keychain: "Chrome Safe Storage",
  },
};

function keychainKey(service) {
  // Bob authorized this once ("Always Allow"); subsequent reads don't prompt.
  const pw = execFileSync("security", ["find-generic-password", "-ws", service], {
    encoding: "utf8",
  }).trim();
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function unpad(buf) {
  const n = buf[buf.length - 1];
  return n > 0 && n <= 16 ? buf.subarray(0, buf.length - n) : buf;
}
function toStr(buf) {
  // Chrome >=130 prepends a 32-byte SHA256(domain) to the plaintext; strip if non-printable.
  if (buf.length > 32 && !buf.subarray(0, 32).every((b) => b >= 32 && b < 127)) {
    return buf.subarray(32).toString("utf8");
  }
  return buf.toString("utf8");
}
function decryptValue(hex, key) {
  const enc = Buffer.from(hex, "hex");
  if (enc.subarray(0, 3).toString() !== "v10") return null; // app-bound (v20) unsupported
  const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  d.setAutoPadding(false);
  return toStr(unpad(Buffer.concat([d.update(enc.subarray(3)), d.final()])));
}

// Returns { name: value } for cookies whose host_key matches the SQL LIKE pattern.
export function getCookies(hostLike, browser = "chrome") {
  const cfg = BROWSERS[browser];
  if (!cfg) return {};
  const dbPath = join(homedir(), cfg.cookies);
  const tmp = join(tmpdir(), `omt-ck-${process.pid}.db`);
  try {
    copyFileSync(dbPath, tmp); // Chrome may hold a lock; a copy is always readable
    const rows = execFileSync(
      "sqlite3",
      ["-readonly", tmp, `SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '${hostLike}';`],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const key = keychainKey(cfg.keychain);
    const out = {};
    for (const r of rows) {
      const i = r.indexOf("|");
      const name = r.slice(0, i);
      const hex = r.slice(i + 1);
      try {
        const v = decryptValue(hex, key);
        if (v) out[name] = v;
      } catch {
        // skip individual cookie that fails to decrypt
      }
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

export function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
