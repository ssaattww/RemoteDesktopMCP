import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLocalJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";

export const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
export const AUTH_COOKIE = "rdmcp_authorization";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_HTTP_BYTES = 64 * 1024;
const TRANSACTION_TTL = 5 * 60_000;
const CODE_TTL = 5 * 60_000;
const ACCESS_TTL = 10 * 60;
const REFRESH_TTL = 7 * 24 * 60 * 60_000;
const MAX_REFRESHES = 256;

export type GoogleIdentity = { iss: string; sub: string; email?: string };
export type OidcAuthorizationInput = { redirectUri: string; state: string; nonce: string };
export type OidcExchangeInput = OidcAuthorizationInput & { code: string };
export interface OidcVerifier {
  authorizationUrl(input: OidcAuthorizationInput): string;
  exchangeCode(input: OidcExchangeInput): Promise<GoogleIdentity>;
}
export type OAuthState = {
  version: 1;
  epoch: number;
  allowedSubjects: GoogleIdentity[];
  refreshes: Array<{ hash: string; family: string; subject: GoogleIdentity; clientId: string; resource: string; scope: "mcp"; expires: number; used?: boolean }>;
  families: Record<string, { active: boolean; epoch: number }>;
};
export interface OAuthStateStore { load(): Promise<OAuthState>; save(state: OAuthState): Promise<void>; }
export type PublicAuthConfig = { baseUrl: string; tokenSecret: string; dataDir: string; googleClientId: string; googleClientSecret: string; googleRedirectUri: string };
export type PublicAuthOptions = { store?: OAuthStateStore; verifier?: OidcVerifier; now?: () => number; makeId?: () => string; request?: typeof fetch };
type Transaction = { id: string; googleState: string; nonce: string; clientId: string; redirectUri: string; resource: string; state?: string; challenge: string; expires: number; subject?: GoogleIdentity; googleCallbackStarted?: boolean };
type Code = Omit<Transaction, "id" | "googleState" | "nonce"> & { subject: GoogleIdentity };

const id = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const digest = (value: string) => createHash("sha256").update(value).digest("base64url");
const freshState = (): OAuthState => ({ version: 1, epoch: 1, allowedSubjects: [], refreshes: [], families: {} });
const isState = (value: unknown): value is OAuthState => typeof value === "object" && value !== null && (value as { version?: unknown }).version === 1 && typeof (value as { epoch?: unknown }).epoch === "number" && Array.isArray((value as { allowedSubjects?: unknown }).allowedSubjects) && Array.isArray((value as { refreshes?: unknown }).refreshes) && typeof (value as { families?: unknown }).families === "object";

export function createFileOAuthStateStore(dataDir: string): OAuthStateStore {
  const file = path.join(dataDir, "oauth-state.json");
  return {
    async load() {
      try { const raw = await readFile(file, "utf8"); const state: unknown = JSON.parse(raw); if (!isState(state)) throw new Error("OAuth state is invalid."); return state; }
      catch (error) { if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") return freshState(); throw error; }
    },
    async save(state) {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${id()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temporary, file); }
      finally { /* A failed rename leaves only an inaccessible random temporary file; do not replace a valid state file. */ }
    },
  };
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error("The Google identity service rejected the request.");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_HTTP_BYTES) throw new Error("The Google identity response was too large.");
  const reader = response.body?.getReader(); if (!reader) throw new Error("The Google identity response was empty.");
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) { const next = await reader.read(); if (next.done) break; total += next.value.byteLength; if (total > MAX_HTTP_BYTES) throw new Error("The Google identity response was too large."); chunks.push(next.value); }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  const parsed: unknown = JSON.parse(text); if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The Google identity response was invalid."); return parsed as Record<string, unknown>;
}

