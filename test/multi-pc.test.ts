import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runNodeConfig } from "../src/node-config-cli.js";
import { ClusterConfigStore } from "../src/node-config.js";
import { assertPrivateDirectory, assertPrivateFile, protectPrivateDirectory } from "../src/private-storage.js";
import {
  addExecutor,
  clearCoordinator,
  createAuthenticatedFrame,
  createInitialClusterConfig,
  deriveConnectionId,
  deriveSessionKey,
  generatePsk,
  parseClusterConfig,
  removeExecutor,
  rotateExecutorKey,
  setCoordinator,
  verifyAuthenticatedFrame,
  verifyAuthProof,
  createAuthProof,
} from "../src/node-cluster.js";
import {
  createNodeOperationRequest,
  nodeOperationContract,
  parseNodeOperationRequest,
  parseNodeOperationResponse,
} from "../src/node-operation.js";

test("cluster config creates stable-format node IDs and validates role requirements", () => {
  const executor = createInitialClusterConfig("executor", "Executor A");
  assert.deepEqual(executor.roles, ["executor"]);
  assert.match(executor.local.node_id, /^node_[A-Za-z0-9_-]{22}$/);
  assert.equal(executor.local.label, "Executor A");
  assert.equal(executor.coordinator, undefined);
  assert.equal(executor.transport, undefined);
  assert.deepEqual(executor.executors, []);

  const coordinator = createInitialClusterConfig("coordinator", "Coordinator", 41000);
  assert.deepEqual(coordinator.roles, ["coordinator"]);
  assert.equal(coordinator.transport?.port, 41000);
  assert.throws(() => createInitialClusterConfig("coordinator", "Coordinator"), /port/i);
  assert.throws(() => createInitialClusterConfig("both", "Coordinator"), /port/i);
  assert.throws(() => createInitialClusterConfig("executor", "   "), /label/i);
  assert.throws(() => createInitialClusterConfig("executor", "x".repeat(65)), /label/i);
});

test("cluster config registration uses per-node PSKs and rejects invalid topology", () => {
  const coordinator = createInitialClusterConfig("both", "Coordinator", 41000);
  const remoteId = "node_AAAAAAAAAAAAAAAAAAAAAA";
  const added = addExecutor(coordinator, remoteId, "Remote A");
  assert.equal(added.config.executors.length, 1);
  assert.equal(added.config.executors[0]?.node_id, remoteId);
  assert.match(added.psk, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(added.psk, "base64url").length, 32);
  assert.throws(() => addExecutor(added.config, remoteId, "Remote A"), /registered/i);
  assert.throws(() => addExecutor(added.config, coordinator.local.node_id, "Self"), /local/i);

  const rotated = rotateExecutorKey(added.config, remoteId);
  assert.notEqual(rotated.psk, added.psk);
  assert.equal(rotated.config.executors[0]?.psk, rotated.psk);

  const removed = removeExecutor(rotated.config, remoteId);
  assert.deepEqual(removed.executors, []);
});

test("executor coordinator settings are atomic and executor-only", () => {
  const executor = createInitialClusterConfig("executor", "Executor A");
  const psk = generatePsk();
  const configured = setCoordinator(executor, "100.64.0.1", 41000, psk);
  assert.deepEqual(configured.coordinator, { host: "100.64.0.1", port: 41000, psk });
  const cleared = clearCoordinator(configured);
  assert.equal(cleared.coordinator, undefined);
  assert.equal(cleared.local.node_id, executor.local.node_id);

  const both = createInitialClusterConfig("both", "Coordinator", 41000);
  assert.throws(() => setCoordinator(both, "100.64.0.1", 41000, psk), /executor-only/i);
  assert.throws(() => clearCoordinator(both), /executor-only/i);
});

test("cluster config parser rejects partial coordinator config and malformed secrets", () => {
  const base = createInitialClusterConfig("executor", "Executor A");
  assert.throws(() => parseClusterConfig({
    ...base,
    coordinator: { host: "100.64.0.1", port: 41000 },
  }), /coordinator/i);

  const coordinator = createInitialClusterConfig("coordinator", "Coordinator", 41000);
  assert.throws(() => parseClusterConfig({
    ...coordinator,
    executors: [{ node_id: "node_AAAAAAAAAAAAAAAAAAAAAA", label: "Remote", psk: "bad" }],
  }), /PSK/i);
  assert.throws(() => parseClusterConfig({ ...coordinator, roles: ["coordinator", "coordinator"] }), /roles/i);
});

