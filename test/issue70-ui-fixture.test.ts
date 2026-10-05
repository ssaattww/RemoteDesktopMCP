import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { userConsoleClientScript } from "../src/user-console-client.js";

test("Issue 70 UI fixture accepts browser-origin login and serves seeded session detail", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/issue70-ui-fixture.ts", "--serve"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    const fixture = await new Promise<{ url: string; login: { email: string; password: string }; sessionId: string }>((resolve, reject) => {
      const output: string[] = [];
      lines.on("line", (line) => {
        output.push(line);
        try { resolve(JSON.parse(output.join("\n")) as { url: string; login: { email: string; password: string }; sessionId: string }); } catch { /* Wait for the fixture's complete pretty-printed JSON object. */ }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`fixture exited before startup (${code}): ${stderr}`)));
    });
    const origin = new URL(fixture.url).origin;
    const login = await fetch(`${origin}/user/login`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fixture.login), redirect: "manual",
    });
    assert.equal(login.status, 303, "the configured origin must match the actual browser origin");
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    assert.ok(cookie);
    const detail = await fetch(fixture.url, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    const html = await detail.text();
    assert.match(html, /作業一覧/);
    assert.match(html, /todo-preview-long/);
    assert.match(html, /todo-preview-completed/);
    assert.match(html, /todo-preview-active/);
  } finally {
    lines.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});

test("Issue 70 preview writes a product-rendered, offline HTML file with representative Todo states", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rdmcp-issue70-preview-test-"));
  const output = path.join(directory, "todo-preview.html");
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/issue70-ui-fixture.ts", "--write-html", output], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0, `preview generation failed: ${stderr}`);
    assert.match(stdout, /Wrote offline Issue 70 preview/);
    const html = await readFile(output, "utf8");
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /id="session-todo"/);
    assert.match(html, /todo-preview-offline-fixture/);
    assert.ok(html.includes(userConsoleClientScript), "preview embeds the exact production client script");
    assert.match(html, /todo-preview-long/);
    assert.match(html, /todo-preview-completed/);
    assert.match(html, /todo-preview-active/);
    assert.match(html, /todo-enforcement-toggle/);
    assert.match(html, /<details class="todo-add" data-todo-add-details/);
    assert.match(html, /offline-preview-token/);
    assert.match(html, /Offline preview blocked an unmocked request/);
    assert.match(html, /window\.EventSource = OfflinePreviewEventSource/);
    assert.match(html, /const isEnforcementForm = \(form\) => form\.classList\.contains\("todo-enforcement-form"\)/);
    assert.match(html, /addEventListener\("submit",[\s\S]*?}, true\)/, "the capture handler must block native non-fixture form submissions");
    assert.match(html, /addEventListener\("click",[\s\S]*?}, true\)/, "the capture handler must stop page-changing links and native submit buttons");
    assert.match(html, /if \(link && !link\.getAttribute\("href"\)\.startsWith\("#"\)\) \{ event\.preventDefault\(\); explainBlockedAction\(\); return; \}/);
    assert.match(html, /target\?\.closest\?\.\("\[data-issue70-blocked-form\]"\)/, "the preview must explain clicks on inert emergency and logout controls");
    assert.match(html, /if \(submitForm && !isEnforcementForm\(submitForm\)\) \{ event\.preventDefault\(\); explainBlockedAction\(\); \}/);
    assert.match(html, /if \(!isEnforcementForm\(form\)\) \{ explainBlockedAction\(\); return; \}/);
    const markup = html.slice(0, html.search(/<script\b/i));
    assert.match(markup, /<div data-issue70-blocked-form>/, "emergency and logout forms must be removed as submission targets in the generated markup");
    assert.doesNotMatch(markup, /\/user\/(?:emergency-stop|logout)|\s(?:action|method|target|formaction|formmethod|formtarget)=(['"])/i, "generated form markup must not retain a server destination or native submission method");
    assert.doesNotMatch(markup, /href="\/user"/, "non-fragment navigation destinations must be absent from generated markup");
    assert.match(markup, /<form class="todo-enforcement-form">/, "the action-free local enforcement form must be preserved");
    assert.match(html, /オフラインプレビューでは利用できません/);
    assert.doesNotMatch(html, /issue70-review-fixture|issue70-ui-fixture-secret|rdmcp_user=|\/workspace\/RemoteDesktopMCP-issue70/);
    assert.doesNotMatch(html, /https?:\/\//, "the saved preview must not include a remote endpoint");

    const bridge = html.match(/<script nonce="offline-preview-nonce">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(bridge?.includes('const marker = "todo-preview-offline-fixture"'));
    const listeners = new Map<string, (event: { target: unknown; preventDefault: () => void }) => void>();
    const notice = { textContent: "" };
    const localState = { textContent: "無効" };
    const localButton = { value: "true", textContent: "強制を有効にする" };
    const sessionTodo = { querySelector: (selector: string) => selector === "[data-todo-enforcement-state]" ? localState : selector === "[data-todo-enforcement]" ? localButton : null };
    class PreviewForm {
      classList = { contains: (name: string) => name === "todo-enforcement-form" };
      closest(selector: string) { return selector === "#session-todo" ? sessionTodo : null; }
      querySelector(selector: string) { return sessionTodo.querySelector(selector); }
    }
    class PreviewHtmlForm extends PreviewForm {}
    const document = {
      addEventListener: (name: string, listener: (event: { target: unknown; preventDefault: () => void }) => void) => listeners.set(name, listener),
      querySelector: () => notice,
    };
    const window: Record<string, unknown> = {};
    runInNewContext(bridge, { document, window, HTMLFormElement: PreviewHtmlForm, Response, URL });
    const localForm = new PreviewHtmlForm();
    for (const [expectedState, expectedValue, expectedLabel] of [["有効", "false", "強制を無効にする"], ["無効", "true", "強制を有効にする"]]) {
      let prevented = false;
      listeners.get("submit")?.({ target: localForm, preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true, "local enforcement toggles must still suppress native submission");
      assert.equal(localState.textContent, expectedState);
      assert.equal(localButton.value, expectedValue);
      assert.equal(localButton.textContent, expectedLabel);
    }
    class BlockedPreviewForm extends PreviewHtmlForm { classList = { contains: () => false }; }
    let blockedPrevented = false;
    listeners.get("submit")?.({ target: new BlockedPreviewForm(), preventDefault: () => { blockedPrevented = true; } });
    assert.equal(blockedPrevented, true, "other action-free forms remain blocked");
    assert.equal(notice.textContent, "この操作はオフラインプレビューでは利用できません。サーバーへの送信やページ移動は行われません。");
    assert.equal(localState.textContent, "無効", "blocked forms must not change enforcement state");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
