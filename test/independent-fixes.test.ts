import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RemoteDesktopService, type ProcessAdapter } from "../src/index.js";
import { absent, fixture, mcp } from "./fixture.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const configPath = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");
const openSession = async (api: Awaited<ReturnType<typeof mcp>>) => (await api.call("session_open", {})).session_id as string;
const auditEvents = async (data: string) => (await readFile(path.join(data, "audit.jsonl"), "utf8")).split("\n").flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });

async function processService(adapter: ProcessAdapter) {
  const f = await fixture();
  await f.service.close();
  const service = new RemoteDesktopService({ ...f.service.cfg, processAdapter: adapter });
  await service.initialize();
  return { f, service, api: await mcp(service) };
}

async function replaceConfigWithRetry(source: string, destination: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw last;
}

test("RDMCP-MVP-IFR-002: live config history prunes past 64 versions without losing known protection", async () => {
  const f = await fixture(); let api = await mcp(f.service); let restarted: RemoteDesktopService | undefined;
  try {
    const protectedConfig = configPath(f.data);
    const alias = path.join(f.root, "known-config-alias.json");
    const ordinary = path.join(f.root, "ordinary-history.txt");
    await Promise.all([link(protectedConfig, alias), writeFile(ordinary, "ordinary history file")]);
    let session = await openSession(api);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }));
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);

    const capture = (f.service as unknown as { rememberProtectedConfigIdentity: () => Promise<void> }).rememberProtectedConfigIdentity.bind(f.service);
    for (let version = 0; version < 70; version++) {
      const staged = `${protectedConfig}.version-${version}`;
      await writeFile(staged, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false, fixtureVersion: version }));
      await replaceConfigWithRetry(staged, protectedConfig);
      await capture();
    }

    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }), "the known hard-link alias survives history pruning");
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);

    await api.close(); await f.service.close();
    restarted = new RemoteDesktopService(f.service.cfg); await restarted.initialize(); api = await mcp(restarted); session = await openSession(api);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }), "restart preserves known config protection after pruning");
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);
  } finally { await api.close(); await restarted?.close(); await f.cleanup(); }
});

test("RDMCP-MVP-IFR-003: uploads and downloads share one active-transfer cap", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    const source = Buffer.from("download source");
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(path.join(f.root, `cap-source-${index}.txt`), source)));
    for (let index = 0; index < 10; index++) {
      await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: `cap-upload-${index}.bin`, size: 1, sha256: digest(Buffer.from("x")), overwrite: false });
      await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: `cap-source-${index}.txt` });
    }
    assert.equal([...f.service.transfers.values()].filter((item) => item.state === "active").length, 20);
    const beforeRoot = (await readdir(f.root)).sort();
    const beforeManifest = await readFile(manifest, "utf8");
    await assert.rejects(api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: "cap-overflow.bin", size: 1, sha256: digest(Buffer.from("y")), overwrite: false }));
    assert.equal([...f.service.transfers.values()].filter((item) => item.state === "active").length, 20, "overflow must not create transfer state");
    assert.deepEqual((await readdir(f.root)).sort(), beforeRoot, "overflow must not leave a temporary upload file");
    assert.equal(await readFile(manifest, "utf8"), beforeManifest, "overflow must not create an owned-upload manifest record");
    await absent(path.join(f.root, "cap-overflow.bin"));
  } finally { await api.close(); await f.cleanup(); }
});

test("RDMCP-MVP-IFR-006: successful multi-chunk uploads commit exact bytes and clean ownership", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    const commit = async (name: string, bytes: Buffer, overwrite: boolean) => {
      const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: digest(bytes), overwrite });
      const id = begun.transfer_id as string;
      const item = f.service.transfers.get(id)!;
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 1024, bytes.length));
        await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset, data: chunk.toString("base64") });
      }
      const completed = await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: id });
      assert.equal(completed.sha256, digest(bytes)); assert.equal(completed.size, bytes.length);
      assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: id })).state, "complete");
      assert.equal(f.service.transfers.get(id)?.state, "complete");
      await absent(item.temp!);
      assert.equal((await readFile(manifest, "utf8")).includes(item.temp!), false, "completed upload removes its owned manifest record");
      assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
    };
    const newBytes = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.alloc(1024, 0x42), Buffer.alloc(517, 0x43)]);
    await commit("multi-new.bin", newBytes, false);
    const replacement = Buffer.concat([Buffer.alloc(1024, 0x5a), Buffer.alloc(377, 0x51)]);
    await writeFile(path.join(f.root, "multi-existing.bin"), "old destination");
    await commit("multi-existing.bin", replacement, true);
  } finally { await api.close(); await f.cleanup(); }
});

