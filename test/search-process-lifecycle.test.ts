import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { configFromEnv, createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { absent, captureProtectedConfigPin, fixture, mcp } from "./fixture.js";

const configFile = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");

const nodeScriptCommand = (file: string) => process.platform === "win32"
  ? `node "${file.replaceAll("\"", "\"\"")}"`
  : `'${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}'`;

const hasAuditEvent = (text: string, event: string, processId: string) => text.split("\n").some((line) => {
  try { const entry = JSON.parse(line) as { event?: unknown; processId?: unknown }; return entry.event === event && entry.processId === processId; } catch { return false; }
});

const safeAuditDetail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const redacted = value.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"']+)+/g, "[path]").replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
  return redacted.replace(/[^\w .,:()[\]-]/g, "?").slice(0, 240);
};

async function safeIdentityTrace(candidate: string): Promise<string> {
  try {
    const [numeric, exact] = await Promise.all([stat(candidate), stat(candidate, { bigint: true })]);
    return `number=${numeric.dev}:${numeric.ino};bigint=${exact.dev}:${exact.ino}`;
  } catch { return "unavailable"; }
}

async function safeDcDiagnostics(data: string, service?: RemoteDesktopService, candidate?: string): Promise<string> {
  const identity = await safeIdentityTrace(configFile(data));
  const candidateIdentity = candidate ? await safeIdentityTrace(candidate) : undefined;
  const identities = (service as unknown as { protectedConfigIdentities?: Map<unknown, unknown> } | undefined)?.protectedConfigIdentities;
  const identityKeys = identities instanceof Map ? [...identities.keys()].filter((key): key is string => typeof key === "string" && /^\d+:\d+$/.test(key)).sort() : [];
  const pinDirectory = path.join(data, "transfers", "protected-config-pins");
  const pinIdentities = await readdir(pinDirectory).then(async (names) => Promise.all(names.map(async (name) => safeIdentityTrace(path.join(pinDirectory, name))))).catch(() => [] as string[]);
  const manifestIdentities = await readFile(path.join(data, "transfers", "protected-config-identities.json"), "utf8").then((text) => {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as { dev?: unknown; ino?: unknown };
      const exact = typeof record.dev === "string" && /^\d+$/.test(record.dev) && typeof record.ino === "string" && /^\d+$/.test(record.ino);
      return exact || (Number.isSafeInteger(record.dev) && Number.isSafeInteger(record.ino)) ? [`${record.dev}:${record.ino}`] : [];
    }) : [];
  }).catch(() => [] as string[]);
  const events = await readFile(path.join(data, "audit.jsonl"), "utf8").then((text) => text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line) as { event?: unknown; tool?: unknown; reason?: unknown; category?: unknown; detail?: unknown };
      if (typeof value.event !== "string" || !/^[a-z._-]+$/.test(value.event)) return [];
      const fields = [value.tool, value.reason, value.category].filter((field): field is string => typeof field === "string" && /^[a-z._-]+$/.test(field));
      const detail = value.event === "desktop_commander.rejected" ? safeAuditDetail(value.detail) : undefined;
      return [`${value.event}${fields.length ? `:${fields.join(":")}` : ""}${detail ? `:detail=${detail}` : ""}`];
    } catch { return []; }
  }).slice(-8)).catch(() => [] as string[]);
  return `config_identity=${identity};${candidateIdentity === undefined ? "" : ` candidate_identity=${candidateIdentity};`} protected_identity_count=${identityKeys.length}; protected_identity_keys=${identityKeys.join(",") || "none"}; pin_identities=${pinIdentities.join("|") || "none"}; manifest_identity_keys=${manifestIdentities.join(",") || "none"}; recent_audit_events=${events.join(",") || "none"}`;
}

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}



