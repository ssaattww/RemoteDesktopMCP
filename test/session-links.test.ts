import assert from "node:assert/strict";
import { createServer } from "node:http";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import { test } from "node:test";
import { applySessionLinkFetchResult, captureSessionLinkFetchLease, createSessionLink, fetchSessionLinkTitle, requestPinnedSessionLink, updateSessionLink, type SessionLinkOwnerState, type SessionLinkTransport } from "../src/session-links.js";

const publicIpv4 = "93.184.216.34";

function transport(responses: Array<{ status: number; location?: string; contentType?: string; body?: string }>, lookups?: Record<string, string[]>): SessionLinkTransport & { requests: Array<{ url: string; address: string; headers: Record<string, string> }> } {
  const requests: Array<{ url: string; address: string; headers: Record<string, string> }> = [];
  return {
    resolve: async (hostname) => lookups?.[hostname] ?? [publicIpv4],
    request: async (url, address, headers, _signal) => {
      requests.push({ url: url.href, address, headers });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return { ...response, body: new TextEncoder().encode(response.body ?? "") };
    },
    requests,
  };
}

test("normalizes only safe HTTP(S) links and preserves optional title source contract", () => {
  const link = createSessionLink({ url: " https://example.com/path#part ", title: "  Work item  " });
  assert.equal(link.externalUrl, "https://example.com/path#part");
  assert.equal(link.externalTitle, "Work item");
  assert.equal(link.externalTitleSource, "manual");
  assert.equal(link.externalTitleStatus, "not_requested");
  assert.equal(link.linkRevision, 0);
  assert.equal(createSessionLink({ url: "http://127.0.0.1/" }).externalUrl, undefined);
  assert.equal(createSessionLink({ url: "http://home.arpa/" }).externalUrl, undefined);
  assert.equal(createSessionLink({ url: "http://router.home.arpa/" }).externalUrl, undefined);
  assert.equal(createSessionLink({ url: "http://child.router.home.arpa/" }).externalUrl, undefined);
  assert.equal(createSessionLink({ url: "https://user:secret@example.com/" }).externalUrl, undefined);
  assert.throws(() => createSessionLink({ url: `https://example.com/${"x".repeat(2048)}` }), /URL/i);
  assert.throws(() => createSessionLink({ title: "x".repeat(201) }), /title/i);
});

test("updates distinguish same-text manual conversion from true no-op", () => {
  const before = { ...createSessionLink({ url: "https://example.com/" }), externalTitle: "Same", externalTitleSource: "fetched" as const, externalTitleStatus: "resolved" as const };
  const converted = updateSessionLink(before, { title: "Same" });
  assert.equal(converted.link.externalTitleSource, "manual");
  assert.equal(converted.link.linkRevision, 1);
  assert.equal(converted.shouldFetch, false);
  const noop = updateSessionLink(converted.link, { title: "Same" });
  assert.equal(noop.link, converted.link);
  assert.equal(noop.link.linkRevision, 1);
  const blanked = updateSessionLink(converted.link, { title: "" });
  assert.equal(blanked.link.externalTitle, undefined);
  assert.equal(blanked.link.externalTitleStatus, "pending");
  assert.equal(blanked.shouldFetch, true);
  assert.equal(blanked.link.linkRevision, 2);
  const urlChanged = updateSessionLink(createSessionLink({ url: "https://example.com/old" }), { url: "https://example.com/new" });
  assert.equal(urlChanged.shouldFetch, true, "a URL-only edit with no title must fetch the new URL");
  assert.equal(urlChanged.link.externalTitleStatus, "pending");
  const applied = { ...before };
  Object.assign(applied, updateSessionLink(before, { url: "https://example.com/new" }).link);
  assert.equal(applied.externalUrl, "https://example.com/new");
  assert.equal(applied.externalTitle, undefined, "assigning the contract result must clear a fetched title");
  assert.equal(applied.externalTitleSource, undefined);
});

