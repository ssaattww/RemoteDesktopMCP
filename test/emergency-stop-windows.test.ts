import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture, mcp } from "./fixture.js";

const onWindows = process.platform === "win32";
const nodeScriptCommand = (file: string) => `node "${file.replaceAll('"', '""')}"`;
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForFile(file: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for test-owned marker ${path.basename(file)}.`);
}

async function waitForFileChange(file: string, previous: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await readFile(file, "utf8") !== previous) return;
    await delay(50);
  }
  assert.fail(`Test-owned heartbeat ${path.basename(file)} stopped changing.`);
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return true; return false; }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(50);
  }
  assert.fail(`Test-owned process ${pid} did not exit after emergency stop.`);
}

function terminateFixtureProcessIfOwned(pid: number, fixtureRoot: string): void {
  const escapedRoot = fixtureRoot.replaceAll("'", "''");
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p -and $p.CommandLine -and $p.CommandLine.Contains('${escapedRoot}')){Stop-Process -Id ${pid} -Force}`;
  try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 5_000 }); }
  catch { /* cleanup only targets a PID whose command line still names this fixture */ }
}

test("Windows emergency stop kills the owned Job descendants after their root exits and preserves another principal", { skip: !onWindows }, async () => {
  const f = await fixture();
  const ownerApi = await mcp(f.service, "owner@example.test");
  const otherApi = await mcp(f.service, "other@example.test");
  const testOwnedPids = new Set<number>();
  let ownerSession: string | undefined;
  let otherSession: string | undefined;
  try {
    assert.equal(f.service.cfg.processAdapter, undefined, "the integration test must use the pinned Desktop Commander bridge");
    assert.match(f.service.cfg.dcArgs.join(" "), /desktop-commander[\\/]dist[\\/]index\.js/);
    const version = JSON.parse(await readFile(path.resolve("node_modules/@wonderwhy-er/desktop-commander/package.json"), "utf8")) as { version?: string };
    assert.equal(version.version, "0.2.51");

    const descendantHeartbeat = path.join(f.root, "owner-descendant-heartbeat.txt");
    const descendantPidFile = path.join(f.root, "owner-descendant-pid.txt");
    const rootPidFile = path.join(f.root, "owner-root-pid.txt");
    const heartbeatScript = path.join(f.root, "heartbeat.cjs");
    const rootScript = path.join(f.root, "root-spawns-descendant.cjs");
    const otherHeartbeat = path.join(f.root, "other-heartbeat.txt");
    const otherPidFile = path.join(f.root, "other-pid.txt");
    await Promise.all([
      writeFile(heartbeatScript, `const fs=require('node:fs');const marker=${JSON.stringify(otherHeartbeat)};const pidFile=${JSON.stringify(otherPidFile)};fs.writeFileSync(pidFile,String(process.pid));const beat=()=>fs.writeFileSync(marker,String(Date.now()));beat();setInterval(beat,100);`),
    ]);
    const descendantScript = path.join(f.root, "owner-descendant.cjs");
    await writeFile(descendantScript, `const fs=require('node:fs');const marker=${JSON.stringify(descendantHeartbeat)};const pidFile=${JSON.stringify(descendantPidFile)};fs.writeFileSync(pidFile,String(process.pid));const beat=()=>fs.writeFileSync(marker,String(Date.now()));beat();setInterval(beat,100);`);
    await writeFile(rootScript, `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,[${JSON.stringify(descendantScript)}],{stdio:'ignore',windowsHide:true,detached:true}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendantPidFile)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(rootPidFile)},String(process.pid));process.exit(0);}},25);`);

    ownerSession = String((await ownerApi.call("session_open", {})).session_id);
    otherSession = String((await otherApi.call("session_open", {})).session_id);
    const ownerStart = await ownerApi.call("process_start", { session_id: ownerSession, command: nodeScriptCommand(rootScript), timeout_ms: 500 });
    const ownerProcessId = String(ownerStart.process_id);
    const ownerProcess = f.service.processes.get(ownerProcessId);
    assert.ok(ownerProcess, "Desktop Commander returned a tracked process for the owner");
    testOwnedPids.add(ownerProcess.pid);
    const descendantPidText = await waitForFile(descendantPidFile).catch(async (error: Error) => {
      const status = await ownerApi.call("process_output", { session_id: ownerSession, process_id: ownerProcessId }).catch((statusError: Error) => ({ error: statusError.message }));
      const rootMarker = await readFile(rootPidFile, "utf8").catch(() => "missing");
      throw new Error(`${error.message} Start output: ${JSON.stringify(ownerStart)} Root marker: ${rootMarker} Process status: ${JSON.stringify(status)}`);
    });
    const descendantPid = Number(descendantPidText);
    const rootPid = Number(await waitForFile(rootPidFile));
    testOwnedPids.add(descendantPid);
    testOwnedPids.add(rootPid);
    await waitForProcessExit(rootPid);
    const heartbeatBeforeStop = await waitForFile(descendantHeartbeat);
    await waitForFileChange(descendantHeartbeat, heartbeatBeforeStop);
    assert.ok(processIsAlive(descendantPid));

    const otherStart = await otherApi.call("process_start", { session_id: otherSession, command: nodeScriptCommand(heartbeatScript), timeout_ms: 500 });
    const otherProcess = f.service.processes.get(String(otherStart.process_id));
    assert.ok(otherProcess, "Desktop Commander returned a tracked process for the other principal");
    testOwnedPids.add(otherProcess.pid);
    const otherPid = Number(await waitForFile(otherPidFile));
    testOwnedPids.add(otherPid);

    await f.service.stopUserExecution("owner@example.test");
    await waitForProcessExit(ownerProcess.pid);
    await waitForProcessExit(descendantPid);
    const otherHeartbeatBefore = await readFile(otherHeartbeat, "utf8");
    await waitForFileChange(otherHeartbeat, otherHeartbeatBefore);
    assert.ok(processIsAlive(otherPid));

    await f.service.stopUserExecution("other@example.test");
    await waitForProcessExit(otherProcess.pid);
    await waitForProcessExit(otherPid);
  } finally {
    await f.service.stopUserExecution("owner@example.test").catch(() => undefined);
    await f.service.stopUserExecution("other@example.test").catch(() => undefined);
    await ownerApi.close().catch(() => undefined);
    await otherApi.close().catch(() => undefined);
    for (const pid of testOwnedPids) if (processIsAlive(pid)) terminateFixtureProcessIfOwned(pid, f.base);
    await f.cleanup();
  }
});
