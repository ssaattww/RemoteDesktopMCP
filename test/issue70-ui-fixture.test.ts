import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("Issue 70 UI fixture accepts browser-origin login and serves seeded session detail", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/issue70-ui-fixture.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
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
    assert.match(html, /todo-long-line/);
    assert.match(html, /todo-wrap-check/);
  } finally {
    lines.close();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }
});
