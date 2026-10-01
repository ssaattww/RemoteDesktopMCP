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
    args: z.object({ root_id: z.string().min(1), relative_path: z.string().min(1).max(500) }),
    response: z.object({
      transfer_id: z.string().min(16),
      filename: z.string(),
      resolved_path: z.string(),
      root_id: z.string(),
      path_base: z.literal("root"),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      chunk_bytes: z.number().int().positive(),
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
    }),
    response: z.object({
      transfer_id: z.string().min(16),
      resolved_path: z.string(),
      root_id: z.string(),
      path_base: z.literal("root"),
      chunk_bytes: z.number().int().positive(),
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
