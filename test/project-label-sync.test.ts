import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPORTED_LABELS,
  observeIssueField,
  planFieldSync,
  recoverPendingOperation,
  selectTargetIssues,
  validateProjectMetadata,
  planFromFixture,
} from "../scripts/project-label-sync.mjs";

const times = {
  t0: "2026-10-03T10:00:00.000Z",
  t1: "2026-10-03T10:01:00.000Z",
  t2: "2026-10-03T10:02:00.000Z",
  t3: "2026-10-03T10:03:00.000Z",
};

function event(id, label, eventType = "labeled", createdAt = times.t0, actor = "ssaattww") {
  return { id, label, event: eventType, createdAt, actor };
}

function issue(field, labels = [], events = []) {
  return observeIssueField(field, labels, events);
}

function snapshot(field, projectValue, projectUpdatedAt, labels = [], events = []) {
  return {
    project: {
      value: projectValue,
      updatedAt: projectUpdatedAt,
      valueId: projectValue === null ? null : `project-value-${projectValue}`,
    },
    issue: issue(field, labels, events),
    labels,
  };
}

function plan(current, previous = null, field = "priority") {
  return planFieldSync({ field, current, previous });
}

function assertDecision(result, source, targetValue) {
  assert.equal(result.decision.source, source);
  assert.equal(result.decision.targetValue, targetValue);
}

test("only the ten explicitly supported labels are managed", () => {
  assert.deepEqual(SUPPORTED_LABELS, [
    "priority:P0", "priority:P1", "priority:P2", "priority:P3",
    "status:Backlog", "status:Ready", "status:In progress",
    "status:保留", "status:Blocked", "status:Done",
  ]);
});

test("initial synchronization adopts a non-empty Project value", () => {
  const result = plan(snapshot("priority", "P1", times.t0));
  assertDecision(result, "project", "P1");
  assert.deepEqual(result.labelMutations, { add: ["priority:P1"], remove: [] });
  assert.equal(result.needsStateAdvance, true);
});

test("initial empty Project value removes supported family labels only", () => {
  const current = snapshot("priority", null, null,
    ["priority:P2", "priority:custom", "status:Done"],
    [event("e1", "priority:P2")]);
  const result = plan(current);
  assertDecision(result, "project", null);
  assert.deepEqual(result.labelMutations, { add: [], remove: ["priority:P2"] });
});

test("when only Project changed, Project value wins regardless of the older issue label", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P2", times.t1,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const result = plan(current, previous);
  assertDecision(result, "project", "P2");
  assert.deepEqual(result.labelMutations, { add: ["priority:P2"], remove: ["priority:P1"] });
});

test("when only issue value changed, issue value updates Project", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P1", times.t0,
    ["priority:P2"], [event("e2", "priority:P2", "labeled", times.t1)]);
  const result = plan(current, previous);
  assertDecision(result, "issue", "P2");
  assert.deepEqual(result.projectMutation, { operation: "set", value: "P2" });
});

test("an unchanged empty Project field does not override a new issue label", () => {
  const previous = snapshot("priority", null, null, [], []);
  const current = snapshot("priority", null, null,
    ["priority:P3"], [event("e3", "priority:P3", "labeled", times.t2)]);
  const result = plan(current, previous);
  assertDecision(result, "issue", "P3");
  assert.deepEqual(result.projectMutation, { operation: "set", value: "P3" });
});

test("when both sides changed, the newer issue event wins", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P2", times.t1,
    ["priority:P3"], [event("e3", "priority:P3", "labeled", times.t2)]);
  const result = plan(current, previous);
  assertDecision(result, "issue", "P3");
  assert.deepEqual(result.projectMutation, { operation: "set", value: "P3" });
});

test("simultaneous changes at the same timestamp prefer Project", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P2", times.t2,
    ["priority:P3"], [event("e3", "priority:P3", "labeled", times.t2)]);
  const result = plan(current, previous);
  assertDecision(result, "project", "P2");
});

test("simultaneous changes with unknown timestamps prefer Project", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P2", null,
    ["priority:P3"], [event("e3", "priority:P3", "labeled", null)]);
  const result = plan(current, previous);
  assertDecision(result, "project", "P2");
});

test("a Project clear in a two-sided conflict removes supported labels but preserves unknown names", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", null, null,
    ["priority:P2", "priority:P9", "status:Ready"],
    [event("e2", "priority:P2", "labeled", times.t2)]);
  const result = plan(current, previous);
  assertDecision(result, "project", null);
  assert.deepEqual(result.labelMutations, { add: [], remove: ["priority:P2"] });
});

