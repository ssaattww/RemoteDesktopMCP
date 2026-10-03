import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_OWNER = "ssaattww";
export const REPOSITORY = "ssaattww/RemoteDesktopMCP";
export const PROJECT_NUMBER = 4;
export const STATE_BRANCH = "project-label-sync-state";
export const STATE_PATH = "state.json";
export const SUPPORTED_VALUES = Object.freeze({
  priority: Object.freeze(["P0", "P1", "P2", "P3"]),
  status: Object.freeze(["Backlog", "Ready", "In progress", "保留", "Blocked", "Done"]),
});
export const SUPPORTED_LABELS = Object.freeze([
  ...SUPPORTED_VALUES.priority.map((value) => `priority:${value}`),
  ...SUPPORTED_VALUES.status.map((value) => `status:${value}`),
]);
const SUPPORTED_LABEL_COLORS = Object.freeze([
  "f85149", "d29922", "e3b341", "3fb950",
  "8b949e", "58a6ff", "bc8cff", "d29922", "f85149", "3fb950",
]);

const FIELD_LABELS = Object.freeze({
  priority: new Map(SUPPORTED_VALUES.priority.map((value) => [`priority:${value}`, value])),
  status: new Map(SUPPORTED_VALUES.status.map((value) => [`status:${value}`, value])),
});
const REQUIRED_FIELDS = Object.freeze(["Priority", "Status"]);
const API_VERSION = "2022-11-28";

export function observeIssueField(field, issueLabels = [], timeline = []) {
  const mapping = getFieldLabels(field);
  const active = new Set(issueLabels);
  const supportedLabels = [...mapping.keys()].filter((label) => active.has(label));
  const relevant = timeline
    .map((entry, index) => normalizeTimelineEntry(entry, index))
    .filter((entry) => mapping.has(entry.label) && ["labeled", "unlabeled"].includes(entry.type));
  const orderedEvents = orderTimeline(relevant);
  const latestEvent = orderedEvents.at(-1) ?? null;
  let value = null;
  let ambiguous = false;

  if (supportedLabels.length === 1) {
    value = mapping.get(supportedLabels[0]);
  } else if (supportedLabels.length > 1) {
    const candidates = supportedLabels.map((label) => {
      const lastAdd = orderTimeline(relevant.filter((entry) => entry.label === label && entry.type === "labeled")).at(-1);
      return { label, value: mapping.get(label), createdAt: lastAdd?.createdAt ?? null };
    });
    if (candidates.every((candidate) => isTimestamp(candidate.createdAt))) {
      candidates.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
      const last = candidates.at(-1);
      const previous = candidates.at(-2);
      if (Date.parse(last.createdAt) > Date.parse(previous.createdAt)) value = last.value;
      else ambiguous = true;
    } else {
      ambiguous = true;
    }
  }

  return {
    value,
    labels: supportedLabels,
    ambiguous,
    latestEvent: latestEvent ? { id: latestEvent.id ?? null, createdAt: latestEvent.createdAt ?? null } : null,
  };
}

export function planFieldSync({ field, current, previous = null }) {
  const mapping = getFieldLabels(field);
  if (!current || !current.project || !current.issue) throw new TypeError("A current Project and issue snapshot is required.");
  const projectValue = current.project.value ?? null;
  if (projectValue !== null && !SUPPORTED_VALUES[field].includes(projectValue)) {
    return emptyPlan("unknown-project-option", { field, projectValue });
  }

  let source = null;
  let reason = "unchanged";
  let projectChanged = false;
  let issueChanged = false;

  if (!previous) {
    source = "project";
    reason = "initial-project-value";
  } else {
    projectChanged = projectObservationChanged(previous.project, current.project);
    issueChanged = issueObservationChanged(previous.issue, current.issue);
    if (!projectChanged && !issueChanged) return emptyPlan(reason, { field, projectChanged, issueChanged });

    if (current.issue.ambiguous) {
      source = "project";
      reason = "ambiguous-supported-labels";
    } else if (projectChanged && !issueChanged) {
      source = "project";
      reason = "project-only-change";
    } else if (issueChanged && !projectChanged) {
      source = "issue";
      reason = "issue-only-change";
    } else {
      const projectTime = current.project.updatedAt ?? null;
      const issueTime = current.issue.latestEvent?.createdAt ?? null;
      if (isTimestamp(projectTime) && isTimestamp(issueTime) && Date.parse(projectTime) < Date.parse(issueTime)) {
        source = "issue";
        reason = "issue-newer-than-project";
      } else {
        source = "project";
        reason = isTimestamp(projectTime) && isTimestamp(issueTime) ? "project-newer-or-equal" : "unknown-time-project-wins";
      }
    }
  }

  const targetValue = source === "project" ? projectValue : current.issue.value;
  const labelMutations = labelMutationPlan(field, current.labels ?? [], targetValue, mapping);
  let projectMutation = null;
  if (source === "issue" && projectValue !== targetValue) {
    projectMutation = targetValue === null
      ? { operation: "clear" }
      : { operation: "set", value: targetValue };
  }

  return {
    field,
    decision: { source, reason, targetValue, projectChanged, issueChanged },
    projectMutation,
    labelMutations,
    needsStateAdvance: true,
  };
}

export function validateProjectMetadata(project) {
  if (!project || typeof project.id !== "string" || project.id.length === 0) {
    throw new Error("Project metadata is missing its node ID.");
  }
  const fieldNodes = Array.isArray(project.fields) ? project.fields : project.fields?.nodes;
  if (!Array.isArray(fieldNodes)) throw new Error("Project metadata is missing its fields.");

  const byField = {};
  for (const displayName of REQUIRED_FIELDS) {
    const matches = fieldNodes.filter((field) => field?.name === displayName);
    if (matches.length !== 1) throw new Error(`Project must have exactly one ${displayName} field.`);
    const field = matches[0];
    if (field.__typename !== "ProjectV2SingleSelectField" || typeof field.id !== "string" || !Array.isArray(field.options)) {
      throw new Error(`Project field ${displayName} must be a single-select field with an ID and options.`);
    }
    const optionNames = new Set();
    const optionIds = {};
    for (const option of field.options) {
      if (!option || typeof option.id !== "string" || typeof option.name !== "string" || optionNames.has(option.name)) {
        throw new Error(`Project field ${displayName} has invalid or duplicate options.`);
      }
      optionNames.add(option.name);
      optionIds[option.name] = option.id;
    }
    const key = displayName.toLowerCase();
    const missing = SUPPORTED_VALUES[key].filter((name) => !optionNames.has(name));
    if (missing.length > 0) throw new Error(`Project field ${displayName} is missing required option ${missing[0]}.`);
    byField[key] = { id: field.id, name: displayName, optionIds, options: optionNames };
  }
  return { projectId: project.id, fields: byField };
}

