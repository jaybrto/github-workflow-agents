#!/usr/bin/env bun
/**
 * Resume with Failures
 * Trigger: QA → In Progress
 * Action: Resume REPL session with test failure context
 */

import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";

const WORKTREES_PATH = "/home/runner/worktrees";

interface ResumeWithFailuresArgs {
  issue: number;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
    },
  });

  const args: ResumeWithFailuresArgs = {
    issue: parseInt(values.issue || "0", 10),
  };

  if (!args.issue) {
    console.error("Usage: gwa-resume-with-failures --issue <number>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan("transition.resume-with-failures", async (span) => {
      span.setAttribute("issue.number", args.issue);

      log("info", `Resuming session with QA failures for issue #${args.issue}`);

      await resumeWithFailures(args.issue);
      success = true;
    });
  } catch (error) {
    log("error", "Failed to resume with failures", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function resumeWithFailures(issueNumber: number): Promise<void> {
  const sessionId = `issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;

  // 1. Initialize database and get session
  db.initDatabase();
  const session = db.getSession(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // 2. Get last QA run results from activity log
  const database = db.getDatabase();
  const qaResult = database
    .query(`
      SELECT details FROM activity_log
      WHERE session_id = ? AND event = 'qa_completed'
      ORDER BY created_at DESC LIMIT 1
    `)
    .get(sessionId) as { details: string } | null;

  let failedCount = 0;
  let runId = "unknown";

  if (qaResult?.details) {
    try {
      const details = JSON.parse(qaResult.details);
      failedCount = details.failed || 0;
      runId = details.run_id || "unknown";
    } catch {
      log("debug", "Could not parse QA results");
    }
  }

  // 3. Check if tmux window exists
  let windowNum = session.tmux_window;
  let needRestart = false;

  if (!windowNum) {
    needRestart = true;
    log("debug", "No tmux window found, will create new one");
  } else if (!(await tmux.windowExists(windowNum))) {
    needRestart = true;
    log("debug", `Tmux window ${windowNum} no longer exists, will create new one`);
  }

  if (needRestart) {
    // Create new tmux window
    await tmux.ensureSession();
    windowNum = await tmux.createWindow(sessionId, worktreePath);
    db.updateSessionStatus(sessionId, "running", { tmux_window: windowNum });

    // Start Claude REPL with resume
    await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions --resume");

    // Wait for REPL to initialize
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // 4. Get failure details from Playwright report
  let failureDetails = "";
  const reportPath = `${worktreePath}/playwright-report/index.html`;

  if (existsSync(reportPath)) {
    try {
      const reportContent = readFileSync(reportPath, "utf-8");
      // Extract failure info (simplified)
      const failureMatch = reportContent.match(/failed[\s\S]{0,500}/gi);
      if (failureMatch) {
        failureDetails = failureMatch.slice(0, 3).join("\n");
      }
    } catch {
      log("debug", "Could not read Playwright report");
    }
  }

  // Also check for recent log files
  try {
    const proc = Bun.spawn(["find", worktreePath, "-name", "*.log", "-mmin", "-30"], {
      stdout: "pipe",
    });
    const logFiles = (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean);

    if (logFiles.length > 0 && existsSync(logFiles[0])) {
      const logContent = readFileSync(logFiles[0], "utf-8");
      const errorLines = logContent
        .split("\n")
        .filter((line) => /fail|error/i.test(line))
        .slice(-10)
        .join("\n");
      if (errorLines) {
        failureDetails += `\n\nFrom logs:\n${errorLines}`;
      }
    }
  } catch {
    log("debug", "Could not check log files");
  }

  // 5. Build resume prompt
  const resumePrompt = `## QA Failed - Fix Required

The Playwright e2e tests failed. Please fix the issues and ensure tests pass.

### QA Run Summary
- Run ID: ${runId}
- Failed Tests: ${failedCount}

### Failure Details
\`\`\`
${failureDetails || "No detailed failure info available. Check playwright-report/"}
\`\`\`

### Instructions
1. Review the test failures above
2. Identify the root cause of each failure
3. Fix the code to make tests pass
4. Run tests locally: \`npx playwright test\`
5. Commit your fixes
6. The project will move back to QA when you're done

Focus on fixing the failures, not adding new features.`;

  // 6. Update session status
  db.updateSessionStatus(sessionId, "running");
  db.logActivity(sessionId, "qa_fix_started", {
    run_id: runId,
    failed_count: failedCount,
  }, "workflow");

  // 7. Send prompt to REPL
  log("info", `Sending QA failure prompt to window ${windowNum}`);

  const tempFile = `/tmp/gwa-qa-failures-${sessionId}.md`;
  await Bun.write(tempFile, resumePrompt);
  await tmux.sendCommand(windowNum!, `Read ${tempFile} and fix the test failures.`);

  log("info", "Session resumed with QA failure context", {
    sessionId,
    window: windowNum || 0,
    failedCount,
  });

  console.log(`
Session resumed with QA failures:
  Session ID: ${sessionId}
  Tmux Window: ${windowNum}
  Failed Tests: ${failedCount}
  Run ID: ${runId}

Attach with: kubectl exec -it gwa-runner-0 -- tmux attach -t gwa-work:${windowNum}
`);
}

main();
