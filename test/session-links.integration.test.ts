import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../src/index.js";
import type { SessionLinkTransport } from "../src/session-links.js";
import { fixture, mcp } from "./fixture.js";

const body = (title: string) => new TextEncoder().encode(`<html><title>${title}</title></html>`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Issue 45 links and Issue 55 session-relative times coexist in the owner console", async () => {
  const f = await fixture();
  f.service.cfg.sessionLinkTransport = { resolve: async () => ["93.184.216.34"], request: async () => { throw new Error("manual titles do not fetch"); } };
  const api = await mcp(f.service);
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await api.call("session_open", { url: "https://example.com/task", title: "Review document" });
    await api.call("session_open", { title: "<Unlinked title>" });
    const longTitle = "A long session link title ".repeat(7).trim();
    await api.call("session_open", { url: "https://example.com/long-title", title: longTitle });
    const login = await fetch(`${base}/user/login`, { method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual" });
    assert.equal(login.status, 303);
    const token = /rdmcp_user=([^;,]+)/u.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const page = await fetch(`${base}/user`, { headers: { cookie: `rdmcp_user=${token}` } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<details class="session-time"/u, "timestamps retain the relative and exact disclosure");
    assert.match(html, /<th[^>]*>リンク<\/th>/u, "the low-priority link column remains in the table");
    assert.match(html, /<a class="session-external-link"[^>]*href="https:\/\/example\.com\/task"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Review document<\/a>/u);
    assert.match(html, /<span class="session-external-title">&lt;Unlinked title&gt;<\/span>/u, "title-only metadata is escaped and inert");
    assert.match(html, /<td class="session-external-link-cell" style="text-align:right;font-size:\.9em;color:#777"><a class="session-external-link"[^>]*>A long session link title/u, "external link stays in its right-aligned low-priority cell");
    assert.match(html, /@media\(max-width:600px\)\{[^<]*th,td\{padding:7px;white-space:nowrap\}[^<]*\.session-list td\.session-external-link-cell\{white-space:normal;overflow-wrap:anywhere;min-width:8em\}/u, "only the narrow-screen external-link cell is allowed to wrap and retains readable width");
  } finally {
    await api.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

async function readLinkEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = "";
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for the session-link event.")), Math.max(1, deadline - Date.now())); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
    const match = /event: session-link-updated\ndata: ([^\n]+)\n/u.exec(text);
    if (match) return match[1]!;
  }
  throw new Error("Session-link update event was not sent.");
}

test("session_open stores owner-only link metadata, skips manual-title retrieval and resolves automatic titles", async () => {
  const f = await fixture();
  let requestCount = 0;
  f.service.cfg.sessionLinkTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async (url) => { requestCount += 1; if (url.pathname === "/failure") throw new Error("synthetic failure containing no returned value"); return { status: 200, contentType: "text/html; charset=utf-8", body: body("Fetched &amp; safe") }; },
  };
  f.service.cfg.users.push({ email: "other@example.test", passwordHash: f.service.cfg.users[0]!.passwordHash });
  const api = await mcp(f.service);
  const otherApi = await mcp(f.service, "other@example.test");
  const server = createApp(f.service).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const sessionOpenDescription = (await api.listTools()).tools.find((tool) => tool.name === "session_open")?.description ?? "";
    assert.match(sessionOpenDescription, /unauthenticated public request/u);
    assert.match(sessionOpenDescription, /no cookies or local credentials/u);
    assert.match(sessionOpenDescription, /enter a title for those links/u);
    const manualUrl = "https://example.com/manual?api_key=private-test-secret#task";
    const manual = await api.call("session_open", { url: manualUrl, title: "<Manual & title>" });
    assert.equal(manual.external_url, manualUrl);
    assert.equal(manual.external_title, "<Manual & title>");
    assert.equal(manual.external_title_source, "manual");
    assert.equal(manual.external_title_status, "not_requested");
    await sleep(10);
    assert.equal(requestCount, 0);
    assert.doesNotMatch(JSON.stringify(f.service.auditEntriesForConsole()), /private-test-secret|Manual & title/u);

    const titleOnly = await api.call("session_open", { title: "<Title without URL>" });
    assert.equal(titleOnly.external_url, undefined);
    assert.equal(titleOnly.external_title, "<Title without URL>");
    const invalidUrlWithTitle = await api.call("session_open", { url: "http://127.0.0.1/private", title: "<Local page>" });
    assert.equal(invalidUrlWithTitle.external_url, undefined);
    assert.equal(invalidUrlWithTitle.external_title, "<Local page>");

    const automatic = await api.call("session_open", { url: "https://example.com/work" });
    assert.equal(automatic.external_title_status, "pending");
    const automaticSession = f.service.sessions.get(String(automatic.session_id)); assert.ok(automaticSession);
    for (let tries = 0; tries < 50 && automaticSession.externalTitleStatus === "pending"; tries += 1) await sleep(2);
    assert.equal(automaticSession.externalTitle, "Fetched & safe");
    assert.equal(automaticSession.externalTitleSource, "fetched");
    assert.equal(automaticSession.externalTitleStatus, "resolved");
    assert.equal(automaticSession.linkRevision, 0);
    assert.equal(requestCount, 1);

    const failed = await api.call("session_open", { url: "https://example.com/failure" });
    assert.equal(typeof failed.session_id, "string", "retrieval failure must not reject session creation");
    const failedSession = f.service.sessions.get(String(failed.session_id)); assert.ok(failedSession);
    for (let tries = 0; tries < 50 && failedSession.externalTitleStatus === "pending"; tries += 1) await sleep(2);
    assert.equal(failedSession.externalTitleStatus, "failed");

    const login = await fetch(`${base}/user/login`, {
      method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "owner@example.test", password: "correct-horse-battery" }), redirect: "manual",
    });
    const token = /rdmcp_user=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]; assert.ok(token);
    const cookie = `rdmcp_user=${token}`;
    const state = await fetch(`${base}/api/console-state`, { headers: { cookie } }); assert.equal(state.status, 200);
    const json = await state.json() as { sessions: Array<Record<string, unknown>> };
    const listed = json.sessions.find((session) => session.session_id === automatic.session_id); assert.ok(listed);
    assert.equal(listed.external_title, "Fetched & safe");
    assert.equal(listed.external_title_source, "fetched");
    const titleOnlyListed = json.sessions.find((session) => session.session_id === titleOnly.session_id); assert.ok(titleOnlyListed);
    assert.equal(titleOnlyListed.external_title, "<Title without URL>");
    assert.equal(titleOnlyListed.external_url, undefined);
    const invalidUrlListed = json.sessions.find((session) => session.session_id === invalidUrlWithTitle.session_id); assert.ok(invalidUrlListed);
    assert.equal(invalidUrlListed.external_title, "<Local page>");
    assert.equal(invalidUrlListed.external_url, undefined);
    const eventStream = await fetch(`${base}/api/events`, { headers: { cookie } }); assert.equal(eventStream.status, 200);
    const reader = eventStream.body!.getReader();
    try {
      const eventSession = await api.call("session_open", { url: "https://example.com/event" });
      const eventData = JSON.parse(await readLinkEvent(reader)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(eventData).sort(), ["link_revision", "session_id"]);
      assert.equal(eventData.session_id, eventSession.session_id);
      assert.equal(eventData.link_revision, 0);
    } finally { await reader.cancel(); }
    const otherLogin = await fetch(`${base}/user/login`, {
      method: "POST", headers: { origin: f.service.cfg.baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "other@example.test", password: "correct-horse-battery" }), redirect: "manual",
    });
    const otherToken = /rdmcp_user=([^;,]+)/.exec(otherLogin.headers.get("set-cookie") ?? "")?.[1]; assert.ok(otherToken);
    const otherState = await fetch(`${base}/api/console-state`, { headers: { cookie: `rdmcp_user=${otherToken}` } }); assert.equal(otherState.status, 200);
    const otherJson = await otherState.json() as { sessions: Array<Record<string, unknown>> };
    assert.equal(otherJson.sessions.some((session) => session.external_url), false);

    const page = await fetch(`${base}/user`, { headers: { cookie } }); assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<span class="session-external-title">&lt;Title without URL&gt;<\/span>/u);
    assert.match(html, /<span class="session-external-title">&lt;Local page&gt;<\/span>/u);
    const anchor = [...html.matchAll(/<a class="session-external-link"([^>]*)>(.*?)<\/a>/gu)].find((match) => match[2] === "Fetched &amp; safe"); assert.ok(anchor);
    assert.match(anchor[1]!, /target="_blank"/u);
    assert.match(anchor[1]!, /rel="noopener noreferrer"/u);
    assert.match(anchor[1]!, /referrerpolicy="no-referrer"/u);
    assert.equal(anchor[2], "Fetched &amp; safe");
    assert.doesNotMatch(anchor[2]!, /example\.com/u);
  } finally {
    await api.close(); await otherApi.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test("session close suppresses an in-flight external title result", async () => {
  const f = await fixture();
  let releaseResponse!: (value: { status: number; contentType: string; body: Uint8Array }) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  f.service.cfg.sessionLinkTransport = {
    resolve: async () => ["93.184.216.34"],
    request: async () => {
      markStarted();
      return new Promise((resolve) => { releaseResponse = resolve; });
    },
  } as SessionLinkTransport;
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", { url: "https://example.com/slow" });
    const session = f.service.sessions.get(String(opened.session_id)); assert.ok(session);
    await started;
    await api.call("session_close", { session_id: opened.session_id });
    releaseResponse({ status: 200, contentType: "text/html", body: body("Too late") });
    await sleep(20);
    assert.equal(session.state, "closed");
    assert.equal(session.externalTitle, undefined);
    assert.equal(session.externalUrl, undefined);
    assert.equal(session.externalTitleStatus, "not_requested");
  } finally { await api.close(); await f.cleanup(); }
});

test("session expiry clears external link data even when expiry auditing fails", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    const opened = await api.call("session_open", { url: "https://example.com/private?token=secret", title: "Private title" });
    const session = f.service.sessions.get(String(opened.session_id)); assert.ok(session);
    session.expires = Date.now() - 1;
    const originalAudit = f.service.audit.bind(f.service);
    f.service.audit = async (event, fields) => {
      if (event === "session.expired") throw new Error("synthetic audit write failure");
      return originalAudit(event, fields);
    };
    await assert.rejects(f.service.sweepExpired(), /synthetic audit write failure/u);
    assert.equal(session.state, "expired");
    assert.equal(session.externalUrl, undefined);
    assert.equal(session.externalTitle, undefined);
    assert.equal(session.externalTitleSource, undefined);
    assert.equal(session.externalTitleStatus, "not_requested");
  } finally { await api.close(); await f.cleanup(); }
});
