/**
 * Swarm Architecture - Architect + Worker Pattern
 *
 * Manages a swarm of Claude agents:
 * - Architect (window 1): Creates plans, spawns workers, aggregates results
 * - Workers (windows 2-N): Execute assigned tasks, report progress
 *
 * All agents share the same tmux session but different windows.
 */

import { getDatabase, logActivity, getSession } from "./db.js";
import * as tmux from "./tmux.js";
import { withSpan, Metrics, log } from "./telemetry.js";
import { getAccessToken, tryRecoverCredentials, isCredentialExpired, provisionFromOrchestrator } from "./credentials-manager.js";
import { preloadClaudeConfig, detectAuthFailure } from "./claude.js";
import { handleDialogIfPresent } from "./dialog-handler.js";
import {
  getProject,
  getProjectItem,
  updateSessionFields,
} from "./projects.js";
import { generateComment, type GeneratedComment } from "./comment-generator.js";
import { getOctokit } from "./github.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentTask {
  id: string;
  sessionId: string;
  agentType: "architect" | "worker";
  taskId: string; // From plan (e.g., "task-001")
  name: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  tmuxWindow: number;
  skills: string[];
  scope: {
    files: string[];
    description: string;
  };
  dependencies: {
    blockedBy: string[];
    blocks: string[];
  };
  validation: string[];
  progress: number; // 0-100
  result?: {
    success: boolean;
    filesCreated: string[];
    filesModified: string[];
    summary: string;
    error?: string;
  };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface SwarmSession {
  id: string;
  issueNumber: number;
  repo: string;
  phase: "planning" | "implementation" | "qa" | "review";
  architectWindow: number;
  workerWindows: number[];
  activeTasks: string[];
  completedTasks: string[];
  blockedTasks: string[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkerSpawnConfig {
  taskId: string;
  name: string;
  description: string;
  skills: string[];
  scope: {
    files: string[];
    description: string;
  };
  dependencies: {
    blockedBy: string[];
    blocks: string[];
  };
  validation: string[];
  workingDir: string;
}

// ============================================================================
// Sub-Agent Tracking (Phase 15 v3.4)
// ============================================================================

/**
 * Update the Sub Agents Used field in GitHub Projects when a worker is spawned.
 */
async function updateSubAgentsUsed(
  sessionId: string,
  repo: string,
  agentName: string
): Promise<void> {
  try {
    const session = getSession(sessionId);
    if (!session?.project_item_id) {
      log("debug", "No project item ID found, skipping sub-agent update", { sessionId });
      return;
    }

    const [owner] = repo.split("/");
    const projectNumber = parseInt(process.env.GWA_PROJECT_NUMBER || "1", 10);

    const project = await getProject(owner, projectNumber);
    const projectItem = await getProjectItem(owner, repo.split("/")[1], session.github_number, project.id);

    if (!projectItem) {
      log("debug", "Project item not found", { sessionId });
      return;
    }

    // Get current sub-agents list
    const currentField = projectItem.fieldValues.find(
      (f) => f.fieldName === "Sub Agents Used"
    );
    const currentAgents = currentField?.value as string || "";

    // Append new agent name
    const agentsList = currentAgents
      ? `${currentAgents}, ${agentName}`
      : agentName;

    await updateSessionFields(project, session.project_item_id, {
      subAgentsUsed: agentsList,
    });

    log("info", "Updated sub-agents tracking", { sessionId, agents: agentsList });
  } catch (error) {
    log("warn", "Failed to update sub-agents tracking", {
      sessionId,
      error: String(error),
    });
  }
}

/**
 * Post a progress comment when a worker is spawned.
 */
async function postWorkerSpawnComment(
  sessionId: string,
  repo: string,
  workerName: string,
  taskId: string
): Promise<void> {
  try {
    const session = getSession(sessionId);
    if (!session) {
      return;
    }

    const [owner, repoName] = repo.split("/");
    const octokit = getOctokit();

    const comment = await generateComment({
      type: "progress",
      sessionId,
      message: `🚀 Spawned worker agent: **${workerName}** (Task: ${taskId})`,
      subAgents: [workerName],
      currentTask: taskId,
    });

    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: session.github_number,
      body: comment.body,
    });

    log("debug", "Posted worker spawn comment", { sessionId, workerName, taskId });
  } catch (error) {
    log("warn", "Failed to post worker spawn comment", {
      sessionId,
      error: String(error),
    });
  }
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Create the agent_tasks table if it doesn't exist.
 */
export function ensureAgentTasksTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      tmux_window INTEGER,
      skills TEXT,
      scope TEXT,
      dependencies TEXT,
      validation TEXT,
      progress INTEGER DEFAULT 0,
      result TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
  `);
}

/**
 * Create a new agent task.
 */
export function createAgentTask(task: Omit<AgentTask, "createdAt">): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO agent_tasks (
      id, session_id, agent_type, task_id, name, description, status,
      tmux_window, skills, scope, dependencies, validation, progress,
      result, created_at, started_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?)`,
    [
      task.id,
      task.sessionId,
      task.agentType,
      task.taskId,
      task.name,
      task.description,
      task.status,
      task.tmuxWindow,
      JSON.stringify(task.skills),
      JSON.stringify(task.scope),
      JSON.stringify(task.dependencies),
      JSON.stringify(task.validation),
      task.progress,
      task.result ? JSON.stringify(task.result) : null,
      task.startedAt || null,
      task.completedAt || null,
    ]
  );
}

