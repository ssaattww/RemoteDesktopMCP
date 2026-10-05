import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    assert.match(html, /addEventListener\("submit"/);
    assert.doesNotMatch(html, /issue70-review-fixture|issue70-ui-fixture-secret|rdmcp_user=|\/workspace\/RemoteDesktopMCP-issue70/);
    assert.doesNotMatch(html, /https?:\/\//, "the saved preview must not include a remote endpoint");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
