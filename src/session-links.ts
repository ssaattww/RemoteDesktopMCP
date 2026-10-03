import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

export type SessionLinkTitleSource = "manual" | "fetched";
export type SessionLinkTitleStatus = "pending" | "resolved" | "failed" | "not_requested";
export type SessionLink = {
  externalUrl?: string;
  externalTitle?: string;
  externalTitleSource?: SessionLinkTitleSource;
  externalTitleStatus: SessionLinkTitleStatus;
  linkRevision: number;
};
export type SessionLinkInput = { url?: string; title?: string };
export type SessionLinkUpdate = { link: SessionLink; shouldFetch: boolean };
export type SessionLinkOwnerState = SessionLink & { id: string; user: string; expires: number; state: "active" | "expired" | "closed" };
export type SessionLinkFetchLease = { id: string; user: string; url: string; revision: number };

export type SessionLinkTransport = {
  resolve: (hostname: string) => Promise<string[]>;
  request: (url: URL, address: string, headers: Record<string, string>, signal: AbortSignal) => Promise<{ status: number; location?: string; contentType?: string; contentLength?: string; body: Uint8Array }>;
};

const MAX_URL_CODE_POINTS = 2_048;
const MAX_TITLE_CODE_POINTS = 200;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_LIMIT = 4;
const DNS_LIMIT = 4;
const DEADLINE_MS = 8_000;
const timeoutError = () => new Error("External title retrieval timed out.");

function codePoints(value: string): number { return [...value].length; }

function inCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/");
  const family = isIP(address);
  if (!network || family !== isIP(network)) return false;
  const prefix = Number(prefixText);
  const bits = family === 4 ? 32 : 128;
  const parse = (value: string): bigint => family === 4
    ? value.split(".").reduce((sum, part) => (sum << 8n) | BigInt(Number(part)), 0n)
    : value.toLowerCase().split(":").reduce((sum, part) => (sum << 16n) | BigInt(part ? Number.parseInt(part, 16) : 0), 0n);
  // IPv6 textual compression is expanded by URL/DNS implementations differently;
  // use URL's canonical serializer before numeric comparison.
  const canonical = (value: string) => family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
  const expand6 = (value: string): bigint => {
    const words = canonical(value).split(":");
    const marker = words.indexOf("");
    const expanded = marker < 0 ? words : [...words.slice(0, marker), ...Array(8 - (words.length - 1)).fill("0"), ...words.slice(marker + 1)];
    return expanded.reduce((sum, part) => (sum << 16n) | BigInt(Number.parseInt(part || "0", 16)), 0n);
  };
  const value = family === 4 ? parse(address) : expand6(address);
  const base = family === 4 ? parse(network) : expand6(network);
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (base >> shift);
}

const IPV4_DENY = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16", "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"];
const IPV6_DENY = ["2001::/23", "2001:db8::/32", "2002::/16", "2620:4f:8000::/48", "3fff::/20", "5f00::/16"];

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !IPV4_DENY.some((cidr) => inCidr(address, cidr));
  if (family !== 6 || address.includes(".") || address.includes("%") || !inCidr(address, "2000::/3")) return false;
  if (["::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64"].some((cidr) => inCidr(address, cidr))) return false;
  return !IPV6_DENY.some((cidr) => inCidr(address, cidr));
}

function normalizedUrl(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const value = input.trim();
  if (codePoints(value) > MAX_URL_CODE_POINTS) throw new Error("URL exceeds the supported length.");
  if (!value || [...value].some((character) => { const code = character.codePointAt(0)!; return code <= 0x20 || code === 0x7f; })) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    if (parsed.port && parsed.port !== (parsed.protocol === "https:" ? "443" : "80")) return undefined;
    if (parsed.port) return undefined;
    const host = parsed.hostname.startsWith("[") ? parsed.hostname.slice(1, -1) : parsed.hostname;
    if (isIP(host)) {
      if (!isPublicAddress(host)) return undefined;
    } else if (!host.includes(".") || /\.(?:localhost|local|internal|lan|test|invalid|example)$/iu.test(host) || host === "home.arpa" || host.endsWith(".home.arpa") || host.endsWith(".")) return undefined;
    if (codePoints(parsed.href) > MAX_URL_CODE_POINTS) throw new Error("URL exceeds the supported length.");
    return parsed.href;
  } catch { return undefined; }
}

function normalizedTitle(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const value = input.trim();
  if (codePoints(value) > MAX_TITLE_CODE_POINTS) throw new Error("Title exceeds the supported length.");
  return value || undefined;
}

export function createSessionLink(input: SessionLinkInput): SessionLink {
  const externalUrl = normalizedUrl(input.url);
  const externalTitle = normalizedTitle(input.title);
  const hasUrl = Boolean(input.url?.trim());
  return {
    externalUrl,
    externalTitle,
    externalTitleSource: externalTitle ? "manual" : undefined,
    externalTitleStatus: externalTitle ? "not_requested" : externalUrl ? "pending" : hasUrl ? "failed" : "not_requested",
    linkRevision: 0,
  };
}

