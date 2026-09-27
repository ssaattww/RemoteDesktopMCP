import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type { Express, Request, Response } from "express";
import type { RemoteDesktopService } from "./index.js";
import { GoogleOidcClient, type GoogleIdentity } from "./public-auth.js";
import { verifyPassword } from "./hash-password.js";
import { assertPrivateAuditStorage } from "./private-storage.js";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const jst = (value: unknown) => { const date = new Date(String(value)); return Number.isNaN(date.getTime()) ? "—" : `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)} JST`; };
const id = () => randomBytes(32).toString("base64url");
const cookieName = "rdmcp_admin";
const loginBudgetCookieName = "rdmcp_admin_login_budget";
const cookie = (header: string | undefined, name = cookieName) => header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
const page = (body: string) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>サーバー管理 | Remote Desktop MCP</title><style>body{font:16px system-ui,sans-serif;background:#f4f6fa;color:#17243b;margin:0;overflow-x:hidden}main{max-width:1100px;margin:40px auto;padding:24px}h1{font-size:28px}h2{font-size:21px}section,form{background:white;padding:24px;border:1px solid #dbe2ec;border-radius:12px;margin:18px 0}header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header h1{margin:0 auto 0 0}.logout{display:inline;margin:0;padding:0;background:transparent;border:0}.logout button{margin:0;padding:6px 9px;font-size:14px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #dbe2ec;vertical-align:top}input,button{font:inherit;padding:10px;margin:8px}small{color:#526078}.scroll{overflow:auto}@media(max-width:600px){body{font-size:13px}main{margin:12px auto;padding:10px}h1{font-size:21px}h2{font-size:17px;margin:0 0 8px}section,form{padding:10px;margin:10px 0}header{gap:8px}header span{font-size:12px}th,td{padding:7px;white-space:nowrap}input,button{max-width:100%;margin:3px;padding:7px}}</style><main>${body}</main></html>`;

type Entry = Record<string, unknown> & { event: string; at: string };
export type SessionLog = { id: string; user: string; at: string; lastAccessAt?: string; state: string; workingDirectory?: string; purpose?: string; latestCommandAt?: string; events: Entry[] };
export type UserStopWarning = { user: string; event: string; at: string; stopId?: string; pid?: number };
const dateValue = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
};
export async function readSessionLogs(service: RemoteDesktopService) {
  const file = path.join(service.cfg.dataDir, "audit.jsonl");
  const sessions = new Map<string, SessionLog>();
  // This is deliberately separate from the rendered event history. Commands are
  // capped at 4,000 characters when written, so 2,000 active correlations stay bounded.
  const processes = new Map<string, { sessionId: string; command?: unknown }>();
  const stopWarnings = new Map<string, UserStopWarning[]>();
  // session_open has no connection ID until it returns. Keep its early operation
  // events briefly so the terminal event can attach them to the new connection.
  const pendingOperations = new Map<string, Entry[]>();
  const associatedCommands = new WeakSet<Entry>();
  const rememberProcess = (processId: string, process: { sessionId: string; command?: unknown }) => {
    processes.delete(processId);
    while (processes.size >= 2_000) processes.delete(processes.keys().next().value!);
    processes.set(processId, process);
  };
  const associateCommand = (session: SessionLog, processId: string, command: unknown) => {
    let target: Entry | undefined;
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const candidate = session.events[index]!;
      if ((candidate.event === "process.output" || candidate.event === "process.exit") && candidate.processId === processId) { target = candidate; break; }
    }
    if (!target || target.command !== undefined) return;
    for (const candidate of session.events) if (candidate.processId === processId && associatedCommands.has(candidate)) { delete candidate.command; associatedCommands.delete(candidate); }
    const associated = { ...target, command };
    session.events[session.events.indexOf(target)] = associated;
    associatedCommands.add(associated);
  };
  let skipped = 0;
  try { await assertPrivateAuditStorage(service.cfg.dataDir, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { sessions: [], skipped, stopWarnings: [] as UserStopWarning[] }; }
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; if (!entry || typeof entry.event !== "string" || typeof entry.at !== "string") throw new Error(); }
    catch { skipped++; continue; }
    if (["process.owner_stop_unconfirmed", "process.owner_stop_failed", "process.stop_unconfirmed", "process.stop_unconfirmed_after_start", "process.stop_requested_after_start", "user.stop_marker_failed", "user.stop_persistence_failed"].includes(entry.event) && typeof entry.user === "string") {
      const userWarnings = stopWarnings.get(entry.user) ?? [];
      userWarnings.push({ user: entry.user, event: entry.event, at: entry.at, ...(typeof entry.stopId === "string" ? { stopId: entry.stopId } : {}), ...(typeof entry.pid === "number" ? { pid: entry.pid } : {}) });
      if (userWarnings.length > 100) userWarnings.shift();
      stopWarnings.set(entry.user, userWarnings);
    }
    const processId = typeof entry.processId === "string" ? entry.processId : undefined;
    const knownProcess = processId ? processes.get(processId) : undefined;
    const operationId = typeof entry.operationId === "string" ? entry.operationId : undefined;
    const sid = typeof entry.sessionId === "string" ? entry.sessionId : knownProcess?.sessionId;
    if (!sid) {
      if (operationId && (entry.event === "operation.received" || entry.event === "operation.started")) {
        const events = pendingOperations.get(operationId) ?? [];
        if (events.length < 2) events.push(entry);
        pendingOperations.set(operationId, events);
        while (pendingOperations.size > 1_000) pendingOperations.delete(pendingOperations.keys().next().value!);
      }
      if (operationId && entry.event.startsWith("operation.") && !["operation.received", "operation.started"].includes(entry.event)) {
        const events = pendingOperations.get(operationId) ?? [];
        const session: SessionLog = { id: `request:${operationId}`, user: String(entry.user ?? "不明"), at: events[0]?.at ?? entry.at, state: "unavailable", events: [...events, entry] };
        sessions.set(`operation:${operationId}`, session);
        pendingOperations.delete(operationId);
        if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
      }
      continue;
    }
    if (processId) rememberProcess(processId, { sessionId: sid, command: entry.event === "process.start" && entry.command !== undefined ? entry.command : knownProcess?.command });
    let session = sessions.get(sid);
    if (!session) { session = { id: sid, user: String(entry.user ?? "不明"), at: entry.at, lastAccessAt: entry.at, state: "unavailable", events: [] }; sessions.set(sid, session); }
    if (operationId && entry.event === "operation.succeeded" && sid !== `request:${operationId}`) {
      const provisional = sessions.get(`request:${operationId}`);
      if (provisional && provisional.user === session.user && entry.user === session.user) {
        sessions.delete(`request:${operationId}`);
        session.events.push(...provisional.events.filter((event) => event.operationId === operationId));
      }
    }
    if (operationId && entry.event.startsWith("operation.")) {
      const pending = pendingOperations.get(operationId);
      if (pending) {
        for (const operation of pending) session.events.push(operation);
        pendingOperations.delete(operationId);
      }
    }
    const accessAt = typeof entry.sessionAccessAt === "string" ? entry.sessionAccessAt : ["session.open", "session.close", "operation.succeeded"].includes(entry.event) ? entry.at : undefined;
    if (entry.user === session.user && accessAt && dateValue(accessAt) >= dateValue(session.lastAccessAt)) session.lastAccessAt = accessAt;
    if (entry.event === "process.start") session.latestCommandAt = entry.at;
    if (entry.event === "session.open" && entry.user === session.user) {
      session.at = entry.at;
      if (typeof entry.workingDirectory === "string") session.workingDirectory = entry.workingDirectory;
      if (typeof entry.purpose === "string") session.purpose = entry.purpose;
    }
    if (entry.event === "session.close") session.state = "closed";
    if (entry.event === "session.expired") session.state = "expired";
    session.events.push(entry);
    // Bound retained history while streaming the file, including large outputs.
    const evicted = session.events.length > 200 ? session.events.shift() : undefined;
    if (evicted?.event === "process.start" && typeof evicted.processId === "string" && evicted.command !== undefined) associateCommand(session, evicted.processId, evicted.command);
    // A running process remains useful when its older process.start entry has
    // rolled out of the display window. Keep one association per process rather
    // than copying a command onto every output. The copied value is the redacted
    // value already persisted with process.start, never the original input.
    if (processId && (entry.event === "process.output" || entry.event === "process.exit") && entry.command === undefined && knownProcess?.command !== undefined && !session.events.some((candidate) => candidate.event === "process.start" && candidate.processId === processId)) {
      associateCommand(session, processId, knownProcess.command);
    }
    if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
  }
  for (const live of service.sessions.values()) {
    let session = sessions.get(live.id);
    if (!session) { session = { id: live.id, user: live.user, at: new Date(live.created).toISOString(), state: live.state, events: [] }; sessions.set(live.id, session); }
    session.state = live.state === "active" && live.expires <= Date.now() ? "expired" : live.state;
    session.at = new Date(live.created).toISOString();
    session.lastAccessAt = new Date(live.touched).toISOString();
    session.workingDirectory = live.workingDirectory;
    session.purpose = live.purpose;
  }
  return { sessions: [...sessions.values()].sort((a, b) => dateValue(b.at) - dateValue(a.at)), skipped, stopWarnings: [...stopWarnings.values()].flat() };
}

