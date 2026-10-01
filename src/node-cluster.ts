import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type ClusterRole = "coordinator" | "executor";
export type ClusterRoleInput = ClusterRole | "both";
export type ClusterExecutor = { node_id: string; label: string; psk: string };
export type ClusterConfig = {
  version: 1;
  roles: ClusterRole[];
  local: { node_id: string; label: string };
  transport?: { port: number };
  coordinator?: { host: string; port: number; psk: string };
  executors: ClusterExecutor[];
};

export type NodeFrameType =
  | "ready"
  | "request"
  | "response"
  | "heartbeat"
  | "heartbeat_ack"
  | "capabilities"
  | "user_state"
  | "user_state_ack"
  | "error";
export type NodeFrameDirection = "coordinator_to_executor" | "executor_to_coordinator";
export type AuthenticatedFrame = {
  type: NodeFrameType;
  connection_id: string;
  direction: NodeFrameDirection;
  sequence: number;
  request_id: string;
  payload: string;
  mac: string;
};

const NODE_ID_RE = /^node_[A-Za-z0-9_-]{22}$/;
const BASE64URL_16_RE = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function assertPort(value: unknown, name = "port"): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535.`);
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Node label must be a string.");
  const label = value.trim();
  if (!label || label.length > 64 || hasControlCharacter(label)) {
    throw new Error("Node label must be 1-64 characters without control characters.");
  }
  return label;
}

function assertNodeId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !NODE_ID_RE.test(value) || Buffer.from(value.slice(5), "base64url").length !== 16) {
    throw new Error("node_id must be node_ plus 16 random bytes encoded as base64url.");
  }
}

function decodeFixed(value: unknown, bytes: 16 | 32, name: string): Buffer {
  const re = bytes === 16 ? BASE64URL_16_RE : BASE64URL_32_RE;
  if (typeof value !== "string" || !re.test(value)) throw new Error(`${name} has invalid base64url format.`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes) throw new Error(`${name} must decode to ${bytes} bytes.`);
  return decoded;
}

function assertPsk(value: unknown): asserts value is string {
  decodeFixed(value, 32, "PSK");
}

export function generateNodeId(): string {
  return `node_${randomBytes(16).toString("base64url")}`;
}

export function generatePsk(): string {
  return randomBytes(32).toString("base64url");
}

export function createInitialClusterConfig(role: ClusterRoleInput, label: string, port?: number): ClusterConfig {
  const roles: ClusterRole[] =
    role === "both" ? ["coordinator", "executor"] : role === "coordinator" ? ["coordinator"] : ["executor"];
  if (roles.includes("coordinator")) {
    assertPort(port, "Coordinator port");
  } else if (port !== undefined) {
    throw new Error("Executor-only config must not define a coordinator listen port.");
  }
  return parseClusterConfig({
    version: 1,
    roles,
    local: { node_id: generateNodeId(), label },
    ...(roles.includes("coordinator") ? { transport: { port } } : {}),
    executors: [],
  });
}

export function parseClusterConfig(value: unknown): ClusterConfig {
  if (!isRecord(value) || value.version !== 1) throw new Error("Cluster config version must be 1.");
  if (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > 2) {
    throw new Error("Cluster roles must contain coordinator and/or executor.");
  }
  const roles = value.roles.map((role) => {
    if (role !== "coordinator" && role !== "executor") throw new Error("Cluster roles contain an unsupported role.");
    return role;
  }) as ClusterRole[];
  if (new Set(roles).size !== roles.length) throw new Error("Cluster roles must not contain duplicates.");

  if (!isRecord(value.local)) throw new Error("Cluster local config is required.");
  assertNodeId(value.local.node_id);
  const local = { node_id: value.local.node_id, label: normalizeLabel(value.local.label) };

  let transport: { port: number } | undefined;
  if (roles.includes("coordinator")) {
    if (!isRecord(value.transport)) throw new Error("Coordinator role requires transport.port.");
    assertPort(value.transport.port, "transport.port");
    transport = { port: value.transport.port };
  } else if (value.transport !== undefined) {
    throw new Error("Executor-only config must not define transport.");
  }

  let coordinator: { host: string; port: number; psk: string } | undefined;
  if (value.coordinator !== undefined) {
    if (!roles.includes("executor") || roles.includes("coordinator")) {
      throw new Error("Coordinator connection settings are allowed only for executor-only nodes.");
    }
    if (
      !isRecord(value.coordinator)
      || typeof value.coordinator.host !== "string"
      || !value.coordinator.host.trim()
      || value.coordinator.port === undefined
      || value.coordinator.psk === undefined
    ) {
      throw new Error("Coordinator config requires host, port, and PSK.");
    }
    assertPort(value.coordinator.port, "coordinator.port");
    assertPsk(value.coordinator.psk);
    coordinator = {
      host: value.coordinator.host.trim(),
      port: value.coordinator.port,
      psk: value.coordinator.psk,
    };
  }

  if (!Array.isArray(value.executors)) throw new Error("Cluster executors must be an array.");
  if (!roles.includes("coordinator") && value.executors.length) {
    throw new Error("Executor-only nodes cannot register executors.");
  }
  const ids = new Set<string>();
  const executors = value.executors.map((entry) => {
    if (!isRecord(entry)) throw new Error("Executor registration must be an object.");
    assertNodeId(entry.node_id);
    if (entry.node_id === local.node_id) throw new Error("Local node_id must not be registered as a remote executor.");
    if (ids.has(entry.node_id)) throw new Error("Executor node_id is already registered.");
    ids.add(entry.node_id);
    assertPsk(entry.psk);
    return { node_id: entry.node_id, label: normalizeLabel(entry.label), psk: entry.psk };
  });

  return {
    version: 1,
    roles,
    local,
    ...(transport ? { transport } : {}),
    ...(coordinator ? { coordinator } : {}),
    executors,
  };
}

function requireCoordinator(config: ClusterConfig): void {
  if (!config.roles.includes("coordinator")) throw new Error("This operation requires a coordinator role.");
}

function requireExecutorOnly(config: ClusterConfig): void {
  if (config.roles.length !== 1 || config.roles[0] !== "executor") {
    throw new Error("This operation is supported only by executor-only nodes.");
  }
}

export function addExecutor(config: ClusterConfig, nodeId: string, label: string): { config: ClusterConfig; psk: string } {
  const current = parseClusterConfig(config);
  requireCoordinator(current);
  assertNodeId(nodeId);
  if (nodeId === current.local.node_id) throw new Error("Local node_id cannot be registered as an executor.");
  if (current.executors.some((entry) => entry.node_id === nodeId)) throw new Error("Executor node_id is already registered.");
  const psk = generatePsk();
  current.executors.push({ node_id: nodeId, label: normalizeLabel(label), psk });
  return { config: parseClusterConfig(current), psk };
}

export function rotateExecutorKey(config: ClusterConfig, nodeId: string): { config: ClusterConfig; psk: string } {
  const current = parseClusterConfig(config);
  requireCoordinator(current);
  const index = current.executors.findIndex((entry) => entry.node_id === nodeId);
  if (index < 0) throw new Error("Executor is not registered.");
  const psk = generatePsk();
  current.executors[index] = { ...current.executors[index]!, psk };
  return { config: parseClusterConfig(current), psk };
}

export function removeExecutor(config: ClusterConfig, nodeId: string): ClusterConfig {
  const current = parseClusterConfig(config);
  requireCoordinator(current);
  if (!current.executors.some((entry) => entry.node_id === nodeId)) throw new Error("Executor is not registered.");
  current.executors = current.executors.filter((entry) => entry.node_id !== nodeId);
  return parseClusterConfig(current);
}

export function setCoordinator(config: ClusterConfig, host: string, port: number, psk: string): ClusterConfig {
  const current = parseClusterConfig(config);
  requireExecutorOnly(current);
  if (!host.trim()) throw new Error("Coordinator host is required.");
  assertPort(port, "coordinator.port");
  assertPsk(psk);
  current.coordinator = { host: host.trim(), port, psk };
  return parseClusterConfig(current);
}

export function clearCoordinator(config: ClusterConfig): ClusterConfig {
  const current = parseClusterConfig(config);
  requireExecutorOnly(current);
  delete current.coordinator;
  return parseClusterConfig(current);
}

function assertNonce(value: string, name: string): Buffer {
  return decodeFixed(value, 32, name);
}

function authMessage(
  role: ClusterRole,
  nodeId: string,
  clientNonce: string,
  serverNonce: string,
): string {
  assertNodeId(nodeId);
  assertNonce(clientNonce, "client_nonce");
  assertNonce(serverNonce, "server_nonce");
  return `rdmcp-node-auth-v1|${role}|${nodeId}|${clientNonce}|${serverNonce}`;
}

export function createAuthProof(
  role: ClusterRole,
  psk: string,
  nodeId: string,
  clientNonce: string,
  serverNonce: string,
): string {
  assertPsk(psk);
  return createHmac("sha256", Buffer.from(psk, "base64url"))
    .update(authMessage(role, nodeId, clientNonce, serverNonce))
    .digest("base64url");
}

export function verifyAuthProof(
  role: ClusterRole,
  psk: string,
  nodeId: string,
  clientNonce: string,
  serverNonce: string,
  proof: string,
): boolean {
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(createAuthProof(role, psk, nodeId, clientNonce, serverNonce), "base64url");
    actual = decodeFixed(proof, 32, "proof");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function deriveSessionKey(psk: string, clientNonce: string, serverNonce: string): Buffer {
  assertPsk(psk);
  const client = assertNonce(clientNonce, "client_nonce");
  const server = assertNonce(serverNonce, "server_nonce");
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(psk, "base64url"),
    Buffer.concat([client, server]),
    Buffer.from("rdmcp-node-session-v1", "utf8"),
    32,
  ));
}

export function deriveConnectionId(clientNonce: string, serverNonce: string): string {
  assertNonce(clientNonce, "client_nonce");
  assertNonce(serverNonce, "server_nonce");
  return createHash("sha256")
    .update(`rdmcp-node-connection-v1|${clientNonce}|${serverNonce}`)
    .digest("base64url");
}

function assertConnectionId(value: unknown): asserts value is string {
  decodeFixed(value, 32, "connection_id");
}

function assertRequestId(value: unknown): asserts value is string {
  decodeFixed(value, 16, "request_id");
}

function assertFrameType(value: unknown): asserts value is NodeFrameType {
  const allowed = new Set<NodeFrameType>([
    "ready",
    "request",
    "response",
    "heartbeat",
    "heartbeat_ack",
    "capabilities",
    "user_state",
    "user_state_ack",
    "error",
  ]);
  if (typeof value !== "string" || !allowed.has(value as NodeFrameType)) {
    throw new Error("Frame type is invalid.");
  }
}

function assertDirection(value: unknown): asserts value is NodeFrameDirection {
  if (value !== "coordinator_to_executor" && value !== "executor_to_coordinator") {
    throw new Error("Frame direction is invalid.");
  }
}

function assertTypeRequestId(type: NodeFrameType, requestId: string): void {
  if (type === "request" || type === "response" || type === "error") {
    assertRequestId(requestId);
    return;
  }
  if (requestId !== "") throw new Error("request_id must be empty for this frame type.");
}

function encodedPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function payloadHash(payload: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) throw new Error("Frame payload has invalid base64url format.");
  return createHash("sha256").update(Buffer.from(payload, "base64url")).digest("base64url");
}

function frameMacInput(frame: Omit<AuthenticatedFrame, "mac">): string {
  return [
    "rdmcp-node-frame-v1",
    frame.connection_id,
    frame.direction,
    String(frame.sequence),
    frame.type,
    frame.request_id,
    payloadHash(frame.payload),
  ].join("|");
}

export function createAuthenticatedFrame(
  sessionKey: Buffer,
  connectionId: string,
  direction: NodeFrameDirection,
  sequence: number,
  type: NodeFrameType,
  requestId: string,
  payload: unknown,
): AuthenticatedFrame {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 32) throw new Error("Session key must contain 32 bytes.");
  assertConnectionId(connectionId);
  assertDirection(direction);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Frame sequence must be a positive safe integer.");
  assertFrameType(type);
  assertTypeRequestId(type, requestId);
  const unsigned: Omit<AuthenticatedFrame, "mac"> = {
    type,
    connection_id: connectionId,
    direction,
    sequence,
    request_id: requestId,
    payload: encodedPayload(payload),
  };
  return {
    ...unsigned,
    mac: createHmac("sha256", sessionKey).update(frameMacInput(unsigned)).digest("base64url"),
  };
}

export function verifyAuthenticatedFrame(
  sessionKey: Buffer,
  frame: AuthenticatedFrame,
  expectedDirection: NodeFrameDirection,
  expectedConnectionId: string,
  lastSequence: number,
): Omit<AuthenticatedFrame, "payload"> & { payload: unknown } {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 32) throw new Error("Session key must contain 32 bytes.");
  if (!isRecord(frame)) throw new Error("Frame must be an object.");
  assertConnectionId(expectedConnectionId);
  assertDirection(expectedDirection);
  if (frame.connection_id !== expectedConnectionId) throw new Error("Frame connection_id does not match.");
  if (frame.direction !== expectedDirection) throw new Error("Frame direction does not match.");
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= lastSequence) {
    throw new Error("Frame sequence is replayed or out of order.");
  }
  assertFrameType(frame.type);
  assertTypeRequestId(frame.type, frame.request_id);
  if (typeof frame.payload !== "string") throw new Error("Frame payload must be encoded text.");
  if (typeof frame.mac !== "string") throw new Error("Frame MAC is required.");

  const unsigned: Omit<AuthenticatedFrame, "mac"> = {
    type: frame.type,
    connection_id: frame.connection_id,
    direction: frame.direction,
    sequence: frame.sequence,
    request_id: frame.request_id,
    payload: frame.payload,
  };
  const expectedMac = createHmac("sha256", sessionKey).update(frameMacInput(unsigned)).digest();
  let actualMac: Buffer;
  try {
    actualMac = decodeFixed(frame.mac, 32, "MAC");
  } catch {
    throw new Error("MAC verification failed.");
  }
  if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
    throw new Error("MAC verification failed.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(frame.payload, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Frame payload is not valid JSON.");
  }
  return { ...frame, payload };
}
