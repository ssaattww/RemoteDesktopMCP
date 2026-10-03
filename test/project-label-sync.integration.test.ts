import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubAdapter,
  observeIssueField,
  SUPPORTED_LABELS,
  synchronizeProject,
  validateState,
} from "../scripts/project-label-sync.mjs";

const projectId = "PVT_kwDOProject4";
const projectItemId = "PVTI_project_issue_1";
const projectUpdated = "2026-10-03T10:02:00.000Z";
const baselineTime = "2026-10-03T10:00:00.000Z";
const fields = [
  { id: "priority-field", name: "Priority", __typename: "ProjectV2SingleSelectField", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `p-${name}`, name })) },
  { id: "status-field", name: "Status", __typename: "ProjectV2SingleSelectField", options: ["Backlog", "Ready", "In progress", "保留", "Blocked", "Done"].map((name) => ({ id: `s-${name}`, name })) },
];

function event(id, label, type, createdAt, actor = "ssaattww") {
  return { id, label, event: type, createdAt, actor };
}

function makeSnapshot(projectValue, updatedAt, projectValueId, labels, timeline, field) {
  const allowed = field === "priority" ? labels.filter((label) => label.startsWith("priority:")) : labels.filter((label) => label.startsWith("status:"));
  const relevant = timeline.filter((entry) => entry.label?.startsWith(`${field}:`));
  return {
    project: { value: projectValue, updatedAt, valueId: projectValueId },
    issue: observeIssueField(field, allowed, relevant),
    labels,
  };
}

function createStatefulAdapter({ priority = "P1", priorityUpdatedAt = baselineTime, labels = ["priority:P1"], timeline = [event("e-p1", "priority:P1", "labeled", baselineTime)], state = null, secondItemFails = false } = {}) {
  let tick = 3;
  const projectFields = { priority, status: "Backlog" };
  const projectTimes = { priority: priorityUpdatedAt, status: baselineTime };
  let currentLabels = [...labels];
  let currentTimeline = [...timeline];
  let saved = state;
  const items = [{ projectId, id: projectItemId, contentType: "Issue", number: 1, repository: "ssaattww/RemoteDesktopMCP" }];
  if (secondItemFails) items.push({ projectId, id: "PVTI_project_issue_2", contentType: "Issue", number: 2, repository: "ssaattww/RemoteDesktopMCP" });
  const writes = [];
  const mutations = [];
  let labelCreateCalls = 0;
  const valueId = (field) => projectFields[field] === null ? null : `value-${field}-${projectFields[field]}`;
  const snapshot = (field) => makeSnapshot(projectFields[field], projectTimes[field], valueId(field), currentLabels, currentTimeline, field);

  const baselineFor = (field, value = projectFields[field]) => ({
    project: { value, updatedAt: projectTimes[field], valueId: value === null ? null : `value-${field}-${value}` },
    issue: observeIssueField(field, currentLabels.filter((label) => label.startsWith(`${field}:`)), currentTimeline.filter((entry) => entry.label?.startsWith(`${field}:`))),
    labels: [...currentLabels],
  });
  if (!saved) {
    const initialLabels = [...currentLabels];
    const initialTimeline = [...currentTimeline];
    saved = { schemaVersion: 1, repository: "ssaattww/RemoteDesktopMCP", projectId, items: {
      [projectItemId]: { issueNumber: 1, fields: {
        priority: { baseline: baselineFor("priority"), pending: null },
        status: { baseline: baselineFor("status"), pending: null },
      } },
    } };
    currentLabels = initialLabels;
    currentTimeline = initialTimeline;
  }

  const adapter = {
    readProject: async () => ({ id: projectId, fields }),
    readProjectItems: async () => items,
    ensureSupportedLabels: async () => { labelCreateCalls += 1; },
    readProjectItem: async (itemId) => {
      if (itemId === "PVTI_project_issue_2") throw new Error("later item read failed");
      return {
        projectId,
        id: itemId,
        contentType: "Issue",
        number: 1,
        repository: "ssaattww/RemoteDesktopMCP",
        fieldValues: ["priority", "status"].filter((field) => projectFields[field] !== null).map((field) => ({
          id: valueId(field), name: projectFields[field], updatedAt: projectTimes[field], fieldId: `${field}-field`,
        })),
      };
    },
    readIssue: async (number) => {
      if (number === 2) throw new Error("later item read failed");
      return { labels: [...currentLabels], timeline: [...currentTimeline] };
    },
    readState: async () => saved ? { state: structuredClone(saved), refSha: "state-ref" } : null,
    writeState: async (next) => { writes.push(structuredClone(next)); saved = structuredClone(next); return `state-ref-${writes.length}`; },
    updateProjectField: async ({ fieldId, optionId }) => {
      mutations.push({ type: "set", fieldId, optionId });
      const field = fieldId === "priority-field" ? "priority" : "status";
      projectFields[field] = fields.find((item) => item.id === fieldId).options.find((option) => option.id === optionId).name;
      projectTimes[field] = `2026-10-03T10:00:0${tick++}.000Z`;
    },
    clearProjectField: async ({ fieldId }) => {
      mutations.push({ type: "clear", fieldId });
      const field = fieldId === "priority-field" ? "priority" : "status";
      projectFields[field] = null;
      projectTimes[field] = null;
    },
    addIssueLabels: async (number, adds) => {
      mutations.push({ type: "add", labels: [...adds] });
      for (const label of adds) {
        if (!currentLabels.includes(label)) currentLabels.push(label);
        currentTimeline.push(event(`bot-${tick++}`, label, "labeled", `2026-10-03T10:00:0${tick}.000Z`, "github-actions[bot]"));
      }
    },
    removeIssueLabel: async (number, label) => {
      mutations.push({ type: "remove", label });
      currentLabels = currentLabels.filter((existing) => existing !== label);
      currentTimeline.push(event(`bot-${tick++}`, label, "unlabeled", `2026-10-03T10:00:0${tick}.000Z`, "github-actions[bot]"));
    },
    injectHumanLabel: (label, entry) => {
      if (!currentLabels.includes(label)) currentLabels.push(label);
      currentTimeline.push(entry);
    },
  };
  return { adapter, writes, mutations, read: () => ({ projectFields: { ...projectFields }, labels: [...currentLabels], timeline: [...currentTimeline], saved: structuredClone(saved) }), labelCreateCalls: () => labelCreateCalls };
}