test("NR003 and NR004: searches return every page and portable Node processes retain output/audit", async (t) => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await Promise.all(Array.from({ length: 115 }, (_, index) => writeFile(path.join(f.root, `needle-${index}.txt`), `literal [term] ${index}`)));
    let files: Record<string, unknown>;
    try { files = await api.call("file_search", { session_id: session, root_id: "files", query: "needle-" }); }
    catch { throw new Error(`file_search returned an MCP error; ${await safeDcDiagnostics(f.data, f.service)}`); }
    const fileHits = new Set([...String(files.output).matchAll(/needle-(\d+)\.txt/g)].map((match) => Number(match[1])));
    assert.deepEqual([...fileHits].sort((left, right) => left - right), Array.from({ length: 115 }, (_, index) => index));
    const content = await api.call("content_search", { session_id: session, root_id: "files", query: "[term]" });
    assert.match(String(content.output), /Pattern: "\[term\]"/);
    const contentHits = new Set([...String(content.output).matchAll(/needle-(\d+)\.txt/g)].map((match) => Number(match[1])));
    assert.deepEqual([...contentHits].sort((left, right) => left - right), Array.from({ length: 115 }, (_, index) => index));

    const linesScript = path.join(f.root, "emit-lines.cjs");
    const naturalScript = path.join(f.root, "natural-exit.cjs");
    const longScript = path.join(f.root, "long-running.cjs");
    await Promise.all([
      writeFile(linesScript, "for (let index = 0; index < 1005; index += 1) console.log(`line-${index}`);"),
      writeFile(naturalScript, "setTimeout(() => process.exit(7), 150);"),
      // Leave enough time for heavily loaded Windows CI to report a live
      // process after the initial 200 ms start response and root preflight.
      writeFile(longScript, "console.log('ready'); setTimeout(() => process.exit(0), 15_000);"),
    ]);
    const natural = await api.call("process_start", { session_id: session, command: nodeScriptCommand(naturalScript), timeout_ms: 10_000 });
    const naturalId = natural.process_id as string;
    let autonomousAudit = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      autonomousAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      if (hasAuditEvent(autonomousAudit, "process.exit", naturalId)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(hasAuditEvent(autonomousAudit, "process.exit", naturalId), "natural exit must be audited without process status/output polling");

    const started = await api.call("process_start", { session_id: session, command: nodeScriptCommand(linesScript), timeout_ms: 10_000 });
    const processId = started.process_id as string;
    let observed = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      const output = await api.call("process_output", { session_id: session, process_id: processId }); observed = String(output.output);
      if (output.state === "finished") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(observed, /line-1004/, "the final output page must be returned");
    const longRunning = await api.call("process_start", { session_id: session, command: nodeScriptCommand(longScript), timeout_ms: 200 });
    const killedId = longRunning.process_id as string;
    assert.equal((await api.call("process_status", { session_id: session, process_id: killedId })).state, "running", "the portable process must be alive before termination is requested");
    const killStarted = process.env.CI ? undefined : Date.now();
    const killed = await api.call("process_kill", { session_id: session, process_id: killedId });
    await t.test("local only: kill request returns promptly", { skip: Boolean(process.env.CI) }, () => {
      assert.ok(Date.now() - killStarted! < 10_000, "kill must be bounded when Desktop Commander cannot confirm a process tree stop");
    });
    assert.ok(killed.state === "terminating" || killed.state === "finished");
    let terminationAudit = "";
    if (killed.state === "finished") {
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.exit"[^\\n]*"processId":"${killedId}"`));
    } else if (killed.termination_unconfirmed === true) {
      await new Promise((resolve) => setTimeout(resolve, 15_200));
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.termination_unconfirmed"[^\\n]*"processId":"${killedId}"`));
    } else {
      for (let attempt = 0; attempt < 140; attempt++) {
        terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
        if (hasAuditEvent(terminationAudit, "process.exit", killedId)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!hasAuditEvent(terminationAudit, "process.exit", killedId)) await api.call("process_status", { session_id: session, process_id: killedId });
      terminationAudit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
      assert.match(terminationAudit, new RegExp(`"event":"process\\.exit"[^\\n]*"processId":"${killedId}"`));
    }
    const audit = await readFile(path.join(f.data, "audit.jsonl"), "utf8");
    assert.match(audit, /"event":"process\.exit"/);
    assert.match(audit, new RegExp(`"processId":"${killedId}"`));
  } finally { await api.close(); await f.cleanup(); }
});





