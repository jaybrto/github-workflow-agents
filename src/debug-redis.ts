#!/usr/bin/env bun
import { parseArgs } from "util";
import * as redis from "./lib/redis.js";

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      pod: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
  });

  const repo = positionals[0];
  const pod = values.pod || "gwa-runner-0";
  const outputJson = values.json || false;

  console.log("=== GWA Redis Debug ===\n");

  try {
    // Test connectivity
    const client = redis.getRedisClient();
    const pong = await client.ping();
    console.log(`Redis connectivity: ${pong === "PONG" ? "OK" : "FAILED"}\n`);

    // Get all PR keys
    const allKeys = await redis.getAllPRKeys();
    console.log(`Total PR keys: ${allKeys.length}\n`);

    // Filter by repo if specified
    const filteredKeys = repo
      ? allKeys.filter((k) => k.includes(repo))
      : allKeys;

    // Group by type
    const sessionKeys = filteredKeys.filter((k) => !k.includes(":question"));
    const questionKeys = filteredKeys.filter((k) => k.includes(":question"));

    console.log(`Session keys: ${sessionKeys.length}`);
    console.log(`Question keys: ${questionKeys.length}\n`);

    // List active PRs for pod
    const activePRs = await redis.getActivePRsForPod(pod);
    console.log(`Active PRs on ${pod}: ${activePRs.length}`);
    for (const pr of activePRs) {
      console.log(`  - ${pr}`);
    }
    console.log();

    // Show session details
    if (sessionKeys.length > 0) {
      console.log("=== Sessions ===\n");

      for (const key of sessionKeys.slice(0, 10)) {
        // Extract repo and PR from key: pr:owner/repo:123
        const parts = key.split(":");
        const prNum = parseInt(parts[parts.length - 1], 10);
        const keyRepo = parts.slice(1, -1).join(":");

        const session = await redis.getSession(keyRepo, prNum);

        if (outputJson) {
          console.log(JSON.stringify({ key, session }, null, 2));
        } else {
          console.log(`PR #${prNum} (${keyRepo})`);
          if (session) {
            console.log(`  Window: ${session.tmuxWindow}`);
            console.log(`  Status: ${session.status}`);
            console.log(`  Path: ${session.worktreePath}`);
            console.log(`  Pod: ${session.podName}`);
            console.log(
              `  Created: ${new Date(session.createdAt).toISOString()}`
            );
            console.log(
              `  Last Activity: ${new Date(session.lastActivity).toISOString()}`
            );
          }
          console.log();
        }
      }

      if (sessionKeys.length > 10) {
        console.log(`... and ${sessionKeys.length - 10} more sessions\n`);
      }
    }

    // Show questions
    if (questionKeys.length > 0) {
      console.log("=== Pending Questions ===\n");

      for (const key of questionKeys) {
        const parts = key.split(":");
        const prNum = parseInt(parts[parts.length - 2], 10);
        const keyRepo = parts.slice(1, -2).join(":");

        const question = await redis.getQuestion(keyRepo, prNum);

        if (outputJson) {
          console.log(JSON.stringify({ key, question }, null, 2));
        } else {
          console.log(`PR #${prNum} (${keyRepo})`);
          if (question) {
            console.log(
              `  Question: ${question.question.substring(0, 100)}...`
            );
            console.log(
              `  Asked: ${new Date(question.askedAt).toISOString()}`
            );
            if (question.answer) {
              console.log(
                `  Answer: ${question.answer.substring(0, 100)}...`
              );
              console.log(`  Answered by: ${question.answeredBy}`);
            } else {
              console.log("  Status: WAITING FOR ANSWER");
            }
          }
          console.log();
        }
      }
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    await redis.closeRedis();
  }
}

main();