export function selectTargetIssues(items, expectedProjectId, repository = REPOSITORY) {
  return (items ?? []).filter((item) =>
    item?.projectId === expectedProjectId
    && item?.contentType === "Issue"
    && item?.repository === repository
    && Number.isInteger(item?.number)
    && typeof item?.id === "string");
}

export function recoverPendingOperation(pending, current, timeline = []) {
  if (!pending?.before || !pending?.intent || !current) return { status: "ambiguous", baseline: pending?.before ?? null, resultEventIds: [] };
  const field = pending.field;
  getFieldLabels(field);

  if (pending.direction === "issue_to_project") {
    const beforeProject = pending.before.project;
    const nowProject = current.project;
    const fieldChanged = nowProject?.valueId !== beforeProject?.valueId
      || nowProject?.updatedAt !== beforeProject?.updatedAt;
    const mutation = pending.intent.projectMutation;
    const hasRecordedProjectWrite = isPlainObject(pending.resultProject)
      && (pending.resultProject.valueId ?? null) === (nowProject?.valueId ?? null)
      && (pending.resultProject.updatedAt ?? null) === (nowProject?.updatedAt ?? null);
    const projectWriteObserved = mutation?.operation === "clear"
      ? nowProject?.value === null && fieldChanged && hasRecordedProjectWrite
      : mutation?.operation === "set"
        ? nowProject?.value === pending.intent.projectValue && isTimestamp(nowProject.updatedAt) && fieldChanged
          && (!pending.resultProject || hasRecordedProjectWrite)
        : mutation === null
          ? nowProject?.value === pending.intent.projectValue && !projectObservationChanged(beforeProject, nowProject)
          : mutation === undefined
            ? (pending.intent.projectValue === undefined
              ? !projectObservationChanged(beforeProject, nowProject)
              : nowProject?.value === pending.intent.projectValue && isTimestamp(nowProject.updatedAt) && fieldChanged)
          : false;
    const plannedLabelMutations = pending.intent.labelMutations ?? { add: [], remove: [] };
    const hasLabelMutations = plannedLabelMutations.add.length > 0 || plannedLabelMutations.remove.length > 0;
    let labelsRecovered = !hasLabelMutations;
    let issueAtResult = null;
    let labelsAtResult = null;
    if (hasLabelMutations) {
      const classified = classifyPendingLabelEvents(pending, timeline, plannedLabelMutations);
      const allOperationsObserved = classified.valid && classified.ownEvents.length === plannedLabelMutations.remove.length + plannedLabelMutations.add.length;
      const lastOwn = classified.ownEvents.at(-1);
      const noHumanBeforeCompletion = !lastOwn || !classified.foreignEvents.some((entry) => entry.order <= lastOwn.order);
      labelsRecovered = allOperationsObserved && noHumanBeforeCompletion;
      if (labelsRecovered && lastOwn) {
        labelsAtResult = activeLabelsAtResult(pending.before.labels ?? [], classified.ownEvents, classified.ownEvents.map((entry) => entry.id));
        const resultRelevant = timeline.map((entry, index) => normalizeTimelineEntry(entry, index))
          .filter((entry) => getFieldLabels(field).has(entry.label) && ["labeled", "unlabeled"].includes(entry.type) && entry.order <= lastOwn.order);
        issueAtResult = observeIssueField(field, [...labelsAtResult], resultRelevant);
      }
    }
    if (projectWriteObserved && labelsRecovered) {
      return {
        status: "recovered",
        baseline: {
          ...pending.before,
          project: { ...nowProject },
          ...(issueAtResult ? { issue: issueAtResult, labels: [...labelsAtResult] } : {}),
        },
        resultEventIds: [],
        result: { projectValueId: nowProject.valueId ?? null, projectUpdatedAt: nowProject.updatedAt },
      };
    }
    return { status: "ambiguous", baseline: pending.before, resultEventIds: [] };
  }

  if (pending.direction === "project_to_issue") {
    const mapping = getFieldLabels(field);
    const expected = [...new Set(pending.intent.issueLabels ?? [])].sort();
    const relevant = timeline.map((entry, index) => normalizeTimelineEntry(entry, index))
      .filter((entry) => mapping.has(entry.label) && ["labeled", "unlabeled"].includes(entry.type));
    const desiredValue = Object.hasOwn(pending.intent, "projectValue")
      ? pending.intent.projectValue
      : (pending.intent.issueLabels ?? []).map((label) => [...mapping.keys()].find((supported) => supported === label)).filter(Boolean)
        .map((label) => mapping.get(label))[0] ?? null;
    const planned = pending.intent.labelMutations ?? expectedIssueLabels(field, pending.before.labels ?? [], desiredValue);
    const classified = classifyPendingLabelEvents(pending, timeline, planned);
    if (!classified.valid) return { status: "ambiguous", baseline: pending.before, resultEventIds: [] };
    const active = new Set(pending.before.labels ?? []);
    let candidates = [];
    let recoveredSnapshot = null;
    let recoveryIds = [];

    for (const entry of classified.ownEvents) {
      if (entry.type === "labeled") active.add(entry.label);
      else active.delete(entry.label);
      candidates.push(entry.id);
      const familyActive = [...mapping.keys()].filter((label) => active.has(label)).sort();
      const humanPrecededCompletion = classified.foreignEvents.some((foreign) => foreign.order <= entry.order);
      if (sameStringArray(familyActive, expected) && !humanPrecededCompletion) {
        recoveredSnapshot = observeIssueField(field, [...active], relevant.filter((item) => item.order <= entry.order));
        recoveryIds = [...candidates];
      }
    }

    if (recoveredSnapshot) {
      const baseline = {
        ...pending.before,
        issue: recoveredSnapshot,
        labels: [...activeLabelsAtResult(pending.before.labels ?? [], relevant, recoveryIds)].sort(),
      };
      return { status: "recovered", baseline, resultEventIds: recoveryIds };
    }

    // Resume only when every post-start event in this field family can be
    // attributed to this workflow and the observed labels equal that replay.
    // A human edit after a partial write makes the pending intent ambiguous.
    const botEvents = classified.ownEvents;
    const onlyBotEvents = classified.foreignEvents.length === 0;
    const replay = new Set(pending.before.labels ?? []);
    for (const entry of botEvents) {
      if (entry.type === "labeled") replay.add(entry.label);
      else replay.delete(entry.label);
    }
    const replayLabels = [...replay].filter((label) => mapping.has(label)).sort();
    const observedLabels = (current.labels ?? []).filter((label) => mapping.has(label)).sort();
    const sourceStillMatches = !projectObservationChanged(pending.before.project, current.project);
    if (onlyBotEvents && sourceStillMatches && sameStringArray(replayLabels, observedLabels)) {
      return { status: "resume", baseline: pending.before, resultEventIds: botEvents.map((entry) => entry.id) };
    }
    return { status: "ambiguous", baseline: pending.before, resultEventIds: [] };
  }

  return { status: "ambiguous", baseline: pending.before, resultEventIds: [] };
}

