import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  addExecutor,
  createInitialClusterConfig,
  setCoordinator,
} from "../src/node-cluster.js";
import { type NodeOperationName } from "../src/node-operation.js";
import { NodeRegistry } from "../src/node-registry.js";
import { CoordinatorNodeServer, ExecutorNodeClient } from "../src/node-transport.js";
import { fixture, mcp } from "./fixture.js";

const remoteId = "node_AAAAAAAAAAAAAAAAAAAAAA";
const connectionId = Buffer.alloc(32, 1).toString("base64url");
const executorGeneration = Buffer.alloc(16, 2).toString("base64url");
const commanderGeneration = Buffer.alloc(16, 3).toString("base64url");
const initialRemoteUserState = [{ principal_id: "owner@example.test", stopped: false, stop_generation: 0, stop_id: null }];

function clusterRegistry() {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const configured = addExecutor(local, remoteId, "Remote A").config;
  const registry = new NodeRegistry(configured);
  registry.setLocalCapabilities({
    operations: ["file", "process", "transfer"],
    roots: [{ root_id: "files", absolute_path: "C:\\local" }],
    path_base: "root",
  });
  return { configured, registry };
}

async function waitForRemoteActive(registry: NodeRegistry): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!registry.activeConnection(remoteId)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote node to become active.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function activateRemote(registry: NodeRegistry): void {
  registry.beginSynchronizing(remoteId, {
    connection_id: connectionId,
    executor_generation: executorGeneration,
    desktop_commander_generation: commanderGeneration,
    operations: ["file", "process", "transfer"],
    roots: [{ root_id: "remote", absolute_path: "D:\\files" }],
    path_base: "root",
  });
  registry.activate(remoteId, connectionId);
}


test("remote public process ids map to executor process ids without using local PID identifiers", async () => {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  registry.setLocalCapabilities({ operations: ["file", "process", "transfer"], roots: [], path_base: "root" });
  let nextPid = 910;
  const terminated: number[] = [];
  const executorFixture = await fixture({
    nodeId: remoteId,
    nodeLabel: "Remote A",
    processAdapter: {
      start: async (command, timeoutMs, workingDirectory) => {
        assert.equal(command, "synthetic-remote-process");
        assert.equal(timeoutMs, 1000);
        assert.equal(workingDirectory, executorFixture.root);
        nextPid += 1;
        return `PID ${nextPid}`;
      },
      read: async () => "Reading 0 new lines (total: 0 lines, 0 remaining)",
      terminate: async (pid) => { terminated.push(pid); return "Successfully initiated termination of session"; },
      sessions: async () => `PID: ${nextPid}`,
    },
  }, undefined, { startDesktopCommander: false });
  const server = new CoordinatorNodeServer({ host: "127.0.0.1", expectedBindHost: "127.0.0.1", port: 0, config: added.config, registry, userStates: () => initialRemoteUserState });
  const address = await server.start();
  const executorBase = createInitialClusterConfig("executor", "Remote A");
  const executorConfig = setCoordinator({ ...executorBase, local: { ...executorBase.local, node_id: remoteId } }, "127.0.0.1", address.port, added.psk);
  const client = new ExecutorNodeClient({
    config: executorConfig,
    capabilities: { executor_generation: executorGeneration, desktop_commander_generation: commanderGeneration, operations: ["file", "process", "transfer"], roots: [{ root_id: "files", absolute_path: executorFixture.root }], path_base: "root" },
    onRequest: (payload) => executorFixture.service.executeNodeRequest(payload),
    onCoordinatorEpoch: async (epoch) => executorFixture.service.activateNodeCoordinatorEpoch(epoch),
    isOperationAuthorized: (operation) => executorFixture.service.isNodeOperationAuthorized(operation.request, operation.operation_id.coordinator_epoch),
    onUserState: (state) => executorFixture.service.applyNodeUserState(state),
  });
  let coordinatorFixture: Awaited<ReturnType<typeof fixture>> | undefined;
  let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    await client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry);
    coordinatorFixture = await fixture({ nodeId: added.config.local.node_id, nodeLabel: added.config.local.label, nodeRegistry: registry, nodeRequest: (nodeId, payload) => server.request(nodeId, payload), nodeStateSync: (state) => server.syncUserState(state) }, undefined, { startDesktopCommander: false });
    api = await mcp(coordinatorFixture.service);
    const opened = await api.call("session_open", { node_id: remoteId, working_directory: executorFixture.root, purpose: "Remote process mapping" });
    await assert.rejects(api.call("process_status", { session_id: opened.session_id, node_id: remoteId, process_id: Buffer.alloc(32, 9).toString("base64url") }), /Operation failed/i);
    const started = await api.call("process_start", { session_id: opened.session_id, node_id: remoteId, command: "synthetic-remote-process", timeout_ms: 1000 });
    const publicId = String(started.process_id);
    const remoteIds = [...executorFixture.service.processes.keys()];
    assert.equal(remoteIds.length, 1);
    assert.notEqual(publicId, remoteIds[0]);
    const status = await api.call("process_status", { session_id: opened.session_id, node_id: remoteId, process_id: publicId });
    assert.equal(status.state, "running");
    const output = await api.call("process_output", { session_id: opened.session_id, node_id: remoteId, process_id: publicId });
    assert.equal(output.state, "running");
    const otherSession = await api.call("session_open", { node_id: remoteId, working_directory: executorFixture.root, purpose: "Mapping scope check" });
    await assert.rejects(api.call("process_status", { session_id: otherSession.session_id, node_id: remoteId, process_id: publicId }), /Operation failed/i);
    const killed = await api.call("process_kill", { session_id: opened.session_id, node_id: remoteId, process_id: publicId });
    assert.equal(killed.state, "terminating");
    assert.deepEqual(terminated, [911]);
    const replacementConnectionId = Buffer.alloc(32, 7).toString("base64url");
    registry.beginSynchronizing(remoteId, {
      connection_id: replacementConnectionId,
      executor_generation: Buffer.alloc(16, 8).toString("base64url"),
      desktop_commander_generation: commanderGeneration,
      operations: ["file", "process", "transfer"],
      roots: [{ root_id: "files", absolute_path: executorFixture.root }],
      path_base: "root",
    });
    registry.activate(remoteId, replacementConnectionId);
    await assert.rejects(api.call("process_status", { session_id: opened.session_id, node_id: remoteId, process_id: publicId }), /Operation failed/i);
    registry.disconnect(remoteId, replacementConnectionId);
    await assert.rejects(api.call("process_status", { session_id: opened.session_id, node_id: remoteId, process_id: publicId }), /Selected node is disconnected/i);
  } finally {
    await api?.close();
    await coordinatorFixture?.cleanup();
    await client.close();
    await server.close();
    await executorFixture.cleanup();
  }
});
