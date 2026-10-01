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

test("node_list is available before session_open and keeps registered disconnected nodes visible", async () => {
  const { configured, registry } = clusterRegistry();
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
  });
  const api = await mcp(f.service);
  try {
    const result = await api.call("node_list", {});
    const nodes = result.nodes as Array<Record<string, unknown>>;
    assert.equal(nodes.length, 2);
    const local = nodes.find((node) => node.node_id === configured.local.node_id);
    const remote = nodes.find((node) => node.node_id === remoteId);
    assert.equal(local?.connected, true);
    assert.equal(local?.coordinator, true);
    assert.equal(remote?.connected, false);
    assert.deepEqual(remote?.operations, []);
    assert.deepEqual(remote?.root_ids, []);
    assert.equal(remote?.last_seen_at, null);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("session_open requires node_id with multiple targets and binds a remote session after remote path validation", async () => {
  const { configured, registry } = clusterRegistry();
  activateRemote(registry);
  const remoteRequests: unknown[] = [];
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
    nodeRequest: async (nodeId: string, payload: unknown) => {
      remoteRequests.push(payload);
      assert.equal(nodeId, remoteId);
      assert.ok(payload && typeof payload === "object");
      const request = payload as {
        operation?: unknown;
        args?: { working_directory?: unknown };
      };
      assert.equal(request.operation, "session_validate_working_directory");
      assert.equal(typeof request.args?.working_directory, "string");
      return { working_directory: request.args?.working_directory };
    },
  });
  const api = await mcp(f.service);
  try {
    await assert.rejects(
      api.call("session_open", { working_directory: f.root, purpose: "Ambiguous target" }),
      /node_id.*required/i,
    );

    const opened = await api.call("session_open", {
      node_id: remoteId,
      working_directory: "D:\\work",
      purpose: "Remote work",
    });
    assert.equal(opened.node_id, remoteId);
    assert.equal(opened.working_directory, "D:\\work");
    assert.equal(remoteRequests.length, 1);

    const sessions = await api.call("session_list", {});
    const listed = (sessions.sessions as Array<Record<string, unknown>>)
      .find((session) => session.session_id === opened.session_id);
    assert.equal(listed?.node_id, remoteId);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("session_open rejects an explicitly selected registered node while it is disconnected", async () => {
  const { configured, registry } = clusterRegistry();
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
    nodeRequest: async () => {
      throw new Error("remote request must not run while disconnected");
    },
  });
  const api = await mcp(f.service);
  try {
    await assert.rejects(
      api.call("session_open", {
        node_id: remoteId,
        working_directory: "D:\\work",
        purpose: "Disconnected remote work",
      }),
      /disconnected/i,
    );
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("file_read dispatches to the session node and rejects a different node_id", async () => {
  const { configured, registry } = clusterRegistry();
  activateRemote(registry);
  const remoteRequests: Array<Record<string, unknown>> = [];
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
    nodeRequest: async (nodeId: string, payload: unknown) => {
      assert.equal(nodeId, remoteId);
      assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
      const request = payload as Record<string, unknown>;
      remoteRequests.push(request);
      if (request.operation === "session_validate_working_directory") {
        const args = request.args as { working_directory?: unknown };
        return { working_directory: args.working_directory };
      }
      if (request.operation === "file_read") return { output: "remote-data" };
      throw new Error("unexpected remote operation");
    },
  });
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", {
      node_id: remoteId,
      working_directory: "D:\\work",
      purpose: "Remote read",
    });
    const read = await api.call("file_read", {
      session_id: opened.session_id,
      node_id: remoteId,
      root_id: "remote",
      relative_path: "note.txt",
    });
    assert.equal(read.output, "remote-data");

    const fileRequest = remoteRequests.find((request) => request.operation === "file_read");
    assert.ok(fileRequest);
    assert.equal(fileRequest.principal_id, "owner@example.test");
    assert.equal(fileRequest.stop_generation, 0);
    assert.equal(fileRequest.session_id, opened.session_id);
    assert.deepEqual(fileRequest.args, {
      root_id: "remote",
      relative_path: "note.txt",
    });

    const beforeMismatch = remoteRequests.length;
    await assert.rejects(
      api.call("file_read", {
        session_id: opened.session_id,
        node_id: configured.local.node_id,
        root_id: "files",
        relative_path: "local.txt",
      }),
      /SESSION_NODE_MISMATCH|session.*node/i,
    );
    assert.equal(remoteRequests.length, beforeMismatch);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("remote file_read rejects a disconnected bound node without failover", async () => {
  const { configured, registry } = clusterRegistry();
  activateRemote(registry);
  let fileReadRequests = 0;
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
    nodeRequest: async (_nodeId: string, payload: unknown) => {
      assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
      const request = payload as Record<string, unknown>;
      if (request.operation === "session_validate_working_directory") {
        const args = request.args as { working_directory?: unknown };
        return { working_directory: args.working_directory };
      }
      if (request.operation === "file_read") {
        fileReadRequests += 1;
        return { output: "must-not-be-used" };
      }
      throw new Error("unexpected remote operation");
    },
  });
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", {
      node_id: remoteId,
      working_directory: "D:\\work",
      purpose: "Disconnect check",
    });
    registry.disconnect(remoteId, connectionId);

    await assert.rejects(
      api.call("file_read", {
        session_id: opened.session_id,
        node_id: remoteId,
        root_id: "remote",
        relative_path: "note.txt",
      }),
      /disconnected/i,
    );
    assert.equal(fileReadRequests, 0);
  } finally {
    await api.close();
    await f.cleanup();
  }
});

