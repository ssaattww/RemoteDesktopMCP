import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/index.js";
import { fixture } from "./fixture.js";

test("CUI API returns owner scoped session list through existing auth boundary", async () => {
  const f = await fixture();
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const unauthenticated = await fetch(`${base}/api/console-state`);
    assert.equal(unauthenticated.status, 401);
    await f.service.audit("session.open", {
      user: "owner@example.test",
      sessionId: "owner-session",
      workingDirectory: "owner-work",
      purpose: "Owner test",
    });
    await f.service.audit("session.open", {
      user: "other@example.test",
      sessionId: "other-session",
      workingDirectory: "other-work",
      purpose: "Other test",
    });
    await f.service.audit("session.open", {
      user: "owner@example.test",
      sessionId: "owner-session-2",
      workingDirectory: "owner-work-2",
      purpose: "Owner second test",
    });
    await f.service.audit("operation.received", {
      user: "owner@example.test", sessionId: "owner-session", connectionId: "owner-session",
      operationId: "owner-operation", tool: "node_list",
    });
    await f.service.audit("operation.received", {
      user: "owner@example.test", sessionId: "owner-session-2", connectionId: "owner-session-2",
      operationId: "owner-operation-2", tool: "node_list",
    });

    const login = await fetch(`${base}/user/login`, {
      method: "POST",
      headers: {
        origin: f.service.cfg.baseUrl,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        email: "owner@example.test",
        password: "correct-horse-battery",
      }),
      redirect: "manual",
    });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(token);

    const response = await fetch(`${base}/api/console-state`, {
      headers: { cookie: `rdmcp_user=${token}` },
    });
    assert.equal(response.status, 200);

    const body = await response.json() as { sessions: Array<{ session_id: string }> };
    assert.deepEqual(body.sessions.map((session) => session.session_id).sort(), ["owner-session", "owner-session-2"]);

    const selectedState = await fetch(`${base}/api/console-state?session_id=owner-session`, {
      headers: { cookie: `rdmcp_user=${token}` },
    });
    assert.equal(selectedState.status, 200);
    const selectedBody = await selectedState.json() as { sessions: Array<{ session_id: string }>; running: Array<{ operation_id: string }> };
    assert.deepEqual(selectedBody.sessions.map((session) => session.session_id).sort(), ["owner-session", "owner-session-2"], "the state endpoint keeps the full owner session list; the panel must filter it by exact selected ID");
    assert.deepEqual(selectedBody.running.map((operation) => operation.operation_id), ["owner-operation"], "running operations are server-filtered to the selected session");
    assert.equal((await fetch(`${base}/api/console-state?session_id=other-session`, { headers: { cookie: `rdmcp_user=${token}` } })).status, 404);

    const selectedLogs = await fetch(`${base}/api/logs?limit=200&session_id=owner-session`, {
      headers: { cookie: `rdmcp_user=${token}` },
    });
    assert.equal(selectedLogs.status, 200);
    const selectedLogBody = await selectedLogs.json() as { items: Array<{ event: { sessionId?: string } }> };
    assert.ok(selectedLogBody.items.length > 0);
    assert.ok(selectedLogBody.items.every((item) => item.event.sessionId === "owner-session"), "logs are server-filtered to the selected session");
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await f.cleanup();
  }
});

test("terminal pairing reuses the authenticated user page consent and revokes the same login on logout", async () => {
  const f = await fixture();
  let submittedLogin: unknown;
  let revokedLogin: unknown;
  let submittedCode = "";
  const pairing = {
    submit(login: unknown, code: string) { submittedLogin = login; submittedCode = code; return { ok: true as const, confirmationId: "A1B2C3D4E5" }; },
    revoke(login: unknown) { revokedLogin = login; },
  };
  const server = createApp(f.service, { pairing }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const page = await fetch(`${base}/user`, { headers: { cookie } });
    const html = await page.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);
    assert.match(html, /action="\/user"/);
    const denied = await fetch(`${base}/user`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pairingCode: "deadbeef" }) });
    assert.equal(denied.status, 400, "the route requires explicit consent in addition to CSRF");
    const paired = await fetch(`${base}/user`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, pairingCode: "abcdef0123456789abcdef0123456789", consent: "yes" }) });
    assert.equal(paired.status, 200);
    assert.match(await paired.text(), /A1B2C3D4E5/);
    assert.equal(submittedCode, "abcdef0123456789abcdef0123456789");
    assert.ok(submittedLogin);
    const logout = await fetch(`${base}/user/logout`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf }), redirect: "manual" });
    assert.equal(logout.status, 303);
    assert.equal(revokedLogin, submittedLogin, "logout revokes the exact login record bound to the pairing candidate");
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await f.cleanup();
  }
});
