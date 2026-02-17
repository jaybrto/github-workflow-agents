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
import { ClaudeAuthError } from "./lib/claude.js";
import { startREPL } from "./lib/repl-session.js";
import { analyzeTaskComplexity } from "./lib/task-analyzer.js";
import { generateComment } from "./lib/comment-generator.js";
import { startMetricsExporter } from "./lib/metrics-exporter.js";

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
      mode: { type: "string" },
    },
  });

  const args: OrchestrateArgs = {
    pr: parseInt(values.pr || "0", 10),
    repo: values.repo || "",
    trigger: (values.trigger as OrchestrateArgs["trigger"]) || "manual",
    branch: values.branch,
    comment: values.comment,
    actor: values.actor || "unknown",
    mode: values.mode as OrchestrateArgs["mode"],
  };

  // Validate mode if provided
  if (args.mode && !["repl", "headless"].includes(args.mode)) {
    console.error("Error: --mode must be 'repl' or 'headless'");
    await shutdownTelemetry();
    process.exit(1);
  }

  if (!args.pr || !args.repo) {
    console.error("Usage: gwa-orchestrate --pr <number> --repo <owner/repo> [--mode <repl|headless>]");
    await shutdownTelemetry();
    process.exit(1);
  }

  // SECURITY: Input validation to prevent injection attacks
  const repoRegex = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/;
  if (!repoRegex.test(args.repo)) {
    console.error("Error: Invalid repo format. Expected 'owner/repo'");
    await shutdownTelemetry();
    process.exit(1);
  }

  if (args.pr <= 0 || args.pr > 999999999) {
    console.error("Error: Invalid PR number");
    await shutdownTelemetry();
    process.exit(1);
  }

  // Validate actor format (GitHub usernames: alphanumeric, hyphens, max 39 chars)
  if (args.actor && !/^[a-zA-Z0-9-]{1,39}$/.test(args.actor) && args.actor !== "unknown") {
    console.error("Error: Invalid actor format");
    await shutdownTelemetry();
    process.exit(1);
  }

  // Limit comment size to prevent DoS
  const MAX_COMMENT_SIZE = 65536; // 64KB
  if (args.comment && args.comment.length > MAX_COMMENT_SIZE) {
    console.error(`Error: Comment too large (max ${MAX_COMMENT_SIZE} bytes)`);
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  const ctx: PRContext = {
    ...args,
    owner,
    repoName,
  };

  // Start background metrics exporter (safe to call multiple times)
  startMetricsExporter();

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

    if (error instanceof ClaudeAuthError) {
      await postAuthStuckComment(ctx, error.message);
    } else {
      await github.postError(
        ctx.owner,
        ctx.repoName,
        ctx.pr,
        "Orchestration failed",
        error instanceof Error ? error.message : String(error)
      );
    }
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
  // 0. Pre-flight: verify Claude auth environment is configured
  const authCheck = claude.checkAuthEnvironment();
  if (!authCheck.ok) {
    log("error", "Claude auth pre-flight failed", { error: authCheck.error || "unknown" });
    await postAuthStuckComment(ctx, authCheck.error!);
    throw new Error(`Auth pre-flight failed: ${authCheck.error}`);
  }

  // 1. Ensure tmux session exists
  await withSpan("tmux.ensureSession", async () => {
    log("debug", "Ensuring tmux session");
    await tmux.ensureSession();
  });

  // 2. Get PR details (branch and diff stats for mode selection)
  let branch = ctx.branch;
  let prDetails: { title: string; body: string | null } | undefined;
  let diffStats: github.DiffStats | undefined;

  if (!branch || !ctx.mode) {
    // We need PR details for branch name and/or mode selection
    const details = await withSpan(
      "github.getPRDetails",
      async (span) => {
        log("debug", "Fetching PR details from GitHub");
        const d = await github.getPRDetails(ctx.owner, ctx.repoName, ctx.pr);
        span.setAttribute("pr.branch", d.head);
        span.setAttribute("pr.title", d.title);
        Metrics.recordGitHubApiCall("getPRDetails", true);
        return d;
      },
      { attributes: { "github.operation": "getPRDetails" } }
    );

    branch = branch || details.head;
    prDetails = { title: details.title, body: details.body };

    // Get diff stats for mode selection if needed
    if (!ctx.mode) {
      diffStats = await withSpan(
        "github.getPRDiffStats",
        async (span) => {
          log("debug", "Fetching PR diff stats");
          const stats = await github.getPRDiffStats(ctx.owner, ctx.repoName, ctx.pr);
          span.setAttribute("pr.diff.additions", stats.additions);
          span.setAttribute("pr.diff.deletions", stats.deletions);
          span.setAttribute("pr.diff.files", stats.changedFiles);
          return stats;
        },
        { attributes: { "github.operation": "getPRDiffStats" } }
      );
    }
  }

  // 3. Determine execution mode
  let executionMode: "repl" | "headless" = ctx.mode || "repl";

  if (!ctx.mode) {
    // Auto-detect mode using task analyzer
    const analysisResult = await withSpan(
      "mode.analyze",
      async (span) => {
        log("info", "Analyzing task complexity for mode selection");

        const result = await analyzeTaskComplexity({
          trigger: ctx.trigger,
          prTitle: prDetails?.title,
          prBody: prDetails?.body || undefined,
          commentBody: ctx.comment,
          diffStats,
        });

        span.setAttribute("mode.selected", result.mode);
        span.setAttribute("mode.confidence", result.confidence);
        span.setAttribute("mode.reasoning", result.reasoning);

        log("info", "Mode selected", {
          mode: result.mode,
          confidence: result.confidence,
          reasoning: result.reasoning,
        });

        return result;
      },
      { attributes: { "mode.operation": "analyze" } }
    );

    executionMode = analysisResult.mode;
  } else {
    log("info", "Using explicitly specified mode", { mode: ctx.mode });
  }

  // 4. Setup or update git worktree
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

  // 5. Get or create session in Redis
  let session = await withSpan("redis.getSession", async () => {
    const s = await redis.getSession(ctx.repo, ctx.pr);
    Metrics.recordRedisOperation("getSession", true);
    return s;
  });

  // 6. Build prompt based on trigger
  const prompt = buildPrompt(ctx);
  log("debug", "Built prompt", { promptLength: prompt.length });

  // 7. Execute based on mode
  if (executionMode === "repl") {
    await executeREPLMode(ctx, worktreePath!, prompt, session);
  } else {
    await executeHeadlessMode(ctx, worktreePath!, prompt, session);
  }
}

