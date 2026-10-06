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

const configFile = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");

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

async function expectRejected(operation: Promise<unknown>, label: string, data: string, service: RemoteDesktopService, candidate?: string): Promise<void> {
  try { await operation; }
  catch { return; }
  throw new Error(`${label} unexpectedly succeeded; ${await safeDcDiagnostics(data, service, candidate)}`);
}

async function replaceConfigWithRetry(source: string, destination: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw last;
}

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}

async function upload(api: Awaited<ReturnType<typeof mcp>>, session: string, name: string, bytes: Buffer, overwrite = false) {
  const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: sha256(bytes), overwrite });
  return begun.transfer_id as string;
}



test("DR001: downloads use one immutable multi-chunk snapshot and clean failed snapshots", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const source = path.join(f.root, "source.bin");
    const original = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.alloc(1024, 0x42), Buffer.alloc(333, 0x43)]);
    await writeFile(source, original);
    const originalStat = await stat(source);
    const session = await openSession(api);
    const begun = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "source.bin" });
    const id = begun.transfer_id as string;
    const replacement = path.join(f.root, "replacement.bin");
    await writeFile(replacement, Buffer.alloc(original.length, 0x5a));
    await utimes(replacement, originalStat.atime, originalStat.mtime);
    await rename(replacement, source);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < original.length; offset += 1024) {
      const chunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: id, offset });
      chunks.push(Buffer.from(chunk.data as string, "base64"));
    }
    assert.deepEqual(Buffer.concat(chunks), original);
    assert.equal(sha256(Buffer.concat(chunks)), begun.sha256);
    assert.equal(f.service.transfers.get(id)?.state, "complete", "completed transfers retain only bounded terminal metadata");

    const failing = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "source.bin" });
    const failedId = failing.transfer_id as string;
    const failed = f.service.transfers.get(failedId)!;
    await unlink(failed.snapshot!);
    await assert.rejects(api.call("file_transfer_download_chunk", { session_id: session, transfer_id: failedId, offset: 0 }));
    await absent(failed.snapshot!);
    assert.equal(f.service.transfers.get(failedId)?.state, "failed", "read failures must become terminal and cannot revive");
  } finally { await api.close(); await f.cleanup(); }
});





test("DR002: no-replace commit preserves a winner and removes the losing temp", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api); const payload = Buffer.from("losing upload");
    const id = await upload(api, session, "race.bin", payload);
    const item = f.service.transfers.get(id)!;
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset: 0, data: payload.toString("base64") });
    await writeFile(path.join(f.root, "race.bin"), "winner");
    await assert.rejects(api.call("file_transfer_upload_commit", { session_id: session, transfer_id: id }));
    assert.equal(await readFile(path.join(f.root, "race.bin"), "utf8"), "winner");
    await absent(item.temp!);
    assert.equal(f.service.transfers.get(id)?.state, "failed");
  } finally { await api.close(); await f.cleanup(); }
});





test("DR002: upload begin fails safely when the destination lacks atomic no-replace support", async () => {
  const f = await fixture({ initializeService: false }); let unsupported: RemoteDesktopService | undefined; let api: Awaited<ReturnType<typeof mcp>> | undefined;
  try {
    const cfg = { ...f.service.cfg, linkNoReplace: async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); } };
    unsupported = new RemoteDesktopService(cfg); await unsupported.initialize(); api = await mcp(unsupported);
    const session = await openSession(api);
    await assert.rejects(upload(api, session, "unsupported.bin", Buffer.from("x")));
    assert.equal(unsupported.transfers.size, 0, "unsupported storage must fail before creating transfer state");
    assert.deepEqual((await readdir(f.root)).filter((name) => name.startsWith(".__rdmcp_")), [], "capability probes must clean their own artifacts");
  } finally { await api?.close(); await unsupported?.close(); await f.cleanup(); }
});