test("synchronizeProject validates every target identity before any mutation", async (t) => {
  await t.test("rejects a target whose saved Project item maps to another Issue", async () => {
    const scenario = createStatefulAdapter();
    const state = scenario.read().saved;
    state.items[projectItemId].issueNumber = 2;
    scenario.adapter.readState = async () => ({ state: structuredClone(state), refSha: "state-ref" });

    await assert.rejects(synchronizeProject({ adapter: scenario.adapter }), /maps to a different issue number/);
    assert.equal(scenario.labelCreateCalls(), 0);
    assert.deepEqual(scenario.writes, []);
    assert.deepEqual(scenario.mutations, []);
  });

  await t.test("checks a later target before label creation or writes for an earlier valid target", async () => {
    const scenario = createStatefulAdapter({ secondItemFails: true });
    const state = scenario.read().saved;
    state.items.PVTI_project_issue_2 = {
      ...structuredClone(state.items[projectItemId]),
      issueNumber: 3,
    };
    scenario.adapter.readState = async () => ({ state: structuredClone(state), refSha: "state-ref" });

    await assert.rejects(synchronizeProject({ adapter: scenario.adapter }), /maps to a different issue number/);
    assert.equal(scenario.labelCreateCalls(), 0);
    assert.deepEqual(scenario.writes, []);
    assert.deepEqual(scenario.mutations, []);
  });
});

