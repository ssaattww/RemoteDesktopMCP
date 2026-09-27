import assert from "node:assert/strict";
import test from "node:test";
import { fixture, mcp } from "./fixture.js";

test("the pinned Desktop Commander owner latch is reopened only by a durable resume", async () => {
  const f = await fixture();
  const api = await mcp(f.service);
  try {
    await f.service.stopUserExecution("owner@example.test");
    await assert.rejects(api.call("session_open", {}), /USER_STOP_REQUESTED/);
    await f.service.resumeUserExecution("owner@example.test");
    const reopened = await api.call("session_open", {});
    assert.equal(typeof reopened.connection_id, "string");
  } finally { await api.close(); await f.cleanup(); }
});
