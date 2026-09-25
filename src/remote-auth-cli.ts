import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { configFromEnv } from "./index.js";
import { GoogleOidcClient, PublicAuthService } from "./public-auth.js";
import { assertPrivateFile, assertSafePrivateParent, createPrivateFile, ensurePrivateDirectory } from "./private-storage.js";

const LOCAL_CALLBACK = "http://localhost:8765/callback";
const current = process.cwd();
const inside = (parent: string, candidate: string) => { const relative = path.relative(parent, candidate); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
const argument = (name: string) => { const position = process.argv.indexOf(name); return position >= 0 ? process.argv[position + 1] : undefined; };
const ask = async (prompt: string) => { const terminal = createInterface({ input, output }); try { return (await terminal.question(prompt)).trim(); } finally { terminal.close(); } };
const secret = () => randomBytes(32).toString("base64url");

async function configure(source: string) {
  const raw: unknown = JSON.parse(await readFile(path.resolve(source), "utf8"));
  const client = typeof raw === "object" && raw !== null && "web" in raw ? (raw as { web?: unknown }).web : undefined;
  if (typeof client !== "object" || client === null || typeof (client as { client_id?: unknown }).client_id !== "string" || typeof (client as { client_secret?: unknown }).client_secret !== "string") throw new Error("The Google Web OAuth client JSON is invalid.");
  const baseUrl = (argument("--base-url") ?? process.env.BASE_URL ?? await ask("Public BASE_URL (https://…): ")).replace(/\/$/, "");
  const parsed = new URL(baseUrl); if (parsed.protocol !== "https:") throw new Error("The public BASE_URL must use HTTPS.");
  const requestedRoot = path.resolve(argument("--root") ?? path.join(os.homedir(), "RemoteDesktopWorkspace"));
  const requestedDataDir = path.resolve(argument("--data-dir") ?? path.join(os.homedir(), "RemoteDesktopMCP-data"));
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 }); await ensurePrivateDirectory(requestedDataDir);
  const root = await realpath(requestedRoot); const dataDir = await realpath(requestedDataDir);
  const envPath = path.join(current, ".env"); const sourcePath = await realpath(path.resolve(source));
  if (overlaps(root, dataDir) || inside(root, envPath) || inside(root, sourcePath)) throw new Error("The permitted workspace must not contain DATA_DIR, .env, or the Google client JSON.");
  const lines = [
    `BASE_URL=${baseUrl}`, "PORT=3000", "REMOTE_AUTH_MODE=google", `TOKEN_SECRET=${secret()}`,
    `GOOGLE_CLIENT_ID=${(client as { client_id: string }).client_id}`, `GOOGLE_CLIENT_SECRET=${(client as { client_secret: string }).client_secret}`, `GOOGLE_REDIRECT_URI=${baseUrl}/google/callback`, `GOOGLE_LOCAL_REDIRECT_URI=${LOCAL_CALLBACK}`,
    `FILE_ROOTS_JSON=${JSON.stringify([{ id: "workspace", path: root }])}`, `DATA_DIR=${dataDir}`, "LOCAL_NODE_ID=local", "LOCAL_NODE_LABEL=This PC", "TRANSFER_CHUNK_BYTES=131072",
  ];
  await createPrivateFile(envPath, `${lines.join("\n")}\n`);
  console.log("Created .env with Google mode. Keep the Google client JSON and .env outside the permitted workspace.");
}

async function authorizeGoogle() {
  const envPath = path.join(current, ".env"); await assertSafePrivateParent(path.dirname(envPath)); await assertPrivateFile(envPath); process.loadEnvFile(envPath); const cfg = configFromEnv();
  const publicAuth = cfg.publicAuth; if (!publicAuth) throw new Error("REMOTE_AUTH_MODE=google is required.");
  const callback = process.env.GOOGLE_LOCAL_REDIRECT_URI ?? LOCAL_CALLBACK;
  if (callback !== LOCAL_CALLBACK) throw new Error(`GOOGLE_LOCAL_REDIRECT_URI must be ${LOCAL_CALLBACK}.`);
  const state = secret(); const nonce = secret(); const oidc = new GoogleOidcClient(publicAuth.googleClientId, publicAuth.googleClientSecret);
  let handled = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", LOCAL_CALLBACK);
      if (handled || url.pathname !== "/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) { res.writeHead(400, { "cache-control": "no-store" }).end("Registration was rejected."); return; }
      handled = true;
      const identity = await oidc.exchangeCode({ code: url.searchParams.get("code")!, redirectUri: callback, state, nonce });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end("Identity verified. Return to the terminal on this PC and type approve to finish registration.");
      const answer = await ask(`Approve Google subject ${identity.iss} / ${identity.sub} for this PC? Type approve: `);
      if (answer !== "approve") throw new Error("Approval was not confirmed.");
      const auth = new PublicAuthService(publicAuth); await auth.initialize(); await auth.addAllowedSubject(identity, { replace: process.argv.includes("--replace") }); console.log("The Google subject was approved. Restart the service before connecting ChatGPT.");
      server.close();
    } catch { if (!res.headersSent) res.writeHead(400, { "cache-control": "no-store" }).end("Registration could not be completed."); server.close(); process.exitCode = 1; }
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(8765, "localhost", resolve));
  const url = oidc.authorizationUrl({ redirectUri: callback, state, nonce });
  console.log(`Open this Google sign-in URL in a browser on this PC:\n${url}`);
  const opened = spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true });
  opened.once("error", () => console.warn("Browser did not start automatically. Open the displayed URL manually in a browser on this PC."));
  opened.unref();
  setTimeout(() => { if (server.listening) { console.error("Google registration timed out before a verified approval."); process.exitCode = 1; server.close(); } }, 5 * 60_000).unref();
  await new Promise<void>((resolve) => server.once("close", resolve));
}

const command = process.argv[2];
if (command === "configure" && process.argv[3]) await configure(process.argv[3]);
else if (command === "authorize-google") await authorizeGoogle();
else console.error("Usage: npm run remote-auth -- configure <google-client.json> [--base-url https://host] [--root path] | authorize-google");
