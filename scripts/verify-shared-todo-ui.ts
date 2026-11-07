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
const expectedConflictConsoleMessages: string[] = [];
const interceptionErrors: string[] = [];
const checks: Record<string, unknown> = {};
let currentStage = "initialization";
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
  const refreshTodoInBrowser = async () => {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url() === todoUrl && candidate.request().method() === "GET"),
      page.click("#log-new-button"),
    ]);
    assert.equal(response.status(), 200);
    return response;
  };
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
  page.on("console", (message) => { if (message.type() === "error") { if (/responded with a status of 409/i.test(message.text())) expectedConflictConsoleMessages.push(message.text()); else consoleErrors.push(message.text()); } });
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

  // Exercise move timestamps through the authenticated HTTP route and preserve descendants.
  currentStage = "N03 create move sibling through UI";
  await openStructure(page, "other-root");
  await page.click(`${rowSelector("other-root")} [data-todo-op="add-child"]`);
  await page.type("[data-todo-add-text]", "move peer");
  const [peerResponse] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.click('#session-todo [data-todo-op="add"]')]);
  assert.equal(peerResponse.status(), 200);
  let snapshot = await service.todoGet(owner, sessionId);
  const peer = snapshot.items.find((item) => item.text === "move peer")!;
  await openStructure(page, peer.id);
  await page.click(`${rowSelector(peer.id)} [data-todo-op="add-child"]`);
  await page.type("[data-todo-add-text]", "move descendant");
  const [descendantResponse] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.click('#session-todo [data-todo-op="add"]')]);
  assert.equal(descendantResponse.status(), 200);
  snapshot = await service.todoGet(owner, sessionId);
  const descendant = snapshot.items.find((item) => item.text === "move descendant")!;
  const beforeMoveSnapshot = await service.todoGet(owner, sessionId);
  const peerBefore = beforeMoveSnapshot.items.find((item) => item.id === peer.id)!;
  const descendantBefore = beforeMoveSnapshot.items.find((item) => item.id === descendant.id)!;
  const [moveResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"),
    page.click(`${rowSelector(peer.id)} [data-todo-op="move-up"]`),
  ]);
  currentStage = "N03 assert move response and descendant state";
  assert.equal(moveResponse.status(), 200);
  await page.waitForFunction((selector) => document.querySelector<HTMLButtonElement>(`${selector} [data-todo-op="save"]`)?.disabled === false, {}, rowSelector(peer.id));
  const afterMoveSnapshot = await service.todoGet(owner, sessionId);
  const peerAfter = afterMoveSnapshot.items.find((item) => item.id === peer.id)!;
  const descendantAfter = afterMoveSnapshot.items.find((item) => item.id === descendant.id)!;
  assert.notEqual(peerAfter.updatedAt, peerBefore.updatedAt);
  assert.deepEqual(descendantAfter, descendantBefore);
  checks.move_timestamp = { target_updated: peerAfter.updatedAt !== peerBefore.updatedAt, descendant_unchanged: JSON.stringify(descendantAfter) === JSON.stringify(descendantBefore), transport: "authenticated HTTP PUT" };

  // A collapsed ancestor must not hide an edited row newly moved beneath it.
  currentStage = "N01 prepare dirty row under collapsed ancestor";
  if (await page.$eval(`${rowSelector("chain-8")} [data-todo-conflict]`, (element) => !(element as HTMLElement).hidden)) {
    await page.click(`${rowSelector("chain-8")} [data-todo-op="keep-draft"]`);
    await page.waitForFunction((selector) => document.querySelector<HTMLButtonElement>(`${selector} [data-todo-op="save"]`)?.disabled === false, {}, rowSelector("chain-8"));
  }
  await page.click(`${rowSelector("chain-1")} [data-todo-op="toggle-children"]`);
  const collapseState = await page.evaluate(() => ({ existingChildHidden: document.querySelector<HTMLElement>('[data-todo-id="chain-2"]')!.hidden, incomingRowVisible: !document.querySelector<HTMLElement>('[data-todo-id="chain-8"]')!.hidden }));
  assert.deepEqual(collapseState, { existingChildHidden: true, incomingRowVisible: true });
  await page.$eval(textSelector, (element) => { const field = element as HTMLTextAreaElement; field.value = "newly hidden unsaved draft"; field.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.select(`${rowSelector("chain-8")} [data-todo-status]`, "in_progress");
  await page.select(`${rowSelector("chain-8")} [data-todo-parent]`, "chain-1");
  await page.$eval(textSelector, (field) => { (field as HTMLTextAreaElement).focus(); (field as HTMLTextAreaElement).setSelectionRange(4, 12, "forward"); });
  const n01Before = await page.evaluate((selector) => { const row = document.querySelector<HTMLElement>(selector)!; return { rowHidden: row.hidden, parent: row.dataset.todoParentId, saveDisabled: row.querySelector<HTMLButtonElement>('[data-todo-op="save"]')?.disabled, version: document.querySelector<HTMLElement>("#session-todo")?.dataset.version, collapsed: Array.from(document.querySelectorAll<HTMLElement>('#session-todo [data-todo-op="toggle-children"]')).filter((button) => button.getAttribute("aria-expanded") === "false").map((button) => button.closest<HTMLElement>("li")?.dataset.todoId) }; }, rowSelector("chain-8"));
  checks.n01_before = n01Before;
  assert.equal(n01Before.saveDisabled, false);
  currentStage = "N01 apply external parent change to service";
  const beforeExternalReparent = await service.todoGet(owner, sessionId);
  const externalParentMove = await service.todoUpdate(owner, sessionId, beforeExternalReparent.version, [{ op: "reparent", id: "other-root", parent_id: "chain-1" }]);
  currentStage = "N01 send stale save and receive 409 snapshot";
  const [reparentConflict] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(`${rowSelector("chain-8")} [data-todo-op="save"]`, (button) => (button as HTMLButtonElement).click())]);
  currentStage = "N01 assert conflict snapshot, focus, selection, and drafts";
  assert.equal(reparentConflict.status(), 409);
  assert.equal(Number(await page.$eval("#session-todo", (element) => (element as HTMLElement).dataset.version)), externalParentMove.version);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const retained = await page.evaluate((selector) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector)!;
    const row = field.closest<HTMLElement>("li[data-todo-id]")!;
    const status = row.querySelector<HTMLSelectElement>("[data-todo-status]")!;
    const parent = row.querySelector<HTMLSelectElement>("[data-todo-parent]")!;
    return { hidden: row.hidden, visible: field.getClientRects().length > 0, focused: document.activeElement === field, value: field.value, status: status.value, parent: parent.value, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection, conflict: !row.querySelector<HTMLElement>("[data-todo-conflict]")!.hidden };
  }, textSelector);
  assert.equal(retained.hidden, false); assert.equal(retained.visible, true); assert.equal(retained.focused, true);
  assert.equal(retained.value, "newly hidden unsaved draft"); assert.equal(retained.status, "in_progress"); assert.equal(retained.parent, "chain-1");
  assert.equal(retained.start, 4); assert.equal(retained.end, 12); assert.equal(retained.direction, "forward"); assert.equal(retained.conflict, true);
  checks.reparent_under_collapsed_ancestor = retained;
  await page.$eval(`${rowSelector("chain-8")} [data-todo-op="keep-draft"]`, (button) => (button as HTMLButtonElement).click());
  await page.waitForFunction((selector) => document.querySelector<HTMLElement>(`${selector} [data-todo-conflict]`)?.hidden === true, {}, rowSelector("chain-8"));
  const [selfMoveResponse] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(`${rowSelector("chain-8")} [data-todo-op="reparent"]`, (button) => (button as HTMLButtonElement).click())]);
  assert.equal(selfMoveResponse.status(), 200);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-todo-id="chain-8"]')?.dataset.todoParentId === "chain-1");
  const selfReparent = await page.evaluate((selector) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector)!; const row = field.closest<HTMLElement>("li[data-todo-id]")!;
    return { hidden: row.hidden, visible: field.getClientRects().length > 0, focused: document.activeElement === field, text: field.value, status: row.querySelector<HTMLSelectElement>("[data-todo-status]")!.value, parent: row.querySelector<HTMLSelectElement>("[data-todo-parent]")!.value, start: field.selectionStart, end: field.selectionEnd, conflictHidden: row.querySelector<HTMLElement>("[data-todo-conflict]")!.hidden };
  }, textSelector);
  assert.equal(selfReparent.hidden, false); assert.equal(selfReparent.visible, true); assert.equal(selfReparent.focused, true);
  assert.equal(selfReparent.text, "newly hidden unsaved draft"); assert.equal(selfReparent.status, "in_progress"); assert.equal(selfReparent.parent, "chain-1");
  assert.equal(selfReparent.start, 4); assert.equal(selfReparent.end, 12); assert.equal(selfReparent.conflictHidden, true);
  checks.same_screen_reparent_under_collapsed_ancestor = selfReparent;
  await page.click(`${rowSelector("chain-1")} [data-todo-op="toggle-children"]`); // clear the snapshot reveal by explicitly expanding
  await page.click(`${rowSelector("chain-1")} [data-todo-op="toggle-children"]`);
  const intentionalCollapse = await page.evaluate(() => ({ hidden: document.querySelector<HTMLElement>('[data-todo-id="chain-8"]')?.hidden, focusedToggle: document.activeElement === document.querySelector('[data-todo-id="chain-1"] [data-todo-op="toggle-children"]') }));
  assert.equal(intentionalCollapse.hidden, true); assert.equal(intentionalCollapse.focusedToggle, true);
  checks.intentional_collapse_remains_effective = intentionalCollapse;

  // Deleting a complete collapsed branch selects the surviving snapshot-visible row.
  currentStage = "N02 prepare branch deletion";
  const beforeDeleteBranch = await service.todoGet(owner, sessionId);
  const byId = new Map(beforeDeleteBranch.items.map((item) => [item.id, item]));
  const depth = (id: string) => { let value = 0; let parentId = byId.get(id)?.parent_id ?? null; const seen = new Set<string>(); while (parentId && !seen.has(parentId)) { seen.add(parentId); value += 1; parentId = byId.get(parentId)?.parent_id ?? null; } return value; };
  const branchDeletes = beforeDeleteBranch.items.filter((item) => item.id === "chain-1" || item.parent_id !== null).sort((left, right) => depth(right.id) - depth(left.id));
  const deleteChanges = [{ op: "add", text: "surviving visible row" }, ...branchDeletes.map((item) => ({ op: "delete", id: item.id }))];
  const collapsedToggle = `${rowSelector("chain-1")} [data-todo-op="toggle-children"]`;
  await page.$eval(collapsedToggle, (button) => (button as HTMLButtonElement).focus());
  const removedBranch = await service.todoUpdate(owner, sessionId, beforeDeleteBranch.version, deleteChanges);
  const [deleteConflict] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(`${rowSelector("chain-1")} [data-todo-op="save"]`, (button) => { (button as HTMLButtonElement).focus(); (button as HTMLButtonElement).click(); })]);
  currentStage = "N02 assert visible destination and message";
  assert.equal(deleteConflict.status(), 409);
  assert.equal(Number(await page.$eval("#session-todo", (element) => (element as HTMLElement).dataset.version)), removedBranch.version);
  const focusAfterDelete = await page.evaluate(() => ({ tag: document.activeElement?.tagName, row: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null, status: document.querySelector<HTMLElement>("[data-todo-status-message]")?.textContent ?? "", visibleRows: Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-todo-id]")).filter((row) => !row.hidden).map((row) => row.dataset.todoId), draftRows: Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-deleted-draft='true']")).map((row) => row.dataset.todoId) }));
  assert.equal(focusAfterDelete.tag, "TEXTAREA"); assert.equal(focusAfterDelete.row, removedBranch.items[0]?.id);
  assert.match(focusAfterDelete.status, /表示中の項目へフォーカス/);
  assert.ok(focusAfterDelete.visibleRows.includes(focusAfterDelete.row));
  assert.ok(focusAfterDelete.draftRows.includes("chain-8"), "the unresolved deleted draft remains available");
  checks.delete_collapsed_branch = focusAfterDelete;

  // At both supported widths, edit text, change status, and delete a leaf task.
  let currentSurvivor = removedBranch.items[0]!;
  for (const width of [320, 1280]) {
    currentStage = `320/1280 edit, status, delete at ${width}px`;
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    const survivor = currentSurvivor;
    const survivorRow = rowSelector(survivor.id);
    await page.$eval(`${survivorRow} [data-todo-text]`, (element) => { const field = element as HTMLTextAreaElement; field.value = "edited at both widths"; field.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.select(`${survivorRow} [data-todo-status]`, "completed");
    const [editResponse] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.click(`${survivorRow} [data-todo-op="save"]`)]);
    assert.equal(editResponse.status(), 200);
    const afterEdit = await service.todoGet(owner, sessionId);
    const edited = afterEdit.items.find((item) => item.id === survivor.id)!;
    assert.equal(edited.text, "edited at both widths"); assert.equal(edited.status, "completed");
    const [deleteResponse] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.click(`${survivorRow} [data-todo-op="delete"]`)]);
    assert.equal(deleteResponse.status(), 200);
    assert.equal((await service.todoGet(owner, sessionId)).items.some((item) => item.id === survivor.id), false);
    checks[`mobile_desktop_edit_status_delete_${width}`] = { text_saved: edited.text, status_saved: edited.status, deleted: true };
    if (width === 320) {
      const next = await service.todoGet(owner, sessionId);
      const replacement = await service.todoUpdate(owner, sessionId, next.version, [{ op: "add", text: "surviving visible row" }]);
      await refreshTodoInBrowser();
      currentSurvivor = replacement.items.find((item) => item.text === "surviving visible row")!;
      await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) >= version, {}, replacement.version);
    }
  }

  // Adjacent deletions skip hidden descendants and choose the next visible snapshot row.
  currentStage = "N02 next visible row after adjacent hidden deletions";
  let seeded = await service.todoGet(owner, sessionId);
  let scenario = await service.todoUpdate(owner, sessionId, seeded.version, [{ op: "add", text: "next-scenario parent" }]);
  const nextParent = scenario.items.find((item) => item.text === "next-scenario parent")!;
  scenario = await service.todoUpdate(owner, sessionId, scenario.version, [{ op: "add", text: "hidden child", parent_id: nextParent.id }, { op: "add", text: "visible next root" }]);
  const hiddenChild = scenario.items.find((item) => item.text === "hidden child")!;
  const visibleNext = scenario.items.find((item) => item.text === "visible next root")!;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, scenario.version);
  await page.click(`${rowSelector(nextParent.id)} [data-todo-op="toggle-children"]`);
  assert.equal(await page.$eval(rowSelector(hiddenChild.id), (row) => (row as HTMLElement).hidden), true);
  const nextParentSave = `${rowSelector(nextParent.id)} [data-todo-op="save"]`;
  await page.$eval(`${rowSelector(nextParent.id)} [data-todo-text]`, (field) => (field as HTMLTextAreaElement).focus());
  const preAdjacentFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, row: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null }));
  assert.equal(preAdjacentFocus.row, nextParent.id);
  const beforeAdjacentDelete = await service.todoGet(owner, sessionId);
  const afterAdjacentDelete = await service.todoUpdate(owner, sessionId, beforeAdjacentDelete.version, [{ op: "delete", id: hiddenChild.id }, { op: "delete", id: nextParent.id }]);
  const focusBeforeConflict = await page.evaluate(() => ({ tag: document.activeElement?.tagName, row: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null }));
  assert.equal(focusBeforeConflict.row, nextParent.id);
  const [adjacentConflict] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(nextParentSave, (button) => (button as HTMLButtonElement).click())]);
  assert.equal(adjacentConflict.status(), 409);
  checks.adjacent_delete_request = adjacentConflict.request().postData();
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, afterAdjacentDelete.version);
  checks.adjacent_delete_post_snapshot = await page.evaluate(() => ({ activeTag: document.activeElement?.tagName, activeRow: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null, rows: Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-todo-id]")).map((row) => ({ id: row.dataset.todoId, hidden: row.hidden, deletedDraft: row.dataset.deletedDraft, conflictHidden: row.querySelector<HTMLElement>("[data-todo-conflict]")?.hidden })), message: document.querySelector<HTMLElement>("[data-todo-status-message]")?.textContent }));
  const nextFocus = await page.evaluate((selector) => ({ row: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null, hidden: document.querySelector<HTMLElement>(selector)?.hidden ?? true, visibleRows: Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-todo-id]")).filter((row) => !row.hidden).map((row) => row.dataset.todoId), message: document.querySelector<HTMLElement>("[data-todo-status-message]")?.textContent ?? "" }), rowSelector(visibleNext.id));
  checks.adjacent_delete_skips_hidden_next_row = nextFocus;
  assert.equal(nextFocus.row, visibleNext.id); assert.equal(nextFocus.hidden, false); assert.deepEqual(nextFocus.visibleRows, [visibleNext.id]);
  assert.match(nextFocus.message, /表示中の項目へフォーカス/);
  checks.adjacent_delete_skips_hidden_next_row = nextFocus;

  // With no surviving next row, the previous visible row receives focus.
  currentStage = "N02 previous visible row fallback";
  seeded = await service.todoGet(owner, sessionId);
  scenario = await service.todoUpdate(owner, sessionId, seeded.version, [{ op: "delete", id: visibleNext.id }]);
  scenario = await service.todoUpdate(owner, sessionId, scenario.version, [{ op: "add", text: "previous root" }, { op: "add", text: "focused last root" }]);
  const previousRoot = scenario.items.find((item) => item.text === "previous root")!;
  const lastRoot = scenario.items.find((item) => item.text === "focused last root")!;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, scenario.version);
  await page.$eval(`${rowSelector(lastRoot.id)} [data-todo-text]`, (field) => (field as HTMLTextAreaElement).focus());
  const beforeLastDelete = await service.todoGet(owner, sessionId);
  const afterLastDelete = await service.todoUpdate(owner, sessionId, beforeLastDelete.version, [{ op: "delete", id: lastRoot.id }]);
  const [previousConflict] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(`${rowSelector(lastRoot.id)} [data-todo-op="save"]`, (button) => (button as HTMLButtonElement).click())]);
  assert.equal(previousConflict.status(), 409);
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, afterLastDelete.version);
  const previousFocus = await page.evaluate(() => ({ row: document.activeElement?.closest<HTMLElement>("li[data-todo-id]")?.dataset.todoId ?? null, visibleRows: Array.from(document.querySelectorAll<HTMLElement>("#session-todo li[data-todo-id]")).filter((row) => !row.hidden).map((row) => row.dataset.todoId), message: document.querySelector<HTMLElement>("[data-todo-status-message]")?.textContent ?? "" }));
  assert.equal(previousFocus.row, previousRoot.id); assert.deepEqual(previousFocus.visibleRows, [previousRoot.id]);
  assert.match(previousFocus.message, /表示中の項目へフォーカス/);
  checks.previous_visible_row_fallback = previousFocus;

  // Deleting the last available row sends focus to the Todo heading.
  currentStage = "N02 last row focuses heading";
  seeded = await service.todoGet(owner, sessionId);
  scenario = await service.todoUpdate(owner, sessionId, seeded.version, [{ op: "delete", id: previousRoot.id }]);
  scenario = await service.todoUpdate(owner, sessionId, scenario.version, [{ op: "add", text: "only remaining row" }]);
  const onlyRow = scenario.items[0]!;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, scenario.version);
  await page.$eval(`${rowSelector(onlyRow.id)} [data-todo-text]`, (field) => (field as HTMLTextAreaElement).focus());
  const beforeOnlyDelete = await service.todoGet(owner, sessionId);
  const afterOnlyDelete = await service.todoUpdate(owner, sessionId, beforeOnlyDelete.version, [{ op: "delete", id: onlyRow.id }]);
  const [onlyConflict] = await Promise.all([page.waitForResponse((response) => response.url() === todoUrl && response.request().method() === "PUT"), page.$eval(`${rowSelector(onlyRow.id)} [data-todo-op="save"]`, (button) => (button as HTMLButtonElement).click())]);
  assert.equal(onlyConflict.status(), 409);
  await page.waitForFunction((version) => Number(document.querySelector<HTMLElement>("#session-todo")?.dataset.version) === version, {}, afterOnlyDelete.version);
  const headingFocus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent, rowCount: document.querySelectorAll("#session-todo li[data-todo-id]").length, message: document.querySelector<HTMLElement>("[data-todo-status-message]")?.textContent ?? "" }));
  assert.equal(headingFocus.tag, "H2"); assert.equal(headingFocus.rowCount, 0); assert.match(headingFocus.message, /見出しへフォーカス/);
  checks.last_row_focuses_heading = headingFocus;

  await originalField.dispose();
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(interceptionErrors, []);
  checks.expected_conflict_responses = expectedConflictConsoleMessages.length;
  result.ok = true;
} catch (error) {
  errors.push(`stage=${currentStage}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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
