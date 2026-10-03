import assert from "node:assert/strict";
import test from "node:test";
import {
  addExecutor,
  createInitialClusterConfig,
  removeExecutor,
  rotateExecutorKey,
} from "../src/node-cluster.js";
import { NodeRegistry } from "../src/node-registry.js";

const remoteId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const connection = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const generation = (byte: number) => Buffer.alloc(16, byte).toString("base64url");
const at = (seconds: number) => Date.parse(`2026-10-01T00:00:${String(seconds).padStart(2, "0")}Z`);

function configuredRegistry(): { registry: NodeRegistry; config: ReturnType<typeof addExecutor>["config"] } {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  registry.setLocalCapabilities({
    operations: ["file", "process", "transfer"],
    roots: [{ root_id: "files", absolute_path: "C:\\workspace" }],
    path_base: "root",
  }, at(1));
  return { registry, config: added.config };
}

test("node registry keeps registered disconnected nodes and hides synchronizing capabilities until activation", () => {
  const { registry } = configuredRegistry();
  const before = registry.list();
  assert.equal(before.length, 2);
  assert.deepEqual(before[1], {
    node_id: remoteId,
    label: "Remote A",
    connected: false,
    coordinator: false,
    operations: [],
    root_ids: [],
    roots: [],
    path_base: "root",
    last_seen_at: null,
  });

  const firstConnection = connection(1);
  registry.beginSynchronizing(remoteId, {
    connection_id: firstConnection,
    executor_generation: generation(2),
    desktop_commander_generation: generation(3),
    operations: ["file", "process"],
    roots: [{ root_id: "remote", absolute_path: "D:\\files" }],
    path_base: "root",
  }, at(2));

  const synchronizing = registry.list().find((node) => node.node_id === remoteId);
  assert.equal(synchronizing?.connected, false);
  assert.deepEqual(synchronizing?.operations, []);
  assert.deepEqual(synchronizing?.roots, []);
  assert.equal(synchronizing?.last_seen_at, null);

  const promoted = registry.activate(remoteId, firstConnection, at(3));
  assert.equal(promoted.replaced_active_connection_id, undefined);
  assert.equal(promoted.executor_generation_changed, false);

  const active = registry.list().find((node) => node.node_id === remoteId);
  assert.equal(active?.connected, true);
  assert.deepEqual(active?.operations, ["file", "process"]);
  assert.deepEqual(active?.root_ids, ["remote"]);
  assert.equal(active?.last_seen_at, new Date(at(3)).toISOString());
});

test("node registry preserves the old active connection until a replacement is synchronized", () => {
  const { registry } = configuredRegistry();
  const first = connection(4);
  registry.beginSynchronizing(remoteId, {
    connection_id: first,
    executor_generation: generation(5),
    desktop_commander_generation: generation(6),
    operations: ["file"],
    roots: [{ root_id: "old", absolute_path: "D:\\old" }],
    path_base: "root",
  }, at(4));
  registry.activate(remoteId, first, at(5));

  const second = connection(7);
  registry.beginSynchronizing(remoteId, {
    connection_id: second,
    executor_generation: generation(8),
    desktop_commander_generation: generation(9),
    operations: ["process"],
    roots: [{ root_id: "new", absolute_path: "D:\\new" }],
    path_base: "root",
  }, at(6));

  const whileSyncing = registry.list().find((node) => node.node_id === remoteId);
  assert.equal(whileSyncing?.connected, true);
  assert.deepEqual(whileSyncing?.operations, ["file"]);
  assert.deepEqual(whileSyncing?.root_ids, ["old"]);

  const third = connection(10);
  const replacedCandidate = registry.beginSynchronizing(remoteId, {
    connection_id: third,
    executor_generation: generation(11),
    desktop_commander_generation: generation(12),
    operations: ["file", "transfer"],
    roots: [{ root_id: "latest", absolute_path: "D:\\latest" }],
    path_base: "root",
  }, at(7));
  assert.equal(replacedCandidate.replaced_synchronizing_connection_id, second);

  const promoted = registry.activate(remoteId, third, at(8));
  assert.equal(promoted.replaced_active_connection_id, first);
  assert.equal(promoted.executor_generation_changed, true);

  registry.disconnect(remoteId, first);
  assert.equal(registry.list().find((node) => node.node_id === remoteId)?.connected, true);

  registry.disconnect(remoteId, third);
  const disconnected = registry.list().find((node) => node.node_id === remoteId);
  assert.equal(disconnected?.connected, false);
  assert.deepEqual(disconnected?.operations, []);
  assert.deepEqual(disconnected?.root_ids, []);
  assert.equal(disconnected?.last_seen_at, new Date(at(8)).toISOString());
});

test("node registry invalidates active and synchronizing connections when registration changes", () => {
  const { registry, config } = configuredRegistry();
  const active = connection(13);
  const candidate = connection(14);
  const state = {
    executor_generation: generation(15),
    desktop_commander_generation: generation(16),
    operations: ["file"],
    roots: [{ root_id: "remote", absolute_path: "D:\\files" }],
    path_base: "root" as const,
  };

  registry.beginSynchronizing(remoteId, { connection_id: active, ...state }, at(9));
  registry.activate(remoteId, active, at(10));
  registry.beginSynchronizing(remoteId, { connection_id: candidate, ...state }, at(11));

  const rotated = rotateExecutorKey(config, remoteId);
  const invalidated = registry.reconfigure(rotated.config);
  assert.deepEqual(new Set(invalidated.invalidated_connection_ids), new Set([active, candidate]));

  const afterRotation = registry.list().find((node) => node.node_id === remoteId);
  assert.equal(afterRotation?.connected, false);
  assert.deepEqual(afterRotation?.operations, []);

  registry.reconfigure(removeExecutor(rotated.config, remoteId));
  assert.equal(registry.list().some((node) => node.node_id === remoteId), false);
});