test("remote search and patch use fixed internal operations on the bound node", async () => {
  const { configured, registry } = clusterRegistry();
  activateRemote(registry);
  const operations: Array<{ operation: unknown; args: unknown }> = [];
  const f = await fixture({
    nodeId: configured.local.node_id,
    nodeLabel: configured.local.label,
    nodeRegistry: registry,
    nodeRequest: async (_nodeId: string, payload: unknown) => {
      assert.ok(payload && typeof payload === "object" && !Array.isArray(payload));
      const request = payload as Record<string, unknown>;
      if (request.operation === "session_validate_working_directory") {
        const args = request.args as { working_directory?: unknown };
        return { working_directory: args.working_directory };
      }
      operations.push({ operation: request.operation, args: request.args });
      if (request.operation === "file_search") return { output: "name-result" };
      if (request.operation === "content_search") return { output: "content-result" };
      if (request.operation === "file_patch") return { output: "patched" };
      throw new Error("unexpected remote operation");
    },
  });
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", {
      node_id: remoteId,
      working_directory: "D:\\work",
      purpose: "Remote file operations",
    });
    const sessionId = opened.session_id as string;

    assert.equal((await api.call("file_search", {
      session_id: sessionId,
      node_id: remoteId,
      root_id: "remote",
      query: "*.txt",
    })).output, "name-result");
    assert.equal((await api.call("content_search", {
      session_id: sessionId,
      node_id: remoteId,
      root_id: "remote",
      query: "needle",
    })).output, "content-result");
    assert.equal((await api.call("file_patch", {
      session_id: sessionId,
      node_id: remoteId,
      root_id: "remote",
      relative_path: "note.txt",
      old_string: "before",
      new_string: "after",
      expected_replacements: 1,
    })).output, "patched");

    assert.deepEqual(operations, [
      { operation: "file_search", args: { root_id: "remote", query: "*.txt" } },
      { operation: "content_search", args: { root_id: "remote", query: "needle" } },
      {
        operation: "file_patch",
        args: {
          root_id: "remote",
          relative_path: "note.txt",
          old_string: "before",
          new_string: "after",
          expected_replacements: 1,
        },
      },
    ]);
  } finally {
    await api.close();
    await f.cleanup();
  }
});