export function updateSessionLink(current: SessionLink, input: SessionLinkInput): SessionLinkUpdate {
  const externalUrl = input.url === undefined ? current.externalUrl : normalizedUrl(input.url);
  const urlChanged = externalUrl !== current.externalUrl;
  const explicitlyClearedTitle = input.title !== undefined && !normalizedTitle(input.title);
  const suppliedTitle = input.title === undefined ? undefined : normalizedTitle(input.title);
  let externalTitle = current.externalTitle;
  let externalTitleSource = current.externalTitleSource;
  let externalTitleStatus = current.externalTitleStatus;
  let shouldFetch = false;

  if (suppliedTitle !== undefined) {
    externalTitle = suppliedTitle;
    externalTitleSource = "manual";
    externalTitleStatus = "not_requested";
  } else if (explicitlyClearedTitle) {
    externalTitle = undefined;
    externalTitleSource = undefined;
    externalTitleStatus = externalUrl ? "pending" : "not_requested";
    shouldFetch = Boolean(externalUrl);
  } else if (urlChanged) {
    if (current.externalTitleSource === "fetched") {
      externalTitle = undefined;
      externalTitleSource = undefined;
      externalTitleStatus = externalUrl ? "pending" : "not_requested";
      shouldFetch = Boolean(externalUrl);
    } else if (current.externalTitleSource === "manual") {
      externalTitleStatus = "not_requested";
    } else {
      externalTitle = undefined;
      externalTitleSource = undefined;
      externalTitleStatus = externalUrl ? "pending" : "not_requested";
      shouldFetch = Boolean(externalUrl);
    }
  }

  const semanticChange = urlChanged || externalTitle !== current.externalTitle || externalTitleSource !== current.externalTitleSource || externalTitleStatus !== current.externalTitleStatus || shouldFetch;
  if (!semanticChange) return { link: current, shouldFetch: false };
  return {
    link: {
      externalUrl,
      externalTitle,
      externalTitleSource,
      externalTitleStatus,
      linkRevision: current.linkRevision + 1,
    },
    shouldFetch,
  };
}

export function captureSessionLinkFetchLease(session: SessionLinkOwnerState): SessionLinkFetchLease | undefined {
  if (session.state !== "active" || !session.externalUrl || session.externalTitleStatus !== "pending" || session.externalTitleSource === "manual") return undefined;
  return { id: session.id, user: session.user, url: session.externalUrl, revision: session.linkRevision };
}

export function applySessionLinkFetchResult(session: SessionLinkOwnerState, lease: SessionLinkFetchLease, title?: string, now = Date.now()): boolean {
  if (session.id !== lease.id || session.user !== lease.user || session.state !== "active" || session.expires <= now || session.externalUrl !== lease.url || session.linkRevision !== lease.revision || session.externalTitleStatus !== "pending" || session.externalTitleSource === "manual") return false;
  const safeTitle = title === undefined ? undefined : normalizedTitle(title);
  if (safeTitle) {
    session.externalTitle = safeTitle;
    session.externalTitleSource = "fetched";
    session.externalTitleStatus = "resolved";
  } else {
    session.externalTitle = undefined;
    session.externalTitleSource = undefined;
    session.externalTitleStatus = "failed";
  }
  return true;
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }> = [];
  constructor(private readonly limit: number) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(timeoutError());
    if (this.active < this.limit) { this.active += 1; return Promise.resolve(this.releaseOnce()); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => undefined };
      waiter.abort = () => { const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); reject(timeoutError()); };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.queue.length) {
        const next = this.queue.shift()!;
        next.signal.removeEventListener("abort", next.abort);
        if (next.signal.aborted) { next.reject(timeoutError()); continue; }
        next.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

const defaultTransport: SessionLinkTransport = {
  resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
  request: (url, address, headers, signal) => new Promise((resolve, reject) => {
    const family = isIP(address);
    const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = requester(url, {
      method: "GET",
      headers,
      agent: false,
      signal,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      ...(url.protocol === "https:" && !isIP(url.hostname.replace(/^\[|\]$/gu, "")) ? { servername: url.hostname } : {}),
      maxHeaderSize: 16 * 1024,
    }, (response) => {
      response.once("error", reject);
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : undefined;
      const contentLength = typeof response.headers["content-length"] === "string" ? response.headers["content-length"] : undefined;
      if (contentLength !== undefined && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
        response.destroy(new Error("Response body exceeds the supported size."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) { request.destroy(new Error("Response body exceeds the supported size.")); return; }
        chunks.push(bytes);
      });
      response.once("end", () => resolve({ status, location, contentType, contentLength, body: Buffer.concat(chunks, size) }));
    });
    request.once("error", reject);
    request.end();
  }),
};

const fetchSlots = new Semaphore(FETCH_LIMIT);
const dnsSlots = new Semaphore(DNS_LIMIT);

function raceDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function decodeTitle(body: Uint8Array): string {
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("Response body exceeds the supported size.");
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(body); }
  catch { throw new Error("Response body is not valid UTF-8."); }
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/iu.exec(html);
  if (!match) throw new Error("HTML title is missing.");
  const value = match[1]!.replace(/<[^>]*>/gu, "").replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([\da-f]+);/giu, (entity, name: string | undefined, decimal: string | undefined, hexadecimal: string | undefined) => {
    if (name) return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" })[name.toLowerCase()]!;
    if (decimal) return decodeCodePoint(Number(decimal));
    if (hexadecimal) return decodeCodePoint(Number.parseInt(hexadecimal, 16));
    return entity;
  }).trim();
  if (!value || codePoints(value) > MAX_TITLE_CODE_POINTS) throw new Error("HTML title is empty or exceeds the supported length.");
  return value;
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) throw new Error("HTML title contains an invalid character reference.");
  return String.fromCodePoint(value);
}

