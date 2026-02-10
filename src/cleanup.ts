#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import * as github from "./lib/github.js";
import * as tmux from "./lib/tmux.js";
import * as git from "./lib/git.js";
import * as db from "./lib/db.js";

interface CleanupArgs {
  repo: string;
  session?: string;
  reason?: string;
  dryRun: boolean;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      session: { type: "string" },
      reason: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });

  const args: CleanupArgs = {
    repo: values.repo || "",
    session: values.session,
    reason: values.reason || "cleanup",
    dryRun: values["dry-run"] || false,
  };

  if (!args.repo) {
    console.error("Usage: gwa-cleanup --repo <owner/repo> [--session <id>] [--reason <reason>] [--dry-run]");
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  let cleanedCount = 0;

  try {
    // Initialize database
    db.initDatabase();

    cleanedCount = await withSpan(
      "cleanup",
      async (span) => {
        span.setAttribute("cleanup.repo", args.repo);
        span.setAttribute("cleanup.dryRun", args.dryRun);

        log("info", `Starting cleanup for ${args.repo}`, {
          dryRun: args.dryRun,
          session: args.session || "all",
        });

        if (args.session) {
          // Clean up specific session
          return await cleanupSession(args, owner, repoName);
        } else {
          // Clean up all closed sessions
          return await cleanupClosedSessions(args, owner, repoName);
        }
      },
      {
        attributes: {
          "gwa.operation": "cleanup",
          "cleanup.repo": args.repo,
          "cleanup.dryRun": args.dryRun,
        },
      }
    );
  } catch (error) {
    log("error", "Cleanup failed", {
      repo: args.repo,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    Metrics.recordCleanup(args.repo, cleanedCount);
    db.closeDatabase();
    await shutdownTelemetry();
  }

  process.exit(0);
}

/**
 * Clean up a specific session by ID.
 */
async function cleanupSession(
  args: CleanupArgs,
  owner: string,
  repoName: string
): Promise<number> {
  const session = db.getSession(args.session!);

  if (!session) {
    log("warn", `Session not found: ${args.session}`);
    return 0;
  }

  if (args.dryRun) {
    log("info", `[DRY RUN] Would clean up session ${args.session}`, {
      tmuxWindow: session.tmux_window ?? -1,
      worktreePath: session.worktree_path ?? "unknown",
      status: session.status,
    });
    return 1;
  }

  await withSpan(
    "cleanupSession",
    async (span) => {
      span.setAttribute("session.id", session.id);

      // Clean up tmux window
      if (session.tmux_window !== null && (await tmux.windowExists(session.tmux_window))) {
        try {
          await tmux.killWindow(session.tmux_window);
          log("debug", `Removed tmux window ${session.tmux_window}`);
        } catch (error) {
          log("warn", `Failed to remove tmux window: ${error}`);
        }
      }

      // Clean up git worktree
      if (session.worktree_path) {
        try {
          await git.removeWorktree(session.github_number);
          log("debug", `Removed worktree for session ${session.id}`);
        } catch (error) {
          log("warn", `Failed to remove worktree: ${error}`);
        }
      }

      // Update session status
      db.updateSessionStatus(session.id, "complete", {
        completion_summary: `Cleaned up: ${args.reason}`,
      });

      db.logActivity(session.id, "session_cleanup", { reason: args.reason }, "workflow");

      Metrics.sessionEnded();
      log("info", `Cleaned up session ${session.id}`);
    },
    { attributes: { "cleanup.session": session.id } }
  );

  return 1;
}

/**
 * Clean up all sessions for closed issues/PRs.
 */
async function cleanupClosedSessions(
  args: CleanupArgs,
  owner: string,
  repoName: string
): Promise<number> {
  // Get all active sessions for this repo from SQLite
  const database = db.getDatabase();
  const sessions = database
    .query(
      `SELECT * FROM sessions
       WHERE repo = ?
       AND status IN ('running', 'blocked', 'starting', 'pending')
       ORDER BY created_at`
    )
    .all(args.repo) as db.Session[];

  log("info", `Found ${sessions.length} active sessions for ${args.repo}`);

  let cleaned = 0;
  let skipped = 0;

  for (const session of sessions) {
    const issueNumber = session.github_number;

    // Check if issue/PR is still open
    const isOpen = await withSpan(
      "github.isIssueOpen",
      async () => {
        try {
          if (session.github_type === "pull_request") {
            return await github.isPROpen(owner, repoName, issueNumber);
          } else {
            const octokit = github.getOctokit();
            const { data: issue } = await octokit.issues.get({
              owner,
              repo: repoName,
              issue_number: issueNumber,
            });
            return issue.state === "open";
          }
        } catch {
          // If we can't fetch, assume it's closed
          return false;
        }
      },
      { attributes: { "issue.number": issueNumber } }
    );

    if (isOpen) {
      log("debug", `#${issueNumber} is still open, skipping`);
      skipped++;
      continue;
    }

    log("info", `#${issueNumber} is closed, cleaning up session ${session.id}`);

    if (args.dryRun) {
      log("info", `[DRY RUN] Would clean up session ${session.id}`, {
        tmuxWindow: session.tmux_window ?? -1,
        worktreePath: session.worktree_path ?? "unknown",
      });
      cleaned++;
      continue;
    }

    await withSpan(
      "cleanupSession",
      async (span) => {
        span.setAttribute("session.id", session.id);

        // Clean up tmux window
        if (session.tmux_window !== null && (await tmux.windowExists(session.tmux_window))) {
          try {
            await tmux.killWindow(session.tmux_window);
            log("debug", `Removed tmux window ${session.tmux_window}`);
          } catch (error) {
            log("warn", `Failed to remove tmux window: ${error}`);
          }
        }

        // Clean up git worktree
        if (session.worktree_path) {
          try {
            await git.removeWorktree(session.github_number);
            log("debug", `Removed worktree for session ${session.id}`);
          } catch (error) {
            log("warn", `Failed to remove worktree: ${error}`);
          }
        }

        // Update session status
        db.updateSessionStatus(session.id, "complete", {
          completion_summary: "Cleaned up: issue/PR closed",
        });

        db.logActivity(session.id, "session_cleanup", { reason: "issue_closed" }, "workflow");

        Metrics.sessionEnded();
      },
      { attributes: { "cleanup.session": session.id } }
    );

    cleaned++;
  }

  log("info", `Cleanup complete: ${cleaned} cleaned, ${skipped} skipped`);

  return cleaned;
}

main();