async function waitForRemoteActive(registry: NodeRegistry, previousConnection?: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const active = registry.activeConnection(remoteId)?.connection_id;
    if (active && active !== previousConnection) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote node to become active.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForRemoteInactive(registry: NodeRegistry): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (registry.activeConnection(remoteId)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the remote node to disconnect.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("RDMCP-25-DR-003: public MCP reaches the executor common handler through authenticated node transport", async () => {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  registry.setLocalCapabilities({ operations: ["file", "transfer"], roots: [], path_base: "root" });

  const executorFixture = await fixture({ nodeId: remoteId, nodeLabel: "Remote A" });
  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: added.config,
    registry,
    userStates: () => [],
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
      executor_generation: executorGeneration,
      desktop_commander_generation: commanderGeneration,
      operations: ["file", "transfer"],
      roots: [{ root_id: "files", absolute_path: executorFixture.root }],
      path_base: "root",
    },
    onRequest: (payload) => executorFixture.service.executeNodeRequest(payload),
  });

  let coordinatorFixture: Awaited<ReturnType<typeof fixture>> | undefined;
  let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    await writeFile(path.join(executorFixture.root, "note.txt"), "remote-through-common-handler", "utf8");
    await client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry);

    coordinatorFixture = await fixture({
      nodeId: added.config.local.node_id,
      nodeLabel: added.config.local.label,
      nodeRegistry: registry,
      nodeRequest: (nodeId, payload) => server.request(nodeId, payload),
    });
    api = await mcp(coordinatorFixture.service);
    const opened = await api.call("session_open", {
      node_id: remoteId,
      working_directory: executorFixture.root,
      purpose: "Common operation composition",
    });
    const read = await api.call("file_read", {
      session_id: opened.session_id,
      node_id: remoteId,
      root_id: "files",
      relative_path: "note.txt",
    });
    assert.match(String(read.output), /remote-through-common-handler/);
  } finally {
    await api?.close();
    await coordinatorFixture?.cleanup();
    await client.close();
    await server.close();
    await executorFixture.cleanup();
  }
});

