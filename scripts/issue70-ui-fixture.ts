import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const previewTodoItems = [
  { id: "todo-preview-active", text: "通常の作業項目。状態を進行中にして更新できます。", status: "in_progress", order: 0 },
  { id: "todo-preview-completed", text: "完了済みの項目。完了状態と編集コントロールを確認します。", status: "completed", order: 1 },
  { id: "todo-preview-long", text: "長文折り返し確認用:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n2行目の文章は狭い画面でも横にはみ出さず、複数行として編集できます。", status: "not_started", order: 2 },
];
service.sessions.set(sessionId, {
  id: sessionId, user: email, workingDirectory: "/workspace/preview", purpose: "Issue 70 mobile UI verification",
  created: now, touched: now, expires: now + 86_400_000, state: "active",
  todo: {
    items: previewTodoItems.map((item) => ({ ...item, createdBy: email, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() })),
    version: 1, lastTodoUpdatedMono: performance.now(), lastUpdatedAt: new Date(now).toISOString(),
    enabled: false, enabledAtMono: performance.now(),
  },
} as never);
await service.audit("session.open", { user: email, sessionId, workingDirectory: "/workspace/preview", purpose: "Issue 70 mobile UI verification" });
const server = createApp(service).listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Could not resolve the fixture server address.");
const url = `http://127.0.0.1:${address.port}/user/sessions/${encodeURIComponent(sessionId)}`;
config.baseUrl = new URL(url).origin;

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

const mode = process.argv[2] ?? "--serve";
if (mode === "--write-html") {
  const output = path.resolve(process.argv[3] ?? "artifacts/issue70-todo-preview.html");
  try {
    const origin = new URL(url).origin;
    const login = await fetch(`${origin}/user/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }), redirect: "manual",
    });
    if (login.status !== 303) throw new Error(`Preview fixture login failed with status ${login.status}.`);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const detail = await fetch(url, { headers: { Cookie: cookie } });
    if (!detail.ok) throw new Error(`Product HTML route failed with status ${detail.status}.`);
    let html = await detail.text();
    const csrf = html.match(/data-csrf="([^"]+)"/)?.[1];
    const nonce = html.match(/<script nonce="([^"]+)"/)?.[1];
    if (!csrf || !nonce) throw new Error("Rendered product HTML did not contain its expected Todo CSRF value and script nonce.");
    html = html.replaceAll(csrf, "offline-preview-token").replaceAll(nonce, "offline-preview-nonce");
    const itemsJson = JSON.stringify(previewTodoItems).replace(/</g, "\\u003c");
    const offlineBridge = `<script nonce="offline-preview-nonce">(() => {
const marker = "todo-preview-offline-fixture";
const sessionId = ${JSON.stringify(sessionId)};
const items = ${itemsJson}.map((item) => ({ ...item }));
let version = 1;
let enforcementEnabled = false;
let nextId = 1;
const snapshot = () => ({ session_id: sessionId, version, items: items.map((item) => ({ ...item })), total: items.length, completed: items.filter((item) => item.status === "completed").length, last_updated_at: "2026-10-01T00:00:00.000Z", enforcement_enabled: enforcementEnabled });
const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  if (url.pathname === "/api/console-state") return json({ stopped: false, activeSessions: 1, runningProcesses: 0, updatedAt: "2026-10-01T00:00:00.000Z", sessions: [{ session_id: sessionId, working_directory: "/workspace/preview", purpose: "合成データのオフラインプレビュー", created_at: "2026-10-01T00:00:00.000Z", last_used_at: "2026-10-01T00:00:00.000Z", state: "active", active: true, version: 1 }], running: [] });
  if (url.pathname === "/api/logs") return json({ items: [], newestCursor: "preview-cursor-1", oldestCursor: "preview-cursor-1", hasMoreOlder: false, hasMoreNewer: false });
  if (url.pathname === "/api/sessions/" + encodeURIComponent(sessionId) + "/todo") {
    if (init.method === "PUT") {
      const update = JSON.parse(String(init.body));
      if (update.expected_version !== version) return json({ ...snapshot(), conflict: true }, 409);
      for (const change of update.changes) {
        if (change.op === "add") items.push({ id: "todo-preview-added-" + nextId++, text: change.text, status: "not_started", order: items.length });
        if (change.op === "edit") { const item = items.find((entry) => entry.id === change.id); if (item) item.text = change.text; }
        if (change.op === "status") { const item = items.find((entry) => entry.id === change.id); if (item) item.status = change.status; }
        if (change.op === "delete") items.splice(items.findIndex((entry) => entry.id === change.id), 1);
      }
      version += 1;
      return json(snapshot());
    }
    return json(snapshot());
  }
  throw new Error("Offline preview blocked an unmocked request: " + url.pathname);
};
class OfflinePreviewEventSource {
  static OPEN = 1;
  readyState = 1;
  onopen = null;
  onerror = null;
  constructor() { queueMicrotask(() => this.onopen?.(new Event("open"))); }
  addEventListener() {}
  close() { this.readyState = 2; }
}
window.EventSource = OfflinePreviewEventSource;
const isEnforcementForm = (form) => form.action.endsWith("/todo/enforcement");
const explainBlockedAction = () => {
  const notice = document.querySelector("[data-issue70-preview-notice]");
  if (notice) notice.textContent = "この操作はオフラインプレビューでは利用できません。サーバーへの送信やページ移動は行われません。";
};
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target?.closest?.("a[href]");
  if (link && !link.getAttribute("href").startsWith("#")) { event.preventDefault(); explainBlockedAction(); return; }
  const button = target?.closest?.("button");
  const submitForm = button && button.type !== "button" ? button.form : target?.closest?.("input[type=submit]")?.form;
  if (submitForm && !isEnforcementForm(submitForm)) { event.preventDefault(); explainBlockedAction(); }
}, true);
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  if (!isEnforcementForm(form)) { explainBlockedAction(); return; }
  enforcementEnabled = !enforcementEnabled;
  const state = form.closest("#session-todo")?.querySelector("[data-todo-enforcement-state]");
  const button = form.querySelector("[data-todo-enforcement]");
  if (state) state.textContent = enforcementEnabled ? "有効" : "無効";
  if (button) { button.value = String(!enforcementEnabled); button.textContent = enforcementEnabled ? "強制を無効にする" : "強制を有効にする"; }
}, true);
window.__issue70TodoPreview = { marker, snapshot };
})();</script>`;
    if (!html.includes("<script nonce=\"offline-preview-nonce\">")) throw new Error("Product client script was not found for offline preview injection.");
    html = html.replace("<main>", `<main><aside data-issue70-preview-notice style="border:1px solid #9ab7df;background:#e8f1ff;border-radius:8px;padding:10px;margin:8px 0">開発用オフラインプレビュー · 合成データ · API応答をローカルfixtureで再現します</aside>`)
      .replace('<script nonce="offline-preview-nonce">', offlineBridge + '<script nonce="offline-preview-nonce">');
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, html, "utf8");
    await chmod(output, 0o644);
    console.log(`Wrote offline Issue 70 preview: ${output}`);
  } finally {
    await close();
  }
} else if (mode === "--serve") {
  console.log(JSON.stringify({ url, login: { email, password }, sessionId, note: "Loopback-only temporary fixture for HTTP integration tests; stop with Ctrl-C." }, null, 2));
} else {
  await close();
  throw new Error("Usage: issue70-ui-fixture.ts --write-html [output.html] | --serve");
}
