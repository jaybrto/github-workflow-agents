#!/usr/bin/env bun
/**
 * Deploy and Cleanup
 * Trigger: Review → Done
 * Action: Merge PR, deploy if needed, destroy session
 */

import { parseArgs } from "util";
import { existsSync } from "fs";
import { unlink } from "fs/promises";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import { getOctokit, updateComment } from "../lib/github.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";
import { generateComment } from "../lib/comment-generator.js";
import { getSessionScreenshots } from "../lib/screenshot.js";
import { stopPaneStream } from "../lib/terminal-relay.js";
import { restoreActor, persistSnapshot, getStateName, canTransition } from "../lib/state-machine.js";

const WORKTREES_PATH = "/home/runner/worktrees";
const REPO_PATH = "/home/runner/repo";

/**
 * Clean up all screenshots for a session (Phase 15 v3.4).
 * Deletes files from disk and removes tracking records from SQLite.
 */
async function cleanupSessionScreenshots(sessionId: string): Promise<number> {
  const screenshots = getSessionScreenshots(sessionId);

  if (screenshots.length === 0) {
    return 0;
  }

  log("info", `Cleaning up ${screenshots.length} screenshots for session ${sessionId}`);

  for (const { file_path } of screenshots) {
    try {
      await unlink(file_path);
      log("debug", `Deleted screenshot: ${file_path}`);
    } catch {
      // Ignore if already deleted
      log("debug", `Screenshot already deleted: ${file_path}`);
    }
  }

  // Remove from database
  const database = db.getDatabase();
  database.run(`DELETE FROM screenshots WHERE session_id = ?`, [sessionId]);

  log("info", `Cleaned up ${screenshots.length} screenshots for session ${sessionId}`);
  return screenshots.length;
}

interface DeployCleanupArgs {
  issue: number;
  repo: string;
}

