import { createHash, randomBytes } from "node:crypto";

export type RemoteTransferBinding = {
  nodeId: string;
  executorGeneration: string;
  connectionId: string;
};

export type RemoteTransferDirection = "download" | "upload";
export type RemoteTransferState = "active" | "detached" | "unknown" | "stale" | "complete" | "cancelled" | "failed" | "expired";
export type RemoteTransferMapping = RemoteTransferBinding & {
  trackingId: string;
  publicId?: string;
  principalId: string;
  sessionId: string;
  remoteTransferId?: string;
  direction: RemoteTransferDirection;
  state: RemoteTransferState;
  version: number;
  createdAt: number;
  touchedAt: number;
  terminalAt?: number;
  publicAvailable: boolean;
  lastAckOffset: number;
  size?: number;
  sha256?: string;
  lastUploadReplay?: { offset: number; digest: string; nextOffset: number };
  pendingUpload?: { offset: number; digest: string; byteLength: number };
  pendingDownload?: { offset: number };
  lastDownloadReplay?: { offset: number; response: { data: string; next_offset: number; complete: boolean } };
  terminalBeginResponse?: Record<string, unknown>;
  commitResponse?: Record<string, unknown>;
};

export type RemoteTransferStartInput = RemoteTransferBinding & {
  publicId: string;
  principalId: string;
  sessionId: string;
  remoteTransferId: string;
  direction: RemoteTransferDirection;
  lastAckOffset?: number;
  size?: number;
  sha256?: string;
  terminalBeginResponse?: Record<string, unknown>;
  now?: number;
};

export type RemoteTransferUnknownInput = RemoteTransferBinding & {
  principalId: string;
  sessionId: string;
  direction: RemoteTransferDirection;
  now?: number;
};

function copy(mapping: RemoteTransferMapping): RemoteTransferMapping {
  return {
    ...mapping,
    ...(mapping.lastUploadReplay ? { lastUploadReplay: { ...mapping.lastUploadReplay } } : {}),
    ...(mapping.pendingUpload ? { pendingUpload: { ...mapping.pendingUpload } } : {}),
    ...(mapping.pendingDownload ? { pendingDownload: { ...mapping.pendingDownload } } : {}),
    ...(mapping.lastDownloadReplay ? { lastDownloadReplay: { ...mapping.lastDownloadReplay, response: { ...mapping.lastDownloadReplay.response } } } : {}),
    ...(mapping.terminalBeginResponse ? { terminalBeginResponse: { ...mapping.terminalBeginResponse } } : {}),
    ...(mapping.commitResponse ? { commitResponse: { ...mapping.commitResponse } } : {}),
  };
}

export class RemoteTransferMappingStore {
  private readonly mappings = new Map<string, RemoteTransferMapping>();
  private readonly reservations = new Map<string, string>();
  private readonly activeLimit: number;
  private readonly totalLimit: number;
  private readonly terminalRetentionMs: number;

  constructor(options: { activeLimit?: number; totalLimit?: number; terminalRetentionMs?: number } = {}) {
    this.activeLimit = options.activeLimit ?? 20;
    this.totalLimit = options.totalLimit ?? 100;
    this.terminalRetentionMs = options.terminalRetentionMs ?? 30 * 60_000;
    if (!Number.isSafeInteger(this.activeLimit) || this.activeLimit < 1
      || !Number.isSafeInteger(this.totalLimit) || this.totalLimit < this.activeLimit
      || !Number.isSafeInteger(this.terminalRetentionMs) || this.terminalRetentionMs < 1) {
      throw new Error("Remote transfer mapping limits are invalid.");
    }
  }

