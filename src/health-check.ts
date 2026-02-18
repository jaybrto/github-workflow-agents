#!/usr/bin/env bun
import { parseArgs } from "util";
import * as db from "./lib/db.js";
import * as tmux from "./lib/tmux.js";

interface HealthStatus {
  healthy: boolean;
  timestamp: string;
  checks: {
    sqlite: { ok: boolean; integrityOk?: boolean; activeSessions?: number; error?: string };
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

  db.closeDatabase();
  process.exit(status.healthy ? 0 : 1);
}

async function runHealthChecks(): Promise<HealthStatus> {
  const status: HealthStatus = {
    healthy: true,
    timestamp: new Date().toISOString(),
    checks: {
      sqlite: { ok: false },
      tmux: { ok: false, sessionExists: false },
      worktrees: { ok: false },
    },
  };

  // Check SQLite
  try {
    const database = db.getDatabase();
    const integrityResult = database
      .query("PRAGMA integrity_check")
      .get() as { integrity_check: string } | null;

    const integrityOk = integrityResult?.integrity_check === "ok";
    const activeSessions = db.getActiveSessionCount();

    if (integrityOk) {
      status.checks.sqlite = { ok: true, integrityOk, activeSessions };
    } else {
      status.checks.sqlite = {
        ok: false,
        integrityOk: false,
        error: `Integrity check failed: ${integrityResult?.integrity_check}`,
      };
      status.healthy = false;
    }
  } catch (error) {
    status.checks.sqlite = {
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

  console.log("--- SQLite ---");
  if (status.checks.sqlite.ok) {
    console.log(`  Status: OK`);
    console.log(`  Integrity: ${status.checks.sqlite.integrityOk ? "OK" : "FAILED"}`);
    console.log(`  Active Sessions: ${status.checks.sqlite.activeSessions}`);
  } else {
    console.log(`  Status: FAILED`);
    console.log(`  Error: ${status.checks.sqlite.error}`);
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