test("an unchanged empty state is a no-op", () => {
  const previous = snapshot("priority", null, null, [], []);
  const current = snapshot("priority", null, null, [], []);
  const result = plan(current, previous);
  assert.equal(result.decision.source, null);
  assert.deepEqual(result.labelMutations, { add: [], remove: [] });
  assert.equal(result.projectMutation, null);
  assert.equal(result.needsStateAdvance, false);
});

test("same-value Project reassignment is observed from updatedAt", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P1", times.t1,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const result = plan(current, previous);
  assertDecision(result, "project", "P1");
  assert.equal(result.projectMutation, null);
  assert.deepEqual(result.labelMutations, { add: [], remove: [] });
  assert.equal(result.needsStateAdvance, true);
});

test("same-value issue remove-and-readd is observed from its new timeline id", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [
      event("e1", "priority:P1", "labeled", times.t0),
      event("e2", "priority:P1", "unlabeled", times.t1),
      event("e3", "priority:P1", "labeled", times.t2),
    ]);
  const result = plan(current, previous);
  assertDecision(result, "issue", "P1");
  assert.equal(result.projectMutation, null);
  assert.equal(result.needsStateAdvance, true);
});

test("re-adding an already-present label without a new event is not observable", () => {
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const current = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const result = plan(current, previous);
  assert.equal(result.decision.source, null);
  assert.equal(result.needsStateAdvance, false);
});

test("latest active supported label resolves multiple same-family labels", () => {
  const events = [
    event("e1", "priority:P1", "labeled", times.t0),
    event("e2", "priority:P3", "labeled", times.t2),
  ];
  const observed = issue("priority", ["priority:P1", "priority:P3"], events);
  assert.equal(observed.value, "P3");
  assert.equal(observed.ambiguous, false);
  const previous = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [events[0]]);
  const current = {
    project: { value: "P1", updatedAt: times.t0, valueId: "project-value-P1" },
    issue: observed,
    labels: ["priority:P1", "priority:P3", "priority:custom"],
  };
  const result = plan(current, previous);
  assertDecision(result, "issue", "P3");
  assert.deepEqual(result.labelMutations, { add: [], remove: ["priority:P1"] });
  assert.deepEqual(result.projectMutation, { operation: "set", value: "P3" });
});

test("multiple supported labels without a unique latest timestamp fall back to Project", () => {
  const events = [
    event("e1", "priority:P1", "labeled", null),
    event("e2", "priority:P3", "labeled", null),
  ];
  const observed = issue("priority", ["priority:P1", "priority:P3"], events);
  assert.equal(observed.ambiguous, true);
  const current = {
    project: { value: "P2", updatedAt: times.t1, valueId: "project-value-P2" },
    issue: observed,
    labels: ["priority:P1", "priority:P3", "priority:P9"],
  };
  const result = plan(current, null);
  assertDecision(result, "project", "P2");
  assert.deepEqual(result.labelMutations, { add: ["priority:P2"], remove: ["priority:P1", "priority:P3"] });
});

test("unknown prefixed labels are never removed by family cleanup", () => {
  const current = snapshot("priority", "P3", times.t2,
    ["priority:P1", "priority:P9", "priority:custom"],
    [event("e1", "priority:P1", "labeled", times.t0)]);
  const result = plan(current);
  assert.deepEqual(result.labelMutations, { add: ["priority:P3"], remove: ["priority:P1"] });
});

test("an unknown selected option skips only that field", () => {
  const current = snapshot("priority", "Urgent", times.t2,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const result = plan(current);
  assert.equal(result.decision.source, null);
  assert.equal(result.decision.reason, "unknown-project-option");
  assert.deepEqual(result.labelMutations, { add: [], remove: [] });
});

test("missing required Project fields or allowed options is a whole-configuration error", () => {
  const fields = [
    { id: "p", name: "Priority", __typename: "ProjectV2SingleSelectField", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `p-${name}`, name })) },
    { id: "s", name: "Status", __typename: "ProjectV2SingleSelectField", options: ["Backlog", "Ready", "In progress", "保留", "Blocked", "Done"].map((name) => ({ id: `s-${name}`, name })) },
  ];
  assert.equal(validateProjectMetadata({ id: "project-4", fields }).projectId, "project-4");
  assert.throws(() => validateProjectMetadata({ id: "project-4", fields: fields.slice(0, 1) }), /Status/);
  assert.throws(() => validateProjectMetadata({ id: "project-4", fields: [{ ...fields[0], options: fields[0].options.slice(1) }, fields[1]] }), /P0/);
});

