#!/usr/bin/env bun
/**
 * Run Playwright
 * Trigger: In Progress → QA
 * Action: Run Playwright e2e tests and record results
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import { postPRComment } from "../lib/github.js";
import * as db from "../lib/db.js";

const WORKTREES_PATH = "/home/runner/worktrees";

interface RunPlaywrightArgs {
  issue: number;
  repo: string;
}

interface TestResults {
  passed: number;
  failed: number;
  skipped: number;
  exitCode: number;
  output: string;
}

async function exec(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
    },
  });

  const args: RunPlaywrightArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
  };

  if (!args.issue || !args.repo) {
    console.error("Usage: gwa-run-playwright --issue <number> --repo <owner/repo>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let exitCode = 1;

  try {
    await withSpan("transition.run-playwright", async (span) => {
      span.setAttribute("issue.number", args.issue);
      span.setAttribute("issue.repo", args.repo);

      log("info", `Running Playwright tests for issue #${args.issue}`);

      const results = await runPlaywrightTests(args.issue, args.repo);
      exitCode = results.exitCode;

      span.setAttribute("qa.passed", results.passed);
      span.setAttribute("qa.failed", results.failed);
      span.setAttribute("qa.status", results.exitCode === 0 ? "passed" : "failed");
    });
  } catch (error) {
    log("error", "Failed to run Playwright tests", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(exitCode);
}

async function runPlaywrightTests(issueNumber: number, repo: string): Promise<TestResults> {
  const sessionId = `issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;
  const runId = `qa-${issueNumber}-${Date.now()}`;
  const [owner, repoName] = repo.split("/");

  // 1. Verify worktree exists
  if (!existsSync(worktreePath)) {
    throw new Error(`Worktree not found: ${worktreePath}`);
  }

  // 2. Initialize database and log QA start
  db.initDatabase();
  db.logActivity(sessionId, "qa_started", { run_id: runId }, "playwright");
  db.updateSessionStatus(sessionId, "running");

  // 3. Install dependencies if needed
  if (existsSync(`${worktreePath}/package.json`) && !existsSync(`${worktreePath}/node_modules`)) {
    log("info", "Installing dependencies");
    const installResult = await exec("bun", ["install"], worktreePath);
    if (installResult.exitCode !== 0) {
      await exec("npm", ["install"], worktreePath);
    }
  }

  // 4. Check for Playwright config
  const hasPlaywrightConfig =
    existsSync(`${worktreePath}/playwright.config.ts`) ||
    existsSync(`${worktreePath}/playwright.config.js`);

  if (!hasPlaywrightConfig) {
    // Check for test files
    const findResult = await exec(
      "find",
      [".", "-path", "./node_modules", "-prune", "-o", "-name", "*.e2e.ts", "-o", "-name", "*.spec.ts"],
      worktreePath
    );

    if (!findResult.stdout.includes(".ts")) {
      log("info", "No Playwright tests found, marking QA as skipped");

      db.logActivity(sessionId, "qa_completed", {
        run_id: runId,
        status: "skipped",
        reason: "no_tests",
      }, "playwright");

      return { passed: 0, failed: 0, skipped: 0, exitCode: 0, output: "No tests found" };
    }
  }

  // 5. Run Playwright tests
  log("info", "Running Playwright tests");
  const testResult = await exec(
    "npx",
    ["playwright", "test", "--reporter=json"],
    worktreePath
  );

  // 6. Parse results
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const output = testResult.stdout + testResult.stderr;

  // Simple parsing - count status occurrences
  passed = (output.match(/"status":"passed"/g) || []).length;
  failed = (output.match(/"status":"failed"/g) || []).length;
  skipped = (output.match(/"status":"skipped"/g) || []).length;

  const qaStatus = testResult.exitCode === 0 ? "passed" : "failed";

  log("info", "Playwright tests completed", {
    status: qaStatus,
    passed,
    failed,
    skipped,
  });

  // 7. Record results in database
  db.logActivity(sessionId, "qa_completed", {
    run_id: runId,
    status: qaStatus,
    passed,
    failed,
    skipped,
  }, "playwright");

  // 8. Get associated PR and post results
  const session = db.getSession(sessionId);
  const prNumber = session?.github_type === "pull_request" ? session.github_number : null;

  if (prNumber) {
    const commentBody = qaStatus === "passed"
      ? `## QA Passed

All Playwright e2e tests passed.

| Metric | Count |
|--------|-------|
| Passed | ${passed} |
| Failed | ${failed} |
| Skipped | ${skipped} |

Run ID: \`${runId}\``
      : `## QA Failed

Some Playwright e2e tests failed.

| Metric | Count |
|--------|-------|
| Passed | ${passed} |
| Failed | ${failed} |
| Skipped | ${skipped} |

<details>
<summary>Failure Details</summary>

\`\`\`
${output.slice(-2000)}
\`\`\`

</details>

Run ID: \`${runId}\`

Moving back to In Progress for fixes.`;

    try {
      await postPRComment(owner, repoName, prNumber, commentBody);
    } catch (e) {
      log("warn", "Failed to post PR comment", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  console.log(`
Playwright test results:
  Status: ${qaStatus}
  Passed: ${passed}
  Failed: ${failed}
  Skipped: ${skipped}
  Run ID: ${runId}
`);

  return {
    passed,
    failed,
    skipped,
    exitCode: testResult.exitCode,
    output,
  };
}

main();