/**
 * Get a task by ID.
 */
export function getAgentTask(taskId: string): AgentTask | null {
  const db = getDatabase();
  const row = db.query(`SELECT * FROM agent_tasks WHERE id = ?`).get(taskId) as Record<
    string,
    unknown
  > | null;

  if (!row) return null;

  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    agentType: row.agent_type as "architect" | "worker",
    taskId: row.task_id as string,
    name: row.name as string,
    description: row.description as string,
    status: row.status as AgentTask["status"],
    tmuxWindow: row.tmux_window as number,
    skills: JSON.parse((row.skills as string) || "[]"),
    scope: JSON.parse((row.scope as string) || "{}"),
    dependencies: JSON.parse((row.dependencies as string) || "{}"),
    validation: JSON.parse((row.validation as string) || "[]"),
    progress: row.progress as number,
    result: row.result ? JSON.parse(row.result as string) : undefined,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | undefined,
    completedAt: row.completed_at as number | undefined,
  };
}

/**
 * Update task status and progress.
 */
export function updateAgentTaskStatus(
  taskId: string,
  status: AgentTask["status"],
  progress?: number,
  result?: AgentTask["result"]
): void {
  const db = getDatabase();

  let sql = `UPDATE agent_tasks SET status = ?`;
  const params: (string | number | null)[] = [status];

  if (progress !== undefined) {
    sql += `, progress = ?`;
    params.push(progress);
  }

  if (result) {
    sql += `, result = ?`;
    params.push(JSON.stringify(result));
  }

  if (status === "in_progress") {
    sql += `, started_at = COALESCE(started_at, unixepoch())`;
  } else if (status === "completed" || status === "failed") {
    sql += `, completed_at = unixepoch()`;
  }

  sql += ` WHERE id = ?`;
  params.push(taskId);

  db.run(sql, params);
}

/**
 * Get all tasks for a session.
 */