function isUtf8HtmlContentType(value: string | undefined): boolean {
  if (!value || !/^text\/html(?:\s*;|\s*$)/iu.test(value)) return false;
  const separator = value.indexOf(";");
  if (separator < 0) return true;
  const parameters: string[] = [];
  let start = separator + 1;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === ";") {
      parameters.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted || escaped) return false;
  parameters.push(value.slice(start));
  let charsetSeen = false;
  for (const parameter of parameters) {
    const equals = parameter.indexOf("=");
    const name = (equals < 0 ? parameter : parameter.slice(0, equals)).trim().toLowerCase();
    if (name !== "charset") continue;
    if (equals < 0 || charsetSeen) return false;
    const rawValue = parameter.slice(equals + 1).trim();
    let charset: string;
    if (rawValue.startsWith('"')) {
      if (!/^"[^"]*"$/u.test(rawValue)) return false;
      charset = rawValue.slice(1, -1);
    } else {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(rawValue)) return false;
      charset = rawValue;
    }
    if (charset.toLowerCase() !== "utf-8") return false;
    charsetSeen = true;
  }
  return true;
}

export async function fetchSessionLinkTitle(rawUrl: string, options: { transport?: SessionLinkTransport; deadlineMs?: number } = {}): Promise<string> {
  const safeUrl = normalizedUrl(rawUrl);
  if (!safeUrl) throw new Error("URL is not eligible for external title retrieval.");
  const transport = options.transport ?? defaultTransport;
  const timeoutMs = Math.min(options.deadlineMs ?? DEADLINE_MS, DEADLINE_MS);
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let releaseFetch: (() => void) | undefined;
  try {
    releaseFetch = await raceDeadline(fetchSlots.acquire(controller.signal), controller.signal);
    let current = new URL(safeUrl);
    for (let redirects = 0; ; redirects += 1) {
      if (performance.now() >= deadline) throw timeoutError();
      const hostname = current.hostname.startsWith("[") ? current.hostname.slice(1, -1) : current.hostname;
      let addresses: string[];
      if (isIP(hostname)) addresses = [hostname];
      else {
        const releaseDns = await raceDeadline(dnsSlots.acquire(controller.signal), controller.signal);
        const dnsPromise = Promise.resolve().then(() => transport.resolve(hostname)).finally(releaseDns);
        addresses = await raceDeadline(dnsPromise, controller.signal);
      }
      if (performance.now() >= deadline) throw timeoutError();
      if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new Error("DNS resolved to a prohibited address.");
      const address = addresses[0]!;
      const requestUrl = new URL(current.href);
      requestUrl.hash = "";
      const requestPromise = transport.request(requestUrl, address, {
        Accept: "text/html",
        "Accept-Encoding": "identity",
        Connection: "close",
        "User-Agent": "RemoteDesktopMCP-title-fetch/1.0",
      }, controller.signal);
      const response = await raceDeadline(requestPromise, controller.signal);
      if (performance.now() >= deadline) throw timeoutError();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.location || redirects >= MAX_REDIRECTS) throw new Error("Redirect limit exceeded.");
        const target = normalizedUrl(new URL(response.location, current).href);
        if (!target) throw new Error("Redirect target is not eligible.");
        const next = new URL(target);
        if (current.protocol === "https:" && next.protocol !== "https:") throw new Error("HTTPS downgrade redirect is prohibited.");
        current = next;
        continue;
      }
      if (response.status !== 200) throw new Error("External title response was not successful.");
      if (response.contentLength !== undefined && (!/^\d+$/u.test(response.contentLength) || Number(response.contentLength) > MAX_BODY_BYTES)) throw new Error("Response body exceeds the supported size.");
      if (!isUtf8HtmlContentType(response.contentType)) throw new Error("Response is not UTF-8 HTML.");
      return decodeTitle(response.body);
    }
  } finally {
    clearTimeout(timer);
    releaseFetch?.();
  }
}
