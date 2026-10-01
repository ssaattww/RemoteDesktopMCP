import assert from "node:assert/strict";
import test from "node:test";
import {
  addExecutor,
  createInitialClusterConfig,
} from "../src/node-cluster.js";
import { NodeRegistry } from "../src/node-registry.js";
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