export function getSessionTasks(sessionId: string): AgentTask[] {
  const db = getDatabase();
  const rows = db.query(`SELECT * FROM agent_tasks WHERE session_id = ?`).all(sessionId) as Array<
    Record<string, unknown>
  >;

  return rows.map((row) => ({
    id: row.id as string,
    sessionId: row.session_id as string,
    agentType: row.agent_type as "architect" | "worker",
    taskId: row.task_id as string,
    name: row.name as string,
    description: row.description as string,
    status: row.status as AgentTask["status"],
    tmuxWindow: row.tmux_window as number,
    skills: JSON.parse((row.skills as string) || "[]"),
    scope: JSON.parse((row.scope as string) || "{}"),
    dependencies: JSON.parse((row.dependencies as string) || "{}"),
    validation: JSON.parse((row.validation as string) || "[]"),
    progress: row.progress as number,
    result: row.result ? JSON.parse(row.result as string) : undefined,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | undefined,
    completedAt: row.completed_at as number | undefined,
  }));
}

/**
 * Get tasks ready to start (pending with no blocked dependencies).
 */
export function getReadyTasks(sessionId: string): AgentTask[] {
  const allTasks = getSessionTasks(sessionId);

  return allTasks.filter((task) => {
    if (task.status !== "pending") return false;

    // Check if all blocked_by tasks are completed
    const blockedBy = task.dependencies.blockedBy || [];
    if (blockedBy.length === 0) return true;

    return blockedBy.every((depId) => {
      const depTask = allTasks.find((t) => t.taskId === depId);
      return depTask?.status === "completed";
    });
  });
}

// ============================================================================
// Swarm Operations
// ============================================================================

/**
 * Create a new swarm session for an issue.
 */
export async function createSwarmSession(
  issueNumber: number,
  repo: string,
  phase: SwarmSession["phase"]
): Promise<SwarmSession> {
  return withSpan("swarm.createSession", async (span) => {
    span.setAttribute("swarm.issue", issueNumber);
    span.setAttribute("swarm.phase", phase);

    // Ensure tables exist
    ensureAgentTasksTable();

    // Pre-load Claude config to prevent first-run dialogs
    preloadClaudeConfig();

    // Pre-flight credential check: recover from MinIO if expired
    if (isCredentialExpired()) {
      log("info", "Credentials expired, attempting orchestrator provision");
      const provisioned = await provisionFromOrchestrator();
      if (!provisioned) {
        log("info", "Orchestrator provision failed, trying MinIO recovery");
        const recovered = await tryRecoverCredentials();
        if (recovered) {
          preloadClaudeConfig();
          log("info", "Credentials restored from MinIO before swarm start");
        } else {
          log("warn", "No valid credentials available - workers may fail auth");
        }
      } else {
        preloadClaudeConfig();
        log("info", "Credentials provisioned from orchestrator before swarm start");
      }
    }

    // Propagate auth env vars into the tmux session so new windows inherit them
    const oauthToken = getAccessToken() || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      await tmux.setEnvironment("CLAUDE_CODE_OAUTH_TOKEN", oauthToken);
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      await tmux.setEnvironment("ANTHROPIC_API_KEY", apiKey);
    }

    // Warmup: prime the TUI auth state by running a single Claude --print call.
    // After pod restart, the first TUI launch always hits the OAuth browser flow.
    // A --print call with the OAuth token forces credential validation and caching
    // so that subsequent TUI launches authenticate correctly.
    try {
      log("info", "Running Claude auth warmup (--print)");
      const proc = Bun.spawn(
        ["claude", "--print", "--dangerously-skip-permissions", "echo warmup"],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthToken || "" },
        }
      );
      const timeoutPromise = Bun.sleep(15000).then(() => {
        proc.kill();
        return "timeout";
      });
      const exitPromise = proc.exited.then(() => "done");
      const result = await Promise.race([exitPromise, timeoutPromise]);
      log("info", "Claude auth warmup complete", { result });
    } catch (e) {
      log("warn", "Claude auth warmup failed, continuing", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Create tmux window for architect
    const architectWindow = await tmux.createWindow(
      `issue-${issueNumber}-architect`,
      `/home/runner/worktrees/issue-${issueNumber}`
    );

    const session: SwarmSession = {
      id: `issue-${issueNumber}`,
      issueNumber,
      repo,
      phase,
      architectWindow,
      workerWindows: [],
      activeTasks: [],
      completedTasks: [],
      blockedTasks: [],
      createdAt: Date.now(),
    };

    logActivity(session.id, "swarm_created", { phase, architectWindow }, "workflow");
    log("info", "Swarm session created", { issueNumber, phase, architectWindow });

    return session;
  });
}

