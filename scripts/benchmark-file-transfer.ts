import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/index.js";
import { fixture } from "../test/fixture.js";

type Direction = "download" | "upload";
type AuditEntry = {
  event?: unknown;
  tool?: unknown;
  durationMs?: unknown;
};

type Measurement = {
  direction: Direction;
  size_mib: number;
  bytes: number;
  tool_calls: number;
  server_duration_ms: number;
  end_to_end_ms: number;
};

const MIB = 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

const parseSucceededTransferOperations = (text: string): AuditEntry[] =>
  text.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      return entry.event === "operation.succeeded"
        && typeof entry.tool === "string"
        && entry.tool.startsWith("file_transfer_")
        ? [entry]
        : [];
    } catch {
      return [];
    }
  });

async function main(): Promise<void> {
  const f = await fixture();
  f.service.cfg.chunkBytes = CHUNK_BYTES;
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const token = f.service.sign({
    type: "access",
    sub: "owner@example.test",
    aud: "http://127.0.0.1/mcp",
    scope: "mcp",
    iss: "http://127.0.0.1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const client = new Client({ name: "transfer-benchmark", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const results: Measurement[] = [];

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({
      name,
      arguments: { comment: "Transfer performance benchmark", ...args },
    });
    const content = response.content as Array<{ type: string; text?: string }>;
    if (response.isError) {
      const text = content.find((item) => item.type === "text")?.text ?? "";
      throw new Error(`${name} failed: ${text}`);
    }
    return JSON.parse(content.find((item) => item.type === "text")?.text ?? "{}") as Record<string, unknown>;
  };

  const auditSnapshot = async () => readFile(path.join(f.data, "audit.jsonl"), "utf8").catch(() => "");
  const serverDurationAfter = async (beforeLength: number) => {
    const audit = await auditSnapshot();
    const entries = parseSucceededTransferOperations(audit.slice(beforeLength));
    return {
      count: entries.length,
      duration: entries.reduce((sum, entry) => sum + (typeof entry.durationMs === "number" ? entry.durationMs : 0), 0),
    };
  };

  try {
    await client.connect(transport);
    const session = (await call("session_open", {
      working_directory: f.root,
      purpose: "Measure transfer performance",
    })).session_id as string;

    for (const sizeMiB of [1, 5, 25]) {
      const bytes = Buffer.alloc(sizeMiB * MIB, 0x5a);
      const expectedSha256 = sha256(bytes);
      const downloadName = `benchmark-download-${sizeMiB}mib.bin`;
      await writeFile(path.join(f.root, downloadName), bytes);

      let audit = await auditSnapshot();
      let toolCalls = 0;
      const downloadStart = performance.now();
      const begun = await call("file_transfer_download_begin", {
        session_id: session,
        root_id: "files",
        relative_path: downloadName,
        inline: true,
      });
      toolCalls += 1;
      const received: Buffer[] = [];
      if (typeof begun.data === "string") received.push(Buffer.from(begun.data, "base64"));
      let complete = begun.complete === true;
      let offset = typeof begun.next_offset === "number" ? begun.next_offset : 0;
      const transferId = begun.transfer_id as string;
      while (!complete) {
        const chunk = await call("file_transfer_download_chunk", {
          session_id: session,
          transfer_id: transferId,
          offset,
        });
        toolCalls += 1;
        received.push(Buffer.from(chunk.data as string, "base64"));
        offset = chunk.next_offset as number;
        complete = chunk.complete === true;
      }
      const downloadEnd = performance.now();
      const downloaded = Buffer.concat(received);
      assert.equal(downloaded.length, bytes.length);
      assert.equal(sha256(downloaded), expectedSha256);
      const downloadServer = await serverDurationAfter(audit.length);
      assert.equal(downloadServer.count, toolCalls);
      results.push({
        direction: "download",
        size_mib: sizeMiB,
        bytes: bytes.length,
        tool_calls: toolCalls,
        server_duration_ms: downloadServer.duration,
        end_to_end_ms: downloadEnd - downloadStart,
      });

      const uploadName = `benchmark-upload-${sizeMiB}mib.bin`;
      audit = await auditSnapshot();
      toolCalls = 0;
      const uploadStart = performance.now();
      const upload = await call("file_transfer_upload_begin", {
        session_id: session,
        root_id: "files",
        relative_path: uploadName,
        size: bytes.length,
        sha256: expectedSha256,
        overwrite: false,
      });
      toolCalls += 1;
      const uploadTransferId = upload.transfer_id as string;
      for (let uploadOffset = 0; uploadOffset < bytes.length; uploadOffset += CHUNK_BYTES) {
        const chunk = bytes.subarray(uploadOffset, Math.min(uploadOffset + CHUNK_BYTES, bytes.length));
        await call("file_transfer_upload_chunk", {
          session_id: session,
          transfer_id: uploadTransferId,
          offset: uploadOffset,
          data: chunk.toString("base64"),
        });
        toolCalls += 1;
      }
      await call("file_transfer_upload_commit", {
        session_id: session,
        transfer_id: uploadTransferId,
      });
      toolCalls += 1;
      const uploadEnd = performance.now();
      const uploaded = await readFile(path.join(f.root, uploadName));
      assert.equal(uploaded.length, bytes.length);
      assert.equal(sha256(uploaded), expectedSha256);
      const uploadServer = await serverDurationAfter(audit.length);
      assert.equal(uploadServer.count, toolCalls);
      results.push({
        direction: "upload",
        size_mib: sizeMiB,
        bytes: bytes.length,
        tool_calls: toolCalls,
        server_duration_ms: uploadServer.duration,
        end_to_end_ms: uploadEnd - uploadStart,
      });

      await rm(path.join(f.root, downloadName), { force: true });
      await rm(path.join(f.root, uploadName), { force: true });
    }

    console.log(JSON.stringify({
      measurement_segment: "localhost MCP Streamable HTTP from first transfer tool call invocation through receipt of final transfer tool response; fixture setup, source creation, and post-transfer hash verification excluded",
      chunk_bytes: CHUNK_BYTES,
      results,
    }, null, 2));
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
}

await main();
