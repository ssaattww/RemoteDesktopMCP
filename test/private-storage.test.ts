import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { assertPrivateDirectory, assertPrivateFile, assertSafePrivateParent, createPrivateFile, createPrivateTemporaryFile, ensurePrivateDirectory, protectPrivateDirectory } from "../src/private-storage.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(process.cwd());
const validation = path.resolve(workspace, "reference", "validation");

const inside = (parent: string, candidate: string) => {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

async function privateBase() {
  await mkdir(validation, { recursive: true });
  const base = await mkdtemp(path.join(validation, "rdmcp-private-storage-"));
  await protectPrivateDirectory(base);
  return base;
}

async function cleanup(base: string) {
  const resolvedValidation = await import("node:fs/promises").then(({ realpath }) => realpath(validation));
  const resolvedBase = await import("node:fs/promises").then(({ realpath }) => realpath(base));
  if (!inside(resolvedValidation, resolvedBase)) throw new Error("Private storage test cleanup escaped validation.");
  await rm(resolvedBase, { recursive: true, force: true, maxRetries: 3 });
}

async function grantBroadRead(target: string) {
  if (process.platform === "win32") {
    await execFileAsync("icacls.exe", [target, "/grant", "*S-1-5-32-545:(RX)"], { windowsHide: true });
    return;
  }
  await chmod(target, 0o755);
}

async function grantBroadWrite(target: string) {
  if (process.platform === "win32") {
    await execFileAsync("icacls.exe", [target, "/grant", "*S-1-5-32-545:(OI)(CI)(M)"], { windowsHide: true });
    return;
  }
  await chmod(target, 0o733);
}

async function setUntrustedOwner(target: string) {
  if (process.platform === "win32") {
    await execFileAsync("icacls.exe", [target, "/setowner", "*S-1-5-32-545"], { windowsHide: true });
  }
}

async function runPrivateStorageChecks() {
  const base = await privateBase();
  try {
    const storage = path.join(base, "data");
    await ensurePrivateDirectory(storage);
    await assertPrivateDirectory(storage);

    const state = path.join(storage, "oauth-state.json");
    await createPrivateFile(state, "secret-state");
    await assertPrivateFile(state);
    assert.equal((await lstat(state)).isFile(), true);

    const temporary = await createPrivateTemporaryFile(storage, "oauth-state");
    await writeFile(temporary, "new-secret-state");
    await assertPrivateFile(temporary);
    await rename(temporary, state);
    await assertPrivateFile(state);

    await grantBroadRead(state);
    await assert.rejects(assertPrivateFile(state), /Private storage/);

    const readonlyParent = path.join(base, "readonly-parent");
    await ensurePrivateDirectory(readonlyParent);
    await grantBroadRead(readonlyParent);
    await assertSafePrivateParent(readonlyParent);
    const readonlyDirectory = path.join(readonlyParent, "safe-new-directory");
    await ensurePrivateDirectory(readonlyDirectory);
    await assertPrivateDirectory(readonlyDirectory);
    const readonlyChild = path.join(readonlyParent, "safe-new-secret");
    await createPrivateFile(readonlyChild, "secret");
    await assertPrivateFile(readonlyChild);

    const foreignOwnerParent = path.join(base, "foreign-owner-parent");
    await ensurePrivateDirectory(foreignOwnerParent);
    await grantBroadRead(foreignOwnerParent);
    await setUntrustedOwner(foreignOwnerParent);
    const foreignOwnerChild = path.join(foreignOwnerParent, "must-not-contain-secret");
    if (process.platform === "win32") {
      await assert.rejects(assertSafePrivateParent(foreignOwnerParent), /Private storage/);
      await assert.rejects(createPrivateFile(foreignOwnerChild, "secret"), /Private storage/);
      await assert.rejects(lstat(foreignOwnerChild), /ENOENT/);
    }

    const unsafeParent = path.join(base, "unsafe-parent");
    await ensurePrivateDirectory(unsafeParent);
    await grantBroadWrite(unsafeParent);
    const rejected = path.join(unsafeParent, "must-not-contain-secret");
    await assert.rejects(createPrivateFile(rejected, "secret"), /Private storage/);
    await assert.rejects(lstat(rejected), /ENOENT/);
  } finally {
    await cleanup(base);
  }
}

test("REMOTE-NR-002: Windows ACLs protect private leaves, allow readonly parents, and reject untrusted writes or owners", { skip: process.platform !== "win32" }, runPrivateStorageChecks);
test("REMOTE-NR-002: POSIX permissions protect private leaves, allow readonly parents, and reject untrusted writes", { skip: process.platform === "win32" }, runPrivateStorageChecks);
