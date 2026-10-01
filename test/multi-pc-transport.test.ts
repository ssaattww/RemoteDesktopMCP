import assert from "node:assert/strict";
import test from "node:test";
import {
  addExecutor,
  createInitialClusterConfig,
  generatePsk,
  setCoordinator,
} from "../src/node-cluster.js";
import { NodeRegistry } from "../src/node-registry.js";
import {
  CoordinatorNodeServer,
  ExecutorNodeClient,
  validateCoordinatorBindHost,
} from "../src/node-transport.js";

const remoteId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const generation = (byte: number) => Buffer.alloc(16, byte).toString("base64url");

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for node state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function configs() {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const executor = createInitialClusterConfig("executor", "Remote A");
  const executorConfig = {
    ...executor,
    local: { ...executor.local, node_id: remoteId },
  };
  return {
    coordinator: added.config,
    executor: setCoordinator(executorConfig, "127.0.0.1", 41000, added.psk),
  };
}

test("coordinator bind address must exactly match the discovered Tailscale address", () => {
  assert.equal(validateCoordinatorBindHost("100.64.1.2", "100.64.1.2"), "100.64.1.2");
  assert.throws(() => validateCoordinatorBindHost("0.0.0.0", "100.64.1.2"), /Tailscale/i);
  assert.throws(() => validateCoordinatorBindHost("192.168.1.10", "100.64.1.2"), /Tailscale/i);
});

test("executor authenticates, becomes active, and serves authenticated requests", async () => {
  const { coordinator, executor } = configs();
  const registry = new NodeRegistry(coordinator);
  registry.setLocalCapabilities({ operations: ["file"], roots: [], path_base: "root" });

  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: coordinator,
    registry,
    userStates: () => [],
    heartbeatIntervalMs: 30,
    idleTimeoutMs: 200,
  });
  const address = await server.start();

  const client = new ExecutorNodeClient({
    config: executor,
    capabilities: {
      executor_generation: generation(1),
      desktop_commander_generation: generation(2),
      operations: ["file", "process"],
      roots: [{ root_id: "remote", absolute_path: "D:\\files" }],
      path_base: "root",
    },
    onRequest: async (payload) => ({ received: payload }),
  });

  try {
    await client.connect("127.0.0.1", address.port);
    await waitFor(() => registry.list().find((node) => node.node_id === remoteId)?.connected === true);

    const listed = registry.list().find((node) => node.node_id === remoteId);
    assert.deepEqual(listed?.operations, ["file", "process"]);
    assert.deepEqual(listed?.root_ids, ["remote"]);

    const response = await server.request(remoteId, {
      principal_id: "owner@example.test",
      stop_generation: 0,
      session_id: "session-test",
      operation: "file_read",
      args: { root_id: "remote", relative_path: "note.txt" },
    });
    assert.deepEqual(response, {
      received: {
        principal_id: "owner@example.test",
        stop_generation: 0,
        session_id: "session-test",
        operation: "file_read",
        args: { root_id: "remote", relative_path: "note.txt" },
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("coordinator rejects unregistered nodes and wrong PSKs without activating them", async () => {
  const { coordinator, executor } = configs();
  const registry = new NodeRegistry(coordinator);
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: coordinator,
    registry,
    userStates: () => [],
  });
  const address = await server.start();

  const wrongPsk = setCoordinator(
    { ...executor, coordinator: undefined },
    "127.0.0.1",
    address.port,
    generatePsk(),
  );
  const badClient = new ExecutorNodeClient({
    config: wrongPsk,
    capabilities: {
      executor_generation: generation(3),
      desktop_commander_generation: generation(4),
      operations: ["file"],
      roots: [],
      path_base: "root",
    },
    onRequest: async () => null,
  });

  const unknownBase = createInitialClusterConfig("executor", "Unknown");
  const unknownConfig = setCoordinator(
    unknownBase,
    "127.0.0.1",
    address.port,
    generatePsk(),
  );
  const unknownClient = new ExecutorNodeClient({
    config: unknownConfig,
    capabilities: {
      executor_generation: generation(5),
      desktop_commander_generation: generation(6),
      operations: ["file"],
      roots: [],
      path_base: "root",
    },
    onRequest: async () => null,
  });

  try {
    await assert.rejects(badClient.connect("127.0.0.1", address.port), /authentication|challenge|closed/i);
    await assert.rejects(unknownClient.connect("127.0.0.1", address.port), /registered|closed|challenge/i);
    assert.equal(registry.list().find((node) => node.node_id === remoteId)?.connected, false);
  } finally {
    await badClient.close();
    await unknownClient.close();
    await server.close();
  }
});

test("a newly synchronized connection replaces the old active connection without stale disconnect regression", async () => {
  const { coordinator, executor } = configs();
  const registry = new NodeRegistry(coordinator);
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: coordinator,
    registry,
    userStates: () => [],
  });
  const address = await server.start();

  const makeClient = (executorGeneration: number) => new ExecutorNodeClient({
    config: executor,
    capabilities: {
      executor_generation: generation(executorGeneration),
      desktop_commander_generation: generation(executorGeneration + 1),
      operations: ["file"],
      roots: [],
      path_base: "root",
    },
    onRequest: async () => null,
  });

  const first = makeClient(7);
  const second = makeClient(9);
  try {
    await first.connect("127.0.0.1", address.port);
    await waitFor(() => registry.activeConnection(remoteId) !== undefined);
    const firstConnection = registry.activeConnection(remoteId)?.connection_id;

    await second.connect("127.0.0.1", address.port);
    await waitFor(() => registry.activeConnection(remoteId)?.connection_id !== firstConnection);
    assert.equal(registry.list().find((node) => node.node_id === remoteId)?.connected, true);

    await first.waitClosed(2_000);
    assert.equal(registry.list().find((node) => node.node_id === remoteId)?.connected, true);
  } finally {
    await first.close();
    await second.close();
    await server.close();
  }
});
