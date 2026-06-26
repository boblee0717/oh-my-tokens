import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeInstallMetadata } from "../install-metadata.js";

const here = dirname(fileURLToPath(import.meta.url));
const helper = join(here, "..", "install-metadata.js");

test("writeInstallMetadata merges installer fields without dropping existing state", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-install-meta-"));

  await writeInstallMetadata(
    {
      sourceRoot: "/repo",
      extensionId: "obmkhlamcmbmacadoolbfaagmojdobah",
      browser: "chrome",
      nativeHostInstalledAt: "2026-06-26T10:00:00.000Z",
      menubarInstalled: true,
      menubarInstalledAt: "2026-06-26T09:00:00.000Z",
    },
    { homeDir: home },
  );
  await writeInstallMetadata(
    {
      sourceRoot: "/repo2",
      browser: "edge",
      nativeHostInstalledAt: "2026-06-26T11:00:00.000Z",
    },
    { homeDir: home },
  );

  const saved = JSON.parse(await readFile(join(home, ".oh-my-tokens", "install.json"), "utf8"));
  assert.equal(saved.sourceRoot, "/repo2");
  assert.equal(saved.extensionId, "obmkhlamcmbmacadoolbfaagmojdobah");
  assert.equal(saved.browser, "edge");
  assert.equal(saved.nativeHostInstalledAt, "2026-06-26T11:00:00.000Z");
  assert.equal(saved.menubarInstalled, true);
  assert.equal(saved.menubarInstalledAt, "2026-06-26T09:00:00.000Z");
});

test("install-metadata CLI writes environment fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-install-meta-cli-"));
  const child = spawn(process.execPath, [helper], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMT_SOURCE_ROOT: "/repo",
      OMT_EXTENSION_ID: "obmkhlamcmbmacadoolbfaagmojdobah",
      OMT_BROWSER: "chrome",
      OMT_NATIVE_HOST_INSTALLED_AT: "2026-06-26T10:00:00Z",
      OMT_MENUBAR_INSTALLED: "1",
      OMT_MENUBAR_INSTALLED_AT: "2026-06-26T10:01:00Z",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", reject);
  });
  assert.equal(exit, 0);

  const saved = JSON.parse(await readFile(join(home, ".oh-my-tokens", "install.json"), "utf8"));
  assert.equal(saved.sourceRoot, "/repo");
  assert.equal(saved.extensionId, "obmkhlamcmbmacadoolbfaagmojdobah");
  assert.equal(saved.browser, "chrome");
  assert.equal(saved.nativeHostInstalledAt, "2026-06-26T10:00:00Z");
  assert.equal(saved.menubarInstalled, true);
  assert.equal(saved.menubarInstalledAt, "2026-06-26T10:01:00Z");
});

test("install-metadata CLI works when launched through a symlink path", async () => {
  const home = await mkdtemp(join(tmpdir(), "omt-install-meta-symlink-home-"));
  const realDir = await mkdtemp(join(tmpdir(), "omt-install-meta-real-"));
  const linkDir = join(tmpdir(), `omt-install-meta-link-${Date.now()}`);
  await mkdir(join(realDir, "host"), { recursive: true });
  await symlink(dirname(helper), join(realDir, "host-link"));
  await symlink(realDir, linkDir);
  const helperViaSymlink = join(linkDir, "host-link", "install-metadata.js");

  const child = spawn(process.execPath, [helperViaSymlink], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMT_SOURCE_ROOT: "/repo-through-symlink",
      OMT_NATIVE_HOST_INSTALLED_AT: "2026-06-26T10:02:00Z",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exit = await new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", reject);
  });
  assert.equal(exit, 0);

  const saved = JSON.parse(await readFile(join(home, ".oh-my-tokens", "install.json"), "utf8"));
  assert.equal(saved.sourceRoot, "/repo-through-symlink");
  assert.equal(saved.nativeHostInstalledAt, "2026-06-26T10:02:00Z");
});