test("DR003: protected config aliases cannot be read, searched, or reached by a swapped upload temp", async () => {
  const f = await fixture(); let service = f.service; let api = await mcp(service);
  try {
    const session = await openSession(api);
    const protectedPath = configFile(f.data);
    const historicalAlias = path.join(f.root, "config-historical-alias.json");
    const replacement = `${protectedPath}.replacement`;
    const pinDirectory = path.join(f.data, "transfers", "protected-config-pins");
    await captureProtectedConfigPin(service, f.data, historicalAlias);
    await expectRejected(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-historical-alias.json" }), "the known protected A inode before replacement", f.data, service, historicalAlias);

    // Stop Desktop Commander before manually replacing config.json.  Its asynchronous
    // usage tracker may otherwise atomically replace the file between our rename and
    // a direct alias link, which would test an unobserved inode rather than history B.
    await api.close(); await service.close();
    await writeFile(replacement, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false }));
    await replaceConfigWithRetry(replacement, protectedPath);

    const currentAlias = path.join(f.root, "config-current-alias.json");
    let capturedReplacement = false;
    service = new RemoteDesktopService({
      ...f.service.cfg,
      linkProtectedConfig: async (existingPath: string, pinPath: string) => {
        await link(existingPath, pinPath);
        if (!capturedReplacement) {
          // The alias comes from the exact inode a verified private pin retained.
          // It remains meaningful even if Commander later rewrites config.json.
          await link(pinPath, currentAlias);
          capturedReplacement = true;
        }
      },
    });
    await service.initialize(); api = await mcp(service);
    assert.equal(capturedReplacement, true, "the replacement alias must be captured from a successful private pin");
    const capturedIdentity = await stat(currentAlias, { bigint: true });
    const pinnedIdentities = await Promise.all((await readdir(pinDirectory)).map(async (name) => stat(path.join(pinDirectory, name), { bigint: true })));
    assert.ok(pinnedIdentities.some((info) => info.dev === capturedIdentity.dev && info.ino === capturedIdentity.ino), "the replacement alias must retain the exact dev:ino recorded by a private pin");
    const replacementSession = await openSession(api);
    await expectRejected(api.call("file_read", { session_id: replacementSession, root_id: "files", relative_path: "config-historical-alias.json" }), "the retained config inode", f.data, service);
    await expectRejected(api.call("file_read", { session_id: replacementSession, root_id: "files", relative_path: "config-current-alias.json" }), "the replacement config inode captured by its private pin", f.data, service, currentAlias);
    await assert.rejects(api.call("content_search", { session_id: replacementSession, root_id: "files", query: "allowedDirectories" }));

    for (let index = 0; index < 128; index++) {
      const churn = path.join(f.root, `inode-churn-${index}.txt`);
      await writeFile(churn, String(index)); await unlink(churn);
    }
    await writeFile(path.join(f.root, "ordinary-after-replacement.txt"), "ordinary file remains readable");

    await api.close(); await service.close();
    service = new RemoteDesktopService(f.service.cfg); await service.initialize(); api = await mcp(service);
    const restartedSession = await openSession(api);
    await expectRejected(api.call("file_read", { session_id: restartedSession, root_id: "files", relative_path: "config-historical-alias.json" }), "the persisted historical config inode", f.data, service);
    await expectRejected(api.call("file_read", { session_id: restartedSession, root_id: "files", relative_path: "config-current-alias.json" }), "the persisted replacement config inode", f.data, service);
    assert.match(String((await api.call("file_read", { session_id: restartedSession, root_id: "files", relative_path: "ordinary-after-replacement.txt" })).output), /ordinary file remains readable/);

    const bytes = Buffer.from("x"); const id = await upload(api, restartedSession, "swap.bin", bytes, true);
    const item = service.transfers.get(id)!;
    const stableTargetAlias = path.join(f.root, "config-swap-target-alias.json");
    await link(protectedPath, stableTargetAlias);
    const stableTargetDigest = sha256(await readFile(stableTargetAlias));
    await unlink(item.temp!); await link(stableTargetAlias, item.temp!);
    await assert.rejects(api.call("file_transfer_upload_chunk", { session_id: restartedSession, transfer_id: id, offset: 0, data: bytes.toString("base64") }));
    assert.equal(sha256(await readFile(stableTargetAlias)), stableTargetDigest, "a path swap must never write the exact protected inode swapped into the temp path");
    assert.equal(service.transfers.get(id)?.state, "failed");

    await assert.rejects(api.call("file_read", { session_id: restartedSession, root_id: "files", relative_path: "../data/audit.jsonl" }));
    await expectRejected(api.call("file_read", { session_id: restartedSession, root_id: "files", relative_path: "config-historical-alias.json" }), "the historical config inode after all operations", f.data, service);
  } finally { await api.close(); await service.close(); await f.cleanup(); }
});





