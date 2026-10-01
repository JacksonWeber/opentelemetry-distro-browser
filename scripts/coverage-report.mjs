// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";

const marker = "<!-- browser-coverage-report -->";
const metrics = ["statements", "branches", "functions", "lines"];
const shaPattern = /^[a-f0-9]{40}$/;

export async function readCoverageSummary(path) {
  const file = await lstat(path);
  assert(file.isFile() && file.size <= 5 * 1024 * 1024, "Invalid coverage summary file");
  return JSON.parse(await readFile(path, "utf8"));
}

function totals(summary) {
  assert(summary?.total && typeof summary.total === "object", "Missing coverage totals");
  return metrics.map((metric) => {
    const entry = summary.total[metric];
    assert(
      entry && Number.isSafeInteger(entry.total) && entry.total >= 0,
      `Invalid ${metric} total`,
    );
    assert(
      Number.isSafeInteger(entry.covered) && entry.covered >= 0 && entry.covered <= entry.total,
      `Invalid ${metric} covered count`,
    );
    // Match Istanbul's two-decimal truncation instead of trusting artifact percentages.
    const percentage =
      entry.total === 0 ? 10000 : Math.floor((entry.covered / entry.total) * 10000);
    return { covered: entry.covered, total: entry.total, percentage };
  });
}

export function renderCoverageReport(baseline, candidate) {
  const base = totals(baseline);
  const head = totals(candidate);
  const rows = metrics.map((metric, index) => {
    const before = base[index];
    const after = head[index];
    const delta = after.percentage - before.percentage;
    const status = delta > 0 ? "Improved" : delta < 0 ? "Decreased" : "Unchanged";
    const cell = (entry) =>
      `${(entry.percentage / 100).toFixed(2)}% (${entry.covered}/${entry.total})`;
    const change = `${delta > 0 ? "+" : ""}${(delta / 100).toFixed(2)} pp`;
    return `| ${metric[0].toUpperCase()}${metric.slice(1)} | ${cell(before)} | ${cell(after)} | ${change} | ${status} |`;
  });
  return [
    marker,
    "### Coverage comparison",
    "",
    "Informational only. Coverage decreases do not fail the build. Changes are percentage points.",
    "",
    "| Metric | Baseline | Candidate | Change | Status |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "Chromium unit tests on Node 24, measuring `src`. Integration tests and test fixtures are excluded.",
  ].join("\n");
}

function validateRun(context) {
  const run = context.payload.workflow_run;
  assert(
    run?.event === "pull_request" &&
      run.status === "completed" &&
      run.path === ".github/workflows/pr-validation.yml" &&
      run.repository?.full_name === `${context.repo.owner}/${context.repo.repo}`,
    "Unexpected coverage workflow source",
  );
  assert(shaPattern.test(run.head_sha), "Invalid workflow head SHA");
  assert(Number.isSafeInteger(run.id) && run.id > 0, "Invalid workflow run ID");
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, "Invalid workflow attempt");
  return run;
}

function isCurrentPullRequest(pr, run, context) {
  return (
    pr.state === "open" &&
    pr.head.sha === run.head_sha &&
    pr.base.repo.full_name === `${context.repo.owner}/${context.repo.repo}`
  );
}

/** Resolve PR identity from GitHub, never from PR-produced artifact contents. */
export async function resolveCoverageReport({ github, context, core }) {
  const run = validateRun(context);
  const linked = run.pull_requests?.length
    ? run.pull_requests
    : await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
        ...context.repo,
        commit_sha: run.head_sha,
        per_page: 100,
      });
  const matches = [];
  for (const number of new Set(linked.map((pr) => pr.number))) {
    assert(Number.isSafeInteger(number) && number > 0, "Invalid associated PR number");
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    if (isCurrentPullRequest(pr, run, context)) matches.push(pr);
  }
  if (matches.length !== 1) {
    core.warning("Coverage comment skipped: no unique open PR at this workflow's head commit.");
    return;
  }
  const pr = matches[0];
  assert(shaPattern.test(pr.base.sha), "Invalid PR base SHA");
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: run.id,
    per_page: 100,
  });
  const find = (name) => {
    const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
    if (matches.length !== 1) return undefined;
    const artifact = matches[0];
    assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, "Invalid coverage artifact ID");
    assert(artifact.size_in_bytes <= 20 * 1024 * 1024, "Coverage artifact is too large");
    return artifact.id;
  };
  const base = find(`coverage-base-${pr.base.sha}`);
  const candidate = find(`coverage-candidate-${run.head_sha}`);
  if (base === undefined || candidate === undefined) {
    core.warning(
      "Coverage comment skipped: complete reports for the current base and head are unavailable.",
    );
    return;
  }
  core.setOutput("base-artifact", base);
  core.setOutput("candidate-artifact", candidate);
  core.setOutput("base-sha", pr.base.sha);
  core.setOutput("pr-number", pr.number);
}

/** Render only validated numeric totals with trusted code from the default branch. */
export async function postCoverageComment({
  github,
  context,
  core,
  prNumber,
  baseSha,
  baseline,
  candidate,
}) {
  const run = validateRun(context);
  assert(Number.isSafeInteger(prNumber) && prNumber > 0, "Invalid PR number");
  assert(shaPattern.test(baseSha), "Invalid base SHA");
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: prNumber });
  if (!isCurrentPullRequest(pr, run, context) || pr.base.sha !== baseSha) {
    core.warning("Coverage comment skipped: the PR was closed or its base/head changed.");
    return;
  }
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.includes(marker),
  );
  const previous = existing?.body.match(/<!-- coverage-run:(\d+):(\d+) -->/);
  if (
    previous &&
    (Number(previous[1]) > run.id ||
      (Number(previous[1]) === run.id && Number(previous[2]) > run.run_attempt))
  ) {
    core.warning("Coverage comment skipped: a newer run has already reported.");
    return;
  }
  const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${run.id}`;
  const body = [
    renderCoverageReport(baseline, candidate),
    "",
    `Base \`${baseSha.slice(0, 7)}\` compared with the tested merge result for PR head \`${run.head_sha.slice(0, 7)}\`.`,
    `[Workflow and downloadable coverage reports](${runUrl})`,
    `<!-- coverage-run:${run.id}:${run.run_attempt} -->`,
  ].join("\n");
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...context.repo, issue_number: prNumber, body });
  }
  await core.summary.addRaw(body).write();
}
