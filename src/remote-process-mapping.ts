import { randomBytes } from "node:crypto";

export type RemoteProcessBinding = {
  nodeId: string;
  executorGeneration: string;
  connectionId: string;
};

export type RemoteProcessLifecycle = "active" | "detached" | "unknown" | "stale" | "finished";

export type RemoteProcessMapping = RemoteProcessBinding & {
  trackingId: string;
  publicId?: string;
  principalId: string;
  sessionId: string;
  remoteProcessId?: string;
  state: RemoteProcessLifecycle;
  observedState?: "running" | "terminating" | "finished";
  version: number;
  createdAt: number;
  touchedAt: number;
  terminalAt?: number;
  terminalOutput?: string;
  terminalExitCode?: number;
  terminalTerminationUnconfirmed?: boolean;
  terminationUnconfirmed?: boolean;
  publicAvailable: boolean;
};

export type RemoteProcessStartInput = RemoteProcessBinding & {
  principalId: string;
  sessionId: string;
  remoteProcessId: string;
  publicId: string;
  now?: number;
};

export type RemoteProcessUnknownStartInput = RemoteProcessBinding & {
  principalId: string;
  sessionId: string;
  now?: number;
};

function copy(mapping: RemoteProcessMapping): RemoteProcessMapping {
  return { ...mapping };
}

export class RemoteProcessMappingStore {
  private readonly mappings = new Map<string, RemoteProcessMapping>();
  private readonly reservations = new Map<string, string>();
  private readonly activeLimit: number;
  private readonly totalLimit: number;
  private readonly terminalRetentionMs: number;
  private readonly terminalOutputLimit: number;