test("DR003: a config replacement during pin linking preserves known history and the final config", async () => {
  const f = await fixture(); let api: Awaited<ReturnType<typeof mcp>> | undefined; let service: RemoteDesktopService | undefined;
  try {
    const protectedPath = configFile(f.data);
    const knownAlias = path.join(f.root, "config-known-before-race.json");
    await captureProtectedConfigPin(f.service, f.data, knownAlias);
    api = await mcp(f.service);
    const knownSession = await openSession(api);
    await expectRejected(api.call("file_read", { session_id: knownSession, root_id: "files", relative_path: "config-known-before-race.json" }), "the known config inode before the pin-link race", f.data, f.service);
    await api.close(); api = undefined; await f.service.close();

    let replacedDuringPin = false;
    const racedAlias = path.join(f.root, "config-raced-during-pin.json");
    const pinnedVersionAlias = path.join(f.root, "config-version-linked-during-pin.json");
    let capturedPinVersion = false;
    const cfg = {
      ...f.service.cfg,
      linkProtectedConfig: async (existingPath: string, pinPath: string) => {
        if (!replacedDuringPin) {
          replacedDuringPin = true;
          await link(existingPath, racedAlias);
          const staged = `${existingPath}.pin-race`;
          await writeFile(staged, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false }));
          await replaceConfigWithRetry(staged, existingPath);
        }
        await link(existingPath, pinPath);
        if (!capturedPinVersion) { await link(pinPath, pinnedVersionAlias); capturedPinVersion = true; }
      },
    };
    service = new RemoteDesktopService(cfg); await service.initialize();
    assert.equal(replacedDuringPin, true, "the deterministic hook must replace config.json between pin stat and link");
    assert.equal(capturedPinVersion, true, "the deterministic hook must retain the identity actually linked to a private pin");
    await writeFile(path.join(f.root, "ordinary-after-pin-race.txt"), "ordinary pin-race file");
    api = await mcp(service);
    const session = await openSession(api);
    await expectRejected(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-known-before-race.json" }), "the known historical config inode after the pin-link race", f.data, service);
    await expectRejected(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-version-linked-during-pin.json" }), "the config inode actually linked during the pin-link race", f.data, service, pinnedVersionAlias);
    try {
      assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-after-pin-race.txt" })).output), /ordinary pin-race file/);
    } catch (error) {
      throw new Error(`ordinary file after pin-link race was rejected: ${error instanceof Error ? error.message : "unknown"}; ${await safeDcDiagnostics(f.data, service, path.join(f.root, "ordinary-after-pin-race.txt"))}`);
    }
  } finally { await api?.close(); await service?.close(); await f.cleanup(); }
});