test("node authentication proves both roles and derives connection state", () => {
  const psk = generatePsk();
  const nodeId = "node_AAAAAAAAAAAAAAAAAAAAAA";
  const clientNonce = Buffer.alloc(32, 1).toString("base64url");
  const serverNonce = Buffer.alloc(32, 2).toString("base64url");

  const coordinatorProof = createAuthProof("coordinator", psk, nodeId, clientNonce, serverNonce);
  const executorProof = createAuthProof("executor", psk, nodeId, clientNonce, serverNonce);
  assert.notEqual(coordinatorProof, executorProof);
  assert.equal(verifyAuthProof("coordinator", psk, nodeId, clientNonce, serverNonce, coordinatorProof), true);
  assert.equal(verifyAuthProof("executor", psk, nodeId, clientNonce, serverNonce, executorProof), true);
  assert.equal(verifyAuthProof("executor", psk, nodeId, clientNonce, serverNonce, coordinatorProof), false);

  const sessionKey = deriveSessionKey(psk, clientNonce, serverNonce);
  assert.equal(sessionKey.length, 32);
  const connectionId = deriveConnectionId(clientNonce, serverNonce);
  assert.match(connectionId, /^[A-Za-z0-9_-]{43}$/);
});

test("authenticated frames reject tampering, invalid request IDs, and replayed sequences", () => {
  const psk = generatePsk();
  const clientNonce = Buffer.alloc(32, 3).toString("base64url");
  const serverNonce = Buffer.alloc(32, 4).toString("base64url");
  const sessionKey = deriveSessionKey(psk, clientNonce, serverNonce);
  const connectionId = deriveConnectionId(clientNonce, serverNonce);
  const requestId = Buffer.alloc(16, 5).toString("base64url");
  const frame = createAuthenticatedFrame(
    sessionKey,
    connectionId,
    "coordinator_to_executor",
    1,
    "request",
    requestId,
    { operation: "file_read", args: { root_id: "files", relative_path: "x.txt" } },
  );

  const verified = verifyAuthenticatedFrame(
    sessionKey,
    frame,
    "coordinator_to_executor",
    connectionId,
    0,
  );
  assert.equal(verified.sequence, 1);
  assert.deepEqual(verified.payload, { operation: "file_read", args: { root_id: "files", relative_path: "x.txt" } });

  assert.throws(() => verifyAuthenticatedFrame(sessionKey, { ...frame, type: "user_state" }, "coordinator_to_executor", connectionId, 0), /request_id|MAC|type/i);
  assert.throws(() => verifyAuthenticatedFrame(sessionKey, { ...frame, request_id: "" }, "coordinator_to_executor", connectionId, 0), /request_id|MAC/i);
  assert.throws(() => verifyAuthenticatedFrame(sessionKey, { ...frame, payload: Buffer.from("{}").toString("base64url") }, "coordinator_to_executor", connectionId, 0), /MAC/i);
  assert.throws(() => verifyAuthenticatedFrame(sessionKey, frame, "coordinator_to_executor", connectionId, 1), /sequence/i);
});