function classifyPendingLabelEvents(pending, timeline, labelMutations) {
  const mapping = getFieldLabels(pending.field);
  const relevant = orderTimeline(timeline.map((entry, index) => normalizeTimelineEntry(entry, index))
    .filter((entry) => mapping.has(entry.label) && ["labeled", "unlabeled"].includes(entry.type)));
  const cursor = pending.beforeEventCursor ?? pending.before?.issue?.latestEvent?.id ?? null;
  let afterCursor = relevant;
  if (cursor !== null) {
    const cursorIndex = relevant.findIndex((entry) => String(entry.id) === String(cursor));
    if (cursorIndex < 0) return { valid: false, ownEvents: [], foreignEvents: relevant };
    afterCursor = relevant.slice(cursorIndex + 1);
  }
  const expected = [
    ...(labelMutations.remove ?? []).map((label) => ({ type: "unlabeled", label })),
    ...(labelMutations.add ?? []).map((label) => ({ type: "labeled", label })),
  ];
  const resultIds = new Set((pending.resultEventIds ?? []).map(String));
  if ([...resultIds].some((id) => !afterCursor.some((entry) => String(entry.id) === id))) {
    return { valid: false, ownEvents: [], foreignEvents: afterCursor };
  }
  const startSecond = isTimestamp(pending.startedAt) ? Math.floor(Date.parse(pending.startedAt) / 1000) * 1000 : null;
  const ownEvents = [];
  const foreignEvents = [];
  let nextOperation = 0;
  for (const entry of afterCursor) {
    const recorded = resultIds.has(String(entry.id));
    const matches = (operation) => operation?.type === entry.type && operation.label === entry.label;
    if (recorded) {
      if (!isAutomationActor(entry.actor) || !expected.some(matches)) return { valid: false, ownEvents, foreignEvents: [...foreignEvents, entry] };
      const matchIndex = expected.findIndex((operation, index) => index >= nextOperation && matches(operation));
      if (matchIndex < 0) return { valid: false, ownEvents, foreignEvents: [...foreignEvents, entry] };
      nextOperation = matchIndex + 1;
      ownEvents.push(entry);
    } else if (isAutomationActor(entry.actor) && startSecond !== null && Date.parse(entry.createdAt) >= startSecond
      && matches(expected[nextOperation])) {
      nextOperation += 1;
      ownEvents.push(entry);
    } else {
      foreignEvents.push(entry);
    }
  }
  return { valid: true, ownEvents, foreignEvents };
}

export async function planFromFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || !fixture.current) throw new TypeError("A JSON fixture with a current snapshot is required.");
  return planFieldSync({ field: fixture.field, current: fixture.current, previous: fixture.previous ?? null });
}

function getFieldLabels(field) {
  const value = FIELD_LABELS[field];
  if (!value) throw new TypeError(`Unsupported field ${String(field)}.`);
  return value;
}

function projectObservationChanged(previous, current) {
  return !previous
    || previous.value !== (current.value ?? null)
    || (previous.updatedAt ?? null) !== (current.updatedAt ?? null)
    || (previous.valueId ?? null) !== (current.valueId ?? null);
}

function issueObservationChanged(previous, current) {
  return !previous
    || previous.value !== current.value
    || previous.ambiguous !== current.ambiguous
    || !sameStringArray(previous.labels ?? [], current.labels ?? [])
    || (previous.latestEvent?.id ?? null) !== (current.latestEvent?.id ?? null)
    || (previous.latestEvent?.createdAt ?? null) !== (current.latestEvent?.createdAt ?? null);
}

function labelMutationPlan(field, currentLabels, targetValue, mapping) {
  const allowed = [...mapping.keys()];
  const current = new Set(currentLabels);
  const desired = targetValue === null ? null : `${field}:${targetValue}`;
  const remove = allowed.filter((label) => current.has(label) && label !== desired);
  const add = desired !== null && !current.has(desired) ? [desired] : [];
  return { add, remove };
}

function emptyPlan(reason, details) {
  return {
    field: details.field,
    decision: { source: null, reason, targetValue: undefined, projectChanged: details.projectChanged ?? false, issueChanged: details.issueChanged ?? false },
    projectMutation: null,
    labelMutations: { add: [], remove: [] },
    needsStateAdvance: false,
  };
}

function normalizeTimelineEntry(entry, order) {
  const type = String(entry?.event ?? entry?.type ?? "").toLowerCase();
  const label = typeof entry?.label === "string" ? entry.label : entry?.label?.name;
  const actor = typeof entry?.actor === "string" ? entry.actor : entry?.actor?.login;
  return { id: entry?.id ?? null, label: label ?? null, type, actor: actor ?? null, createdAt: entry?.createdAt ?? entry?.created_at ?? null, order };
}

