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
    assert.deepEqual(body.sessions.map((session) => session.session_id), ["owner-session"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});
