import assert from "node:assert/strict";
import test from "node:test";
import { addExecutor, createInitialClusterConfig, setCoordinator } from "../src/node-cluster.js";
import { NodeRegistry } from "../src/node-registry.js";
import { CoordinatorNodeServer, ExecutorNodeClient } from "../src/node-transport.js";

const remoteId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const generation = (byte: number) => Buffer.alloc(16, byte).toString("base64url");

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote executor.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("coordinator assigns monotonic semantic operation ids inside the authenticated target generation", async () => {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  const observed: unknown[] = [];
  const state = { epoch: "", principal_id: "", stopped: true, stop_generation: -1 };
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: added.config,
    registry,
    userStates: () => [{ principal_id: "owner@example.test", stopped: false, stop_generation: 0, stop_id: null }],
  });
  const address = await server.start();
  const executorBase = createInitialClusterConfig("executor", "Remote A");
  const executorConfig = setCoordinator(
    { ...executorBase, local: { ...executorBase.local, node_id: remoteId } },
    "127.0.0.1",
    address.port,
    added.psk,
  );
  const client = new ExecutorNodeClient({
    config: executorConfig,
    capabilities: {
      executor_generation: generation(1),
      desktop_commander_generation: generation(2),
      operations: ["file"],
      roots: [],
      path_base: "root",
    },
    onRequest: async (payload) => {
      return payload;
    },
    onCoordinatorEpoch: async (epoch) => { state.epoch = epoch; },
    onUserState: async (userState) => { state.principal_id = userState.principal_id; state.stopped = userState.stopped; state.stop_generation = userState.stop_generation; },
    isOperationAuthorized: (operation) => {
      if (!observed.some((item) => (item as { operation_id?: { sequence?: number } }).operation_id?.sequence === operation.operation_id.sequence)) observed.push(operation);
      return state.epoch === operation.operation_id.coordinator_epoch
        && state.principal_id === operation.request.principal_id
        && !state.stopped
        && state.stop_generation === operation.request.stop_generation;
    },
  });
  const request = {
    principal_id: "owner@example.test",
    stop_generation: 0,
    session_id: "session-sequence-test",
    operation: "file_read" as const,
    args: { root_id: "remote", relative_path: "readme.txt" },
  };

  try {
    await client.connect("127.0.0.1", address.port);
    await waitFor(() => registry.activeConnection(remoteId) !== undefined);
    await server.request(remoteId, request);
    await server.request(remoteId, request);

    const first = observed[0] as { operation_id?: { coordinator_epoch?: string; target_node_id?: string; executor_generation?: string; sequence?: number }; request?: unknown };
    const second = observed[1] as { operation_id?: { coordinator_epoch?: string; target_node_id?: string; executor_generation?: string; sequence?: number }; request?: unknown };
    assert.ok(first.operation_id, "the executor receives a semantic operation id");
    assert.equal(first.operation_id.coordinator_epoch?.length, 43);
    assert.equal(first.operation_id.target_node_id, remoteId);
    assert.equal(first.operation_id.executor_generation, generation(1));
    assert.equal(first.operation_id.sequence, 1);
    assert.equal(second.operation_id?.coordinator_epoch, first.operation_id.coordinator_epoch);
    assert.equal(second.operation_id?.sequence, 2);
    assert.deepEqual(first.request, request);
  } finally {
    await client.close();
    await server.close();
  }
});