function orderTimeline(entries) {
  return [...entries].sort((left, right) => {
    if (isTimestamp(left.createdAt) && isTimestamp(right.createdAt)) {
      const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (byTime !== 0) return byTime;
    }
    return left.order - right.order;
  });
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameStringArray(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAutomationActor(actor) {
  return typeof actor === "string" && actor.toLowerCase() === "github-actions[bot]";
}

function activeLabelsAtResult(initialLabels, relevant, resultIds) {
  const active = new Set(initialLabels);
  const wanted = new Set(resultIds);
  for (const entry of orderTimeline(relevant)) {
    if (!wanted.has(entry.id)) continue;
    if (entry.type === "labeled") active.add(entry.label);
    else active.delete(entry.label);
  }
  return active;
}

export function createGitHubAdapter({ projectToken, githubToken, fetchImpl = globalThis.fetch }) {
  if (!projectToken || !githubToken) throw new Error("PROJECTS_TOKEN and GITHUB_TOKEN are required.");
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  const request = async (token, route, options = {}) => {
    const response = await fetchImpl(`https://api.github.com${route}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let data = null;
    try {
      data = response.status === 204 ? null : await response.json();
    } catch {
      data = null;
    }
    if (options.allow404 && response.status === 404) return { data: null, response };
    if (!response.ok) throw new Error(`GitHub REST request failed (${response.status}).`);
    return { data, response };
  };

  const graphql = async (query, variables = {}) => {
    const { data } = await request(projectToken, "/graphql", { method: "POST", body: { query, variables } });
    if (!data || (Array.isArray(data.errors) && data.errors.length > 0)) {
      const count = Array.isArray(data?.errors) ? data.errors.length : 1;
      throw new Error(`GitHub GraphQL request failed (${count} error(s)).`);
    }
    return data.data;
  };

  const readProject = async () => {
    const query = `query ProjectSyncMetadata($owner: String!, $number: Int!) {
      user(login: $owner) {
        projectV2(number: $number) {
          id
          fields(first: 100) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`;
    const result = await graphql(query, { owner: PROJECT_OWNER, number: PROJECT_NUMBER });
    const project = result?.user?.projectV2;
    if (!project) throw new Error("Personal Project #4 was not found or is not readable.");
    if (project.fields?.pageInfo?.hasNextPage) throw new Error("Project fields exceed the supported page; no changes were made.");
    return { id: project.id, fields: project.fields?.nodes ?? [] };
  };

  const readProjectItems = async (projectId) => {
    const items = [];
    let cursor = null;
    do {
      const query = `query ProjectSyncItems($projectId: ID!, $cursor: String) {
        node(id: $projectId) {
          __typename
          ... on ProjectV2 {
            items(first: 100, after: $cursor) {
      nodes {
                id
                content {
                  __typename
                  ... on Issue { number repository { nameWithOwner } }
                  ... on PullRequest { number repository { nameWithOwner } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`;
      const result = await graphql(query, { projectId, cursor });
      const project = result?.node;
      if (!project || project.__typename !== "ProjectV2") throw new Error("Project identity changed while reading items.");
      const page = project.items;
      for (const node of page?.nodes ?? []) {
        const content = node.content;
        items.push({
          projectId,
          id: node.id,
          contentType: content?.__typename,
          number: content?.number,
          repository: content?.repository?.nameWithOwner,
        });
      }
      if (!page?.pageInfo?.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
      if (!cursor) throw new Error("Project item pagination did not return a cursor.");
      if (items.length > 100000) throw new Error("Project item pagination exceeded the safety limit.");
    } while (cursor);
    return items;
  };

  const readProjectItem = async (itemId, projectId) => {
    const query = `query ProjectSyncItem($itemId: ID!) {
      node(id: $itemId) {
        __typename
        ... on ProjectV2Item {
          id
          project { id }
          content {
            __typename
            ... on Issue { number repository { nameWithOwner } }
            ... on PullRequest { number repository { nameWithOwner } }
          }
          fieldValues(first: 100) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                id name optionId updatedAt field { ... on ProjectV2SingleSelectField { id name } }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      }
    }`;
    const result = await graphql(query, { itemId });
    const node = result?.node;
    if (!node || node.__typename !== "ProjectV2Item" || node.id !== itemId) throw new Error("Project item could not be re-read.");
    if (!node.project || node.project.id !== projectId) throw new Error("Project item membership changed or could not be verified.");
    if (node.fieldValues?.pageInfo?.hasNextPage) throw new Error("Project item has too many field values; no changes were made.");
    const content = node.content;
    return {
      projectId,
      id: node.id,
      contentType: content?.__typename,
      number: content?.number,
      repository: content?.repository?.nameWithOwner,
      fieldValues: (node.fieldValues?.nodes ?? []).filter((value) => value.__typename === "ProjectV2ItemFieldSingleSelectValue").map((value) => ({
        id: value.id,
        name: value.name,
        optionId: value.optionId,
        updatedAt: value.updatedAt,
        fieldId: value.field?.id,
        fieldName: value.field?.name,
      })),
    };
  };

  const readIssue = async (issueNumber) => {
    const labels = await readRestCollection(`/repos/${REPOSITORY}/issues/${issueNumber}/labels`);
    const timeline = await readRestCollection(`/repos/${REPOSITORY}/issues/${issueNumber}/timeline`);
    return {
      labels: labels.map((label) => label.name).filter((name) => typeof name === "string"),
      timeline: timeline.filter((entry) => ["labeled", "unlabeled"].includes(String(entry.event).toLowerCase())).map((entry) => ({
        id: String(entry.id),
        event: String(entry.event).toLowerCase(),
        label: entry.label?.name ?? null,
        createdAt: entry.created_at ?? null,
        actor: entry.actor?.login ?? null,
      })),
    };
  };

  const ensureSupportedLabels = async () => {
    const existing = await readRestCollection(`/repos/${REPOSITORY}/labels`);
    const byFoldedName = new Map(existing.filter((label) => typeof label.name === "string")
      .map((label) => [label.name.toLowerCase(), label]));
    for (const name of SUPPORTED_LABELS) {
      const current = byFoldedName.get(name.toLowerCase());
      if (current && current.name !== name) throw new Error(`Repository label casing conflicts with supported label ${name}.`);
    }
    const created = [];
    for (const [index, name] of SUPPORTED_LABELS.entries()) {
      const current = byFoldedName.get(name.toLowerCase());
      if (current) continue;
      await request(githubToken, `/repos/${REPOSITORY}/labels`, {
        method: "POST",
        body: { name, color: SUPPORTED_LABEL_COLORS[index], description: "Managed by Project #4 synchronization." },
      });
      created.push(name);
      byFoldedName.set(name.toLowerCase(), { name });
    }
    return created;
  };

  const readRestCollection = async (route) => {
    const values = [];
    for (let page = 1; page <= 1000; page += 1) {
      const { data, response } = await request(githubToken, `${route}?per_page=100&page=${page}`);
      if (!Array.isArray(data)) throw new Error("GitHub REST collection response had an unexpected shape.");
      values.push(...data);
      const next = response.headers?.get?.("link")?.split(",").some((part) => /rel="next"/.test(part)) ?? data.length === 100;
      if (!next) return values;
    }
    throw new Error("GitHub REST collection exceeded the pagination safety limit.");
  };

  const updateProjectField = async ({ projectId, itemId, fieldId, optionId }) => {
    const mutation = `mutation SetProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }`;
    const result = await graphql(mutation, { projectId, itemId, fieldId, optionId });
    if (!result?.updateProjectV2ItemFieldValue?.projectV2Item?.id) throw new Error("Project field update returned no item ID.");
  };

  const clearProjectField = async ({ projectId, itemId, fieldId }) => {
    const mutation = `mutation ClearProjectField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) {
        projectV2Item { id }
      }
    }`;
    const result = await graphql(mutation, { projectId, itemId, fieldId });
    if (!result?.clearProjectV2ItemFieldValue?.projectV2Item?.id) throw new Error("Project field clear returned no item ID.");
  };

  const addIssueLabels = async (issueNumber, labels) => {
    if (!labels.length) return;
    await request(githubToken, `/repos/${REPOSITORY}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } });
  };

  const removeIssueLabel = async (issueNumber, label) => {
    await request(githubToken, `/repos/${REPOSITORY}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, { method: "DELETE" });
  };

  const readState = async (expectedProjectId) => {
    const ref = await request(githubToken, `/repos/${REPOSITORY}/git/ref/heads/${STATE_BRANCH}`, { allow404: true });
    if (!ref.data) return null;
    const commit = await request(githubToken, `/repos/${REPOSITORY}/git/commits/${ref.data.object.sha}`);
    const tree = await request(githubToken, `/repos/${REPOSITORY}/git/trees/${commit.data.tree.sha}?recursive=1`);
    const entry = tree.data.tree?.find((node) => node.path === STATE_PATH && node.type === "blob");
    if (!entry) throw new Error("Existing state branch is missing state.json; refusing to initialize over it.");
    const blob = await request(githubToken, `/repos/${REPOSITORY}/git/blobs/${entry.sha}`);
    if (blob.data.encoding !== "base64" || typeof blob.data.content !== "string") throw new Error("State blob has an unsupported encoding.");
    let state;
    try {
      state = JSON.parse(Buffer.from(blob.data.content, "base64").toString("utf8"));
    } catch {
      throw new Error("State JSON is invalid; no remote state was changed.");
    }
    validateState(state, expectedProjectId);
    return { state, refSha: ref.data.object.sha };
  };

  const writeState = async (state, expectedProjectId, refSha) => {
    validateState(state, expectedProjectId);
    const content = JSON.stringify(state, null, 2) + "\n";
    if (!refSha) {
      const tree = await request(githubToken, `/repos/${REPOSITORY}/git/trees`, {
        method: "POST",
        body: { tree: [{ path: STATE_PATH, mode: "100644", type: "blob", content }] },
      });
      const commit = await request(githubToken, `/repos/${REPOSITORY}/git/commits`, {
        method: "POST",
        body: { message: "同期状態の初期化", tree: tree.data.sha, parents: [] },
      });
      const ref = await request(githubToken, `/repos/${REPOSITORY}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${STATE_BRANCH}`, sha: commit.data.sha },
      });
      return ref.data.object.sha;
    }

    const parent = await request(githubToken, `/repos/${REPOSITORY}/git/commits/${refSha}`);
    const blob = await request(githubToken, `/repos/${REPOSITORY}/git/blobs`, {
      method: "POST", body: { content, encoding: "utf-8" },
    });
    const tree = await request(githubToken, `/repos/${REPOSITORY}/git/trees`, {
      method: "POST",
      body: {
        base_tree: parent.data.tree.sha,
        tree: [{ path: STATE_PATH, mode: "100644", type: "blob", sha: blob.data.sha }],
      },
    });
    const commit = await request(githubToken, `/repos/${REPOSITORY}/git/commits`, {
      method: "POST",
      body: { message: "同期状態を更新", tree: tree.data.sha, parents: [refSha] },
    });
    const ref = await request(githubToken, `/repos/${REPOSITORY}/git/refs/heads/${STATE_BRANCH}`, {
      method: "PATCH", body: { sha: commit.data.sha, force: false },
    });
    return ref.data.object.sha;
  };

  return {
    readProject,
    readProjectItems,
    readProjectItem,
    readIssue,
    ensureSupportedLabels,
    updateProjectField,
    clearProjectField,
    addIssueLabels,
    removeIssueLabel,
    readState,
    writeState,
  };
}

export function validateState(state, expectedProjectId) {
  if (!isPlainObject(state) || state.schemaVersion !== 1 || state.repository !== REPOSITORY || state.projectId !== expectedProjectId || !isPlainObject(state.items)) {
    throw new Error("Synchronization state does not match this repository, Project, or schema.");
  }
  for (const [itemId, item] of Object.entries(state.items)) {
    if (!itemId || !isPlainObject(item) || !Number.isInteger(item.issueNumber) || item.issueNumber < 1 || !isPlainObject(item.fields)) {
      throw new Error("Synchronization state contains a malformed item record.");
    }
    for (const field of ["priority", "status"]) {
      const fieldState = item.fields[field];
      if (!isPlainObject(fieldState) || !(fieldState.baseline === null || isValidSnapshot(fieldState.baseline, field))
        || !(fieldState.pending === null || isValidPending(fieldState.pending, field))) {
        throw new Error(`Synchronization state contains an invalid ${field} baseline or pending record.`);
      }
    }
  }
  const json = JSON.stringify(state);
  if (/"(?:token|secret|authorization|headers)"\s*:/i.test(json)) throw new Error("Synchronization state contains a forbidden credential field.");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isValidSnapshot(snapshot, field) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.project) || !isPlainObject(snapshot.issue)) return false;
  if (!SUPPORTED_VALUES[field]) return false;
  if (!isNullableString(snapshot.project.value) || !isNullableString(snapshot.project.updatedAt)
    || !isNullableString(snapshot.project.valueId) || (snapshot.project.optionId !== undefined && !isNullableString(snapshot.project.optionId))) return false;
  if (!isNullableString(snapshot.issue.value) || typeof snapshot.issue.ambiguous !== "boolean"
    || !Array.isArray(snapshot.issue.labels) || !snapshot.issue.labels.every((label) => typeof label === "string")
    || !Array.isArray(snapshot.labels) || !snapshot.labels.every((label) => typeof label === "string")) return false;
  const allowed = new Set(SUPPORTED_VALUES[field].map((value) => `${field}:${value}`));
  if ((snapshot.project.value !== null && !SUPPORTED_VALUES[field].includes(snapshot.project.value))
    || (snapshot.issue.value !== null && !SUPPORTED_VALUES[field].includes(snapshot.issue.value))
    || !snapshot.issue.labels.every((label) => allowed.has(label))) return false;
  const latest = snapshot.issue.latestEvent;
  return latest === null || (isPlainObject(latest) && isNullableString(latest.id) && isNullableString(latest.createdAt));
}

function isValidPending(pending, field) {
  if (!isPlainObject(pending) || pending.field !== field || !["project_to_issue", "issue_to_project"].includes(pending.direction)
    || !isValidSnapshot(pending.before, field) || !isPlainObject(pending.intent) || !isNullableString(pending.intent.projectValue)
    || !Array.isArray(pending.intent.issueLabels) || !pending.intent.issueLabels.every((label) => typeof label === "string")
    || !isTimestamp(pending.startedAt) || !Array.isArray(pending.resultEventIds) || !pending.resultEventIds.every((id) => typeof id === "string")
    || (pending.beforeEventCursor !== undefined && !isNullableString(pending.beforeEventCursor))) return false;
  const supportedValues = new Set(SUPPORTED_VALUES[field]);
  const supportedLabels = new Set(SUPPORTED_VALUES[field].map((value) => `${field}:${value}`));
  if ((pending.intent.projectValue !== null && !supportedValues.has(pending.intent.projectValue))
    || !pending.intent.issueLabels.every((label) => supportedLabels.has(label))) return false;
  const projectMutation = pending.intent.projectMutation;
  if (projectMutation !== null && projectMutation !== undefined
    && !(isPlainObject(projectMutation) && (projectMutation.operation === "clear"
      || (projectMutation.operation === "set" && supportedValues.has(projectMutation.value))))) return false;
  const labelMutations = pending.intent.labelMutations;
  if (!isPlainObject(labelMutations) || !Array.isArray(labelMutations.add) || !Array.isArray(labelMutations.remove)
    || !labelMutations.add.every((label) => supportedLabels.has(label)) || !labelMutations.remove.every((label) => supportedLabels.has(label))) return false;
  if (pending.direction === "project_to_issue" && projectMutation) return false;
  if (pending.direction === "issue_to_project" && labelMutations.add.length > 0) return false;
  const resultProject = pending.resultProject;
  return resultProject === null || resultProject === undefined
    || (isPlainObject(resultProject) && isNullableString(resultProject.valueId) && isNullableString(resultProject.updatedAt));
}

function emptyState(projectId) {
  return { schemaVersion: 1, repository: REPOSITORY, projectId, items: {} };
}

function fieldStateFor(itemState, field) {
  itemState.fields ??= {};
  itemState.fields[field] ??= { baseline: null, pending: null };
  return itemState.fields[field];
}

async function readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field) {
  const projectItem = await adapter.readProjectItem(target.id, projectId);
  if (projectItem.projectId !== projectId || projectItem.contentType !== "Issue" || projectItem.repository !== REPOSITORY || projectItem.number !== target.number) {
    throw new Error(`Issue #${target.number} changed identity or Project membership; refusing to write.`);
  }
  const issue = await adapter.readIssue(target.number);
  const projectValue = projectItem.fieldValues.find((value) => value.fieldId === fieldMetadata.id) ?? null;
  const current = {
    project: {
      value: projectValue?.name ?? null,
      updatedAt: projectValue?.updatedAt ?? null,
      valueId: projectValue?.id ?? null,
      optionId: projectValue?.optionId ?? null,
    },
    issue: observeIssueField(field, issue.labels, issue.timeline),
    labels: issue.labels,
  };
  return { current, issue };
}

function snapshotEqual(field, left, right) {
  return !projectObservationChanged(left.project, right.project)
    && !issueObservationChanged(left.issue, right.issue)
    && sameStringArray(
      (left.labels ?? []).filter((label) => getFieldLabels(field).has(label)),
      (right.labels ?? []).filter((label) => getFieldLabels(field).has(label)),
    );
}

function expectedIssueLabels(field, currentLabels, desiredValue) {
  return labelMutationPlan(field, currentLabels, desiredValue, getFieldLabels(field));
}

function pendingForPlan(field, current, planResult, runId) {
  const direction = planResult.decision.source === "project" ? "project_to_issue" : "issue_to_project";
  const desiredValue = planResult.decision.targetValue ?? null;
  return {
    runId,
    field,
    direction,
    startedAt: new Date().toISOString(),
    beforeEventCursor: current.issue.latestEvent?.id ?? null,
    before: current,
    intent: {
      projectValue: desiredValue,
      issueLabels: desiredValue === null ? [] : [`${field}:${desiredValue}`],
      projectMutation: planResult.projectMutation,
      labelMutations: planResult.labelMutations,
    },
    resultEventIds: [],
    resultProject: null,
  };
}

function targetSideBaseline(field, pending, after) {
  const baseline = structuredClone(pending.before);
  if (pending.direction === "project_to_issue") {
    baseline.issue = after.issue;
    baseline.labels = after.labels;
  } else {
    baseline.project = after.project;
    if (pending.intent.labelMutations?.add.length || pending.intent.labelMutations?.remove.length) {
      baseline.issue = after.issue;
      baseline.labels = after.labels;
    }
  }
  return baseline;
}

function isExpectedIssueState(field, snapshot, expectedValue) {
  const expectedLabel = expectedValue === null ? null : `${field}:${expectedValue}`;
  const actual = [...getFieldLabels(field).keys()].filter((label) => (snapshot.labels ?? []).includes(label));
  return expectedLabel === null ? actual.length === 0 : actual.length === 1 && actual[0] === expectedLabel;
}

function planForOutput(issueNumber, planResult, dryRun) {
  return {
    issueNumber,
    field: planResult.field,
    source: planResult.decision.source,
    reason: planResult.decision.reason,
    targetValue: planResult.decision.targetValue ?? null,
    projectMutation: planResult.projectMutation,
    addLabels: planResult.labelMutations.add,
    removeLabels: planResult.labelMutations.remove,
    dryRun,
  };
}

export async function synchronizeProject({ adapter, dryRun = false, issueNumber = null, logger = null, maxRetries = 3 }) {
  if (!adapter) throw new TypeError("A GitHub adapter is required.");
  const project = await adapter.readProject();
  const metadata = validateProjectMetadata(project);
  const targets = selectTargetIssues(await adapter.readProjectItems(project.id), project.id, REPOSITORY)
    .filter((item) => issueNumber === null || item.number === issueNumber);
  const stored = await adapter.readState(project.id);
  if (stored) validateState(stored.state, project.id);
  const state = stored?.state ?? emptyState(project.id);
  let refSha = stored?.refSha ?? null;
  const plans = [];
  const initialSnapshots = new Map();

  // Verify every persisted Project item identity before reads that may lead to any write.
  for (const target of targets) {
    const itemState = state.items[target.id];
    if (itemState && itemState.issueNumber !== target.number) {
      throw new Error("State item ID maps to a different issue number.");
    }
  }

  // Read every target and both fields before the first persistent or content write.
  for (const target of targets) {
    for (const field of ["priority", "status"]) {
      initialSnapshots.set(`${target.id}:${field}`, await readCurrentSnapshot(adapter, target, project.id, metadata.fields[field], field));
    }
  }

  if (!dryRun && targets.length > 0 && typeof adapter.ensureSupportedLabels === "function") await adapter.ensureSupportedLabels();

  for (const target of targets) {
    state.items[target.id] ??= {
      issueNumber: target.number,
      fields: {
        priority: { baseline: null, pending: null },
        status: { baseline: null, pending: null },
      },
    };
    const itemState = state.items[target.id];

    for (const field of ["priority", "status"]) {
      const storedField = fieldStateFor(itemState, field);
      let attempts = 0;
      while (attempts < maxRetries) {
        attempts += 1;
        const { current, issue } = attempts === 1
          ? initialSnapshots.get(`${target.id}:${field}`)
          : await readCurrentSnapshot(adapter, target, project.id, metadata.fields[field], field);
        if (storedField.pending) {
          const recovered = recoverPendingOperation(storedField.pending, current, issue.timeline);
          if (recovered.status === "recovered") {
            storedField.baseline = recovered.baseline;
            storedField.pending = null;
            if (!dryRun) refSha = await adapter.writeState(state, project.id, refSha);
          } else if (recovered.status === "resume") {
            if (dryRun) {
              plans.push({ issueNumber: target.number, field, source: "pending", reason: "resume-after-interruption", dryRun: true });
              break;
            }
            refSha = await resumePending(adapter, state, itemState, storedField, {
              ...recovered,
              observedSnapshot: current,
              observedTimeline: issue.timeline,
            }, target, project.id, metadata.fields[field], field, refSha);
            continue;
          }
        }

        const planResult = planFieldSync({ field, current, previous: storedField.baseline });
        plans.push(planForOutput(target.number, planResult, dryRun));
        if (dryRun) break;
        if (!planResult.needsStateAdvance) break;

        const hasMutation = Boolean(planResult.projectMutation)
          || planResult.labelMutations.add.length > 0
          || planResult.labelMutations.remove.length > 0;
        if (!hasMutation) {
          storedField.baseline = current;
          storedField.pending = null;
          refSha = await adapter.writeState(state, project.id, refSha);
          break;
        }

        const pending = pendingForPlan(field, current, planResult, `${Date.now()}-${target.number}-${field}`);
        storedField.pending = pending;
        refSha = await adapter.writeState(state, project.id, refSha);

        const preflight = await readCurrentSnapshot(adapter, target, project.id, metadata.fields[field], field);
        if (!snapshotEqual(field, current, preflight.current)) {
          storedField.pending = null;
          refSha = await adapter.writeState(state, project.id, refSha);
          if (attempts >= maxRetries) throw new Error(`Issue #${target.number} changed repeatedly before a write; retry on the next event.`);
          continue;
        }

        pending.before = preflight.current;
        storedField.pending = pending;
        refSha = await adapter.writeState(state, project.id, refSha);

        await executePending(adapter, state, itemState, storedField, pending, target, project.id, metadata.fields[field], field, refSha);
        refSha = storedField._refSha ?? refSha;
        storedField._refSha = refSha;
        break;
      }
      delete storedField._refSha;
      if (attempts >= maxRetries && storedField.pending) throw new Error(`Issue #${target.number} ${field} synchronization exceeded retries.`);
    }
  }

  if (!dryRun && !stored) {
    const hasAnyItem = Object.keys(state.items).length > 0;
    if (hasAnyItem && !refSha) refSha = await adapter.writeState(state, project.id, null);
  }
  if (logger) logger(plans);
  return { projectId: project.id, targetCount: targets.length, plans };
}

async function resumePending(adapter, state, itemState, storedField, recovery, target, projectId, fieldMetadata, field, refSha) {
  let pending = storedField.pending;
  if (recovery.baseline) {
    pending = { ...pending, resultEventIds: recovery.resultEventIds };
    storedField.pending = pending;
    refSha = await adapter.writeState(state, projectId, refSha);
  }
  const current = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
  if (!snapshotEqual(field, recovery.observedSnapshot, current.current)
    || timelineSignature(field, recovery.observedTimeline) !== timelineSignature(field, current.issue.timeline)) {
    throw new Error(`Issue #${target.number} changed while resuming ${field}; pending state retained.`);
  }
  if (!sourceUnchanged(pending, current.current)) {
    storedField.pending = null;
    refSha = await adapter.writeState(state, projectId, refSha);
    return refSha;
  }
  const remaining = expectedIssueLabels(field, current.current.labels, pending.intent.projectValue);
  if (remaining.add.length === 0 && remaining.remove.length === 0) {
    const final = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    storedField.baseline = targetSideBaseline(field, pending, final.current);
    storedField.pending = null;
    return await adapter.writeState(state, projectId, refSha);
  }
  let expectedLabels = [...current.current.labels];
  for (const label of remaining.remove) {
    const beforeAction = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    if (!sourceUnchanged(pending, beforeAction.current) || !sameStringArray(beforeAction.current.labels, expectedLabels)) {
      throw new Error(`Issue #${target.number} changed while resuming ${field}; pending state retained.`);
    }
    await adapter.removeIssueLabel(target.number, label);
    expectedLabels = expectedLabels.filter((existing) => existing !== label);
    const after = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    recordNewBotEvents(pending, current.issue.timeline, after.issue.timeline, label, "unlabeled");
    refSha = await adapter.writeState(state, projectId, refSha);
    if (!sourceUnchanged(pending, after.current) || !sameStringArray(after.current.labels, expectedLabels)) throw new Error(`Issue #${target.number} changed while resuming ${field}; pending state retained.`);
  }
  if (remaining.add.length > 0) {
    const beforeAction = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    if (!sourceUnchanged(pending, beforeAction.current) || !sameStringArray(beforeAction.current.labels, expectedLabels)) {
      throw new Error(`Issue #${target.number} changed while resuming ${field}; pending state retained.`);
    }
    await adapter.addIssueLabels(target.number, remaining.add);
    expectedLabels = [...new Set([...expectedLabels, ...remaining.add])];
    const after = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    for (const label of remaining.add) recordNewBotEvents(pending, current.issue.timeline, after.issue.timeline, label, "labeled");
    refSha = await adapter.writeState(state, projectId, refSha);
    if (!sourceUnchanged(pending, after.current) || !sameStringArray(after.current.labels, expectedLabels)) throw new Error(`Issue #${target.number} changed while resuming ${field}; pending state retained.`);
  }
  const final = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
  if (!isExpectedIssueState(field, final.current, pending.intent.projectValue)) throw new Error(`Issue #${target.number} labels did not match the pending Project value.`);
  storedField.baseline = targetSideBaseline(field, pending, final.current);
  storedField.pending = null;
  return await adapter.writeState(state, projectId, refSha);
}

function sourceUnchanged(pending, current) {
  if (pending.direction === "project_to_issue") return !projectObservationChanged(pending.before.project, current.project);
  if (pending.direction === "issue_to_project") return !issueObservationChanged(pending.before.issue, current.issue);
  return false;
}

function timelineSignature(field, timeline = []) {
  const mapping = getFieldLabels(field);
  return JSON.stringify(orderTimeline(timeline.map((entry, index) => normalizeTimelineEntry(entry, index))
    .filter((entry) => mapping.has(entry.label) && ["labeled", "unlabeled"].includes(entry.type))
    .map(({ id, label, type, actor, createdAt }) => ({ id, label, type, actor, createdAt }))));
}

async function executePending(adapter, state, itemState, storedField, pending, target, projectId, fieldMetadata, field, initialRefSha) {
  let refSha = initialRefSha;
  if (pending.intent.projectMutation) {
    const mutation = pending.intent.projectMutation;
    const beforeWrite = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    if (!snapshotEqual(field, pending.before, beforeWrite.current)) throw new Error(`Issue #${target.number} changed before Project ${field} update; pending state retained.`);
    if (mutation.operation === "set") {
      const optionId = fieldMetadata.optionIds[mutation.value];
      if (!optionId) throw new Error(`Project option for ${field} is unavailable; refusing to write.`);
      await adapter.updateProjectField({ projectId, itemId: target.id, fieldId: fieldMetadata.id, optionId });
    } else {
      await adapter.clearProjectField({ projectId, itemId: target.id, fieldId: fieldMetadata.id });
    }
    const updated = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    pending.resultProject = { valueId: updated.current.project.valueId, updatedAt: updated.current.project.updatedAt };
    if (updated.current.project.value !== pending.intent.projectValue) throw new Error(`Project ${field} did not match the pending value after update.`);
    if (pending.direction === "issue_to_project" && issueObservationChanged(pending.before.issue, updated.current.issue)) {
      refSha = await adapter.writeState(state, projectId, refSha);
      throw new Error(`Issue #${target.number} changed after the Project ${field} update; pending state retained.`);
    }
    refSha = await adapter.writeState(state, projectId, refSha);
  }
  let expectedLabels = [...pending.before.labels];
  const labelMutations = pending.intent.labelMutations;
  for (const label of labelMutations.remove) {
    const before = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    if (!executionStillMatches(pending, before.current, expectedLabels)) throw new Error(`Issue #${target.number} changed before label removal; pending state retained.`);
    await adapter.removeIssueLabel(target.number, label);
    expectedLabels = expectedLabels.filter((existing) => existing !== label);
    const after = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    recordNewBotEvents(pending, before.issue.timeline, after.issue.timeline, label, "unlabeled");
    refSha = await adapter.writeState(state, projectId, refSha);
    if (!executionStillMatches(pending, after.current, expectedLabels)) throw new Error(`Issue #${target.number} changed after label removal; pending state retained.`);
  }
  if (labelMutations.add.length > 0) {
    const before = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    if (!executionStillMatches(pending, before.current, expectedLabels)) throw new Error(`Issue #${target.number} changed before label addition; pending state retained.`);
    await adapter.addIssueLabels(target.number, labelMutations.add);
    expectedLabels = [...new Set([...expectedLabels, ...labelMutations.add])];
    const after = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
    for (const label of labelMutations.add) recordNewBotEvents(pending, before.issue.timeline, after.issue.timeline, label, "labeled");
    refSha = await adapter.writeState(state, projectId, refSha);
    if (!executionStillMatches(pending, after.current, expectedLabels)) throw new Error(`Issue #${target.number} changed after label addition; pending state retained.`);
  }
  const final = await readCurrentSnapshot(adapter, target, projectId, fieldMetadata, field);
  const verified = isExpectedIssueState(field, final.current, pending.intent.projectValue)
    && (pending.intent.projectMutation === null || final.current.project.value === pending.intent.projectValue);
  if (!verified) throw new Error(`Issue #${target.number} ${field} update failed post-write verification; pending state retained.`);
  storedField.baseline = targetSideBaseline(field, pending, final.current);
  storedField.pending = null;
  storedField._refSha = await adapter.writeState(state, projectId, refSha);
}

function executionStillMatches(pending, current, expectedLabels) {
  if (!sameStringArray(current.labels ?? [], expectedLabels)) return false;
  if (pending.direction === "project_to_issue") return !projectObservationChanged(pending.before.project, current.project);
  if (pending.direction === "issue_to_project") {
    if (current.project.value !== pending.intent.projectValue) return false;
    if (pending.intent.projectMutation) {
      return (current.project.valueId ?? null) === (pending.resultProject?.valueId ?? null)
        && (current.project.updatedAt ?? null) === (pending.resultProject?.updatedAt ?? null);
    }
    return !projectObservationChanged(pending.before.project, current.project);
  }
  return false;
}

function recordNewBotEvents(pending, beforeTimeline, afterTimeline, label, type) {
  const beforeIds = new Set(beforeTimeline.map((entry) => String(entry.id)));
  for (const entry of afterTimeline) {
    const normalized = normalizeTimelineEntry(entry, 0);
    if (!beforeIds.has(String(entry.id)) && normalized.label === label && normalized.type === type && isAutomationActor(normalized.actor)) {
      pending.resultEventIds = [...new Set([...pending.resultEventIds, String(entry.id)])];
    }
  }
}

const PROJECT_FIELDS_QUERY = `query ProjectSyncFields($owner: String!, $number: Int!) {
  user(login: $owner) { projectV2(number: $number) {
    id
    fields(first: 100) {
      nodes { __typename ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } }
      pageInfo { hasNextPage }
    }
  } }
}`;

async function main() {
  const args = process.argv.slice(2);
  const fixtureIndex = args.indexOf("--input");
  const apiDryRun = args.includes("--api-dry-run");
  if (fixtureIndex >= 0) {
    if (!args.includes("--dry-run") || !args[fixtureIndex + 1]) throw new Error("Fixture input requires --dry-run --input <file>.");
    const fixture = JSON.parse(await fs.readFile(path.resolve(args[fixtureIndex + 1]), "utf8"));
    const result = await planFromFixture(fixture);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  let issueNumber = null;
  if (eventPath && process.env.GITHUB_EVENT_NAME !== "schedule" && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
    if (Number.isInteger(event.issue?.number) && !event.issue?.pull_request) issueNumber = event.issue.number;
  }
  const adapter = createGitHubAdapter({ projectToken: process.env.PROJECTS_TOKEN, githubToken: process.env.GITHUB_TOKEN });
  const result = await synchronizeProject({ adapter, dryRun: apiDryRun, issueNumber, logger: (plans) => {
    process.stdout.write(`${JSON.stringify({ plans }, null, 2)}\n`);
  } });
  if (!result) process.stdout.write("No synchronization result.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Project label sync failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
