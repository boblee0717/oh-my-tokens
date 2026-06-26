import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function metadataPath(homeDir = homedir()) {
  return join(homeDir, ".oh-my-tokens", "install.json");
}

async function readExisting(homeDir) {
  try {
    return JSON.parse(await readFile(metadataPath(homeDir), "utf8"));
  } catch {
    return {};
  }
}

function clean(updates) {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined && value !== ""),
  );
}

export async function writeInstallMetadata(updates, { homeDir = homedir() } = {}) {
  const existing = await readExisting(homeDir);
  const merged = { ...existing, ...clean(updates) };
  await mkdir(join(homeDir, ".oh-my-tokens"), { recursive: true });
  await writeFile(metadataPath(homeDir), JSON.stringify(merged, null, 2));
  return merged;
}

function boolEnv(value) {
  if (value == null || value === "") return undefined;
  return value === "1" || value === "true";
}

async function main() {
  await writeInstallMetadata({
    sourceRoot: process.env.OMT_SOURCE_ROOT,
    extensionId: process.env.OMT_EXTENSION_ID,
    browser: process.env.OMT_BROWSER,
    nativeHostInstalledAt: process.env.OMT_NATIVE_HOST_INSTALLED_AT,
    menubarInstalled: boolEnv(process.env.OMT_MENUBAR_INSTALLED),
    menubarInstalledAt: process.env.OMT_MENUBAR_INSTALLED_AT,
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(`failed to write oh-my-tokens install metadata: ${e.message}`);
    process.exitCode = 1;
  });
}
