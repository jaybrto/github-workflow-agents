#!/usr/bin/env bun
// Telemetry MUST be imported first
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";

import { parseArgs } from "util";
import type { CleanupArgs } from "./lib/types.js";
import * as redis from "./lib/redis.js";
import * as github from "./lib/github.js";
import * as tmux from "./lib/tmux.js";
import * as git from "./lib/git.js";

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      repo: { type: "string" },
      pod: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });

  const args: CleanupArgs = {
    repo: values.repo || "",
    pod: values.pod || "gwa-runner-0",
    dryRun: values["dry-run"] || false,
  };

  if (!args.repo) {
    console.error("Usage: gwa-cleanup --repo <owner/repo> [--pod <pod>] [--dry-run]");
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  let cleanedCount = 0;

  try {
    cleanedCount = await withSpan(
      "cleanup",
      async (span) => {
        span.setAttribute("cleanup.repo", args.repo);
        span.setAttribute("cleanup.dryRun", args.dryRun ?? false);

        log("info", `Starting cleanup for ${args.repo}`, {
          dryRun: args.dryRun ?? false,
        });

        return await cleanup(args, owner, repoName);
      },
      {
        attributes: {
          "gwa.operation": "cleanup",
          "cleanup.repo": args.repo,
          "cleanup.dryRun": args.dryRun ?? false,
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
    await redis.closeRedis();
    await shutdownTelemetry();
  }

  process.exit(0);
}

async function cleanup(
  args: CleanupArgs,
  owner: string,
  repoName: string
): Promise<number> {
  // Get all PR keys from Redis
  const allKeys = await withSpan("redis.getAllPRKeys", async () => {
    const keys = await redis.getAllPRKeys();
    Metrics.recordRedisOperation("getAllPRKeys", true);
    return keys;
  });

  log("info", `Found ${allKeys.length} PR keys in Redis`);

  // Filter to keys matching our repo
  const repoPattern = `pr:${args.repo}:`;
  const prKeys = allKeys.filter(
    (key) => key.startsWith(repoPattern) && !key.includes(":question")
  );

  log("info", `${prKeys.length} keys match repo ${args.repo}`);

  let cleaned = 0;
  let skipped = 0;

  for (const key of prKeys) {
    // Extract PR number from key: pr:owner/repo:123
    const parts = key.split(":");
    const prNum = parseInt(parts[parts.length - 1], 10);

    if (isNaN(prNum)) {
      log("debug", `Skipping invalid key: ${key}`);
      skipped++;
      continue;
    }

    // Check if PR is still open
    const isOpen = await withSpan(
      "github.isPROpen",
      async () => {
        const open = await github.isPROpen(owner, repoName, prNum);
        Metrics.recordGitHubApiCall("isPROpen", true);
        return open;
      },
      { attributes: { "pr.number": prNum } }
    );

    if (isOpen) {
      log("debug", `PR #${prNum} is still open, skipping`);
      skipped++;
      continue;
    }

    log("info", `PR #${prNum} is closed, cleaning up`);

    // Get session data before deleting
    const session = await redis.getSession(args.repo, prNum);

    if (args.dryRun) {
      log("info", `[DRY RUN] Would clean up PR #${prNum}`, {
        tmuxWindow: session?.tmuxWindow ?? -1,
        worktreePath: session?.worktreePath ?? "unknown",
      });
      cleaned++;
      continue;
    }

    await withSpan(
      "cleanupPR",
      async (span) => {
        span.setAttribute("pr.number", prNum);

        // Clean up tmux window
        if (session && (await tmux.windowExists(session.tmuxWindow))) {
          try {
            await tmux.killWindow(session.tmuxWindow);
            log("debug", `Removed tmux window ${session.tmuxWindow}`);
          } catch (error) {
            log("warn", `Failed to remove tmux window: ${error}`);
          }
        }

        // Clean up git worktree
        try {
          await git.removeWorktree(prNum);
          log("debug", `Removed worktree for PR #${prNum}`);
        } catch (error) {
          log("warn", `Failed to remove worktree: ${error}`);
        }

        // Clean up Redis
        await redis.deletePRData(args.repo, prNum);
        Metrics.recordRedisOperation("deletePRData", true);
        log("debug", `Deleted Redis data for PR #${prNum}`);

        Metrics.sessionEnded();
      },
      { attributes: { "cleanup.pr": prNum } }
    );

    cleaned++;
  }

  log("info", `Cleanup complete: ${cleaned} cleaned, ${skipped} skipped`);

  return cleaned;
}

main();
