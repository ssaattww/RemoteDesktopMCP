import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { hashPassword } from "../src/hash-password.js";
import { RemoteDesktopService, type RuntimeConfig } from "../src/index.js";

export type Fixture = { service: RemoteDesktopService; root: string; data: string; base: string; cleanup: () => Promise<void> };

export async function fixture(): Promise<Fixture> {
  // Node 22 does not keep the test process alive for an in-memory MCP handshake.
  // This referenced timer belongs to the fixture and is always cleared by cleanup.
  const keepAlive = setInterval(() => undefined, 1_000);
  const workspace = path.resolve(process.cwd());
  const validation = path.resolve(workspace, "reference", "validation");
  const relativeValidation = path.relative(workspace, validation);
  if (!relativeValidation || relativeValidation.startsWith("..") || path.isAbsolute(relativeValidation)) throw new Error("Regression fixture directory must stay within the workspace.");
  await mkdir(validation, { recursive: true });
  const base = await mkdtemp(path.join(validation, "rdmcp-regression-"));
  const relativeBase = path.relative(validation, base);
  if (!relativeBase || relativeBase.startsWith("..") || path.isAbsolute(relativeBase)) throw new Error("Regression fixture escaped its validation directory.");
  const root = path.join(base, "files");
  const data = path.join(base, "data");
  await Promise.all([mkdir(root), mkdir(data)]);
  const cfg: RuntimeConfig = {
    baseUrl: "http://127.0.0.1",
    tokenSecret: "x".repeat(32),
    users: [{ email: "owner@example.test", passwordHash: await hashPassword("correct-horse-battery") }],
    roots: [{ id: "files", path: root }], dataDir: data, port: 0, chunkBytes: 1024,
    nodeId: "local", nodeLabel: "This PC", dcCommand: process.execPath,
    dcArgs: [path.resolve("node_modules/@wonderwhy-er/desktop-commander/dist/index.js"), "--no-onboarding"],
    allowedRedirectOrigins: new Set(["https://chatgpt.com"]),
  };
  const service = new RemoteDesktopService(cfg);
  await service.initialize();
  return { service, root, data, base, cleanup: async () => { try { await service.close(); await rm(base, { recursive: true, force: true, maxRetries: 3 }); } finally { clearInterval(keepAlive); } } };
}

export async function mcp(service: RemoteDesktopService, user = "owner@example.test") {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "regression-test", version: "1" });
  const server = service.server(user);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok("content" in response);
      const text = response.content.find((item) => item.type === "text")?.text ?? "";
      if (response.isError) throw new Error(text);
      return JSON.parse(text) as Record<string, unknown>;
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

export async function absent(file: string): Promise<void> {
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(file)));
}