async function clusterDataFixture(): Promise<{ data: string; cleanup: () => Promise<void> }> {
  const validation = path.resolve("reference", "validation");
  await mkdir(validation, { recursive: true });
  const base = await mkdtemp(path.join(validation, "rdmcp-node-config-"));
  const data = path.join(base, "data");
  await mkdir(data);
  await protectPrivateDirectory(data);
  return {
    data,
    cleanup: async () => {
      await rm(base, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

test("cluster config store initializes once and atomically persists registered executors", async () => {
  const fixture = await clusterDataFixture();
  try {
    const store = new ClusterConfigStore(fixture.data);
    assert.equal(await store.load(), undefined);

    const initial = await store.initialize("coordinator", "Coordinator", 41000);
    assert.match(initial.local.node_id, /^node_[A-Za-z0-9_-]{22}$/);
    await assert.rejects(store.initialize("coordinator", "Replacement", 41000), /already|exist|initialized/i);

    const remote = createInitialClusterConfig("executor", "Remote A");
    const added = await store.addExecutor(remote.local.node_id, "Remote A");
    assert.match(added.psk, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await store.load())?.executors[0]?.psk, added.psk);

    const rotated = await store.rotateExecutorKey(remote.local.node_id);
    assert.match(rotated.psk, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotated.psk, added.psk);
    assert.equal((await store.load())?.executors[0]?.psk, rotated.psk);

    await store.removeExecutor(remote.local.node_id);
    assert.deepEqual((await store.load())?.executors, []);

    const nodeDirectory = path.join(fixture.data, "node");
    const configFile = path.join(nodeDirectory, "cluster.json");
    await assertPrivateDirectory(nodeDirectory);
    await assertPrivateFile(configFile);
    assert.deepEqual(await readdir(nodeDirectory), ["cluster.json"]);
    assert.doesNotMatch(await readFile(configFile, "utf8"), /Remote A/);
  } finally {
    await fixture.cleanup();
  }
});

test("cluster config store preserves node identity while coordinator settings are set and cleared", async () => {
  const fixture = await clusterDataFixture();
  try {
    const store = new ClusterConfigStore(fixture.data);
    const initial = await store.initialize("executor", "Remote A");
    const psk = generatePsk();

    const configured = await store.setCoordinator("100.64.0.10", 41000, psk);
    assert.equal(configured.local.node_id, initial.local.node_id);
    assert.deepEqual(configured.coordinator, { host: "100.64.0.10", port: 41000, psk });
    assert.deepEqual(await store.load(), configured);

    const cleared = await store.clearCoordinator();
    assert.equal(cleared.local.node_id, initial.local.node_id);
    assert.equal(cleared.coordinator, undefined);
    assert.deepEqual(await store.load(), cleared);
  } finally {
    await fixture.cleanup();
  }
});

async function invokeNodeConfig(dataDir: string, args: string[], input = ""): Promise<string[]> {
  const output: string[] = [];
  await runNodeConfig(
    args,
    { DATA_DIR: dataDir },
    {
      readStdin: async () => input,
      write: (value) => {
        output.push(value);
      },
    },
  );
  return output;
}

test("node-config coordinator commands reveal generated PSKs once but never through show", async () => {
  const fixture = await clusterDataFixture();
  try {
    const initialized = await invokeNodeConfig(fixture.data, ["init", "--role", "coordinator", "--label", "Coordinator", "--port", "41000"]);
    assert.match(initialized.join("\n"), /node_[A-Za-z0-9_-]{22}/);

    const remote = createInitialClusterConfig("executor", "Remote A");
    const added = await invokeNodeConfig(fixture.data, ["add-executor", "--node-id", remote.local.node_id, "--label", "Remote A"]);
    const addedSecret = JSON.parse(added.at(-1) ?? "{}") as { node_id?: string; psk?: string };
    assert.equal(addedSecret.node_id, remote.local.node_id);
    assert.match(addedSecret.psk ?? "", /^[A-Za-z0-9_-]{43}$/);

    const shown = (await invokeNodeConfig(fixture.data, ["show"])).join("\n");
    assert.match(shown, /Remote A/);
    assert.doesNotMatch(shown, new RegExp(addedSecret.psk ?? "impossible-secret"));

    const rotated = await invokeNodeConfig(fixture.data, ["rotate-executor-key", "--node-id", remote.local.node_id]);
    const rotatedSecret = JSON.parse(rotated.at(-1) ?? "{}") as { psk?: string };
    assert.match(rotatedSecret.psk ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(rotatedSecret.psk, addedSecret.psk);

    await invokeNodeConfig(fixture.data, ["remove-executor", "--node-id", remote.local.node_id]);
    assert.doesNotMatch((await invokeNodeConfig(fixture.data, ["show"])).join("\n"), /Remote A/);
  } finally {
    await fixture.cleanup();
  }
});

test("node-config executor commands accept coordinator PSK only through stdin and clear it atomically", async () => {
  const fixture = await clusterDataFixture();
  try {
    const initialized = await invokeNodeConfig(fixture.data, ["init", "--role", "executor", "--label", "Remote A"]);
    assert.match(initialized.join("\n"), /node_[A-Za-z0-9_-]{22}/);

    const psk = generatePsk();
    await assert.rejects(
      invokeNodeConfig(fixture.data, ["set-coordinator", "--host", "100.64.0.10", "--port", "41000", "--psk", psk]),
      /psk-stdin|standard input|stdin/i,
    );

    const configuredOutput = await invokeNodeConfig(
      fixture.data,
      ["set-coordinator", "--host", "100.64.0.10", "--port", "41000", "--psk-stdin"],
      psk + "\n",
    );
    assert.doesNotMatch(configuredOutput.join("\n"), new RegExp(psk));

    const store = new ClusterConfigStore(fixture.data);
    assert.deepEqual((await store.load())?.coordinator, { host: "100.64.0.10", port: 41000, psk });
    const shown = (await invokeNodeConfig(fixture.data, ["show"])).join("\n");
    assert.match(shown, /100\.64\.0\.10/);
    assert.doesNotMatch(shown, new RegExp(psk));

    await invokeNodeConfig(fixture.data, ["clear-coordinator"]);
    assert.equal((await store.load())?.coordinator, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("node operation registry fixes capability and schema at the transport boundary", () => {
  const request = createNodeOperationRequest(
    "owner@example.test",
    0,
    "session-test-123456",
    "file_read",
    { root_id: "files", relative_path: "note.txt" },
  );
  assert.equal(nodeOperationContract("file_read").capability, "file");
  assert.deepEqual(request.args, { root_id: "files", relative_path: "note.txt" });

  assert.throws(() => parseNodeOperationRequest({
    principal_id: "owner@example.test",
    stop_generation: 0,
    session_id: "session-test-123456",
    operation: "force_terminate",
    args: {},
  }), /not supported/i);
  assert.throws(() => parseNodeOperationRequest({
    principal_id: "owner@example.test",
    stop_generation: 0,
    session_id: "session-test-123456",
    operation: "file_read",
    args: { root_id: "files" },
  }));
  assert.throws(() => parseNodeOperationResponse("file_read", { output: 42 }));
});
