import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mapCuiResponse, type CuiModel } from "./cui-output.js";

export type CuiLogin = { principal: string; expires: number };
export type CuiSnapshot = { state: unknown; logs: unknown };
type Candidate<L extends CuiLogin> = { login: L; id: string; expires: number; approving?: boolean };
type Hooks<L extends CuiLogin> = {
  read(login: L): Promise<CuiSnapshot>;
  active(login: L): boolean | Promise<boolean>;
  write(text: string): void;
  clear(): void;
  now?: () => number;
  random?: (size: number) => Buffer;
  every?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  jsonl?: boolean;
  onDisplayStop?: () => void;
  onEnd?: () => void;
};

/** Process-local pairing and output lifecycle. No cookie, token, or browser secret crosses this boundary. */
export class TerminalCui<L extends CuiLogin> {
  private loginRecordCheck?: (login: L) => boolean;
  private rawPairingCode?: string;
  private readonly digest: Buffer;
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;
  private candidate?: Candidate<L>;
  private bound?: L;
  private attempts = 0;
  private timer?: unknown;
  private busy = false;
  private generation = 0;
  private model?: CuiModel;
  private ended = false;
  private readonly pairingExpires: number;
  private pairingConsumed = false;
  private displayStopNotified = false;
  private endedNotified = false;

  constructor(private readonly hooks: Hooks<L>) {
    this.now = hooks.now ?? Date.now;
    this.random = hooks.random ?? randomBytes;
    this.rawPairingCode = this.random(16).toString("hex");
    this.digest = createHash("sha256").update(this.rawPairingCode).digest();
    this.pairingExpires = this.now() + 300_000;
  }

  setLoginRecordCheck(check: (login: L) => boolean): void { this.loginRecordCheck = check; }

  takePairingCode(): string { const code = this.rawPairingCode; if (!code) throw new Error("pairing code already consumed"); this.rawPairingCode = undefined; return code; }

  submit(login: L, supplied: string): { ok: false; reason: "invalid" | "expired" | "exhausted" | "busy" } | { ok: true; confirmationId: string } {
    if (this.ended || this.pairingConsumed || this.bound || this.candidate) return { ok: false, reason: "busy" };
    if (this.now() >= login.expires || this.now() >= this.pairingExpires) { this.stopDisplay(); return { ok: false, reason: "expired" }; }
    if (++this.attempts > 5) { this.stopDisplay(); return { ok: false, reason: "exhausted" }; }
    const candidateDigest = createHash("sha256").update(typeof supplied === "string" ? supplied : "").digest();
    if (!timingSafeEqual(this.digest, candidateDigest)) return { ok: false, reason: "invalid" };
    this.pairingConsumed = true;
    const confirmationId = this.random(5).toString("hex").toUpperCase();
    this.candidate = { login, id: confirmationId, expires: Math.min(login.expires, this.now() + 300_000) };
    this.attempts = 0;
    return { ok: true, confirmationId };
  }

  async approve(confirmationId: string): Promise<boolean> {
    const candidate = this.candidate;
    if (this.ended || !candidate || candidate.approving) return false;
    if (candidate.id !== confirmationId) { this.stopDisplay(); return false; }
    candidate.approving = true;
    const generation = this.generation;
    let active: boolean;
    try { active = this.isCurrent(candidate.login) && await this.hooks.active(candidate.login); }
    catch {
      if (this.candidate === candidate && generation === this.generation) this.stopDisplay();
      return false;
    }
    if (this.candidate !== candidate || generation !== this.generation || this.ended) return false;
    if (this.now() >= candidate.expires || !active) { this.stopDisplay(); return false; }
    this.candidate = undefined;
    this.bound = candidate.login;
    this.generation++;
    this.timer = (this.hooks.every ?? setInterval)(() => { void this.poll(); }, 1_000);
    void this.poll();
    return true;
  }

  revoke(login?: L): void {
    if (login && this.bound !== login && this.candidate?.login !== login) return;
    this.stopDisplay();
  }

  stopDisplay(): void {
    this.pairingConsumed = true;
    this.invalidate();
    if (!this.displayStopNotified) {
      this.displayStopNotified = true;
      this.hooks.onDisplayStop?.();
    }
  }

  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.pairingConsumed = true;
    this.invalidate();
    if (!this.endedNotified) { this.endedNotified = true; this.hooks.onEnd?.(); }
  }
  get isBound(): boolean { return Boolean(this.bound) && !this.ended; }

  private invalidate(): void {
    this.generation++;
    this.bound = undefined;
    this.candidate = undefined;
    this.model = undefined;
    if (this.timer !== undefined) { (this.hooks.cancel ?? clearInterval)(this.timer as never); this.timer = undefined; }
    if (!this.hooks.jsonl) this.hooks.clear();
  }

  private async poll(): Promise<void> {
    const login = this.bound;
    if (!login || this.ended || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    try {
      if (!this.isCurrent(login) || !await this.hooks.active(login) || this.now() >= login.expires || this.bound !== login || this.ended || generation !== this.generation) { this.stopDisplay(); return; }
      const snapshot = await this.hooks.read(login);
      if (generation !== this.generation || this.bound !== login || this.ended || !this.isCurrent(login) || !await this.hooks.active(login) || this.now() >= login.expires) { if (this.bound === login) this.stopDisplay(); return; }
      const result = mapCuiResponse(snapshot.state, snapshot.logs);
      const text = JSON.stringify(result.model);
      const rendered = this.hooks.jsonl ? text : `\u001b[2J\u001b[H${JSON.stringify(result.model, null, 2)}${result.truncated ? "\n(partial: collection limit reached)" : ""}`;
      if (Buffer.byteLength(rendered, "utf8") > 256 * 1024) { this.model = undefined; if (this.isCurrent(login) && await this.hooks.active(login) && generation === this.generation && this.bound === login && !this.ended) this.writeMessage("output_limit_exceeded"); return; }
      const stillActive = this.isCurrent(login) && await this.hooks.active(login);
      if (!stillActive || generation !== this.generation || this.bound !== login || this.ended || this.now() >= login.expires) { if (this.bound === login) this.stopDisplay(); return; }
      this.model = result.model;
      this.hooks.write(rendered);
    } catch {
      try { if (generation === this.generation && this.bound === login && !this.ended && this.isCurrent(login) && await this.hooks.active(login) && generation === this.generation && this.bound === login && !this.ended) this.writeMessage("view_unavailable"); }
      catch { if (this.bound === login) this.stopDisplay(); }
    } finally { this.busy = false; }
  }

  private isCurrent(login: L): boolean { return this.loginRecordCheck?.(login) ?? true; }

  private writeMessage(error: string): void {
    const json = JSON.stringify({ error });
    this.hooks.write(this.hooks.jsonl ? json : `\u001b[2J\u001b[H${json}`);
  }
}
