import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { installDesktopCommanderOwnership, isOwnershipContextActive, ownedProcessWorkingDirectory } from "./desktop-commander-ownership.mjs";
import { prepareWindowsJobLauncher } from "./windows-job-launcher.mjs";

const [, , entryArgument, configArgument, ...forwardedArguments] = process.argv;
if (!entryArgument || !configArgument) {
  throw new Error("Desktop Commander bootstrap requires an entry module and config path.");
}

const entry = path.resolve(entryArgument);
const configPath = path.resolve(configArgument);
const isolatedHome = path.dirname(path.dirname(configPath));
const profileKeys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"];
const originalProfile = new Map(profileKeys.map((key) => [key, {
  present: Object.prototype.hasOwnProperty.call(process.env, key),
  value: process.env[key],
}]));
const drive = path.parse(isolatedHome).root;

Object.assign(process.env, {
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  APPDATA: path.join(isolatedHome, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(isolatedHome, "AppData", "Local"),
  HOMEDRIVE: drive,
  HOMEPATH: isolatedHome.slice(drive.length),
});

try {
  const configModule = pathToFileURL(path.join(path.dirname(entry), "config-manager.js")).href;
  const imported = await import(configModule);
  const configManager = imported.configManager;
  if (!configManager || typeof configManager !== "object" || !("configPath" in configManager)) {
    throw new Error("Desktop Commander config manager is unavailable.");
  }

  configManager.configPath = configPath;
  if (process.platform === "win32") {
    // terminal-manager imports `spawn` by name. Update the builtin ESM export
    // before it is loaded, so only owner-context process starts become Job
    // roots that remain alive until every managed descendant exits.
    const wrapSpawn = await prepareWindowsJobLauncher(isolatedHome);
    childProcess.spawn = wrapSpawn(childProcess.spawn, isOwnershipContextActive);
  }
  // Desktop Commander imports spawn by name. Keep the working directory tied
  // to the authenticated session's owned start_process call on every platform.
  const spawnWithOwnedCwd = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const cwd = ownedProcessWorkingDirectory();
    if (!cwd) return spawnWithOwnedCwd(...args);
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
    const options = args[optionsIndex];
    const next = args.slice();
    next[optionsIndex] = { ...(options && typeof options === "object" ? options : {}), cwd };
    return spawnWithOwnedCwd(...next);
  };
  syncBuiltinESMExports();
  // The bridge must be installed before Desktop Commander imports server.js
  // and registers its handlers. It deliberately supports the pinned package
  // layout only; a different entry cannot silently bypass owner isolation.
  await installDesktopCommanderOwnership(entry);
  // Desktop Commander normally sends SIGINT/SIGKILL to only the shell it
  // started. On Windows, terminate the verified manager-owned root process
  // tree as well. `getSession` binds the numeric PID to a live Commander
  // ChildProcess before taskkill is invoked, avoiding a blind PID kill.
  if (process.platform === "win32") {
    const terminalModule = await import(pathToFileURL(path.join(path.dirname(entry), "terminal-manager.js")).href);
    const terminalManager = terminalModule.terminalManager;
    const originalTerminate = terminalManager?.forceTerminate?.bind(terminalManager);
    if (!terminalManager || typeof terminalManager.getSession !== "function" || typeof originalTerminate !== "function") throw new Error("Desktop Commander terminal manager is unavailable.");
    terminalManager.forceTerminate = (pid) => {
      const session = terminalManager.getSession(pid);
      const child = session?.process;
      if (!child || child.pid !== pid || child.exitCode !== null) return false;
      const outcome = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, timeout: 2_000 });
      if (outcome.error || outcome.status !== 0) return originalTerminate(pid);
      return true;
    };
  }
  process.argv = [process.argv[0], entry, ...forwardedArguments];
  await import(pathToFileURL(entry).href);
} finally {
  for (const [key, snapshot] of originalProfile) {
    if (snapshot.present) process.env[key] = snapshot.value;
    else delete process.env[key];
  }
}
