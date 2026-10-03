import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const PER_PAGE = 100;

export function hasSuccessfulMeasurementRun(runs, expected) {
  if (!Array.isArray(runs)) throw new Error("Workflow runs must be an array.");
  if (!Number.isSafeInteger(expected.prNumber) || expected.prNumber <= 0 || !SHA.test(expected.headSha ?? "")) {
    throw new Error("Expected pull request identity is invalid.");
  }
  return runs.some((run) => run?.event === "pull_request"
    && run.head_sha === expected.headSha
    && run.status === "completed"
    && run.conclusion === "success"
    && Array.isArray(run.pull_requests)
    && run.pull_requests.some((pullRequest) => pullRequest?.number === expected.prNumber));
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
  url.searchParams.set("per_page", String(PER_PAGE));
  for (let page = 1; page <= 10; page += 1) {
    url.searchParams.set("page", String(page));
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
    if (hasSuccessfulMeasurementRun(payload.workflow_runs, { prNumber, headSha })) return true;
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
