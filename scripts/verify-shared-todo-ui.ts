import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser, type HTTPRequest, type Page } from "puppeteer";
import { createApp, RemoteDesktopService, type RuntimeConfig } from "../src/index.js";
import { hashPassword } from "../src/hash-password.js";
import { protectPrivateDirectory } from "../src/private-storage.js";

const owner = "owner@example.test";
const password = "subtasks-browser-smoke-only";
const sessionId = "session-subtasks-browser-smoke";
const outputDir = path.join(process.cwd(), "reference/subtasks");
const rowSelector = (itemId: string) => `#session-todo li[data-todo-id="${itemId}"]`;
const errors: string[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
const interceptionErrors: string[] = [];
const checks: Record<string, unknown> = {};
const savedScreenshots: string[] = [];
const screenshots = { mobile: path.join(outputDir, "mobile.png"), desktop: path.join(outputDir, "desktop.png") };
const result: Record<string, unknown> = { started_at: new Date().toISOString(), node: process.version, platform: process.platform, ok: false, checks, screenshots, screenshots_saved: savedScreenshots, page_errors: pageErrors, console_errors: consoleErrors, interception_errors: interceptionErrors, errors };
let temporaryRoot: string | undefined;
let service: RemoteDesktopService | undefined;
let server: Server | undefined;
let browser: Browser | undefined;
let heldRequest: HTTPRequest | undefined;
let closing = false;
let heldTimer: ReturnType<typeof setTimeout> | undefined;

/** 表示が落ち着いた時点の幅と、本文欄が画面内に収まることを確認する。 */
async function checkLayout(page: Page, width: number, screenshotPath: string) {
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const measured = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>("#session-todo [data-todo-text]"))
      .filter((field) => field.getClientRects().length > 0)
      .map((field) => {
        const rect = field.getBoundingClientRect();
        return { id: field.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId, left: rect.left, right: rect.right, width: rect.width, clientWidth: field.clientWidth, scrollWidth: field.scrollWidth, height: rect.height };
      });
    const parentLabels = Array.from(document.querySelectorAll<HTMLElement>("#session-todo [data-todo-parent-label]")).map((label) => ({ height: label.getBoundingClientRect().height, fontSize: Number.parseFloat(getComputedStyle(label).fontSize), textLength: label.textContent?.length ?? 0 }));
    return { viewport, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, deepest: document.querySelector<HTMLElement>('li[data-todo-depth="8"]')?.dataset.todoId, textareas, parentLabels };
  });
  checks[width === 320 ? "mobile" : "desktop"] = measured;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  savedScreenshots.push(screenshotPath);
  assert.equal(measured.viewport, width);
  assert.ok(measured.scrollWidth <= width + 1, `document overflow at ${width}px: ${measured.scrollWidth}`);
  assert.ok(measured.bodyScrollWidth <= width + 1, `body overflow at ${width}px: ${measured.bodyScrollWidth}`);
  assert.equal(measured.deepest, "chain-8");
  assert.equal(measured.textareas.length, 9);
  for (const label of measured.parentLabels) assert.ok(label.height <= label.fontSize * 3.1, `parent label is too tall at ${width}px: ${label.height}`);
  for (const field of measured.textareas) {
    assert.ok(field.left >= -1 && field.right <= width + 1, `textarea outside viewport: ${field.id}`);
    assert.ok(field.width > 0 && field.height > 0, `textarea has no size: ${field.id}`);
    assert.ok(field.scrollWidth <= field.clientWidth + 1, `textarea horizontal overflow: ${field.id}`);
  }
  return measured;
}

/** 構成欄を実際に開き、画面から操作できる状態にする。 */
async function openStructure(page: Page, itemId: string) {
  const selector = `${rowSelector(itemId)} details[data-todo-structure]`;
  const opened = await page.$eval(selector, (element) => (element as HTMLDetailsElement).open);
  if (!opened) await page.click(`${selector}>summary`);
  await page.waitForFunction((selector) => document.querySelector<HTMLDetailsElement>(selector)?.open === true, {}, selector);
}

