import { execFile as execFileCb } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileDefault = promisify(execFileCb);
const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_SOURCE_ROOT = join(HOST_DIR, "..");
const DEFAULT_EXTENSION_ID = "obmkhlamcmbmacadoolbfaagmojdobah";
const DEFAULT_REPORT_CACHE_TTL_MS = 30 * 60 * 1000;

function shortRef(ref) {
  return String(ref || "").trim().slice(0, 7);
}

function metaDir(homeDir = homedir()) {
  return join(homeDir, ".oh-my-tokens");
}

function installMetadataPath(homeDir = homedir()) {
  return join(metaDir(homeDir), "install.json");
}

function updateStatusPath(homeDir = homedir()) {
  return join(metaDir(homeDir), "update-status.json");
}

async function readInstallMetadata(homeDir = homedir()) {
  try {
    return JSON.parse(await readFile(installMetadataPath(homeDir), "utf8"));
  } catch {
    return {};
  }
}

async function writeUpdateStatus(update, homeDir = homedir()) {
  await mkdir(metaDir(homeDir), { recursive: true });
  await writeFile(updateStatusPath(homeDir), JSON.stringify(update, null, 2));
}

async function readUpdateStatus(homeDir = homedir()) {
  try {
    return JSON.parse(await readFile(updateStatusPath(homeDir), "utf8"));
  } catch {
    return null;
  }
}

function isFresh(update, now, ttlMs, sourceRoot) {
  if (!update?.checkedAt) return false;
  if (sourceRoot && update.sourceRoot && update.sourceRoot !== sourceRoot) return false;
  const checked = Date.parse(update.checkedAt);
  if (!Number.isFinite(checked)) return false;
  return now.getTime() - checked <= ttlMs;
}

async function run(execFile, file, args, opts = {}) {
  const result = await execFile(file, args, opts);
  return typeof result?.stdout === "string" ? result.stdout : String(result?.stdout || "");
}

async function git(execFile, sourceRoot, args) {
  return run(execFile, "git", args, { cwd: sourceRoot });
}

function splitUpstream(upstream) {
  const clean = String(upstream || "origin/master").trim() || "origin/master";
  const slash = clean.indexOf("/");
  if (slash < 0) return { upstream: clean, remote: "origin", remoteBranch: clean };
  return {
    upstream: clean,
    remote: clean.slice(0, slash),
    remoteBranch: clean.slice(slash + 1),
  };
}

async function resolveUpstream(execFile, sourceRoot) {
  try {
    return splitUpstream(await git(execFile, sourceRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]));
  } catch {
    try {
      return splitUpstream(await git(execFile, sourceRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]));
    } catch {
      return splitUpstream("origin/master");
    }
  }
}

async function resolveSourceRoot(opts, metadata) {
  return opts.sourceRoot || process.env.OMT_SOURCE_ROOT || metadata.sourceRoot || DEV_SOURCE_ROOT;
}

function updateBase({ status, sourceRoot, upstream, checkedAt, message, canApply }) {
  const { remote, remoteBranch } = upstream || splitUpstream("origin/master");
  return {
    status,
    sourceRoot,
    branch: remoteBranch,
    remote,
    remoteBranch,
    checkedAt,
    canApply,
    message,
  };
}