  reserveStart(nodeId: string, now = Date.now()): string {
    this.sweep(now);
    const active = [...this.mappings.values()].filter((item) => item.nodeId === nodeId && (item.state === "active" || item.state === "detached" || item.state === "unknown")).length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => reservedNodeId === nodeId).length;
    const total = [...this.mappings.values()].filter((item) => item.nodeId === nodeId).length;
    if (active + reserved >= this.activeLimit || total + reserved >= this.totalLimit) {
      throw new Error("Remote transfer mapping capacity is full.");
    }
    const reservation = randomBytes(16).toString("base64url");
    this.reservations.set(reservation, nodeId);
    return reservation;
  }

  releaseStart(reservation: string): void { this.reservations.delete(reservation); }

  bindStarted(reservation: string, input: RemoteTransferStartInput): RemoteTransferMapping {
    if (!this.reservations.delete(reservation)) throw new Error("Remote transfer start reservation is stale.");
    if (!input.publicId || !input.remoteTransferId || [...this.mappings.values()].some((item) => item.publicId === input.publicId)) {
      throw new Error("Remote transfer mapping identity is invalid.");
    }
    const now = input.now ?? Date.now();
    const mapping: RemoteTransferMapping = {
      trackingId: randomBytes(16).toString("base64url"),
      publicId: input.publicId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      executorGeneration: input.executorGeneration,
      connectionId: input.connectionId,
      remoteTransferId: input.remoteTransferId,
      direction: input.direction,
      state: input.terminalBeginResponse?.complete === true ? "complete" : "active",
      version: 1,
      createdAt: now,
      touchedAt: now,
      ...(input.terminalBeginResponse?.complete === true ? { terminalAt: now } : {}),
      publicAvailable: true,
      lastAckOffset: input.lastAckOffset ?? 0,
      ...(input.size === undefined ? {} : { size: input.size }),
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.terminalBeginResponse ? { terminalBeginResponse: { ...input.terminalBeginResponse } } : {}),
      ...(input.terminalBeginResponse?.complete === true && input.direction === "download"
        && typeof input.terminalBeginResponse.data === "string"
        ? { lastDownloadReplay: { offset: 0, response: { data: input.terminalBeginResponse.data, next_offset: input.lastAckOffset ?? 0, complete: true } } }
        : {}),
    };
    this.mappings.set(mapping.trackingId, mapping);
    return copy(mapping);
  }

  bindUnknown(reservation: string, input: RemoteTransferUnknownInput): RemoteTransferMapping {
    if (!this.reservations.delete(reservation)) throw new Error("Remote transfer start reservation is stale.");
    const now = input.now ?? Date.now();
    const mapping: RemoteTransferMapping = {
      trackingId: randomBytes(16).toString("base64url"),
      principalId: input.principalId,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      executorGeneration: input.executorGeneration,
      connectionId: input.connectionId,
      direction: input.direction,
      state: "unknown",
      version: 1,
      createdAt: now,
      touchedAt: now,
      publicAvailable: false,
      lastAckOffset: 0,
    };
    this.mappings.set(mapping.trackingId, mapping);
    return copy(mapping);
  }

  lookupPublic(publicId: string, principalId: string, sessionId: string, nodeId: string): RemoteTransferMapping | undefined {
    const item = [...this.mappings.values()].find((candidate) => candidate.publicId === publicId);
    if (!item || !item.publicAvailable || item.state === "unknown" || item.state === "stale"
      || item.principalId !== principalId || item.sessionId !== sessionId || item.nodeId !== nodeId) return undefined;
    return copy(item);
  }

  listTracking(): RemoteTransferMapping[] { return [...this.mappings.values()].map(copy); }
  lookupTracking(trackingId: string): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    return item ? copy(item) : undefined;
  }
  countActive(nodeId?: string): number {
    const active = [...this.mappings.values()].filter((item) => (item.state === "active" || item.state === "detached" || item.state === "unknown") && (nodeId === undefined || item.nodeId === nodeId)).length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => nodeId === undefined || reservedNodeId === nodeId).length;
    return active + reserved;
  }
  countTotal(nodeId?: string): number {
    const total = [...this.mappings.values()].filter((item) => nodeId === undefined || item.nodeId === nodeId).length;
    const reserved = [...this.reservations.values()].filter((reservedNodeId) => nodeId === undefined || reservedNodeId === nodeId).length;
    return total + reserved;
  }

  expireSession(sessionId: string): void {
    for (const item of this.mappings.values()) if (item.sessionId === sessionId && item.publicAvailable) {
      item.publicAvailable = false;
      item.version += 1;
    }
  }
  hidePublic(trackingId: string): void {
    const item = this.mappings.get(trackingId);
    if (item?.publicAvailable) { item.publicAvailable = false; item.version += 1; }
  }
  markDetached(trackingId: string, expectedVersion: number, now = Date.now()): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || this.isTerminal(item.state) || item.state === "stale") return undefined;
    item.state = "detached";
    item.touchedAt = now;
    item.version += 1;
    return copy(item);
  }
  markStale(trackingId: string, expectedVersion: number, now = Date.now()): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || this.isTerminal(item.state)) return undefined;
    item.state = "stale";
    item.touchedAt = now;
    item.version += 1;
    return copy(item);
  }

  confirmStatus(
    trackingId: string,
    expectedVersion: number,
    binding: RemoteTransferBinding,
    status: { state: "active" | "complete" | "cancelled" | "failed" | "expired"; nextOffset: number },
    now = Date.now(),
  ): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.state === "stale"
      || item.nodeId !== binding.nodeId || item.executorGeneration !== binding.executorGeneration
      || !Number.isSafeInteger(status.nextOffset) || status.nextOffset < 0) return undefined;
    const pendingUpload = item.pendingUpload;
    const pendingDownload = item.pendingDownload;
    let recoveredUpload: RemoteTransferMapping["lastUploadReplay"];
    if (pendingUpload) {
      if (status.nextOffset === pendingUpload.offset + pendingUpload.byteLength) {
        recoveredUpload = { offset: pendingUpload.offset, digest: pendingUpload.digest, nextOffset: status.nextOffset };
      } else if (status.nextOffset !== item.lastAckOffset) return undefined;
    } else if (pendingDownload) {
      if (status.nextOffset < pendingDownload.offset || status.nextOffset < item.lastAckOffset) return undefined;
    } else if (status.nextOffset !== item.lastAckOffset) return undefined;
    if (recoveredUpload) item.lastUploadReplay = recoveredUpload;
    if (pendingUpload) item.pendingUpload = undefined;
    if (pendingDownload && status.nextOffset === pendingDownload.offset) item.pendingDownload = undefined;
    item.connectionId = binding.connectionId;
    // A status offset only proves the executor advanced. The caller still needs
    // the pending download chunk bytes before its public offset can advance.
    if (!pendingDownload) item.lastAckOffset = status.nextOffset;
    item.touchedAt = now;
    item.version += 1;
    item.state = status.state;
    if (this.isTerminal(status.state)) item.terminalAt ??= now;
    else item.terminalAt = undefined;
    return copy(item);
  }

  beginUploadChunk(trackingId: string, expectedVersion: number, offset: number, data: string): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.state !== "active" || item.direction !== "upload") return undefined;
    const digest = createHash("sha256").update(data).digest("hex");
    const replay = item.lastUploadReplay;
    if (replay && replay.offset === offset) {
      if (replay.digest !== digest) throw new Error("Upload chunk replay conflicts with the acknowledged payload.");
      return copy(item);
    }
    if (item.pendingUpload) {
      if (item.pendingUpload.offset !== offset || item.pendingUpload.digest !== digest) throw new Error("A different upload chunk is awaiting status confirmation.");
      return copy(item);
    }
    if (offset !== item.lastAckOffset) throw new Error("Upload chunk offset is stale or out of sequence.");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.toString("base64") !== data) throw new Error("Upload chunk encoding is invalid.");
    item.pendingUpload = { offset, digest, byteLength: bytes.length };
    item.touchedAt = Date.now();
    item.version += 1;
    return copy(item);
  }

  uploadReplay(trackingId: string, offset: number, data: string): { nextOffset: number } | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.direction !== "upload") return undefined;
    const replay = item.lastUploadReplay;
    if (!replay || replay.offset !== offset) return undefined;
    const digest = createHash("sha256").update(data).digest("hex");
    if (replay.digest !== digest) throw new Error("Upload chunk replay conflicts with the acknowledged payload.");
    return { nextOffset: replay.nextOffset };
  }

  acknowledgeUploadChunk(
    trackingId: string,
    expectedVersion: number,
    offset: number,
    digest: string,
    nextOffset: number,
    now = Date.now(),
  ): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    const pending = item?.pendingUpload;
    if (!item || item.version !== expectedVersion || item.state !== "active" || !pending
      || pending.offset !== offset || pending.digest !== digest || nextOffset !== offset + pending.byteLength) return undefined;
    item.lastAckOffset = nextOffset;
    item.lastUploadReplay = { offset, digest, nextOffset };
    item.pendingUpload = undefined;
    item.touchedAt = now;
    item.version += 1;
    return copy(item);
  }

  acknowledgeDownloadChunk(
    trackingId: string,
    expectedVersion: number,
    offset: number,
    response: { data: string; next_offset: number; complete: boolean },
    now = Date.now(),
  ): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.direction !== "download"
      || (item.state !== "active" && !(item.pendingDownload?.offset === offset && this.isTerminal(item.state)))) return undefined;
    if (item.pendingDownload?.offset === offset) {
      if (!Number.isSafeInteger(response.next_offset) || response.next_offset <= offset || response.next_offset < item.lastAckOffset) return undefined;
      item.lastAckOffset = response.next_offset;
      item.lastDownloadReplay = { offset, response: { ...response } };
      item.pendingDownload = undefined;
      item.touchedAt = now;
      if (response.complete) { item.state = "complete"; item.terminalAt ??= now; }
      item.version += 1;
      return copy(item);
    }
    if (offset === item.lastDownloadReplay?.offset) {
      if (JSON.stringify(item.lastDownloadReplay.response) !== JSON.stringify(response)) return undefined;
      return copy(item);
    }
    if (offset !== item.lastAckOffset || !Number.isSafeInteger(response.next_offset) || response.next_offset <= offset) return undefined;
    item.lastAckOffset = response.next_offset;
    item.lastDownloadReplay = { offset, response: { ...response } };
    item.touchedAt = now;
    if (response.complete) { item.state = "complete"; item.terminalAt = now; }
    item.version += 1;
    return copy(item);
  }

  downloadReplay(trackingId: string, offset: number): { data: string; next_offset: number; complete: boolean } | undefined {
    const replay = this.mappings.get(trackingId)?.lastDownloadReplay;
    return replay?.offset === offset ? { ...replay.response } : undefined;
  }

  beginDownloadChunk(trackingId: string, expectedVersion: number, offset: number): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.direction !== "download"
      || (item.state !== "active" && !(item.pendingDownload?.offset === offset && this.isTerminal(item.state)))) return undefined;
    if (item.pendingDownload) {
      if (item.pendingDownload.offset !== offset) throw new Error("A different download chunk is awaiting status confirmation.");
      return copy(item);
    }
    if (offset !== item.lastAckOffset) throw new Error("Download chunk offset is stale or out of sequence.");
    item.pendingDownload = { offset };
    item.touchedAt = Date.now();
    item.version += 1;
    return copy(item);
  }

  recordCommit(trackingId: string, expectedVersion: number, response: Record<string, unknown>, now = Date.now()): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.direction !== "upload" || item.state !== "active") return undefined;
    item.state = "complete";
    item.terminalAt = now;
    item.touchedAt = now;
    item.commitResponse = { ...response };
    item.version += 1;
    return copy(item);
  }

  markTerminal(trackingId: string, expectedVersion: number, state: "cancelled" | "failed" | "expired", now = Date.now()): RemoteTransferMapping | undefined {
    const item = this.mappings.get(trackingId);
    if (!item || item.version !== expectedVersion || item.state === "stale" || this.isTerminal(item.state)) return undefined;
    item.state = state;
    item.terminalAt = now;
    item.touchedAt = now;
    item.pendingUpload = undefined;
    item.pendingDownload = undefined;
    item.version += 1;
    return copy(item);
  }

  sweep(now = Date.now()): number {
    let removed = 0;
    for (const [id, item] of this.mappings) if (this.isTerminal(item.state)
      && item.terminalAt !== undefined && now - item.terminalAt >= this.terminalRetentionMs) {
      this.mappings.delete(id);
      removed += 1;
    }
    return removed;
  }

  private isTerminal(state: RemoteTransferState): boolean {
    return state === "complete" || state === "cancelled" || state === "failed" || state === "expired";
  }
}
