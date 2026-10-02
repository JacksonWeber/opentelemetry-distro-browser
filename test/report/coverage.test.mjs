// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import {
  postCoverageComment,
  readCoverageSummary,
  renderCoverageReport,
  resolveCoverageReport,
} from "../../scripts/coverage-report.mjs";

const marker = "<!-- browser-coverage-report -->";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function summary(covered = 80, total = 100) {
  return {
    total: Object.fromEntries(
      ["statements", "branches", "functions", "lines"].map((key) => [key, { covered, total }]),
    ),
  };
}

function harness() {
  const pr = {
    number: 42,
    state: "open",
    head: { sha: headSha, repo: { full_name: "contributor/browser" } },
    base: { sha: baseSha, repo: { full_name: "owner/browser" } },
  };
  const context = {
    repo: { owner: "owner", repo: "browser" },
    serverUrl: "https://github.com",
    payload: {
      workflow_run: {
        id: 200,
        run_attempt: 1,
        event: "pull_request",
        status: "completed",
        path: ".github/workflows/pr-validation.yml",
        repository: { full_name: "owner/browser" },
        head_sha: headSha,
        pull_requests: [{ number: 42 }],
      },
    },
  };
  const artifacts = [
    { id: 1, name: `coverage-base-${baseSha}`, size_in_bytes: 1000, expired: false },
    { id: 2, name: `coverage-candidate-${headSha}`, size_in_bytes: 1000, expired: false },
  ];
  const pullRequests = [pr];
  const comments = [];
  const outputs = new Map();
  const core = {
    warning: mock.fn(),
    setOutput: mock.fn((name, value) => outputs.set(name, value)),
    summary: { addRaw: mock.fn(() => core.summary), write: mock.fn(async () => {}) },
  };
  const github = {
    paginate: mock.fn(async (route, params) => route(params)),
    rest: {
      pulls: {
        get: mock.fn(async ({ pull_number }) => {
          const data = pullRequests.find((candidate) => candidate.number === pull_number);
          assert.ok(data, `Unexpected PR number ${pull_number}`);
          return { data };
        }),
        list: mock.fn(async () => pullRequests),
      },
      repos: { listPullRequestsAssociatedWithCommit: mock.fn(async () => []) },
      actions: { listWorkflowRunArtifacts: mock.fn(async () => artifacts) },
      issues: {
        listComments: mock.fn(async () => comments),
        createComment: mock.fn(async () => {}),
        updateComment: mock.fn(async () => {}),
      },
    },
  };
  return {
    github,
    context,
    core,
    pr,
    pullRequests,
    artifacts,
    comments,
    outputs,
    prNumber: 42,
    baseSha,
    baseline: summary(),
    candidate: summary(90),
  };
}

test("renders all four metrics with counts, percentage-point deltas and informational status", () => {
  const candidate = summary();
  candidate.total.statements.covered = 90;
  candidate.total.branches.covered = 70;
  const report = renderCoverageReport(summary(), candidate);
  assert.ok(report.startsWith(marker));
  assert.match(report, /Informational only\. Coverage decreases do not fail the build/);
  assert.match(
    report,
    /\| Statements \| 80\.00% \(80\/100\) \| 90\.00% \(90\/100\) \| \+10\.00 pp \| Improved \|/,
  );
  assert.match(report, /\| Branches .* -10\.00 pp \| Decreased \|/);
  assert.match(report, /\| Functions .* 0\.00 pp \| Unchanged \|/);
  assert.match(report, /\| Lines .* 0\.00 pp \| Unchanged \|/);
});

test("recomputes percentages and does not render untrusted artifact text", () => {
  const candidate = summary(2, 3);
  candidate.total.lines.pct = "[injected](https://example.test)";
  candidate["malicious filename"] = "@someone";
  const report = renderCoverageReport(summary(0, 0), candidate);
  assert.match(report, /100\.00% \(0\/0\)/);
  assert.match(report, /66\.66% \(2\/3\)/);
  assert.doesNotMatch(report, /injected|example\.test|malicious|@someone/);
});

