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

async function waitForRemoteActive(registry: NodeRegistry): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!registry.activeConnection(remoteId)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote node to become active.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForRemoteDisconnected(registry: NodeRegistry): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (registry.activeConnection(remoteId)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote node to disconnect.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}


test("remote transfer ids are opaque and upload replays only identical last chunks", async () => {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  registry.setLocalCapabilities({ operations: ["file", "transfer"], roots: [], path_base: "root" });
  const executorFixture = await fixture({ nodeId: remoteId, nodeLabel: "Remote A", chunkBytes: 1024 }, undefined, { startDesktopCommander: false });
  const downloadBytes = Buffer.alloc(1536, 0x5a);
  await writeFile(path.join(executorFixture.root, "remote-download.bin"), downloadBytes);
  let dropNextDownloadChunkSocket = false;
  let downloadChunkExecutions = 0;
  const server = new CoordinatorNodeServer({ host: "127.0.0.1", expectedBindHost: "127.0.0.1", port: 0, config: added.config, registry, userStates: () => initialRemoteUserState });
  const address = await server.start();
  const executorBase = createInitialClusterConfig("executor", "Remote A");
  const executorConfig = setCoordinator({ ...executorBase, local: { ...executorBase.local, node_id: remoteId } }, "127.0.0.1", address.port, added.psk);
  const client = new ExecutorNodeClient({
    config: executorConfig,
    capabilities: { executor_generation: executorGeneration, desktop_commander_generation: commanderGeneration, operations: ["file", "transfer"], roots: [{ root_id: "files", absolute_path: executorFixture.root }], path_base: "root" },
    onRequest: async (payload) => {
      if (typeof payload === "object" && payload !== null
        && "operation" in payload && payload.operation === "file_transfer_download_chunk") downloadChunkExecutions += 1;
      const response = await executorFixture.service.executeNodeRequest(payload);
      if (dropNextDownloadChunkSocket && typeof payload === "object" && payload !== null
        && "operation" in payload && payload.operation === "file_transfer_download_chunk") {
        dropNextDownloadChunkSocket = false;
        await client.close();
      }
      return response;
    },
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
    const opened = await api.call("session_open", { node_id: remoteId, working_directory: executorFixture.root, purpose: "Remote transfer mapping" });
    const download = await api.call("file_transfer_download_begin", { session_id: opened.session_id, node_id: remoteId, root_id: "files", relative_path: "remote-download.bin" });
    const publicDownloadId = String(download.transfer_id);
    const internalDownloadId = String([...executorFixture.service.transfers.keys()][0]);
    assert.notEqual(publicDownloadId, internalDownloadId);
    const first = await api.call("file_transfer_download_chunk", { session_id: opened.session_id, transfer_id: publicDownloadId, offset: 0 });
    const replay = await api.call("file_transfer_download_chunk", { session_id: opened.session_id, transfer_id: publicDownloadId, offset: 0 });
    assert.equal(first.data, replay.data);
    assert.equal(first.next_offset, replay.next_offset);
    const originalConnectionId = registry.activeConnection(remoteId)?.connection_id;
    assert.ok(originalConnectionId);
    dropNextDownloadChunkSocket = true;
    const finalOffset = Number(first.next_offset);
    await assert.rejects(
      api.call("file_transfer_download_chunk", { session_id: opened.session_id, transfer_id: publicDownloadId, offset: finalOffset }),
      /TODO_OPERATION_OUTCOME_UNKNOWN/,
    );
    assert.equal(dropNextDownloadChunkSocket, false, "the final chunk was committed before its executor socket was closed");
    assert.equal(downloadChunkExecutions, 2, "the final chunk side effect ran exactly once before the socket closed");
    const executorTransfer = executorFixture.service.transfers.get(internalDownloadId) as unknown as {
      offset: number;
      downloadReplay?: { offset: number; data: string; nextOffset: number; complete: boolean };
    };
    assert.equal(executorTransfer?.offset, downloadBytes.length, "the executor committed the final chunk before the connection closed");
    const committedReplay = executorTransfer.downloadReplay;
    assert.ok(committedReplay);
    assert.equal(committedReplay.offset, finalOffset);
    await waitForRemoteDisconnected(registry);
    await client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry);
    const reconnectedId = registry.activeConnection(remoteId)?.connection_id;
    assert.ok(reconnectedId);
    assert.notEqual(reconnectedId, originalConnectionId, "recovery must use a new authenticated transport connection");
    const pendingStatus = await api.call("file_transfer_status", { session_id: opened.session_id, transfer_id: publicDownloadId });
    assert.equal(pendingStatus.state, "active", "a terminal executor state must stay publicly recoverable while the final chunk response is pending");
    assert.equal(pendingStatus.next_offset, finalOffset, "public offset must not pass the unreturned final chunk");
    const last = await api.call("file_transfer_download_chunk", { session_id: opened.session_id, transfer_id: publicDownloadId, offset: finalOffset });
    assert.equal(downloadChunkExecutions, 3, "recovery retries the exact same offset through the authenticated transport");
    assert.equal(executorTransfer.offset, downloadBytes.length, "executor replay must not advance the committed side effect a second time");
    assert.deepEqual(executorTransfer.downloadReplay, committedReplay, "executor replay returns the identical cached chunk");
    assert.equal(last.complete, true);
    const recoveredStatus = await api.call("file_transfer_status", { session_id: opened.session_id, transfer_id: publicDownloadId });
    assert.equal(recoveredStatus.state, "complete");
    assert.equal(recoveredStatus.next_offset, downloadBytes.length);
    assert.equal(Buffer.from(String(first.data), "base64").length + Buffer.from(String(last.data), "base64").length, downloadBytes.length);

    const uploadBytes = Buffer.from("same-chunk upload replay through authenticated executor");
    const sha256 = createHash("sha256").update(uploadBytes).digest("hex");
    const upload = await api.call("file_transfer_upload_begin", { session_id: opened.session_id, node_id: remoteId, root_id: "files", relative_path: "remote-upload.bin", size: uploadBytes.length, sha256, overwrite: false });
    const publicUploadId = String(upload.transfer_id);
    const internalUploadId = [...executorFixture.service.transfers.keys()].find((id) => id !== internalDownloadId);
    assert.ok(internalUploadId);
    assert.notEqual(publicUploadId, internalUploadId);
    const chunkArgs = { session_id: opened.session_id, transfer_id: publicUploadId, offset: 0, data: uploadBytes.toString("base64") };
    const uploaded = await api.call("file_transfer_upload_chunk", chunkArgs);
    const duplicate = await api.call("file_transfer_upload_chunk", chunkArgs);
    assert.equal(uploaded.next_offset, duplicate.next_offset);
    const committed = await api.call("file_transfer_upload_commit", { session_id: opened.session_id, transfer_id: publicUploadId });
    assert.equal(committed.sha256, sha256);
    assert.deepEqual(await readFile(path.join(executorFixture.root, "remote-upload.bin")), uploadBytes);
  } finally {
    await api?.close();
    await coordinatorFixture?.cleanup();
    await client.close();
    await server.close();
    await executorFixture.cleanup();
  }
});
