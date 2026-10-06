import { randomBytes } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  createAuthProof,
  createAuthenticatedFrame,
  deriveConnectionId,
  deriveSessionKey,
  parseClusterConfig,
  verifyAuthenticatedFrame,
  verifyAuthProof,
  type AuthenticatedFrame,
  type ClusterConfig,
  type NodeFrameDirection,
  type NodeFrameType,
} from "./node-cluster.js";
import {
  createNodeOperationResponseEnvelope,
  NodeOperationSequenceIssuer,
  parseNodeOperationEnvelope,
  parseNodeOperationResponseEnvelope,
  type NodeOperationEnvelope,
  type NodeOperationIdentity,
  type NodeOperationRequest,
} from "./node-operation.js";
import { NodeOperationReplayGuard } from "./node-operation-replay.js";
import {
  NodeRegistry,
  type NodeCapabilities,
  type NodeReadyState,
  type NodeRoot,
} from "./node-registry.js";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_PREAUTH_BYTES = 8 * 1024;
const AUTH_TIMEOUT_MS = 10_000;
const USER_SYNC_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_PENDING_REQUESTS = 32;
const MAX_UNAUTHENTICATED_CONNECTIONS = 32;

type UserState = {
  principal_id: string;
  stopped: boolean;
  stop_generation: number;
  stop_id: string | null;
  coordinator_epoch?: string;
};
type SynchronizedUserState = UserState & { coordinator_epoch: string };
type UserStateAck = { principal_id: string; stop_generation: number; coordinator_epoch: string; state_applied: true; requested_process_ids: string[]; failed_process_ids: string[] };
type NodeUserStateAck = UserStateAck & { node_id: string };
type UserStateResult = { requested_process_ids: string[]; failed_process_ids: string[] };

type ExecutorCapabilities = NodeCapabilities & {
  executor_generation: string;
  desktop_commander_generation: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  operationId: NodeOperationIdentity;
};
type PendingStateSync = {
  expected: SynchronizedUserState;
  resolve: (value: UserStateAck) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
const PROCESS_OPERATION_ISSUER = new NodeOperationSequenceIssuer();

type CoordinatorConnection = {
  nodeId: string;
  socket: Socket;
  frames: FramedSocket;
  channel: AuthenticatedChannel;
  connectionId: string;
  lastReceivedAt: number;
  pending: Map<string, PendingRequest>;
  stateSyncs: Map<string, PendingStateSync>;
  stateSyncTail?: Promise<void>;
  heartbeatTimer?: NodeJS.Timeout;
  closed: boolean;
};

type CoordinatorNodeServerOptions = {
  host: string;
  expectedBindHost: string;
  port: number;
  config: ClusterConfig;
  registry: NodeRegistry;
  userStates: () => UserState[];
  heartbeatIntervalMs?: number;
  idleTimeoutMs?: number;
  authenticationTimeoutMs?: number;
  userSyncTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type ExecutorNodeClientOptions = {
  config: ClusterConfig;
  capabilities: ExecutorCapabilities;
  onRequest: (payload: NodeOperationRequest) => Promise<unknown>;
  isOperationAuthorized?: (payload: NodeOperationEnvelope) => boolean;
  onCoordinatorEpoch?: (epoch: string) => Promise<void>;
  onUserState?: (state: SynchronizedUserState) => Promise<UserStateResult | void>;
  authenticationTimeoutMs?: number;
};

type QueuedFrame = { bytes: number; value: unknown };
type FrameWaiter = {
  maxBytes: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fixedBase64Url(value: unknown, bytes: number, name: string): string {
  const expectedLength = bytes === 16 ? 22 : 43;
  if (
    typeof value !== "string"
    || value.length !== expectedLength
    || !/^[A-Za-z0-9_-]+$/.test(value)
    || Buffer.from(value, "base64url").length !== bytes
  ) {
    throw new Error(name + " is invalid.");
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(name + " must be a string array.");
  }
  return [...value] as string[];
}

function nodeRoots(value: unknown): NodeRoot[] {
  if (!Array.isArray(value)) throw new Error("roots must be an array.");
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.root_id !== "string"
      || !entry.root_id
      || typeof entry.absolute_path !== "string"
      || !entry.absolute_path
    ) {
      throw new Error("roots contains an invalid entry.");
    }
    return { root_id: entry.root_id, absolute_path: entry.absolute_path };
  });
}

