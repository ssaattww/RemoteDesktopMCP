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

const nodeScriptCommand = (file: string) => process.platform === "win32"
  ? `node "${file.replaceAll("\"", "\"\"")}"`
  : `'${process.execPath.replaceAll("'", "'\\''")}' '${file.replaceAll("'", "'\\''")}'`;

async function openSession(api: Awaited<ReturnType<typeof mcp>>) {
  return (await api.call("session_open", {})).session_id as string;
}

async function upload(api: Awaited<ReturnType<typeof mcp>>, session: string, name: string, bytes: Buffer, overwrite = false) {
  const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: sha256(bytes), overwrite });
  return begun.transfer_id as string;
}



test("Issue 13: published tool descriptions match session, file-root, transfer, and process boundaries", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const tools = new Map((await api.listTools()).tools.map((tool) => [tool.name, tool.description ?? ""]));
    const required = ["session_open", "node_list", "file_search", "content_search", "file_read", "file_patch", "file_transfer_download_begin", "file_transfer_download_chunk", "file_transfer_upload_begin", "file_transfer_upload_chunk", "file_transfer_upload_commit", "process_start", "process_output", "process_status", "process_kill"];
    for (const name of required) assert.ok(tools.get(name)?.length, `${name} must have a useful published description`);
    assert.match(api.getInstructions() ?? "", /authenticated caller/i);
    assert.match(tools.get("session_open")!, /session_id/i);
    for (const name of ["file_search", "content_search"]) assert.match(tools.get(name)!, /root_id/i);
    for (const name of ["file_read", "file_patch", "file_transfer_download_begin", "file_transfer_upload_begin"]) {
      assert.match(tools.get(name)!, /root_id/i);
      assert.match(tools.get(name)!, /relative_path/i);
    }
    assert.match(tools.get("file_transfer_download_begin")!, /snapshot copy/i);
    assert.match(tools.get("file_transfer_download_begin")!, /inline=true/i);
    assert.match(tools.get("file_transfer_upload_begin")!, /single call/i);
    assert.match(tools.get("file_transfer_upload_commit")!, /SHA-256/i);
    assert.match(tools.get("file_transfer_upload_commit")!, /atomic/i);
    assert.match(tools.get("process_start")!, /OS user's existing permissions/i);
    for (const name of ["process_output", "process_status", "process_kill"]) assert.match(tools.get(name)!, /same session_id/i);

    const session = await openSession(api);
    const outside = path.join(f.base, "outside-root.txt");
    await writeFile(outside, "reachable-through-command");
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "../outside-root.txt" }), /Path/);
    const script = path.join(f.base, "read-outside-root.cjs");
    await writeFile(script, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(outside)}, 'utf8'))`);
    const started = await api.call("process_start", { session_id: session, command: nodeScriptCommand(script), timeout_ms: 10_000 });
    assert.match(String(started.output), /reachable-through-command/, "process_start keeps the server OS user's file access outside configured file roots");
  } finally { await api.close(); await f.cleanup(); }
});





test("Issue 20: root-scoped file operations expose their canonical path when the session CWD differs", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const workingDirectory = path.join(f.base, "session-cwd");
    const sourceDirectory = path.join(f.root, "actual-source");
    const uploadDirectory = path.join(f.root, "actual-upload");
    const rootFile = path.join(f.root, "root-only.txt");
    const downloadFile = path.join(sourceDirectory, "download-only.txt");
    const uploadedName = "linked-upload/uploaded-from-root-base.bin";
    const uploadedPath = path.join(uploadDirectory, "uploaded-from-root-base.bin");
    await mkdir(workingDirectory);
    await Promise.all([mkdir(sourceDirectory), mkdir(uploadDirectory)]);
    await Promise.all([
      writeFile(rootFile, "root content before patch"),
      writeFile(downloadFile, "download content through an in-root symlink"),
      writeFile(path.join(workingDirectory, "cwd-only.txt"), "session CWD content"),
      writeFile(path.join(workingDirectory, "report-cwd.cjs"), "process.stdout.write(process.cwd())"),
    ]);
    const opened = await api.call("session_open", { working_directory: workingDirectory, purpose: "Verify root-relative file paths" });
    const session = opened.session_id as string;

    const listed = await api.call("node_list", { session_id: session });
    const node = (listed.nodes as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(node.root_ids, ["files"], "the compatible root-ID list remains available");
    assert.deepEqual(node.roots, [{ root_id: "files", absolute_path: f.root }]);
    assert.equal(node.path_base, "root");

    const startedProcess = await api.call("process_start", { session_id: session, command: nodeScriptCommand(path.join(workingDirectory, "report-cwd.cjs")), timeout_ms: 10_000 });
    assert.match(String(startedProcess.output), new RegExp(workingDirectory.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")), "process_start uses the session working directory");

    const names = await api.call("file_search", { session_id: session, root_id: "files", query: "root-only" });
    assert.match(String(names.output), /root-only\.txt/, "file search uses root_id rather than the session working directory");
    const contents = await api.call("content_search", { session_id: session, root_id: "files", query: "before patch" });
    assert.match(String(contents.output), /root-only\.txt/, "content search uses root_id rather than the session working directory");
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "root-only.txt" })).output), /root content before patch/);
    await api.call("file_patch", { session_id: session, root_id: "files", relative_path: "root-only.txt", old_string: "before patch", new_string: "after patch" });
    assert.equal(await readFile(rootFile, "utf8"), "root content after patch");
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "../session-cwd/cwd-only.txt" }), /Path is outside/, "root escape protection remains in force");
    await Promise.all([
      symlink(sourceDirectory, path.join(f.root, "linked-source"), process.platform === "win32" ? "junction" : "dir"),
      symlink(uploadDirectory, path.join(f.root, "linked-upload"), process.platform === "win32" ? "junction" : "dir"),
    ]);

    const download = await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: "linked-source/download-only.txt" });
    assert.equal(download.resolved_path, downloadFile); assert.equal(download.root_id, "files"); assert.equal(download.path_base, "root");
    const downloaded = await api.call("file_transfer_download_chunk", { session_id: session, transfer_id: download.transfer_id, offset: 0 });
    assert.equal(Buffer.from(downloaded.data as string, "base64").toString("utf8"), "download content through an in-root symlink");

    const bytes = Buffer.from("upload bytes in configured root");
    const upload = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: uploadedName, size: bytes.length, sha256: sha256(bytes), overwrite: false });
    assert.equal(upload.resolved_path, uploadedPath); assert.equal(upload.root_id, "files"); assert.equal(upload.path_base, "root");
    await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: upload.transfer_id, offset: 0, data: bytes.toString("base64") });
    const committed = await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: upload.transfer_id });
    assert.equal(committed.resolved_path, uploadedPath); assert.equal(committed.root_id, "files"); assert.equal(committed.path_base, "root");
    assert.deepEqual(await readFile(uploadedPath), bytes);
    await assert.rejects(readFile(path.join(workingDirectory, uploadedName)), "upload does not silently write relative to the session working directory");
  } finally { await api.close(); await f.cleanup(); }
});





test("Issue 9: sessions require a working directory and purpose, and commands start there", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    await assert.rejects(api.callRaw("session_open", {}));
    await assert.rejects(api.callRaw("session_open", { purpose: "missing directory" }));
    await assert.rejects(api.call("session_open", { working_directory: "relative/path", purpose: "relative path" }), /absolute directory/i);
    await assert.rejects(api.call("session_open", { working_directory: path.join(f.base, "missing-directory"), purpose: "missing directory" }), /absolute directory/i);

    const workingDirectory = path.join(f.base, "working-directory");
    await mkdir(workingDirectory);
    const marker = path.join(f.root, "outside-working-directory.txt");
    await writeFile(marker, "available outside the working directory");
    const script = path.join(f.base, "show-working-directory.cjs");
    await writeFile(script, `process.stdout.write(process.cwd() + "|" + require("node:fs").readFileSync(${JSON.stringify(marker)}, "utf8"))`);

    const opened = await api.call("session_open", { working_directory: workingDirectory, purpose: "Inspect a project" });
    const session = String(opened.session_id);
    assert.equal(opened.working_directory, workingDirectory);
    assert.equal(opened.purpose, "Inspect a project");
    const listed = await api.call("session_list", {}) as { sessions: Array<Record<string, unknown>> };
    const row = listed.sessions.find((entry) => entry.session_id === session);
    assert.equal(row?.working_directory, workingDirectory);
    assert.equal(row?.purpose, "Inspect a project");

    const started = await api.call("process_start", { session_id: session, command: nodeScriptCommand(script), timeout_ms: 10_000 });
    assert.ok(String(started.output).includes(workingDirectory));
    assert.match(String(started.output), /available outside the working directory/);
  } finally { await api.close(); await f.cleanup(); }
});
