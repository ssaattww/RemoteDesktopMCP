import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./windows-job-runner.cs", import.meta.url));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function assertNoSymlinkPath(directory) {
  const absolute = path.resolve(directory);
  const { root } = path.parse(absolute);
  let current = root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const component of ["", ...components]) {
    if (component) current = path.join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) { throw new Error(`Private runner path is unavailable: ${current}: ${error.message}`); }
    if (info.isSymbolicLink()) throw new Error(`Private runner path contains a symbolic link: ${current}`);
    if (!info.isDirectory()) throw new Error(`Private runner path component is not a directory: ${current}`);
  }
}

async function readVerifiedRunner(runnerPath, manifestPath, sourceHash) {
  let runnerInfo;
  let manifestInfo;
  try {
    [runnerInfo, manifestInfo] = await Promise.all([lstat(runnerPath), lstat(manifestPath)]);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (runnerInfo.isSymbolicLink() || manifestInfo.isSymbolicLink()) {
    throw new Error("The cached Windows Job Object runner or manifest is a symbolic link.");
  }
  if (!runnerInfo.isFile() || !manifestInfo.isFile()) return false;
  try {
    const [binary, manifestText] = await Promise.all([readFile(runnerPath), readFile(manifestPath, "utf8")]);
    const manifest = JSON.parse(manifestText);
    return manifest?.sourceSha256 === sourceHash && manifest?.runnerSha256 === sha256(binary);
  } catch {
    return false;
  }
}

async function removeRegularCacheFile(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to replace unsafe cache entry: ${filePath}`);
    await rm(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function findCSharpCompiler() {
  const windows = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Compile the Windows Job Object runner into the isolated private data directory.
 * The returned spawn wrapper is synchronous and can replace child_process.spawn.
 * `isOwned` must return true only inside an active Desktop Commander owner context.
 */
export async function prepareWindowsJobLauncher(dataDir) {
  if (process.platform !== "win32") {
    return (originalSpawn) => originalSpawn;
  }
  if (typeof dataDir !== "string" || dataDir.length === 0) throw new TypeError("A private data directory is required.");

  const source = await readFile(sourcePath);
  const hash = sha256(source);
  // The data directory itself may be under a long temporary test path. Keep
  // this cache shallow so .NET Framework's MAX_PATH-limited compiler can
  // create the temporary executable.
  const cacheDir = path.join(path.resolve(dataDir), ".wj");
  await assertNoSymlinkPath(path.resolve(dataDir));
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(cacheDir);
  const runnerPath = path.join(cacheDir, `${hash}.exe`);
  const manifestPath = path.join(cacheDir, `${hash}.json`);

  const compiled = await readVerifiedRunner(runnerPath, manifestPath, hash);
  if (!compiled) {
    await removeRegularCacheFile(runnerPath);
    await removeRegularCacheFile(manifestPath);
    const compiler = findCSharpCompiler();
    if (!compiler) throw new Error("The .NET Framework C# compiler is unavailable; owned process launch is disabled.");
    const temporaryRunnerPath = `${runnerPath}.${randomUUID()}.tmp.exe`;
    try {
      execFileSync(compiler, ["/nologo", "/target:exe", `/out:${temporaryRunnerPath}`, sourcePath], {
        windowsHide: true,
        stdio: "pipe",
        timeout: 60_000,
      });
      try {
        await rename(temporaryRunnerPath, runnerPath);
      } catch (error) {
        // Another server process may have populated this content-addressed cache
        // at the same time. Keep the complete winner and discard this temporary.
        try {
          const winner = await lstat(runnerPath);
          if (winner.isSymbolicLink() || !winner.isFile()) throw new Error("Unsafe concurrent runner cache entry.");
        }
        catch { throw error; }
        await rm(temporaryRunnerPath, { force: true });
      }
    } catch (error) {
      await rm(temporaryRunnerPath, { force: true });
      const detail = error?.stderr?.toString?.("utf8") || error?.message || "unknown compiler error";
      throw new Error(`Could not compile the Windows Job Object runner: ${detail}`);
    }
    const runnerInfo = await lstat(runnerPath);
    if (runnerInfo.isSymbolicLink() || !runnerInfo.isFile()) throw new Error("The Windows Job Object runner cache entry is unsafe.");
    const manifestTempPath = `${manifestPath}.${randomUUID()}.tmp`;
    const manifest = JSON.stringify({ sourceSha256: hash, runnerSha256: sha256(await readFile(runnerPath)) });
    try {
      await writeFile(manifestTempPath, manifest, { flag: "wx", mode: 0o600 });
      await rename(manifestTempPath, manifestPath);
    } catch (error) {
      await rm(manifestTempPath, { force: true });
      // A concurrent initializer can publish the same verified content first.
      if (!(await readVerifiedRunner(runnerPath, manifestPath, hash))) throw error;
    }
    if (!(await readVerifiedRunner(runnerPath, manifestPath, hash))) {
      throw new Error("The compiled Windows Job Object runner failed its integrity check.");
    }
  }

  return (originalSpawn, isOwned) => {
    if (typeof originalSpawn !== "function") throw new TypeError("The original spawn function is required.");
    if (typeof isOwned !== "function") throw new TypeError("An owner-context predicate is required.");
    return function ownedJobSpawn(executable, args = [], options = {}) {
      if (!isOwned()) return originalSpawn.call(this, executable, args, options);
      if (typeof executable !== "string" || executable.length === 0 || !Array.isArray(args) ||
          args.some((arg) => typeof arg !== "string") || !isRecord(options)) {
        throw new TypeError("Owned process launch requires an executable, string arguments, and spawn options.");
      }
      if (options.shell) throw new Error("Owned process launch does not permit shell execution.");
      const encodedArgs = args.map((arg) => Buffer.from(arg, "utf16le").toString("base64"));
      const helperArgs = [executable, options.windowsVerbatimArguments ? "1" : "0", String(encodedArgs.length), ...encodedArgs];
      const helperOptions = {
        ...options,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: false,
      };
      // The helper inherits cwd, environment, and standard streams. The target then
      // inherits those same values, while the helper owns its Job Object handle.
      return originalSpawn.call(this, runnerPath, helperArgs, helperOptions);
    };
  };
}