/**
 * Spawn a worker agent for a specific task.
 */
export async function spawnWorker(
  session: SwarmSession,
  config: WorkerSpawnConfig
): Promise<number> {
  return withSpan("swarm.spawnWorker", async (span) => {
    span.setAttribute("swarm.task_id", config.taskId);
    span.setAttribute("swarm.task_name", config.name);

    // Check if dependencies are satisfied
    const blockedBy = config.dependencies.blockedBy || [];
    if (blockedBy.length > 0) {
      const tasks = getSessionTasks(session.id);
      const unsatisfied = blockedBy.filter((depId) => {
        const depTask = tasks.find((t) => t.taskId === depId);
        return depTask?.status !== "completed";
      });

      if (unsatisfied.length > 0) {
        throw new Error(`Task ${config.taskId} is blocked by: ${unsatisfied.join(", ")}`);
      }
    }

    // Create tmux window for worker
    const windowName = `issue-${session.issueNumber}-${config.taskId}`;
    const workerWindow = await tmux.createWindow(windowName, config.workingDir);

    session.workerWindows.push(workerWindow);

    // Create task record
    const taskId = `${session.id}-${config.taskId}`;
    createAgentTask({
      id: taskId,
      sessionId: session.id,
      agentType: "worker",
      taskId: config.taskId,
      name: config.name,
      description: config.description,
      status: "pending",
      tmuxWindow: workerWindow,
      skills: config.skills,
      scope: config.scope,
      dependencies: config.dependencies,
      validation: config.validation,
      progress: 0,
    });

    logActivity(session.id, "worker_spawned", { taskId: config.taskId, window: workerWindow }, "architect");
    log("info", "Worker spawned", { taskId: config.taskId, window: workerWindow });

    Metrics.recordSwarmWorker("spawned");

    // Phase 15 (v3.4) - Update sub-agents tracking in GitHub Projects
    await updateSubAgentsUsed(session.id, session.repo, config.name);

    // Post progress comment about worker spawn
    await postWorkerSpawnComment(session.id, session.repo, config.name, config.taskId);

    return workerWindow;
  });
}

/**
 * Build the prompt for a worker agent.
 */
export function buildWorkerPrompt(config: WorkerSpawnConfig): string {
  const skillCommands = config.skills.map((s) => `/${s}`).join(", ");

  return `You are a worker agent assigned to complete a specific task.

## Your Task
**Task ID:** ${config.taskId}
**Name:** ${config.name}

## Description
${config.description}

## Scope
**Files to work on:**
${config.scope.files.map((f) => `- ${f}`).join("\n")}

**Details:**
${config.scope.description}

## Available Skills
${skillCommands}

## Validation Criteria
When you're done, verify:
${config.validation.map((v, i) => `${i + 1}. ${v}`).join("\n")}

## Dependencies
${config.dependencies.blockedBy.length > 0 ? `This task depends on: ${config.dependencies.blockedBy.join(", ")}` : "No dependencies - you can start immediately."}

## Instructions
1. Focus ONLY on your assigned task
2. Do NOT modify files outside your scope unless absolutely necessary
3. Run validation steps before marking complete
4. Report progress by calling \`gwa-update-task --progress <0-100>\`
5. When complete, call \`gwa-complete-task --result "summary of what you did"\`

Begin working on your task now.`;
}

/**
 * Send a command to a worker window.
 */
