import path from "node:path";
import { pathToFileURL } from "node:url";

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
  process.argv = [process.argv[0], entry, ...forwardedArguments];
  await import(pathToFileURL(entry).href);
} finally {
  for (const [key, snapshot] of originalProfile) {
    if (snapshot.present) process.env[key] = snapshot.value;
    else delete process.env[key];
  }
}