test("fetches a bounded UTF-8 HTML title through a pinned public address without credentials", async () => {
  const fake = transport([{ status: 200, contentType: "text/html; charset=utf-8", body: "<html><title>A &amp; B</title></html>" }]);
  assert.equal(await fetchSessionLinkTitle("https://example.com/x#no-send", { transport: fake }), "A & B");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]?.url, "https://example.com/x");
  assert.equal(fake.requests[0]?.address, publicIpv4);
  assert.equal(fake.requests[0]?.headers.Connection, "close");
  assert.equal(Object.keys(fake.requests[0]!.headers).some((key) => /cookie|authorization|referer/i.test(key)), false);
});

test("pinned HTTP transport honors Node autoSelectFamily lookup contract using only the selected IP", async () => {
  const previousAutoSelectFamily = getDefaultAutoSelectFamily();
  setDefaultAutoSelectFamily(true);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<title>local fixture</title>");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await requestPinnedSessionLink(
      new URL(`http://example.com:${address.port}/`),
      "127.0.0.1",
      { Connection: "close" },
      new AbortController().signal,
    );
    assert.equal(result.status, 200);
    assert.match(new TextDecoder().decode(result.body), /local fixture/u);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    setDefaultAutoSelectFamily(previousAutoSelectFamily);
  }
});

test("accepts quoted UTF-8 charset parameters and rejects malformed or other charsets", async () => {
  const quoted = transport([{ status: 200, contentType: 'text/html; charset="UTF-8"', body: "<title>Quoted UTF-8</title>" }]);
  assert.equal(await fetchSessionLinkTitle("https://example.com/", { transport: quoted }), "Quoted UTF-8");
  const additionalParameter = transport([{ status: 200, contentType: 'text/html; note="contains; charset=latin1"; charset="utf-8"', body: "<title>Quoted parameter</title>" }]);
  assert.equal(await fetchSessionLinkTitle("https://example.com/", { transport: additionalParameter }), "Quoted parameter");
  for (const contentType of [
    'text/html; charset="utf-16"',
    'text/html; charset="utf-8',
    "text/html; charset='utf-8'",
    "text/html; charset=utf-8x",
    "text/html; charset=utf-8; charset=latin1",
  ]) {
    await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: transport([{ status: 200, contentType, body: "<title>must reject</title>" }]) }), /UTF-8 HTML/i, contentType);
  }
});

test("validates every redirect and does not contact private destinations", async () => {
  const redirect = transport([{ status: 302, location: "https://privately-resolved.com/" }], { "example.com": [publicIpv4], "privately-resolved.com": ["10.0.0.4"] });
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: redirect }), /address|destination|network/i);
  assert.equal(redirect.requests.length, 1);
  const mixed = transport([{ status: 200, contentType: "text/html", body: "<title>must not connect</title>" }], { "example.com": [publicIpv4, "10.0.0.4"] });
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: mixed }), /address|destination|network/i);
  assert.equal(mixed.requests.length, 0, "one prohibited DNS answer rejects the whole name");
  const downgrade = transport([{ status: 302, location: "http://example.com/plain" }]);
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: downgrade }), /downgrade/i);
  assert.equal(downgrade.requests.length, 1, "the HTTP downgrade target is never contacted");
  const tooMany = transport(Array.from({ length: 4 }, (_, i) => ({ status: 302, location: `/next${i}` })));
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: tooMany }), /redirect/i);
  assert.equal(tooMany.requests.length, 4);
});

test("rejects special-use IPv4 and IPv6 DNS answers while pinning a public answer", async () => {
  const prohibited = [
    "0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.1.1", "192.175.48.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:192.0.2.1", "64:ff9b::1", "64:ff9b:1::1", "100::1", "2001::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "2620:4f:8000::1", "fc00::1", "fe80::1", "ff02::1",
  ];
  for (const address of prohibited) {
    const fake = transport([{ status: 200, contentType: "text/html", body: "<title>must not connect</title>" }], { "example.com": [address] });
    await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: fake }), undefined, address);
    assert.equal(fake.requests.length, 0, address);
  }
  const globalV6 = transport([{ status: 200, contentType: "text/html", body: "<title>Public</title>" }], { "example.com": ["2606:4700:4700::1111"] });
  assert.equal(await fetchSessionLinkTitle("https://example.com/", { transport: globalV6 }), "Public");
  assert.equal(globalV6.requests[0]?.address, "2606:4700:4700::1111");
});

