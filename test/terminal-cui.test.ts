import assert from "node:assert/strict";
import test from "node:test";
import { TerminalCui, type CuiSnapshot } from "../src/terminal-cui.js";

const snapshot: CuiSnapshot = { state: { sessions: [], running: [] }, logs: { items: [] } };
const login = { principal: "user-a", expires: 4_000_000_000_000 };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("pairing requires browser code and a matching local confirmation before reading", async () => {
  let now = 1_000;
  let reads = 0;
  let timer: (() => void) | undefined;
  const output: string[] = [];
  const ctl = new TerminalCui({ read: async () => { reads++; return snapshot; }, active: () => true, write: (s) => output.push(s), clear() {}, now: () => now, random: (n) => Buffer.alloc(n, 7), every: (fn, ms) => { assert.equal(ms, 1_000); timer = fn; return fn; }, cancel() {} });
  const code = ctl.takePairingCode();
  assert.equal(Buffer.from(code, "hex").length, 16);
  assert.throws(() => ctl.takePairingCode());
  const accepted = ctl.submit(login, code);
  assert.equal(accepted.ok, true);
  assert.equal(reads, 0);
  assert.equal(await ctl.approve(accepted.ok ? accepted.confirmationId : ""), true);
  await settle();
  assert.equal(reads, 1);
  assert.equal(output.length, 1);
  assert.ok(timer);
  now += 301_000;
  ctl.stop();
});

test("duplicate approval cannot stop the display bound by the first approval", async () => {
  let releaseFirstCheck!: (allowed: boolean) => void;
  let firstCheck = true;
  let ended = 0;
  const output: string[] = [];
  const ctl = new TerminalCui({
    read: async () => snapshot,
    active: () => {
      if (firstCheck) {
        firstCheck = false;
        return new Promise<boolean>((resolve) => { releaseFirstCheck = resolve; });
      }
      return true;
    },
    write: (s) => output.push(s), clear() {}, every: () => 1, cancel() {},
    onEnd: () => { ended++; },
  });
  const code = ctl.takePairingCode();
  const candidate = ctl.submit(login, code);
  assert.ok(candidate.ok);
  const first = ctl.approve(candidate.confirmationId);
  assert.equal(await ctl.approve(candidate.confirmationId), false, "duplicate request is ignored while approval is in flight");
  releaseFirstCheck(true);
  assert.equal(await first, true);
  await settle();
  assert.equal(ctl.isBound, true);
  assert.equal(await ctl.approve(candidate.confirmationId), false, "consumed confirmation cannot be replayed");
  assert.equal(ctl.isBound, true, "a stale duplicate response cannot end the active display");
  assert.equal(ended, 0);
  assert.equal(output.length, 1);
  ctl.stop();
  assert.equal(ended, 1, "only explicit process stop closes the reader");
});

test("login revocation stops only the view and does not end the CUI server", async () => {
  let ended = 0;
  let displayStopped = 0;
  const output: string[] = [];
  const ctl = new TerminalCui({
    read: async () => snapshot, active: () => true,
    write: (s) => output.push(s), clear() {}, jsonl: true,
    every: () => 1, cancel() {},
    onEnd: () => { ended++; },
    onDisplayStop: () => { displayStopped++; },
  });
  const code = ctl.takePairingCode();
  const candidate = ctl.submit(login, code);
  assert.ok(candidate.ok);
  assert.equal(await ctl.approve(candidate.confirmationId), true);
  await settle();
  assert.equal(output.length, 1);
  ctl.revoke(login);
  assert.equal(ctl.isBound, false);
  assert.equal(ended, 0, "revocation leaves the reader and HTTP/MCP server alive");
  assert.equal(displayStopped, 1);
  assert.deepEqual(ctl.submit(login, code), { ok: false, reason: "busy" }, "used pairing code cannot be reused after logout");
  ctl.stop();
  assert.equal(ended, 1, "explicit q/stop is the only process shutdown path");
});

test("CUI checks that the exact login record remains in the user console registry", async () => {
  let current = true;
  let stopped = 0;
  const ctl = new TerminalCui({ read: async () => snapshot, active: () => true, write() {}, clear() {}, jsonl: true, every: () => 1, cancel() {}, onDisplayStop: () => { stopped++; } });
  ctl.setLoginRecordCheck((record) => record === login && current);
  const candidate = ctl.submit(login, ctl.takePairingCode());
  assert.ok(candidate.ok);
  assert.equal(await ctl.approve(candidate.confirmationId), true);
  current = false;
  await settle();
  assert.equal(ctl.isBound, false);
  assert.equal(stopped, 1);
});

