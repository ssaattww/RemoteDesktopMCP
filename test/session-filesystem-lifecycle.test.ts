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

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

const old = () => Date.now() - 31 * 60_000;

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}

async function upload(api: Awaited<ReturnType<typeof mcp>>, session: string, name: string, bytes: Buffer, overwrite = false) {
  const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: sha256(bytes), overwrite });
  return begun.transfer_id as string;
}



test("NR009: canonical allowed roots work through a symlink or Windows junction", async (t) => {
  const f = await fixture(); let service: RemoteDesktopService | undefined; let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    await f.service.close();
    const aliasedRoot = path.join(f.base, "allowed-root-link");
    try { await symlink(f.root, aliasedRoot, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") { t.skip(`directory link capability unavailable: ${code}`); return; }
      throw error;
    }
    await writeFile(path.join(f.root, "ordinary.txt"), "ordinary allowed-root content");
    service = new RemoteDesktopService({ ...f.service.cfg, roots: [{ id: "files", path: aliasedRoot }] });
    await service.initialize(); api = await mcp(service);
    const session = await openSession(api);
    const read = await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary.txt" });
    assert.match(String(read.output), /ordinary allowed-root content/);
    const search = await api.call("file_search", { session_id: session, root_id: "files", query: "ordinary" });
    assert.match(String(search.output), /ordinary\.txt/);
  } finally { await api?.close(); await service?.close(); await f.cleanup(); }
});





test("NR002 and NR006: expiry sweeps cancel transfers, clean files, and list session state", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const listed = await api.call("session_list", {});
    const row = (listed.sessions as Array<Record<string, unknown>>).find((value) => value.session_id === session);
    assert.equal(row?.state, "active"); assert.equal(typeof row?.expires_at, "string");
    const id = await upload(api, session, "expired.bin", Buffer.from("x"));
    const item = f.service.transfers.get(id)!; item.touched = old();
    await f.service.sweepExpired();
    assert.equal(f.service.transfers.get(id)?.state, "expired"); await absent(item.temp!);
    assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: id })).state, "expired");
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: "eA==" }));

    const cancellable = await upload(api, session, "cancel.bin", Buffer.from("x"));
    const cancellableItem = f.service.transfers.get(cancellable)!;
    await api.call("file_transfer_cancel", { session_id: session, transfer_id: cancellable });
    await absent(cancellableItem.temp!);

    const session2 = await openSession(api); const id2 = await upload(api, session2, "session-expired.bin", Buffer.from("x"));
    const item2 = f.service.transfers.get(id2)!;
    const expiredSession = f.service.sessions.get(session2)!;
    expiredSession.touched = Date.now() - 25 * 60 * 60_000;
    expiredSession.expires = Date.now() - 1;
    await f.service.sweepExpired();
    assert.equal(f.service.sessions.get(session2)?.state, "expired"); assert.equal(f.service.transfers.get(id2)?.state, "expired"); await absent(item2.temp!);
    await assert.rejects(api.call("node_list", { session_id: session2 }));
    assert.equal((await api.call("session_list", {}) as { sessions: Array<{ session_id: string }> }).sessions.some((entry) => entry.session_id === session2), false, "expired sessions must not be listed");

    const closed = await openSession(api);
    await api.call("session_close", { session_id: closed });
    assert.equal((await api.call("session_list", {}) as { sessions: Array<{ session_id: string }> }).sessions.some((entry) => entry.session_id === closed), false, "closed sessions must not be listed");
  } finally { await api.close(); await f.cleanup(); }
});





test("NR008: startup preserves unowned lookalikes and removes only manifest-owned orphan artifacts", async () => {
  const f = await fixture();
  let restarted: RemoteDesktopService | undefined;
  try {
    await f.service.close();
    const snapshot = path.join(f.data, "transfers", "orphan.snapshot");
    const legitimate = path.join(f.root, ".__rdmcp_legitimate.upload");
    const owned = path.join(f.root, ".__rdmcp_owned.upload");
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    await mkdir(path.dirname(snapshot), { recursive: true });
    await Promise.all([writeFile(snapshot, "orphan"), writeFile(legitimate, "keep me"), writeFile(owned, "remove me")]);
    const identity = await stat(owned, { bigint: true });
    await writeFile(manifest, JSON.stringify([{ rootId: "files", path: owned, dev: identity.dev.toString(), ino: identity.ino.toString() }]));
    restarted = new RemoteDesktopService(f.service.cfg); await restarted.initialize();
    await Promise.all([absent(snapshot), absent(owned)]);
    assert.equal(await readFile(legitimate, "utf8"), "keep me");
  } finally { await restarted?.close(); await f.cleanup(); }
});
