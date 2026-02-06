#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import type { OrchestrateArgs, PRContext } from "./lib/types.js";
import * as redis from "./lib/redis.js";
import * as github from "./lib/github.js";
import * as tmux from "./lib/tmux.js";
import * as git from "./lib/git.js";
import * as claude from "./lib/claude.js";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      trigger: { type: "string" },
      branch: { type: "string" },
      comment: { type: "string" },
      actor: { type: "string" },
    },
  });

  const args: OrchestrateArgs = {
    pr: parseInt(values.pr || "0", 10),
    repo: values.repo || "",
    trigger: (values.trigger as OrchestrateArgs["trigger"]) || "manual",
    branch: values.branch,
    comment: values.comment,
    actor: values.actor || "unknown",
  };

  if (!args.pr || !args.repo) {
    console.error("Usage: gwa-orchestrate --pr <number> --repo <owner/repo>");
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  const ctx: PRContext = {
    ...args,
    owner,
    repoName,
  };

  const startTime = Date.now();
  let success = false;

  try {
    await withSpan(
      "orchestrate",
      async (span) => {
        span.setAttribute("pr.number", ctx.pr);
        span.setAttribute("pr.repo", ctx.repo);
        span.setAttribute("pr.trigger", ctx.trigger);
        span.setAttribute("pr.actor", ctx.actor);

        log("info", `Starting work on PR #${ctx.pr}`, {
          repo: ctx.repo,
          trigger: ctx.trigger,
          actor: ctx.actor,
        });

        await orchestrate(ctx);
        success = true;

        log("info", "Orchestration completed successfully", {
          repo: ctx.repo,
          pr: ctx.pr,
        });
      },
      {
        attributes: {
          "gwa.operation": "orchestrate",
          "pr.number": ctx.pr,
          "pr.repo": ctx.repo,
        },
      }
    );
  } catch (error) {
    log("error", "Orchestration failed", {
      repo: ctx.repo,
      pr: ctx.pr,
      error: error instanceof Error ? error.message : String(error),
    });

    await github.postError(
      ctx.owner,
      ctx.repoName,
      ctx.pr,
      "Orchestration failed",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    // Record metrics
    Metrics.recordOrchestration(ctx.repo, ctx.pr, ctx.trigger, success);
    Metrics.recordOrchestrationDuration(Date.now() - startTime, ctx.repo, ctx.trigger);

    await redis.closeRedis();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function orchestrate(ctx: PRContext): Promise<void> {
  // 1. Ensure tmux session exists
  await withSpan("tmux.ensureSession", async () => {
    log("debug", "Ensuring tmux session");
    await tmux.ensureSession();
  });

  // 2. Get branch name if not provided
  let branch = ctx.branch;
  if (!branch) {
    branch = await withSpan(
      "github.getPRBranch",
      async (span) => {
        log("debug", "Fetching branch name from GitHub");
        const branchName = await github.getPRBranch(ctx.owner, ctx.repoName, ctx.pr);
        span.setAttribute("pr.branch", branchName);
        Metrics.recordGitHubApiCall("getPRBranch", true);
        return branchName;
      },
      { attributes: { "github.operation": "getPRBranch" } }
    );
  }

  // 3. Setup or update git worktree
  let worktreePath: string;
  await withSpan("git.setup", async (span) => {
    log("debug", "Setting up git worktree");
    await git.fetchAll();

    const exists = await git.worktreeExists(ctx.pr);
    span.setAttribute("worktree.exists", exists);

    if (exists) {
      log("debug", "Worktree exists, updating");
      await git.updateWorktree(ctx.pr, branch!);
      worktreePath = git.getWorktreePath(ctx.pr);
    } else {
      log("debug", "Creating new worktree");
      worktreePath = await git.createWorktree(ctx.pr, branch!);
    }

    span.setAttribute("worktree.path", worktreePath);
  });

  // 4. Get or create session in Redis
  let session = await withSpan("redis.getSession", async () => {
    const s = await redis.getSession(ctx.repo, ctx.pr);
    Metrics.recordRedisOperation("getSession", true);
    return s;
  });

  let tmuxWindow: number;

  if (session) {
    log("debug", `Found existing session in window ${session.tmuxWindow}`);
    tmuxWindow = session.tmuxWindow;
    await redis.touchSession(ctx.repo, ctx.pr);

    // Verify window still exists
    if (!(await tmux.windowExists(tmuxWindow))) {
      log("debug", "Window gone, recreating");
      tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath!);
      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");
    }
  } else {
    log("debug", "Creating new session");
    tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath!);

    await withSpan("redis.createSession", async () => {
      await redis.createSession(ctx.repo, ctx.pr, {
        tmuxWindow,
        podName: process.env.POD_NAME || "gwa-runner-0",
        worktreePath: worktreePath!,
        createdAt: Date.now(),
        status: "active",
      });
      Metrics.recordRedisOperation("createSession", true);
      Metrics.sessionStarted();
    });
  }

  // 5. Build prompt based on trigger
  const prompt = buildPrompt(ctx);
  log("debug", "Built prompt", { promptLength: prompt.length });

  // 6. Run Claude
  await withSpan(
    "claude.run",
    async (span) => {
      span.setAttribute("claude.continueSession", !!session);
      log("info", "Running Claude", {
        continueSession: !!session,
        workingDir: worktreePath!,
      });

      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");

      const claudeStartTime = Date.now();
      const result = await claude.runClaude({
        prompt,
        workingDir: worktreePath!,
        continueSession: !!session,
      });
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
      Metrics.recordClaudeInvocation(outcome, !!session);
      Metrics.recordClaudeDuration(claudeDuration, outcome);

      // 7. Handle result
      if (result.askedQuestion) {
        log("info", "Claude asked a question", { pr: ctx.pr });
        await redis.updateSessionStatus(ctx.repo, ctx.pr, "waiting");
        await redis.storeQuestion(ctx.repo, ctx.pr, result.askedQuestion);
        await github.postQuestion(
          ctx.owner,
          ctx.repoName,
          ctx.pr,
          result.askedQuestion,
          result.output.slice(-500)
        );
        Metrics.recordGitHubApiCall("postQuestion", true);
      } else if (result.success) {
        log("info", "Claude completed successfully", { pr: ctx.pr });
        await redis.updateSessionStatus(ctx.repo, ctx.pr, "completed");
        await github.postWorkComplete(
          ctx.owner,
          ctx.repoName,
          ctx.pr,
          "Work completed",
          result.output.slice(-2000)
        );
        Metrics.recordGitHubApiCall("postWorkComplete", true);
        Metrics.sessionEnded();
      } else {
        log("error", "Claude encountered an error", {
          pr: ctx.pr,
          error: result.error || "Unknown error",
        });
        await redis.updateSessionStatus(ctx.repo, ctx.pr, "error");
        await github.postError(
          ctx.owner,
          ctx.repoName,
          ctx.pr,
          result.error || "Unknown error",
          result.output.slice(-2000)
        );
        Metrics.recordGitHubApiCall("postError", true);
        Metrics.sessionEnded();
      }
    },
    { attributes: { "claude.operation": "runClaude" } }
  );
}

function buildPrompt(ctx: PRContext): string {
  switch (ctx.trigger) {
    case "pr_event":
      return `Work on PR #${ctx.pr}. Analyze the changes, ensure tests pass, and address any issues. If the PR description has specific instructions, follow them.`;

    case "comment":
      return `Address this feedback on PR #${ctx.pr}: ${ctx.comment || "No comment provided"}`;

    case "manual":
      return `Resume work on PR #${ctx.pr}. Check the current state and continue where you left off.`;

    default:
      return `Work on PR #${ctx.pr}.`;
  }
}

main();