test("rejects non-HTML, oversized and invalid UTF-8 responses", async () => {
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: transport([{ status: 200, contentType: "text/plain", body: "<title>x</title>" }]) }), /HTML|content/i);
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: transport([{ status: 200, contentType: "text/html", body: `<title>${"x".repeat(262_145)}</title>` }]) }), /size|large|limit/i);
  const invalid = transport([{ status: 200, contentType: "text/html", body: "<title>x</title>" }]);
  invalid.request = async (url, address, headers, signal) => {
    invalid.requests.push({ url: url.href, address, headers });
    return { status: 200, contentType: "text/html", body: Uint8Array.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0xff]) };
  };
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: invalid }), /UTF-8|encoding|title/i);
  await assert.rejects(fetchSessionLinkTitle("https://example.com/", { transport: {
    resolve: async () => [publicIpv4],
    request: async () => ({ status: 200, contentType: "text/html", contentLength: "262145", body: new TextEncoder().encode("<title>x</title>") }),
  } }), /size|large|limit/i);
  const escapedOnce = transport([{ status: 200, contentType: "text/html", body: "<title>&amp;#65;</title>" }]);
  assert.equal(await fetchSessionLinkTitle("https://example.com/", { transport: escapedOnce }), "&#65;");
});

test("applies a single total deadline and abandons late DNS results", async () => {
  let finishDns!: (addresses: string[]) => void;
  let requestCount = 0;
  const pending = fetchSessionLinkTitle("https://example.com/", { deadlineMs: 25, transport: {
    resolve: () => new Promise((resolve) => { finishDns = resolve; }),
    request: async () => { requestCount += 1; return { status: 200, contentType: "text/html", body: new TextEncoder().encode("<title>late</title>") }; },
  } });
  await assert.rejects(pending, /timed out/i);
  finishDns([publicIpv4]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 0);
});

test("bounds simultaneously accepted retrievals at four process slots", async () => {
  let active = 0;
  let maximum = 0;
  const makeTransport = (): SessionLinkTransport => ({
    resolve: async () => [publicIpv4],
    request: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: 200, contentType: "text/html", body: new TextEncoder().encode("<title>bounded</title>") };
    },
  });
  await Promise.all(Array.from({ length: 8 }, () => fetchSessionLinkTitle("https://example.com/", { transport: makeTransport() })));
  assert.equal(maximum, 4);
});

test("late fetch results cannot overwrite a changed, closed, expired or differently-owned session", () => {
  const link = createSessionLink({ url: "https://example.com/" });
  const session: SessionLinkOwnerState = { id: "session-id", user: "owner@example.test", expires: Date.now() + 10_000, state: "active", ...link };
  const lease = captureSessionLinkFetchLease(session);
  assert.ok(lease);
  assert.equal(applySessionLinkFetchResult(session, lease, "Fetched title"), true);
  assert.equal(session.externalTitleSource, "fetched");
  assert.equal(session.linkRevision, 0);

  const competing: SessionLinkOwnerState = { id: "other-id", user: "owner@example.test", expires: Date.now() + 10_000, state: "active", ...link };
  const staleLease = captureSessionLinkFetchLease(competing);
  assert.ok(staleLease);
  competing.user = "other@example.test";
  assert.equal(applySessionLinkFetchResult(competing, staleLease, "Stale owner"), false);
  competing.user = staleLease.user;
  competing.linkRevision += 1;
  assert.equal(applySessionLinkFetchResult(competing, staleLease, "Stale revision"), false);
  competing.linkRevision = staleLease.revision;
  competing.state = "closed";
  assert.equal(applySessionLinkFetchResult(competing, staleLease, "Closed"), false);
  competing.state = "active";
  assert.equal(applySessionLinkFetchResult(competing, staleLease, "Expired", competing.expires), false);
});
