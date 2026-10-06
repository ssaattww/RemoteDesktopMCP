import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { RemoteTransferMappingStore } from "../src/remote-transfer-mapping.js";

const binding = {
  nodeId: "node_AAAAAAAAAAAAAAAAAAAAAA",
  executorGeneration: Buffer.alloc(16, 2).toString("base64url"),
  connectionId: Buffer.alloc(32, 1).toString("base64url"),
};

function start(store: RemoteTransferMappingStore, n: number, direction: "download" | "upload" = "upload", now = 1_000) {
  const reservation = store.reserveStart(binding.nodeId, now);
  return store.bindStarted(reservation, {
    publicId: `public-transfer-id-${n}`,
    principalId: "owner@example.test",
    sessionId: "session_identifier_1234",
    ...binding,
    remoteTransferId: `remote-transfer-id-${n}`,
    direction,
    now,
  });
}

test("remote transfer reservations enforce capacity and hidden sessions retain live trackers", () => {
  const store = new RemoteTransferMappingStore({ activeLimit: 2, totalLimit: 3, terminalRetentionMs: 100 });
  const live = start(store, 1);
  const unknownReservation = store.reserveStart(binding.nodeId, 1);
  const unknown = store.bindUnknown(unknownReservation, {
    principalId: "owner@example.test", sessionId: live.sessionId, direction: "upload", ...binding, now: 1,
  });
  assert.throws(() => store.reserveStart(binding.nodeId, 1), /capacity/i);
  const otherNodeReservation = store.reserveStart("node_BBBBBBBBBBBBBBBBBBBBBB", 1);
  store.releaseStart(otherNodeReservation);
  store.expireSession(live.sessionId);
  assert.equal(store.lookupPublic(live.publicId!, live.principalId, live.sessionId, live.nodeId), undefined);
  assert.equal(store.lookupTracking(live.trackingId)?.state, "active");
  assert.equal(store.lookupTracking(unknown.trackingId)?.state, "unknown");
  assert.equal(store.sweep(1_000_000), 0);
});

test("upload chunks replay only identical last acknowledged bytes and recover pending ACK from status", () => {
  const store = new RemoteTransferMappingStore({ activeLimit: 2, totalLimit: 3 });
  const mapping = start(store, 1);
  const data = Buffer.from("synthetic upload chunk").toString("base64");
  const digest = createHash("sha256").update(data).digest("hex");
  const pending = store.beginUploadChunk(mapping.trackingId, mapping.version, 0, data)!;
  assert.ok(pending.pendingUpload);
  const replacement = { ...binding, connectionId: Buffer.alloc(32, 8).toString("base64url") };
  const recovered = store.confirmStatus(pending.trackingId, pending.version, replacement, {
    state: "active", nextOffset: Buffer.from(data, "base64").length,
  }, 2_000);
  assert.equal(recovered?.connectionId, replacement.connectionId);
  assert.deepEqual(store.uploadReplay(mapping.trackingId, 0, data), { nextOffset: Buffer.from(data, "base64").length });
  assert.throws(() => store.uploadReplay(mapping.trackingId, 0, Buffer.from("different").toString("base64")), /conflicts/i);
  const next = Buffer.from("next").toString("base64");
  const nextPending = store.beginUploadChunk(mapping.trackingId, recovered!.version, recovered!.lastAckOffset, next)!;
  const nextDigest = createHash("sha256").update(next).digest("hex");
  const acknowledged = store.acknowledgeUploadChunk(mapping.trackingId, nextPending.version, nextPending.lastAckOffset, nextDigest, nextPending.lastAckOffset + Buffer.from(next, "base64").length);
  assert.equal(acknowledged?.lastAckOffset, nextPending.lastAckOffset + Buffer.from(next, "base64").length);
  assert.throws(() => store.beginUploadChunk(mapping.trackingId, acknowledged!.version, acknowledged!.lastUploadReplay!.offset, Buffer.from("different").toString("base64")), /conflicts/i);
});

test("download chunks replay exactly, rebind needs matching generation and terminal retention is bounded", () => {
  const store = new RemoteTransferMappingStore({ activeLimit: 2, totalLimit: 3, terminalRetentionMs: 100 });
  const mapping = start(store, 1, "download", 1);
  const response = { data: Buffer.from("bytes").toString("base64"), next_offset: 5, complete: false };
  const acknowledged = store.acknowledgeDownloadChunk(mapping.trackingId, mapping.version, 0, response, 2);
  assert.equal(acknowledged?.lastAckOffset, 5);
  assert.deepEqual(store.downloadReplay(mapping.trackingId, 0), response);
  assert.equal(store.acknowledgeDownloadChunk(mapping.trackingId, acknowledged!.version, 0, response)?.version, acknowledged!.version);
  const finished = store.acknowledgeDownloadChunk(mapping.trackingId, acknowledged!.version, 5, { data: Buffer.from("end").toString("base64"), next_offset: 8, complete: true }, 3);
  assert.equal(finished?.state, "complete");
  assert.equal(store.sweep(102), 0);
  assert.equal(store.sweep(103), 1);

  const current = start(store, 2, "download", 1_000);
  const otherGeneration = { ...binding, executorGeneration: Buffer.alloc(16, 9).toString("base64url") };
  assert.equal(store.confirmStatus(current.trackingId, current.version, otherGeneration, { state: "active", nextOffset: 0 }), undefined);
});

test("download status after a lost chunk ACK rebinds and retrieves the executor's exact replay", () => {
  const store = new RemoteTransferMappingStore({ activeLimit: 2, totalLimit: 3 });
  const mapping = start(store, 1, "download");
  const pending = store.beginDownloadChunk(mapping.trackingId, mapping.version, 0)!;
  const replacement = { ...binding, connectionId: Buffer.alloc(32, 8).toString("base64url") };
  const rebound = store.confirmStatus(pending.trackingId, pending.version, replacement, { state: "active", nextOffset: 5 });
  assert.equal(rebound?.pendingDownload?.offset, 0);
  assert.equal(rebound?.lastAckOffset, 5);
  const remoteReplay = { data: Buffer.from("bytes").toString("base64"), next_offset: 5, complete: false };
  const recovered = store.acknowledgeDownloadChunk(mapping.trackingId, rebound!.version, 0, remoteReplay);
  assert.equal(recovered?.pendingDownload, undefined);
  assert.equal(recovered?.lastAckOffset, 5);
  assert.deepEqual(store.downloadReplay(mapping.trackingId, 0), remoteReplay);
});
