#!/usr/bin/env bun
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
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");

  console.log(`[GWA Cleanup] Starting cleanup for ${args.repo}`);
  console.log(`[GWA Cleanup] Dry run: ${args.dryRun}`);

  try {
    await cleanup(args, owner, repoName);
  } catch (error) {
    console.error("[GWA Cleanup] Fatal error:", error);
    process.exit(1);
  } finally {
    await redis.closeRedis();
  }
}

async function cleanup(
  args: CleanupArgs,
  owner: string,
  repoName: string
): Promise<void> {
  // Get all PR keys from Redis
  const allKeys = await redis.getAllPRKeys();
  console.log(`[GWA Cleanup] Found ${allKeys.length} PR keys in Redis`);

  // Filter to keys matching our repo
  const repoPattern = `pr:${args.repo}:`;
  const prKeys = allKeys.filter(
    (key) => key.startsWith(repoPattern) && !key.includes(":question")
  );

  console.log(`[GWA Cleanup] ${prKeys.length} keys match repo ${args.repo}`);

  let cleaned = 0;
  let skipped = 0;

  for (const key of prKeys) {
    // Extract PR number from key: pr:owner/repo:123
    const parts = key.split(":");
    const prNum = parseInt(parts[parts.length - 1], 10);

    if (isNaN(prNum)) {
      console.log(`[GWA Cleanup] Skipping invalid key: ${key}`);
      skipped++;
      continue;
    }

    // Check if PR is still open
    const isOpen = await github.isPROpen(owner, repoName, prNum);

    if (isOpen) {
      console.log(`[GWA Cleanup] PR #${prNum} is still open, skipping`);
      skipped++;
      continue;
    }

    console.log(`[GWA Cleanup] PR #${prNum} is closed, cleaning up...`);

    // Get session data before deleting
    const session = await redis.getSession(args.repo, prNum);

    if (args.dryRun) {
      console.log(`[GWA Cleanup] [DRY RUN] Would clean up PR #${prNum}`);
      if (session) {
        console.log(`[GWA Cleanup] [DRY RUN]   - Remove tmux window ${session.tmuxWindow}`);
        console.log(`[GWA Cleanup] [DRY RUN]   - Remove worktree ${session.worktreePath}`);
      }
      console.log(`[GWA Cleanup] [DRY RUN]   - Delete Redis keys`);
      cleaned++;
      continue;
    }

    // Clean up tmux window
    if (session && (await tmux.windowExists(session.tmuxWindow))) {
      try {
        await tmux.killWindow(session.tmuxWindow);
        console.log(`[GWA Cleanup]   Removed tmux window ${session.tmuxWindow}`);
      } catch (error) {
        console.log(`[GWA Cleanup]   Failed to remove tmux window: ${error}`);
      }
    }

    // Clean up git worktree
    try {
      await git.removeWorktree(prNum);
      console.log(`[GWA Cleanup]   Removed worktree for PR #${prNum}`);
    } catch (error) {
      console.log(`[GWA Cleanup]   Failed to remove worktree: ${error}`);
    }

    // Clean up Redis
    await redis.deletePRData(args.repo, prNum);
    console.log(`[GWA Cleanup]   Deleted Redis data for PR #${prNum}`);

    cleaned++;
  }

  console.log(`[GWA Cleanup] Complete: ${cleaned} cleaned, ${skipped} skipped`);
}

main();