export class GoogleOidcClient implements OidcVerifier {
  private jwks?: ReturnType<typeof createLocalJWKSet>;
  private jwksExpires = 0;
  constructor(private readonly clientId: string, private readonly clientSecret: string, private readonly request: typeof fetch = fetch, private readonly now = () => Date.now()) {}
  authorizationUrl(input: OidcAuthorizationInput): string {
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({ response_type: "code", client_id: this.clientId, redirect_uri: input.redirectUri, scope: "openid email", state: input.state, nonce: input.nonce, prompt: "select_account" }).toString();
    return url.toString();
  }
  async exchangeCode(input: OidcExchangeInput): Promise<GoogleIdentity> {
    const response = await this.request(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: input.code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: input.redirectUri, grant_type: "authorization_code" }), signal: AbortSignal.timeout(10_000), redirect: "error" });
    const token = (await boundedJson(response)).id_token;
    if (typeof token !== "string" || token.length > 16 * 1024) throw new Error("The Google identity token was missing.");
    return this.verifyIdToken(token, input.nonce);
  }
  async verifyIdToken(token: string, nonce: string): Promise<GoogleIdentity> {
    if (!this.jwks || this.jwksExpires <= this.now()) {
      const response = await this.request(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      const jwks = await boundedJson(response) as unknown as { keys: JsonWebKey[] };
      if (!Array.isArray(jwks.keys) || jwks.keys.length > 20) throw new Error("The Google signing keys were invalid.");
      this.jwks = createLocalJWKSet(jwks); this.jwksExpires = this.now() + 60 * 60_000;
    }
    const options: JWTVerifyOptions = { issuer: [...GOOGLE_ISSUERS], audience: this.clientId, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "iss", "sub", "aud"], maxTokenAge: "10m", clockTolerance: 10 };
    const verified = await jwtVerify(token, this.jwks, options);
    const { iss, sub, nonce: returnedNonce, azp, aud, iat } = verified.payload;
    if (typeof iss !== "string" || !GOOGLE_ISSUERS.includes(iss as typeof GOOGLE_ISSUERS[number]) || typeof sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(sub) || returnedNonce !== nonce || typeof iat !== "number" || iat * 1000 > this.now() + 10_000) throw new Error("The Google identity token claims were invalid.");
    if ((Array.isArray(aud) && azp !== this.clientId) || (azp !== undefined && azp !== this.clientId)) throw new Error("The Google identity token client was invalid.");
    return { iss, sub, ...(typeof verified.payload.email === "string" ? { email: verified.payload.email } : {}) };
  }
}

