import assert from "node:assert/strict";
import test from "node:test";
import { RemoteProcessMappingStore } from "../src/remote-process-mapping.js";

const binding = {
  nodeId: "node_AAAAAAAAAAAAAAAAAAAAAA",
  executorGeneration: Buffer.alloc(16, 2).toString("base64url"),
  connectionId: Buffer.alloc(32, 1).toString("base64url"),
};

function start(store: RemoteProcessMappingStore, n: number, now = 1_000) {
  const reservation = store.reserveStart(binding.nodeId, now);
  return store.bindStarted(reservation, {
    publicId: `public-process-id-${n}`,
    principalId: "owner@example.test",
    sessionId: "session_identifier_1234",
    ...binding,
    remoteProcessId: `remote-process-id-${n}`,
    now,
  });
}

test("parallel start reservations enforce active and total limits and release failed work", () => {
  const store = new RemoteProcessMappingStore({ activeLimit: 2, totalLimit: 3, terminalRetentionMs: 100 });
  const first = store.reserveStart(binding.nodeId, 1);
  const second = store.reserveStart(binding.nodeId, 1);
  assert.throws(() => store.reserveStart(binding.nodeId, 1), /capacity/i);
  const otherNodeReservation = store.reserveStart("node_BBBBBBBBBBBBBBBBBBBBBB", 1);
  store.releaseStart(otherNodeReservation);
  store.releaseStart(first);
  const replacement = store.reserveStart(binding.nodeId, 1);
  store.bindStarted(replacement, {
    publicId: "public-process-id-1",
    principalId: "owner@example.test",
    sessionId: "session_identifier_1234",
    ...binding,
    remoteProcessId: "remote-process-id-1",
    now: 1,
  });
  store.bindStarted(second, {
    publicId: "public-process-id-2",
    principalId: "owner@example.test",
    sessionId: "session_identifier_1234",
    ...binding,
    remoteProcessId: "remote-process-id-2",
    now: 1,
  });
  assert.equal(store.countActive(), 2);
  assert.throws(() => store.reserveStart(binding.nodeId, 1), /capacity/i);
});

test("session public expiry does not discard live or unconfirmed process tracking", () => {
  const store = new RemoteProcessMappingStore({ activeLimit: 2, totalLimit: 3, terminalRetentionMs: 100 });
  const live = start(store, 1);
  const unknownReservation = store.reserveStart(binding.nodeId, 1);
  const unknown = store.bindUnknown(unknownReservation, {
    principalId: "owner@example.test",
    sessionId: "session_identifier_1234",
    ...binding,
    now: 1,
  });
  store.expireSession("session_identifier_1234");
  assert.equal(store.lookupPublic(live.publicId!, "owner@example.test", live.sessionId, live.nodeId), undefined);
  assert.equal(store.lookupTracking(live.trackingId)?.state, "active");
  assert.equal(store.lookupTracking(unknown.trackingId)?.state, "unknown");
  assert.equal(store.sweep(1_000_000), 0);
  assert.equal(store.countActive(), 2);
});

test("only confirmed terminal state expires after retention; rebind uses generation and version CAS", () => {
  const store = new RemoteProcessMappingStore({ activeLimit: 2, totalLimit: 3, terminalRetentionMs: 100, terminalOutputLimit: 8 });
  const mapping = start(store, 1);
  const firstVersion = mapping.version;
  const replacement = {
    ...binding,
    connectionId: Buffer.alloc(32, 7).toString("base64url"),
  };
  const rebound = store.confirmStatus(mapping.trackingId, firstVersion, replacement, "running", 2_000);
  assert.equal(rebound?.connectionId, replacement.connectionId);
  assert.equal(rebound?.version, firstVersion + 1);
  assert.equal(store.confirmStatus(mapping.trackingId, firstVersion, binding, "finished", 2_001), undefined);

  const terminal = store.confirmStatus(mapping.trackingId, rebound!.version, replacement, "finished", 3_000, {
    exitCode: 0,
    terminationUnconfirmed: false,
    output: "finished output",
  });
  assert.equal(terminal?.state, "finished");
  assert.equal(terminal?.terminalExitCode, 0);
  assert.equal(terminal?.terminalOutput, "d output");
  assert.equal(store.sweep(3_099), 0);
  assert.equal(store.sweep(3_100), 1);

  const otherGeneration = { ...replacement, executorGeneration: Buffer.alloc(16, 8).toString("base64url") };
  const current = start(store, 2, 4_000);
  assert.equal(store.confirmStatus(current.trackingId, current.version, otherGeneration, "running", 4_001), undefined);
});