function readyState(payload: unknown, connectionId: string): NodeReadyState {
  if (!isRecord(payload)) throw new Error("ready payload must be an object.");
  if (payload.path_base !== "root") throw new Error("ready path_base must be root.");
  return {
    connection_id: connectionId,
    executor_generation: fixedBase64Url(payload.executor_generation, 16, "executor_generation"),
    desktop_commander_generation: fixedBase64Url(
      payload.desktop_commander_generation,
      16,
      "desktop_commander_generation",
    ),
    operations: stringArray(payload.operations, "operations"),
    roots: nodeRoots(payload.roots),
    path_base: "root",
  };
}

function parseUserState(value: unknown): SynchronizedUserState {
  if (
    !isRecord(value)
    || typeof value.principal_id !== "string"
    || !value.principal_id
    || typeof value.stopped !== "boolean"
    || !Number.isSafeInteger(value.stop_generation)
    || (value.stop_generation as number) < 0
    || !(typeof value.stop_id === "string" || value.stop_id === null)
  ) {
    throw new Error("user_state payload is invalid.");
  }
  return {
    principal_id: value.principal_id,
    stopped: value.stopped,
    stop_generation: value.stop_generation as number,
    stop_id: value.stop_id as string | null,
    coordinator_epoch: fixedBase64Url(value.coordinator_epoch, 32, "coordinator_epoch"),
  };
}

function assertUserStateAck(value: unknown, expected: UserState): void {
  if (
    !isRecord(value)
    || value.principal_id !== expected.principal_id
    || value.stop_generation !== expected.stop_generation
    || value.coordinator_epoch !== expected.coordinator_epoch
    || value.state_applied !== true
    || !Array.isArray(value.requested_process_ids)
    || value.requested_process_ids.some((entry) => typeof entry !== "string")
    || !Array.isArray(value.failed_process_ids)
    || value.failed_process_ids.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("user_state_ack does not match the synchronized state.");
  }
}

function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), remaining);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class FramedSocket {
  private buffer = Buffer.alloc(0);
  private readonly queue: QueuedFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private terminalError?: Error;

  constructor(readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.receive(chunk);
    });
    socket.on("error", (error: Error) => {
      this.finish(error);
    });
    socket.on("close", () => {
      this.finish(new Error("Connection closed."));
    });
  }

  private receive(chunk: Buffer): void {
    if (this.terminalError) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) {
        this.fail(new Error("Node frame exceeds the maximum size."));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        this.fail(new Error("Node frame contains invalid JSON."));
        return;
      }
      this.deliver({ bytes: length, value });
    }
  }

  private deliver(frame: QueuedFrame): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.queue.push(frame);
      return;
    }
    if (frame.bytes > waiter.maxBytes) {
      const error = new Error("Node frame exceeds the allowed size for this protocol phase.");
      waiter.reject(error);
      this.fail(error);
      return;
    }
    waiter.resolve(frame.value);
  }

  private fail(error: Error): void {
    this.finish(error);
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private finish(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    while (this.waiters.length) this.waiters.shift()?.reject(error);
  }

  read(maxBytes = MAX_FRAME_BYTES): Promise<unknown> {
    const frame = this.queue.shift();
    if (frame) {
      if (frame.bytes > maxBytes) {
        const error = new Error("Node frame exceeds the allowed size for this protocol phase.");
        this.fail(error);
        return Promise.reject(error);
      }
      return Promise.resolve(frame.value);
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ maxBytes, resolve, reject });
    });
  }

  async write(value: unknown, maxBytes = MAX_FRAME_BYTES): Promise<void> {
    if (this.socket.destroyed) throw new Error("Connection is closed.");
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > maxBytes) throw new Error("Node frame exceeds the allowed size.");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    await new Promise<void>((resolve, reject) => {
      try {
        this.socket.write(Buffer.concat([header, body]), () => resolve());
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Node frame write failed."));
      }
    });
  }
}

class AuthenticatedChannel {
  private sendSequence = 0;
  private receiveSequence = 0;

