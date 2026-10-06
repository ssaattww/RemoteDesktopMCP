import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hashPassword } from "../src/hash-password.js";
import { startFromEnvironment, discoverTailscaleIPv4 } from "../src/index.js";
import { ClusterConfigStore } from "../src/node-config.js";
import { protectPrivateDirectory } from "../src/private-storage.js";
import { mcp } from "./fixture.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function runtimeEnv(dataDir: string, root: string, passwordHash: string): NodeJS.ProcessEnv {
  return {
    BASE_URL: "http://127.0.0.1",
    PORT: "0",
    TOKEN_SECRET: "x".repeat(32),
    AUTHORIZED_USERS_JSON: JSON.stringify([{ email: "owner@example.test", passwordHash }]),
    FILE_ROOTS_JSON: JSON.stringify([{ id: "remote-files", path: root }]),
    DATA_DIR: dataDir,
  };
}

test("coordinator and executor roles start from stored cluster config and serve a remote operation", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "rdmcp-runtime-startup-"));
  const coordinatorData = path.join(temporary, "coordinator-data");
  const executorData = path.join(temporary, "executor-data");
  const coordinatorRoot = path.join(temporary, "coordinator-files");
  const executorRoot = path.join(temporary, "executor-files");
  await Promise.all([mkdir(coordinatorData), mkdir(executorData), mkdir(coordinatorRoot), mkdir(executorRoot)]);
  await Promise.all([protectPrivateDirectory(coordinatorData), protectPrivateDirectory(executorData)]);
  await writeFile(path.join(executorRoot, "startup.txt"), "served by the configured executor");
  const passwordHash = await hashPassword("correct-horse-battery");
  let coordinator: Awaited<ReturnType<typeof startFromEnvironment>> | undefined;
  let executor: Awaited<ReturnType<typeof startFromEnvironment>> | undefined;
  let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    const executorStore = new ClusterConfigStore(executorData);
    const executorConfig = await executorStore.initialize("executor", "Executor");

    const port = await availablePort();
    const coordinatorStore = new ClusterConfigStore(coordinatorData);
    await coordinatorStore.initialize("coordinator", "Coordinator", port);
    const registered = await coordinatorStore.addExecutor(executorConfig.local.node_id, executorConfig.local.label);
    await executorStore.setCoordinator("127.0.0.1", port, registered.psk);

    coordinator = await startFromEnvironment({
      env: runtimeEnv(coordinatorData, coordinatorRoot, passwordHash),
      resolveTailscaleIPv4: () => "127.0.0.1",
    });
    executor = await startFromEnvironment({ env: runtimeEnv(executorData, executorRoot, passwordHash) });

    const deadline = Date.now() + 10_000;
    while (!coordinator.nodeRegistry?.list().some((node) => node.node_id === executorConfig.local.node_id && node.connected)) {
      if (Date.now() >= deadline) throw new Error("Configured executor did not become active through the startup transport.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    api = await mcp(coordinator.service);
    const opened = await api.call("session_open", {
      node_id: executorConfig.local.node_id,
      working_directory: executorRoot,
      purpose: "Verify the configured coordinator transport",
    });
    const read = await api.call("file_read", {
      session_id: opened.session_id as string,
      node_id: executorConfig.local.node_id,
      root_id: "remote-files",
      relative_path: "startup.txt",
    });
    assert.match(String(read.output), /served by the configured executor/);
  } finally {
    await api?.close();
    await executor?.close();
    await coordinator?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("coordinator bind discovery accepts exactly one external Tailscale IPv4 address", () => {
  assert.equal(discoverTailscaleIPv4({ Ethernet: [
    { address: "192.0.2.10", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.0.2.10/24" },
    { address: "100.101.22.33", netmask: "255.192.0.0", family: "IPv4", mac: "", internal: false, cidr: "100.101.22.33/10" },
  ] }), "100.101.22.33");
  assert.throws(() => discoverTailscaleIPv4({}), /Exactly one Tailscale IPv4/);
});