test("target selection excludes other Projects, repositories, and pull requests", () => {
  const items = [
    { projectId: "p4", id: "i1", contentType: "Issue", number: 1, repository: "ssaattww/RemoteDesktopMCP" },
    { projectId: "p3", id: "i2", contentType: "Issue", number: 2, repository: "ssaattww/RemoteDesktopMCP" },
    { projectId: "p4", id: "i3", contentType: "Issue", number: 3, repository: "other/repo" },
    { projectId: "p4", id: "i4", contentType: "PullRequest", number: 4, repository: "ssaattww/RemoteDesktopMCP" },
  ];
  assert.deepEqual(selectTargetIssues(items, "p4", "ssaattww/RemoteDesktopMCP").map(({ number }) => number), [1]);
});

test("pending Project write is recovered as self-update before later issue edits are reconsidered", () => {
  const before = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const pending = {
    field: "priority",
    direction: "issue_to_project",
    startedAt: times.t1,
    before,
    intent: { projectValue: "P2" },
  };
  const current = snapshot("priority", "P2", times.t2,
    ["priority:P3"], [
      event("e1", "priority:P1", "labeled", times.t0),
      event("e3", "priority:P3", "labeled", times.t3),
    ]);
  const recovered = recoverPendingOperation(pending, current);
  assert.equal(recovered.status, "recovered");
  const next = plan(current, recovered.baseline);
  assertDecision(next, "issue", "P3");
});

test("pending label write recovers its bot event and keeps a later human edit as the new change", () => {
  const before = snapshot("priority", "P2", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const pending = {
    field: "priority",
    direction: "project_to_issue",
    startedAt: times.t1,
    before,
    intent: { issueLabels: ["priority:P2"] },
  };
  const events = [
    event("e1", "priority:P1", "labeled", times.t0),
    event("e2", "priority:P1", "unlabeled", times.t2, "github-actions[bot]"),
    event("e3", "priority:P2", "labeled", times.t2, "github-actions[bot]"),
    event("e4", "priority:P2", "unlabeled", times.t3),
    event("e5", "priority:P3", "labeled", times.t3),
  ];
  const current = snapshot("priority", "P2", times.t0, ["priority:P3"], events);
  const recovered = recoverPendingOperation(pending, current, events);
  assert.equal(recovered.status, "recovered");
  assert.deepEqual(recovered.resultEventIds, ["e2", "e3"]);
  const next = plan(current, recovered.baseline);
  assertDecision(next, "issue", "P3");
});

test("unidentifiable pending Project result is not assumed self-authored and uses conflict fallback", () => {
  const before = snapshot("priority", "P1", times.t0,
    ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const pending = {
    field: "priority",
    direction: "issue_to_project",
    startedAt: times.t1,
    before,
    intent: { projectValue: "P2" },
  };
  const current = snapshot("priority", "P2", null,
    ["priority:P3"], [event("e3", "priority:P3", "labeled", null)]);
  const recovered = recoverPendingOperation(pending, current);
  assert.equal(recovered.status, "ambiguous");
  const result = plan(current, recovered.baseline);
  assertDecision(result, "project", "P2");
});

test("pending label operation can resume safely when no write happened yet", () => {
  const before = snapshot("priority", "P2", times.t0, ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const pending = { field: "priority", direction: "project_to_issue", startedAt: times.t1, before, intent: { issueLabels: ["priority:P2"] } };
  const current = snapshot("priority", "P2", times.t0, ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  assert.equal(recoverPendingOperation(pending, current, current.timeline).status, "resume");
});

test("partial bot label operation can resume only while issue still matches observed bot changes", () => {
  const before = snapshot("priority", "P2", times.t0, ["priority:P1"], [event("e1", "priority:P1", "labeled", times.t0)]);
  const pending = { field: "priority", direction: "project_to_issue", startedAt: times.t1, before, intent: { issueLabels: ["priority:P2"] } };
  const partial = [event("e1", "priority:P1", "labeled", times.t0), event("e2", "priority:P1", "unlabeled", times.t2, "github-actions[bot]")];
  const current = snapshot("priority", "P2", times.t0, [], partial);
  assert.equal(recoverPendingOperation(pending, current, partial).status, "resume");
  const humanInterference = [...partial, event("e3", "priority:P3", "labeled", times.t3)];
  const changed = snapshot("priority", "P3", times.t0, ["priority:P3"], humanInterference);
  assert.equal(recoverPendingOperation(pending, changed, humanInterference).status, "ambiguous");
});

test("fixture dry-run returns plans without calling the network", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error("network must not be used"); };
  try {
    const result = await planFromFixture({
      field: "priority",
      current: snapshot("priority", "P1", times.t0),
      previous: null,
    });
    assertDecision(result, "project", "P1");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
