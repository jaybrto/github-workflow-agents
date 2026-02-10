#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import * as github from "./lib/github.js";
import * as db from "./lib/db.js";
import * as tmux from "./lib/tmux.js";

interface RespondArgs {
  issue: number;
  repo: string;
  comment?: string;
  actor?: string;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
      comment: { type: "string" },
      actor: { type: "string" },
    },
  });

  const args: RespondArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
    comment: values.comment,
    actor: values.actor || "unknown",
  };

  if (!args.issue || !args.repo) {
    console.error(
      "Usage: gwa-respond --issue <number> --repo <owner/repo> [--comment <text>] [--actor <username>]"
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  let success = false;

  try {
    // Initialize database
    db.initDatabase();

    await withSpan(
      "respond",
      async (span) => {
        span.setAttribute("issue.number", args.issue);
        span.setAttribute("issue.repo", args.repo);
        span.setAttribute("issue.actor", args.actor || "unknown");

        log("info", `Processing answer for issue #${args.issue}`, {
          repo: args.repo,
          actor: args.actor || "unknown",
        });

        await handleResponse(args, owner, repoName);
        success = true;
      },
      {
        attributes: {
          "gwa.operation": "respond",
          "issue.number": args.issue,
          "issue.repo": args.repo,
        },
      }
    );
  } catch (error) {
    log("error", "Failed to process answer", {
      repo: args.repo,
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });

    await github.postError(
      owner,
      repoName,
      args.issue,
      "Failed to process answer",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    Metrics.recordResponse(args.repo, args.issue, success);
    db.closeDatabase();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function handleResponse(
  args: RespondArgs,
  owner: string,
  repoName: string
): Promise<void> {
  // Get session from SQLite
  const session = await withSpan("db.getSessionByPR", async () => {
    return db.getSessionByPR(args.repo, args.issue);
  });

  if (!session) {
    log("warn", "No active session found", { issue: args.issue });
    await github.postIssueComment(
      owner,
      repoName,
      args.issue,
      "No active Claude session found for this issue. Move to 'Planning' column to start a new session."
    );
    Metrics.recordGitHubApiCall("postIssueComment", true);
    return;
  }

  // Get pending question
  const pendingQuestion = db.getPendingQuestion(session.id);

  // Extract answer from comment if provided, otherwise fetch from GitHub
  let answer: string | undefined;
  let answeredBy = args.actor || "unknown";

  if (args.comment) {
    // Extract answer from comment
    const match = args.comment.match(/@claude-answer:\s*(.+)/is);
    if (match) {
      answer = match[1].trim();
    }
  } else if (pendingQuestion) {
    // Fetch the latest answer from GitHub comments
    const octokit = github.getOctokit();
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo: repoName,
      issue_number: args.issue,
      since: new Date(pendingQuestion.asked_at * 1000).toISOString(),
      per_page: 100,
    });

    // Find the most recent @claude-answer comment
    for (const comment of comments.reverse()) {
      const match = comment.body?.match(/@claude-answer:\s*(.+)/is);
      if (match) {
        answer = match[1].trim();
        answeredBy = comment.user?.login || "unknown";
        break;
      }
    }
  }

  if (!answer) {
    log("debug", "No answer found");
    return;
  }

  log("info", "Extracted answer", { answerLength: answer.length, answeredBy });

  // Update question with answer
  if (pendingQuestion) {
    db.answerQuestion(pendingQuestion.id, answer, answeredBy);
  }

  if (session.status !== "blocked") {
    log("info", `Session status is ${session.status}, not blocked`);
    await github.postIssueComment(
      owner,
      repoName,
      args.issue,
      `Claude is not currently waiting for input (status: ${session.status}). Your answer has been saved.`
    );
    Metrics.recordGitHubApiCall("postIssueComment", true);
    return;
  }

  // Update session status to running
  db.updateSessionStatus(session.id, "running");

  // Resume Claude with the answer by sending to tmux window
  await withSpan(
    "claude.resumeWithAnswer",
    async (span) => {
      log("info", "Resuming Claude with answer", {
        sessionId: session.id,
        tmuxWindow: session.tmux_window ?? -1,
      });

      if (session.tmux_window === null) {
        throw new Error("Session has no tmux window");
      }

      // Send the answer to the Claude REPL
      await tmux.sendCommand(session.tmux_window, answer!);

      db.logActivity(session.id, "answer_sent", { answeredBy, answerLength: answer!.length }, answeredBy);

      span.setAttribute("claude.sessionId", session.id);
      Metrics.recordClaudeInvocation("success", true);

      log("info", "Answer sent to Claude", { sessionId: session.id });
    },
    { attributes: { "claude.operation": "resumeWithAnswer" } }
  );
}

main();
