import assert from "node:assert/strict";
import test from "node:test";
import { NodeOperationReplayGuard } from "../src/node-operation-replay.js";
import { RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { type NodeOperationEnvelope } from "../src/node-operation.js";

const epoch = Buffer.alloc(32, 4).toString("base64url");
const nodeId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const generation = Buffer.alloc(16, 7).toString("base64url");
const request = {
  principal_id: "owner@example.test",
  stop_generation: 3,
  session_id: "session-auth-test",
  operation: "file_read" as const,
  args: { root_id: "remote", relative_path: "note.txt" },
};

function serviceFixture(): RemoteDesktopService {
  const cfg = {
    baseUrl: "http://127.0.0.1",
    tokenSecret: "x".repeat(32),
    users: [{ email: "owner@example.test", passwordHash: "synthetic" }],
    roots: [],
    dataDir: "synthetic-unused",
    port: 0,
    chunkBytes: 1024,
    nodeId,
    nodeLabel: "Synthetic executor",
    dcCommand: process.execPath,
    dcArgs: [],
    allowedRedirectOrigins: new Set<string>(),
    processAdapter: {
      start: async () => "",
      read: async () => "",
      terminate: async () => "",
      sessions: async () => "",
    },
  } as RuntimeConfig;
  const service = new RemoteDesktopService(cfg);
  // Keep this protocol/state unit fixture in memory; do not initialize the
  // Desktop Commander child or alter filesystem security settings.
  (service as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates = async () => undefined;
  (service as unknown as { audit: () => Promise<void> }).audit = async () => undefined;
  return service;
}

async function applyState(service: RemoteDesktopService, stopped = false, stopGeneration = 3, stateEpoch = epoch, principal = "owner@example.test") {
  return service.applyNodeUserState({ principal_id: principal, stopped, stop_generation: stopGeneration, stop_id: stopped ? "stop-state-id-0001" : null, coordinator_epoch: stateEpoch });
}

function envelope(sequence = 1): NodeOperationEnvelope {
  return {
    operation_id: { coordinator_epoch: epoch, target_node_id: nodeId, executor_generation: generation, sequence },
    issued_at: Date.now(),
    request,
  };
}

function synchronizedState(stopped = false, stopGeneration = 3) {
  const auth = serviceFixture();
  auth.activateNodeCoordinatorEpoch(epoch);
  const applied = applyState(auth, stopped, stopGeneration);
  const guard = new NodeOperationReplayGuard();
  guard.activateCoordinatorEpoch(epoch);
  return applied.then(() => ({ auth, guard }));
}

test("replay rejects unknown and unsynchronized user states before work", async () => {
  const guard = new NodeOperationReplayGuard();
  guard.activateCoordinatorEpoch(epoch);
  const auth = serviceFixture();
  auth.activateNodeCoordinatorEpoch(epoch);
  let calls = 0;
  await assert.rejects(guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), async () => { calls += 1; }), /USER_STOP_REQUESTED/);
  await assert.rejects(applyState(auth, false, 3, epoch, "unknown@example.test"), /principal is unknown/);
  const unknownRequest = { ...request, principal_id: "unknown@example.test" };
  await assert.rejects(guard.execute({ ...envelope(2), request: unknownRequest }, () => auth.isNodeOperationAuthorized(unknownRequest, epoch), async () => { calls += 1; }), /USER_STOP_REQUESTED/);
  assert.equal(calls, 0);
});

test("replay rejects stopped and generation-mismatched synchronized state", async () => {
  for (const state of [{ stopped: true, stopGeneration: 3 }, { stopped: false, stopGeneration: 4 }]) {
    const { auth, guard } = await synchronizedState(state.stopped, state.stopGeneration);
    let calls = 0;
    await assert.rejects(guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), async () => { calls += 1; }), /USER_STOP_REQUESTED/);
    assert.equal(calls, 0);
  }
});

test("cached replay is denied after a newly applied stop", async () => {
  const { auth, guard } = await synchronizedState();
  let calls = 0;
  const work = async () => { calls += 1; return "cached"; };
  assert.equal(await guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), work), "cached");
  await applyState(auth, true, 4);
  await assert.rejects(guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), work), /USER_STOP_REQUESTED/);
  assert.equal(calls, 1);
});

test("pending duplicate is denied if stop state changes before work completes", async () => {
  const { auth, guard } = await synchronizedState();
  let started!: () => void;
  let finish!: (value: string) => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const work = () => new Promise<string>((resolve) => { finish = resolve; started(); });
  const authorize = () => auth.isNodeOperationAuthorized(request, epoch);
  const first = guard.execute(envelope(), authorize, work);
  await startedPromise;
  const duplicate = guard.execute(envelope(), authorize, work);
  await applyState(auth, true, 4);
  finish("finished after stop");
  await assert.rejects(first, /USER_STOP_REQUESTED/);
  await assert.rejects(duplicate, /USER_STOP_REQUESTED/);
});

test("only the current synchronized state authorizes an operation", async () => {
  const { auth, guard } = await synchronizedState();
  assert.equal(await guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), async () => "allowed"), "allowed");
});

test("a coordinator-synchronized Google principal can authorize executor work", async () => {
  const auth = serviceFixture();
  auth.activateNodeCoordinatorEpoch(epoch);
  const principal = "google:https://accounts.google.com:subject-123";
  await applyState(auth, false, 0, epoch, principal);
  assert.equal(auth.nodeUserStates().some((state) => state.principal_id === principal), true);
  assert.equal(auth.isNodeOperationAuthorized({ ...request, principal_id: principal, stop_generation: 0 }, epoch), true);
});

test("failed user state application remains unauthorized", async () => {
  const auth = serviceFixture();
  auth.activateNodeCoordinatorEpoch(epoch);
  (auth as unknown as { persistExecutionStates: () => Promise<void> }).persistExecutionStates = async () => { throw new Error("synthetic persistence failure"); };
  await assert.rejects(applyState(auth), /synthetic persistence failure/);
  assert.equal(auth.isNodeOperationAuthorized(request, epoch), false);
});

test("user state cannot resume or replace a stop without advancing its generation", async () => {
  const auth = serviceFixture();
  auth.activateNodeCoordinatorEpoch(epoch);
  await applyState(auth, true, 4);
  await assert.rejects(applyState(auth, false, 4), /without advancing its generation/);
  assert.equal(auth.isNodeOperationAuthorized(request, epoch), false);
});

test("changing coordinator epoch invalidates prior synchronized user state", async () => {
  const { auth, guard } = await synchronizedState();
  const replacementEpoch = Buffer.alloc(32, 9).toString("base64url");
  auth.activateNodeCoordinatorEpoch(replacementEpoch);
  guard.activateCoordinatorEpoch(replacementEpoch);
  await assert.rejects(guard.execute(envelope(), () => auth.isNodeOperationAuthorized(request, epoch), async () => "must not run"), /OPERATION_EPOCH_STALE/);
});