test("RDMCP-MVP-IFR-001: same PID reuse never lets an old logical process delegate for its successor", async () => {
  const calls: string[] = [];
  let starts = 0;
  let holdNextRead = false;
  let readEntered: (() => void) | undefined;
  let releaseRead: (() => void) | undefined;
  const adapter: ProcessAdapter = {
    start: async () => { starts += 1; calls.push(`start:${starts}`); return "Process started with PID 4242"; },
    read: async () => { calls.push("read"); if (holdNextRead) { holdNextRead = false; readEntered?.(); await new Promise<void>((resolve) => { releaseRead = resolve; }); } return "Reading 0 new lines (total: 0 lines)"; },
    terminate: async () => { calls.push("terminate"); return "Successfully initiated termination of session"; },
    sessions: async () => { calls.push("sessions"); return "PID: 4242"; },
  };
  const { f, service, api } = await processService(adapter);
  try {
    const session = await openSession(api);
    const first = await api.call("process_start", { session_id: session, command: "logical-a", timeout_ms: 100 });
    const firstId = first.process_id as string;
    const second = await api.call("process_start", { session_id: session, command: "logical-b", timeout_ms: 100 });
    const secondId = second.process_id as string;
    assert.notEqual(firstId, secondId);
    const afterReplacement = calls.length;
    await assert.rejects(api.call("process_output", { session_id: session, process_id: firstId }));
    await assert.rejects(api.call("process_status", { session_id: session, process_id: firstId }));
    await assert.rejects(api.call("process_kill", { session_id: session, process_id: firstId }));
    assert.deepEqual(calls.slice(afterReplacement), [], "B must not receive output, status, or terminate delegation through stale A");

    const third = await api.call("process_start", { session_id: session, command: "logical-c", timeout_ms: 100 });
    const thirdId = third.process_id as string;
    holdNextRead = true;
    let markReadEntered!: () => void;
    const reachedRead = new Promise<void>((resolve) => { markReadEntered = resolve; });
    readEntered = markReadEntered;
    const outputBeforeReplacement = api.call("process_output", { session_id: session, process_id: thirdId });
    await reachedRead;
    const fourthPending = api.call("process_start", { session_id: session, command: "logical-d", timeout_ms: 100 });
    releaseRead!(); await outputBeforeReplacement;
    const fourth = await fourthPending; const fourthId = fourth.process_id as string;
    const afterQueuedReplacement = calls.length;
    await assert.rejects(api.call("process_output", { session_id: session, process_id: thirdId }));
    await assert.rejects(api.call("process_status", { session_id: session, process_id: thirdId }));
    await assert.rejects(api.call("process_kill", { session_id: session, process_id: thirdId }));
    assert.deepEqual(calls.slice(afterQueuedReplacement), [], "stale C must not delegate after D acquires the process lock");
    assert.equal(service.processes.get(fourthId)?.pid, 4242);
  } finally { await api.close(); await service.close(); await f.cleanup(); }
});

test("RDMCP-MVP-IFR-004: a termination timeout becomes an observed single finished exit", async () => {
  let active = true;
  const adapter: ProcessAdapter = {
    start: async () => "Process started with PID 5050",
    read: async () => "Reading 1 new lines (total: 1 lines)\nProcess completed with exit code 9",
    terminate: async () => { throw Object.assign(new Error("timeout"), { code: -32001 }); },
    sessions: async () => active ? "PID: 5050" : "No active sessions",
  };
  const { f, service, api } = await processService(adapter);
  try {
    const session = await openSession(api);
    const started = await api.call("process_start", { session_id: session, command: "timeout-process", timeout_ms: 100 });
    const processId = started.process_id as string;
    const timedOut = await api.call("process_kill", { session_id: session, process_id: processId });
    assert.equal(timedOut.state, "terminating"); assert.equal(timedOut.termination_unconfirmed, true);
    const unknown = await api.call("process_status", { session_id: session, process_id: processId });
    assert.equal(unknown.state, "terminating"); assert.equal(unknown.termination_unconfirmed, true);
    active = false;
    let exits: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      exits = (await auditEvents(f.data)).filter((entry) => entry.event === "process.exit" && entry.processId === processId);
      if (service.processes.get(processId)?.state === "finished" && exits.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(service.processes.get(processId)?.state, "finished", "the watcher must observe the later exit without a status/output poll");
    assert.equal(exits.length, 1, "late observation must emit exactly one exit audit event");
    assert.equal(exits[0]?.exitCode, 9);
    const finished = await api.call("process_status", { session_id: session, process_id: processId });
    assert.equal(finished.state, "finished"); assert.equal(finished.exit_code, 9);
  } finally { await api.close(); await service.close(); await f.cleanup(); }
});

test("RDMCP-MVP-IFR-005: process start audit binds redacted command, PID, session, and logical id", async () => {
  const adapter: ProcessAdapter = {
    start: async () => "Process started with PID 6060",
    read: async () => "Reading 0 new lines (total: 0 lines)",
    terminate: async () => "Successfully initiated termination of session",
    sessions: async () => "PID: 6060",
  };
  const { f, service, api } = await processService(adapter);
  try {
    const session = await openSession(api);
    const secretPassword = "fixture-password-must-not-appear";
    const secretToken = "fixture-token-must-not-appear";
    const configuredSecret = f.service.cfg.tokenSecret;
    const configuredHash = f.service.cfg.users[0]!.passwordHash;
    const bearerToken = "fixture-bearer-must-not-appear";
    const started = await api.call("process_start", { session_id: session, command: `tool run ${configuredSecret} ${configuredHash} --password ${secretPassword} --token ${secretToken} Bearer ${bearerToken} visible-task`, timeout_ms: 100 });
    const processId = started.process_id as string;
    const entry = (await auditEvents(f.data)).findLast((value) => value.event === "process.start" && value.processId === processId);
    assert.ok(entry);
    assert.equal(entry.sessionId, session); assert.equal(entry.pid, 6060); assert.equal(entry.processId, processId);
    assert.match(String(entry.command), /visible-task/);
    for (const secret of [secretPassword, secretToken, bearerToken, configuredSecret, configuredHash]) assert.equal(String(entry.command).includes(secret), false, "process command audit must redact configured and supplied secrets");
    const audit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
    assert.equal(audit.includes(configuredSecret), false, "configured token secret must not enter process audit"); assert.equal(audit.includes(configuredHash), false, "configured password hash must not enter process audit");
  } finally { await api.close(); await service.close(); await f.cleanup(); }
});
