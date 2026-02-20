#!/usr/bin/env bun
// Telemetry MUST be imported first
import {
  withSpan,
  Metrics,
  shutdown as shutdownTelemetry,
  log,
} from "./lib/telemetry.js";

import { parseArgs } from "util";
import * as db from "./lib/db.js";
import * as github from "./lib/github.js";
import { captureScreenshot, toMarkdownImage } from "./lib/screenshot.js";
import { generateComment } from "./lib/comment-generator.js";

interface SessionCompleteArgs {
  pr: number;
  repo: string;
  summary: string;
  sessionId?: string;
  window?: number;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      summary: { type: "string" },
      "session-id": { type: "string" },
      window: { type: "string" },
    },
  });

  const args: SessionCompleteArgs = {
    pr: parseInt(values.pr || "0", 10),
    repo: values.repo || "",
    summary: values.summary || "",
    sessionId: values["session-id"],
    window: values.window ? parseInt(values.window, 10) : undefined,
  };

  if (!args.pr || !args.repo || !args.summary) {
    console.error(
      "Usage: session-complete --pr <number> --repo <owner/repo> --summary <text> [--session-id <id>] [--window <number>]"
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
      "session-complete",
      async (span) => {
        span.setAttribute("pr.number", args.pr);
        span.setAttribute("pr.repo", args.repo);
        if (args.sessionId) {
          span.setAttribute("repl.session_id", args.sessionId);
        }
        if (args.window !== undefined) {
          span.setAttribute("tmux.window", args.window);
        }

        log("info", "Marking session complete", {
          repo: args.repo,
          pr: args.pr,
          sessionId: args.sessionId || "none",
          window: args.window ?? -1,
        });

        // Get or derive session ID
        const sessionId = args.sessionId || `pr-${args.pr}`;

        // Step 1: Optionally capture final screenshot
        let screenshotMarkdown = "";
        if (args.window !== undefined) {
          try {
            log("debug", "Capturing final screenshot", { window: args.window });
            const screenshot = await captureScreenshot({ window: args.window });
            screenshotMarkdown = `\n\n${toMarkdownImage(screenshot.buffer, "Final state")}`;
            span.setAttribute("screenshot.sizeKB", screenshot.sizeKB);
            span.setAttribute("screenshot.captured", true);
          } catch (error) {
            log("warn", "Failed to capture screenshot", {
              error: error instanceof Error ? error.message : String(error),
            });
            span.setAttribute("screenshot.captured", false);
          }
        }

        // Step 2: Update SQLite session status to complete
        await withSpan("db.updateSessionStatus", async () => {
          const session = db.getSessionByPR(args.repo, args.pr);
          if (session) {
            db.updateSessionStatus(session.id, "complete", {
              completion_summary: args.summary,
            });
            db.logActivity(session.id, "session_completed", { summary: args.summary.substring(0, 200) }, "claude");
          } else {
            // Create minimal session record if it doesn't exist
            db.createSession({
              id: sessionId,
              type: "pr",
              github_number: args.pr,
              github_type: "pull_request",
              repo: args.repo,
            });
            db.updateSessionStatus(sessionId, "complete", {
              completion_summary: args.summary,
            });
          }
          Metrics.recordDbOperation("updateSessionStatus", true);
        });

        // Step 3: Update the lifecycle status comment or post a new one
        const session = db.getSessionByPR(args.repo, args.pr);
        const statusCommentId = session?.status_comment_id;

        const completionComment = await generateComment({
          type: "session_complete",
          sessionId: session?.id || `pr-${args.pr}`,
          summary: args.summary + screenshotMarkdown,
          startedAt: session?.started_at ?? undefined,
          completedAt: Math.floor(Date.now() / 1000),
        });

        await withSpan("github.updateOrPostComment", async () => {
          if (statusCommentId) {
            // Update the existing lifecycle comment
            await github.updateComment(owner, repoName, statusCommentId, completionComment.body);
            Metrics.recordGitHubApiCall("issues.updateComment", true);
            log("info", "Updated lifecycle status comment", { commentId: statusCommentId });
          } else {
            // No status comment saved — fall back to posting a new one
            await github.postPRComment(owner, repoName, args.pr, completionComment.body);
            Metrics.recordGitHubApiCall("postPRComment", true);
            log("info", "Posted new completion comment (no status comment ID found)");
          }
        });

        success = true;
        log("info", "Session marked complete", {
          repo: args.repo,
          pr: args.pr,
        });

        Metrics.sessionEnded();
      },
      {
        attributes: {
          "gwa.operation": "session-complete",
          "pr.number": args.pr,
          "pr.repo": args.repo,
        },
      }
    );

    console.log("Session marked complete");
  } catch (error) {
    log("error", "Failed to mark session complete", {
      repo: args.repo,
      pr: args.pr,
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