export async function sendToWorker(
  window: number,
  command: string
): Promise<void> {
  return withSpan("swarm.sendToWorker", async (span) => {
    span.setAttribute("swarm.window", window);

    await tmux.sendCommand(window, command);
    log("debug", "Sent command to worker", { window });
  });
}

/**
 * Start a worker with Claude REPL.
 */
export async function startWorker(
  session: SwarmSession,
  config: WorkerSpawnConfig
): Promise<void> {
  return withSpan("swarm.startWorker", async (span) => {
    span.setAttribute("swarm.task_id", config.taskId);

    const window = await spawnWorker(session, config);
    const prompt = buildWorkerPrompt(config);

    // Update task status
    const taskId = `${session.id}-${config.taskId}`;
    updateAgentTaskStatus(taskId, "in_progress");
    session.activeTasks.push(config.taskId);

    // Start Claude REPL in worker window
    // SECURITY: Write prompt to temp file to avoid shell injection via user-controlled content
    const promptFile = `/tmp/gwa-worker-prompt-${config.taskId}-${Date.now()}.md`;
    await Bun.write(promptFile, prompt);

    // Pre-load Claude config to prevent first-run dialogs
    preloadClaudeConfig();

    // Ensure worker window has a fresh OAuth token
    const freshToken = getAccessToken();
    if (freshToken) {
      await tmux.sendKeys(window, `export CLAUDE_CODE_OAUTH_TOKEN='${freshToken}'\n`);
      await Bun.sleep(200);
    }

    // Start Claude with auth retry loop using credential recovery
    const MAX_AUTH_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
      await sendToWorker(window, "claude --dangerously-skip-permissions");
      await Bun.sleep(3000);

      // Check if Claude is stuck on auth/login screen
      const paneText = await tmux.capturePane(window, 30);
      if (!detectAuthFailure(paneText)) {
        // Not on auth screen — handle any other dialogs and break
        await handleDialogIfPresent(window);
        break;
      }

      if (attempt >= MAX_AUTH_RETRIES) {
        log("error", "Worker could not get past auth screen after credential recovery", {
          taskId: config.taskId, window, attempts: MAX_AUTH_RETRIES,
        });
        break;
      }

      log("warn", "Worker hit auth screen, attempting credential recovery", {
        taskId: config.taskId, window, attempt,
      });

      // Kill stuck Claude, recover credentials, retry
      await tmux.sendKeys(window, "C-c");
      await Bun.sleep(500);
      await tmux.sendKeys(window, "C-c");
      await Bun.sleep(500);

      // Try orchestrator first, then MinIO fallback
      let recovered = await provisionFromOrchestrator();
      if (!recovered) {
        recovered = await tryRecoverCredentials();
      }

      if (recovered) {
        preloadClaudeConfig();
        // Re-export the fresh token to the tmux window
        const refreshedToken = getAccessToken();
        if (refreshedToken) {
          await tmux.sendKeys(window, `export CLAUDE_CODE_OAUTH_TOKEN='${refreshedToken}'\n`);
          await Bun.sleep(200);
        }
        // Also update tmux session-level env
        await tmux.setEnvironment("CLAUDE_CODE_OAUTH_TOKEN", refreshedToken || "");
        log("info", "Credentials recovered, retrying Claude start", {
          taskId: config.taskId, attempt: attempt + 1,
        });
      } else {
        log("error", "Credential recovery failed, retry may not succeed", {
          taskId: config.taskId,
        });
      }
      await Bun.sleep(1000);
    }

    // Send command to read the prompt file
    await sendToWorker(window, `Read ${promptFile} and follow the instructions.`);

    log("info", "Worker started", { taskId: config.taskId, window });
  });
}

/**
 * Check task completion and update session state.
 */
