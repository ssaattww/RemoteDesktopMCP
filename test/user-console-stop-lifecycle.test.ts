import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { createApp, RemoteDesktopService, configFromEnv } from "../src/index.js";
import { readSessionLogs } from "../src/admin.js";
import type { OAuthState } from "../src/public-auth.js";
import { fixture, mcp } from "./fixture.js";

test("emergency stop persists per principal, terminates known processes, and requires a new connection after resume", async () => {
  const f = await fixture();
  const terminated: number[] = [];
  f.service.cfg.processAdapter = { start: async () => "PID 771", read: async () => "Reading 0 new lines (total: 0 lines)", terminate: async (pid) => { terminated.push(pid); return "Successfully initiated termination of session"; }, sessions: async () => "PID: 771" };
  const api = await mcp(f.service);
  try {
    const connection = await api.call("session_open", {});
    const sessionId = connection.session_id as string;
    const operationEvents = (await readSessionLogs(f.service)).sessions.flatMap((session) => session.events).filter((event) => event.tool === "session_open");
    const started = operationEvents.find((event) => event.event === "operation.started")!;
    const succeeded = operationEvents.find((event) => event.event === "operation.succeeded")!;
    assert.ok(String(started.connectionId).startsWith("request:"));
    assert.equal(typeof started.startAt, "string");
    assert.equal(succeeded.connectionId, sessionId);
    const process = await api.call("process_start", { session_id: sessionId, command: "test process" });
    assert.ok(process.process_id);
    const stopped = await f.service.stopUserExecution("owner@example.test");
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.stopGeneration, 1);
    assert.deepEqual(terminated, [771]);
    await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/);
    const stored = JSON.parse(await readFile(`${f.data}/user-execution-states.json`, "utf8")) as Array<{ stopped: boolean; stopGeneration: number }>;
    assert.deepEqual(stored, [{ stopped: true, stopGeneration: 1, principalId: "owner@example.test", stoppedAt: stopped.stoppedAt, stopId: stopped.stopId }]);
    await f.service.resumeUserExecution("owner@example.test");
    await assert.rejects(api.call("node_list", { session_id: sessionId }), /Session is invalid/);
    const newConnection = await api.call("session_open", {});
    assert.ok(newConnection.connection_id);
  } finally { await api.close(); await f.cleanup(); }
});

test("Issue 48: emergency stop is accepted while a session working directory is being validated", async () => {
  const f = await fixture();
  const owner = await mcp(f.service);
  let releasePathCheck!: (value: string) => void;
  let releaseStopMarker!: () => void;
  let stop: Promise<unknown> | undefined;
  let update: Promise<unknown> | undefined;
  let stopMarkerWasEntered = false;
  let enterPathCheck!: () => void;
  const pathCheckEntered = new Promise<void>((resolve) => { enterPathCheck = resolve; });
  const delayedPathCheck = new Promise<string>((resolve) => { releasePathCheck = resolve; });
  const delayedStopMarker = new Promise<void>((resolve) => { releaseStopMarker = resolve; });
  try {
    const opened = await owner.call("session_open", { working_directory: f.root, purpose: "Delayed path validation" });
    const service = f.service as unknown as {
      resolveSessionWorkingDirectory: (path: string) => Promise<string | undefined>;
      writeExecutionStopMarker: (state: unknown) => Promise<void>;
    };
    service.resolveSessionWorkingDirectory = async () => { enterPathCheck(); return delayedPathCheck; };
    update = f.service.updateSessionMetadata("owner@example.test", String(opened.session_id), { expectedVersion: 1, workingDirectory: f.base });
    await pathCheckEntered;
    const writeStopMarker = service.writeExecutionStopMarker.bind(f.service);
    service.writeExecutionStopMarker = async (state) => {
      stopMarkerWasEntered = true;
      await delayedStopMarker;
      await writeStopMarker(state);
    };
    stop = f.service.stopUserExecution("owner@example.test");
    await Promise.resolve();
    assert.equal(f.service.userExecutionState("owner@example.test").stopped, true, "stop must latch before persistence while path validation is still pending");
    assert.equal(stopMarkerWasEntered, true, "stop must reach persistence while path validation is still pending");
    releaseStopMarker();
    assert.equal((await stop as { stopped: boolean }).stopped, true);
    releasePathCheck(f.base);
    assert.deepEqual(await update as { ok: boolean; status: number; error: string }, { ok: false, status: 404, error: "session_unavailable" });
  } finally {
    releaseStopMarker();
    releasePathCheck(f.base);
    await Promise.allSettled([...(stop ? [stop] : []), ...(update ? [update] : [])]);
    await owner.close().catch(() => undefined);
    await f.cleanup();
  }
});
