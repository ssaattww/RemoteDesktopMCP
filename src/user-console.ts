import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { readSessionLogs } from "./admin.js";
import type { RemoteDesktopService } from "./index.js";
import { GoogleOidcClient, type GoogleIdentity } from "./public-auth.js";
import { verifyPassword } from "./hash-password.js";

const id = () => randomBytes(32).toString("base64url");
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const cookieName = "rdmcp_user";
const cookie = (header: string | undefined, name = cookieName) => header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const principalFor = (identity: GoogleIdentity) => `google:${identity.iss}:${identity.sub}`;
const jst = (value: unknown) => { const date = new Date(String(value ?? "")); return value === undefined || value === "—" || Number.isNaN(date.getTime()) ? "—" : `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "medium", hourCycle: "h23" }).format(date)} JST`; };
const page = (body: string, refreshSeconds?: number) => `<!doctype html><html lang="ja"><meta charset="utf-8">${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}<meta name="viewport" content="width=device-width,initial-scale=1"><title>RDMCP User Console</title><style>body{font:16px system-ui,sans-serif;background:#f4f6fa;color:#17243b;margin:0}main{max-width:1100px;margin:12px auto;padding:12px}header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}header h1{font-size:18px;margin:0 auto 0 0}h2{font-size:16px;margin:0 0 8px}p{margin:7px 0}section,form{background:#fff;border:1px solid #dbe2ec;border-radius:12px;padding:20px;margin:18px 0}section.session-list{font-size:14px;border-radius:8px;padding:12px;margin:10px 0}header form,.toolbar form{display:inline-flex;align-items:center;gap:6px;background:none;border:0;padding:0;margin:0}button,select{font:inherit;padding:5px 7px}button{white-space:nowrap}.toolbar form{flex-wrap:wrap}article p,.session-meta{overflow-wrap:anywhere}.danger{background:#b42318;color:#fff;border:0;font-weight:700}.ok{background:#147a43;color:#fff;border:0;font-weight:700}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #dbe2ec;vertical-align:top}th{font-weight:600}.session-list th,.session-list td{padding:6px}.scroll{overflow:auto}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}.session-link{white-space:nowrap;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f7;padding:12px;border-radius:8px}.stopped{color:#b42318;font-weight:700}.running{color:#a15c00;font-weight:700}small{color:#526078}@media(max-width:600px){main{margin:4px auto;padding:7px}section{padding:12px;margin:10px 0}section.session-list{padding:9px;margin:7px 0}header h1{font-size:16px}h2{font-size:15px}th,td{padding:7px;white-space:nowrap}.session-list th,.session-list td{padding:5px}}</style><main>${body}</main></html>`;

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
  const setLoginCookie = (res: Response, value: string, age: number) => setCookie(res, value, age);
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

  app.use("/user", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${google ? " https://accounts.google.com" : ""}; frame-ancestors 'none'; base-uri 'none'`); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("X-Content-Type-Options", "nosniff"); clean(); next(); });
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
  app.use("/user", async (req, res, next) => { const login = current(req); if (!login || !await loginAllowed(login)) return res.redirect(303, "/user/login"); res.locals.principal = login.principal; res.locals.csrf = login.csrf; next(); });
  app.post("/user/logout", (req, res) => { if (!requireCsrf(req, res)) return; logins.delete(cookie(req.header("cookie")) ?? ""); setLoginCookie(res, "", 0); return res.redirect(303, "/user/login"); });
  app.post("/user/emergency-stop", async (req, res) => { if (!requireCsrf(req, res)) return; const state = await service.stopUserExecution(res.locals.principal as string).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "停止状態を保存できませんでした。" })); if ("error" in state) return res.status(503).type("html").send(page(`<p class="stopped">${escape(state.error)}</p>`)); return res.redirect(303, "/user"); });
  app.post("/user/resume", async (req, res) => { if (!requireCsrf(req, res)) return; const state = await service.resumeUserExecution(res.locals.principal as string).catch((error: unknown) => ({ error: error instanceof Error ? error.message : "再開できませんでした。" })); if ("error" in state) return res.status(503).type("html").send(page(`<p class="stopped">${escape(state.error)}</p>`)); return res.redirect(303, "/user"); });
  app.get(["/user", "/user/", "/user/sessions/:sessionId"], async (req, res) => {
    const principal = res.locals.principal as string;
    const refreshChoices = [0, 5, 10, 30, 60];
    const requestedRefresh = typeof req.query.refresh === "string" ? Number(req.query.refresh) : undefined;
    const savedRefresh = Number(cookie(req.header("cookie"), "rdmcp_user_refresh") ?? "5");
    const refreshSeconds = requestedRefresh !== undefined && refreshChoices.includes(requestedRefresh) ? requestedRefresh : refreshChoices.includes(savedRefresh) ? savedRefresh : 5;
    if (requestedRefresh !== undefined && refreshChoices.includes(requestedRefresh)) setCookie(res, String(refreshSeconds), 365 * 24 * 3600, "rdmcp_user_refresh");
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
    const visibleSessions = selectedSession ? [selectedSession] : own;
    const stoppedAt = Date.parse(String(state.stoppedAt ?? ""));
    const currentStopWarnings = state.stopped ? stopWarnings.filter((warning) => warning.user === principal && Date.parse(warning.at) >= stoppedAt && (!warning.stopId || warning.stopId === state.stopId)) : [];
    const running = [...service.processes.values()].filter((process) => process.user === principal && (!selectedSession || process.sessionId === selectedSession.id) && (process.state === "running" || process.state === "terminating"));
    const activeSessions = [...service.sessions.values()].filter((session) => session.user === principal && session.state === "active" && session.expires > Date.now());
    const activeIds = new Set(activeSessions.map((session) => session.id));
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
    const stopWarningLabels: Record<string, string> = { "process.owner_stop_unconfirmed": "停止担当機能から終了確認応答がありません。", "process.owner_stop_failed": "プロセスへの停止要求に失敗しました。", "process.stop_unconfirmed": "プロセスの終了を確認できませんでした。", "process.stop_unconfirmed_after_start": "停止中に開始したプロセスの終了を確認できませんでした。", "process.stop_requested_after_start": "停止中に返されたプロセス ID に停止要求を行いました。", "user.stop_marker_failed": "停止状態の復旧マーカーを保存できませんでした。", "user.stop_persistence_failed": "停止状態を保存できませんでした。" };
    const warningRows = currentStopWarnings.map((warning) => `<li>${escape(stopWarningLabels[warning.event] ?? "停止処理に未確認の結果があります。")}${warning.pid ? ` PID ${escape(warning.pid)}` : ""}</li>`).join("");
    let body = `<header><h1>RDMCP User Console</h1><span class="${state.stopped ? "stopped" : ""}">${state.stopped ? "STOPPED" : "READY"}</span>${state.stopped ? `<form method="post" action="/user/emergency-stop"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">停止を再試行</button></form><form method="post" action="/user/resume"><input type="hidden" name="csrf" value="${csrf}"><button class="ok">実行を再開</button></form>` : `<form method="post" action="/user/emergency-stop"><input type="hidden" name="csrf" value="${csrf}"><button class="danger">EMERGENCY STOP / 全実行停止</button></form>`}<form method="post" action="/user/logout"><input type="hidden" name="csrf" value="${csrf}"><button>ログアウト</button></form></header>`;
    const stopDetails = `<section><details${warningRows ? " open" : ""}><summary>実行状態の詳細</summary><p>Stop generation: ${state.stopGeneration}</p>${state.stopped ? `<p>Stopped at: ${jst(state.stoppedAt)}<br><span style="overflow-wrap:anywhere">Stop ID: ${escape(state.stopId)}</span></p><p class="stopped">停止状態は新しい実行を遮断します。既存プロセスの終了確認は別に行います。</p>${warningRows ? `<p class="stopped">この停止要求で終了を確認できなかった処理:</p><ul>${warningRows}</ul>` : ""}<p>停止要求を再試行して、応答を確認できなかったプロセスや開始処理中のプロセスを再走査できます。</p>` : ""}<p><small>終了を確認できていない処理が残る場合があります。停止中は停止要求を再試行できます。停止後は再開しても以前の接続を再利用できません。</small></p></details></section>`;
    const refreshOptions = refreshChoices.map((seconds) => `<option value="${seconds}"${refreshSeconds === seconds ? " selected" : ""}>${seconds === 0 ? "自動更新なし" : `${seconds}秒`}</option>`).join("");
    if (!selectedSession) {
      body += `<section class="session-list"><div class="toolbar"><h2>セッション一覧</h2><span>有効な接続: ${activeSessions.length} · 現在実行中の操作: ${runningOperations.length + running.length}</span><form method="get" action="/user"><label>表示 <select name="filter"><option value="all"${filter === "all" ? " selected" : ""}>すべて</option><option value="active"${filter === "active" ? " selected" : ""}>有効のみ</option></select></label><label>更新間隔 <select name="refresh">${refreshOptions}</select></label><button>適用</button></form></div>${shownSessions.length ? `<div class="scroll"><table><thead><tr><th>内容</th><th>作成日時</th><th>最終アクセス日時</th><th>状態</th><th>用途</th><th>Connection ID</th><th>作業ディレクトリ</th></tr></thead><tbody>${shownSessions.map((session) => `<tr><td><a class="session-link" href="/user/sessions/${encodeURIComponent(session.id)}">詳細を見る</a></td><td>${jst(session.at)}</td><td>${jst(session.lastAccessAt ?? session.at)}</td><td>${escape(activeIds.has(session.id) ? "有効" : session.state === "closed" ? "終了" : "履歴")}</td><td style="overflow-wrap:anywhere">${escape(session.purpose ?? "—")}</td><td style="overflow-wrap:anywhere">${escape(session.id)}</td><td style="overflow-wrap:anywhere">${escape(session.workingDirectory ?? "—")}</td></tr>`).join("")}</tbody></table></div>` : `<p>${filter === "active" ? "有効なセッションはありません。" : "表示できるセッションはありません。"}</p>`}</section>`;
      if (unassignedOperations.length) body += `<section><h2>セッション外の操作</h2><ul>${unassignedOperations.map((session) => `<li>${jst(session.at)} · <a href="/user/sessions/${encodeURIComponent(session.id)}">${escape(session.id)}</a></li>`).join("")}</ul></section>`;
      return res.type("html").send(page(body + stopDetails, refreshSeconds));
    }
    body += `<section><div class="toolbar"><h2>${selectedSession.id.startsWith("request:") ? "セッション外の操作" : "セッションの内容"}</h2><a href="/user">一覧に戻る</a><form method="get"><label>更新間隔 <select name="refresh">${refreshOptions}</select></label><button>適用</button></form></div><p class="session-meta">Connection ID: ${escape(selectedSession.id)}<br>作成日時: ${jst(selectedSession.at)}<br>最終アクセス日時: ${jst(selectedSession.lastAccessAt ?? selectedSession.at)}<br>作業ディレクトリ: ${escape(selectedSession.workingDirectory ?? "—")}<br>用途: ${escape(selectedSession.purpose ?? "—")}</p></section>`;
    const runningRows = [
      ...runningOperations.map(({ session, event }) => ({ operationId: String(event.operationId ?? "—"), connectionId: String(event.connectionId ?? session.id), label: String(event.tool ?? "operation"), status: "running" })),
      ...running.map((process) => ({ operationId: process.id, connectionId: process.sessionId, label: "process", status: `${process.state}${process.terminationUnconfirmed ? " (termination unconfirmed)" : ""}` })),
    ];
    body += `<section><h2>Running operations</h2>${runningRows.length ? `<div class="scroll"><table><thead><tr><th>Operation ID</th><th>Connection ID</th><th>Tool / 状態</th></tr></thead><tbody>${runningRows.map((item) => `<tr><td style="overflow-wrap:anywhere">${escape(item.operationId)}</td><td style="overflow-wrap:anywhere">${escape(item.connectionId)}</td><td class="running">${escape(item.label)} · ${escape(item.status)}</td></tr>`).join("")}</tbody></table></div>` : "<p>実行中の操作はありません。</p>"}</section>`;
    const opRows = operations.map(({ session, event, status }) => {
      const tool = String(event.tool ?? "—");
      const receivedAt = String(event.receivedAt ?? event.at);
      const started = typeof event.startAt === "string" ? event.startAt : "—";
      const ended = typeof event.endedAt === "string" ? event.endedAt : "—";
      const target = typeof event.target === "string" ? event.target : "—";
      const operationId = String(event.operationId ?? "—");
      const connectionId = String(event.connectionId ?? session.id ?? "—");
      return `<tr><td>${jst(receivedAt)}</td><td style="overflow-wrap:anywhere">${escape(connectionId)}</td><td style="overflow-wrap:anywhere">${escape(operationId)}</td><td>${escape(tool)}</td><td>${escape(status)}</td><td>${escape(target)}</td><td>${jst(started)}</td><td>${jst(ended)}</td><td>${event.durationMs === undefined ? "—" : `${escape(event.durationMs)} ms`}</td></tr>`;
    }).join("");
    const ownedProcessIds = new Set(visibleSessions.flatMap((session) => session.events.filter((event) => event.event === "process.start" && event.user === principal).map((event) => String(event.processId ?? ""))));
    const processGroups = new Map<string, { session: typeof own[number]; start?: Record<string, unknown> & { event: string; at: string }; latest: Record<string, unknown> & { event: string; at: string } }>();
    for (const session of visibleSessions) for (const event of session.events) {
      if (!["process.start", "process.output", "process.exit"].includes(event.event) || !(event.user === principal || (typeof event.processId === "string" && ownedProcessIds.has(event.processId)))) continue;
      const key = typeof event.processId === "string" ? event.processId : `${session.id}:${event.at}:${event.event}`;
      const previous = processGroups.get(key);
      processGroups.set(key, { session, start: event.event === "process.start" ? event : previous?.start, latest: event });
    }
    const processDetails = [...processGroups.values()].slice(-100).reverse();
    body += `<section><h2>Invocation log</h2><div class="scroll"><table><thead><tr><th>受信時刻</th><th>Connection ID</th><th>Operation ID</th><th>Tool</th><th>状態</th><th>対象</th><th>開始</th><th>終了</th><th>実行時間</th></tr></thead><tbody>${opRows}</tbody></table></div><p><small>この画面には現在ログインしている使用者自身の記録だけを表示します。</small></p></section>`;
    if (processDetails.length) body += `<section><h2>コマンドと出力の詳細</h2>${processDetails.map(({ session, start, latest }) => `<article><p>${jst(latest.at)} · ${escape(session.id)} · ${escape(latest.event)}</p>${(start?.command ?? latest.command) === undefined ? "" : `<h3>コマンド</h3><pre>${escape(start?.command ?? latest.command)}</pre>`}${latest.output === undefined ? "" : `<h3>出力</h3><pre>${escape(latest.output)}</pre>`}${latest.result ? `<p>${escape(latest.result)}</p>` : ""}</article>`).join("")}</section>`;
    return res.type("html").send(page(body + stopDetails, refreshSeconds));
  });
}