test("truncates percentages exactly across the supported integer range", () => {
  for (const [covered, total, percentage] of [
    [57, 100, "57.00"],
    [29, 100, "29.00"],
    [0, 100, "0.00"],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, "99.99"],
  ]) {
    const report = renderCoverageReport(summary(covered, total), summary(covered, total));
    const cell = `${percentage}% (${covered}/${total})`;
    for (const metric of ["Statements", "Branches", "Functions", "Lines"]) {
      assert.ok(report.includes(`| ${metric} | ${cell} | ${cell} | 0.00 pp | Unchanged |`));
    }
  }
});

test("does not report a decrease when truncated percentages are equal", () => {
  const report = renderCoverageReport(summary(570001, 1000000), summary(57, 100));
  for (const metric of ["Statements", "Branches", "Functions", "Lines"]) {
    assert.ok(
      report.includes(
        `| ${metric} | 57.00% (570001/1000000) | 57.00% (57/100) | 0.00 pp | Unchanged |`,
      ),
    );
  }
});

for (const value of [
  null,
  {},
  { total: {} },
  summary(-1),
  summary(101),
  summary(1.5),
  summary("80"),
  summary(0, Infinity),
]) {
  test(`rejects invalid coverage data ${JSON.stringify(value)}`, () => {
    assert.throws(() => renderCoverageReport(value, summary()));
    assert.throws(() => renderCoverageReport(summary(), value));
  });
}

test("loads JSON summaries and rejects malformed, missing, non-file and oversized inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-coverage-"));
  const path = join(directory, "coverage-summary.json");
  try {
    await writeFile(path, JSON.stringify(summary()));
    assert.deepEqual(await readCoverageSummary(path), summary());
    await assert.rejects(readCoverageSummary(directory), /Invalid coverage summary file/);
    await assert.rejects(readCoverageSummary(join(directory, "missing.json")), /ENOENT/);
    await writeFile(path, "{invalid");
    await assert.rejects(readCoverageSummary(path), SyntaxError);
    await truncate(path, 5 * 1024 * 1024 + 1);
    await assert.rejects(readCoverageSummary(path), /Invalid coverage summary file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves artifact IDs only from the triggering run and current PR commits", async () => {
  const state = harness();
  await resolveCoverageReport(state);
  assert.deepEqual(Object.fromEntries(state.outputs), {
    "base-artifact": 1,
    "candidate-artifact": 2,
    "base-sha": baseSha,
    "pr-number": 42,
  });
  assert.equal(
    state.github.rest.actions.listWorkflowRunArtifacts.mock.calls[0].arguments[0].run_id,
    200,
  );
  assert.equal(state.github.rest.pulls.list.mock.callCount(), 0);
});

for (const [name, linked] of [
  ["empty", []],
  ["missing", undefined],
]) {
  test(`resolves fork PRs when the workflow PR list is ${name}`, async () => {
    const state = harness();
    state.context.payload.workflow_run.pull_requests = linked;
    state.pullRequests.unshift({
      ...state.pr,
      number: 41,
      head: { ...state.pr.head, sha: "c".repeat(40) },
    });
    await resolveCoverageReport(state);
    assert.deepEqual(Object.fromEntries(state.outputs), {
      "base-artifact": 1,
      "candidate-artifact": 2,
      "base-sha": baseSha,
      "pr-number": 42,
    });
    assert.equal(state.github.paginate.mock.calls[0].arguments[0], state.github.rest.pulls.list);
    assert.deepEqual(state.github.rest.pulls.list.mock.calls[0].arguments[0], {
      owner: "owner",
      repo: "browser",
      state: "open",
      per_page: 100,
    });
    assert.equal(state.github.rest.repos.listPullRequestsAssociatedWithCommit.mock.callCount(), 0);
    assert.equal(state.github.rest.pulls.get.mock.callCount(), 1);
    assert.equal(state.github.rest.pulls.get.mock.calls[0].arguments[0].pull_number, 42);
    assert.equal(state.core.warning.mock.callCount(), 0);
  });
}

for (const [name, change] of [
  ["no matching head", (state) => (state.pr.head.sha = "c".repeat(40))],
  ["closed PR", (state) => (state.pr.state = "closed")],
  ["wrong base repository", (state) => (state.pr.base.repo.full_name = "other/browser")],
  ["multiple matching PRs", (state) => state.pullRequests.push({ ...state.pr, number: 43 })],
]) {
  test(`skips the open-PR fallback with a diagnostic for ${name}`, async () => {
    const state = harness();
    state.context.payload.workflow_run.pull_requests = [];
    change(state);
    await resolveCoverageReport(state);
    assert.equal(state.outputs.size, 0);
    assert.equal(state.core.warning.mock.callCount(), 1);
    assert.match(state.core.warning.mock.calls[0].arguments[0], /no unique open PR/);
    assert.equal(state.github.rest.actions.listWorkflowRunArtifacts.mock.callCount(), 0);
  });
}

