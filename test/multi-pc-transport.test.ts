import assert from "node:assert/strict";
import test from "node:test";
import { createConnection } from "node:net";
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
  const authState = { epoch: "", principal_id: "", stopped: true, stop_generation: -1 };

  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: coordinator,
    registry,
    userStates: () => [{ principal_id: "owner@example.test", stopped: false, stop_generation: 0, stop_id: null }],
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
    onCoordinatorEpoch: async (epoch) => { authState.epoch = epoch; },
    onUserState: async (state) => { authState.principal_id = state.principal_id; authState.stopped = state.stopped; authState.stop_generation = state.stop_generation; },
    isOperationAuthorized: (operation) => authState.epoch === operation.operation_id.coordinator_epoch
      && authState.principal_id === operation.request.principal_id
      && !authState.stopped
      && authState.stop_generation === operation.request.stop_generation,
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
      session_id: "session-test-123456",
      operation: "file_read",
      args: { root_id: "remote", relative_path: "note.txt" },
    });
    assert.deepEqual(response, {
      received: {
        principal_id: "owner@example.test",
        stop_generation: 0,
        session_id: "session-test-123456",
        operation: "file_read",
        args: { root_id: "remote", relative_path: "note.txt" },
      },
    });

    await assert.rejects(
      server.request(remoteId, {
        principal_id: "owner@example.test",
        stop_generation: 0,
        session_id: "session-test-123456",
        operation: "arbitrary_desktop_commander_tool",
        args: {},
      } as never),
      /Node operation is not supported/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("authenticated user stop is applied while a duplicate-safe request is pending", async () => {
  const { coordinator, executor } = configs();
  const registry = new NodeRegistry(coordinator);
  registry.setLocalCapabilities({ operations: ["file"], roots: [], path_base: "root" });
  const state = { epoch: "", principal_id: "", stopped: true, stop_generation: -1 };
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1", expectedBindHost: "127.0.0.1", port: 0, config: coordinator, registry,
    userStates: () => [{ principal_id: "owner@example.test", stopped: false, stop_generation: 0, stop_id: null }],
  });
  const address = await server.start();
  let started!: () => void;
  let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let workCount = 0;
  const client = new ExecutorNodeClient({
    config: executor,
    capabilities: { executor_generation: generation(8), desktop_commander_generation: generation(9), operations: ["file"], roots: [], path_base: "root" },
    onCoordinatorEpoch: async (epoch) => { state.epoch = epoch; },
    onUserState: async (userState) => { state.principal_id = userState.principal_id; state.stopped = userState.stopped; state.stop_generation = userState.stop_generation; },
    isOperationAuthorized: (operation) => state.epoch === operation.operation_id.coordinator_epoch
      && state.principal_id === operation.request.principal_id
      && !state.stopped
      && state.stop_generation === operation.request.stop_generation,
    onRequest: async (payload) => { workCount += 1; started(); await releasePromise; return payload; },
  });
  try {
    await client.connect("127.0.0.1", address.port);
    await waitFor(() => registry.activeConnection(remoteId) !== undefined);
    const pending = server.request(remoteId, {
      principal_id: "owner@example.test", stop_generation: 0, session_id: "session-pending-stop",
      operation: "file_read", args: { root_id: "remote", relative_path: "note.txt" },
    });
    await startedPromise;
    const acknowledgements = await server.syncUserState({ principal_id: "owner@example.test", stopped: true, stop_generation: 1, stop_id: "stop-request-0001" });
    assert.equal(acknowledgements.length, 1);
    assert.deepEqual(acknowledgements[0].failed_process_ids, []);
    release();
    await assert.rejects(pending, /NODE_REQUEST_FAILED/);
    assert.equal(workCount, 1);
  } finally {
    release();
    await client.close();
    await server.close();
  }
});

test("coordinator rejects an oversized pre-auth frame from its header without buffering a body", async () => {
  const { coordinator } = configs();
  const registry = new NodeRegistry(coordinator);
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1", expectedBindHost: "127.0.0.1", port: 0, config: coordinator, registry, userStates: () => [],
  });
  const address = await server.start();
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(8 * 1024 + 1);
    socket.write(header);
    await new Promise<void>((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
    });
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("user state sync preserves successful executor ACKs when another executor rejects the update", async () => {
  const secondRemoteId = "node_BBBBBBBBBBBBBBBBBBBBBB";
  const base = createInitialClusterConfig("both", "Coordinator", 41000);
  const first = addExecutor(base, remoteId, "Remote A");
  const second = addExecutor(first.config, secondRemoteId, "Remote B");
  const registry = new NodeRegistry(second.config);
  registry.setLocalCapabilities({ operations: ["file"], roots: [], path_base: "root" });
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1", expectedBindHost: "127.0.0.1", port: 0, config: second.config, registry,
    userStates: () => [{ principal_id: "owner@example.test", stopped: false, stop_generation: 0, stop_id: null }],
  });
  const address = await server.start();
  let rejectSecondStop = false;
  const makeClient = (nodeId: string, label: string, psk: string, rejectsStop: boolean) => {
    const executorBase = createInitialClusterConfig("executor", label);
    const executor = setCoordinator({ ...executorBase, local: { ...executorBase.local, node_id: nodeId } }, "127.0.0.1", address.port, psk);
    return new ExecutorNodeClient({
      config: executor,
      capabilities: { executor_generation: generation(rejectsStop ? 12 : 10), desktop_commander_generation: generation(11), operations: ["file"], roots: [], path_base: "root" },
      onRequest: async (payload) => payload,
      onCoordinatorEpoch: async () => undefined,
      onUserState: async (state) => {
        if (rejectsStop && rejectSecondStop && state.stopped) throw new Error("synthetic user state rejection");
      },
    });
  };
  const firstClient = makeClient(remoteId, "Remote A", first.psk, false);
  const secondClient = makeClient(secondRemoteId, "Remote B", second.psk, true);
  try {
    await firstClient.connect("127.0.0.1", address.port);
    await waitFor(() => registry.activeConnection(remoteId) !== undefined);
    await secondClient.connect("127.0.0.1", address.port);
    try { await waitFor(() => registry.activeConnection(secondRemoteId) !== undefined); }
    catch { assert.fail(`Second executor did not activate: ${JSON.stringify(registry.list())}`); }
    rejectSecondStop = true;
    const acknowledgements = await server.syncUserState({ principal_id: "owner@example.test", stopped: true, stop_generation: 1, stop_id: "partial-stop-0001" });
    assert.equal(acknowledgements.length, 2);
    assert.equal(acknowledgements.find((ack) => ack.node_id === remoteId)?.state_applied, true);
    const rejected = acknowledgements.find((ack) => ack.node_id === secondRemoteId);
    assert.equal(rejected?.state_applied, false);
    assert.ok(["NODE_STATE_SYNC_UNAVAILABLE", "NODE_STATE_SYNC_TIMEOUT", "NODE_STATE_SYNC_FAILED"].includes(rejected?.sync_error ?? ""));
  } finally {
    await Promise.all([firstClient.close(), secondClient.close()]);
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
    onCoordinatorEpoch: async () => undefined,
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