try {
  await mkdir(outputDir, { recursive: true });
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "rdmcp-subtasks-browser-"));
  const dataDir = path.join(temporaryRoot, "data");
  await mkdir(dataDir);
  await protectPrivateDirectory(dataDir);
  const config: RuntimeConfig = { baseUrl: "http://127.0.0.1", tokenSecret: "s".repeat(32), users: [{ email: owner, passwordHash: await hashPassword(password) }], roots: [], dataDir, port: 0, chunkBytes: 1024, nodeId: "local", nodeLabel: "Browser smoke test", dcCommand: process.execPath, dcArgs: [], allowedRedirectOrigins: new Set() };
  service = new RemoteDesktopService(config);
  const stamp = new Date().toISOString();
  const statuses = ["not_started", "in_progress", "completed"] as const;
  const items = Array.from({ length: 8 }, (_, index) => {
    const text = index === 0 ? `親タスク ${"長い親の本文と表示の折り返しを確認します。".repeat(16)}`
      : index === 6 ? `第7階層の長い親 ${"ParentLabelWithoutSpaces_".repeat(20)}`
      : index === 7 ? `第8階層の本文\n${"long_unbroken_identifier_".repeat(20)}\n日本語の本文も幅に収まることを確認します。`
      : `第${index + 1}階層の子タスク`;
    return { id: `chain-${index + 1}`, text, status: statuses[index % statuses.length]!, parent_id: index === 0 ? null : `chain-${index}`, order: 0, createdBy: owner, createdAt: stamp, updatedAt: stamp };
  });
  items.push({ id: "other-root", text: "別の親タスク（画面から子を追加・移動します）", status: "not_started", parent_id: null, order: 1, createdBy: owner, createdAt: stamp, updatedAt: stamp });
  service.sessions.set(sessionId, { id: sessionId, user: owner, workingDirectory: process.cwd(), purpose: "サブタスク画面の一時ブラウザー試験", created: Date.now(), touched: Date.now(), expires: Date.now() + 3_600_000, state: "active", todo: { items, version: 1, lastTodoUpdatedMono: performance.now(), lastUpdatedAt: stamp, enabled: true, enabledAtMono: performance.now() } } as never);
  await service.audit("session.open", { user: owner, sessionId, workingDirectory: process.cwd(), purpose: "サブタスク画面の一時ブラウザー試験" });
  server = createApp(service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  config.baseUrl = baseUrl;
  assert.equal(service.cfg.baseUrl, baseUrl);
  const todoUrl = `${baseUrl}/api/sessions/${sessionId}/todo`;
  const login = await fetch(`${baseUrl}/user/login`, { method: "POST", headers: { origin: baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: owner, password }), redirect: "manual" });
  assert.equal(login.status, 303);
  const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(token, "temporary login cookie was not returned");
  const executablePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((candidate) => existsSync(candidate));
  result.browser_executable = executablePath ?? "puppeteer-default";
  browser = await puppeteer.launch({ headless: true, ...(executablePath ? { executablePath } : {}), userDataDir: path.join(temporaryRoot, "browser-profile"), timeout: 30_000 });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => pageErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await page.setCookie({ name: "rdmcp_user", value: token, url: baseUrl, httpOnly: true, sameSite: "Lax" });
  let resolveHeld: ((request: HTTPRequest) => void) | undefined;
  let holdNextMutation = false;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled()) return;
    if (request.url() === `${baseUrl}/favicon.ico`) { void request.respond({ status: 204 }).catch((error) => { if (!closing) interceptionErrors.push(String(error)); }); return; }
    if (holdNextMutation && request.url() === todoUrl && request.method() === "PUT") {
      holdNextMutation = false; heldRequest = request; resolveHeld?.(request); return;
    }
    void request.continue().catch((error) => { if (!closing) interceptionErrors.push(String(error)); });
  });
  const navigation = await page.goto(`${baseUrl}/user/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
  assert.equal(navigation?.status(), 200);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#log-new-button")?.disabled);
  const [firstRead] = await Promise.all([
    page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "GET"),
    page.click("#log-new-button"),
  ]);
  assert.equal(firstRead.status(), 200);
  await page.waitForFunction(() => document.querySelectorAll("#session-todo li[data-todo-id]").length === 9 && document.querySelector('#session-todo li[data-todo-id="chain-8"]')?.getAttribute("data-todo-depth") === "8");
  checks.initial_parent_first = await page.$$eval("#session-todo [data-todo-items]>li[data-todo-id]", (rows) => rows.map((row) => (row as HTMLElement).dataset.todoId));
  assert.deepEqual(checks.initial_parent_first, [...Array.from({ length: 8 }, (_, index) => `chain-${index + 1}`), "other-root"]);
  await checkLayout(page, 320, screenshots.mobile);
  await checkLayout(page, 1280, screenshots.desktop);

  // 折り畳みはDOM表示だけを変え、共有データと行の識別子を保持する。
  const beforeCollapse = await service.todoGet(owner, sessionId);
  await page.click(`${rowSelector("chain-1")} [data-todo-op="toggle-children"]`);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-todo-id="chain-8"]')?.hidden === true);
  const collapsed = await page.$$eval("#session-todo [data-todo-items]>li[data-todo-id]", (rows) => rows.map((row) => ({ id: (row as HTMLElement).dataset.todoId, hidden: (row as HTMLElement).hidden, display: getComputedStyle(row).display })));
  assert.equal(collapsed.length, 9);
  assert.equal(collapsed.filter((row) => row.hidden && row.display === "none").length, 7);
  const whileCollapsed = await service.todoGet(owner, sessionId);
  assert.deepEqual(whileCollapsed.items, beforeCollapse.items);
  assert.equal(whileCollapsed.version, beforeCollapse.version);
  await page.click(`${rowSelector("chain-1")} [data-todo-op="toggle-children"]`);
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-todo-id]")).every((row) => !row.hidden));
  checks.collapse = { retained_rows: collapsed.length, hidden_descendants: 7, shared_items_retained: true, expanded_again: true };

  // 子追加は画面の操作を通し、同じサービスの共有Todoで確認する。
  await openStructure(page, "other-root");
  await page.click(`${rowSelector("other-root")} [data-todo-op="add-child"]`);
  const addParent = await page.$eval("[data-todo-add-parent]", (field) => (field as HTMLSelectElement).value);
  assert.equal(addParent, "other-root");
  const childText = "ブラウザーから追加した子タスク";
  await page.type("[data-todo-add-text]", childText);
  const [addResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"),
    page.click('#session-todo [data-todo-op="add"]'),
  ]);
  assert.equal(addResponse.status(), 200);
  await page.waitForFunction(() => document.querySelectorAll("#session-todo li[data-todo-id]").length === 10);
  const afterAdd = await service.todoGet(owner, sessionId);
  const added = afterAdd.items.find((item) => item.text === childText);
  assert.ok(added); assert.equal(added.parent_id, "other-root");
  checks.add_child = { id: added.id, parent_id: added.parent_id, shared_count: afterAdd.items.length };

  // 応答前に本文へ戻り、構成保存によるDOM移動が入力と選択位置を失わせないか確認する。
  await openStructure(page, "chain-8");
  const textSelector = `${rowSelector("chain-8")} [data-todo-text]`;
  const originalField = await page.$(textSelector); assert.ok(originalField);
  const storedText = afterAdd.items.find((item) => item.id === "chain-8")!.text;
  const draft = `${storedText}\n未保存の入力を保持します。`;
  await page.$eval(textSelector, (element, value) => { const field = element as HTMLTextAreaElement; field.value = value; field.dispatchEvent(new Event("input", { bubbles: true })); }, draft);
  await page.select(`${rowSelector("chain-8")} [data-todo-parent]`, "other-root");
  const waitForHeld = new Promise<HTTPRequest>((resolve, reject) => {
    resolveHeld = (request) => { if (heldTimer) clearTimeout(heldTimer); resolve(request); };
    heldTimer = setTimeout(() => reject(new Error("reparent request was not intercepted")), 15_000);
  });
  holdNextMutation = true;
  const [paused] = await Promise.all([waitForHeld, page.click(`${rowSelector("chain-8")} [data-todo-op="reparent"]`)]);
  assert.deepEqual(JSON.parse(paused.postData() ?? "{}").changes, [{ op: "reparent", id: "chain-8", parent_id: "other-root" }]);
  await page.focus(textSelector);
  await page.$eval(textSelector, (field) => (field as HTMLTextAreaElement).setSelectionRange(3, 11, "forward"));
  const [reparentResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"),
    paused.continue(),
  ]);
  heldRequest = undefined;
  assert.equal(reparentResponse.status(), 200);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-todo-id="chain-8"]')?.dataset.todoParentId === "other-root" && !document.querySelector<HTMLButtonElement>('[data-todo-id="chain-8"] [data-todo-op="reparent"]')?.disabled);
  const preserved = await page.evaluate((original, selector) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector)!;
    return { same_element: field === original, text: field.value, focused: document.activeElement === field, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection };
  }, originalField, textSelector);
  assert.equal(preserved.same_element, true); assert.equal(preserved.text, draft); assert.equal(preserved.focused, true);
  assert.equal(preserved.start, 3); assert.equal(preserved.end, 11); assert.equal(preserved.direction, "forward");
  const afterMove = await service.todoGet(owner, sessionId);
  const moved = afterMove.items.find((item) => item.id === "chain-8")!;
  assert.equal(moved.parent_id, "other-root"); assert.equal(moved.text, storedText);
  checks.reparent_preserves_draft = { same_element: preserved.same_element, focused: preserved.focused, selection: [preserved.start, preserved.end], unsaved_text_retained: true, shared_text_unchanged: true, parent_id: moved.parent_id };
  await originalField.dispose();
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(interceptionErrors, []);
  result.ok = true;
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  result.ok = false;
} finally {
  closing = true;
  if (heldTimer) clearTimeout(heldTimer);
  if (heldRequest && !heldRequest.isInterceptResolutionHandled()) { try { await heldRequest.abort(); } catch (error) { errors.push(`interception cleanup: ${String(error)}`); } }
  if (browser) { try { await browser.close(); } catch (error) { errors.push(`browser cleanup: ${String(error)}`); } }
  if (server) { try { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); } catch (error) { errors.push(`server cleanup: ${String(error)}`); } }
  if (service) { try { await service.close(); } catch (error) { errors.push(`service cleanup: ${String(error)}`); } }
  if (temporaryRoot) { try { await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (error) { errors.push(`temporary directory cleanup: ${String(error)}`); } }
  if (errors.length || pageErrors.length || consoleErrors.length || interceptionErrors.length) result.ok = false;
  result.completed_at = new Date().toISOString();
  const json = JSON.stringify(result, null, 2);
  await writeFile(path.join(outputDir, "browser-smoke-result.json"), `\uFEFF${json}\n`, "utf8");
  process.stdout.write(`${json}\n`);
  if (!result.ok) process.exitCode = 1;
}
