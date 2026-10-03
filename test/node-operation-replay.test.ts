import assert from "node:assert/strict";
import test from "node:test";
import {
  NodeOperationSequenceIssuer,
  nodeOperationContextKey,
  type NodeOperationEnvelope,
  type NodeOperationRequest,
} from "../src/node-operation.js";
import { NodeOperationReplayGuard } from "../src/node-operation-replay.js";

const target = "node_AAAAAAAAAAAAAAAAAAAAAA";
const generation = Buffer.alloc(16, 1).toString("base64url");
const epoch = Buffer.alloc(32, 2).toString("base64url");
const request: NodeOperationRequest = {
  principal_id: "owner@example.test",
  stop_generation: 0,
  session_id: "session-replay-test-123456",
  operation: "file_read",
  args: { root_id: "files", relative_path: "note.txt" },
};

function envelope(sequence: number, operationRequest = request, coordinatorEpoch = epoch): NodeOperationEnvelope {
  return { operation_id: { coordinator_epoch: coordinatorEpoch, target_node_id: target, executor_generation: generation, sequence }, issued_at: Date.now(), request: operationRequest };
}

test("coordinator operation sequences are scoped by epoch, node, and executor generation", () => {
  const issuer = new NodeOperationSequenceIssuer();
  const first = issuer.issue(target, generation, request);
  const second = issuer.issue(target, generation, request);
  const otherGeneration = issuer.issue(target, Buffer.alloc(16, 3).toString("base64url"), request);
  assert.equal(first.operation_id.sequence, 1);
  assert.equal(second.operation_id.sequence, 2);
  assert.equal(first.operation_id.coordinator_epoch, second.operation_id.coordinator_epoch);
  assert.equal(otherGeneration.operation_id.sequence, 1);
});

test("replay guard deduplicates, rejects changed context, and keeps bitmap identity after terminal eviction", async () => {
  const guard = new NodeOperationReplayGuard();
  guard.activateCoordinatorEpoch(epoch);
  let executions = 0;
  const first = envelope(1);
  const result = await guard.execute(first, () => true, async () => ({ value: ++executions }));
  assert.deepEqual(result, { value: 1 });
  assert.deepEqual(await guard.execute(first, () => true, async () => ({ value: ++executions })), result);
  assert.equal(executions, 1);
  await assert.rejects(guard.execute(envelope(1, { ...request, principal_id: "other@example.test" }), () => true, async () => ++executions), /OPERATION_ID_CONFLICT/);

  const bit31Guard = new NodeOperationReplayGuard();
  bit31Guard.activateCoordinatorEpoch(epoch);
  const firstAtBit31 = envelope(1);
  await bit31Guard.execute(firstAtBit31, () => true, async () => "first");
  await bit31Guard.execute(envelope(32), () => true, async () => "last");
  assert.equal(await bit31Guard.execute(firstAtBit31, () => true, async () => "duplicate"), "first");

  const sequence32Guard = new NodeOperationReplayGuard();
  sequence32Guard.activateCoordinatorEpoch(epoch);
  await sequence32Guard.execute(envelope(1), () => true, async () => "first");
  await sequence32Guard.execute(envelope(33), () => true, async () => "delta32");
  await assert.rejects(sequence32Guard.execute(envelope(1), () => true, async () => "must not run"), /OPERATION_EXPIRED/);
  await assert.rejects(sequence32Guard.execute(envelope(66), () => true, async () => "gap"), /OPERATION_SEQUENCE_WINDOW/);
});

test("pending duplicates singleflight outside the window and cached results still require current stop authorization", async () => {
  const guard = new NodeOperationReplayGuard();
  guard.activateCoordinatorEpoch(epoch);
  let executions = 0;
  let release!: (value: string) => void;
  const pending = guard.execute(envelope(1), () => true, () => {
    executions += 1;
    return new Promise<string>((resolve) => { release = resolve; });
  });
  await Promise.resolve();
  for (let sequence = 2; sequence <= 34; sequence += 1) {
    await guard.execute(envelope(sequence), () => true, async () => `result-${sequence}`);
  }
  const duplicate = guard.execute(envelope(1), () => true, async () => { executions += 1; return "duplicate"; });
  assert.equal(executions, 1);
  release("one");
  assert.equal(await pending, "one");
  assert.equal(await duplicate, "one");
  await assert.rejects(guard.execute(envelope(1), () => false, async () => "unauthorized"), /USER_STOP_REQUESTED/);
});

test("operation context digest is deterministic for canonical parsed arguments", () => {
  const reversed: NodeOperationRequest = { ...request, args: { relative_path: "note.txt", root_id: "files" } };
  assert.equal(nodeOperationContextKey(request), nodeOperationContextKey(reversed));
});