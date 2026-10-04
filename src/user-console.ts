import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { readSessionLogs } from "./admin.js";
import type { RemoteDesktopService } from "./index.js";
import { GoogleOidcClient, type GoogleIdentity } from "./public-auth.js";
import { verifyPassword } from "./hash-password.js";
import { userConsoleClientScript } from "./user-console-client.js";
import { formatSessionTime } from "./session-time.js";

const id = () => randomBytes(32).toString("base64url");
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const externalLinkMarkup = (session?: { externalUrl?: string; externalTitle?: string; externalTitleSource?: string; externalTitleStatus?: string }) => {
  let link = "—";
  if (session?.externalUrl) {
    try {
      const url = new URL(session.externalUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) link = `<a class="session-external-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(session.externalTitle ?? url.href)}</a>`;
    } catch { /* Malformed session data is not rendered as a link. */ }
  } else if (session?.externalTitle) link = `<span class="session-external-title">${escape(session.externalTitle)}</span>`;
  const source = session?.externalTitleSource === "manual" ? "手入力" : session?.externalTitleSource === "fetched" ? "自動取得" : session?.externalTitleStatus === "pending" ? "題名を取得中" : session?.externalTitleStatus === "failed" ? "題名を取得できません" : "";
  return source ? `${link}<small class="session-external-source">${source}</small>` : link;
};
const operationDetailHtml = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  const detail = value as { summary?: unknown; entries?: unknown };
  if (!Array.isArray(detail.entries)) return "—";
  const entries = detail.entries.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as { label?: unknown; value?: unknown; truncated?: unknown };
    if (typeof item.label !== "string" || typeof item.value !== "string") return [];
    return [`<div class="operation-detail-entry"><strong>${escape(item.label)}${item.truncated === true ? "（省略あり）" : ""}</strong><pre>${escape(item.value)}</pre></div>`];
  });
  if (!entries.length) return "—";
  const summary = typeof detail.summary === "string" ? `<p><strong>${escape(detail.summary)}</strong></p>` : "";
  return `<details><summary>詳細</summary>${summary}${entries.join("")}</details>`;
};
const sessionTimeHtml = (value: unknown, sessionId: string, kind: "created" | "last-access") => {
  const display = formatSessionTime(value);
  if (!display) return '<td class="session-time-cell">—</td>';
  return `<td class="session-time-cell"><details class="session-time" data-session-time="${kind}" data-session-id="${escape(sessionId)}"><summary><time datetime="${escape(display.iso)}" data-session-relative="true">${escape(display.relative)}</time></summary><time datetime="${escape(display.iso)}">${escape(display.exact)}</time></details></td>`;
};
const cookieName = "rdmcp_user";
const cookie = (header: string | undefined, name = cookieName) => header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const principalFor = (identity: GoogleIdentity) => `google:${identity.iss}:${identity.sub}`;
const jst = (value: unknown) => { const date = new Date(String(value ?? "")); return value === undefined || value === "—" || Number.isNaN(date.getTime()) ? "—" : `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(date)} JST`; };
const page = (body: string, nonce?: string) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RDMCP User Console</title><style>body{font:13px system-ui,sans-serif;background:#f4f6fa;color:#17243b;margin:0}main{max-width:1100px;margin:12px auto;padding:12px}header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header h1{font-size:15px;margin:0 auto 0 0}h2{font-size:14px;margin:0 0 8px}p{margin:7px 0}section,form{background:#fff;border:1px solid #dbe2ec;border-radius:12px;padding:20px;margin:18px 0}section.session-list{font-size:12px;border-radius:8px;padding:12px;margin:10px 0}header form,.toolbar form{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;margin:0}.session-list form.session-editor{box-sizing:border-box;display:grid;gap:8px;min-width:220px;margin:6px 0 0;padding:10px;border-radius:8px}.session-list form.session-editor label{display:grid;gap:3px;white-space:normal}.session-list form.session-editor input:not([type=hidden]){box-sizing:border-box;width:100%;min-width:0}.session-list form.session-editor output{min-height:1em}.session-list form.session-editor button{justify-self:start}.session-list form.session-editor [data-session-conflict]:not([hidden]){display:grid;gap:6px}button,select{font:inherit;padding:5px 7px}button{white-space:nowrap}#log-new-button{border:1px solid #9ab7df;background:#e8f1ff;color:#174f91;border-radius:999px;font-weight:650;box-shadow:0 1px 1px #17243b18}#log-new-button:hover{background:#dceaff}#log-new-button:focus-visible{outline:3px solid #70a5e8;outline-offset:2px}#log-new-button:disabled{opacity:.65;cursor:wait}@media(pointer:fine){#log-pull-hint{display:none}}.toolbar form{flex-wrap:wrap}article p,.session-meta{overflow-wrap:anywhere}.danger{background:#b42318;color:#fff;border:0;font-weight:700}.ok{background:#147a43;color:#fff;border:0;font-weight:700}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #dbe2ec;vertical-align:top}th{font-weight:600}.session-list th,.session-list td{padding:6px}.session-list td.session-time-cell{white-space:normal;overflow-wrap:anywhere;min-width:6em}.session-time summary:focus-visible{outline:3px solid #70a5e8;outline-offset:2px}.session-time time{overflow-wrap:anywhere}.scroll{overflow:auto}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.session-link{white-space:nowrap;font-weight:600}.process-block{border:1px solid #dbe2ec;border-radius:8px;padding:10px;margin:10px 0}.process-block h3{font-size:inherit;margin:10px 0 4px}.output-part+ .output-part{margin-top:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f7;padding:12px;border-radius:8px}.stopped{color:#b42318;font-weight:700}.running{color:#a15c00;font-weight:700}small{color:#526078}#session-todo label{display:grid;gap:5px;min-width:0;margin:8px 0}#session-todo textarea{box-sizing:border-box;width:100%;min-width:0;min-height:3.8em;max-height:12.5em;overflow-y:auto;resize:none;font:inherit;line-height:1.45;padding:8px;border:1px solid #aebbd0;border-radius:6px;white-space:pre-wrap}#session-todo li{display:grid;grid-template-columns:minmax(0,1fr);align-items:end;gap:8px;padding:10px 0;border-bottom:1px solid #dbe2ec}#session-todo li .todo-text-label{grid-column:1/-1}#session-todo .todo-controls{display:flex;align-items:center;gap:6px;width:100%;min-width:0}#session-todo .todo-controls .todo-status{display:flex;align-items:center;flex:1;min-width:0;gap:6px;margin:0}#session-todo .todo-status>span{white-space:nowrap}#session-todo .todo-controls select{box-sizing:border-box;min-width:0;flex:1;min-height:44px}#session-todo .todo-actions{display:flex;gap:4px;flex:none}#session-todo button{box-sizing:border-box;min-height:44px;padding:2px 8px;font:inherit;line-height:1.2;white-space:nowrap}#session-todo .todo-actions button{flex:none;min-width:44px;padding:2px 8px;font:inherit}#session-todo .todo-enforcement{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:7px 0}#session-todo .todo-enforcement-form{display:inline-flex;align-items:center;background:none;border:0;border-radius:0;padding:0;margin:0}#session-todo .todo-enforcement-toggle{font-size:inherit}#session-todo .todo-add{margin:10px 0}#session-todo .todo-add>summary{cursor:pointer;font-weight:600;padding:6px 0}#session-todo .todo-add>summary:focus-visible{outline:3px solid #70a5e8;outline-offset:2px}#session-todo .todo-add-form{display:grid;gap:6px}#session-todo .todo-add-form>button{justify-self:start}#session-todo [data-todo-conflict]:not([hidden]),#session-todo [data-todo-deleted-actions]:not([hidden]),#session-todo [data-todo-readd-confirm]:not([hidden]),#session-todo [data-todo-add-conflict]:not([hidden]){grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}#session-todo [data-todo-conflict] p,#session-todo [data-todo-readd-confirm] p,#session-todo [data-todo-add-conflict] p{flex-basis:100%}@media(max-width:600px){main{margin:4px auto;padding:7px}section{padding:12px;margin:10px 0}section.session-list{padding:9px;margin:7px 0}header h1{font-size:14px}h2{font-size:13px}th,td{padding:7px;white-space:nowrap}.session-list th,.session-list td{padding:5px}.session-list td.session-external-link-cell{white-space:normal;overflow-wrap:anywhere;min-width:8em}#session-todo li{grid-template-columns:minmax(0,1fr);gap:6px}#session-todo .todo-controls{display:flex;align-items:end;gap:6px;width:100%}#session-todo .todo-controls .todo-status{flex:1 1 0%;min-width:0;margin:0}#session-todo .todo-actions{width:auto;flex:none}#session-todo .todo-actions button{flex:none;padding-inline:8px}#session-todo textarea{min-height:3.8em}}</style><main>${body}</main>${nonce ? `<script nonce="${nonce}">${userConsoleClientScript}</script>` : ""}</html>`;

type Login = { principal: string; expires: number; csrf: string; email?: string; identity?: GoogleIdentity };
type Pending = { binding: string; nonce: string; expires: number };
type Budget = { attempts: number; reset: number };

export function mountUserConsole(app: Express, service: RemoteDesktopService) {
  const logins = new Map<string, Login>();
  const pending = new Map<string, Pending>();
  const loginBudgets = new Map<string, Budget>();
  const passwordBudgets = new Map<string, Budget>();
  const google = service.cfg.publicAuth;
  const verifier = google ? service.cfg.publicAuthOptions?.verifier ?? new GoogleOidcClient(google.googleClientId, google.googleClientSecret) : undefined;
  const setCookie = (res: Response, value: string, age: number, name = cookieName, cookiePath = "/user") => res.append("Set-Cookie", `${name}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${age}${service.cfg.baseUrl.startsWith("https:") ? "; Secure" : ""}`);
  // The console's read-only HTTP and SSE APIs live under /api, so the login
  // cookie must be sent there as well as to the rendered /user pages.
  const setLoginCookie = (res: Response, value: string, age: number) => { setCookie(res, value, age, cookieName, "/"); setCookie(res, "", 0, cookieName, "/user"); };
  const clean = () => { const now = Date.now(); for (const [key, value] of logins) if (value.expires <= now) logins.delete(key); for (const [key, value] of pending) if (value.expires <= now) pending.delete(key); for (const [key, value] of loginBudgets) if (value.reset <= now) loginBudgets.delete(key); for (const [key, value] of passwordBudgets) if (value.reset <= now) passwordBudgets.delete(key); };
  const remember = <T>(map: Map<string, T>, key: string, value: T, maximum: number) => { map.delete(key); while (map.size >= maximum) map.delete(map.keys().next().value!); map.set(key, value); };
  const consume = (map: Map<string, Budget>, key: string) => { const now = Date.now(); const prior = map.get(key); const budget = !prior || prior.reset <= now ? { attempts: 1, reset: now + 60_000 } : { ...prior, attempts: prior.attempts + 1 }; remember(map, key, budget, 2_000); return budget.attempts <= 10; };
  const constantTimeEqual = (left: string, right: string) => { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
  const loginAllowed = async (login: Login) => login.identity
    ? Boolean(await service.publicAuth?.isAllowedIdentity(login.identity))
    : Boolean(login.email && login.principal === login.email && service.cfg.users.some((entry) => entry.email === login.email));
  const newLogin = (principal: string, extra: { email?: string; identity?: GoogleIdentity } = {}) => ({ principal, expires: Date.now() + 3600_000, csrf: id(), ...extra });
  const passwordPrincipal = async (req: Request): Promise<string | undefined> => {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const user = service.cfg.users.find((entry) => entry.email === email);
    return user && typeof req.body?.password === "string" && await verifyPassword(req.body.password, user.passwordHash) ? user.email : undefined;
  };
  const current = (req: Request) => logins.get(cookie(req.header("cookie")) ?? "");
  const requireCsrf = (req: Request, res: Response): boolean => {
    const login = current(req);
    const supplied = typeof req.body?.csrf === "string" ? req.body.csrf : req.header("x-csrf-token") ?? "";
    if (req.header("origin") === new URL(service.cfg.baseUrl).origin && login && constantTimeEqual(supplied, login.csrf)) return true;
    res.sendStatus(403); return false;
  };

  app.use("/user", (_req, res, next) => { const nonce = id(); res.locals.userNonce = nonce; res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'${google ? " https://accounts.google.com" : ""}; frame-ancestors 'none'; base-uri 'none'`); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("X-Content-Type-Options", "nosniff"); clean(); next(); });
  app.get("/user/login", (_req, res) => res.type("html").send(page(`<h1>RDMCP User Console</h1>${google ? '<form method="post" action="/user/login"><button>Google でログイン</button></form>' : '<form method="post" action="/user/login"><label>メールアドレス <input name="email" type="email" required autocomplete="username"></label><label>パスワード <input name="password" type="password" required autocomplete="current-password"></label><button>ログイン</button></form>'}`)));
  app.post("/user/login", async (req, res) => {
    if (req.header("origin") !== new URL(service.cfg.baseUrl).origin) return res.sendStatus(403);
    const offeredBudget = cookie(req.header("cookie"), "rdmcp_user_login_budget");
    const browserKey = offeredBudget && loginBudgets.has(offeredBudget) ? offeredBudget : id();
    const loginPermitted = consume(loginBudgets, browserKey);
    setCookie(res, browserKey, 60, "rdmcp_user_login_budget");
    if (!loginPermitted) return res.sendStatus(429);
    if (google && verifier) {
      const state = `user_${id()}`; const binding = id(); const nonce = id();
      if (pending.size >= 1_000) return res.sendStatus(429);
      pending.set(state, { binding, nonce, expires: Date.now() + 300_000 }); setCookie(res, binding, 300, "rdmcp_user_google_binding", "/");
      return res.redirect(303, verifier.authorizationUrl({ redirectUri: google.googleRedirectUri, state, nonce }));
    }
    const email = typeof req.body?.email === "string" ? req.body.email.slice(0, 320) : "";
    if (!consume(passwordBudgets, `ip:${req.socket.remoteAddress ?? "unknown"}`) || !consume(passwordBudgets, `account:${email}`)) return res.sendStatus(429);
    const principal = await passwordPrincipal(req);
    if (!principal) return res.status(403).type("html").send(page('<p>ログインできません。</p><a href="/user/login">再試行</a>'));
    const token = id(); remember(logins, token, newLogin(principal, { email: principal }), 2_000); setLoginCookie(res, token, 3600); return res.redirect(303, "/user");
  });
  app.get("/google/callback", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Content-Type-Options", "nosniff");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state.startsWith("user_")) return next();
    clean();
    const flow = pending.get(state);
    if (!flow || flow.expires <= Date.now() || flow.binding !== cookie(req.header("cookie"), "rdmcp_user_google_binding") || !google || !verifier || typeof req.query.code !== "string" || req.query.error) return res.status(403).send("ログインできません。");
    pending.delete(state);
    try {
      const identity = await verifier.exchangeCode({ code: req.query.code, state, nonce: flow.nonce, redirectUri: google.googleRedirectUri });
      if (!await service.publicAuth?.isAllowedIdentity(identity)) return res.status(403).send("ログインできません。");
      const token = id(); remember(logins, token, newLogin(principalFor(identity), { identity }), 2_000); setLoginCookie(res, token, 3600); setCookie(res, "", 0, "rdmcp_user_google_binding", "/"); return res.redirect(303, "/user");
    } catch { return res.status(403).send("ログインできません。"); }
  });
  const userLogin = async (req: Request): Promise<Login | undefined> => {
    const login = current(req);
    if (!login || login.expires <= Date.now() || !await loginAllowed(login)) return undefined;
    return login;
  };
  app.use("/api", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); clean();
    const login = await userLogin(req);
    if (!login) return res.status(401).json({ error: "unauthorized" });
    res.locals.principal = login.principal; res.locals.login = login; next();
  });
  const apiSession = (req: Request, res: Response): string | undefined => {
    if (req.query.session_id !== undefined && typeof req.query.session_id !== "string") { res.status(400).json({ error: "invalid_request" }); return undefined; }
    const value = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
    if (value !== undefined && (!value || !service.userOwnsAuditSession(res.locals.principal as string, value))) { res.sendStatus(404); return undefined; }
    return value;
  };
  app.patch("/api/sessions/:sessionId", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    const result = await service.updateSessionMetadata(res.locals.principal as string, req.params.sessionId!, req.body);
    if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.currentVersion === undefined ? {} : { currentVersion: result.currentVersion }) });
    return res.json({ session_id: result.session_id, working_directory: result.working_directory, purpose: result.purpose, external_url: result.external_url ?? null, external_title: result.external_title ?? null, external_title_source: result.external_title_source ?? null, external_title_status: result.external_title_status, version: result.version, changedFields: result.changedFields });
  });
  app.get("/api/sessions/:sessionId/todo", async (req, res) => {
    const principal = res.locals.principal as string;
    if (!service.userOwnsActiveSession(principal, req.params.sessionId)) return res.sendStatus(404);
    try { return res.json(await service.todoGet(principal, req.params.sessionId)); }
    catch { return res.sendStatus(404); }
  });
  app.put("/api/sessions/:sessionId/todo", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    const principal = res.locals.principal as string;
    if (!service.userOwnsActiveSession(principal, req.params.sessionId)) return res.sendStatus(404);
    if (!Number.isInteger(req.body?.expected_version) || req.body.expected_version < 0 || !Array.isArray(req.body?.changes)) return res.status(400).json({ error: "invalid_request" });
    try {
      const result = await service.todoUpdate(principal, req.params.sessionId, req.body.expected_version, req.body.changes);
      return res.status("conflict" in result && result.conflict ? 409 : 200).json(result);
    } catch { return res.status(400).json({ error: "invalid_request" }); }
  });
  app.put("/api/sessions/:sessionId/todo/enforcement", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    const principal = res.locals.principal as string;
    if (!service.userOwnsActiveSession(principal, req.params.sessionId)) return res.sendStatus(404);
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "invalid_request" });
    try { return res.json(await service.todoSetEnforcement(principal, req.params.sessionId, req.body.enabled)); }
    catch { return res.status(404).json({ error: "session_unavailable" }); }
  });
  app.get("/api/logs", async (req, res) => {
    if ((req.query.limit !== undefined && typeof req.query.limit !== "string") || (req.query.before !== undefined && typeof req.query.before !== "string") || (req.query.after !== undefined && typeof req.query.after !== "string")) return res.status(400).json({ error: "invalid_request" });
    const supplied = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
    if (!Number.isInteger(supplied) || supplied < 1 || supplied > 200) return res.status(400).json({ error: "invalid_request" });
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    if (before !== undefined && after !== undefined) return res.status(400).json({ error: "invalid_request" });
    await service.refreshAuditIndex();
    const sessionId = apiSession(req, res); if (res.headersSent) return;
    try { return res.json(service.getUserAuditPage(res.locals.principal as string, sessionId, { limit: supplied, before, after })); }
    catch (error) { return res.status(error instanceof Error && error.message === "Log cursor expired." ? 409 : 400).json({ error: error instanceof Error && error.message === "Log cursor expired." ? "cursor_expired" : "invalid_cursor" }); }
  });
  app.get("/api/console-state", async (req, res) => {
    const principal = res.locals.principal as string;
    await service.refreshAuditIndex();
    const sessionId = apiSession(req, res); if (res.headersSent) return;
    const { sessions: allSessions } = await readSessionLogs(service);
    const activeLive = [...service.sessions.values()].filter((session) => session.user === principal && session.state === "active" && session.expires > Date.now());
    const activeIds = new Set(activeLive.map((session) => session.id));
    const liveById = new Map(activeLive.map((session) => [session.id, session]));
    const sessions = allSessions.filter((session) => session.user === principal && !session.id.startsWith("request:")).map((session) => ({
      session_id: session.id,
      working_directory: session.workingDirectory ?? null,
      purpose: session.purpose ?? null,
      created_at: session.at,
      last_used_at: session.lastAccessAt ?? session.at,
      state: activeIds.has(session.id) ? "active" : session.state,
      active: activeIds.has(session.id),
      ...(liveById.has(session.id) ? { version: liveById.get(session.id)!.version, external_url: liveById.get(session.id)!.externalUrl ?? null, external_title: liveById.get(session.id)!.externalTitle ?? null, external_title_source: liveById.get(session.id)!.externalTitleSource ?? null, external_title_status: liveById.get(session.id)!.externalTitleStatus } : {}),
    }));
    const operationEvents = allSessions.filter((session) => session.user === principal && (sessionId === undefined || session.id === sessionId)).flatMap((session) => session.events.map((event) => ({ session, event })))
      .filter(({ event }) => ["operation.received", "operation.started", "operation.succeeded", "operation.failed", "operation.cancelled", "operation.rejected"].includes(event.event))
      .sort((left, right) => Date.parse(left.event.at) - Date.parse(right.event.at));
    const operationMap = new Map<string, { sessionId: string; event: Record<string, unknown> & { event: string; at: string } }>();
    for (const currentEvent of operationEvents) {
      const key = String(currentEvent.event.operationId ?? `${currentEvent.session.id}:${currentEvent.event.at}:${currentEvent.event.event}`);
      const previous = operationMap.get(key);
      operationMap.set(key, { sessionId: currentEvent.session.id, event: { ...(previous?.event ?? {}), ...currentEvent.event, receivedAt: previous?.event.receivedAt ?? currentEvent.event.receivedAt ?? currentEvent.event.at, startAt: currentEvent.event.startAt ?? previous?.event.startAt, endedAt: currentEvent.event.endedAt ?? previous?.event.endedAt, durationMs: currentEvent.event.durationMs ?? previous?.event.durationMs, connectionId: currentEvent.event.connectionId ?? previous?.event.connectionId } });
    }
    const processMetadata = new Map<string, { purpose: string; command: string }>();
    for (const session of allSessions.filter((entry) => entry.user === principal && (sessionId === undefined || entry.id === sessionId))) {
      for (const event of session.events) {
        if (event.event !== "process.start" || typeof event.processId !== "string") continue;
        processMetadata.set(`${session.id}:${event.processId}`, {
          purpose: typeof event.comment === "string" ? event.comment : "",
          command: typeof event.command === "string" ? event.command : "",
        });
      }
    }
    const running = [
      ...[...operationMap.entries()].flatMap(([operationId, operation]) => {
        const status = typeof operation.event.status === "string" ? operation.event.status : operation.event.event.startsWith("operation.") && !["operation.received", "operation.started"].includes(operation.event.event) ? operation.event.event.slice("operation.".length) : "running";
        return status === "running" ? [{ operation_id: operationId, connection_id: String(operation.event.connectionId ?? operation.sessionId), label: String(operation.event.tool ?? "operation"), status }] : [];
      }),
      ...[...service.processes.values()].filter((process) => process.user === principal && (sessionId === undefined || process.sessionId === sessionId) && (process.state === "running" || process.state === "terminating")).map((process) => ({ operation_id: process.id, connection_id: process.sessionId, label: "process", status: process.state, purpose: processMetadata.get(`${process.sessionId}:${process.id}`)?.purpose ?? "", command: processMetadata.get(`${process.sessionId}:${process.id}`)?.command ?? "", termination_unconfirmed: process.terminationUnconfirmed || undefined })),
    ];
    const state = service.userExecutionState(principal);
    return res.json({ stopped: state.stopped, activeSessions: activeLive.length, runningProcesses: running.length, sessions, running, updatedAt: new Date().toISOString() });
  });
  app.get("/api/events", async (req, res) => {
    if ((req.header("content-length") !== undefined && req.header("content-length") !== "0") || req.header("transfer-encoding") !== undefined) return res.status(400).json({ error: "invalid_request" });
    if (req.query.after !== undefined && typeof req.query.after !== "string") return res.status(400).json({ error: "invalid_request" });
    const after = typeof req.query.after === "string" ? req.query.after : undefined;
    await service.refreshAuditIndex();
    const sessionId = apiSession(req, res); if (res.headersSent) return;
    const principal = res.locals.principal as string;
    let initialCursorExpired = false;
    try { service.countNewUserAuditEvents(principal, sessionId, after); }
    catch (error) {
      if (error instanceof Error && error.message === "Log cursor expired.") initialCursorExpired = true;
      else return res.status(400).json({ error: "invalid_cursor" });
    }
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let closed = false; let timer: NodeJS.Timeout | undefined; let notifiedAfter = after;
    const send = (name: string, data: Record<string, unknown> = {}) => { if (!closed && !res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) close(); };
    const notify = (event: Record<string, unknown>) => {
      if (!service.userCanViewAuditEvent(principal, sessionId, event)) return;
      if (timer || closed) return;
      timer = setTimeout(async () => {
        timer = undefined;
        try { await service.refreshAuditIndex(); const count = service.countNewUserAuditEvents(principal, sessionId, notifiedAfter); notifiedAfter = count.latestCursor; send("logs-available", { addedCount: count.count, latestCursor: count.latestCursor, overflow: count.overflow }); }
        catch { send("resync-required"); close(); }
      }, 150);
    };
    const unsubscribe = service.subscribeAudit(notify);
    const unsubscribeLinks = service.subscribeSessionLink((owner, changedSessionId) => {
      if (owner !== principal || (sessionId !== undefined && sessionId !== changedSessionId) || !service.userOwnsActiveSession(owner, changedSessionId)) return;
      void userLogin(req).then((login) => { if (login?.principal === owner && service.userOwnsActiveSession(owner, changedSessionId)) send("session-link-updated", { session_id: changedSessionId }); }).catch(() => undefined);
    });
    const heartbeat = setInterval(async () => {
      try {
        const login = await userLogin(req);
        if (!login || login.principal !== principal) { send("auth-expired"); close(); return; }
        await service.refreshAuditIndex(); service.countNewUserAuditEvents(principal, sessionId, notifiedAfter); send("heartbeat");
      }
      catch { send("resync-required"); close(); }
    }, 20_000);
    const close = () => { if (closed) return; closed = true; if (timer) clearTimeout(timer); clearInterval(heartbeat); unsubscribe(); unsubscribeLinks(); unregisterClose(); res.end(); };
    const unregisterClose = service.subscribeAuditConnection(close);
    try {
      if (initialCursorExpired) { send("resync-required"); close(); return; }
      const count = service.countNewUserAuditEvents(principal, sessionId, notifiedAfter); notifiedAfter = count.latestCursor; send("logs-available", { addedCount: count.count, latestCursor: count.latestCursor, overflow: count.overflow });
    }
    catch { send("resync-required"); close(); return; }
    // IncomingMessage `close` can describe request completion rather than a
    // cancelled long-lived response. Tie SSE teardown to the response socket
    // itself so a normal heartbeat does not terminate the EventSource.
    res.on("close", close);
  });
  app.use("/user", async (req, res, next) => { const login = await userLogin(req); if (!login) return res.redirect(303, "/user/login"); setLoginCookie(res, cookie(req.header("cookie")) ?? "", Math.max(0, Math.floor((login.expires - Date.now()) / 1000))); res.locals.principal = login.principal; res.locals.csrf = login.csrf; next(); });
  app.post("/user/logout", (req, res) => { if (!requireCsrf(req, res)) return; logins.delete(cookie(req.header("cookie")) ?? ""); setLoginCookie(res, "", 0); setCookie(res, "", 0, cookieName, "/user"); return res.redirect(303, "/user/login"); });
  app.post("/user/emergency-stop", async (req, res) => { if (!requireCsrf(req, res)) return; const state = await service.stopUserExecution(res.locals.principal as string).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "停止状態を保存できませんでした。" })); if ("error" in state) return res.status(503).type("html").send(page(`<p class="stopped">${escape(state.error)}</p>`)); return res.redirect(303, "/user"); });
  app.post("/user/resume", async (req, res) => { if (!requireCsrf(req, res)) return; const state = await service.resumeUserExecution(res.locals.principal as string).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "再開できませんでした。" })); if ("error" in state) return res.status(503).type("html").send(page(`<p class="stopped">${escape(state.error)}</p>`)); return res.redirect(303, "/user"); });
  app.post("/user/sessions/:sessionId/todo", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    const principal = res.locals.principal as string; const sessionId = req.params.sessionId;
    if (!service.userOwnsActiveSession(principal, sessionId)) return res.sendStatus(404);
    const expectedVersion = Number(req.body?.expected_version); if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) return res.sendStatus(400);
    let changes: Array<Record<string, unknown>>;
    if (req.body?.op === "add") changes = [{ op: "add", text: req.body.text }];
    else if (req.body?.op === "delete") changes = [{ op: "delete", id: req.body.id }];
    else if (req.body?.op === "edit") changes = [{ op: "edit", id: req.body.id, text: req.body.text }, { op: "status", id: req.body.id, status: req.body.status }];
    else return res.sendStatus(400);
    try { const result = await service.todoUpdate(principal, sessionId, expectedVersion, changes); const suffix = "conflict" in result && result.conflict ? "?todo=conflict" : "audit_warning" in result && result.audit_warning ? "?todo=audit" : ""; return res.redirect(303, `/user/sessions/${encodeURIComponent(sessionId)}${suffix}`); }
    catch { return res.redirect(303, `/user/sessions/${encodeURIComponent(sessionId)}?todo=error`); }
  });
  app.post("/user/sessions/:sessionId/todo/enforcement", async (req, res) => {
    if (!requireCsrf(req, res)) return;
    const principal = res.locals.principal as string; const sessionId = req.params.sessionId;
    if (!service.userOwnsActiveSession(principal, sessionId)) return res.sendStatus(404);
    if (req.body?.enabled !== "true" && req.body?.enabled !== "false") return res.sendStatus(400);
    try { const result = await service.todoSetEnforcement(principal, sessionId, req.body.enabled === "true"); return res.redirect(303, `/user/sessions/${encodeURIComponent(sessionId)}${result.audit_warning ? "?todo=audit" : ""}`); }
    catch { return res.redirect(303, `/user/sessions/${encodeURIComponent(sessionId)}?todo=error`); }
  });
  app.get(["/user", "/user/", "/user/sessions/:sessionId"], async (req, res) => {
    const principal = res.locals.principal as string;
    await service.refreshAuditIndex();
    const requestedFilter = typeof req.query.filter === "string" ? req.query.filter : undefined;
    const savedFilter = cookie(req.header("cookie"), "rdmcp_user_filter");
    const filter = requestedFilter === "active" || requestedFilter === "all" ? requestedFilter : savedFilter === "active" ? "active" : "all";
    if (requestedFilter === "active" || requestedFilter === "all") setCookie(res, filter, 365 * 24 * 3600, "rdmcp_user_filter");
    const state = service.userExecutionState(principal);
    const { sessions, stopWarnings } = await readSessionLogs(service);
    const own = sessions.filter((session) => session.user === principal);
    const listedSessions = own.filter((session) => !session.id.startsWith("request:"));
    const unassignedOperations = own.filter((session) => session.id.startsWith("request:"));
    const requestedSession = req.params.sessionId;
    const selectedSession = requestedSession === undefined ? undefined : own.find((session) => session.id === requestedSession);
    if (requestedSession !== undefined && !selectedSession) return res.sendStatus(404);
    const initialLogPage = service.getUserAuditPage(principal, selectedSession?.id, { limit: 200 });
    const visibleSessions = selectedSession ? [selectedSession] : own;
    const stoppedAt = Date.parse(String(state.stoppedAt ?? ""));
    const currentStopWarnings = state.stopped ? stopWarnings.filter((warning) => warning.user === principal && Date.parse(warning.at) >= stoppedAt && (!warning.stopId || warning.stopId === state.stopId)) : [];
    const running = [...service.processes.values()].filter((process) => process.user === principal && (!selectedSession || process.sessionId === selectedSession.id) && (process.state === "running" || process.state === "terminating"));
    const activeSessions = [...service.sessions.values()].filter((session) => session.user === principal && session.state === "active" && session.expires > Date.now());
    const activeIds = new Set(activeSessions.map((session) => session.id));
    const activeById = new Map(activeSessions.map((session) => [session.id, session]));
    const shownSessions = filter === "active" ? listedSessions.filter((session) => activeIds.has(session.id)) : listedSessions;
    const operationEvents = visibleSessions.flatMap((session) => session.events.map((event) => ({ session, event })))
      .filter(({ event }) => event.user === principal && ["operation.received", "operation.started", "operation.succeeded", "operation.failed", "operation.cancelled", "operation.rejected"].includes(event.event))
      .sort((left, right) => Date.parse(left.event.at) - Date.parse(right.event.at));
    const operationMap = new Map<string, { session: typeof own[number]; event: Record<string, unknown> & { event: string; at: string } }>();
    for (const currentEvent of operationEvents) {
      const key = String(currentEvent.event.operationId ?? `${currentEvent.session.id}:${currentEvent.event.at}:${currentEvent.event.event}`);
      const previous = operationMap.get(key);
      operationMap.set(key, { session: currentEvent.session, event: { ...(previous?.event ?? {}), ...currentEvent.event, receivedAt: previous?.event.receivedAt ?? currentEvent.event.receivedAt ?? currentEvent.event.at, startAt: currentEvent.event.startAt ?? previous?.event.startAt, endedAt: currentEvent.event.endedAt ?? previous?.event.endedAt, durationMs: currentEvent.event.durationMs ?? previous?.event.durationMs, connectionId: currentEvent.event.connectionId ?? previous?.event.connectionId } });
    }
    const operations = [...operationMap.values()].map(({ session, event }) => {
      const status = typeof event.status === "string" ? event.status : event.event.startsWith("operation.") && !["operation.received", "operation.started"].includes(event.event) ? event.event.slice("operation.".length) : "running";
      return { session, event, status };
    }).sort((left, right) => Date.parse(String(right.event.receivedAt ?? right.event.at)) - Date.parse(String(left.event.receivedAt ?? left.event.at))).slice(0, 200);
    const runningOperations = operations.filter((operation) => operation.status === "running");
    const csrf = escape(res.locals.csrf);
    const liveSession = selectedSession ? service.sessions.get(selectedSession.id) : undefined;
    const todoState = liveSession?.todo;
    const todoAction = selectedSession ? `/user/sessions/${encodeURIComponent(selectedSession.id)}/todo` : "";
    const todoLabels = { not_started: "未着手", in_progress: "進行中", completed: "完了" };
    const todoNotice = req.query.todo === "conflict" ? "別の更新があります。最新内容を確認してから操作してください。" : req.query.todo === "audit" ? "監査記録に警告があります。表示された内容が適用済みか確認してください。" : req.query.todo === "error" ? "作業一覧を更新できませんでした。内容を再読み込みしてください。" : "";
    const todoPanel = selectedSession ? `<section id="session-todo" data-session-id="${escape(selectedSession.id)}" data-version="${todoState?.version ?? 0}" data-csrf="${csrf}" data-active="${liveSession?.state === "active"}"><h2 tabindex="-1">作業一覧</h2>${todoNotice ? `<p role="status">${escape(todoNotice)}</p>` : ""}${todoState ? `<p data-todo-summary><span data-todo-summary-count>進捗: ${todoState.items.filter((item) => item.status === "completed").length} / ${todoState.items.length}</span> · 最終更新: <time data-todo-updated>${escape(todoState.lastUpdatedAt ?? "未更新")}</time></p><div class="todo-enforcement"><span class="todo-enforcement-label">強制機能: <span data-todo-enforcement-state>${todoState.enabled ? "有効" : "無効"}</span></span>${liveSession?.state === "active" ? `<form class="todo-enforcement-form" method="post" action="${todoAction}/enforcement"><input type="hidden" name="csrf" value="${csrf}"><button class="todo-enforcement-toggle" data-todo-enforcement name="enabled" value="${todoState.enabled ? "false" : "true"}">${todoState.enabled ? "強制を無効にする" : "強制を有効にする"}</button></form>` : ""}</div><p data-todo-status-message role="status" aria-live="polite"></p><ul data-todo-items>${todoState.items.map((item) => `<li data-todo-id="${escape(item.id)}" data-base-text="${escape(item.text)}" data-base-status="${escape(item.status)}" data-base-version="${todoState.version}"><label class="todo-text-label"><span>作業項目</span><textarea rows="2" data-todo-text="true" maxlength="1000" aria-label="作業項目"${liveSession?.state === "active" ? "" : " disabled"}>${escape(item.text)}</textarea></label><div class="todo-controls"><label class="todo-status"><span>状態</span><select data-todo-status="true" aria-label="状態"${liveSession?.state === "active" ? "" : " disabled"}>${Object.entries(todoLabels).map(([value, label]) => `<option value="${value}"${item.status === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>${liveSession?.state === "active" ? `<div class="todo-actions"><button type="button" data-todo-op="save">更新</button><button type="button" data-todo-op="delete">削除</button></div>` : ""}</div><div data-todo-conflict hidden><p>最新の共有内容</p><p>最新の本文: <span data-todo-latest-text></span></p><p data-todo-latest-status></p><button type="button" data-todo-op="use-latest">最新を使う</button><button type="button" data-todo-op="keep-draft">入力を残して再編集</button></div><div data-todo-deleted-notice hidden></div><div data-todo-deleted-actions hidden><button type="button" data-todo-op="discard-deleted">入力を捨てる</button><button type="button" data-todo-op="readd-deleted">新しい項目として編集</button></div><div data-todo-readd-confirm hidden><p>追加欄の入力を置き換えますか？</p><button type="button" data-todo-op="replace-add-draft">追加欄を置き換える</button><button type="button" data-todo-op="keep-add-draft">追加欄を保つ</button></div></li>`).join("")}</ul>${liveSession?.state === "active" ? `<details class="todo-add" data-todo-add-details><summary>作業を追加</summary><div class="todo-add-form"><label><span>追加内容</span><textarea rows="2" data-todo-add-text="true" maxlength="1000" aria-label="作業を追加"></textarea></label><button type="button" data-todo-op="add">追加</button><div data-todo-add-conflict hidden><p data-todo-add-latest></p><button type="button" data-todo-op="use-latest-add">最新を使う</button><button type="button" data-todo-op="keep-draft-add">入力を残して追加</button></div></div></details>` : ""}` : `<p>このセッションの作業一覧はありません。</p>`}</section>` : "";
    const stopWarningLabels: Record<string, string> = { "process.owner_stop_unconfirmed": "停止担当機能から終了確認応答がありません。", "process.owner_stop_failed": "プロセスへの停止要求に失敗しました。", "process.stop_unconfirmed": "プロセスの終了を確認できませんでした。", "process.stop_unconfirmed_after_start": "停止中に開始したプロセスの終了を確認できませんでした。", "process.stop_requested_after_start": "停止中に返されたプロセス ID に停止要求を行いました。", "user.stop_marker_failed": "停止状態の復旧マーカーを保存できませんでした。", "user.stop_persistence_failed": "停止状態を保存できませんでした。" };
    const warningRows = currentStopWarnings.map((warning) => `<li>${escape(stopWarningLabels[warning.event] ?? "停止処理に未確認の結果があります。")}${warning.pid ? ` PID ${escape(warning.pid)}` : ""}</li>`).join("");
    let body = `<header><h1>RDMCP User Console</h1><span id="execution-state" class="${state.stopped ? "stopped" : ""}">${state.stopped ? "STOPPED" : "READY"}</span><span id="log-status">接続中</span><small id="state-updated-at">${jst(new Date().toISOString())}</small>${state.stopped ? `<form method="post" action="/user/emergency-stop"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">停止を再試行</button></form><form method="post" action="/user/resume"><input type="hidden" name="csrf" value="${csrf}"><button class="ok">実行を再開</button></form>` : `<form method="post" action="/user/emergency-stop"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">EMERGENCY STOP / 全実行停止</button></form>`}<form method="post" action="/user/logout"><input type="hidden" name="csrf" value="${csrf}"><button>ログアウト</button></form></header>`;
    const logControls = `<div id="log-console" class="toolbar" data-session-id="${escape(selectedSession?.id ?? "")}" data-newest-cursor="${escape(initialLogPage.newestCursor)}" data-oldest-cursor="${escape(initialLogPage.oldestCursor)}" data-has-more-older="${initialLogPage.hasMoreOlder}" data-filter="${filter}" data-csrf="${escape(csrf)}" data-initial-items="${escape(JSON.stringify(selectedSession ? initialLogPage.items : []))}"><button id="log-new-button" type="button">↻ 更新（新着 0件）</button><button id="log-older-button" type="button"${initialLogPage.hasMoreOlder ? "" : " hidden"}>過去のログを読み込む</button>${selectedSession && initialLogPage.items.some((item) => ["process.start", "process.output", "process.exit"].includes(String(item.event.event))) ? `<small id="log-pull-hint">下へ引いて更新</small>` : ""}</div>`;
    const stopDetails = `<section><details${warningRows ? " open" : ""}><summary>実行状態の詳細</summary><p>Stop generation: ${state.stopGeneration}</p>${state.stopped ? `<p>Stopped at: ${jst(state.stoppedAt)}<br><span style="overflow-wrap:anywhere">Stop ID: ${escape(state.stopId)}</span></p><p class="stopped">停止状態は新しい実行を遮断します。既存プロセスの終了確認は別に行います。</p>${warningRows ? `<p class="stopped">この停止要求で終了を確認できなかった処理:</p><ul>${warningRows}</ul>` : ""}<p>停止要求を再試行して、応答を確認できなかったプロセスや開始処理中のプロセスを再走査できます。</p>` : ""}<p><small>終了を確認できていない処理が残る場合があります。停止中は停止要求を再試行できます。停止後は再開しても以前の接続を再利用できません。</small></p></details></section>`;
    if (!selectedSession) {
      body += `${logControls}<section class="toolbar"><label><input type="checkbox" id="auto-refresh" checked> 自動更新</label><small>自動更新を停止中は新しい情報を自動反映しません。手動更新（↻ 更新）を使用してください。</small></section><section class="session-list"><div class="toolbar"><h2>セッション一覧</h2><span>有効な接続: <span id="active-session-count">${activeSessions.length}</span> · 現在実行中の操作: <span id="running-count">${runningOperations.length + running.length}</span></span><form method="get" action="/user"><label>表示 <select name="filter"><option value="all"${filter === "all" ? " selected" : ""}>すべて</option><option value="active"${filter === "active" ? " selected" : ""}>有効のみ</option></select></label><button>適用</button></form></div><div class="scroll"><table><thead><tr><th>内容</th><th>作成日時</th><th>最終アクセス日時</th><th>状態</th><th>用途</th><th>Connection ID</th><th>作業ディレクトリ</th><th>リンク</th><th>編集</th></tr></thead><tbody id="session-rows">${shownSessions.length ? shownSessions.map((session) => {
        const live = activeById.get(session.id);
        const editor = live && !state.stopped ? `<details><summary>編集</summary><form class="session-editor" data-session-edit="${escape(session.id)}" data-version="${live.version}"><input type="hidden" name="csrf" value="${csrf}"><label>作業ディレクトリ <input name="workingDirectory" required maxlength="4096" value="${escape(live.workingDirectory)}"></label><label>用途 <input name="purpose" required maxlength="200" value="${escape(live.purpose)}"></label><label>URL <input name="externalUrl" type="url" maxlength="2048" value="${escape(live.externalUrl ?? "")}"></label><label>題名 <input name="externalTitle" maxlength="200" value="${escape(live.externalTitle ?? "")}"></label><button type="submit">保存</button><output aria-live="polite"></output><div data-session-conflict hidden><p data-session-conflict-summary></p><button type="button" data-session-conflict-action="keep-draft">自分の入力で再編集</button><button type="button" data-session-conflict-action="use-latest">最新値を取り込む</button></div></form><small>変更は保存後に開始するプロセスから適用されます。</small></details>` : "—";
        return `<tr data-session-id="${escape(session.id)}"><td><a class="session-link" href="/user/sessions/${encodeURIComponent(session.id)}">詳細を見る</a></td>${sessionTimeHtml(session.at, session.id, "created")}${sessionTimeHtml(session.lastAccessAt ?? session.at, session.id, "last-access")}<td data-session-state>${escape(activeIds.has(session.id) ? "有効" : session.state === "closed" ? "終了" : "履歴")}</td><td data-session-purpose style="overflow-wrap:anywhere">${escape(session.purpose ?? "—")}</td><td style="overflow-wrap:anywhere">${escape(session.id)}</td><td data-session-directory style="overflow-wrap:anywhere">${escape(session.workingDirectory ?? "—")}</td><td class="session-external-link-cell" data-session-external-link>${externalLinkMarkup(live)}</td><td>${editor}</td></tr>`;
      }).join("") : `<tr><td colspan="9">${filter === "active" ? "有効なセッションはありません。" : "表示できるセッションはありません。"}</td></tr>`}</tbody></table></div></section>`;
      if (unassignedOperations.length) body += `<section><h2>セッション外の操作</h2><ul>${unassignedOperations.map((session) => `<li>${jst(session.at)} · <a href="/user/sessions/${encodeURIComponent(session.id)}">${escape(session.id)}</a></li>`).join("")}</ul></section>`;
      return res.type("html").send(page(body + stopDetails, res.locals.userNonce));
    }
    body += `${todoPanel}<section><div class="toolbar"><h2>${selectedSession.id.startsWith("request:") ? "セッション外の操作" : "セッションの内容"}</h2><a href="/user">一覧に戻る</a></div><p class="session-meta">Connection ID: ${escape(selectedSession.id)}<br>作成日時: ${jst(selectedSession.at)}<br>最終アクセス日時: ${jst(selectedSession.lastAccessAt ?? selectedSession.at)}<br>作業ディレクトリ: ${escape(selectedSession.workingDirectory ?? "—")}<br>用途: ${escape(selectedSession.purpose ?? "—")}</p></section>`;
    const processMetadata = new Map<string, { purpose: string; command: string }>();
    for (const session of visibleSessions) for (const event of session.events) {
      if (event.event === "process.start" && typeof event.processId === "string") processMetadata.set(`${session.id}:${event.processId}`, { purpose: typeof event.comment === "string" ? event.comment : "", command: typeof event.command === "string" ? event.command : "" });
    }
    const runningRows = [
      ...runningOperations.map(({ session, event }) => ({ operationId: String(event.operationId ?? "—"), connectionId: String(event.connectionId ?? session.id), label: String(event.tool ?? "operation"), status: "running", process: false, purpose: "", command: "" })),
      ...running.map((process) => ({ operationId: process.id, connectionId: process.sessionId, label: "process", status: `${process.state}${process.terminationUnconfirmed ? " (termination unconfirmed)" : ""}`, process: true, ...(processMetadata.get(`${process.sessionId}:${process.id}`) ?? { purpose: "", command: "" }) })),
    ];
    const processAnchorId = (session: string, process: string) => `process-${encodeURIComponent(session)}-${encodeURIComponent(process)}`;
    body += `<section><h2>Running operations</h2><div id="running-table" class="scroll"${runningRows.length ? "" : " hidden"}><table><thead><tr><th>Operation ID</th><th>Connection ID</th><th>Tool / 状態</th><th>実行目的</th><th>コマンド</th><th>詳細</th></tr></thead><tbody id="running-rows">${runningRows.map((item) => `<tr><td style="overflow-wrap:anywhere">${escape(item.operationId)}</td><td style="overflow-wrap:anywhere">${escape(item.connectionId)}</td><td class="running">${escape(item.label)} · ${escape(item.status)}</td><td style="overflow-wrap:anywhere">${escape(item.process ? item.purpose || "未記録" : "—")}</td><td style="overflow-wrap:anywhere">${escape(item.process ? item.command || "未記録" : "—")}</td><td>${item.process ? `<a href="#${escape(processAnchorId(item.connectionId, item.operationId))}" data-session-id="${escape(item.connectionId)}" data-process-id="${escape(item.operationId)}">詳細へ</a>` : "—"}</td></tr>`).join("")}</tbody></table></div><p id="running-empty"${runningRows.length ? " hidden" : ""}>実行中の操作はありません。</p></section>`;
    const opRows = operations.map(({ session, event, status }) => {
      const tool = String(event.tool ?? "—");
      const receivedAt = String(event.receivedAt ?? event.at);
      const started = typeof event.startAt === "string" ? event.startAt : "—";
      const ended = typeof event.endedAt === "string" ? event.endedAt : "—";
      const target = typeof event.target === "string" ? event.target : "—";
      const operationId = String(event.operationId ?? "—");
      const connectionId = String(event.connectionId ?? session.id ?? "—");
      return `<tr data-operation-id="${escape(operationId)}" data-connection-id="${escape(connectionId)}" data-event-json="${escape(JSON.stringify(event))}"><td>${jst(receivedAt)}</td><td style="overflow-wrap:anywhere">${escape(connectionId)}</td><td style="overflow-wrap:anywhere">${escape(operationId)}</td><td>${escape(tool)}</td><td>${escape(status)}</td><td>${escape(target)}</td><td>${jst(started)}</td><td>${jst(ended)}</td><td>${event.durationMs === undefined ? "—" : `${escape(event.durationMs)} ms`}</td><td>${operationDetailHtml(event.detail)}</td></tr>`;
    }).join("");
    const ownedProcessIds = new Set(visibleSessions.flatMap((session) => session.events.filter((event) => event.event === "process.start" && event.user === principal).map((event) => String(event.processId ?? ""))));
    const processGroups = new Map<string, { session: typeof own[number]; events: Array<Record<string, unknown> & { event: string; at: string }> }>();
    for (const session of visibleSessions) for (const event of session.events) {
      if (!["process.start", "process.output", "process.exit"].includes(event.event) || !(event.user === principal || (event.user === undefined && typeof event.processId === "string" && (ownedProcessIds.has(event.processId) || event.command !== undefined)))) continue;
      const key = `${session.id}:${typeof event.processId === "string" ? event.processId : `${event.at}:${event.event}`}`;
      const previous = processGroups.get(key);
      processGroups.set(key, { session, events: [...(previous?.events ?? []), event] });
    }
    const runningProcessKeys = new Set(running.map((process) => `${process.sessionId}:${process.id}`));
    const processDetails = [...processGroups.entries()].sort(([leftKey, left], [rightKey, right]) => {
      const leftRunning = runningProcessKeys.has(leftKey) ? 1 : 0;
      const rightRunning = runningProcessKeys.has(rightKey) ? 1 : 0;
      return rightRunning - leftRunning || Date.parse(right.events.at(-1)!.at) - Date.parse(left.events.at(-1)!.at);
    }).map(([, group]) => group).slice(0, 100);
    body += `<section><details><summary>操作履歴</summary><div class="scroll"><table><thead><tr><th>受信時刻</th><th>Connection ID</th><th>Operation ID</th><th>Tool</th><th>状態</th><th>対象</th><th>開始</th><th>終了</th><th>実行時間</th><th>詳細</th></tr></thead><tbody id="operation-rows">${opRows}</tbody></table></div><p><small>この画面には現在ログインしている使用者自身の記録だけを表示します。</small></p></details></section>`;
    body += `<section id="process-details"><h2>コマンドと出力の詳細</h2>${logControls}${processDetails.map(({ session, events }) => {
      const start = events.find((event) => event.event === "process.start");
      const latest = events.at(-1)!;
      const exit = events.filter((event) => event.event === "process.exit").at(-1);
      const command = start?.command ?? events.filter((event) => event.command !== undefined).at(-1)?.command;
      const comment = start?.comment ?? events.filter((event) => event.comment !== undefined).at(-1)?.comment;
      const outputEvents = events.filter((event) => event.output !== undefined && event.event !== "process.exit");
      const earlierOutput = outputEvents.map((event) => String(event.output)).join("\n");
      if (exit?.output !== undefined && !earlierOutput.includes(String(exit.output))) {
        const snapshot = String(exit.output);
        const remaining = snapshot.startsWith(earlierOutput) ? snapshot.slice(earlierOutput.length).replace(/^\n/, "") : snapshot;
        if (remaining) outputEvents.push({ ...exit, output: remaining });
      }
      const purpose = typeof comment === "string" && comment ? comment : "未記録";
      const commandText = typeof command === "string" && command ? command : "未記録";
      return `<article class="process-block" data-session-id="${escape(session.id)}" data-process-id="${escape(latest.processId ?? "—")}" data-events-json="${escape(JSON.stringify(events))}"><h3 id="${escape(processAnchorId(session.id, String(latest.processId ?? "—")))}" tabindex="-1">${jst(start?.at ?? events[0]?.at)} · ${escape(session.id)} · ${escape(latest.processId ?? "—")}</h3><h3>実行目的</h3><pre>${escape(purpose)}</pre><h3>コマンド</h3><pre>${escape(commandText)}</pre>${outputEvents.length ? `<details><summary>出力</summary>${outputEvents.map((event) => `<div class="output-part"><small>${event.event === "process.exit" ? "終了時の出力 · " : ""}${jst(event.at)}</small><pre>${escape(event.output)}</pre></div>`).join("")}</details>` : ""}${exit ? `<p>終了コード: ${escape(exit.exitCode ?? "—")}${exit.result ? ` · ${escape(exit.result)}` : ""}</p>` : ""}</article>`;
    }).join("")}</section>`;
    return res.type("html").send(page(body + stopDetails, res.locals.userNonce));
  });
}
