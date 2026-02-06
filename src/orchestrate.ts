#!/usr/bin/env bun
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
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  const ctx: PRContext = {
    ...args,
    owner,
    repoName,
  };

  console.log(`[GWA] Starting work on PR #${ctx.pr} (${ctx.repo})`);
  console.log(`[GWA] Trigger: ${ctx.trigger}, Actor: ${ctx.actor}`);

  try {
    await orchestrate(ctx);
    console.log("[GWA] Orchestration completed successfully");
  } catch (error) {
    console.error("[GWA] Fatal error:", error);
    await github.postError(
      ctx.owner,
      ctx.repoName,
      ctx.pr,
      "Orchestration failed",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  } finally {
    await redis.closeRedis();
  }

  // Explicit exit to ensure process terminates
  process.exit(0);
}

async function orchestrate(ctx: PRContext): Promise<void> {
  // 1. Ensure tmux session exists
  console.log("[GWA] Ensuring tmux session...");
  await tmux.ensureSession();

  // 2. Get branch name if not provided
  let branch = ctx.branch;
  if (!branch) {
    console.log("[GWA] Fetching branch name from GitHub...");
    branch = await github.getPRBranch(ctx.owner, ctx.repoName, ctx.pr);
  }

  // 3. Setup or update git worktree
  console.log("[GWA] Setting up git worktree...");
  await git.fetchAll();

  let worktreePath: string;
  const exists = await git.worktreeExists(ctx.pr);

  if (exists) {
    console.log("[GWA] Worktree exists, updating...");
    await git.updateWorktree(ctx.pr, branch);
    worktreePath = git.getWorktreePath(ctx.pr);
  } else {
    console.log("[GWA] Creating new worktree...");
    worktreePath = await git.createWorktree(ctx.pr, branch);
  }

  // 4. Get or create session in Redis
  let session = await redis.getSession(ctx.repo, ctx.pr);
  let tmuxWindow: number;

  if (session) {
    console.log(`[GWA] Found existing session in window ${session.tmuxWindow}`);
    tmuxWindow = session.tmuxWindow;
    await redis.touchSession(ctx.repo, ctx.pr);

    // Verify window still exists
    if (!(await tmux.windowExists(tmuxWindow))) {
      console.log("[GWA] Window gone, recreating...");
      tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath);
      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");
    }
  } else {
    console.log("[GWA] Creating new session...");
    tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath);

    await redis.createSession(ctx.repo, ctx.pr, {
      tmuxWindow,
      podName: process.env.POD_NAME || "gwa-runner-0",
      worktreePath,
      createdAt: Date.now(),
      status: "active",
    });
  }

  // 5. Build prompt based on trigger
  const prompt = buildPrompt(ctx);
  console.log("[GWA] Prompt:", prompt.substring(0, 100) + "...");

  // 6. Run Claude
  console.log("[GWA] Running Claude...");
  await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");

  const result = await claude.runClaude({
    prompt,
    workingDir: worktreePath,
    continueSession: !!session,
  });

  // 7. Handle result
  if (result.askedQuestion) {
    console.log("[GWA] Claude asked a question");
    await redis.updateSessionStatus(ctx.repo, ctx.pr, "waiting");
    await redis.storeQuestion(ctx.repo, ctx.pr, result.askedQuestion);
    await github.postQuestion(
      ctx.owner,
      ctx.repoName,
      ctx.pr,
      result.askedQuestion,
      result.output.slice(-500) // Last 500 chars as context
    );
  } else if (result.success) {
    console.log("[GWA] Claude completed successfully");
    await redis.updateSessionStatus(ctx.repo, ctx.pr, "completed");
    await github.postWorkComplete(
      ctx.owner,
      ctx.repoName,
      ctx.pr,
      "Work completed",
      result.output.slice(-2000)
    );
  } else {
    console.log("[GWA] Claude encountered an error");
    await redis.updateSessionStatus(ctx.repo, ctx.pr, "error");
    await github.postError(
      ctx.owner,
      ctx.repoName,
      ctx.pr,
      result.error || "Unknown error",
      result.output.slice(-2000)
    );
  }
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