test("rechecks the PR head after listing open PRs", async () => {
  const state = harness();
  state.context.payload.workflow_run.pull_requests = [];
  state.github.rest.pulls.get = mock.fn(async () => ({
    data: { ...state.pr, head: { ...state.pr.head, sha: "c".repeat(40) } },
  }));
  await resolveCoverageReport(state);
  assert.equal(state.outputs.size, 0);
  assert.equal(state.github.rest.pulls.get.mock.callCount(), 1);
  assert.equal(state.core.warning.mock.callCount(), 1);
  assert.equal(state.github.rest.actions.listWorkflowRunArtifacts.mock.callCount(), 0);
});

test("propagates open-PR lookup failures", async () => {
  const state = harness();
  state.context.payload.workflow_run.pull_requests = [];
  state.github.rest.pulls.list = mock.fn(async () => {
    throw new Error("permission denied");
  });
  await assert.rejects(resolveCoverageReport(state), /permission denied/);
  assert.equal(state.outputs.size, 0);
  assert.equal(state.github.rest.actions.listWorkflowRunArtifacts.mock.callCount(), 0);
});

for (const [name, change] of [
  [
    "closed PR",
    (state) => {
      state.pr.state = "closed";
    },
  ],
  [
    "new head",
    (state) => {
      state.pr.head.sha = "c".repeat(40);
    },
  ],
  [
    "wrong repository",
    (state) => {
      state.pr.base.repo.full_name = "other/browser";
    },
  ],
  [
    "new base without a matching artifact",
    (state) => {
      state.pr.base.sha = "c".repeat(40);
    },
  ],
  [
    "missing artifact",
    (state) => {
      state.artifacts.pop();
    },
  ],
  [
    "expired artifact",
    (state) => {
      state.artifacts[0].expired = true;
    },
  ],
  [
    "duplicate artifact",
    (state) => {
      state.artifacts.push({ ...state.artifacts[0], id: 3 });
    },
  ],
  [
    "ambiguous PR association",
    (state) => {
      state.pullRequests.push({ ...state.pr, number: 43 });
      state.context.payload.workflow_run.pull_requests.push({ number: 43 });
    },
  ],
]) {
  test(`skips reporting with a diagnostic for ${name}`, async () => {
    const state = harness();
    change(state);
    await resolveCoverageReport(state);
    assert.equal(state.outputs.size, 0);
    assert.equal(state.core.warning.mock.callCount(), 1);
  });
}

for (const [name, change] of [
  [
    "different workflow",
    (run) => {
      run.path = ".github/workflows/other.yml";
    },
  ],
  [
    "different repository",
    (run) => {
      run.repository.full_name = "other/browser";
    },
  ],
  [
    "push event",
    (run) => {
      run.event = "push";
    },
  ],
  [
    "invalid SHA",
    (run) => {
      run.head_sha = "../injected";
    },
  ],
  [
    "invalid run ID",
    (run) => {
      run.id = "200";
    },
  ],
  [
    "invalid attempt",
    (run) => {
      run.run_attempt = 0;
    },
  ],
]) {
  test(`rejects ${name}`, async () => {
    const state = harness();
    change(state.context.payload.workflow_run);
    await assert.rejects(resolveCoverageReport(state));
    await assert.rejects(postCoverageComment(state));
    assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
  });
}

test("rejects oversized artifacts before downloading", async () => {
  const state = harness();
  state.artifacts[0].size_in_bytes = 20 * 1024 * 1024 + 1;
  await assert.rejects(resolveCoverageReport(state), /too large/);
  assert.equal(state.outputs.size, 0);
});

