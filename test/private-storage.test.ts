import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { assertPrivateDirectory, assertPrivateFile, createPrivateFile, createPrivateTemporaryFile, ensurePrivateDirectory, protectPrivateDirectory } from "../src/private-storage.js";

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

    const broadParent = path.join(base, "broad-parent");
    await ensurePrivateDirectory(broadParent);
    await grantBroadRead(broadParent);
    await assert.rejects(createPrivateFile(path.join(broadParent, "must-not-contain-secret"), "secret"), /Private storage/);
  } finally {
    await cleanup(base);
  }
}

test("REMOTE-NR-002: Windows ACLs protect new files, rename results, and reject broad existing ACLs", { skip: process.platform !== "win32" }, runPrivateStorageChecks);
test("REMOTE-NR-002: POSIX permissions protect new files, rename results, and reject broad existing modes", { skip: process.platform === "win32" }, runPrivateStorageChecks);
