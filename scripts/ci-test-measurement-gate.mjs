import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const PER_PAGE = 100;

export function hasSuccessfulMeasurementRun(run, expected, jobsPayload, artifactsPayload) {
  if (!Number.isSafeInteger(expected.prNumber) || expected.prNumber <= 0 || !SHA.test(expected.headSha ?? "")) {
    throw new Error("Expected pull request identity is invalid.");
  }
  const runMatches = run?.event === "pull_request"
    && run.head_sha === expected.headSha
    && run.status === "completed"
    && run.conclusion === "success"
    && Array.isArray(run.pull_requests)
    && run.pull_requests.some((pullRequest) => pullRequest?.number === expected.prNumber);
  if (!runMatches) return false;
  if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
    throw new Error("Successful measurement run identity is invalid.");
  }
  if (!jobsPayload || !Array.isArray(jobsPayload.jobs) || !Number.isSafeInteger(jobsPayload.total_count)
    || !artifactsPayload || !Array.isArray(artifactsPayload.artifacts) || !Number.isSafeInteger(artifactsPayload.total_count)) {
    throw new Error("Measurement job or artifact response is invalid.");
  }
  const measured = jobsPayload.jobs.some((job) => job?.name === "Measure individual Windows tests"
    && job.status === "completed"
    && job.conclusion === "success"
    && Array.isArray(job.steps)
    && job.steps.some((step) => step?.name === "Measure each tracked test file" && step.status === "completed" && step.conclusion === "success")
    && job.steps.some((step) => step?.name === "Upload measurement evidence" && step.status === "completed" && step.conclusion === "success"));
  if (!measured) return false;
  const artifactPrefix = `test-runtime-measurement-${run.id}-${run.run_attempt}-`;
  return artifactsPayload.artifacts.some((artifact) => typeof artifact?.name === "string"
    && artifact.name.startsWith(artifactPrefix)
    && artifact.expired === false);
}

async function fetchPages(url, collectionName, fetchImpl, resourceName, token) {
  const items = [];
  let totalCount;
  for (let page = 1; page <= 10; page += 1) {
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`${resourceName} request failed with HTTP ${response.status}.`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload[collectionName]) || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0) {
      throw new Error(`${resourceName} response is invalid.`);
    }
    totalCount = payload.total_count;
    items.push(...payload[collectionName]);
    if (page * PER_PAGE >= totalCount || payload[collectionName].length < PER_PAGE) return items;
  }
  throw new Error(`${resourceName} exceeds the guarded page limit.`);
}

export async function shouldSkipMeasurement(environment = process.env, fetchImpl = fetch) {
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.CI_GITHUB_TOKEN;
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is invalid.");
  }
  if (typeof token !== "string" || !token) throw new Error("CI_GITHUB_TOKEN is required.");
  if (typeof eventPath !== "string" || !eventPath) throw new Error("GITHUB_EVENT_PATH is required.");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const pullRequest = event?.pull_request;
  const prNumber = pullRequest?.number;
  const headSha = pullRequest?.head?.sha;
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !SHA.test(headSha ?? "")) {
    throw new Error("Pull request event identity is invalid.");
  }
  if (pullRequest.head.repo?.full_name !== repository) {
    throw new Error("Measurement runs are restricted to same-repository pull requests.");
  }

  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/test-runtime-measurement.yml/runs`);
  url.searchParams.set("event", "pull_request");
  url.searchParams.set("head_sha", headSha);
  for (let page = 1; page <= 10; page += 1) {
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`Measurement history request failed with HTTP ${response.status}.`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.workflow_runs) || !Number.isSafeInteger(payload.total_count) || payload.total_count < 0) {
      throw new Error("Measurement history response is invalid.");
    }
    const candidates = payload.workflow_runs.filter((run) => run?.event === "pull_request"
      && run.head_sha === headSha
      && run.status === "completed"
      && run.conclusion === "success"
      && Array.isArray(run.pull_requests)
      && run.pull_requests.some((item) => item?.number === prNumber));
    for (const run of candidates) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
        throw new Error("Successful measurement run identity is invalid.");
      }
      const jobsUrl = new URL(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs`);
      const artifactsUrl = new URL(`https://api.github.com/repos/${repository}/actions/runs/${run.id}/artifacts`);
      const [jobs, artifacts] = await Promise.all([
        fetchPages(jobsUrl, "jobs", fetchImpl, "Measurement jobs", token),
        fetchPages(artifactsUrl, "artifacts", fetchImpl, "Measurement artifacts", token),
      ]);
      if (hasSuccessfulMeasurementRun(run, { prNumber, headSha }, { total_count: jobs.length, jobs }, { total_count: artifacts.length, artifacts })) return true;
    }
    if (page * PER_PAGE >= payload.total_count || payload.workflow_runs.length < PER_PAGE) return false;
  }
  throw new Error("Measurement history exceeds the guarded page limit.");
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") throw new Error("The duplicate guard only supports pull_request events.");
  process.stdout.write(`${await shouldSkipMeasurement() ? "skip" : "run"}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
