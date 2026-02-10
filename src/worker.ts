#!/usr/bin/env bun
/**
 * Worker Agent
 *
 * Executes assigned sub-tasks from the implementation plan.
 * Reports progress to the architect via SQLite.
 *
 * Usage:
 *   gwa-worker --task-id <id> --session <session-id>
 *
 * Environment:
 *   This is typically started by the architect agent via tmux.
 */

import { parseArgs } from "util";
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";
import * as swarm from "./lib/swarm.js";
import { logActivity } from "./lib/db.js";

interface WorkerArgs {
  taskId: string;
  session: string;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "task-id": { type: "string" },
      session: { type: "string" },
    },
  });

  const args: WorkerArgs = {
    taskId: values["task-id"] || "",
    session: values.session || "",
  };

  if (!args.taskId || !args.session) {
    console.error("Usage: gwa-worker --task-id <id> --session <session-id>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan(
      "worker",
      async (span) => {
        span.setAttribute("worker.task_id", args.taskId);
        span.setAttribute("worker.session", args.session);

        log("info", `Worker starting task ${args.taskId}`, {
          session: args.session,
        });

        await executeTask(args.taskId, args.session);
        success = true;

        log("info", "Worker completed task", {
          taskId: args.taskId,
          session: args.session,
        });
      },
      {
        attributes: {
          "gwa.operation": "worker",
          "worker.task_id": args.taskId,
        },
      }
    );
  } catch (error) {
    log("error", "Worker failed", {
      taskId: args.taskId,
      error: error instanceof Error ? error.message : String(error),
    });

    // Update task status to failed
    swarm.updateAgentTaskStatus(args.taskId, "failed", undefined, {
      success: false,
      filesCreated: [],
      filesModified: [],
      summary: "",
      error: error instanceof Error ? error.message : String(error),
    });

    Metrics.recordSwarmWorker("failed");
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

/**
 * Execute the assigned task.
 */
async function executeTask(taskId: string, sessionId: string): Promise<void> {
  return withSpan("worker.execute", async (span) => {
    // Get task details
    const task = swarm.getAgentTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    span.setAttribute("worker.task_name", task.name);

    // Update status to in_progress
    swarm.updateAgentTaskStatus(taskId, "in_progress");
    logActivity(sessionId, "worker_started", { taskId, name: task.name }, "worker");

    // Build and execute the task
    // In production, this would start Claude REPL with the task prompt
    // For now, we simulate execution
    const prompt = swarm.buildWorkerPrompt({
      taskId: task.taskId,
      name: task.name,
      description: task.description,
      skills: task.skills,
      scope: task.scope,
      dependencies: task.dependencies,
      validation: task.validation,
      workingDir: `/home/runner/worktrees/${sessionId.replace("issue-", "")}`,
    });

    console.log(`
=== Worker Task ===
Task ID: ${task.taskId}
Name: ${task.name}
Session: ${sessionId}

Description:
${task.description}

Files in scope:
${task.scope.files.map((f) => `  - ${f}`).join("\n")}

Validation criteria:
${task.validation.map((v, i) => `  ${i + 1}. ${v}`).join("\n")}

The worker would now start Claude REPL with the task prompt.
In production, this runs: claude --dangerously-skip-permissions -p "..."
`);

    // Simulate progress updates
    // In production, these would come from Claude via gwa-update-task calls
    for (let progress = 25; progress <= 100; progress += 25) {
      swarm.updateAgentTaskStatus(taskId, "in_progress", progress);
      log("debug", `Task progress: ${progress}%`, { taskId });
    }

    // Mark task complete
    swarm.updateAgentTaskStatus(taskId, "completed", 100, {
      success: true,
      filesCreated: [],
      filesModified: task.scope.files,
      summary: `Completed task: ${task.name}`,
    });

    logActivity(sessionId, "worker_completed", { taskId, name: task.name }, "worker");
    Metrics.recordSwarmWorker("completed");
  });
}

main();
