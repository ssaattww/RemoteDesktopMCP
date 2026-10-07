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

const transferAuditEvents = async (dataDir: string, transferId: string) => {
  const text = await readFile(path.join(dataDir, "audit.jsonl"), "utf8");
  return text.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown; transferId?: unknown; direction?: unknown; sessionId?: unknown; size?: unknown; sha256?: unknown };
      return entry.transferId === transferId ? [entry] : [];
    } catch { return []; }
  });
};

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}

async function upload(api: Awaited<ReturnType<typeof mcp>>, session: string, name: string, bytes: Buffer, overwrite = false) {
  const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: sha256(bytes), overwrite });
  return begun.transfer_id as string;
}



test("built-in file tools persist structured operation details for user monitoring", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const file = path.join(f.root, "detail-target.txt");
    await writeFile(file, "before detail content\n");
    const opened = await api.call("session_open", { working_directory: f.root, purpose: "Verify built-in tool details" });
    const session = String(opened.session_id);

    await api.call("file_search", { session_id: session, root_id: "files", query: "detail-target" });
    await api.call("content_search", { session_id: session, root_id: "files", query: "before detail" });
    await api.call("file_read", { session_id: session, root_id: "files", relative_path: "detail-target.txt", offset: 0, length: 20 });
    await api.call("file_patch", { session_id: session, root_id: "files", relative_path: "detail-target.txt", old_string: "before detail", new_string: "after detail" });

    const download = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "detail-target.txt" });
    await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: download.transfer_id, offset: 0 });

    const uploadBytes = Buffer.from("uploaded detail content\n");
    const upload = await api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: "uploaded-detail.txt",
      size: uploadBytes.length,
      sha256: sha256(uploadBytes),
      overwrite: false,
    });
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: uploadBytes.toString("base64") });
    await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id });

    const binaryBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41]);
    await writeFile(path.join(f.root, "binary-detail.bin"), binaryBytes);
    const binaryDownload = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "binary-detail.bin" });
    await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: binaryDownload.transfer_id, offset: 0 });

    const knownSecret = f.service.cfg.tokenSecret;
    await writeFile(path.join(f.root, "secret-detail.txt"), "x".repeat(4200) + knownSecret);
    await api.call("file_read", { session_id: session, root_id: "files", relative_path: "secret-detail.txt", offset: 0, length: 1 });
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "missing", relative_path: "failed-detail.txt", offset: 2, length: 3 }));

    const terminal = f.service.auditEntriesForConsole()
      .filter((event) => ["operation.succeeded", "operation.failed", "operation.rejected"].includes(event.event) && event.sessionId === session);
    const findDetail = (tool: string, status = "succeeded") => {
      const event = terminal.find((candidate) => candidate.tool === tool && candidate.status === status);
      assert.ok(event, `missing terminal audit for ${tool}/${status}`);
      const detail = event.detail as { version?: unknown; summary?: unknown; entries?: Array<{ label?: unknown; value?: unknown; format?: unknown; truncated?: unknown }> } | undefined;
      assert.equal(detail?.version, 1, `missing structured detail for ${tool}`);
      assert.ok(Array.isArray(detail?.entries));
      return detail.entries!;
    };
    const value = (entries: Array<{ label?: unknown; value?: unknown }>, label: string) => String(entries.find((entry) => entry.label === label)?.value ?? "");

    const searchEntries = findDetail("file_search");
    assert.match(value(searchEntries, "検索条件"), /detail-target/);
    assert.match(value(searchEntries, "検索結果"), /detail-target\.txt/);

    const contentEntries = findDetail("content_search");
    assert.match(value(contentEntries, "検索条件"), /before detail/);
    assert.match(value(contentEntries, "検索結果"), /detail-target\.txt/);

    const readEntries = findDetail("file_read");
    assert.match(value(readEntries, "対象"), /files.*detail-target\.txt/);
    assert.match(value(readEntries, "読取範囲"), /offset=0.*length=20/);
    assert.match(value(readEntries, "本文"), /before detail content/);

    const patchEntries = findDetail("file_patch");
    const diff = patchEntries.find((entry) => entry.label === "差分");
    assert.equal(diff?.format, "diff");
    assert.match(String(diff?.value), /-before detail/);
    assert.match(String(diff?.value), /\+after detail/);

    const downloadBeginEntries = findDetail("file_transfer_download_begin");
    assert.match(value(downloadBeginEntries, "方向"), /download/);
    assert.match(value(downloadBeginEntries, "内容見本"), /after detail content/);
    const downloadChunkEntries = findDetail("file_transfer_download_chunk");
    assert.match(value(downloadChunkEntries, "内容見本"), /after detail content/);

    const uploadChunkEntries = findDetail("file_transfer_upload_chunk");
    assert.match(value(uploadChunkEntries, "内容見本"), /uploaded detail content/);
    const uploadCommitEntries = findDetail("file_transfer_upload_commit");
    assert.match(value(uploadCommitEntries, "内容見本"), /uploaded detail content/);

    const downloadChunkEvents = terminal.filter((candidate) => candidate.tool === "file_transfer_download_chunk" && candidate.status === "succeeded");
    const binaryDetail = downloadChunkEvents.at(-1)?.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    assert.match(value(binaryDetail?.entries ?? [], "内容見本"), /00 01 02 ff 41/i, "binary content is represented as a bounded hex preview");

    const secretEvent = terminal.find((candidate) => candidate.tool === "file_read" && candidate.status === "succeeded" && String(candidate.target).includes("secret-detail.txt"));
    const secretDetail = secretEvent?.detail as { entries?: Array<{ label?: unknown; value?: unknown; truncated?: unknown }> } | undefined;
    const secretBody = secretDetail?.entries?.find((entry) => entry.label === "本文");
    assert.ok(secretBody, "the long file read has a body detail");
    assert.equal(String(secretBody.value).includes(knownSecret), false, "known service secrets are never persisted in operation detail");
    assert.match(String(secretBody.value), /\[redacted\]/);
    assert.equal(secretBody.truncated, true);
    assert.ok(String(secretBody.value).length <= 4000, "each variable detail value stays within the audit limit");

    const failureEntries = findDetail("file_read", "failed");
    assert.match(value(failureEntries, "対象"), /missing.*failed-detail\.txt/);
    assert.match(value(failureEntries, "読取範囲"), /offset=2.*length=3/);
    assert.ok(value(failureEntries, "エラー").length > 0);
  } finally { await api.close(); await f.cleanup(); }
});





