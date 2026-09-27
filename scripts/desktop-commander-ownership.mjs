import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const STOP_TOOL = "_rdmcp_stop_owner", RESUME_TOOL = "_rdmcp_resume_owner";
const ownershipContext = new AsyncLocalStorage(), bridges = new WeakMap(), installedMaps = new WeakSet();
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const privateResult = (v) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const schemaMethod = (s) => s?.shape?.method?.value;
export const isOwnershipContextActive = () => Boolean(ownershipContext.getStore());
export const ownedProcessWorkingDirectory = () => ownershipContext.getStore()?.workingDirectory;

function attachTerminal(state, terminalManager) {
  if (typeof terminalManager?.getSession !== "function" || typeof terminalManager?.forceTerminate !== "function" || !(terminalManager.sessions instanceof Map)) throw new Error("Desktop Commander ownership bridge dependencies are incompatible.");
  if (state.terminalManager || installedMaps.has(terminalManager.sessions)) throw new Error("Desktop Commander ownership bridge was already installed.");
  installedMaps.add(terminalManager.sessions); state.terminalManager = terminalManager;
  const terminateLatePublication = (pid, record, retries = 4) => {
    if (state.owners.get(pid) !== record || !state.blockedOwners.has(record.owner)) return;
    if (terminalManager.getSession(pid) !== record.session || record.child.pid !== pid || record.child.exitCode !== null) { state.owners.delete(pid); return; }
    try { if (terminalManager.forceTerminate(pid)) return; } catch { /* retry below */ }
    if (retries > 0) {
      const retry = globalThis.setTimeout(() => terminateLatePublication(pid, record, retries - 1), 50);
      retry.unref?.();
    }
  };
  const sessions = terminalManager.sessions, originalSet = sessions.set.bind(sessions);
  sessions.set = (pid, session) => {
    const context = ownershipContext.getStore();
    if (context && Number.isInteger(pid) && session?.process?.pid === pid) {
      const child = session.process, record = { owner: context.owner, operation: context.operation, session, child };
      state.owners.set(pid, record);
      const forget = () => { if (state.owners.get(pid) === record) state.owners.delete(pid); };
      // A ChildProcess error can report a failed signal while the process is
      // still alive.  Ownership must remain until an actual exit is observed.
      child.once("exit", forget); child.once("close", forget);
    }
    const result = originalSet(pid, session), record = state.owners.get(pid);
    // Stop can win the race between start_process and PID publication.
    if (record && state.blockedOwners.has(record.owner)) terminateLatePublication(pid, record);
    return result;
  };
}