/**
 * Execute in REPL mode: Start interactive session and exit.
 * Claude manages its own lifecycle via ask-question and session-complete tools.
 */
async function executeREPLMode(
  ctx: PRContext,
  worktreePath: string,
  prompt: string,
  existingSession: Awaited<ReturnType<typeof redis.getSession>>
): Promise<void> {
  await withSpan(
    "repl.execute",
    async (span) => {
      span.setAttribute("repl.working_dir", worktreePath);

      log("info", "Starting REPL mode", {
        pr: ctx.pr,
        workingDir: worktreePath,
      });

      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");

      // Start the REPL session
      const replResult = await startREPL(worktreePath, prompt);

      span.setAttribute("repl.session_id", replResult.session.sessionId);
      span.setAttribute("repl.tmux_window", replResult.session.tmuxWindow);

      // Update Redis session with REPL info
      if (!existingSession) {
        await withSpan("redis.createSession", async () => {
          await redis.createSession(ctx.repo, ctx.pr, {
            tmuxWindow: replResult.session.tmuxWindow,
            podName: process.env.POD_NAME || "gwa-runner-0",
            worktreePath,
            createdAt: Date.now(),
            status: "active",
          });
          Metrics.recordRedisOperation("createSession", true);
          Metrics.sessionStarted();
        });
      } else {
        await redis.touchSession(ctx.repo, ctx.pr);
      }

      // Generate and post REPL start comment
      const comment = await generateComment({
        type: "repl_start",
        sessionId: replResult.session.sessionId,
        kubectlAttachCommand: replResult.kubectlAttachCommand,
        tmuxAttachCommand: replResult.tmuxAttachCommand,
        prNumber: ctx.pr,
        trigger: ctx.trigger,
      });

      await github.postPRComment(ctx.owner, ctx.repoName, ctx.pr, comment.body);
      Metrics.recordGitHubApiCall("postPRComment", true);

      log("info", "REPL session started, orchestrator exiting", {
        sessionId: replResult.session.sessionId,
        tmuxWindow: replResult.session.tmuxWindow,
      });

      // REPL mode: Orchestrator exits here. Claude runs in background.
      // Claude will call ask-question and session-complete tools as needed.
    },
    { attributes: { "repl.operation": "execute" } }
  );
}

/**
 * Execute in headless mode: Run Claude and wait for completion.
 * Orchestrator handles questions and posts completion comment.
 */