test("failed upload commit does not expose existing destination content in operation detail", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const existingBody = "EXISTING_DESTINATION_SECRET";
    const targetName = "existing-detail-target.txt";
    await writeFile(path.join(f.root, targetName), existingBody);
    const opened = await api.call("session_open", { working_directory: f.root, purpose: "Verify failed upload commit details" });
    const session = String(opened.session_id);
    const replacement = Buffer.from("replacement upload content ".repeat(4));
    const upload = await api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: targetName,
      size: replacement.length,
      sha256: sha256(replacement),
      overwrite: false,
    });
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: replacement.toString("base64") });
    await assert.rejects(api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id }));

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_transfer_upload_commit"
      && candidate.status === "failed"
      && candidate.sessionId === session);
    assert.ok(event, "missing failed upload commit audit");
    const detail = event.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    const entries = detail?.entries ?? [];
    assert.ok(entries.some((entry) => entry.label === "エラー"), "failed commit keeps its public error detail");
    assert.equal(entries.some((entry) => entry.label === "内容見本"), false, "failed commit must not preview a pre-existing destination");
    assert.equal(JSON.stringify(detail).includes(existingBody), false, "pre-existing destination content must not enter the failed operation detail");
  } finally { await api.close(); await f.cleanup(); }
});

test("failed operation audit records safe exception name and code", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "missing-diagnostic-file.txt" }));

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.sessionId === session);
    assert.ok(event, "missing failed operation audit");
    assert.equal(event.errorName, "Error");
    assert.equal(event.errorCode, "ENOENT");
    assert.equal(JSON.stringify({ errorName: event.errorName, errorCode: event.errorCode }).includes("missing-diagnostic-file"), false, "exception details must not enter new diagnostic fields");

    const busySecret = "private-busy-path-sentinel";
    const service = f.service as unknown as { safePath: (...args: unknown[]) => Promise<string> };
    const safePath = service.safePath;
    service.safePath = async () => { throw Object.assign(new Error(`EBUSY ${busySecret}`), { code: "EBUSY" }); };
    try { await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "busy-diagnostic-file.txt" })); }
    finally { service.safePath = safePath; }
    const busy = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "busy-diagnostic-file.txt");
    assert.ok(busy, "missing audit for EBUSY operation");
    assert.equal(busy.errorCode, "EBUSY");
    assert.equal(JSON.stringify({ errorName: busy.errorName, errorCode: busy.errorCode }).includes(busySecret), false);

    const secret = "untrusted-exception-sentinel";
    service.safePath = async () => {
      const error = Object.assign(new Error(`Private detail ${secret}`), { name: secret, code: secret });
      throw error;
    };
    try { await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "untrusted-diagnostic-file.txt" })); }
    finally { service.safePath = safePath; }
    const untrusted = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "untrusted-diagnostic-file.txt");
    assert.ok(untrusted, "missing audit for injected exception");
    assert.equal(untrusted.errorName, "Error", "use a fixed safe class name instead of a caller-supplied name");
    assert.equal("errorCode" in untrusted, false, "omit codes outside the safe allowlist");
    assert.equal(JSON.stringify(untrusted).includes(secret), false, "arbitrary exception text must not leak through diagnostics");

    service.safePath = async () => { throw Object.assign(new Error("Unrecognized numeric code"), { code: 12_345 }); };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "unknown-numeric-code.txt" }));
    const unknownNumeric = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "unknown-numeric-code.txt");
    assert.ok(unknownNumeric, "missing audit for unrecognized numeric code");
    assert.equal("errorCode" in unknownNumeric, false, "omit numeric codes outside the explicit protocol allowlist");

    service.safePath = async () => { throw Object.assign(new Error("Known protocol code"), { code: -32_001 }); };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-numeric-code.txt" }));
    const knownNumeric = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "known-numeric-code.txt");
    assert.ok(knownNumeric, "missing audit for known numeric code");
    assert.equal(knownNumeric.errorCode, -32_001);

    service.safePath = safePath;

    await assert.rejects(api.callRaw("file_read", { comment: "Verify rejection diagnostics", session_id: session, root_id: "files", relative_path: "invalid-offset.txt", offset: -1, length: 1 }), /Input validation error/);
    const rejected = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "rejected" && candidate.reason === "input_validation");
    assert.ok(rejected, "missing schema-rejection audit");
    assert.equal(rejected.errorName, "InputValidationError");
    assert.equal(rejected.errorCode, "INPUT_VALIDATION");
  } finally { await api.close(); await f.cleanup(); }
});