  constructor(options: { activeLimit?: number; totalLimit?: number; terminalRetentionMs?: number; terminalOutputLimit?: number } = {}) {
    this.activeLimit = options.activeLimit ?? 20;
    this.totalLimit = options.totalLimit ?? 100;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 30 * 60_000;
    this.terminalOutputLimit = options.terminalOutputLimit ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.activeLimit) || this.activeLimit < 1
      || !Number.isSafeInteger(this.totalLimit) || this.totalLimit < this.activeLimit
      || !Number.isSafeInteger(this.terminalRetentionMs) || this.terminalRetentionMs < 1
      || !Number.isSafeInteger(this.terminalOutputLimit) || this.terminalOutputLimit < 1) {
      throw new Error("Remote process mapping limits are invalid.");
    }
  }

  reserveStart(nodeId: string, now = Date.now()): string {
    this.sweep(now);
    const active = [...this.mappings.values()].filter((mapping) => mapping.nodeId === nodeId && mapping.state !== "finished").length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => reservedNodeId === nodeId).length;
    const total = [...this.mappings.values()].filter((mapping) => mapping.nodeId === nodeId).length;
    if (active + reserved >= this.activeLimit || total + reserved >= this.totalLimit) {
      throw new Error("Remote process mapping capacity is full.");
    }
    const reservation = randomBytes(16).toString("base64url");
    this.reservations.set(reservation, nodeId);
    return reservation;
  }

  releaseStart(reservation: string): void {
    this.reservations.delete(reservation);
  }

  bindStarted(reservation: string, input: RemoteProcessStartInput): RemoteProcessMapping {
    if (!this.reservations.delete(reservation)) throw new Error("Remote process start reservation is stale.");
    if (!input.publicId || !input.remoteProcessId || [...this.mappings.values()].some((item) => item.publicId === input.publicId)) {
      throw new Error("Remote process mapping identity is invalid.");
    }
    const now = input.now ?? Date.now();
    const mapping: RemoteProcessMapping = {
      trackingId: randomBytes(16).toString("base64url"),
      publicId: input.publicId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      executorGeneration: input.executorGeneration,
      connectionId: input.connectionId,
      remoteProcessId: input.remoteProcessId,
      state: "active",
      observedState: "running",
      version: 1,
      createdAt: now,
      touchedAt: now,
      publicAvailable: true,
    };
    this.mappings.set(mapping.trackingId, mapping);
    return copy(mapping);
  }

  bindUnknown(reservation: string, input: RemoteProcessUnknownStartInput): RemoteProcessMapping {
    if (!this.reservations.delete(reservation)) throw new Error("Remote process start reservation is stale.");
    const now = input.now ?? Date.now();
    const mapping: RemoteProcessMapping = {
      trackingId: randomBytes(16).toString("base64url"),
      principalId: input.principalId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      executorGeneration: input.executorGeneration,
      connectionId: input.connectionId,
      state: "unknown",
      version: 1,
      createdAt: now,
      touchedAt: now,
      publicAvailable: false,
    };
    this.mappings.set(mapping.trackingId, mapping);
    return copy(mapping);
  }

  lookupPublic(publicId: string, principalId: string, sessionId: string, nodeId: string): RemoteProcessMapping | undefined {
    const mapping = [...this.mappings.values()].find((item) => item.publicId === publicId);
    if (!mapping || !mapping.publicAvailable || mapping.state === "unknown" || mapping.state === "stale"
      || mapping.principalId !== principalId || mapping.sessionId !== sessionId || mapping.nodeId !== nodeId) return undefined;
    return copy(mapping);
  }

  lookupTracking(trackingId: string): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    return mapping ? copy(mapping) : undefined;
  }

  listTracking(): RemoteProcessMapping[] {
    return [...this.mappings.values()].map(copy);
  }

  countActive(nodeId?: string): number {
    const active = [...this.mappings.values()].filter((mapping) => mapping.state !== "finished" && (nodeId === undefined || mapping.nodeId === nodeId)).length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => nodeId === undefined || reservedNodeId === nodeId).length;
    return active + reserved;
  }

  countTotal(nodeId?: string): number {
    const total = [...this.mappings.values()].filter((mapping) => nodeId === undefined || mapping.nodeId === nodeId).length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => nodeId === undefined || reservedNodeId === nodeId).length;
    return total + reserved;
  }

  expireSession(sessionId: string): void {
    for (const mapping of this.mappings.values()) if (mapping.sessionId === sessionId && mapping.publicAvailable) {
      mapping.publicAvailable = false;
      mapping.version += 1;
    }
  }

  hidePublic(trackingId: string): void {
    const mapping = this.mappings.get(trackingId);
    if (mapping?.publicAvailable) {
      mapping.publicAvailable = false;
      mapping.version += 1;
    }
  }

  markDetached(trackingId: string, expectedVersion: number, now = Date.now()): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    if (!mapping || mapping.version !== expectedVersion || mapping.state === "finished" || mapping.state === "stale") return undefined;
    mapping.state = "detached";
    mapping.touchedAt = now;
    mapping.version += 1;
    return copy(mapping);
  }

  markStale(trackingId: string, expectedVersion: number, now = Date.now()): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    if (!mapping || mapping.version !== expectedVersion || mapping.state === "finished") return undefined;
    mapping.state = "stale";
    mapping.touchedAt = now;
    mapping.version += 1;
    return copy(mapping);
  }

  confirmStatus(
    trackingId: string,
    expectedVersion: number,
    binding: RemoteProcessBinding,
    observedState: "running" | "terminating" | "finished",
    now = Date.now(),
    terminalResult?: { exitCode?: number; terminationUnconfirmed?: boolean; output?: string },
  ): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    if (!mapping || mapping.version !== expectedVersion || mapping.state === "stale"
      || mapping.executorGeneration !== binding.executorGeneration || mapping.nodeId !== binding.nodeId) return undefined;
    mapping.connectionId = binding.connectionId;
    mapping.observedState = observedState;
    mapping.touchedAt = now;
    mapping.version += 1;
    if (observedState === "finished") {
      mapping.state = "finished";
      mapping.terminalAt ??= now;
      if (terminalResult?.output !== undefined) mapping.terminalOutput = terminalResult.output.slice(-this.terminalOutputLimit);
      if (terminalResult?.exitCode !== undefined) mapping.terminalExitCode = terminalResult.exitCode;
      if (terminalResult?.terminationUnconfirmed !== undefined) mapping.terminalTerminationUnconfirmed = terminalResult.terminationUnconfirmed;
    } else {
      mapping.terminationUnconfirmed = terminalResult?.terminationUnconfirmed ?? false;
      mapping.state = "active";
      mapping.terminalAt = undefined;
      mapping.terminalOutput = undefined;
      mapping.terminalExitCode = undefined;
      mapping.terminalTerminationUnconfirmed = undefined;
    }
    return copy(mapping);
  }

  markKillRequested(trackingId: string, expectedVersion: number, now = Date.now(), terminationUnconfirmed = false): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    if (!mapping || mapping.version !== expectedVersion || mapping.state === "finished" || mapping.state === "stale") return undefined;
    mapping.observedState = "terminating";
    mapping.terminationUnconfirmed = terminationUnconfirmed;
    mapping.touchedAt = now;
    mapping.version += 1;
    return copy(mapping);
  }

  markTerminationUnconfirmed(trackingId: string, expectedVersion: number, now = Date.now()): RemoteProcessMapping | undefined {
    const mapping = this.mappings.get(trackingId);
    if (!mapping || mapping.version !== expectedVersion || mapping.state === "finished" || mapping.state === "stale") return undefined;
    mapping.observedState = "terminating";
    mapping.terminationUnconfirmed = true;
    mapping.touchedAt = now;
    mapping.version += 1;
    return copy(mapping);
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [trackingId, mapping] of this.mappings) {
      if (mapping.state === "finished" && mapping.terminalAt !== undefined
        && now - mapping.terminalAt >= this.terminalRetentionMs) {
        this.mappings.delete(trackingId);
        removed += 1;
      }
    }
    return removed;
  }
}
