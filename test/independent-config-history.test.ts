import assert from "node:assert/strict";
import { link, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RemoteDesktopService } from "../src/index.js";
import { captureProtectedConfigPin, fixture, mcp } from "./fixture.js";

const configPath = (data: string) => path.join(data, "desktop-commander-home", ".claude-server-commander", "config.json");
const openSession = async (api: Awaited<ReturnType<typeof mcp>>) => (await api.call("session_open", {})).session_id as string;
const auditEvents = async (data: string) => (await readFile(path.join(data, "audit.jsonl"), "utf8")).split("\n").flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
async function replaceConfigWithRetry(source: string, destination: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") || attempt === 5) break;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw last;
}


test("RDMCP-MVP-IFR-002: live config history prunes past 64 versions without losing known protection", async () => {
  const f = await fixture(); let api = await mcp(f.service); let restarted: RemoteDesktopService | undefined;
  try {
    const protectedConfig = configPath(f.data);
    const alias = path.join(f.root, "known-config-alias.json");
    const ordinary = path.join(f.root, "ordinary-history.txt");
    await captureProtectedConfigPin(f.service, f.data, alias);
    await writeFile(ordinary, "ordinary history file");
    let session = await openSession(api);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }));
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);

    const capture = (f.service as unknown as { rememberProtectedConfigIdentity: () => Promise<void> }).rememberProtectedConfigIdentity.bind(f.service);
    for (let version = 0; version < 70; version++) {
      const staged = `${protectedConfig}.version-${version}`;
      await writeFile(staged, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false, fixtureVersion: version }));
      await replaceConfigWithRetry(staged, protectedConfig);
      await capture();
    }

    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }), "the known hard-link alias survives history pruning");
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);

    await api.close(); await f.service.close();
    restarted = new RemoteDesktopService(f.service.cfg); await restarted.initialize(); api = await mcp(restarted); session = await openSession(api);
    await assert.rejects(api.call("file_read", { session_id: session, root_id: "files", relative_path: "known-config-alias.json" }), "restart preserves known config protection after pruning");
    assert.match(String((await api.call("file_read", { session_id: session, root_id: "files", relative_path: "ordinary-history.txt" })).output), /ordinary history file/);
  } finally { await api.close(); await restarted?.close(); await f.cleanup(); }
})

test("RDMCP-MVP-IFR-002: real pin-link replacements settle or fail closed within the retry budget", async (t) => {
  const f = await fixture(); let stable: RemoteDesktopService | undefined; let stableApi: Awaited<ReturnType<typeof mcp>> | undefined;
  const unstableFixture = await fixture(); let unstable: RemoteDesktopService | undefined;
  try {
    const aliasA = path.join(f.root, "retry-known-a.json");
    const aliasB = path.join(f.root, "retry-known-b.json");
    await captureProtectedConfigPin(f.service, f.data, aliasA);
    await f.service.close();

    let settledReplacements = 0;
    let capturedB = false;
    stable = new RemoteDesktopService({
      ...f.service.cfg,
      linkProtectedConfig: async (existingPath: string, pinPath: string) => {
        await link(existingPath, pinPath);
        if (!capturedB) { await link(pinPath, aliasB); capturedB = true; }
        if (settledReplacements < 5) {
          const staged = `${existingPath}.settle-${settledReplacements}`;
          await writeFile(staged, JSON.stringify({ allowedDirectories: [f.root], telemetryEnabled: false, retryVersion: settledReplacements }));
          await replaceConfigWithRetry(staged, existingPath);
          settledReplacements += 1;
        }
      },
    });
    await stable.initialize();
    assert.equal(settledReplacements, 5, "the first five successful real links must observe a replacement before the config stabilizes");
    assert.equal(capturedB, true, "the stable retry path must retain a second known config identity");
    await writeFile(path.join(f.root, "retry-ordinary.txt"), "ordinary retry file");
    stableApi = await mcp(stable);
    const stableSession = await openSession(stableApi);
    await assert.rejects(stableApi.call("file_read", { session_id: stableSession, root_id: "files", relative_path: "retry-known-a.json" }));
    await assert.rejects(stableApi.call("file_read", { session_id: stableSession, root_id: "files", relative_path: "retry-known-b.json" }));
    assert.match(String((await stableApi.call("file_read", { session_id: stableSession, root_id: "files", relative_path: "retry-ordinary.txt" })).output), /ordinary retry file/);

    await unstableFixture.service.close();
    const readyBefore = (await auditEvents(unstableFixture.data)).filter((entry) => entry.event === "desktop_commander.ready").length;
    let unboundedReplacements = 0;
    const retryAttemptStarts: number[] = [];
    unstable = new RemoteDesktopService({
      ...unstableFixture.service.cfg,
      linkProtectedConfig: async (existingPath: string, pinPath: string) => {
        if (!process.env.CI) retryAttemptStarts.push(Date.now());
        await link(existingPath, pinPath);
        const staged = `${existingPath}.never-stable-${unboundedReplacements}`;
        await writeFile(staged, JSON.stringify({ allowedDirectories: [unstableFixture.root], telemetryEnabled: false, retryVersion: unboundedReplacements }));
        await replaceConfigWithRetry(staged, existingPath);
        unboundedReplacements += 1;
      },
    });
    await assert.rejects(unstable.initialize(), /Protected config identity changed while pinning/);
    assert.ok(unboundedReplacements > 1 && unboundedReplacements <= 20, "failure must arise from at most 20 real link-and-replace attempts");
    await t.test("local only: real pin-link retry phase is prompt", { skip: Boolean(process.env.CI) }, () => {
      assert.ok(retryAttemptStarts.at(-1)! - retryAttemptStarts[0]! < 2_500, "real pin-link retries must exhaust their ~2 second budget without an unbounded wait");
    });
    assert.throws(() => (unstable as unknown as { dc: { currentGeneration: () => string } }).dc.currentGeneration(), /unavailable/, "failed initialization must not expose a ready Desktop Commander generation");
    const readyAfter = (await auditEvents(unstableFixture.data)).filter((entry) => entry.event === "desktop_commander.ready").length;
    assert.equal(readyAfter, readyBefore, "failed initialization must not audit a ready service");
  } finally { await stableApi?.close(); await stable?.close(); await unstable?.close(); await f.cleanup(); await unstableFixture.cleanup(); }
})