test("unknown thrown values and code getters cannot leak through audit diagnostics", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  const service = f.service as unknown as { safePath: (...args: unknown[]) => Promise<string> };
  const safePath = service.safePath;
  try {
    const session = await openSession(api);
    const primitiveSecret = "primitive-throw-secret";
    service.safePath = async () => { throw primitiveSecret; };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "thrown-primitive.txt" }));
    const primitive = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "thrown-primitive.txt");
    assert.ok(primitive, "missing audit for an unknown primitive throw value");
    assert.equal(primitive.errorName, "string");
    assert.equal(JSON.stringify(primitive).includes(primitiveSecret), false);

    const getterSecret = "throwing-code-getter-secret";
    let getterCalled = false;
    const getterError = new Error(`Private ${getterSecret}`);
    Object.defineProperty(getterError, "code", { get() { getterCalled = true; throw new Error(getterSecret); } });
    service.safePath = async () => { throw getterError; };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "throwing-code-getter.txt" }));
    const getter = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "throwing-code-getter.txt");
    assert.ok(getter, "missing audit for a throwing code getter");
    assert.equal(getterCalled, false, "diagnostics must inspect descriptors without invoking getters");
    assert.equal("errorCode" in getter, false);
    assert.equal(JSON.stringify(getter).includes(getterSecret), false);
  } finally { service.safePath = safePath; await api.close(); await f.cleanup(); }
});