test("Issue 10: process_start inherits the service user profile environment", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const keys = ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME", "HOMEDRIVE", "HOMEPATH"] as const;
    const script = path.join(f.root, "profile-environment.cjs");
    await writeFile(script, `const keys = ${JSON.stringify(keys)}; console.log("PROFILE_ENV=" + JSON.stringify(Object.fromEntries(keys.map((key) => [key, { present: Object.prototype.hasOwnProperty.call(process.env, key), value: process.env[key] ?? null }]))));`);
    const session = await openSession(api);
    const started = await api.call("process_start", { session_id: session, command: nodeScriptCommand(script), timeout_ms: 10_000 });
    const processId = started.process_id as string; let output = String(started.output ?? "");
    for (let attempt = 0; attempt < 40 && !output.includes("PROFILE_ENV="); attempt += 1) {
      const observed = await api.call("process_output", { session_id: session, process_id: processId }); output = `${output}\n${String(observed.output ?? "")}`;
      if (observed.state === "finished" && output.includes("PROFILE_ENV=")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let finalState = "";
    for (let attempt = 0; attempt < 40 && finalState !== "finished"; attempt += 1) {
      const observed = await api.call("process_status", { session_id: session, process_id: processId });
      finalState = String(observed.state ?? "");
      if (finalState !== "finished") await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(finalState, "finished", "process completion must be observed before cleanup");
    const line = output.split(/\r?\n/).find((value) => value.startsWith("PROFILE_ENV=")); assert.ok(line, "profile environment output must be observable");
    const actual = JSON.parse(line.slice("PROFILE_ENV=".length)) as Record<string, { present: boolean; value: string | null }>;
    const expected = Object.fromEntries(keys.map((key) => [key, { present: Object.prototype.hasOwnProperty.call(process.env, key), value: process.env[key] ?? null }]));
    assert.deepEqual(actual, expected);
  } finally { await api.close(); await f.cleanup(); }
});





test("Desktop Commander stderr is drained before repeated get_config calls can block MCP", async () => {
  const f = await fixture(); let service: RemoteDesktopService | undefined;
  try {
    await f.service.close();
    await writeFile(path.join(f.root, "anything.txt"), "anything");
    const stub = path.join(f.base, "stderr-capacity-stub.mjs");
    await writeFile(stub, `
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
const names = ${JSON.stringify(["get_config", "start_search", "get_more_search_results", "stop_search", "read_file", "edit_block", "start_process", "read_process_output", "force_terminate", "list_sessions", "_rdmcp_stop_owner", "_rdmcp_resume_owner"])};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === "initialize") reply(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stderr-stub", version: "1" } });
  else if (request.method === "tools/list") reply(request.id, { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) });
  else if (request.method === "tools/call") {
    if (request.params.name === "get_config") { if (!process.stderr.write("x".repeat(1024 * 1024))) await once(process.stderr, "drain"); const config = JSON.parse(await readFile(${JSON.stringify(configFile(f.data))}, "utf8")); reply(request.id, { content: [{ type: "text", text: JSON.stringify({ allowedDirectories: config.allowedDirectories }) }] }); }
    else reply(request.id, { content: [{ type: "text", text: "stub" }] });
  }
}
`);
    const original = (f.service as unknown as { cfg: RuntimeConfig }).cfg;
    service = new RemoteDesktopService({ ...original, dcCommand: process.execPath, dcArgs: [stub], dcManagedConfig: false, allowedRedirectOrigins: new Set(original.allowedRedirectOrigins) });
    await Promise.race([
      service.initialize(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stderr drain fixture timed out")), 5_000)),
    ]);
    const api = await mcp(service);
    try {
      const session = await openSession(api);
      assert.equal((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "anything.txt" })).output, "stub");
    } finally { await api.close(); }
  } finally { await service?.close(); await f.cleanup(); }
});
