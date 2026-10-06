import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { prepareWindowsJobLauncher } from "../scripts/windows-job-launcher.mjs";

const onWindows = process.platform === "win32";
let temporaryDataDir = "";
let wrapSpawn: (originalSpawn: typeof nodeSpawn, isOwned: () => boolean) => typeof nodeSpawn;

before(async () => {
  if (!onWindows) return;
  temporaryDataDir = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-test-"));
  wrapSpawn = await prepareWindowsJobLauncher(temporaryDataDir);
});

after(async () => {
  if (temporaryDataDir) await rm(temporaryDataDir, { recursive: true, force: true });
});

function spawnOwned(executable: string, args: string[], options: Record<string, unknown> = {}) {
  return wrapSpawn(nodeSpawn, () => true)(executable, args, options as never);
}

function collect(child: ReturnType<typeof nodeSpawn>, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr?.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function getCachePaths(dataDir: string) {
  const source = await readFile(new URL("../scripts/windows-job-runner.cs", import.meta.url));
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const cacheDir = path.join(dataDir, ".wj");
  return { cacheDir, runnerPath: path.join(cacheDir, `${sourceHash}.exe`), manifestPath: path.join(cacheDir, `${sourceHash}.json`) };
}

async function assertRunnerManifest(runnerPath: string, manifestPath: string) {
  const runner = await readFile(runnerPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.runnerSha256, createHash("sha256").update(runner).digest("hex"));
}

test("owned Job runner preserves arguments, environment, cwd, streams, and root exit code", { skip: !onWindows }, async () => {
  const cwd = path.join(temporaryDataDir, "working directory");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  const script = "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),env:process.env.RDMCP_JOB_TEST,cwd:process.cwd(),input}));process.stderr.write('stderr-ok');process.exitCode=23;});";
  const args = ["-e", script, "space value", "quote\"inside", "trail\\", "日本語"];
  const child = spawnOwned(path.basename(process.execPath, ".exe"), args, {
    cwd,
    env: { ...process.env, RDMCP_JOB_TEST: "env value with spaces" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = await collect(child, "stdin payload");
  assert.equal(result.code, 23, result.stderr);
  assert.equal(result.stderr, "stderr-ok");
  const received = JSON.parse(result.stdout) as { argv: string[]; env: string; cwd: string; input: string };
  assert.equal(await realpath(received.cwd), await realpath(cwd));
  assert.deepEqual({ ...received, cwd: "canonicalized" }, {
    argv: ["space value", "quote\"inside", "trail\\", "日本語"],
    env: "env value with spaces",
    cwd: "canonicalized",
    input: "stdin payload",
  });
});

test("the helper stays alive after the root exits and killing it stops remaining Job descendants", { skip: !onWindows }, async () => {
  const marker = path.join(temporaryDataDir, "descendant-survived.txt");
  const childScript = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),1800);`;
  const rootScript = "require('child_process').spawn(process.execPath,['-e',process.argv[1]],{stdio:'inherit',windowsHide:true});process.stdout.write('root-exited');";
  const helper = spawnOwned(process.execPath, ["-e", rootScript, childScript], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  helper.stdout?.setEncoding("utf8").on("data", (data: string) => { output += data; });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The process root did not exit in time.")), 10_000);
    helper.once("error", reject);
    helper.stdout?.on("data", () => {
      if (output.includes("root-exited")) { clearTimeout(timeout); resolve(); }
    });
  });
  assert.equal(helper.exitCode, null, "the tracked helper should remain alive while a Job descendant exists");
  helper.kill();
  await new Promise<void>((resolve, reject) => {
    helper.once("error", reject);
    helper.once("close", () => resolve());
  });
  await delay(2200);
  await assert.rejects(stat(marker));
});

test("invalid executables fail closed through the helper", { skip: !onWindows }, async () => {
  const child = spawnOwned(path.join(temporaryDataDir, "missing-program.exe"), [], { stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);
  assert.equal(result.code, 125);
  assert.match(result.stderr, /CreateProcess failed/);
});

test("the launcher does not wrap calls outside the owner context", { skip: !onWindows }, async () => {
  const wrap = await prepareWindowsJobLauncher(temporaryDataDir);
  const spawn = wrap(nodeSpawn, () => false);
  const child = spawn(process.execPath, ["-e", "process.stdout.write('direct')"], { stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "direct");
});

test("the launcher compiles its private runner when the data path approaches the Windows compiler path limit", { skip: !onWindows }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-long-"));
  const dataDir = path.join(base, "a".repeat(44), "b".repeat(44));
  try {
    await mkdir(dataDir, { recursive: true });
    assert.ok(path.join(dataDir, ".wj", `${"f".repeat(64)}.exe`).length < 260);
    await prepareWindowsJobLauncher(dataDir);
    const { runnerPath, manifestPath } = await getCachePaths(dataDir);
    await assertRunnerManifest(runnerPath, manifestPath);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a corrupted cached runner is recompiled and receives a matching digest manifest", { skip: !onWindows }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-corrupt-"));
  try {
    await prepareWindowsJobLauncher(dataDir);
    const { runnerPath, manifestPath } = await getCachePaths(dataDir);
    await writeFile(runnerPath, Buffer.from("corrupt runner"));
    const wrap = await prepareWindowsJobLauncher(dataDir);
    await assertRunnerManifest(runnerPath, manifestPath);
    const result = await collect(wrap(nodeSpawn, () => true)(process.execPath, ["-e", "process.stdout.write('recovered')"], { stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "recovered");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an interrupted cache write is recovered on the next initialization", { skip: !onWindows }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-partial-"));
  try {
    const { cacheDir, runnerPath, manifestPath } = await getCachePaths(dataDir);
    await mkdir(cacheDir);
    await writeFile(runnerPath, Buffer.from("partial executable"));
    await writeFile(`${runnerPath}.interrupted.tmp.exe`, Buffer.from("partial compile output"));
    const wrap = await prepareWindowsJobLauncher(dataDir);
    await assertRunnerManifest(runnerPath, manifestPath);
    const info = await lstat(runnerPath);
    assert.equal(info.isFile(), true);
    const result = await collect(wrap(nodeSpawn, () => true)(process.execPath, ["-e", "process.stdout.write('recovered')"], { stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "recovered");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the launcher rejects a cache directory junction", { skip: !onWindows }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-link-"));
  const redirectedDir = await mkdtemp(path.join(os.tmpdir(), "rdmcp-job-target-"));
  try {
    await symlink(redirectedDir, path.join(dataDir, ".wj"), "junction");
    await assert.rejects(prepareWindowsJobLauncher(dataDir), /symbolic link/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(redirectedDir, { recursive: true, force: true });
  }
});