async function executeHeadlessMode(
  ctx: PRContext,
  worktreePath: string,
  prompt: string,
  existingSession: Awaited<ReturnType<typeof redis.getSession>>
): Promise<void> {
  // Create tmux window for headless mode
  let tmuxWindow: number;

  if (existingSession) {
    log("debug", `Found existing session in window ${existingSession.tmuxWindow}`);
    tmuxWindow = existingSession.tmuxWindow;
    await redis.touchSession(ctx.repo, ctx.pr);

    // Verify window still exists
    if (!(await tmux.windowExists(tmuxWindow))) {
      log("debug", "Window gone, recreating");
      tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath);
      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");
    }
  } else {
    log("debug", "Creating new session");
    tmuxWindow = await tmux.createWindow(`pr-${ctx.pr}`, worktreePath);

    await withSpan("redis.createSession", async () => {
      await redis.createSession(ctx.repo, ctx.pr, {
        tmuxWindow,
        podName: process.env.POD_NAME || "gwa-runner-0",
        worktreePath,
        createdAt: Date.now(),
        status: "active",
      });
      Metrics.recordRedisOperation("createSession", true);
      Metrics.sessionStarted();
    });
  }

  await withSpan(
    "headless.execute",
    async (span) => {
      span.setAttribute("headless.continue_session", !!existingSession);
      span.setAttribute("headless.working_dir", worktreePath);

      log("info", "Running Claude in headless mode", {
        continueSession: !!existingSession,
        workingDir: worktreePath,
      });

      await redis.updateSessionStatus(ctx.repo, ctx.pr, "active");

      const claudeStartTime = Date.now();
      const result = await claude.runClaude({
        prompt,
        workingDir: worktreePath,
        continueSession: !!existingSession,
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

      span.setAttribute("headless.outcome", outcome);
      span.setAttribute("headless.duration_ms", claudeDuration);
      Metrics.recordClaudeInvocation(outcome, !!existingSession);
      Metrics.recordClaudeDuration(claudeDuration, outcome);

      // Handle result
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

        // Use smart comment generator for completion
        const comment = await generateComment({
          type: "headless_complete",
          output: result.output,
          prNumber: ctx.pr,
          trigger: ctx.trigger,
        });

        await github.postPRComment(ctx.owner, ctx.repoName, ctx.pr, comment.body);
        Metrics.recordGitHubApiCall("postPRComment", true);

        if (comment.usedAI) {
          log("debug", "Used AI summarization for completion comment");
        }

        Metrics.sessionEnded();
      } else {
        log("error", "Claude encountered an error", {
          pr: ctx.pr,
          error: result.error || "Unknown error",
        });
        await redis.updateSessionStatus(ctx.repo, ctx.pr, "error");

        // Check if this is an auth failure
        const isAuthFailure = claude.detectAuthFailure(
          (result.error || "") + "\n" + result.output.slice(-2000)
        );

        if (isAuthFailure) {
          await postAuthStuckComment(ctx, result.error || "Authentication failure detected in headless output");
        } else {
          // Use smart comment generator for error
          const comment = await generateComment({
            type: "error",
            error: result.error || "Unknown error",
            context: result.output.slice(-2000),
            prNumber: ctx.pr,
          });

          await github.postPRComment(ctx.owner, ctx.repoName, ctx.pr, comment.body);
          Metrics.recordGitHubApiCall("postPRComment", true);
        }
        Metrics.sessionEnded();
      }
    },
    { attributes: { "headless.operation": "execute" } }
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

/**
 * Post a GitHub comment notifying that the pod is stuck on Claude auth.
 */
async function postAuthStuckComment(ctx: PRContext, details: string): Promise<void> {
  const podName = process.env.POD_NAME || "unknown";
  const timestamp = new Date().toISOString();

  const body = [
    `**Claude Code authentication failure**`,
    ``,
    `The pod is stuck on the Claude Code login/authentication screen and cannot process commands.`,
    ``,
    `**Details:** ${details.slice(0, 500)}`,
    ``,
    `**Action required:**`,
    `1. Verify the \`CLAUDE_CODE_OAUTH_TOKEN\` secret is set and not expired`,
    `2. Refresh the token if needed:`,
    `   \`\`\`bash`,
    `   kubectl create secret generic gwa-secrets \\`,
    `     --from-literal=claude-oauth-token=<new-token> \\`,
    `     --dry-run=client -o yaml | kubectl apply -f -`,
    `   \`\`\``,
    `3. Restart the pod: \`kubectl rollout restart statefulset gwa-runner\``,
    ``,
    `*Pod: \`${podName}\` | Detected at: ${timestamp}*`,
  ].join("\n");

  try {
    await github.postPRComment(ctx.owner, ctx.repoName, ctx.pr, body);
    Metrics.recordGitHubApiCall("postPRComment.authError", true);
  } catch (commentError) {
    log("error", "Failed to post auth error comment", {
      pr: ctx.pr,
      error: commentError instanceof Error ? commentError.message : String(commentError),
    });
  }
}

main();
