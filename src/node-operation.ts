import { createHash, randomBytes } from "node:crypto";
import { z, type ZodTypeAny } from "zod";

export type NodeOperationCapability = "file" | "transfer" | "process";

type NodeOperationContract = {
  capability: NodeOperationCapability;
  args: ZodTypeAny;
  response: ZodTypeAny;
  auditEvent: string;
  requiresSession: boolean;
};

const output = z.object({ output: z.string() });
const transferState = z.enum(["active", "complete", "cancelled", "failed", "expired"]);
const processState = z.enum(["running", "terminating", "finished"]);
const processResult = z.object({
  state: processState,
  exit_code: z.number().int().optional(),
  termination_unconfirmed: z.boolean().optional(),
  output: z.string(),
});

export const NODE_OPERATION_CONTRACTS = {
  session_validate_working_directory: {
    capability: "file",
    args: z.object({ working_directory: z.string().trim().min(1).max(4096) }),
    response: z.object({ working_directory: z.string().trim().min(1).max(4096) }),
    auditEvent: "session.validate_working_directory",
    requiresSession: false,
  },
  file_search: {
    capability: "file",
    args: z.object({ root_id: z.string().min(1), query: z.string().min(1).max(120) }),
    response: output,
    auditEvent: "file.search",
    requiresSession: true,
  },
  content_search: {
    capability: "file",
    args: z.object({ root_id: z.string().min(1), query: z.string().min(1).max(120) }),
    response: output,
    auditEvent: "file.content_search",
    requiresSession: true,
  },
  file_read: {
    capability: "file",
    args: z.object({
      root_id: z.string().min(1),
      relative_path: z.string().min(1).max(500),
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().positive().max(1000).optional(),
    }),
    response: output,
    auditEvent: "file.read",
    requiresSession: true,
  },
  file_patch: {
    capability: "file",
    args: z.object({
      root_id: z.string().min(1),
      relative_path: z.string().min(1).max(500),
      old_string: z.string().min(1).max(1_000_000),
      new_string: z.string().max(1_000_000),
      expected_replacements: z.number().int().positive().max(100),
    }),
    response: output,
    auditEvent: "file.patch",
    requiresSession: true,
  },
  file_transfer_download_begin: {
    capability: "transfer",
    args: z.object({ root_id: z.string().min(1), relative_path: z.string().min(1).max(500), inline: z.boolean().optional() }),
    response: z.object({
      transfer_id: z.string().min(16),
      filename: z.string(),
      resolved_path: z.string(),
      root_id: z.string(),
      path_base: z.literal("root"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      chunk_bytes: z.number().int().positive(),
      data: z.string().optional(),
      next_offset: z.number().int().nonnegative().optional(),
      complete: z.boolean().optional(),
    }),
    auditEvent: "transfer.begin",
    requiresSession: true,
  },
  file_transfer_download_chunk: {
    capability: "transfer",
    args: z.object({ transfer_id: z.string().min(16), offset: z.number().int().nonnegative() }),
    response: z.object({
      data: z.string(),
      next_offset: z.number().int().nonnegative(),
      complete: z.boolean(),
    }),
    auditEvent: "transfer.chunk",
    requiresSession: true,
  },
  file_transfer_upload_begin: {
    capability: "transfer",
    args: z.object({
      root_id: z.string().min(1),
      relative_path: z.string().min(1).max(500),
      size: z.number().int().nonnegative().max(25 * 1024 * 1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      overwrite: z.boolean(),
      data: z.string().max(700_000).optional(),
    }),
    response: z.object({
      transfer_id: z.string().min(16),
      resolved_path: z.string(),
      root_id: z.string(),
      path_base: z.literal("root"),
      chunk_bytes: z.number().int().positive(),
      complete: z.boolean().optional(),
      size: z.number().int().nonnegative().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    }),
    auditEvent: "transfer.begin",
    requiresSession: true,
  },
  file_transfer_upload_chunk: {
    capability: "transfer",
    args: z.object({
      transfer_id: z.string().min(16),
      offset: z.number().int().nonnegative(),
      data: z.string().max(700_000),
    }),
    response: z.object({ next_offset: z.number().int().nonnegative() }),
    auditEvent: "transfer.chunk",
    requiresSession: true,
  },
  file_transfer_upload_commit: {
    capability: "transfer",
    args: z.object({ transfer_id: z.string().min(16) }),
    response: z.object({
      resolved_path: z.string(),
      root_id: z.string(),
      path_base: z.literal("root"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    auditEvent: "transfer.complete",
    requiresSession: true,
  },
  file_transfer_status: {
    capability: "transfer",
    args: z.object({ transfer_id: z.string().min(16) }),
    response: z.object({
      state: transferState,
      next_offset: z.number().int().nonnegative(),
      transferred_bytes: z.number().int().nonnegative(),
    }),
    auditEvent: "transfer.status",
    requiresSession: true,
  },
  file_transfer_cancel: {
    capability: "transfer",
    args: z.object({ transfer_id: z.string().min(16) }),
    response: z.object({ cancelled: z.literal(true) }),
    auditEvent: "transfer.cancel",
    requiresSession: true,
  },
  process_start: {
    capability: "process",
    args: z.object({
      command: z.string().min(1).max(4000),
      timeout_ms: z.number().int().min(100).max(60_000),
      working_directory: z.string().trim().min(1).max(4096),
    }),
    response: z.object({
      process_id: z.string().min(16),
      output: z.string(),
    }),
    auditEvent: "process.start",
    requiresSession: true,
  },
  process_status: {
    capability: "process",
    args: z.object({ process_id: z.string().min(16) }),
    response: processResult,
    auditEvent: "process.status",
    requiresSession: true,
  },
  process_output: {
    capability: "process",
    args: z.object({ process_id: z.string().min(16) }),
    response: processResult,
    auditEvent: "process.output",
    requiresSession: true,
  },
  process_kill: {
    capability: "process",
    args: z.object({ process_id: z.string().min(16) }),
    response: z.object({
      state: z.enum(["running", "terminating"]),
      rejected: z.boolean().optional(),
      termination_unconfirmed: z.boolean().optional(),
    }),
    auditEvent: "process.kill_requested",
    requiresSession: true,
  },
} satisfies Record<string, NodeOperationContract>;

export type NodeOperationName = keyof typeof NODE_OPERATION_CONTRACTS;
export type NodeOperationIdentity = {
  coordinator_epoch: string;
  target_node_id: string;
  executor_generation: string;
  sequence: number;
};

export type NodeOperationEnvelope = {
  operation_id: NodeOperationIdentity;
  issued_at: number;
  request: NodeOperationRequest;
};

export type NodeOperationResponseEnvelope = {
  operation_id: NodeOperationIdentity;
  target_node_id: string;
  executor_generation: string;
  response: unknown;
};

const MAX_SAFE_SEQUENCE = Number.MAX_SAFE_INTEGER;
const NODE_ID_PATTERN = /^node_[A-Za-z0-9_-]{22}$/;
const FIXED_16_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const FIXED_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function validFixedBase64Url(value: unknown, pattern: RegExp, bytes: number): value is string {
  return typeof value === "string"
    && pattern.test(value)
    && Buffer.from(value, "base64url").length === bytes;
}

export class NodeOperationSequenceIssuer {
  readonly coordinatorEpoch = randomBytes(32).toString("base64url");
  private readonly lastSequences = new Map<string, number>();

  issue(targetNodeId: string, executorGeneration: string, request: NodeOperationRequest, issuedAt = Date.now()): NodeOperationEnvelope {
    if (!NODE_ID_PATTERN.test(targetNodeId)) throw new Error("Operation target node id is invalid.");
    if (!validFixedBase64Url(executorGeneration, FIXED_16_PATTERN, 16)) throw new Error("Executor generation is invalid.");
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error("Operation issue time is invalid.");
    const key = `${targetNodeId}:${executorGeneration}`;
    const last = this.lastSequences.get(key) ?? 0;
    if (last >= MAX_SAFE_SEQUENCE) throw new Error("OPERATION_SEQUENCE_EXHAUSTED");
    const sequence = last + 1;
    this.lastSequences.set(key, sequence);
    return {
      operation_id: {
        coordinator_epoch: this.coordinatorEpoch,
        target_node_id: targetNodeId,
        executor_generation: executorGeneration,
        sequence,
      },
      issued_at: issuedAt,
      request: parseNodeOperationRequest(request),
    };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function nodeOperationContextKey(request: NodeOperationRequest): string {
  const parsed = parseNodeOperationRequest(request);
  const digest = createHash("sha256").update(canonicalJson(parsed.args)).digest("hex");
  return JSON.stringify([
    parsed.principal_id,
    parsed.session_id ?? null,
    parsed.stop_generation,
    parsed.operation,
    digest,
  ]);
}

export function parseNodeOperationEnvelope(
  value: unknown,
  expected: { coordinatorEpoch: string; targetNodeId: string; executorGeneration: string },
  now = Date.now(),
): NodeOperationEnvelope {
  if (!isRecord(value) || !isRecord(value.operation_id)) throw new Error("Node operation envelope is invalid.");
  const identity = value.operation_id;
  if (
    identity.coordinator_epoch !== expected.coordinatorEpoch
    || identity.target_node_id !== expected.targetNodeId
    || identity.executor_generation !== expected.executorGeneration
    || !validFixedBase64Url(identity.coordinator_epoch, FIXED_32_PATTERN, 32)
    || typeof identity.target_node_id !== "string"
    || !NODE_ID_PATTERN.test(identity.target_node_id)
    || !validFixedBase64Url(identity.executor_generation, FIXED_16_PATTERN, 16)
    || !Number.isSafeInteger(identity.sequence)
    || (identity.sequence as number) <= 0
  ) throw new Error("OPERATION_IDENTITY_MISMATCH");
  if (
    !Number.isSafeInteger(value.issued_at)
    || (value.issued_at as number) <= 0
    || now - (value.issued_at as number) > 30 * 60_000
    || (value.issued_at as number) - now > 2 * 60_000
  ) throw new Error("OPERATION_EXPIRED");
  return {
    operation_id: {
      coordinator_epoch: identity.coordinator_epoch,
      target_node_id: identity.target_node_id,
      executor_generation: identity.executor_generation,
      sequence: identity.sequence as number,
    },
    issued_at: value.issued_at as number,
    request: parseNodeOperationRequest(value.request),
  };
}

export function createNodeOperationResponseEnvelope(envelope: NodeOperationEnvelope, response: unknown): NodeOperationResponseEnvelope {
  return {
    operation_id: { ...envelope.operation_id },
    target_node_id: envelope.operation_id.target_node_id,
    executor_generation: envelope.operation_id.executor_generation,
    response,
  };
}

export type NodeOperationRequest = {
  principal_id: string;
  stop_generation: number;
  session_id?: string;
  operation: NodeOperationName;
  args: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nodeOperationContract(operation: NodeOperationName): NodeOperationContract {
  return NODE_OPERATION_CONTRACTS[operation];
}

function operationName(value: unknown): NodeOperationName {
  if (typeof value !== "string" || !(value in NODE_OPERATION_CONTRACTS)) {
    throw new Error("Node operation is not supported.");
  }
  return value as NodeOperationName;
}

export function createNodeOperationRequest(
  principalId: string,
  stopGeneration: number,
  sessionId: string | undefined,
  operation: NodeOperationName,
  args: Record<string, unknown>,
): NodeOperationRequest {
  if (!principalId) throw new Error("Node operation principal is required.");
  if (!Number.isSafeInteger(stopGeneration) || stopGeneration < 0) {
    throw new Error("Node operation stop generation is invalid.");
  }
  const contract = nodeOperationContract(operation);
  if (contract.requiresSession && !sessionId) throw new Error("Node operation session is required.");
  return {
    principal_id: principalId,
    stop_generation: stopGeneration,
    ...(sessionId ? { session_id: sessionId } : {}),
    operation,
    args: contract.args.parse(args) as Record<string, unknown>,
  };
}

export function parseNodeOperationRequest(value: unknown): NodeOperationRequest {
  if (!isRecord(value)) throw new Error("Node operation request must be an object.");
  const operation = operationName(value.operation);
  const principalId = typeof value.principal_id === "string" ? value.principal_id.trim() : "";
  const stopGeneration = value.stop_generation;
  const sessionId = value.session_id;
  if (!principalId) throw new Error("Node operation principal is required.");
  if (!Number.isSafeInteger(stopGeneration) || (stopGeneration as number) < 0) {
    throw new Error("Node operation stop generation is invalid.");
  }
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length < 16)) {
    throw new Error("Node operation session is invalid.");
  }
  return createNodeOperationRequest(
    principalId,
    stopGeneration as number,
    sessionId as string | undefined,
    operation,
    isRecord(value.args) ? value.args : {},
  );
}

export function parseNodeOperationResponse(operation: NodeOperationName, value: unknown): unknown {
  return nodeOperationContract(operation).response.parse(value);
}
export function parseNodeOperationResponseEnvelope(
  value: unknown,
  expected: NodeOperationIdentity,
): NodeOperationResponseEnvelope {
  if (!isRecord(value) || !isRecord(value.operation_id)) throw new Error("Node operation response envelope is invalid.");
  const identity = value.operation_id;
  if (
    identity.coordinator_epoch !== expected.coordinator_epoch
    || identity.target_node_id !== expected.target_node_id
    || identity.executor_generation !== expected.executor_generation
    || identity.sequence !== expected.sequence
    || value.target_node_id !== expected.target_node_id
    || value.executor_generation !== expected.executor_generation
  ) throw new Error("NODE_RESPONSE_IDENTITY_MISMATCH");
  return {
    operation_id: {
      coordinator_epoch: identity.coordinator_epoch as string,
      target_node_id: identity.target_node_id as string,
      executor_generation: identity.executor_generation as string,
      sequence: identity.sequence as number,
    },
    target_node_id: value.target_node_id as string,
    executor_generation: value.executor_generation as string,
    response: value.response,
  };
}