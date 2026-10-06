import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RemoteProcessMappingStore } from "../src/remote-process-mapping.js";
import { fixture } from "./fixture.js";

test("owner stop reconciles per-node ACKs to public process mappings without leaking executor ids", async () => {
  const nodeId = "node_AAAAAAAAAAAAAAAAAAAAAA";
  const executorGeneration = Buffer.alloc(16, 2).toString("base64url");
  const connectionId = Buffer.alloc(32, 1).toString("base64url");
  const acceptedRemoteId = "executor-process-accepted";
  const failedRemoteId = "executor-process-failed";
  const f = await fixture({
    processAdapter: { start: async () => "", read: async () => "", terminate: async () => "", sessions: async () => "" },
    nodeStateSync: async () => [{
      node_id: nodeId,
      state_applied: true,
      requested_process_ids: [acceptedRemoteId],
      failed_process_ids: [failedRemoteId],
    }],
  }, undefined, { startDesktopCommander: false });
  try {
    const mappings = (f.service as unknown as { remoteProcessMappings: RemoteProcessMappingStore }).remoteProcessMappings;
    const createMapping = (publicId: string, remoteProcessId: string) => {
      const reservation = mappings.reserveStart(nodeId);
      return mappings.bindStarted(reservation, {
        principalId: "owner@example.test",
        sessionId: "synthetic-session",
        nodeId,
        executorGeneration,
        connectionId,
        remoteProcessId,
        publicId,
      });
    };
    const accepted = createMapping("public-process-accepted", acceptedRemoteId);
    const failed = createMapping("public-process-failed", failedRemoteId);

    await f.service.stopUserExecution("owner@example.test");

    const acceptedAfter = mappings.lookupTracking(accepted.trackingId)!;
    const failedAfter = mappings.lookupTracking(failed.trackingId)!;
    assert.equal(acceptedAfter.observedState, "terminating");
    assert.notEqual(acceptedAfter.terminationUnconfirmed, true);
    assert.equal(failedAfter.observedState, "terminating");
    assert.equal(failedAfter.terminationUnconfirmed, true);
    const events = (await readFile(path.join(f.data, "audit.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const requested = events.find((event) => event.event === "process.stop_requested" && event.processId === accepted.publicId);
    const unconfirmed = events.find((event) => event.event === "process.owner_stop_unconfirmed" && event.processId === failed.publicId);
    assert.equal(requested?.nodeId, nodeId);
    assert.equal(requested?.source, "owner_stop");
    assert.equal(unconfirmed?.nodeId, nodeId);
    assert.equal(unconfirmed?.reason, "executor_reported_failure");
    for (const event of [requested, unconfirmed]) {
      assert.ok(event);
      assert.equal("pid" in event, false);
      assert.equal("remoteProcessId" in event, false);
    }
  } finally {
    await f.cleanup();
  }
});