async function readSecurityAudit(service: RemoteDesktopService) {
  const file = path.join(service.cfg.dataDir, "audit.jsonl");
  try { await assertPrivateAuditStorage(service.cfg.dataDir, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const entries: Array<{ at: string; event: string; reason?: string; user?: string }> = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const item = JSON.parse(line) as Record<string, unknown>;
      const event = typeof item.event === "string" ? item.event : "";
      // Keep the administrator view focused on security and authentication. Tool
      // invocations, file activity, commands, and their output belong to users.
      if (!(event.startsWith("oauth.") || event.startsWith("auth.") || event === "mcp.rejected" || event === "http.failed" || event === "admin.login_rejected" || event.startsWith("user.execution.") || event === "user.stop_requested" || event.startsWith("user.stop_") || event === "process.owner_stop_unconfirmed")) continue;
      entries.push({ at: typeof item.at === "string" ? item.at : "", event, ...(typeof item.reason === "string" ? { reason: item.reason.slice(0, 120) } : {}), ...(typeof item.user === "string" ? { user: item.user.slice(0, 320) } : {}) });
      if (entries.length > 100) entries.shift();
    } catch { /* malformed audit lines are ignored */ }
  }
  return entries.reverse();
}

const renderAdminStatus = async (service: RemoteDesktopService) => {
  const activeConnections = [...service.sessions.values()].filter((session) => session.state === "active" && session.expires > Date.now()).length;
  const processes = [...service.processes.values()].filter((process) => process.state === "running" || process.state === "terminating");
  const administrators = service.cfg.adminUsers ?? [];
  const rootIds = service.cfg.roots.map((root) => root.id);
  const security = await readSecurityAudit(service);
  const recent = security.map((entry) => `<tr><td>${jst(entry.at)}</td><td>${escape(entry.event)}</td><td>${escape(entry.user ?? "—")}</td><td>${escape(entry.reason ?? "—")}</td></tr>`).join("");
  return `<header><h1>サーバー管理</h1><span>時刻は JST</span><form class="logout" method="post" action="/admin/logout"><button>ログアウト</button></form></header><section><h2>サーバー状態</h2><p>状態: 稼働中</p><p>認証方式: ${service.cfg.publicAuth ? "Google OIDC" : "ローカル開発用パスワード"}</p><p>管理者アカウント: ${administrators.length ? administrators.map(escape).join(", ") : "未設定"}</p><p>ファイル領域: ${rootIds.map(escape).join(", ")}</p><p>有効な接続: ${activeConnections}</p><p>実行中プロセス: ${processes.length}</p></section><section><h2>セキュリティ監査</h2><div class="scroll"><table><thead><tr><th>時刻</th><th>イベント</th><th>使用者</th><th>理由</th></tr></thead><tbody>${recent}</tbody></table></div><p><small>認証、拒否、サーバーセキュリティに関する直近100件を表示します。通常のツール呼び出しやコマンド履歴は使用者コンソールに表示されます。</small></p></section>`;
};

