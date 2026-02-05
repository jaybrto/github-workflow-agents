#!/usr/bin/env bun
import { parseArgs } from "util";
import * as redis from "./lib/redis.js";
import * as tmux from "./lib/tmux.js";

interface HealthStatus {
  healthy: boolean;
  timestamp: string;
  checks: {
    redis: { ok: boolean; latencyMs?: number; error?: string };
    tmux: { ok: boolean; sessionExists: boolean; windowCount?: number; error?: string };
    worktrees: { ok: boolean; count?: number; error?: string };
  };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      json: { type: "boolean" },
    },
  });

  const outputJson = values.json || false;
  const status = await runHealthChecks();

  if (outputJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    printStatus(status);
  }

  await redis.closeRedis();
  process.exit(status.healthy ? 0 : 1);
}

async function runHealthChecks(): Promise<HealthStatus> {
  const status: HealthStatus = {
    healthy: true,
    timestamp: new Date().toISOString(),
    checks: {
      redis: { ok: false },
      tmux: { ok: false, sessionExists: false },
      worktrees: { ok: false },
    },
  };

  // Check Redis
  try {
    const start = performance.now();
    const client = redis.getRedisClient();
    const pong = await client.ping();
    const latencyMs = Math.round(performance.now() - start);

    if (pong === "PONG") {
      status.checks.redis = { ok: true, latencyMs };
    } else {
      status.checks.redis = { ok: false, error: `Unexpected response: ${pong}` };
      status.healthy = false;
    }
  } catch (error) {
    status.checks.redis = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    status.healthy = false;
  }

  // Check tmux session
  try {
    await tmux.ensureSession();
    const windowIndex = await tmux.getNextWindowIndex();

    status.checks.tmux = {
      ok: true,
      sessionExists: true,
      windowCount: windowIndex, // Next index = current count
    };
  } catch (error) {
    status.checks.tmux = {
      ok: false,
      sessionExists: false,
      error: error instanceof Error ? error.message : String(error),
    };
    status.healthy = false;
  }

  // Check worktrees directory
  try {
    const proc = Bun.spawn(["ls", "-1", "/home/runner/worktrees"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode === 0) {
      const worktrees = stdout.trim().split("\n").filter(Boolean);
      status.checks.worktrees = { ok: true, count: worktrees.length };
    } else {
      // Directory might not exist yet, which is OK
      status.checks.worktrees = { ok: true, count: 0 };
    }
  } catch (error) {
    status.checks.worktrees = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    // Don't mark unhealthy - worktrees might just be empty
  }

  return status;
}

function printStatus(status: HealthStatus): void {
  console.log("=== GWA Health Check ===\n");
  console.log(`Timestamp: ${status.timestamp}`);
  console.log(`Overall: ${status.healthy ? "HEALTHY" : "UNHEALTHY"}\n`);

  console.log("--- Redis ---");
  if (status.checks.redis.ok) {
    console.log(`  Status: OK`);
    console.log(`  Latency: ${status.checks.redis.latencyMs}ms`);
  } else {
    console.log(`  Status: FAILED`);
    console.log(`  Error: ${status.checks.redis.error}`);
  }

  console.log("\n--- Tmux ---");
  if (status.checks.tmux.ok) {
    console.log(`  Status: OK`);
    console.log(`  Session exists: ${status.checks.tmux.sessionExists}`);
    console.log(`  Window count: ${status.checks.tmux.windowCount}`);
  } else {
    console.log(`  Status: FAILED`);
    console.log(`  Error: ${status.checks.tmux.error}`);
  }

  console.log("\n--- Worktrees ---");
  if (status.checks.worktrees.ok) {
    console.log(`  Status: OK`);
    console.log(`  Count: ${status.checks.worktrees.count}`);
  } else {
    console.log(`  Status: FAILED`);
    console.log(`  Error: ${status.checks.worktrees.error}`);
  }

  console.log();
}

main();
