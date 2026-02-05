#!/usr/bin/env bun
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
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");

  console.log(`[GWA] Processing answer for PR #${args.pr}`);

  try {
    await handleResponse(args, owner, repoName);
  } catch (error) {
    console.error("[GWA] Fatal error:", error);
    await github.postError(
      owner,
      repoName,
      args.pr,
      "Failed to process answer",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  } finally {
    await redis.closeRedis();
  }
}

async function handleResponse(
  args: RespondArgs,
  owner: string,
  repoName: string
): Promise<void> {
  // Extract answer from comment
  const match = args.comment.match(/@claude-answer:\s*(.+)/i);
  if (!match) {
    console.log("[GWA] No @claude-answer: found in comment");
    return;
  }

  const answer = match[1].trim();
  console.log(`[GWA] Extracted answer: ${answer.substring(0, 100)}...`);

  // Store answer in Redis
  await redis.storeAnswer(args.repo, args.pr, answer, args.actor);
  console.log("[GWA] Answer stored in Redis");

  // Get session info
  const session = await redis.getSession(args.repo, args.pr);

  if (!session) {
    console.log("[GWA] No active session found, cannot continue");
    await github.postPRComment(
      owner,
      repoName,
      args.pr,
      "No active Claude session found for this PR. Comment `@claude` to start a new session."
    );
    return;
  }

  if (session.status !== "waiting") {
    console.log(`[GWA] Session status is ${session.status}, not waiting`);
    await github.postPRComment(
      owner,
      repoName,
      args.pr,
      `Claude is not currently waiting for input (status: ${session.status}). Your answer has been saved.`
    );
    return;
  }

  // Continue Claude with the answer
  console.log("[GWA] Continuing Claude with answer...");
  await redis.updateSessionStatus(args.repo, args.pr, "active");
  await redis.clearQuestion(args.repo, args.pr);

  const result = await claude.continueWithAnswer(session.worktreePath, answer);

  // Handle result
  if (result.askedQuestion) {
    console.log("[GWA] Claude asked another question");
    await redis.updateSessionStatus(args.repo, args.pr, "waiting");
    await redis.storeQuestion(args.repo, args.pr, result.askedQuestion);
    await github.postQuestion(
      owner,
      repoName,
      args.pr,
      result.askedQuestion,
      result.output.slice(-500)
    );
  } else if (result.success) {
    console.log("[GWA] Claude completed successfully");
    await redis.updateSessionStatus(args.repo, args.pr, "completed");
    await github.postWorkComplete(
      owner,
      repoName,
      args.pr,
      "Work completed after receiving your answer",
      result.output.slice(-2000)
    );
  } else {
    console.log("[GWA] Claude encountered an error");
    await redis.updateSessionStatus(args.repo, args.pr, "error");
    await github.postError(
      owner,
      repoName,
      args.pr,
      result.error || "Unknown error",
      result.output.slice(-2000)
    );
  }
}

main();