export class PublicAuthService {
  private readonly store: OAuthStateStore;
  private readonly verifier: OidcVerifier;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly request: typeof fetch;
  private clientMetadataExpires = 0;
  private state?: OAuthState;
  private mutationTail = Promise.resolve();
  private readonly transactions = new Map<string, Transaction>();
  private readonly codes = new Map<string, Code>();
  constructor(readonly cfg: PublicAuthConfig, options: PublicAuthOptions = {}) { this.store = options.store ?? createFileOAuthStateStore(cfg.dataDir); this.verifier = options.verifier ?? new GoogleOidcClient(cfg.googleClientId, cfg.googleClientSecret, options.request, options.now); this.now = options.now ?? (() => Date.now()); this.makeId = options.makeId ?? id; this.request = options.request ?? fetch; }
  async initialize(): Promise<void> { await this.reload(); await this.verifyChatGptClientMetadata(); }
  private current() { if (!this.state) throw new Error("Public authentication was not initialized."); return this.state; }
  private async reload() { this.state = await this.store.load(); this.clean(); }
  private async serialized<T>(work: () => Promise<T>) { let release!: () => void; const next = new Promise<void>((resolve) => { release = resolve; }); const previous = this.mutationTail; this.mutationTail = next; await previous; try { return await work(); } finally { release(); } }
  hasAllowedSubject() { return this.current().allowedSubjects.length > 0; }
  private async verifyChatGptClientMetadata() {
    const response = await this.request(CHATGPT_CLIENT_ID, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    const document = await boundedJson(response);
    const redirects = Array.isArray(document.redirect_uris) ? document.redirect_uris : [];
    const methods = Array.isArray(document.token_endpoint_auth_methods_supported) ? document.token_endpoint_auth_methods_supported : [document.token_endpoint_auth_method];
    if (document.client_id !== CHATGPT_CLIENT_ID || !redirects.includes(CHATGPT_REDIRECT_URI) || !methods.includes("none")) throw new Error("The ChatGPT client metadata was invalid.");
    const maxAge = /max-age=(\d+)/i.exec(response.headers.get("cache-control") ?? "")?.[1];
    this.clientMetadataExpires = this.now() + Math.min(60 * 60_000, Math.max(60_000, Number(maxAge ?? 300) * 1000));
  }
  private async persist() { await this.store.save(this.current()); }
  private clean() { const now = this.now(); for (const [key, value] of this.transactions) if (value.expires <= now) this.transactions.delete(key); for (const [key, value] of this.codes) if (value.expires <= now) this.codes.delete(key); const state = this.current(); state.refreshes = state.refreshes.filter((token) => token.expires > now); }
  cookie(transaction: string) { const sig = createHmac("sha256", this.cfg.tokenSecret).update(transaction).digest("base64url"); return `${transaction}.${sig}`; }
  validCookie(value: string | undefined, transaction: string) { return Boolean(value && same(value, this.cookie(transaction))); }
  async begin(input: { clientId: string; redirectUri: string; resource: string; state?: string; challenge: string }): Promise<{ redirect: string; cookie: string }> {
    if (this.clientMetadataExpires <= this.now()) await this.verifyChatGptClientMetadata();
    this.clean(); const transaction: Transaction = { id: this.makeId(), googleState: this.makeId(), nonce: this.makeId(), ...input, expires: this.now() + TRANSACTION_TTL }; this.transactions.set(transaction.id, transaction);
    return { redirect: this.verifier.authorizationUrl({ redirectUri: this.cfg.googleRedirectUri, state: transaction.googleState, nonce: transaction.nonce }), cookie: this.cookie(transaction.id) };
  }
  private redirectFor(transaction: Transaction, values: Record<string, string>) { const redirect = new URL(transaction.redirectUri); for (const [key, value] of Object.entries(values)) redirect.searchParams.set(key, value); if (transaction.state) redirect.searchParams.set("state", transaction.state); redirect.searchParams.set("iss", this.cfg.baseUrl); return redirect.toString(); }
  async googleCallback(input: { state: string; code?: string; error?: string; cookie?: string }): Promise<{ redirect?: string; transaction?: string; error?: string }> {
    this.clean(); const transaction = [...this.transactions.values()].find((item) => item.googleState === input.state); if (!transaction || !this.validCookie(input.cookie, transaction.id)) return { error: "The sign-in session was invalid." };
    if (transaction.subject || transaction.googleCallbackStarted) return { error: "The sign-in session was already used." };
    if (input.error || !input.code) { this.transactions.delete(transaction.id); return { redirect: this.redirectFor(transaction, { error: "access_denied" }) }; }
    transaction.googleCallbackStarted = true;
    try { transaction.subject = await this.verifier.exchangeCode({ code: input.code, redirectUri: this.cfg.googleRedirectUri, state: transaction.googleState, nonce: transaction.nonce }); }
    catch { this.transactions.delete(transaction.id); return { redirect: this.redirectFor(transaction, { error: "access_denied" }) }; }
    if (!this.allowed(transaction.subject)) { this.transactions.delete(transaction.id); return { redirect: this.redirectFor(transaction, { error: "access_denied" }) }; }
    return { transaction: transaction.id };
  }
  consent(input: { transaction: string; cookie?: string; allow: boolean }): { redirect?: string; error?: string } {
    this.clean(); const transaction = this.transactions.get(input.transaction); this.transactions.delete(input.transaction);
    if (!transaction || !transaction.subject || !this.validCookie(input.cookie, transaction.id)) return { error: "The authorization request was invalid." };
    if (!input.allow) return { redirect: this.redirectFor(transaction, { error: "access_denied" }) };
    const code = this.makeId(); this.codes.set(code, { ...transaction, subject: transaction.subject, expires: this.now() + CODE_TTL });
    return { redirect: this.redirectFor(transaction, { code }) };
  }
  private allowed(subject: GoogleIdentity) { return this.current().allowedSubjects.some((item) => item.iss === subject.iss && item.sub === subject.sub); }
  async addAllowedSubject(subject: GoogleIdentity): Promise<void> { await this.serialized(async () => { await this.reload(); const state = this.current(); if (!this.allowed(subject)) state.allowedSubjects.push(subject); state.epoch += 1; await this.persist(); }); }
  private sign(body: object) { const encoded = Buffer.from(JSON.stringify(body)).toString("base64url"); return `${encoded}.${createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url")}`; }
  private verify(token: string): Record<string, unknown> | undefined { const [encoded, signature, extra] = token.split("."); if (!encoded || !signature || extra || !same(createHmac("sha256", this.cfg.tokenSecret).update(encoded).digest("base64url"), signature)) return undefined; try { const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; } catch { return undefined; } }
  private async issue(subject: GoogleIdentity, clientId: string, resource: string, scope: "mcp", family = this.makeId()) {
    const state = this.current(); this.clean(); if (state.refreshes.length >= MAX_REFRESHES) { await this.persist(); if (state.refreshes.length >= MAX_REFRESHES) throw new Error("The refresh-token store is full."); }
    state.families[family] = { active: true, epoch: state.epoch };
    const refresh = this.makeId(); state.refreshes.push({ hash: digest(refresh), family, subject, clientId, resource, scope, expires: this.now() + REFRESH_TTL }); await this.persist();
    const access = this.sign({ type: "access", iss: this.cfg.baseUrl, sub: subject.sub, google_iss: subject.iss, aud: resource, client_id: clientId, scope, epoch: state.epoch, family, iat: Math.floor(this.now() / 1000), nbf: Math.floor(this.now() / 1000), exp: Math.floor(this.now() / 1000) + ACCESS_TTL });
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_TTL, scope };
  }
  async token(input: { grantType: string; code?: string; verifier?: string; clientId: string; redirectUri?: string; resource?: string; refreshToken?: string }) { return this.serialized(async () => this.tokenUnlocked(input)); }
  private async tokenUnlocked(input: { grantType: string; code?: string; verifier?: string; clientId: string; redirectUri?: string; resource?: string; refreshToken?: string }) {
    await this.reload();
    this.clean(); if (input.grantType === "authorization_code") {
      const code = input.code ?? ""; const authorization = this.codes.get(code); this.codes.delete(code);
      const verifier = input.verifier ?? "";
      if (!authorization || authorization.expires <= this.now() || authorization.clientId !== input.clientId || authorization.redirectUri !== input.redirectUri || authorization.resource !== input.resource || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) || !same(digest(verifier), authorization.challenge)) return { error: "invalid_grant" as const };
      return this.issue(authorization.subject, authorization.clientId, authorization.resource, "mcp");
    }
    if (input.grantType !== "refresh_token" || !input.refreshToken || input.resource !== `${this.cfg.baseUrl}/mcp`) return { error: "invalid_grant" as const };
    const state = this.current(); const item = state.refreshes.find((token) => same(token.hash, digest(input.refreshToken!)));
    if (!item || item.clientId !== input.clientId || item.resource !== input.resource || item.expires <= this.now() || !this.allowed(item.subject) || state.families[item.family]?.active !== true || state.families[item.family]?.epoch !== state.epoch) return { error: "invalid_grant" as const };
    if (item.used) { state.families[item.family].active = false; await this.persist(); return { error: "invalid_grant" as const }; }
    item.used = true; return this.issue(item.subject, item.clientId, item.resource, item.scope, item.family);
  }
  async authenticate(header?: string): Promise<string | undefined> {
    await this.reload(); if (!header?.startsWith("Bearer ")) return undefined; const token = this.verify(header.slice(7)); const state = this.current();
    if (!token || token.type !== "access" || token.iss !== this.cfg.baseUrl || token.aud !== `${this.cfg.baseUrl}/mcp` || token.scope !== "mcp" || typeof token.sub !== "string" || typeof token.google_iss !== "string" || typeof token.exp !== "number" || typeof token.epoch !== "number" || typeof token.family !== "string" || token.exp <= Math.floor(this.now() / 1000) || token.epoch !== state.epoch || state.families[token.family]?.active !== true || state.families[token.family]?.epoch !== state.epoch || !this.allowed({ iss: token.google_iss, sub: token.sub })) return undefined;
    return `google:${token.google_iss}:${token.sub}`;
  }
}
