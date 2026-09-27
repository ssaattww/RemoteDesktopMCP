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
const page = (body: string) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>セッションログ | Remote Desktop MCP</title><style>body{font:16px system-ui,sans-serif;background:#f4f6fa;color:#17243b;margin:0}main{max-width:1100px;margin:40px auto;padding:24px}h1{font-size:28px}a{color:#165fba}section,form{background:white;padding:24px;border:1px solid #dbe2ec;border-radius:12px;margin:18px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:12px;border-bottom:1px solid #dbe2ec;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef2f7;padding:16px;border-radius:8px}input,button{font:inherit;padding:10px;margin:8px}small{color:#526078}.scroll{overflow:auto}.badge{font-weight:700}label{display:block}</style><main>${body}</main></html>`;

type Entry = Record<string, unknown> & { event: string; at: string };
export async function readSessionLogs(service: RemoteDesktopService) {
  const file = path.join(service.cfg.dataDir, "audit.jsonl");
  const sessions = new Map<string, { id: string; user: string; at: string; state: string; events: Entry[] }>();
  // This is deliberately separate from the rendered event history. Commands are
  // capped at 4,000 characters when written, so 2,000 active correlations stay bounded.
  const processes = new Map<string, { sessionId: string; command?: unknown }>();
  const associatedCommands = new WeakSet<Entry>();
  const rememberProcess = (processId: string, process: { sessionId: string; command?: unknown }) => {
    processes.delete(processId);
    while (processes.size >= 2_000) processes.delete(processes.keys().next().value!);
    processes.set(processId, process);
  };
  const associateCommand = (session: { events: Entry[] }, processId: string, command: unknown) => {
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
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { sessions: [], skipped }; }
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry: Entry;
    try { entry = JSON.parse(line) as Entry; if (!entry || typeof entry.event !== "string" || typeof entry.at !== "string") throw new Error(); }
    catch { skipped++; continue; }
    const processId = typeof entry.processId === "string" ? entry.processId : undefined;
    const knownProcess = processId ? processes.get(processId) : undefined;
    const sid = typeof entry.sessionId === "string" ? entry.sessionId : knownProcess?.sessionId;
    if (!sid) continue;
    if (processId) rememberProcess(processId, { sessionId: sid, command: entry.event === "process.start" && entry.command !== undefined ? entry.command : knownProcess?.command });
    let session = sessions.get(sid);
    if (!session) { session = { id: sid, user: String(entry.user ?? "不明"), at: entry.at, state: "unavailable", events: [] }; sessions.set(sid, session); }
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
  }
  return { sessions: [...sessions.values()].sort((a, b) => b.at.localeCompare(a.at)), skipped };
}

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
  app.use("/admin", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${google ? " https://accounts.google.com" : ""}; frame-ancestors 'none'; base-uri 'none'`); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("X-Content-Type-Options", "nosniff"); clean(); next(); });
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
    if (!login || !await allowed(login)) return res.redirect(303, "/admin/login");
    next();
  });
  app.post("/admin/logout", (req, res) => { if (req.header("origin") !== new URL(service.cfg.baseUrl).origin) return res.sendStatus(403); logins.delete(cookie(req.header("cookie")) ?? ""); setAdminCookie(res, "", 0); return res.redirect(303, "/admin/login"); });
  app.get(["/admin", "/admin/sessions"], async (req, res) => {
    const { sessions, skipped } = await readSessionLogs(service);
    const selected = typeof req.query.session === "string" ? req.query.session : undefined;
    const stateLabel = (state: string) => state === "active" ? "有効" : `無効（${state === "closed" ? "終了済み" : state === "expired" ? "期限切れ" : "再起動前・状態不明"}）`;
    let body = '<h1>セッションログ</h1><p>時刻はすべて日本標準時（JST）です。</p><a href="/admin/sessions">一覧・更新</a><form method="post" action="/admin/logout"><button>ログアウト</button></form>';
    if (selected) {
      const session = sessions.find((entry) => entry.id === selected);
      if (!session) return res.status(404).type("html").send(page(`${body}<p>セッションが見つかりません。</p>`));
      body += `<section><h2>${escape(session.user)}</h2><p>${escape(session.id)}</p><p class="badge">${stateLabel(session.state)}</p><p>開始: ${jst(session.at)}</p></section>`;
      body += session.events.map((entry) => `<section><small>${jst(entry.at)}</small><h3>${escape(entry.event)}</h3>${entry.processId ? `<p>実行 ID: ${escape(entry.processId)}</p>` : ""}${entry.command !== undefined ? `<h4>コマンド実行 → 実行結果</h4><pre>${escape(entry.command)}</pre>` : ""}${entry.output !== undefined ? `<pre>${escape(entry.output)}</pre>` : ""}${entry.outputTruncated ? "<p>出力は先頭4,000文字まで保存されています。</p>" : ""}${entry.exitCode !== undefined ? `<p>終了コード: ${escape(entry.exitCode ?? "不明")}</p>` : ""}${entry.result ? `<p>${escape(entry.result)}</p>` : ""}</section>`).join("");
    } else {
      body += `<section><div class="scroll"><table><thead><tr><th>開始時刻（JST）</th><th>ユーザー / セッション</th><th>有効・無効</th></tr></thead><tbody>${sessions.map((session) => `<tr><td>${jst(session.at)}</td><td>${escape(session.user)}<br><a href="/admin/sessions?session=${encodeURIComponent(session.id)}">${escape(session.id)}</a></td><td class="badge">${stateLabel(session.state)}</td></tr>`).join("")}</tbody></table></div>${sessions.length ? "" : "<p>セッションログはまだありません。</p>"}</section>`;
    }
    body += `<p><small>最大500セッション・各直近200件を表示。過去に保存されていない出力は表示できません。${skipped ? ` 読み取れない記録: ${skipped}件。` : ""}</small></p>`;
    return res.type("html").send(page(body));
  });
}
