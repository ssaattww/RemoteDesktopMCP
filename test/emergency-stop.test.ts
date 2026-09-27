import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { RemoteDesktopService } from "../src/index.js";
import { fixture, mcp } from "./fixture.js";

const owner = "owner@example.test";

test("a queued old-generation process start is reclaimed after stop and resume", async () => {
  const f = await fixture();
  let releaseStart!: (value: string) => void;
  let entered!: () => void;
  const enteredStart = new Promise<void>((resolve) => { entered = resolve; });
  const terminated: number[] = [];
  f.service.cfg.processAdapter = { start: async () => { entered(); return new Promise<string>((resolve) => { releaseStart = resolve; }); }, read: async () => "", terminate: async (pid) => { terminated.push(pid); return "terminated"; }, sessions: async () => "" };
  const api = await mcp(f.service);
  try {
    const session = (await api.call("session_open", {})).session_id as string;
    const pending = api.call("process_start", { session_id: session, command: "queued" });
    await enteredStart;
    await f.service.stopUserExecution(owner);
    await f.service.resumeUserExecution(owner);
    releaseStart("PID 4242");
    await assert.rejects(pending, /USER_STOP_REQUESTED/);
    assert.deepEqual(terminated, [4242]);
  } finally { await api.close(); await f.cleanup(); }
});

test("a process id is confined to its owning principal and session", async () => {
  const f = await fixture();
  const terminated: number[] = [];
  f.service.cfg.processAdapter = { start: async () => "PID 7007", read: async () => "Reading 0 new lines (total: 0 lines, 0 remaining)", terminate: async (pid) => { terminated.push(pid); return "terminated"; }, sessions: async () => "PID: 7007" };
  const ownerApi = await mcp(f.service, owner);
  const otherApi = await mcp(f.service, "other@example.test");
  try {
    const ownerSession = (await ownerApi.call("session_open", {})).session_id as string;
    const processId = (await ownerApi.call("process_start", { session_id: ownerSession, command: "owned" })).process_id as string;
    const otherSession = (await otherApi.call("session_open", {})).session_id as string;
    for (const tool of ["process_output", "process_status", "process_kill"]) await assert.rejects(otherApi.call(tool, { session_id: otherSession, process_id: processId }), /Process id is stale or finished/);
    assert.deepEqual(terminated, []);
  } finally { await ownerApi.close(); await otherApi.close(); await f.cleanup(); }
});

test("a marker write failure remains fail-closed and still terminates known processes", async () => {
  const f = await fixture();
  const terminated: number[] = [];
  f.service.cfg.processAdapter = { start: async () => "PID 99", read: async () => "", terminate: async (pid) => { terminated.push(pid); return "terminated"; }, sessions: async () => "PID: 99" };
  const api = await mcp(f.service);
  try {
    const session = (await api.call("session_open", {})).session_id as string;
    await api.call("process_start", { session_id: session, command: "known" });
    (f.service as unknown as { executionStopMarkerPath: () => string }).executionStopMarkerPath = () => path.join(f.data, "does-not-exist", "stop-marker.json");
    await assert.rejects(f.service.stopUserExecution(owner), /marker could not be persisted/);
    assert.equal(f.service.userExecutionState(owner).stopped, true);
    assert.deepEqual(terminated, [99]);
    await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/);
  } finally { await api.close(); await f.cleanup(); }
});

test("resume does not expose execution until its durable update and backend latch complete", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  let releasePersist!: () => void;
  let entered!: () => void;
  const enteredPersist = new Promise<void>((resolve) => { entered = resolve; });
  const originalPersist = (f.service as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates.bind(f.service);
  try {
    await f.service.stopUserExecution(owner);
    (f.service as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates = async () => {
      entered(); await new Promise<void>((resolve) => { releasePersist = resolve; });
      return originalPersist();
    };
    const resume = f.service.resumeUserExecution(owner);
    await enteredPersist;
    await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/);
    releasePersist();
    await resume;
    assert.equal(typeof (await api.call("session_open", {})).connection_id, "string");
  } finally { await api.close(); await f.cleanup(); }
});

test("a resume failure after state replacement recovers stopped state on restart", async () => {
  const f = await fixture();
  const originalPersist = (f.service as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates.bind(f.service);
  let persistCount = 0;
  try {
    await f.service.stopUserExecution(owner);
    (f.service as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates = async () => {
      persistCount += 1;
      await originalPersist();
      // Simulate a post-rename failure such as restoring the state-file ACL.
      if (persistCount === 1) throw new Error("private ACL restore failed");
    };
    await assert.rejects(f.service.resumeUserExecution(owner), /private ACL restore failed/);
    assert.equal(f.service.userExecutionState(owner).stopped, true);
    await f.service.close();
    const restarted = new RemoteDesktopService(f.service.cfg);
    try {
      await restarted.initialize();
      assert.equal(restarted.userExecutionState(owner).stopped, true);
    } finally { await restarted.close(); }
  } finally { await f.cleanup(); }
});

test("a restart and a new server instance retain the stopped principal", async () => {
  const f = await fixture();
  try {
    await f.service.stopUserExecution(owner);
    await f.service.close();
    const restarted = new RemoteDesktopService(f.service.cfg);
    try {
      await restarted.initialize();
      assert.equal(restarted.userExecutionState(owner).stopped, true);
      const api = await mcp(restarted);
      try { await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/); } finally { await api.close(); }
    } finally { await restarted.close(); }
  } finally { await f.cleanup(); }
});
