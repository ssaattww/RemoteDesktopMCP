import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RemoteDesktopService, type RuntimeConfig } from "../src/index.js";

test("the session scoped Todo tools are registered on the authenticated MCP server", async () => {
  // Listing the server contract needs no Desktop Commander process. Keeping
  // this focused harness below service.initialize() makes bridge startup
  // irrelevant to this API regression check.
  const service = new RemoteDesktopService({
    baseUrl: "http://127.0.0.1",
    tokenSecret: "x".repeat(32),
    users: [{ email: "owner@example.test", passwordHash: "unused" }],
    roots: [],
    dataDir: "/tmp/rdmcp-issue-56-contract-test",
    port: 0,
    chunkBytes: 1024,
    nodeId: "local",
    nodeLabel: "This PC",
    dcCommand: process.execPath,
    dcArgs: [],
    allowedRedirectOrigins: new Set(),
  } satisfies RuntimeConfig);
  const keepAlive = setInterval(() => undefined, 1_000);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "issue-56-contract-test", version: "1" });
  const server = service.server("owner@example.test");
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    assert.ok(names.has("todo_get"), "the session Todo must be readable by the chat");
    assert.ok(names.has("todo_update"), "the session Todo must be writable by the chat");
    assert.ok(names.has("todo_enforcement_set"), "the session freshness gate must be switchable");
  } finally {
    clearInterval(keepAlive);
    await client.close();
    await server.close();
    await service.close();
  }
});