test("DR003: exact bigint identity keys distinguish adjacent unsafe ids while preserving ordinary reads", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const identityService = f.service as unknown as {
      identityFromStats: (info: { dev: bigint; ino: bigint }) => { dev: string; ino: string };
      identityKey: (identity: { dev: string; ino: string }) => string;
      protectedConfigIdentities: Map<string, unknown>;
    };
    const firstUnsafe = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();
    const secondUnsafe = (BigInt(firstUnsafe) + 1n).toString();
    assert.equal(Number(firstUnsafe), Number(secondUnsafe), "the deterministic pair must collide after lossy Number conversion");
    const firstExact = identityService.identityFromStats({ dev: 1n, ino: BigInt(firstUnsafe) });
    const secondExact = identityService.identityFromStats({ dev: 1n, ino: BigInt(secondUnsafe) });
    assert.notEqual(identityService.identityKey(firstExact), identityService.identityKey(secondExact), "protected identity keys must retain bigint precision");

    const protectedAlias = path.join(f.root, "config-exact-identity-alias.json");
    const ordinary = path.join(f.root, "ordinary-exact-identity.txt");
    const pin = await captureProtectedConfigPin(f.service, f.data, protectedAlias);
    await writeFile(ordinary, "ordinary bigint identity file");
    const [pinInfo, ordinaryInfo] = await Promise.all([stat(pin, { bigint: true }), stat(ordinary, { bigint: true })]);
    const pinIdentity = identityService.identityFromStats(pinInfo);
    const ordinaryIdentity = identityService.identityFromStats(ordinaryInfo);
    assert.notEqual(identityService.identityKey(pinIdentity), identityService.identityKey(ordinaryIdentity), "the real ordinary file must not share the protected pin's exact identity");
    assert.ok(identityService.protectedConfigIdentities.has(identityService.identityKey(pinIdentity)), "the real pin must be stored under its exact identity key");
    const identityManifest = JSON.parse(await readFile(path.join(f.data, "transfers", "protected-config-identities.json"), "utf8")) as Array<{ dev?: unknown; ino?: unknown }>;
    assert.ok(identityManifest.length > 0 && identityManifest.every((entry) => typeof entry.dev === "string" && /^\d+$/.test(entry.dev) && typeof entry.ino === "string" && /^\d+$/.test(entry.ino)), "new protected-config manifests must persist exact decimal bigint identities");

    const session = await openSession(api);
    await expectRejected(api.call("file_read", { session_id: session, root_id: "files", relative_path: "config-exact-identity-alias.json" }), "the exact pinned alias", f.data, f.service, protectedAlias);
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-exact-identity.txt" })).output), /ordinary bigint identity file/);
  } finally { await api.close(); await f.cleanup(); }
});





test("DR003: protected identity manifests accept safe legacy values and fail closed on unsafe numeric values", async () => {
  const f = await fixture(); let rejected: RemoteDesktopService | undefined;
  try {
    const identityService = f.service as unknown as {
      validExactIdentity: (value: unknown) => boolean;
      validLegacyIdentity: (value: unknown) => boolean;
    };
    assert.equal(identityService.validExactIdentity({ dev: "1", ino: "2" }), true);
    assert.equal(identityService.validExactIdentity({ dev: 1, ino: 2 }), false, "numeric values must never be mistaken for exact persisted identities");
    assert.equal(identityService.validLegacyIdentity({ dev: 1, ino: 2 }), true, "safe integer records retain a migration path");
    assert.equal(identityService.validLegacyIdentity({ dev: Number.MAX_SAFE_INTEGER + 1, ino: 2 }), false, "unsafe numeric records are ambiguous and must fail closed");

    const pin = await captureProtectedConfigPin(f.service, f.data);
    await f.service.close();
    const manifest = path.join(f.data, "transfers", "protected-config-identities.json");
    const unsafeManifest = JSON.stringify([{ dev: Number.MAX_SAFE_INTEGER + 1, ino: 2, pin }]);
    await writeFile(manifest, unsafeManifest);
    rejected = new RemoteDesktopService(f.service.cfg);
    await assert.rejects(rejected.initialize(), /Protected config identity history is invalid/);
    assert.equal(await readFile(manifest, "utf8"), unsafeManifest, "an unsafe legacy manifest must remain available for operator diagnosis");
    await stat(pin);
  } finally { await rejected?.close(); await f.cleanup(); }
});
