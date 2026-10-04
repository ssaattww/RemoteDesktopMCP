import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { hashPassword } from "../src/hash-password.js";
import { protectPrivateDirectory } from "../src/private-storage.js";

const directory = await mkdtemp(path.join(tmpdir(), "rdmcp-issue70-ui-"));
const dataDir = path.join(directory, "data");
await mkdir(dataDir);
await protectPrivateDirectory(dataDir);
const email = "issue70-ui@example.test";
const password = "issue70-review-fixture";
const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1",
  tokenSecret: "issue70-ui-fixture-secret-key-32-bytes-minimum",
  users: [{ email, passwordHash: await hashPassword(password) }],
  roots: [], dataDir, port: 0, chunkBytes: 1024, nodeId: "issue70-ui", nodeLabel: "Issue 70 UI fixture",
  dcCommand: process.execPath, dcArgs: [], allowedRedirectOrigins: new Set(),
};
const service = new RemoteDesktopService(config);
const sessionId = "issue70-mobile-ui-session";
const now = Date.now();
service.sessions.set(sessionId, {
  id: sessionId, user: email, workingDirectory: process.cwd(), purpose: "Issue 70 mobile UI verification",
  created: now, touched: now, expires: now + 86_400_000, state: "active",
  todo: {
    items: [
      { id: "todo-long-line", text: "複数行の作業項目です。狭い画面で状態・更新・削除が折り返されることを確認します。\n2行目の改行も表示されます。", status: "in_progress", order: 0, createdBy: email, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
      { id: "todo-wrap-check", text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", status: "not_started", order: 1, createdBy: email, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
    ],
    version: 1, lastTodoUpdatedMono: performance.now(), lastUpdatedAt: new Date(now).toISOString(),
    enabled: false, enabledAtMono: performance.now(),
  },
} as never);
await service.audit("session.open", { user: email, sessionId, workingDirectory: process.cwd(), purpose: "Issue 70 mobile UI verification" });
const server = createApp(service).listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not resolve the fixture server address.");
const url = `http://127.0.0.1:${address.port}/user/sessions/${encodeURIComponent(sessionId)}`;
console.log(JSON.stringify({ url, login: { email, password }, sessionId, note: "Loopback-only temporary fixture. Sign in through /user/login; stop with Ctrl-C." }, null, 2));

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await service.close();
  await rm(directory, { recursive: true, force: true });
};
process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });
