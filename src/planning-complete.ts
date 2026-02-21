#!/usr/bin/env bun
// Telemetry MUST be imported first
import {
  withSpan,
  Metrics,
  shutdown as shutdownTelemetry,
  log,
} from "./lib/telemetry.js";

import { parseArgs } from "util";
import { existsSync } from "fs";
import * as db from "./lib/db.js";
import * as github from "./lib/github.js";
import * as tmux from "./lib/tmux.js";
import { generateComment } from "./lib/comment-generator.js";
import { restoreActor, persistSnapshot, getStateName } from "./lib/state-machine.js";

const REPO_PATH = "/home/runner/repo";

interface PlanningCompleteArgs {
  issue: number;
  repo: string;
  plan: string;
  sessionId?: string;
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
      plan: { type: "string" },
      "session-id": { type: "string" },
    },
  });

  const args: PlanningCompleteArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
    plan: values.plan || "",
    sessionId: values["session-id"],
  };

  if (!args.issue || !args.repo || !args.plan) {
    console.error(
      "Usage: gwa-planning-complete --issue <number> --repo <owner/repo> --plan <markdown text> [--session-id <id>]"
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");

  if (!owner || !repoName) {
    console.error("Invalid repo format. Expected: owner/repo");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan(
      "planning-complete",
      async (span) => {
        span.setAttribute("issue.number", args.issue);
        span.setAttribute("issue.repo", args.repo);
        if (args.sessionId) {
          span.setAttribute("repl.session_id", args.sessionId);
        }

        log("info", "Marking planning complete", {
          repo: args.repo,
          issue: args.issue,
          sessionId: args.sessionId || "none",
        });

        // Get or derive session ID
        const sessionId = args.sessionId || `issue-${args.issue}`;

        // Step 1: Post the plan as a new issue comment
        await withSpan("github.postIssueComment.plan", async () => {
          await github.postIssueComment(owner, repoName, args.issue, args.plan);
          Metrics.recordGitHubApiCall("postIssueComment.plan", true);
          log("info", "Posted plan as issue comment", { issue: args.issue });
        });

        // Step 2: Look up status_comment_id from the session record
        const session = db.getSession(sessionId);
        const statusCommentId = session?.status_comment_id;

        // Step 3: Generate a planning_complete status comment
        const planningCompleteComment = await generateComment({
          type: "planning_complete",
          sessionId,
          startedAt: session?.started_at ?? undefined,
          completedAt: Math.floor(Date.now() / 1000),
        });

        // Step 4: Update or post the status comment
        await withSpan("github.updateOrPostStatusComment", async () => {
          if (statusCommentId) {
            await github.updateComment(owner, repoName, statusCommentId, planningCompleteComment.body);
            Metrics.recordGitHubApiCall("issues.updateComment", true);
            log("info", "Updated lifecycle status comment", { commentId: statusCommentId });
          } else {
            await github.postIssueComment(owner, repoName, args.issue, planningCompleteComment.body);
            Metrics.recordGitHubApiCall("postIssueComment", true);
            log("info", "Posted new planning_complete comment (no status comment ID found)");
          }
        });

        // Step 5: Update session status to "planning_complete" in SQLite
        await withSpan("db.updateSessionStatus", async () => {
          if (session) {
            db.updateSessionStatus(sessionId, "planning_complete", {
              completion_summary: args.plan.substring(0, 500),
            });
          } else {
            // Create minimal session record if it doesn't exist
            db.createSession({
              id: sessionId,
              type: "issue",
              github_number: args.issue,
              github_type: "issue",
              repo: args.repo,
            });
            db.updateSessionStatus(sessionId, "planning_complete", {
              completion_summary: args.plan.substring(0, 500),
            });
          }
          Metrics.recordDbOperation("updateSessionStatus", true);
        });

        // Step 6: Log planning_completed activity event
        db.logActivity(sessionId, "planning_completed", {
          plan_length: args.plan.length,
          issue: args.issue,
        }, "claude");

        // Step 7: Transition XState: restoreActor, send PLANNING_COMPLETE, persistSnapshot
        const actor = restoreActor(sessionId);
        if (actor) {
          const currentState = getStateName(actor);
          const event = { type: "PLANNING_COMPLETE" as const };
          const snapshot = actor.getSnapshot();
          if (snapshot.can(event)) {
            actor.send(event);
            persistSnapshot(sessionId, actor.getSnapshot(), "PLANNING_COMPLETE");
            log("debug", `XState transitioned from ${currentState} to ${getStateName(actor)}`);
          } else {
            log("warn", `XState cannot PLANNING_COMPLETE from ${currentState}, skipping transition`);
          }
        } else {
          log("debug", "No XState snapshot found, skipping transition");
        }

        // Step 8: Kill tmux window if session has one
        const tmuxWindow = session?.tmux_window;
        if (tmuxWindow !== null && tmuxWindow !== undefined) {
          log("info", `Killing tmux window ${tmuxWindow}`);
          try {
            await tmux.killWindow(tmuxWindow);
          } catch {
            log("debug", "Tmux window already closed or not found");
          }
        }

        // Step 9: Remove git worktree if session has one
        const worktreePath = session?.worktree_path;
        if (worktreePath && existsSync(worktreePath)) {
          log("info", `Removing git worktree: ${worktreePath}`);
          const result = await exec(
            "git",
            ["worktree", "remove", worktreePath, "--force"],
            REPO_PATH
          );
          if (result.exitCode !== 0) {
            log("warn", "git worktree remove failed, forcing cleanup", {
              worktreePath,
            });
            await exec("rm", ["-rf", worktreePath]);
            await exec("git", ["worktree", "prune"], REPO_PATH);
          } else {
            log("info", "Worktree removed successfully", { worktreePath });
          }
        }

        success = true;
        log("info", "Planning marked complete", {
          repo: args.repo,
          issue: args.issue,
        });

        Metrics.sessionEnded();
      },
      {
        attributes: {
          "gwa.operation": "planning-complete",
          "issue.number": args.issue,
          "issue.repo": args.repo,
        },
      }
    );

    console.log("Planning marked complete");
  } catch (error) {
    log("error", "Failed to mark planning complete", {
      repo: args.repo,
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });

    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    db.closeDatabase();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

main();