  constructor(
    private readonly frames: FramedSocket,
    private readonly sessionKey: Buffer,
    readonly connectionId: string,
    private readonly sendDirection: NodeFrameDirection,
    private readonly receiveDirection: NodeFrameDirection,
  ) {}

  async send(type: NodeFrameType, requestId: string, payload: unknown): Promise<void> {
    if (this.sendSequence >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error("Authenticated frame sequence is exhausted.");
    }
    this.sendSequence += 1;
    await this.frames.write(createAuthenticatedFrame(
      this.sessionKey,
      this.connectionId,
      this.sendDirection,
      this.sendSequence,
      type,
      requestId,
      payload,
    ));
  }

  async receive(): Promise<ReturnType<typeof verifyAuthenticatedFrame>> {
    const value = await this.frames.read();
    const verified = verifyAuthenticatedFrame(
      this.sessionKey,
      value as AuthenticatedFrame,
      this.receiveDirection,
      this.connectionId,
      this.receiveSequence,
    );
    this.receiveSequence = verified.sequence;
    return verified;
  }
}

function helloFrame(value: unknown): { nodeId: string; clientNonce: string } {
  if (
    !isRecord(value)
    || value.type !== "hello"
    || value.version !== 1
    || typeof value.node_id !== "string"
  ) {
    throw new Error("Node hello is invalid.");
  }
  return {
    nodeId: value.node_id,
    clientNonce: fixedBase64Url(value.client_nonce, 32, "client_nonce"),
  };
}

function challengeFrame(value: unknown, nodeId: string): { serverNonce: string; proof: string } {
  if (
    !isRecord(value)
    || value.type !== "challenge"
    || value.version !== 1
    || value.node_id !== nodeId
    || typeof value.proof !== "string"
  ) {
    throw new Error("Coordinator challenge is invalid.");
  }
  return {
    serverNonce: fixedBase64Url(value.server_nonce, 32, "server_nonce"),
    proof: value.proof,
  };
}

function proofFrame(value: unknown, nodeId: string): string {
  if (
    !isRecord(value)
    || value.type !== "proof"
    || value.version !== 1
    || value.node_id !== nodeId
    || typeof value.proof !== "string"
  ) {
    throw new Error("Executor proof is invalid.");
  }
  return value.proof;
}

export function validateCoordinatorBindHost(host: string, expectedTailscaleIp: string): string {
  const normalized = host.trim();
  const expected = expectedTailscaleIp.trim();
  if (!normalized || !expected || normalized !== expected) {
    throw new Error("Coordinator node listener must bind exactly to the discovered Tailscale IPv4 address.");
  }
  return normalized;
}

export class CoordinatorNodeServer {
  private readonly config: ClusterConfig;
  private readonly connections = new Map<string, CoordinatorConnection>();
  private readonly unauthenticated = new Set<Socket>();
  private server?: Server;