function prepareOwnershipBridge({ ServerClass, callSchema, listSchema }) {
  if (typeof ServerClass?.prototype?.setRequestHandler !== "function" || !callSchema || !listSchema) throw new Error("Desktop Commander ownership bridge dependencies are incompatible.");
  const proto = ServerClass.prototype, existing = bridges.get(proto); if (existing) return existing;
  const state = { terminalManager: undefined, owners: new Map(), blockedOwners: new Set() }; bridges.set(proto, state);
  const stopOwner = (owner) => {
    if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) throw new Error("Invalid owner.");
    state.blockedOwners.add(owner); const manager = state.terminalManager;
    if (!manager) throw new Error("Desktop Commander ownership bridge is not ready.");
    let matched = 0, terminated = 0, failed = 0;
    const terminatedPids = [], failedPids = [];
    for (const [pid, record] of state.owners) {
      if (record.owner !== owner) continue; matched += 1;
      const child = record.child;
      // child.killed means only that Node sent a signal, not that it exited.
      if (manager.getSession(pid) !== record.session || child.pid !== pid || child.exitCode !== null) { state.owners.delete(pid); continue; }
      try {
        if (manager.forceTerminate(pid)) { terminated += 1; terminatedPids.push(pid); }
        else { failed += 1; failedPids.push(pid); }
      } catch { failed += 1; failedPids.push(pid); }
    }
    return privateResult({ stopped: true, matched, terminated, failed, terminated_pids: terminatedPids, failed_pids: failedPids });
  };
  const original = proto.setRequestHandler;
  proto.setRequestHandler = function (schema, handler) {
    if (schema === listSchema || schemaMethod(schema) === "tools/list") return original.call(this, schema, async (...args) => {
      const result = await handler.apply(this, args);
      if (!isRecord(result) || !Array.isArray(result.tools)) throw new Error("Desktop Commander returned an incompatible tools/list result.");
      const tools = result.tools.filter((tool) => tool?.name !== STOP_TOOL && tool?.name !== RESUME_TOOL);
      tools.push({ name: STOP_TOOL, description: "Private RDMCP owner-scoped emergency stop.", inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] } }, { name: RESUME_TOOL, description: "Private RDMCP owner-scoped resume.", inputSchema: { type: "object", properties: { owner: { type: "string" } }, required: ["owner"] } });
      return { ...result, tools };
    });
    if (schema === callSchema || schemaMethod(schema) === "tools/call") return original.call(this, schema, async (request, extra) => {
      const params = request?.params, args = params?.arguments;
      if (params?.name === STOP_TOOL) return stopOwner(args?.owner);
      if (params?.name === RESUME_TOOL) { if (typeof args?.owner !== "string" || args.owner.length === 0 || args.owner.length > 256) throw new Error("Invalid owner."); state.blockedOwners.delete(args.owner); return privateResult({ resumed: true }); }
      if (params?.name === "start_process") {
        if (!isRecord(args) || typeof args.__rdmcp_owner !== "string" || args.__rdmcp_owner.length === 0 || args.__rdmcp_owner.length > 256 || typeof args.__rdmcp_operation !== "string" || args.__rdmcp_operation.length === 0 || args.__rdmcp_operation.length > 256) throw new Error("Owned Desktop Commander process metadata is required.");
        if (state.blockedOwners.has(args.__rdmcp_owner)) throw new Error("Owner execution is stopped.");
        if (typeof args.__rdmcp_cwd !== "string" || args.__rdmcp_cwd.length === 0 || args.__rdmcp_cwd.length > 4096 || !path.isAbsolute(args.__rdmcp_cwd)) throw new Error("Absolute working directory metadata is required.");
        const cleanArgs = { ...args }; delete cleanArgs.__rdmcp_owner; delete cleanArgs.__rdmcp_operation; delete cleanArgs.__rdmcp_cwd;
        return ownershipContext.run({ owner: args.__rdmcp_owner, operation: args.__rdmcp_operation, workingDirectory: args.__rdmcp_cwd }, () => handler.call(this, { ...request, params: { ...params, arguments: cleanArgs } }, extra));
      }
      if (isRecord(args) && ("__rdmcp_owner" in args || "__rdmcp_operation" in args || "__rdmcp_cwd" in args)) { const cleanArgs = { ...args }; delete cleanArgs.__rdmcp_owner; delete cleanArgs.__rdmcp_operation; delete cleanArgs.__rdmcp_cwd; return handler.call(this, { ...request, params: { ...params, arguments: cleanArgs } }, extra); }
      return handler.call(this, request, extra);
    });
    return original.call(this, schema, handler);
  };
  return state;
}

export function installOwnershipBridge({ ServerClass, callSchema, listSchema, terminalManager }) { attachTerminal(prepareOwnershipBridge({ ServerClass, callSchema, listSchema }), terminalManager); }

// terminal-manager imports capture.js, which imports server.js. Patch Server
// first so those handler registrations cannot race ahead of the bridge.
export async function installDesktopCommanderOwnership(entry) {
  const state = prepareOwnershipBridge({ ServerClass: Server, callSchema: CallToolRequestSchema, listSchema: ListToolsRequestSchema });
  const terminalModule = await import(pathToFileURL(path.join(path.dirname(path.resolve(entry)), "terminal-manager.js")).href);
  attachTerminal(state, terminalModule.terminalManager);
}