test("synchronizeProject executes both directions, clears, removes duplicate labels, and recovers an interrupted label operation", async (t) => {
  await t.test("issue to Project set reaches updateProjectField", async () => {
    const initial = createStatefulAdapter();
    const { adapter, mutations, read } = initial;
    const liveTimeline = [...read().timeline, event("human-p2", "priority:P2", "labeled", projectUpdated)];
    // Rebuild the stateful adapter with the changed Issue observation.
    const scenario = createStatefulAdapter({ timeline: liveTimeline, labels: ["priority:P2"], state: read().saved });
    scenario.mutations.length = 0;
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.read().projectFields.priority, "P2");
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "set" && mutation.optionId === "p-P2"));
  });

  await t.test("issue to Project clear reaches clearProjectField", async () => {
    const initial = createStatefulAdapter();
    const state = initial.read().saved;
    const previous = state.items[projectItemId].fields.priority.baseline;
    const events = [...initial.read().timeline, event("human-remove", "priority:P1", "unlabeled", projectUpdated)];
    const nextState = structuredClone(state);
    nextState.items[projectItemId].fields.priority.baseline = previous;
    const scenario = createStatefulAdapter({ priority: "P1", labels: [], timeline: events, state: nextState });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.equal(scenario.read().projectFields.priority, null);
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "clear" && mutation.fieldId === "priority-field"));
  });

  await t.test("Project to Issue set removes duplicates and preserves unrelated labels", async () => {
    const timeline = [
      event("p1", "priority:P1", "labeled", baselineTime),
      event("p2", "priority:P2", "labeled", "2026-10-03T10:01:00.000Z"),
    ];
    const initial = createStatefulAdapter({ priority: "P3", labels: ["priority:P1", "priority:P2", "priority:custom", "status:Backlog"], timeline });
    const state = initial.read().saved;
    state.items[projectItemId].fields.priority.baseline = makeSnapshot("P1", baselineTime, "value-priority-P1", ["priority:P1", "priority:custom", "status:Backlog"], [timeline[0]], "priority");
    const scenario = createStatefulAdapter({ priority: "P3", priorityUpdatedAt: "2026-10-03T10:03:00.000Z", labels: ["priority:P1", "priority:P2", "priority:custom", "status:Backlog"], timeline, state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.read().labels.sort(), ["priority:P3", "priority:custom", "status:Backlog"].sort());
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P1"));
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P2"));
  });

  await t.test("Project to Issue clear removes the allowed label", async () => {
    const initial = createStatefulAdapter();
    const state = initial.read().saved;
    const scenario = createStatefulAdapter({ priority: null, priorityUpdatedAt: null, labels: ["priority:P1"], timeline: initial.read().timeline, state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.read().labels.filter((label) => label.startsWith("priority:")), []);
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P1"));
  });

  await t.test("issue to Project set also cleans a duplicate supported label", async () => {
    const timeline = [event("p1", "priority:P1", "labeled", baselineTime), event("p2", "priority:P2", "labeled", projectUpdated)];
    const initial = createStatefulAdapter();
    const state = initial.read().saved;
    const scenario = createStatefulAdapter({ labels: ["priority:P1", "priority:P2"], timeline, state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.equal(scenario.read().projectFields.priority, "P2");
    assert.deepEqual(scenario.read().labels.filter((label) => label.startsWith("priority:")), ["priority:P2"]);
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "set" && mutation.optionId === "p-P2"));
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P1"));
  });

  await t.test("interrupted pending label intent resumes through synchronizeProject", async () => {
    const initial = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], timeline: [event("p1", "priority:P1", "labeled", baselineTime)] });
    const state = initial.read().saved;
    const before = structuredClone(state.items[projectItemId].fields.priority.baseline);
    state.items[projectItemId].fields.priority.pending = {
      runId: "interrupted-run", field: "priority", direction: "project_to_issue", startedAt: "2026-10-03T10:01:00.000Z",
      before, intent: { projectValue: "P2", issueLabels: ["priority:P2"], labelMutations: { add: ["priority:P2"], remove: ["priority:P1"] } },
      labelMutations: { add: ["priority:P2"], remove: ["priority:P1"] }, resultEventIds: [], resultProject: null,
    };
    const scenario = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], timeline: [event("p1", "priority:P1", "labeled", baselineTime)], state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.read().labels.filter((label) => label.startsWith("priority:")).sort(), ["priority:P2"]);
    assert.equal(scenario.read().saved.items[projectItemId].fields.priority.pending, null);
  });

  await t.test("interrupted partial label intent resumes only until a human edits the target family", async () => {
    const timeline = [event("p1", "priority:P1", "labeled", baselineTime), event("bot-remove", "priority:P1", "unlabeled", projectUpdated, "github-actions[bot]")];
    const initial = createStatefulAdapter({ priority: "P2", labels: [], timeline: timeline.slice(0, 1) });
    const state = initial.read().saved;
    const before = structuredClone(state.items[projectItemId].fields.priority.baseline);
    state.items[projectItemId].fields.priority.pending = {
      runId: "interrupted-partial", field: "priority", direction: "project_to_issue", startedAt: "2026-10-03T10:01:00.000Z",
      before, intent: { projectValue: "P2", issueLabels: ["priority:P2"], projectMutation: null, labelMutations: { add: ["priority:P2"], remove: ["priority:P1"] } },
      resultEventIds: [], resultProject: null,
    };
    const scenario = createStatefulAdapter({ priority: "P2", labels: [], timeline, state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.read().labels.filter((label) => label.startsWith("priority:")), ["priority:P2"]);
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "add" && mutation.labels.includes("priority:P2")));
  });

  await t.test("a human Issue edit between pending recovery and resume is retained without stale label writes", async () => {
    const timeline = [
      event("p1", "priority:P1", "labeled", baselineTime),
      event("bot-remove", "priority:P1", "unlabeled", projectUpdated, "github-actions[bot]"),
    ];
    const seed = createStatefulAdapter({ priority: "P2", labels: [], timeline: timeline.slice(0, 1) });
    const state = seed.read().saved;
    const before = structuredClone(state.items[projectItemId].fields.priority.baseline);
    state.items[projectItemId].fields.priority.pending = {
      runId: "interrupted-race", field: "priority", direction: "project_to_issue", startedAt: "2026-10-03T10:01:00.000Z",
      before, beforeEventCursor: "p1",
      intent: { projectValue: "P2", issueLabels: ["priority:P2"], projectMutation: null, labelMutations: { add: ["priority:P2"], remove: ["priority:P1"] } },
      resultEventIds: ["bot-remove"], resultProject: null,
    };
    const scenario = createStatefulAdapter({ priority: "P2", labels: [], timeline, state });
    const writeState = scenario.adapter.writeState;
    let injected = false;
    scenario.adapter.writeState = async (...args) => {
      const pending = args[0].items[projectItemId].fields.priority.pending;
      if (!injected && pending?.resultEventIds?.includes("bot-remove")) {
        injected = true;
        scenario.adapter.injectHumanLabel("priority:P3", event("human-p3", "priority:P3", "labeled", "2026-10-03T10:03:00.000Z"));
      }
      return writeState(...args);
    };
    await assert.rejects(synchronizeProject({ adapter: scenario.adapter }), /changed while resuming/i);
    assert.deepEqual(scenario.read().labels.filter((label) => label.startsWith("priority:")), ["priority:P3"]);
    assert.equal(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P3"), false);
    assert.equal(scenario.read().saved.items[projectItemId].fields.priority.pending !== null, true);
  });

  await t.test("a recorded Project clear is recovered before a later Issue edit is synchronized", async () => {
    const originalTimeline = [event("p1", "priority:P1", "labeled", baselineTime)];
    const seed = createStatefulAdapter({ priority: "P1", labels: ["priority:P1"], timeline: originalTimeline });
    const state = seed.read().saved;
    const before = structuredClone(state.items[projectItemId].fields.priority.baseline);
    state.items[projectItemId].fields.priority.pending = {
      runId: "clear-completed", field: "priority", direction: "issue_to_project", startedAt: "2026-10-03T10:01:00.000Z",
      before,
      intent: { projectValue: null, issueLabels: [], projectMutation: { operation: "clear" }, labelMutations: { add: [], remove: [] } },
      resultEventIds: [], resultProject: { valueId: null, updatedAt: null },
    };
    const laterTimeline = [
      ...originalTimeline,
      event("human-remove-p1", "priority:P1", "unlabeled", "2026-10-03T10:02:00.000Z"),
      event("human-p2", "priority:P2", "labeled", "2026-10-03T10:03:00.000Z"),
    ];
    const scenario = createStatefulAdapter({ priority: null, priorityUpdatedAt: null, labels: ["priority:P2"], timeline: laterTimeline, state });
    await synchronizeProject({ adapter: scenario.adapter });
    assert.equal(scenario.read().projectFields.priority, "P2");
    assert.equal(scenario.read().labels.includes("priority:P2"), true);
    assert.ok(scenario.mutations.some((mutation) => mutation.type === "set" && mutation.optionId === "p-P2"));
    assert.equal(scenario.mutations.some((mutation) => mutation.type === "remove" && mutation.label === "priority:P2"), false);
  });
});