  constructor(private readonly options: CoordinatorNodeServerOptions) {
    this.config = parseClusterConfig(options.config);
    if (!this.config.roles.includes("coordinator")) {
      throw new Error("Coordinator node server requires the coordinator role.");
    }
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("Coordinator node server is already running.");
    const host = validateCoordinatorBindHost(this.options.host, this.options.expectedBindHost);
    const server = createServer((socket) => {
      socket.setNoDelay(true);
      if (this.unauthenticated.size >= MAX_UNAUTHENTICATED_CONNECTIONS) {
        socket.destroy();
        return;
      }
      this.unauthenticated.add(socket);
      void this.accept(socket);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port: this.options.port });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Coordinator node listener did not expose a TCP address.");
    }
    return { host: address.address, port: address.port };
  }

  private async accept(socket: Socket): Promise<void> {
    const frames = new FramedSocket(socket);
    let connection: CoordinatorConnection | undefined;
    try {
      const authDeadline = Date.now() + (this.options.authenticationTimeoutMs ?? AUTH_TIMEOUT_MS);
      const hello = helloFrame(await withDeadline(
        frames.read(MAX_PREAUTH_BYTES),
        authDeadline,
        "Node authentication timed out.",
      ));
      const registration = this.options.registry.registration(hello.nodeId);
      if (!registration) throw new Error("Executor is not registered.");

      const serverNonce = randomBytes(32).toString("base64url");
      await frames.write({
        type: "challenge",
        version: 1,
        node_id: hello.nodeId,
        server_nonce: serverNonce,
        proof: createAuthProof(
          "coordinator",
          registration.psk,
          hello.nodeId,
          hello.clientNonce,
          serverNonce,
        ),
      }, MAX_PREAUTH_BYTES);

      const proof = proofFrame(await withDeadline(
        frames.read(MAX_PREAUTH_BYTES),
        authDeadline,
        "Node authentication timed out.",
      ), hello.nodeId);
      if (!verifyAuthProof(
        "executor",
        registration.psk,
        hello.nodeId,
        hello.clientNonce,
        serverNonce,
        proof,
      )) {
        throw new Error("Executor authentication failed.");
      }

      const sessionKey = deriveSessionKey(registration.psk, hello.clientNonce, serverNonce);
      const connectionId = deriveConnectionId(hello.clientNonce, serverNonce);
      const channel = new AuthenticatedChannel(
        frames,
        sessionKey,
        connectionId,
        "coordinator_to_executor",
        "executor_to_coordinator",
      );
      const ready = await withDeadline(
        channel.receive(),
        authDeadline,
        "Node ready handshake timed out.",
      );
      if (ready.type !== "ready" || ready.request_id !== "") {
        throw new Error("Executor did not send ready after authentication.");
      }

      connection = {
        nodeId: hello.nodeId,
        socket,
        frames,
        channel,
        connectionId,
        lastReceivedAt: Date.now(),
        pending: new Map(),
        stateSyncs: new Map(),
        closed: false,
      };
      this.connections.set(connectionId, connection);
      const synchronizing = this.options.registry.beginSynchronizing(
        hello.nodeId,
        readyState(ready.payload, connectionId),
        connection.lastReceivedAt,
      );
      if (synchronizing.replaced_synchronizing_connection_id) {
        this.closeConnection(synchronizing.replaced_synchronizing_connection_id);
      }

      this.unauthenticated.delete(socket);
      const userSyncDeadline = Date.now() + (this.options.userSyncTimeoutMs ?? USER_SYNC_TIMEOUT_MS);
      await channel.send("coordinator_state", "", { coordinator_epoch: PROCESS_OPERATION_ISSUER.coordinatorEpoch });
      const epochAck = await withDeadline(channel.receive(), userSyncDeadline, "Coordinator epoch synchronization timed out.");
      if (epochAck.type !== "coordinator_state_ack" || epochAck.request_id !== "" || !isRecord(epochAck.payload) || epochAck.payload.coordinator_epoch !== PROCESS_OPERATION_ISSUER.coordinatorEpoch) {
        throw new Error("Executor did not acknowledge coordinator epoch.");
      }
      for (const state of this.options.userStates()) {
        const synchronizedState = { ...state, coordinator_epoch: PROCESS_OPERATION_ISSUER.coordinatorEpoch };
        await channel.send("user_state", "", synchronizedState);
        const ack = await withDeadline(
          channel.receive(),
          userSyncDeadline,
          "Initial user state synchronization timed out.",
        );
        if (ack.type !== "user_state_ack" || ack.request_id !== "") {
          throw new Error("Executor did not acknowledge initial user state.");
        }
        assertUserStateAck(ack.payload, synchronizedState);
        connection.lastReceivedAt = Date.now();
      }

      const promoted = this.options.registry.activate(
        hello.nodeId,
        connectionId,
        Date.now(),
      );
      if (promoted.replaced_active_connection_id) {
        this.closeConnection(promoted.replaced_active_connection_id);
      }
      this.startHeartbeat(connection);
      void this.runActive(connection);
    } catch {
      this.unauthenticated.delete(socket);
      if (connection) this.cleanupConnection(connection);
      else if (!socket.destroyed) socket.destroy();
    }
  }

  private startHeartbeat(connection: CoordinatorConnection): void {
    const intervalMs = this.options.heartbeatIntervalMs ?? 15_000;
    const idleTimeoutMs = this.options.idleTimeoutMs ?? 45_000;
    connection.heartbeatTimer = setInterval(() => {
      if (connection.closed) return;
      if (Date.now() - connection.lastReceivedAt >= idleTimeoutMs) {
        connection.socket.destroy();
        return;
      }
      void connection.channel.send("heartbeat", "", { at: new Date().toISOString() })
        .catch(() => connection.socket.destroy());
    }, intervalMs);
    connection.heartbeatTimer.unref();
  }

  private async runActive(connection: CoordinatorConnection): Promise<void> {
    try {
      while (!connection.closed && !connection.socket.destroyed) {
        const frame = await connection.channel.receive();
        connection.lastReceivedAt = Date.now();
        this.options.registry.touch(connection.nodeId, connection.connectionId, connection.lastReceivedAt);
        if (frame.type === "heartbeat_ack") continue;
        if (frame.type === "heartbeat") {
          await connection.channel.send("heartbeat_ack", "", { at: new Date().toISOString() });
          continue;
        }
        if (frame.type === "response" || frame.type === "error") {
          const pending = connection.pending.get(frame.request_id);
          if (!pending) continue;
          connection.pending.delete(frame.request_id);
          clearTimeout(pending.timer);
          if (frame.type === "response") {
            try { pending.resolve(parseNodeOperationResponseEnvelope(frame.payload, pending.operationId).response); }
            catch (error) { pending.reject(error instanceof Error ? error : new Error("Node response identity mismatch.")); }
          }
          else pending.reject(new Error(
            isRecord(frame.payload) && typeof frame.payload.code === "string"
              ? frame.payload.code
              : "NODE_REQUEST_FAILED",
          ));
          continue;
        }
        if (frame.type === "user_state_ack") {
          const [key, pending] = connection.stateSyncs.entries().next().value ?? [];
          if (!key || !pending) continue;
          connection.stateSyncs.delete(key);
          clearTimeout(pending.timer);
          try {
            assertUserStateAck(frame.payload, pending.expected);
            pending.resolve(frame.payload as UserStateAck);
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error("User state acknowledgement is invalid."));
          }
          continue;
        }
        if (frame.type === "capabilities") continue;
        throw new Error("Unexpected authenticated frame from executor.");
      }
    } catch {
      this.cleanupConnection(connection);
    }
  }

  private closeConnection(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection && !connection.socket.destroyed) connection.socket.destroy();
  }

  private cleanupConnection(connection: CoordinatorConnection): void {
    if (connection.closed) return;
    connection.closed = true;
    if (connection.heartbeatTimer) clearInterval(connection.heartbeatTimer);
    this.connections.delete(connection.connectionId);
    this.options.registry.disconnect(connection.nodeId, connection.connectionId);
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("NODE_OUTCOME_UNKNOWN"));
    }
    connection.pending.clear();
    for (const pending of connection.stateSyncs.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("NODE_STATE_SYNC_UNAVAILABLE"));
    }
    connection.stateSyncs.clear();
    if (!connection.socket.destroyed) connection.socket.destroy();
  }

  async request(nodeId: string, payload: NodeOperationRequest): Promise<unknown> {
    const active = this.options.registry.activeConnection(nodeId);
    if (!active) throw new Error("Node is disconnected.");
    const connection = this.connections.get(active.connection_id);
    if (!connection || connection.closed || connection.socket.destroyed) {
      throw new Error("Node is disconnected.");
    }
    if (connection.pending.size >= MAX_PENDING_REQUESTS) throw new Error("Node is busy.");
    const requestId = randomBytes(16).toString("base64url");
    const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId);
        reject(new Error("NODE_OUTCOME_UNKNOWN"));
      }, timeoutMs);
      timer.unref();
      const operation = PROCESS_OPERATION_ISSUER.issue(nodeId, active.executor_generation, payload);
      connection.pending.set(requestId, { resolve, reject, timer, operationId: operation.operation_id });
      void connection.channel.send("request", requestId, operation).catch((error: unknown) => {
        const pending = connection.pending.get(requestId);
        if (!pending) return;
        connection.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error("Node request failed."));
      });
    });
  }

  async syncUserState(state: UserState): Promise<NodeUserStateAck[]> {
    const synchronizedState = { ...state, coordinator_epoch: PROCESS_OPERATION_ISSUER.coordinatorEpoch };
    const active = [...this.connections.values()].filter((connection) => {
      const current = this.options.registry.activeConnection(connection.nodeId);
      return current?.connection_id === connection.connectionId && !connection.closed && !connection.socket.destroyed;
    });
    if (!active.length) throw new Error("NODE_STATE_SYNC_UNAVAILABLE");
    return Promise.all(active.map((connection) => {
      const previous = connection.stateSyncTail ?? Promise.resolve();
      const current = previous.then(() => new Promise<UserStateAck>((resolve, reject) => {
        if (connection.closed || connection.socket.destroyed) {
          reject(new Error("NODE_STATE_SYNC_UNAVAILABLE"));
          return;
        }
        const key = randomBytes(16).toString("base64url");
        const timeoutMs = this.options.userSyncTimeoutMs ?? USER_SYNC_TIMEOUT_MS;
        const timer = setTimeout(() => {
          connection.stateSyncs.delete(key);
          reject(new Error("NODE_STATE_SYNC_TIMEOUT"));
        }, timeoutMs);
        timer.unref();
        connection.stateSyncs.set(key, { expected: synchronizedState, resolve, reject, timer });
        void connection.channel.send("user_state", "", synchronizedState).catch((error: unknown) => {
          const pending = connection.stateSyncs.get(key);
          if (!pending) return;
          connection.stateSyncs.delete(key);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("NODE_STATE_SYNC_FAILED"));
        });
      }));
      connection.stateSyncTail = current.then(() => undefined, () => undefined);
      return current.then((ack) => ({ ...ack, node_id: connection.nodeId }));
    }));
  }

  async close(): Promise<void> {
    for (const socket of this.unauthenticated) socket.destroy();
    this.unauthenticated.clear();
    for (const connection of [...this.connections.values()]) this.cleanupConnection(connection);
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

export class ExecutorNodeClient {
  private readonly config: ClusterConfig;
  private socket?: Socket;
  private channel?: AuthenticatedChannel;
  private coordinatorEpoch?: string;
  private readonly replayGuard = new NodeOperationReplayGuard();
  private closedPromise: Promise<void> = Promise.resolve();
  private resolveClosed?: () => void;

  constructor(private readonly options: ExecutorNodeClientOptions) {
    this.config = parseClusterConfig(options.config);
    if (
      this.config.roles.length !== 1
      || this.config.roles[0] !== "executor"
      || !this.config.coordinator
    ) {
      throw new Error("Executor node client requires executor-only configuration with a coordinator.");
    }
  }

  async connect(host = this.config.coordinator!.host, port = this.config.coordinator!.port): Promise<void> {
    if (this.socket && !this.socket.destroyed) throw new Error("Executor node client is already connected.");
    const socket = createConnection({ host, port });
    socket.setNoDelay(true);
    this.socket = socket;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.once("close", () => {
      this.resolveClosed?.();
      this.resolveClosed = undefined;
    });
    const frames = new FramedSocket(socket);

    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off("connect", onConnect);
          reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });

      const deadline = Date.now() + (this.options.authenticationTimeoutMs ?? AUTH_TIMEOUT_MS);
      const clientNonce = randomBytes(32).toString("base64url");
      await frames.write({
        type: "hello",
        version: 1,
        node_id: this.config.local.node_id,
        client_nonce: clientNonce,
      }, MAX_PREAUTH_BYTES);

      const challenge = challengeFrame(await withDeadline(
        frames.read(MAX_PREAUTH_BYTES),
        deadline,
        "Coordinator challenge timed out.",
      ), this.config.local.node_id);
      const psk = this.config.coordinator!.psk;
      if (!verifyAuthProof(
        "coordinator",
        psk,
        this.config.local.node_id,
        clientNonce,
        challenge.serverNonce,
        challenge.proof,
      )) {
        throw new Error("Coordinator authentication failed.");
      }

      await frames.write({
        type: "proof",
        version: 1,
        node_id: this.config.local.node_id,
        proof: createAuthProof(
          "executor",
          psk,
          this.config.local.node_id,
          clientNonce,
          challenge.serverNonce,
        ),
      }, MAX_PREAUTH_BYTES);

      const connectionId = deriveConnectionId(clientNonce, challenge.serverNonce);
      const channel = new AuthenticatedChannel(
        frames,
        deriveSessionKey(psk, clientNonce, challenge.serverNonce),
        connectionId,
        "executor_to_coordinator",
        "coordinator_to_executor",
      );
      this.channel = channel;
      await channel.send("ready", "", {
        executor_generation: fixedBase64Url(
          this.options.capabilities.executor_generation,
          16,
          "executor_generation",
        ),
        desktop_commander_generation: fixedBase64Url(
          this.options.capabilities.desktop_commander_generation,
          16,
          "desktop_commander_generation",
        ),
        operations: [...this.options.capabilities.operations],
        roots: this.options.capabilities.roots.map((root) => ({ ...root })),
        path_base: this.options.capabilities.path_base,
      });
      void this.run(socket, channel);
    } catch (error) {
      if (!socket.destroyed) socket.destroy();
      this.channel = undefined;
      throw error;
    }
  }

  private async run(socket: Socket, channel: AuthenticatedChannel): Promise<void> {
    try {
      while (!socket.destroyed) {
        const frame = await channel.receive();
        if (frame.type === "heartbeat") {
          await channel.send("heartbeat_ack", "", { at: new Date().toISOString() });
          continue;
        }
        if (frame.type === "coordinator_state") {
          if (!isRecord(frame.payload)) throw new Error("Coordinator state is invalid.");
          const epoch = fixedBase64Url(frame.payload.coordinator_epoch, 32, "coordinator_epoch");
          if (!this.options.onCoordinatorEpoch) throw new Error("Executor coordinator epoch state handler is unavailable.");
          this.replayGuard.activateCoordinatorEpoch(epoch);
          await this.options.onCoordinatorEpoch(epoch);
          this.coordinatorEpoch = epoch;
          await channel.send("coordinator_state_ack", "", { coordinator_epoch: epoch });
          continue;
        }
        if (frame.type === "request") {
          void this.handleRequest(channel, frame).catch(() => {
            if (!socket.destroyed) socket.destroy();
          });
          continue;
        }
        if (frame.type === "user_state") {
          const state = parseUserState(frame.payload);
          if (state.coordinator_epoch !== this.coordinatorEpoch) throw new Error("User state coordinator epoch mismatch.");
          if (!this.options.onUserState) throw new Error("Executor user state handler is unavailable.");
          const result = await this.options.onUserState(state);
          await channel.send("user_state_ack", "", {
            principal_id: state.principal_id,
            stop_generation: state.stop_generation,
            coordinator_epoch: state.coordinator_epoch,
            state_applied: true,
            requested_process_ids: result ? result.requested_process_ids : [],
            failed_process_ids: result ? result.failed_process_ids : [],
          });
          continue;
        }
        if (frame.type === "heartbeat_ack") continue;
        throw new Error("Unexpected authenticated frame from coordinator.");
      }
    } catch {
      if (!socket.destroyed) socket.destroy();
    }
  }

  private async handleRequest(channel: AuthenticatedChannel, frame: ReturnType<typeof verifyAuthenticatedFrame>): Promise<void> {
    try {
      if (!this.coordinatorEpoch) throw new Error("Coordinator epoch has not been synchronized.");
      const operation = parseNodeOperationEnvelope(frame.payload, {
        coordinatorEpoch: this.coordinatorEpoch,
        targetNodeId: this.config.local.node_id,
        executorGeneration: this.options.capabilities.executor_generation,
      });
      const response = await this.replayGuard.execute(
        operation,
        () => this.options.isOperationAuthorized?.(operation) === true,
        () => this.options.onRequest(operation.request),
      );
      await channel.send("response", frame.request_id, createNodeOperationResponseEnvelope(operation, response));
    } catch (error) {
      await channel.send("error", frame.request_id, {
        code: "NODE_REQUEST_FAILED",
        message: error instanceof Error ? error.message : "Executor request failed.",
      });
    }
  }

  async waitClosed(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.closedPromise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for connection close.")), timeoutMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.channel = undefined;
    if (!socket) return;
    if (!socket.destroyed) socket.destroy();
    await this.closedPromise;
  }
}