export async function checkTaskCompletion(session: SwarmSession): Promise<{
  completed: string[];
  inProgress: string[];
  blocked: string[];
  allDone: boolean;
}> {
  return withSpan("swarm.checkCompletion", async (span) => {
    const tasks = getSessionTasks(session.id);

    const completed = tasks.filter((t) => t.status === "completed").map((t) => t.taskId);
    const inProgress = tasks.filter((t) => t.status === "in_progress").map((t) => t.taskId);
    const blocked = tasks.filter((t) => t.status === "blocked").map((t) => t.taskId);
    const pending = tasks.filter((t) => t.status === "pending");

    session.completedTasks = completed;
    session.activeTasks = inProgress;
    session.blockedTasks = blocked;

    const allDone = pending.length === 0 && inProgress.length === 0 && blocked.length === 0;

    span.setAttribute("swarm.completed", completed.length);
    span.setAttribute("swarm.in_progress", inProgress.length);
    span.setAttribute("swarm.blocked", blocked.length);
    span.setAttribute("swarm.all_done", allDone);

    return { completed, inProgress, blocked, allDone };
  });
}

/**
 * Start all ready tasks (parallel execution).
 */
export async function startReadyTasks(
  session: SwarmSession,
  workingDir: string,
  taskConfigs: WorkerSpawnConfig[]
): Promise<void> {
  return withSpan("swarm.startReadyTasks", async (span) => {
    const readyTasks = getReadyTasks(session.id);

    span.setAttribute("swarm.ready_tasks", readyTasks.length);

    for (const task of readyTasks) {
      const config = taskConfigs.find((c) => c.taskId === task.taskId);
      if (config) {
        await startWorker(session, { ...config, workingDir });
      }
    }

    log("info", "Started ready tasks", {
      count: readyTasks.length,
      tasks: readyTasks.map((t) => t.taskId).join(","),
    });
  });
}

/**
 * Aggregate results from all completed workers.
 */
export function aggregateResults(session: SwarmSession): {
  success: boolean;
  filesCreated: string[];
  filesModified: string[];
  summary: string;
  errors: string[];
} {
  const tasks = getSessionTasks(session.id);
  const completed = tasks.filter((t) => t.status === "completed" && t.result);

  const filesCreated: string[] = [];
  const filesModified: string[] = [];
  const summaries: string[] = [];
  const errors: string[] = [];

  for (const task of completed) {
    if (task.result) {
      filesCreated.push(...(task.result.filesCreated || []));
      filesModified.push(...(task.result.filesModified || []));
      summaries.push(`**${task.name}:** ${task.result.summary}`);
      if (task.result.error) {
        errors.push(`${task.name}: ${task.result.error}`);
      }
    }
  }

  const failed = tasks.filter((t) => t.status === "failed");
  for (const task of failed) {
    errors.push(`${task.name}: Task failed`);
  }

  return {
    success: errors.length === 0,
    filesCreated: [...new Set(filesCreated)],
    filesModified: [...new Set(filesModified)],
    summary: summaries.join("\n"),
    errors,
  };
}

/**
 * Cleanup worker windows when session completes.
 */
export async function cleanupSwarm(session: SwarmSession): Promise<void> {
  return withSpan("swarm.cleanup", async (span) => {
    span.setAttribute("swarm.session_id", session.id);

    // Kill worker windows
    for (const window of session.workerWindows) {
      await tmux.killWindow(window);
    }

    // Keep architect window for summary
    logActivity(session.id, "swarm_cleanup", { workersKilled: session.workerWindows.length }, "workflow");
    log("info", "Swarm cleanup completed", {
      session: session.id,
      workersKilled: session.workerWindows.length,
    });

    Metrics.recordSwarmCleanup();
  });
}

export default {
  ensureAgentTasksTable,
  createAgentTask,
  getAgentTask,
  updateAgentTaskStatus,
  getSessionTasks,
  getReadyTasks,
  createSwarmSession,
  spawnWorker,
  buildWorkerPrompt,
  sendToWorker,
  startWorker,
  checkTaskCompletion,
  startReadyTasks,
  aggregateResults,
  cleanupSwarm,
};