test("creates a coverage comment with commit provenance and a workflow link", async () => {
  const state = harness();
  await postCoverageComment(state);
  const comment = state.github.rest.issues.createComment.mock.calls[0].arguments[0];
  assert.equal(comment.issue_number, 42);
  assert.match(comment.body, /Base `aaaaaaa`.*PR head `bbbbbbb`/);
  assert.match(comment.body, /https:\/\/github\.com\/owner\/browser\/actions\/runs\/200/);
  assert.match(comment.body, /<!-- coverage-run:200:1 -->/);
  assert.equal(state.core.summary.write.mock.callCount(), 1);
});

test("updates the existing bot comment instead of creating duplicates", async () => {
  const state = harness();
  state.comments.push({
    id: 99,
    user: { login: "github-actions[bot]" },
    body: `${marker}\n<!-- coverage-run:199:1 -->`,
  });
  await postCoverageComment(state);
  assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
  assert.equal(state.github.rest.issues.updateComment.mock.calls[0].arguments[0].comment_id, 99);
});

for (const ids of [
  [98, 99],
  [99, 98],
]) {
  test(`updates the newest matching bot comment in API order ${ids}`, async () => {
    const state = harness();
    state.comments.push(
      ...ids.map((id) => ({
        id,
        user: { login: "github-actions[bot]" },
        body: `${marker}\n<!-- coverage-run:199:1 -->`,
      })),
      { id: 100, user: { login: "contributor" }, body: marker },
      { id: 101, user: { login: "github-actions[bot]" }, body: "Unrelated comment" },
    );
    await postCoverageComment(state);
    assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
    assert.equal(state.github.rest.issues.updateComment.mock.callCount(), 1);
    assert.equal(state.github.rest.issues.updateComment.mock.calls[0].arguments[0].comment_id, 99);
    assert.equal(state.core.summary.write.mock.callCount(), 1);
  });
}

test("does not modify a user's comment containing the marker", async () => {
  const state = harness();
  state.comments.push({ id: 99, user: { login: "contributor" }, body: marker });
  await postCoverageComment(state);
  assert.equal(state.github.rest.issues.createComment.mock.callCount(), 1);
  assert.equal(state.github.rest.issues.updateComment.mock.callCount(), 0);
});

for (const version of ["201:1", "200:2"]) {
  test(`does not overwrite a newer report ${version}`, async () => {
    const state = harness();
    state.comments.push({
      id: 99,
      user: { login: "github-actions[bot]" },
      body: `${marker}\n<!-- coverage-run:${version} -->`,
    });
    await postCoverageComment(state);
    assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
    assert.equal(state.github.rest.issues.updateComment.mock.callCount(), 0);
    assert.equal(state.core.warning.mock.callCount(), 1);
  });

  for (const newerReportId of [98, 99]) {
    test(`preserves newer report ${version} in duplicate comment ${newerReportId}`, async () => {
      const state = harness();
      state.comments.push(
        ...[98, 99].map((id) => ({
          id,
          user: { login: "github-actions[bot]" },
          body: `${marker}\n<!-- coverage-run:${id === newerReportId ? version : "199:1"} -->`,
        })),
      );
      await postCoverageComment(state);
      assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
      assert.equal(state.github.rest.issues.updateComment.mock.callCount(), 0);
      assert.equal(state.core.warning.mock.callCount(), 1);
      assert.match(state.core.warning.mock.calls[0].arguments[0], /newer run has already reported/);
      assert.equal(state.core.summary.write.mock.callCount(), 0);
    });
  }
}

for (const [name, change] of [
  [
    "head",
    (pr) => {
      pr.head.sha = "c".repeat(40);
    },
  ],
  [
    "base",
    (pr) => {
      pr.base.sha = "c".repeat(40);
    },
  ],
  [
    "state",
    (pr) => {
      pr.state = "closed";
    },
  ],
]) {
  test(`rechecks PR ${name} after artifact download`, async () => {
    const state = harness();
    change(state.pr);
    await postCoverageComment(state);
    assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
    assert.equal(state.core.warning.mock.callCount(), 1);
  });
}

test("does not post invalid data and propagates API errors", async () => {
  const state = harness();
  state.candidate = {};
  await assert.rejects(postCoverageComment(state), /Missing coverage totals/);
  assert.equal(state.github.rest.issues.createComment.mock.callCount(), 0);
  state.candidate = summary();
  state.github.rest.issues.createComment = mock.fn(async () => {
    throw new Error("permission denied");
  });
  await assert.rejects(postCoverageComment(state), /permission denied/);
});