test("terminal audit survives a throw from a code descriptor proxy", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  const service = f.service as unknown as { safePath: (...args: unknown[]) => Promise<string> };
  const safePath = service.safePath;
  try {
    const session = await openSession(api);
    const secret = "proxy-descriptor-trap-secret";
    const thrown = new Proxy(Object.create(null) as object, {
      getOwnPropertyDescriptor() { throw new Error(secret); },
    });
    service.safePath = async () => { throw thrown; };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "throwing-code-proxy.txt" }));
    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "throwing-code-proxy.txt");
    assert.ok(event, "missing terminal audit when a code descriptor trap throws");
    assert.equal("errorCode" in event, false);
    assert.equal(JSON.stringify(event).includes(secret), false);
  } finally { service.safePath = safePath; await api.close(); await f.cleanup(); }
});

test("terminal audit survives a throw from an error-name prototype proxy", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  const service = f.service as unknown as { safePath: (...args: unknown[]) => Promise<string> };
  const safePath = service.safePath;
  try {
    const session = await openSession(api);
    const secret = "proxy-prototype-trap-secret";
    let checks = 0;
    const thrown = new Proxy(Object.create(null) as object, {
      getPrototypeOf() {
        checks += 1;
        if (checks <= 2) return null;
        throw new Error(secret);
      },
    });
    service.safePath = async () => { throw thrown; };
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "throwing-name-proxy.txt" }));
    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read" && candidate.status === "failed" && candidate.target === "throwing-name-proxy.txt");
    assert.ok(event, "missing terminal audit when an error-name prototype trap throws");
    assert.equal(event.errorName, "UnknownError");
    assert.equal(JSON.stringify(event).includes(secret), false);
  } finally { service.safePath = safePath; await api.close(); await f.cleanup(); }
});





test("schema validation rejections persist safe operation detail", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await assert.rejects(api.callRaw("file_read", {
      comment: "Verify schema rejection detail",
      session_id: session,
      root_id: "files",
      relative_path: "schema-invalid.txt",
      offset: -1,
      length: 3,
    }), /Input validation error/);

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read"
      && candidate.status === "rejected"
      && candidate.sessionId === session);
    assert.ok(event, "schema rejection must create a terminal operation audit");
    assert.equal(event.reason, "input_validation");
    const detail = event.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    const entries = detail?.entries ?? [];
    const value = (label: string) => String(entries.find((entry) => entry.label === label)?.value ?? "");
    assert.match(value("対象"), /files.*schema-invalid\.txt/);
    assert.match(value("読取範囲"), /offset=-1.*length=3/);
    assert.match(value("エラー"), /Input validation error/);
  } finally { await api.close(); await f.cleanup(); }
});





test("schema validation rejection bounds oversized comments before audit persistence", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    await assert.rejects(api.callRaw("file_read", {
      comment: "c".repeat(5_001),
      session_id: session,
      root_id: "files",
      relative_path: "schema-invalid.txt",
      offset: -1,
      length: 3,
    }), /Input validation error/);

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_read"
      && candidate.status === "rejected"
      && candidate.sessionId === session);
    assert.ok(event, "oversized rejected comment must still create a terminal operation audit");
    assert.equal(String(event.comment ?? "").length, 500, "rejected comment must obey the normal schema limit before audit persistence");
  } finally { await api.close(); await f.cleanup(); }
});