test("pairing challenge expires after five minutes and exhausts after five failures", () => {
  let now = 0;
  const make = () => new TerminalCui({ read: async () => snapshot, active: () => true, write() {}, clear() {}, now: () => now, random: (n) => Buffer.alloc(n, 8) });
  const expired = make();
  now = 300_000;
  const expiredCode = expired.takePairingCode();
  assert.deepEqual(expired.submit(login, expiredCode), { ok: false, reason: "expired" });
  now = 0;
  const limited = make();
  const limitedCode = limited.takePairingCode();
  for (let i = 0; i < 5; i++) assert.deepEqual(limited.submit(login, "wrong"), { ok: false, reason: "invalid" });
  assert.deepEqual(limited.submit(login, "wrong"), { ok: false, reason: "exhausted" });
  assert.deepEqual(limited.submit(login, limitedCode), { ok: false, reason: "busy" });
});

test("single-flight polling suppresses a delayed result after revocation", async () => {
  let release!: (value: CuiSnapshot) => void;
  let reads = 0;
  let timer: (() => void) | undefined;
  let cleared = 0;
  const output: string[] = [];
  const ctl = new TerminalCui({ read: () => { reads++; return new Promise<CuiSnapshot>((resolve) => { release = resolve; }); }, active: () => true, write: (s) => output.push(s), clear: () => { cleared++; }, every: (fn) => { timer = fn; return 1; }, cancel: () => undefined });
  const candidate = ctl.submit(login, ctl.takePairingCode());
  assert.equal(candidate.ok && await ctl.approve(candidate.confirmationId), true);
  timer?.(); timer?.();
  assert.equal(reads, 1);
  ctl.revoke(login);
  release(snapshot);
  await settle();
  assert.equal(output.length, 0);
  assert.equal(cleared, 1);
  assert.equal(ctl.isBound, false);
});

test("logout clears only the interactive display; JSONL history is not erased", async () => {
  const output: string[] = [];
  let cleared = 0;
  const ctl = new TerminalCui({ read: async () => snapshot, active: () => true, write: (s) => output.push(s), clear: () => { cleared++; }, jsonl: true, every: () => 1, cancel() {} });
  const candidate = ctl.submit(login, ctl.takePairingCode());
  assert.equal(candidate.ok && await ctl.approve(candidate.confirmationId), true);
  await settle();
  assert.equal(output.length, 1);
  ctl.revoke(login);
  await settle();
  assert.equal(output.length, 1, "past JSONL output remains in the stream");
  assert.equal(cleared, 0, "JSONL mode does not claim to clear redirected history");
});

test("auth change after a delayed read suppresses output", async () => {
  let release!: (value: CuiSnapshot) => void;
  let authChecks = 0;
  const output: string[] = [];
  const ctl = new TerminalCui({ read: () => new Promise<CuiSnapshot>((resolve) => { release = resolve; }), active: () => ++authChecks < 3, write: (s) => output.push(s), clear() {}, every: () => 1, cancel() {} });
  const candidate = ctl.submit(login, ctl.takePairingCode());
  assert.ok(candidate.ok);
  assert.equal(await ctl.approve(candidate.confirmationId), true);
  release(snapshot);
  await settle();
  assert.equal(output.length, 0);
  assert.equal(ctl.isBound, false);
});

test("terminal rejects a serialized view above 256 KiB", async () => {
  const output: string[] = [];
  const large: CuiSnapshot = { state: { sessions: [{ session_id: "s", purpose: "x".repeat(270_000), working_directory: null, created_at: "2026-10-02T12:00:00.000Z", last_used_at: "2026-10-02T12:00:00.000Z", active: false, state: "closed" }], running: [] }, logs: { items: [] } };
  const ctl = new TerminalCui({ read: async () => large, active: () => true, write: (s) => output.push(s), clear() {}, jsonl: true, every: () => 1, cancel() {} });
  const candidate = ctl.submit(login, ctl.takePairingCode());
  assert.ok(candidate.ok);
  assert.equal(await ctl.approve(candidate.confirmationId), true);
  await settle();
  assert.deepEqual(output, ['{"error":"output_limit_exceeded"}']);
});
