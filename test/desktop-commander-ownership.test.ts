import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installOwnershipBridge } from "../scripts/desktop-commander-ownership.mjs";

const callSchema = {};
const listSchema = {};

function makeBridge() {
  class FakeServer {
    handlers = new Map<unknown, (...args: any[]) => unknown>();
    setRequestHandler(schema: unknown, handler: (...args: any[]) => unknown) {
      this.handlers.set(schema, handler);
    }
  }
  const sessions = new Map<number, any>();
  const forceTerminated: number[] = [];
  const manager = {
    sessions,
    getSession(pid: number) { return sessions.get(pid); },
    forceTerminate(pid: number) { forceTerminated.push(pid); return true; },
  };
  installOwnershipBridge({ ServerClass: FakeServer, callSchema, listSchema, terminalManager: manager });
  const server = new FakeServer();
  server.setRequestHandler(listSchema, async () => ({ tools: [{ name: "start_process" }] }));
  server.setRequestHandler(callSchema, async (request: any) => {
    if (request.params.name === "start_process") {
      const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; exitCode: number | null };
      child.pid = request.params.arguments.pid;
      child.killed = false;
      child.exitCode = null;
      const session = { process: child };
      if (request.params.arguments.waitBeforeSession) await new Promise((resolve) => setTimeout(resolve, 20));
      sessions.set(child.pid, session);
      if (request.params.arguments.waitForReply) await new Promise((resolve) => setTimeout(resolve, 20));
      return { content: [{ type: "text", text: "started" }] };
    }
    return { content: [{ type: "text", text: "handled" }] };
  });
  const call = server.handlers.get(callSchema)!;
  return { server, call, sessions, forceTerminated };
}

const readResult = (result: any) => JSON.parse(result.content[0].text);

test("the private ownership tools are available only in the private bridge list", async () => {
  const { server } = makeBridge();
  const result = await server.handlers.get(listSchema)!.call(server);
  assert.deepEqual(result.tools.map((tool: any) => tool.name), ["start_process", "_rdmcp_stop_owner", "_rdmcp_resume_owner"]);
});

test("stop latches an owner and terminates only its tracked processes, including before start reply", async () => {
  const { call, forceTerminated } = makeBridge();
  const pending = call({ params: { name: "start_process", arguments: { __rdmcp_owner: "alice", __rdmcp_operation: "op-1", pid: 100, waitForReply: true } } }, {});
  const stop = readResult(await call({ params: { name: "_rdmcp_stop_owner", arguments: { owner: "alice" } } }, {}));
  assert.deepEqual(stop, { stopped: true, matched: 1, terminated: 1, failed: 0, terminated_pids: [100], failed_pids: [] });
  assert.deepEqual(forceTerminated, [100]);
  await assert.rejects(call({ params: { name: "start_process", arguments: { __rdmcp_owner: "alice", __rdmcp_operation: "op-2", pid: 101 } } }, {}), /stopped/);
  await pending;
  await call({ params: { name: "start_process", arguments: { __rdmcp_owner: "bob", __rdmcp_operation: "op-3", pid: 200 } } }, {});
  const bobStop = readResult(await call({ params: { name: "_rdmcp_stop_owner", arguments: { owner: "bob" } } }, {}));
  assert.equal(bobStop.matched, 1);
  assert.deepEqual(forceTerminated, [100, 200]);
  await call({ params: { name: "_rdmcp_resume_owner", arguments: { owner: "alice" } } }, {});
  await call({ params: { name: "start_process", arguments: { __rdmcp_owner: "alice", __rdmcp_operation: "op-4", pid: 102 } } }, {});
});

test("a PID published after the stop latch is terminated immediately", async () => {
  const { call, forceTerminated } = makeBridge();
  const pending = call({ params: { name: "start_process", arguments: { __rdmcp_owner: "alice", __rdmcp_operation: "op-late", pid: 303, waitBeforeSession: true } } }, {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stopped = readResult(await call({ params: { name: "_rdmcp_stop_owner", arguments: { owner: "alice" } } }, {}));
  assert.equal(stopped.matched, 0);
  await pending;
  assert.deepEqual(forceTerminated, [303]);
});

test("the bridge requires trusted owner and operation metadata and strips it before upstream handlers", async () => {
  const { call, sessions } = makeBridge();
  await assert.rejects(call({ params: { name: "start_process", arguments: { pid: 1 } } }, {}), /metadata is required/);
  await call({ params: { name: "start_process", arguments: { __rdmcp_owner: "alice", __rdmcp_operation: "op-1", pid: 12 } } }, {});
  assert.equal(sessions.has(12), true);
});