test("schema validation rejection bounds variable-length bodies before detail processing", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  const service = f.service as unknown as {
    operationDetail: (tool: string, args: Record<string, unknown>, body?: unknown, error?: string) => Promise<unknown>;
  };
  const original = service.operationDetail.bind(f.service);
  const observed = new Map<string, Record<string, unknown>>();
  service.operationDetail = async (tool, args, body, error) => {
    if (error?.includes("Input validation error:")) observed.set(tool, { ...args });
    return original(tool, args, body, error);
  };
  try {
    const session = await openSession(api);
    await assert.rejects(api.callRaw("file_patch", {
      comment: "Verify bounded patch rejection",
      session_id: session,
      root_id: "files",
      relative_path: "schema-invalid.txt",
      old_string: "x".repeat(10_000),
      new_string: "replacement",
      expected_replacements: 0,
    }), /Input validation error/);
    await assert.rejects(api.callRaw("file_transfer_upload_chunk", {
      comment: "Verify bounded upload chunk rejection",
      session_id: session,
      transfer_id: "t".repeat(16),
      offset: -1,
      data: "A".repeat(10_000),
    }), /Input validation error/);

    assert.equal(String(observed.get("file_patch")?.old_string ?? "").length, 4_000);
    assert.equal(String(observed.get("file_transfer_upload_chunk")?.data ?? "").length, 4_096);
  } finally {
    service.operationDetail = original;
    await api.close(); await f.cleanup();
  }
});





test("successful upload commit detail is pinned to verified upload bytes", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  const originalAudit = f.service.audit.bind(f.service);
  try {
    const targetName = "verified-upload-detail.txt";
    const target = path.join(f.root, targetName);
    const verified = Buffer.from("VERIFIED_UPLOAD_CONTENT");
    const mutated = "MUTATED_AFTER_COMMIT";
    const session = await openSession(api);
    const upload = await api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: targetName,
      size: verified.length,
      sha256: sha256(verified),
      overwrite: false,
    });
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: verified.toString("base64") });

    f.service.audit = async (event, fields) => {
      await originalAudit(event, fields);
      if (event === "transfer.complete") await writeFile(target, mutated);
    };
    await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id });

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_transfer_upload_commit"
      && candidate.status === "succeeded"
      && candidate.sessionId === session);
    assert.ok(event, "missing successful upload commit audit");
    const detail = event.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    const preview = String(detail?.entries?.find((entry) => entry.label === "内容見本")?.value ?? "");
    assert.match(preview, /VERIFIED_UPLOAD_CONTENT/, "detail must use the bytes verified before commit");
    assert.doesNotMatch(preview, /MUTATED_AFTER_COMMIT/, "detail must not re-read the mutable destination path");
  } finally {
    f.service.audit = originalAudit;
    await api.close();
    await f.cleanup();
  }
});





test("file transfer cancel detail includes the transferred position", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const bytes = Buffer.from("abcdef");
    const upload = await api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: "cancel-detail.txt",
      size: bytes.length,
      sha256: sha256(bytes),
      overwrite: false,
    });
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: bytes.subarray(0, 3).toString("base64") });
    await api.call("file_transfer_cancel", { session_id: session, transfer_id: upload.transfer_id });

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_transfer_cancel"
      && candidate.status === "succeeded"
      && candidate.sessionId === session);
    assert.ok(event, "missing transfer cancel audit");
    const detail = event.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    const position = String(detail?.entries?.find((entry) => entry.label === "位置")?.value ?? "");
    assert.equal(position, "3");
  } finally { await api.close(); await f.cleanup(); }
});





