import { nodeOperationContextKey, type NodeOperationEnvelope } from "./node-operation.js";

type ReplayWindow = { highWatermark: number; bitmap: number };
type ReplayEntry = {
  context: string;
  state: "pending" | "terminal";
  promise: Promise<unknown>;
  completedAt?: number;
  expiresAt: number;
  value?: unknown;
  error?: unknown;
};

const REPLAY_WINDOW = 32;
const MAX_IN_FLIGHT = 32;
const MAX_TERMINAL = 100;
const OPERATION_TTL_MS = 30 * 60_000;

function scopeKey(envelope: NodeOperationEnvelope): string {
  const { coordinator_epoch, target_node_id, executor_generation } = envelope.operation_id;
  return JSON.stringify([coordinator_epoch, target_node_id, executor_generation]);
}

function replayKey(envelope: NodeOperationEnvelope): string {
  return `${scopeKey(envelope)}:${envelope.operation_id.sequence}`;
}

export class NodeOperationReplayGuard {
  private readonly windows = new Map<string, ReplayWindow>();
  private readonly entries = new Map<string, ReplayEntry>();
  private coordinatorEpoch?: string;

  activateCoordinatorEpoch(epoch: string): void {
    if (this.coordinatorEpoch === epoch) return;
    this.coordinatorEpoch = epoch;
    this.windows.clear();
    this.entries.clear();
  }

  async execute(
    envelope: NodeOperationEnvelope,
    isCurrentlyAuthorized: () => boolean,
    work: () => Promise<unknown>,
    now = Date.now(),
  ): Promise<unknown> {
    const identity = envelope.operation_id;
    if (!this.coordinatorEpoch || identity.coordinator_epoch !== this.coordinatorEpoch) {
      throw new Error("OPERATION_EPOCH_STALE");
    }
    if (
      !Number.isSafeInteger(identity.sequence)
      || identity.sequence <= 0
      || now - envelope.issued_at > OPERATION_TTL_MS
    ) throw new Error("OPERATION_EXPIRED");
    if (!isCurrentlyAuthorized()) throw new Error("USER_STOP_REQUESTED");

    const key = replayKey(envelope);
    const context = nodeOperationContextKey(envelope.request);
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.context !== context) throw new Error("OPERATION_ID_CONFLICT");
      if (entry.state === "pending") {
        const value = await entry.promise;
        if (!isCurrentlyAuthorized()) throw new Error("USER_STOP_REQUESTED");
        return value;
      }
      if (entry.expiresAt <= now || !this.sequenceIsInWindow(envelope)) {
        this.entries.delete(key);
        throw new Error("OPERATION_EXPIRED");
      }
      if (entry.error !== undefined) throw entry.error;
      if (!isCurrentlyAuthorized()) throw new Error("USER_STOP_REQUESTED");
      return entry.value;
    }

    const pendingCount = [...this.entries.values()].filter((item) => item.state === "pending").length;
    if (pendingCount >= MAX_IN_FLIGHT) throw new Error("OPERATION_CAPACITY");
    this.reserveSequence(envelope);

    const promise = Promise.resolve().then(work);
    entry = { context, state: "pending", promise, expiresAt: now + OPERATION_TTL_MS };
    this.entries.set(key, entry);
    try {
      const value = await promise;
      entry.value = value;
      this.finishEntry(key, entry, now);
      if (!isCurrentlyAuthorized()) throw new Error("USER_STOP_REQUESTED");
      return value;
    } catch (error) {
      entry.error = error;
      this.finishEntry(key, entry, now);
      throw error;
    }
  }

  private finishEntry(key: string, entry: ReplayEntry, now: number): void {
    entry.state = "terminal";
    entry.completedAt = now;
    entry.expiresAt = now + OPERATION_TTL_MS;
    const terminal = [...this.entries.entries()]
      .filter(([, item]) => item.state === "terminal")
      .sort((left, right) => (left[1].completedAt ?? 0) - (right[1].completedAt ?? 0));
    while (terminal.length > MAX_TERMINAL) {
      const [oldestKey] = terminal.shift()!;
      if (oldestKey !== key) this.entries.delete(oldestKey);
    }
  }

  private sequenceIsInWindow(envelope: NodeOperationEnvelope): boolean {
    const scope = scopeKey(envelope);
    const window = this.windows.get(scope);
    if (!window) return false;
    const distance = window.highWatermark - envelope.operation_id.sequence;
    if (distance < 0 || distance >= REPLAY_WINDOW) return false;
    return ((window.bitmap >>> distance) & 1) === 1;
  }

  private reserveSequence(envelope: NodeOperationEnvelope): void {
    const scope = scopeKey(envelope);
    const sequence = envelope.operation_id.sequence;
    const window = this.windows.get(scope) ?? { highWatermark: 0, bitmap: 0 };
    if (sequence > window.highWatermark) {
      const delta = sequence - window.highWatermark;
      if (delta > REPLAY_WINDOW) throw new Error("OPERATION_SEQUENCE_WINDOW");
      window.bitmap = delta >= REPLAY_WINDOW ? 0 : (window.bitmap << delta) >>> 0;
      window.highWatermark = sequence;
      window.bitmap = (window.bitmap | 1) >>> 0;
      this.windows.set(scope, window);
      return;
    }
    const distance = window.highWatermark - sequence;
    if (distance >= REPLAY_WINDOW) throw new Error("OPERATION_EXPIRED");
    if (((window.bitmap >>> distance) & 1) === 1) throw new Error("OPERATION_EXPIRED");
    window.bitmap = (window.bitmap | (1 << distance)) >>> 0;
    this.windows.set(scope, window);
  }

}