test("RDMCP-25-DR-001: download replay survives lost node responses and same-generation reconnects", async () => {
  const local = createInitialClusterConfig("both", "Coordinator", 41000);
  const added = addExecutor(local, remoteId, "Remote A");
  const registry = new NodeRegistry(added.config);
  registry.setLocalCapabilities({ operations: ["file", "transfer"], roots: [], path_base: "root" });

  const executorFixture = await fixture({ nodeId: remoteId, nodeLabel: "Remote A", chunkBytes: 1024 });
  await writeFile(path.join(executorFixture.root, "payload.bin"), Buffer.alloc(1536, 0x5a));

  const server = new CoordinatorNodeServer({
    host: "127.0.0.1",
    expectedBindHost: "127.0.0.1",
    port: 0,
    config: added.config,
    registry,
    userStates: () => [],
    requestTimeoutMs: 10_000,
  });
  const address = await server.start();
  const executorBase = createInitialClusterConfig("executor", "Remote A");
  const executorConfig = setCoordinator(
    { ...executorBase, local: { ...executorBase.local, node_id: remoteId } },
    "127.0.0.1",
    address.port,
    added.psk,
  );

  const makeClient = (blockedOffset?: number) => {
    let handled!: () => void;
    let release!: () => void;
    const handledPromise = new Promise<void>((resolve) => { handled = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const client = new ExecutorNodeClient({
      config: executorConfig,
      capabilities: {
        executor_generation: executorGeneration,
        desktop_commander_generation: commanderGeneration,
        operations: ["file", "transfer"],
        roots: [{ root_id: "files", absolute_path: executorFixture.root }],
        path_base: "root",
      },
      onRequest: async (payload) => {
        const response = await executorFixture.service.executeNodeRequest(payload);
        const request = payload as { operation?: unknown; args?: { offset?: unknown } };
        if (request.operation === "file_transfer_download_chunk" && request.args?.offset === blockedOffset) {
          handled();
          await releasePromise;
        }
        return response;
      },
    });
    return { client, handledPromise, release };
  };

  const envelope = (sessionId: string, operation: NodeOperationName, args: Record<string, unknown>) => ({
    principal_id: "owner@example.test",
    stop_generation: 0,
    session_id: sessionId,
    operation,
    args,
  });
  const sessionId = "remote-session-for-replay";

  let current = makeClient(0);
  try {
    await current.client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry);

    const begin = await server.request(remoteId, envelope(sessionId, "file_transfer_download_begin", {
      root_id: "files",
      relative_path: "payload.bin",
    })) as { transfer_id: string };
    assert.ok(begin.transfer_id);

    const firstAttempt = assert.rejects(
      server.request(remoteId, envelope(sessionId, "file_transfer_download_chunk", {
        transfer_id: begin.transfer_id,
        offset: 0,
      })),
      /NODE_OUTCOME_UNKNOWN|closed/i,
    );
    await current.handledPromise;
    const firstConnection = registry.activeConnection(remoteId)?.connection_id;
    const firstClose = current.client.close();
    await firstClose;
    await waitForRemoteInactive(registry);
    current.release();
    await firstAttempt;

    current = makeClient();
    await current.client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry, firstConnection);
    const replayedFirst = await server.request(remoteId, envelope(sessionId, "file_transfer_download_chunk", {
      transfer_id: begin.transfer_id,
      offset: 0,
    })) as { data: string; next_offset: number; complete: boolean };
    assert.equal(replayedFirst.next_offset, 1024);
    assert.equal(replayedFirst.complete, false);

    const finalOffset = replayedFirst.next_offset;
    const priorConnection = registry.activeConnection(remoteId)?.connection_id;
    await current.client.close();
    current = makeClient(finalOffset);
    await current.client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry, priorConnection);

    const finalAttempt = assert.rejects(
      server.request(remoteId, envelope(sessionId, "file_transfer_download_chunk", {
        transfer_id: begin.transfer_id,
        offset: finalOffset,
      })),
      /NODE_OUTCOME_UNKNOWN|closed/i,
    );
    await current.handledPromise;
    const finalConnection = registry.activeConnection(remoteId)?.connection_id;
    const finalClose = current.client.close();
    await finalClose;
    await waitForRemoteInactive(registry);
    current.release();
    await finalAttempt;

    current = makeClient();
    await current.client.connect("127.0.0.1", address.port);
    await waitForRemoteActive(registry, finalConnection);
    const replayedFinal = await server.request(remoteId, envelope(sessionId, "file_transfer_download_chunk", {
      transfer_id: begin.transfer_id,
      offset: finalOffset,
    })) as { data: string; next_offset: number; complete: boolean };
    assert.equal(replayedFinal.next_offset, 1536);
    assert.equal(replayedFinal.complete, true);
    assert.equal(Buffer.from(replayedFirst.data, "base64").length + Buffer.from(replayedFinal.data, "base64").length, 1536);
  } finally {
    current.release();
    await current.client.close();
    await server.close();
    await executorFixture.cleanup();
  }
});

test("RDMCP-25-DR-003: executor common handler owns the upload state machine", async () => {
  const f = await fixture({ nodeId: remoteId, nodeLabel: "Remote A", chunkBytes: 1024 });
  const sessionId = "remote-upload-session";
  const payload = Buffer.from("upload through the shared operation core");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const envelope = (operation: string, args: Record<string, unknown>) => ({
    principal_id: "owner@example.test",
    stop_generation: 0,
    session_id: sessionId,
    operation,
    args,
  });
  try {
    const begun = await f.service.executeNodeRequest(envelope("file_transfer_upload_begin", {
      root_id: "files",
      relative_path: "shared-upload.bin",
      size: payload.length,
      sha256,
      overwrite: false,
    })) as { transfer_id: string; chunk_bytes: number };
    assert.ok(begun.transfer_id);
    assert.equal(begun.chunk_bytes, 1024);

    const chunked = await f.service.executeNodeRequest(envelope("file_transfer_upload_chunk", {
      transfer_id: begun.transfer_id,
      offset: 0,
      data: payload.toString("base64"),
    })) as { next_offset: number };
    assert.equal(chunked.next_offset, payload.length);

    const committed = await f.service.executeNodeRequest(envelope("file_transfer_upload_commit", {
      transfer_id: begun.transfer_id,
    })) as { size: number; sha256: string };
    assert.equal(committed.size, payload.length);
    assert.equal(committed.sha256, sha256);
    assert.deepEqual(await readFile(path.join(f.root, "shared-upload.bin")), payload);
  } finally {
    await f.cleanup();
  }
});