test("synchronizeProject dry-run, malformed state, incomplete later reads, and preflight conflicts never send content mutations", async (t) => {
  await t.test("dry-run writes nothing", async () => {
    const scenario = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], timeline: [event("p1", "priority:P1", "labeled", baselineTime)] });
    await synchronizeProject({ adapter: scenario.adapter, dryRun: true });
    assert.deepEqual(scenario.mutations, []);
    assert.deepEqual(scenario.writes, []);
  });

  await t.test("invalid state fails validation before all mutations", async () => {
    assert.throws(() => validateState({ schemaVersion: 1, repository: "ssaattww/RemoteDesktopMCP", projectId, items: null }, projectId), /state|items/i);
    assert.throws(() => validateState({ schemaVersion: 1, repository: "ssaattww/RemoteDesktopMCP", projectId, items: { [projectItemId]: { issueNumber: 1, fields: { priority: { baseline: {}, pending: null } } } } }, projectId), /baseline|state|priority/i);
    const malformed = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], state: { schemaVersion: 1, repository: "ssaattww/RemoteDesktopMCP", projectId, items: null } });
    await assert.rejects(synchronizeProject({ adapter: malformed.adapter }), /state|items/i);
    assert.deepEqual(malformed.mutations, []);
    assert.deepEqual(malformed.writes, []);
  });

  await t.test("later target read failure is discovered before an earlier target mutation", async () => {
    const scenario = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], timeline: [event("p1", "priority:P1", "labeled", baselineTime)], secondItemFails: true });
    await assert.rejects(synchronizeProject({ adapter: scenario.adapter }), /later item read failed/);
    assert.deepEqual(scenario.mutations, []);
    assert.deepEqual(scenario.writes, []);
  });

  await t.test("preflight conflict blocks every label mutation", async () => {
    const scenario = createStatefulAdapter({ priority: "P2", labels: ["priority:P1"], timeline: [event("p1", "priority:P1", "labeled", baselineTime)] });
    let reads = 0;
    const realReadProjectItem = scenario.adapter.readProjectItem;
    scenario.adapter.readProjectItem = async (...args) => {
      reads += 1;
      const result = await realReadProjectItem(...args);
      if (reads === 3) return { ...result, fieldValues: result.fieldValues.map((field) => field.fieldId === "priority-field" ? { ...field, name: "P3", updatedAt: projectUpdated, id: "racing-project-change" } : field) };
      return result;
    };
    await synchronizeProject({ adapter: scenario.adapter });
    assert.deepEqual(scenario.mutations, []);
  });

  await t.test("a human edit between label removals stops the remaining stale write", async () => {
    const timeline = [event("p1", "priority:P1", "labeled", baselineTime), event("p2", "priority:P2", "labeled", "2026-10-03T10:01:00.000Z")];
    const scenario = createStatefulAdapter({ priority: "P3", priorityUpdatedAt: "2026-10-03T10:03:00.000Z", labels: ["priority:P1", "priority:P2"], timeline });
    const state = scenario.read().saved;
    state.items[projectItemId].fields.priority.baseline = makeSnapshot("P1", baselineTime, "value-priority-P1", ["priority:P1"], [timeline[0]], "priority");
    const adapter = createStatefulAdapter({ priority: "P3", priorityUpdatedAt: "2026-10-03T10:03:00.000Z", labels: ["priority:P1", "priority:P2"], timeline, state });
    let issueReads = 0;
    const realReadIssue = adapter.adapter.readIssue;
    adapter.adapter.readIssue = async (number) => {
      issueReads += 1;
      if (issueReads === 6) {
        adapter.adapter.injectHumanLabel("priority:P0", event("human-race", "priority:P0", "labeled", "2026-10-03T10:04:00.000Z"));
      }
      return realReadIssue(number);
    };
    await assert.rejects(synchronizeProject({ adapter: adapter.adapter }), /changed before label removal/i);
    assert.deepEqual(adapter.mutations.filter((mutation) => mutation.type === "remove").map((mutation) => mutation.label), ["priority:P1"]);
  });
});

