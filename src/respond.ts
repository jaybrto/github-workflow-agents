#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import type { RespondArgs } from "./lib/types.js";
import * as redis from "./lib/redis.js";
import * as github from "./lib/github.js";
import * as claude from "./lib/claude.js";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      comment: { type: "string" },
      actor: { type: "string" },
    },
  });

  const args: RespondArgs = {
    pr: parseInt(values.pr || "0", 10),
    repo: values.repo || "",
    comment: values.comment || "",
    actor: values.actor || "unknown",
  };

  if (!args.pr || !args.repo || !args.comment) {
    console.error(
      "Usage: gwa-respond --pr <number> --repo <owner/repo> --comment <text>"
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  let success = false;

  try {
    await withSpan(
      "respond",
      async (span) => {
        span.setAttribute("pr.number", args.pr);
        span.setAttribute("pr.repo", args.repo);
        span.setAttribute("pr.actor", args.actor);

        log("info", `Processing answer for PR #${args.pr}`, {
          repo: args.repo,
          actor: args.actor,
        });

        await handleResponse(args, owner, repoName);
        success = true;
      },
      {
        attributes: {
          "gwa.operation": "respond",
          "pr.number": args.pr,
          "pr.repo": args.repo,
        },
      }
    );
  } catch (error) {
    log("error", "Failed to process answer", {
      repo: args.repo,
      pr: args.pr,
      error: error instanceof Error ? error.message : String(error),
    });

    await github.postError(
      owner,
      repoName,
      args.pr,
      "Failed to process answer",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    Metrics.recordResponse(args.repo, args.pr, success);
    await redis.closeRedis();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function handleResponse(
  args: RespondArgs,
  owner: string,
  repoName: string
): Promise<void> {
  // Extract answer from comment
  const match = args.comment.match(/@claude-answer:\s*(.+)/i);
  if (!match) {
    log("debug", "No @claude-answer: found in comment");
    return;
  }

  const answer = match[1].trim();
  log("info", "Extracted answer", { answerLength: answer.length });

  // Store answer in Redis
  await withSpan("redis.storeAnswer", async () => {
    await redis.storeAnswer(args.repo, args.pr, answer, args.actor);
    Metrics.recordRedisOperation("storeAnswer", true);
  });

  // Get session info
  const session = await withSpan("redis.getSession", async () => {
    const s = await redis.getSession(args.repo, args.pr);
    Metrics.recordRedisOperation("getSession", true);
    return s;
  });

  if (!session) {
    log("warn", "No active session found", { pr: args.pr });
    await github.postPRComment(
      owner,
      repoName,
      args.pr,
      "No active Claude session found for this PR. Comment `@claude` to start a new session."
    );
    Metrics.recordGitHubApiCall("postPRComment", true);
    return;
  }

  if (session.status !== "waiting") {
    log("info", `Session status is ${session.status}, not waiting`);
    await github.postPRComment(
      owner,
      repoName,
      args.pr,
      `Claude is not currently waiting for input (status: ${session.status}). Your answer has been saved.`
    );
    Metrics.recordGitHubApiCall("postPRComment", true);
    return;
  }

  // Continue Claude with the answer
  await withSpan(
    "claude.continueWithAnswer",
    async (span) => {
      log("info", "Continuing Claude with answer", {
        workingDir: session.worktreePath,
      });

      await redis.updateSessionStatus(args.repo, args.pr, "active");
      await redis.clearQuestion(args.repo, args.pr);

      const claudeStartTime = Date.now();
      const result = await claude.continueWithAnswer(session.worktreePath, answer);
      const claudeDuration = Date.now() - claudeStartTime;

      // Determine outcome
      let outcome: "success" | "error" | "question" | "timeout";
      if (result.askedQuestion) {
        outcome = "question";
      } else if (result.success) {
        outcome = "success";
      } else if (result.error?.includes("timeout")) {
        outcome = "timeout";
      } else {
        outcome = "error";
      }

      span.setAttribute("claude.outcome", outcome);
      span.setAttribute("claude.durationMs", claudeDuration);
      Metrics.recordClaudeInvocation(outcome, true);
      Metrics.recordClaudeDuration(claudeDuration, outcome);

      // Handle result
      if (result.askedQuestion) {
        log("info", "Claude asked another question", { pr: args.pr });
        await redis.updateSessionStatus(args.repo, args.pr, "waiting");
        await redis.storeQuestion(args.repo, args.pr, result.askedQuestion);
        await github.postQuestion(
          owner,
          repoName,
          args.pr,
          result.askedQuestion,
          result.output.slice(-500)
        );
        Metrics.recordGitHubApiCall("postQuestion", true);
      } else if (result.success) {
        log("info", "Claude completed successfully", { pr: args.pr });
        await redis.updateSessionStatus(args.repo, args.pr, "completed");
        await github.postWorkComplete(
          owner,
          repoName,
          args.pr,
          "Work completed after receiving your answer",
          result.output.slice(-2000)
        );
        Metrics.recordGitHubApiCall("postWorkComplete", true);
        Metrics.sessionEnded();
      } else {
        log("error", "Claude encountered an error", {
          pr: args.pr,
          error: result.error || "Unknown error",
        });
        await redis.updateSessionStatus(args.repo, args.pr, "error");
        await github.postError(
          owner,
          repoName,
          args.pr,
          result.error || "Unknown error",
          result.output.slice(-2000)
        );
        Metrics.recordGitHubApiCall("postError", true);
        Metrics.sessionEnded();
      }
    },
    { attributes: { "claude.operation": "continueWithAnswer" } }
  );
}

main();
