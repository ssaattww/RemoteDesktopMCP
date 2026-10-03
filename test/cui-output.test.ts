import assert from "node:assert/strict";
import test from "node:test";
import { mapCuiResponse } from "../src/cui-output.js";

const date = "2026-10-02T12:00:00.000Z";
const state = { sessions: [{ session_id: "s1", purpose: "review", working_directory: "C:/work", created_at: date, last_used_at: date, active: true, state: "active", owner: "must-not-escape" }], running: [{ operation_id: "o1", connection_id: "s1", status: "running", tool: "secret" }] };
const logs = { items: [{ id: "l1", event: { at: date, event: "operation.started", command: "secret" } }] };

test("shared CUI mapper emits only the fixed allowlisted schema", () => {
  const { model, truncated } = mapCuiResponse(state, logs);
  assert.equal(truncated, false);
  assert.deepEqual(model, {
    sessions: [{ sessionId: "s1", purpose: "review", workingDirectory: "C:/work", createdAt: date, lastAccessAt: date, state: "active" }],
    operations: [{ operationId: "o1", connectionId: "s1", status: "running", startedAt: null, endedAt: null }],
    logs: [{ logId: "l1", timestamp: date, type: "operation.started" }],
  });
  assert.equal(JSON.stringify(model).includes("secret"), false);
});

test("shared CUI mapper enforces strict enums, dates, and selected-session filtering", () => {
  assert.equal(mapCuiResponse(state, logs, "other").model.sessions.length, 0);
  assert.throws(() => mapCuiResponse({ ...state, sessions: [{ ...state.sessions[0], state: "admin" }] }, logs));
  assert.throws(() => mapCuiResponse({ ...state, sessions: [{ ...state.sessions[0], created_at: "yesterday" }] }, logs));
  assert.throws(() => mapCuiResponse({ ...state, running: [{ ...state.running[0], status: "succeeded" }] }, logs));
});

test("shared CUI mapper caps each collection at 200 and reports truncation", () => {
  const many = Array.from({ length: 201 }, (_, i) => ({ ...state.sessions[0], session_id: `s${i}` }));
  const result = mapCuiResponse({ ...state, sessions: many }, logs);
  assert.equal(result.model.sessions.length, 200);
  assert.equal(result.truncated, true);
});