export async function checkUpdate(opts = {}) {
  const execFile = opts.execFile || execFileDefault;
  const now = opts.now || (() => new Date());
  const homeDir = opts.homeDir || homedir();
  const checkedAt = now().toISOString();
  const metadata = opts.metadata || await readInstallMetadata(homeDir);
  const sourceRoot = await resolveSourceRoot(opts, metadata);

  try {
    const inside = (await git(execFile, sourceRoot, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") {
      return updateBase({
        status: "not_git_repo",
        sourceRoot,
        checkedAt,
        message: "Source checkout is not a git repository",
        canApply: false,
      });
    }
  } catch (e) {
    return updateBase({
      status: "not_git_repo",
      sourceRoot,
      checkedAt,
      message: `Source checkout is not a git repository: ${e.message}`,
      canApply: false,
    });
  }

  let dirty;
  let upstream;
  try {
    dirty = (await git(execFile, sourceRoot, ["status", "--porcelain"])).trim();
    upstream = await resolveUpstream(execFile, sourceRoot);
  } catch (e) {
    return updateBase({
      status: "checking_failed",
      sourceRoot,
      checkedAt,
      message: e.message,
      canApply: false,
    });
  }
  if (dirty) {
    return {
      ...updateBase({
        status: "dirty",
        sourceRoot,
        upstream,
        checkedAt,
        message: "Local changes present; automatic update is disabled",
        canApply: false,
      }),
      dirty,
    };
  }

  try {
    await git(execFile, sourceRoot, ["fetch", "--prune", upstream.remote]);
    const localFull = (await git(execFile, sourceRoot, ["rev-parse", "HEAD"])).trim();
    const remoteFull = (await git(execFile, sourceRoot, ["rev-parse", upstream.upstream])).trim();
    const localRef = shortRef(localFull);
    const remoteRef = shortRef(remoteFull);
    const current = localFull === remoteFull;
    return {
      ...updateBase({
        status: current ? "current" : "available",
        sourceRoot,
        upstream,
        checkedAt,
        message: current ? "Already up to date" : "Update available",
        canApply: !current,
      }),
      localRef,
      remoteRef,
    };
  } catch (e) {
    return updateBase({
      status: "checking_failed",
      sourceRoot,
      upstream,
      checkedAt,
      message: e.message,
      canApply: false,
    });
  }
}

export async function getUpdateForReport(opts = {}) {
  const homeDir = opts.homeDir || homedir();
  const metadata = opts.metadata || await readInstallMetadata(homeDir);
  const sourceRoot = opts.sourceRoot || process.env.OMT_SOURCE_ROOT || metadata.sourceRoot;
  if (!sourceRoot) return null;
  const now = opts.now || (() => new Date());
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_REPORT_CACHE_TTL_MS;
  const cached = await readUpdateStatus(homeDir);
  if (cacheTtlMs > 0 && isFresh(cached, now(), cacheTtlMs, sourceRoot)) return cached;
  const update = await checkUpdate({ ...opts, homeDir, metadata, sourceRoot, now });
  try {
    await writeUpdateStatus(update, homeDir);
  } catch {
  }
  return update;
}

export async function applyUpdate(opts = {}) {
  const execFile = opts.execFile || execFileDefault;
  const now = opts.now || (() => new Date());
  const homeDir = opts.homeDir || homedir();
  const platform = opts.platform || process.platform;
  const metadata = opts.metadata || await readInstallMetadata(homeDir);
  const sourceRoot = await resolveSourceRoot(opts, metadata);
  const steps = [];

  const before = await checkUpdate({ ...opts, sourceRoot, metadata, execFile, now, homeDir });
  if (!before.canApply || before.status !== "available") {
    const update = { ...before, status: before.status === "dirty" ? "dirty" : "apply_failed" };
    await writeUpdateStatus(update, homeDir);
    return { ok: false, update, steps, error: before.message || "No applicable update" };
  }

  try {
    steps.push("fetch");
    await git(execFile, sourceRoot, ["fetch", "--prune", before.remote]);
    steps.push("fast-forward");
    await git(execFile, sourceRoot, ["merge", "--ff-only", `${before.remote}/${before.remoteBranch}`]);

    if (platform === "darwin") {
      const extensionId = metadata.extensionId || DEFAULT_EXTENSION_ID;
      const browser = metadata.browser || "chrome";
      steps.push("install-native-host");
      await run(execFile, join(sourceRoot, "host", "install-macos.sh"), [extensionId, browser]);
      if (metadata.menubarInstalled) {
        steps.push("install-menubar");
        await run(execFile, join(sourceRoot, "menubar", "install-menubar.sh"), []);
      }
    }

    const checkedAt = now().toISOString();
    const update = {
      ...before,
      status: "applied",
      localRef: before.remoteRef,
      checkedAt,
      canApply: false,
      message: "Update applied",
    };
    await writeUpdateStatus(update, homeDir);
    return { ok: true, update, steps };
  } catch (e) {
    const update = {
      ...before,
      status: "apply_failed",
      checkedAt: now().toISOString(),
      canApply: false,
      message: e.message,
    };
    await writeUpdateStatus(update, homeDir);
    return { ok: false, update, steps, error: e.message };
  }
}

export const paths = {
  installMetadataPath,
  updateStatusPath,
};

async function main() {
  const cmd = process.argv[2] || "check";
  const result = cmd === "apply" ? await applyUpdate() : { ok: true, update: await checkUpdate() };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.ok === false) process.exitCode = 1;
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
    console.error(`oh-my-tokens update failed: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  });
}