test("long UTF-8 transfer previews remain text when the byte limit splits a code point", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const text = "あ".repeat(2000);
    await writeFile(path.join(f.root, "utf8-preview.txt"), text);
    const opened = await api.call("session_open", { working_directory: f.root, purpose: "Verify UTF-8 transfer preview" });
    const session = String(opened.session_id);

    await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "utf8-preview.txt" });

    const event = f.service.auditEntriesForConsole().findLast((candidate) =>
      candidate.tool === "file_transfer_download_begin"
      && candidate.status === "succeeded"
      && String(candidate.target).includes("utf8-preview.txt"));
    assert.ok(event, "missing terminal audit for the UTF-8 download");
    const detail = event.detail as { entries?: Array<{ label?: unknown; value?: unknown }> } | undefined;
    const preview = detail?.entries?.find((entry) => entry.label === "内容見本");
    assert.ok(preview, "missing UTF-8 content preview");
    assert.doesNotMatch(String(preview.value), /^hex:/i, "valid UTF-8 text must not be misclassified as binary");
    assert.match(String(preview.value), /あ/, "the text preview remains readable");
  } finally { await api.close(); await f.cleanup(); }
});






test("Issue 29: small transfers complete in one MCP call while large transfers keep the chunked fallback", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const session = await openSession(api);

    const downloadBytes = Buffer.from("single-call download");
    const downloadPath = path.join(f.root, "single-download.bin");
    await writeFile(downloadPath, downloadBytes);
    const downloaded = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "single-download.bin", inline: true });
    assert.equal(downloaded.complete, true);
    assert.equal(downloaded.next_offset, downloadBytes.length);
    assert.deepEqual(Buffer.from(downloaded.data as string, "base64"), downloadBytes);
    assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: downloaded.transfer_id })).state, "complete");
    const inlineDownloadAudit = await transferAuditEvents(f.data, downloaded.transfer_id as string);
    assert.ok(inlineDownloadAudit.some((entry) => entry.event === "transfer.complete" && entry.direction === "download" && entry.sessionId === session && entry.size === downloadBytes.length && entry.sha256 === sha256(downloadBytes)), "inline download completion must be audited with transfer metadata");

    const uploadBytes = Buffer.from("single-call upload");
    const uploaded = await api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: "single-upload.bin",
      size: uploadBytes.length,
      sha256: sha256(uploadBytes),
      overwrite: false,
      data: uploadBytes.toString("base64"),
    });
    assert.equal(uploaded.complete, true);
    assert.equal(uploaded.size, uploadBytes.length);
    assert.deepEqual(await readFile(path.join(f.root, "single-upload.bin")), uploadBytes);
    assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: uploaded.transfer_id })).state, "complete");

    const largeBytes = Buffer.alloc(1025, 0x5a);
    await writeFile(path.join(f.root, "large-download.bin"), largeBytes);
    const largeDownload = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "large-download.bin", inline: true });
    assert.equal(largeDownload.complete, false);
    assert.equal(largeDownload.data, undefined);
    const firstLargeChunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: largeDownload.transfer_id, offset: 0 });
    assert.equal(firstLargeChunk.complete, false);
    const finalLargeChunk = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: largeDownload.transfer_id, offset: 1024 });
    assert.equal(finalLargeChunk.complete, true);
    const chunkedDownloadAudit = await transferAuditEvents(f.data, largeDownload.transfer_id as string);
    assert.ok(chunkedDownloadAudit.some((entry) => entry.event === "transfer.complete" && entry.direction === "download" && entry.sessionId === session && entry.size === largeBytes.length && entry.sha256 === sha256(largeBytes)), "chunked download completion must be audited with transfer metadata");

    await assert.rejects(api.call("file_transfer_upload_begin", {
      session_id: session,
      root_id: "files",
      relative_path: "large-upload.bin",
      size: largeBytes.length,
      sha256: sha256(largeBytes),
      overwrite: false,
      data: largeBytes.toString("base64"),
    }));
  } finally { await api.close(); await f.cleanup(); }
});
