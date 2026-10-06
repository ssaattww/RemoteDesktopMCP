import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { absent, fixture, mcp } from "./fixture.js";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const openSession = async (api: Awaited<ReturnType<typeof mcp>>) => (await api.call("session_open", {})).session_id as string;


test("RDMCP-MVP-IFR-003: uploads and downloads share one active-transfer cap", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    const source = Buffer.from("download source");
    await Promise.all(Array.from({ length: 10 }, (_, index) => writeFile(path.join(f.root, `cap-source-${index}.txt`), source)));
    for (let index = 0; index < 10; index++) {
      await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: `cap-upload-${index}.bin`, size: 1, sha256: digest(Buffer.from("x")), overwrite: false });
      await api.call("file_transfer_download_begin", { session_id: session, root_id: "files", relative_path: `cap-source-${index}.txt` });
    }
    assert.equal([...f.service.transfers.values()].filter((item) => item.state === "active").length, 20);
    const beforeRoot = (await readdir(f.root)).sort();
    const beforeManifest = await readFile(manifest, "utf8");
    await assert.rejects(api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: "cap-overflow.bin", size: 1, sha256: digest(Buffer.from("y")), overwrite: false }));
    assert.equal([...f.service.transfers.values()].filter((item) => item.state === "active").length, 20, "overflow must not create transfer state");
    assert.deepEqual((await readdir(f.root)).sort(), beforeRoot, "overflow must not leave a temporary upload file");
    assert.equal(await readFile(manifest, "utf8"), beforeManifest, "overflow must not create an owned-upload manifest record");
    await absent(path.join(f.root, "cap-overflow.bin"));
  } finally { await api.close(); await f.cleanup(); }
})

test("RDMCP-MVP-IFR-006: successful multi-chunk uploads commit exact bytes and clean ownership", async () => {
  const f = await fixture(); const api = await mcp(f.service);
  try {
    const session = await openSession(api);
    const manifest = path.join(f.data, "transfers", "owned-uploads.json");
    const commit = async (name: string, bytes: Buffer, overwrite: boolean) => {
      const begun = await api.call("file_transfer_upload_begin", { session_id: session, root_id: "files", relative_path: name, size: bytes.length, sha256: digest(bytes), overwrite });
      const id = begun.transfer_id as string;
      const item = f.service.transfers.get(id)!;
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 1024, bytes.length));
        await api.call("file_transfer_upload_chunk", { session_id: session, transfer_id: id, offset, data: chunk.toString("base64") });
      }
      const completed = await api.call("file_transfer_upload_commit", { session_id: session, transfer_id: id });
      assert.equal(completed.sha256, digest(bytes)); assert.equal(completed.size, bytes.length);
      assert.equal((await api.call("file_transfer_status", { session_id: session, transfer_id: id })).state, "complete");
      assert.equal(f.service.transfers.get(id)?.state, "complete");
      await absent(item.temp!);
      assert.equal((await readFile(manifest, "utf8")).includes(item.temp!), false, "completed upload removes its owned manifest record");
      assert.deepEqual(await readFile(path.join(f.root, name)), bytes);
    };
    const newBytes = Buffer.concat([Buffer.alloc(1024, 0x41), Buffer.alloc(1024, 0x42), Buffer.alloc(517, 0x43)]);
    await commit("multi-new.bin", newBytes, false);
    const replacement = Buffer.concat([Buffer.alloc(1024, 0x5a), Buffer.alloc(377, 0x51)]);
    await writeFile(path.join(f.root, "multi-existing.bin"), "old destination");
    await commit("multi-existing.bin", replacement, true);
  } finally { await api.close(); await f.cleanup(); }
})