export function mountAdmin(app: Express, service: RemoteDesktopService) {
  const logins = new Map<string, { expires: number; email?: string; identity?: GoogleIdentity }>();
  const pending = new Map<string, { nonce: string; binding: string; expires: number }>();
  const loginBudgets = new Map<string, { attempts: number; reset: number }>();
  const passwordBudgets = new Map<string, { attempts: number; reset: number }>();
  const google = service.cfg.publicAuth;
  const verifier = google ? service.cfg.publicAuthOptions?.verifier ?? new GoogleOidcClient(google.googleClientId, google.googleClientSecret) : undefined;
  const admins = () => service.cfg.adminUsers ?? [];
  const allowed = async (login: { email?: string; identity?: GoogleIdentity }) => login.identity
    ? admins().includes(login.identity.sub) && Boolean(await service.publicAuth?.isAllowedIdentity(login.identity))
    : Boolean(login.email && admins().includes(login.email) && service.cfg.users.some((user) => user.email === login.email));
  const setCookie = (res: Response, name: string, value: string, age: number, path = "/") => res.append("Set-Cookie", `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${service.cfg.baseUrl.startsWith("https:") ? "; Secure" : ""}`);
  const setAdminCookie = (res: Response, value: string, age: number) => setCookie(res, cookieName, value, age);
  const remember = <T>(map: Map<string, T>, key: string, value: T, maximum: number) => { map.delete(key); while (map.size >= maximum) map.delete(map.keys().next().value!); map.set(key, value); };
  const clean = () => { const now = Date.now(); for (const [key, value] of logins) if (value.expires <= now) logins.delete(key); for (const [key, value] of pending) if (value.expires <= now) pending.delete(key); for (const [key, value] of loginBudgets) if (value.reset <= now) loginBudgets.delete(key); for (const [key, value] of passwordBudgets) if (value.reset <= now) passwordBudgets.delete(key); };
  const consume = (budgets: Map<string, { attempts: number; reset: number }>, key: string) => {
    const now = Date.now(); const budget = budgets.get(key); const next = !budget || budget.reset <= now ? { attempts: 1, reset: now + 60_000 } : { ...budget, attempts: budget.attempts + 1 };
    remember(budgets, key, next, 2_000);
    return next.attempts <= 10;
  };
  const loginAttempt = (header: string | undefined) => {
    const existing = cookie(header, loginBudgetCookieName); const key = existing && loginBudgets.has(existing) ? existing : id();
    return { key, allowed: consume(loginBudgets, key) };
  };
  const passwordAttempt = (req: Request) => {
    const email = typeof req.body?.email === "string" ? req.body.email.slice(0, 320) : "";
    // Password mode is local-only. Use the socket address that Express observed,
    // never client-controlled forwarding headers, in addition to the account key.
    return consume(passwordBudgets, `ip:${req.socket.remoteAddress ?? "unknown"}`) && consume(passwordBudgets, `account:${email}`);
  };
  app.use("/admin", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'${google ? " https://accounts.google.com" : ""}; frame-ancestors 'none'; base-uri 'none'`); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("X-Content-Type-Options", "nosniff"); clean(); next(); });
  app.get("/admin/login", (_req, res) => res.type("html").send(page(`<h1>管理者ログイン</h1>${google ? '<form method="post" action="/admin/login"><button>Google でログイン</button></form>' : '<form method="post" action="/admin/login"><label>メールアドレス<input name="email" type="email" required autocomplete="username"></label><label>パスワード<input name="password" type="password" required autocomplete="current-password"></label><button>ログイン</button></form>'}`)));
  app.post("/admin/login", async (req, res) => {
    if (req.header("origin") !== new URL(service.cfg.baseUrl).origin) return res.status(403).send("アクセスできません。");
    const attempt = loginAttempt(req.header("cookie"));
    const setBudgetCookie = () => setCookie(res, loginBudgetCookieName, attempt.key, 60, "/admin");
    if (!attempt.allowed) { setBudgetCookie(); return res.status(429).send("しばらく待ってから再試行してください。"); }
    if (verifier && google) {
      const state = `admin_${id()}`; const binding = id(); const nonce = id();
      if (pending.size >= 1_000) { setBudgetCookie(); return res.status(429).send("しばらく待ってから再試行してください。"); }
      pending.set(state, { nonce, binding, expires: Date.now() + 300_000 }); setAdminCookie(res, binding, 300); setBudgetCookie();
      return res.redirect(303, verifier.authorizationUrl({ redirectUri: google.googleRedirectUri, state, nonce }));
    }
    if (!passwordAttempt(req)) { setBudgetCookie(); return res.status(429).send("しばらく待ってから再試行してください。"); }
    const user = service.cfg.users.find((entry) => entry.email === req.body?.email);
    if (!user || !await allowed({ email: user.email }) || typeof req.body?.password !== "string" || !await verifyPassword(req.body.password, user.passwordHash)) { setBudgetCookie(); return res.status(403).type("html").send(page('<p>管理者としてログインできません。</p><a href="/admin/login">再試行</a>')); }
    const token = id(); remember(logins, token, { email: user.email, expires: Date.now() + 3600_000 }, 2_000); setAdminCookie(res, token, 3600); setBudgetCookie(); return res.redirect(303, "/admin/sessions");
  });
  app.get("/google/callback", async (req, res, next) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!state.startsWith("admin_")) return next();
    res.setHeader("Cache-Control", "no-store"); clean();
    const flow = pending.get(state);
    if (!flow || flow.binding !== cookie(req.header("cookie")) || !verifier || !google) return res.status(403).send("ログインの有効期限が切れています。");
    pending.delete(state);
    if (typeof req.query.code !== "string" || req.query.error) return res.status(403).send("ログインできません。");
    try {
      const identity = await verifier.exchangeCode({ code: req.query.code, state, nonce: flow.nonce, redirectUri: google.googleRedirectUri });
      if (!await allowed({ identity })) return res.status(403).send("管理者権限が必要です。");
      const token = id(); remember(logins, token, { identity, expires: Date.now() + 3600_000 }, 2_000); setAdminCookie(res, token, 3600); return res.redirect(303, "/admin/sessions");
    } catch { return res.status(403).send("ログインできません。"); }
  });
  app.use("/admin", async (req, res, next) => {
    const login = logins.get(cookie(req.header("cookie")) ?? "");
    if (!login || !await allowed(login)) {
      if (req.path === "/sessions.json") return res.status(401).json({ error: "authentication_required" });
      return res.redirect(303, "/admin/login");
    }
    next();
  });
  app.post("/admin/logout", (req, res) => { if (req.header("origin") !== new URL(service.cfg.baseUrl).origin) return res.sendStatus(403); logins.delete(cookie(req.header("cookie")) ?? ""); setAdminCookie(res, "", 0); return res.redirect(303, "/admin/login"); });
  app.get("/admin/client.js", (_req, res) => res.sendStatus(404));
  app.get("/admin/sessions.json", (_req, res) => res.sendStatus(404));
  app.get(["/admin", "/admin/sessions"], async (_req, res) => res.type("html").send(page(await renderAdminStatus(service))));
}
