#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, SessionMetrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import * as db from "./lib/db.js";
import * as github from "./lib/github.js";
import { captureScreenshot, toMarkdownImage } from "./lib/screenshot.js";

interface AskQuestionArgs {
  pr: number;
  repo: string;
  question: string;
  window?: number;
  sessionId?: string;
}

const POLL_INTERVAL_MS = 5000; // 5 seconds
const TIMEOUT_MS = 3600000; // 1 hour

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      question: { type: "string" },
      window: { type: "string" },
      "session-id": { type: "string" },
    },
  });

  const args: AskQuestionArgs = {
    pr: parseInt(values.pr || "0", 10),
    repo: values.repo || "",
    question: values.question || "",
    window: values.window ? parseInt(values.window, 10) : undefined,
    sessionId: values["session-id"],
  };

  if (!args.pr || !args.repo || !args.question) {
    console.error(
      "Usage: gwa-ask-question --pr <number> --repo <owner/repo> --question <text> [--window <number>] [--session-id <id>]"
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");

  let success = false;

  try {
    const answer = await withSpan(
      "ask-question",
      async (span) => {
        span.setAttribute("pr.number", args.pr);
        span.setAttribute("pr.repo", args.repo);
        span.setAttribute("question.length", args.question.length);

        log("info", "Asking question on PR", {
          repo: args.repo,
          pr: args.pr,
          questionLength: args.question.length,
        });

        // Get or create session ID
        const sessionId = args.sessionId || `pr-${args.pr}`;

        // 1. Get session from SQLite and update status to "blocked"
        await withSpan("db.updateStatus", async () => {
          const session = db.getSessionByPR(args.repo, args.pr);
          if (session) {
            db.updateSessionStatus(session.id, "blocked");
          }
          Metrics.recordDbOperation("updateSessionStatus", true);
        });

        // 2. Optionally capture screenshot
        let screenshotMarkdown = "";
        if (args.window !== undefined) {
          try {
            const screenshot = await withSpan("screenshot.capture", async () => {
              return captureScreenshot({ window: args.window! });
            });
            screenshotMarkdown = toMarkdownImage(screenshot.buffer, "Current terminal state");
            log("debug", "Screenshot captured", {
              sizeKB: screenshot.sizeKB,
              wasCompressed: screenshot.wasCompressed,
            });
          } catch (error) {
            log("warn", "Failed to capture screenshot", {
              error: error instanceof Error ? error.message : String(error),
            });
            // Continue without screenshot
          }
        }

        // 3. Create question record in SQLite
        const questionId = await withSpan("db.createQuestion", async () => {
          const id = db.createQuestion({
            session_id: sessionId,
            question: args.question,
          });
          Metrics.recordDbOperation("createQuestion", true);
          return id;
        });

        // Record metrics for question asked
        SessionMetrics.recordQuestionAsked(args.repo);

        // 4. Build and post question to GitHub
        let body = `🤔 **Claude is asking:**\n\n${args.question}`;

        if (screenshotMarkdown) {
          body += `\n\n${screenshotMarkdown}`;
        }

        body += `\n\n---\n**Reply with:** \`@claude-answer: your response\``;

        const commentId = await withSpan("github.postComment", async () => {
          const result = await github.postPRComment(owner, repoName, args.pr, body);
          Metrics.recordGitHubApiCall("postPRComment", true);
          return result.id;
        });

        // 5. Update question with GitHub comment ID
        await withSpan("db.updateQuestionPosted", async () => {
          db.updateQuestionPosted(questionId, commentId);
          Metrics.recordDbOperation("updateQuestionPosted", true);
        });

        log("info", "Question posted, waiting for answer", {
          repo: args.repo,
          pr: args.pr,
          questionId,
        });

        // 6. Poll SQLite for answer
        const startTime = Date.now();
        let answer: string | undefined;

        while (Date.now() - startTime < TIMEOUT_MS) {
          await withSpan("db.pollAnswer", async () => {
            const question = db.getPendingQuestion(sessionId);
            Metrics.recordDbOperation("getPendingQuestion", true);

            if (question?.answer) {
              answer = question.answer;
              log("info", "Received answer", {
                repo: args.repo,
                pr: args.pr,
                answeredBy: question.answered_by || "unknown",
              });
            }
          });

          if (answer) {
            break;
          }

          // Wait before polling again
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        if (!answer) {
          // Update question status to timeout
          const dbConn = db.getDatabase();
          dbConn.run(`UPDATE questions SET status = 'timeout' WHERE id = ?`, [questionId]);
          throw new Error("Timeout waiting for answer (1 hour)");
        }

        // 7. Update session status back to running
        await withSpan("db.updateStatusRunning", async () => {
          const session = db.getSessionByPR(args.repo, args.pr);
          if (session) {
            db.updateSessionStatus(session.id, "running");
          }
          Metrics.recordDbOperation("updateSessionStatus", true);
        });

        success = true;
        span.setAttribute("answer.length", answer.length);

        return answer;
      },
      {
        attributes: {
          "gwa.operation": "ask-question",
          "pr.number": args.pr,
          "pr.repo": args.repo,
        },
      }
    );

    // Output answer to stdout so Claude can read it
    console.log(answer);
  } catch (error) {
    log("error", "Failed to get answer", {
      repo: args.repo,
      pr: args.pr,
      error: error instanceof Error ? error.message : String(error),
    });

    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    db.closeDatabase();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

main();