test("GraphQL adapter queries select Project identity and legal union fragments", async () => {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.query);
    let data;
    if (body.query.includes("ProjectSyncItems")) {
      assert.match(body.query, /node\s*\(id:\s*\$projectId\)\s*\{\s*__typename/);
      data = { node: { __typename: "ProjectV2", id: projectId, items: { nodes: [{ id: projectItemId, content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ssaattww/RemoteDesktopMCP" } } }], pageInfo: { hasNextPage: false } } } };
    } else {
      assert.match(body.query, /node\s*\(id:\s*\$itemId\)\s*\{\s*__typename/);
      assert.match(body.query, /project\s*\{\s*id\s*\}/);
      assert.match(body.query, /field\s*\{\s*\.\.\.\s+on\s+ProjectV2SingleSelectField\s*\{\s*id\s+name\s*\}/);
      data = { node: { __typename: "ProjectV2Item", id: projectItemId, project: { id: projectId }, content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ssaattww/RemoteDesktopMCP" } }, fieldValues: { nodes: [{ __typename: "ProjectV2ItemFieldSingleSelectValue", id: "value-p1", name: "P1", optionId: "p-P1", updatedAt: baselineTime, field: { id: "priority-field", name: "Priority" } }], pageInfo: { hasNextPage: false } } } };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) };
  };
  const adapter = createGitHubAdapter({ projectToken: "not-a-real-token", githubToken: "not-a-real-token", fetchImpl });
  const items = await adapter.readProjectItems(projectId);
  assert.equal(items[0].id, projectItemId);
  const item = await adapter.readProjectItem(projectItemId, projectId);
  assert.equal(item.projectId, projectId);
  assert.equal(item.fieldValues[0].fieldId, "priority-field");
  assert.equal(calls.length, 2);
});

test("GraphQL adapter rejects an item missing membership evidence and another Project's item", async () => {
  let wrongProject = false;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.query, /project\s*\{\s*id\s*\}/);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { node: {
      __typename: "ProjectV2Item", id: projectItemId, project: { id: wrongProject ? "another-project" : null },
      content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ssaattww/RemoteDesktopMCP" } },
      fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
    } } }) };
  };
  const adapter = createGitHubAdapter({ projectToken: "not-a-real-token", githubToken: "not-a-real-token", fetchImpl });
  await assert.rejects(adapter.readProjectItem(projectItemId, projectId), /membership|Project/i);
  wrongProject = true;
  await assert.rejects(adapter.readProjectItem(projectItemId, projectId), /membership|Project/i);
});

test("transport dry-run reads GitHub contracts but sends no external mutation request", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method ?? "GET", query: init.body ? JSON.parse(init.body).query : null });
    if (String(url).endsWith("/graphql")) {
      const query = JSON.parse(init.body).query;
      let data;
      if (query.includes("ProjectSyncMetadata")) {
        data = { user: { projectV2: { id: projectId, fields: { nodes: fields, pageInfo: { hasNextPage: false } } } } };
      } else if (query.includes("ProjectSyncItems")) {
        data = { node: { __typename: "ProjectV2", items: { nodes: [{ id: projectItemId, content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ssaattww/RemoteDesktopMCP" } } }], pageInfo: { hasNextPage: false } } } };
      } else if (query.includes("ProjectSyncItem")) {
        data = { node: { __typename: "ProjectV2Item", id: projectItemId, project: { id: projectId }, content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ssaattww/RemoteDesktopMCP" } }, fieldValues: { nodes: [
          { __typename: "ProjectV2ItemFieldSingleSelectValue", id: "priority-P2", name: "P2", optionId: "p-P2", updatedAt: projectUpdated, field: { id: "priority-field", name: "Priority" } },
          { __typename: "ProjectV2ItemFieldSingleSelectValue", id: "status-Backlog", name: "Backlog", optionId: "s-Backlog", updatedAt: baselineTime, field: { id: "status-field", name: "Status" } },
        ], pageInfo: { hasNextPage: false } } } };
      } else {
        throw new Error("unexpected GraphQL operation");
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data }) };
    }
    if (String(url).includes("/git/ref/heads/")) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: "not found" }) };
    if (String(url).includes("/issues/1/labels")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    if (String(url).includes("/issues/1/timeline")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    throw new Error(`unexpected route ${url}`);
  };
  const adapter = createGitHubAdapter({ projectToken: "not-a-real-token", githubToken: "not-a-real-token", fetchImpl });
  const result = await synchronizeProject({ adapter, dryRun: true });
  assert.equal(result.targetCount, 1);
  assert.ok(requests.length > 0);
  assert.equal(requests.some((request) => request.query?.trimStart().startsWith("mutation")), false);
  assert.equal(requests.some((request) => ["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && !request.url.endsWith("/graphql")), false);
});

test("label initialization creates only missing allowlisted names and preserves existing definitions", async () => {
  const created = [];
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      created.push(JSON.parse(init.body));
      return { ok: true, status: 201, headers: { get: () => null }, json: async () => ({ name: JSON.parse(init.body).name }) };
    }
    assert.match(url, /\/repos\/ssaattww\/RemoteDesktopMCP\/labels\?/);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ name: SUPPORTED_LABELS[0], color: "abcdef" }, { name: "unrelated" }],
    };
  };
  const adapter = createGitHubAdapter({ projectToken: "fake", githubToken: "fake", fetchImpl });
  const createdNames = await adapter.ensureSupportedLabels();
  assert.deepEqual(createdNames, SUPPORTED_LABELS.slice(1));
  assert.deepEqual(created.map(({ name }) => name), SUPPORTED_LABELS.slice(1));
  assert.ok(created.every((label) => /^[0-9a-f]{6}$/.test(label.color)));
  assert.ok(created.every((label) => label.description === "Managed by Project #4 synchronization."));
});