async function exec(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
    },
  });

  const args: DeployCleanupArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
  };

  if (!args.issue || !args.repo) {
    console.error("Usage: gwa-deploy-and-cleanup --issue <number> --repo <owner/repo>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan("transition.deploy-and-cleanup", async (span) => {
      span.setAttribute("issue.number", args.issue);
      span.setAttribute("issue.repo", args.repo);

      log("info", `Completing issue #${args.issue}`);

      await deployAndCleanup(args.issue, args.repo);
      success = true;
    });
  } catch (error) {
    log("error", "Failed to deploy and cleanup", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function deployAndCleanup(issueNumber: number, repo: string): Promise<void> {
  const sessionId = `issue-${issueNumber}`;
  const branchName = `claude/issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;
  const [owner, repoName] = repo.split("/");

  const octokit = getOctokit();
  db.initDatabase();

  // 1. Get session info
  const session = db.getSession(sessionId);
  const windowNum = session?.tmux_window;

  // 2. Find associated PR
  let prNumber: number | null = null;

  try {
    const { data: prs } = await octokit.pulls.list({
      owner,
      repo: repoName,
      head: `${owner}:${branchName}`,
      state: "open",
    });

    if (prs.length > 0) {
      prNumber = prs[0].number;
    }
  } catch (e) {
    log("warn", "Could not find PR", { branch: branchName });
  }

  // 3. Merge PR if exists
  if (prNumber) {
    log("info", `Found PR #${prNumber} for branch ${branchName}`);

    try {
      const { data: pr } = await octokit.pulls.get({
        owner,
        repo: repoName,
        pull_number: prNumber,
      });

      if (pr.state === "open") {
        log("info", `Merging PR #${prNumber}`);

        await octokit.pulls.merge({
          owner,
          repo: repoName,
          pull_number: prNumber,
          merge_method: "squash",
          commit_title: `feat: complete issue #${issueNumber}`,
          commit_message: `Automatically merged by GWA after QA passed.\n\nCloses #${issueNumber}`,
        });

        log("info", `PR #${prNumber} merged`);
      } else {
        log("info", `PR #${prNumber} is already ${pr.state}`);
      }
    } catch (e) {
      log("warn", "Auto-merge failed, PR may need manual merge", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 3.5 Transition XState: review -> done
  const actor = restoreActor(sessionId);
  if (actor) {
    const event = { type: "DEPLOY_AND_CLEANUP" as const };
    if (!canTransition(actor, event)) {
      log("warn", `XState cannot DEPLOY_AND_CLEANUP from ${getStateName(actor)}, proceeding anyway`);
    } else {
      actor.send(event);
      persistSnapshot(sessionId, actor.getSnapshot());
      log("debug", `XState transitioned to ${getStateName(actor)}`);
    }
  }

  // 4. Update session status to complete
  log("info", "Marking session as complete");

  if (session) {
    db.updateSessionStatus(sessionId, "complete", {
      completion_summary: "Issue completed and merged",
    });
  }

  db.logActivity(sessionId, "session_completed", {
    pr_number: prNumber,
    merged: true,
  }, "workflow");

  // 4.5. Stop terminal streaming and upload recording
  const recording = await stopPaneStream(sessionId);
  if (recording) {
    log("info", "Recording uploaded", { s3Key: recording.s3Key, sizeBytes: recording.sizeBytes });
  }

  // 5. Kill tmux window if exists
  if (windowNum) {
    log("info", `Killing tmux window ${windowNum}`);
    try {
      await tmux.killWindow(windowNum);
    } catch {
      log("debug", "Window already closed");
    }
  }

  // 6. Remove worktree
  if (existsSync(worktreePath)) {
    log("info", "Removing worktree");
    const result = await exec("git", ["worktree", "remove", worktreePath, "--force"], REPO_PATH);
    if (result.exitCode !== 0) {
      // Force cleanup
      await exec("rm", ["-rf", worktreePath]);
      await exec("git", ["worktree", "prune"], REPO_PATH);
    }
  }

  // 6.5. Clean up screenshots (Phase 15 v3.4)
  const screenshotsDeleted = await cleanupSessionScreenshots(sessionId);

  // 7. Get session stats for summary
  const database = db.getDatabase();
  const commits = database
    .query(`SELECT COUNT(*) as count FROM commits WHERE session_id = ?`)
    .get(sessionId) as { count: number } | null;
  const toolCalls = database
    .query(`SELECT COUNT(*) as count FROM tool_calls WHERE session_id = ?`)
    .get(sessionId) as { count: number } | null;
  const questions = database
    .query(`SELECT COUNT(*) as count FROM questions WHERE session_id = ?`)
    .get(sessionId) as { count: number } | null;

  const durationResult = database
    .query(`SELECT ROUND((completed_at - created_at) / 3600.0, 1) as hours FROM sessions WHERE id = ?`)
    .get(sessionId) as { hours: number } | null;

  const stats = {
    commits: commits?.count || 0,
    toolCalls: toolCalls?.count || 0,
    questions: questions?.count || 0,
    durationHours: durationResult?.hours || 0,
  };

  // 8. Update or post completion summary to issue
  const summaryParts = [
    `Issue completed and merged.`,
    ``,
    `**Session Statistics:** ${stats.commits} commits, ${stats.toolCalls} tool calls, ${stats.questions} questions, ${stats.durationHours}h duration.`,
    screenshotsDeleted > 0 ? `Cleaned up ${screenshotsDeleted} screenshots.` : "",
    prNumber ? `PR #${prNumber} has been merged.` : "",
  ].filter(Boolean).join("\n");

  const statusCommentId = session?.status_comment_id;

  const completionComment = await generateComment({
    type: "session_complete",
    sessionId,
    summary: summaryParts,
    startedAt: session?.started_at ?? undefined,
    completedAt: Math.floor(Date.now() / 1000),
  });

  try {
    if (statusCommentId) {
      await updateComment(owner, repoName, statusCommentId, completionComment.body);
      log("info", "Updated lifecycle status comment", { commentId: statusCommentId });
    } else {
      await octokit.issues.createComment({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        body: completionComment.body,
      });
      log("info", "Posted new completion comment (no status comment ID found)");
    }

    // Close the issue
    await octokit.issues.update({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      state: "closed",
    });
  } catch (e) {
    log("warn", "Failed to post completion comment", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  log("info", "Issue completed successfully", {
    issue: issueNumber,
    commits: stats.commits,
    duration: stats.durationHours,
  });

  console.log(`
Issue #${issueNumber} completed:
  Commits: ${stats.commits}
  Duration: ${stats.durationHours} hours
  PR: ${prNumber ? `#${prNumber} merged` : "none"}
  Session resources cleaned up
`);
}

main();
