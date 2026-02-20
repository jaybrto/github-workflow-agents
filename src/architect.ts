#!/usr/bin/env bun
/**
 * Architect Agent
 *
 * Creates implementation plans from issues, spawns workers for parallel execution,
 * and aggregates results. Runs in tmux window 1 of the swarm session.
 *
 * Usage:
 *   gwa-architect --issue <number> --repo <owner/repo> --phase <planning|implementation>
 */

import { parseArgs } from "util";
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";
import * as github from "./lib/github.js";
import * as git from "./lib/git.js";
import * as swarm from "./lib/swarm.js";
import * as projects from "./lib/projects.js";
import * as planSync from "./lib/plan-sync.js";
import { getDatabase, logActivity } from "./lib/db.js";
import { readFileSync, existsSync } from "fs";

interface ArchitectArgs {
  issue: number;
  repo: string;
  phase: "planning" | "implementation";
  projectNumber?: number;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
      phase: { type: "string" },
      "project-number": { type: "string" },
    },
  });

  const args: ArchitectArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
    phase: (values.phase as ArchitectArgs["phase"]) || "planning",
    projectNumber: values["project-number"] ? parseInt(values["project-number"], 10) : 1,
  };

  if (!args.issue || !args.repo) {
    console.error("Usage: gwa-architect --issue <number> --repo <owner/repo> --phase <planning|implementation>");
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");
  let success = false;

  try {
    await withSpan(
      "architect",
      async (span) => {
        span.setAttribute("architect.issue", args.issue);
        span.setAttribute("architect.repo", args.repo);
        span.setAttribute("architect.phase", args.phase);

        log("info", `Architect starting for issue #${args.issue}`, {
          repo: args.repo,
          phase: args.phase,
        });

        if (args.phase === "planning") {
          await runPlanningPhase(owner, repoName, args.issue, args.projectNumber!);
        } else {
          await runImplementationPhase(owner, repoName, args.issue, args.projectNumber!);
        }

        success = true;
        log("info", "Architect completed", { issue: args.issue, phase: args.phase });
      },
      {
        attributes: {
          "gwa.operation": "architect",
          "architect.issue": args.issue,
        },
      }
    );
  } catch (error) {
    log("error", "Architect failed", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });

    await github.postError(
      owner,
      repoName,
      args.issue,
      "Architect failed",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

/**
 * Planning Phase: Analyze issue and create implementation plan.
 */
async function runPlanningPhase(
  owner: string,
  repo: string,
  issueNumber: number,
  projectNumber: number
): Promise<void> {
  return withSpan("architect.planning", async (span) => {
    span.setAttribute("architect.phase", "planning");

    // 1. Create swarm session
    const session = await swarm.createSwarmSession(issueNumber, `${owner}/${repo}`, "planning");

    // 2. Get issue details
    const octokit = github.getOctokit();
    const { data: issue } = await octokit.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    log("info", "Analyzing issue", { title: issue.title });

    // 3. Setup worktree for the issue
    const branchName = `claude/issue-${issueNumber}`;
    await git.fetchAll();

    let worktreePath: string;
    const issueWorktreePath = git.getIssueWorktreePath(issueNumber);
    if (existsSync(issueWorktreePath)) {
      worktreePath = issueWorktreePath;
    } else if (await git.worktreeExists(issueNumber)) {
      await git.updateWorktree(issueNumber, branchName);
      worktreePath = git.getWorktreePath(issueNumber);
    } else {
      worktreePath = await git.createWorktree(issueNumber, branchName);
    }

    // 4. Create plan directory
    const planDir = `${worktreePath}/.plans/issue-${issueNumber}`;
    await Bun.write(`${planDir}/.gitkeep`, "");

    // 5. Build planning prompt
    const planningPrompt = buildPlanningPrompt(issue.title, issue.body || "", issueNumber);

    // 6. Start Claude REPL in architect window to create plan
    // The architect will:
    // - Analyze the issue requirements
    // - Create plan.md with task breakdown
    // - Create other plan files (decisions.md, snippets.md, etc.)
    // - Post plan summary to GitHub
    // - Update project item with plan metadata

    log("info", "Architect ready to create plan", {
      issueNumber,
      worktreePath,
      planDir,
    });

    // Note: In production, this would start Claude REPL with the prompt
    // For now, we log what would happen
    console.log(`
=== Planning Phase ===
Issue: #${issueNumber} - ${issue.title}
Worktree: ${worktreePath}
Plan Dir: ${planDir}

Claude will be prompted to:
1. Analyze issue requirements
2. Create implementation plan in ${planDir}/plan.md
3. Break down into parallelizable tasks
4. Post plan summary to GitHub issue

Architect window: ${session.architectWindow}
`);

    logActivity(session.id, "planning_started", { issueNumber, worktreePath }, "architect");
  });
}

/**
 * Implementation Phase: Spawn workers to execute plan tasks.
 */
async function runImplementationPhase(
  owner: string,
  repo: string,
  issueNumber: number,
  projectNumber: number
): Promise<void> {
  return withSpan("architect.implementation", async (span) => {
    span.setAttribute("architect.phase", "implementation");

    // 1. Get or create swarm session
    const session = await swarm.createSwarmSession(issueNumber, `${owner}/${repo}`, "implementation");

    // 2. Load plan file — check issue worktree first (start-planning uses issue-{N}),
    //    then fall back to pr-{N} worktree
    const issueWorktreePath = git.getIssueWorktreePath(issueNumber);
    const prWorktreePath = git.getWorktreePath(issueNumber);
    const worktreePath = existsSync(`${issueWorktreePath}/.plans/issue-${issueNumber}/plan.md`)
      ? issueWorktreePath
      : prWorktreePath;
    const planPath = `${worktreePath}/.plans/issue-${issueNumber}/plan.md`;

    if (!existsSync(planPath)) {
      throw new Error(`Plan file not found: ${planPath}. Run planning phase first.`);
    }

    const planContent = readFileSync(planPath, "utf-8");
    let tasks = parsePlanTasks(planContent);

    // If plan.md didn't yield tasks, try tasks.md (Claude often writes tasks in a separate file)
    if (tasks.length === 0) {
      const tasksPath = `${worktreePath}/.plans/issue-${issueNumber}/tasks.md`;
      if (existsSync(tasksPath)) {
        const tasksContent = readFileSync(tasksPath, "utf-8");
        tasks = parsePlanTasks(tasksContent);
        log("info", "Fell back to tasks.md for task parsing", { taskCount: tasks.length });
      }
    }

    log("info", "Loaded plan with tasks", { taskCount: tasks.length });

    // 3. Create task records in database
    for (const task of tasks) {
      swarm.createAgentTask({
        id: `${session.id}-${task.taskId}`,
        sessionId: session.id,
        agentType: "worker",
        taskId: task.taskId,
        name: task.name,
        description: task.description,
        status: "pending",
        tmuxWindow: 0, // Will be assigned when spawned
        skills: task.skills,
        scope: task.scope,
        dependencies: task.dependencies,
        validation: task.validation,
        progress: 0,
      });
    }

    // 4. Start tasks that have no dependencies (parallel execution)
    const taskConfigs: swarm.WorkerSpawnConfig[] = tasks.map((t) => ({
      ...t,
      workingDir: worktreePath,
    }));

    await swarm.startReadyTasks(session, worktreePath, taskConfigs);

    // 5. Monitor and start remaining tasks as dependencies complete
    // In production, this would poll and spawn new workers
    // For now, we log the execution plan

    console.log(`
=== Implementation Phase ===
Issue: #${issueNumber}
Worktree: ${worktreePath}
Total Tasks: ${tasks.length}

Tasks to execute:
${tasks.map((t) => `  - ${t.taskId}: ${t.name} (blocked by: ${t.dependencies.blockedBy.join(", ") || "none"})`).join("\n")}

Architect window: ${session.architectWindow}
Worker windows will be created for each task.
`);

    logActivity(session.id, "implementation_started", { taskCount: tasks.length }, "architect");
  });
}

/**
 * Build the planning prompt for Claude.
 */
function buildPlanningPrompt(title: string, body: string, issueNumber: number): string {
  return `You are an architect agent creating an implementation plan for a GitHub issue.

## Issue to Plan
**Issue #${issueNumber}:** ${title}

${body}

## Your Task
Create a comprehensive implementation plan by:

1. **Analyze Requirements**
   - Extract functional requirements from the issue
   - Identify non-functional requirements (performance, security)
   - Define acceptance criteria

2. **Design Solution**
   - Determine files to create/modify
   - Identify architectural patterns to use
   - Consider dependencies and integration points

3. **Break Down into Tasks**
   - Create 3-7 parallelizable tasks
   - Define task dependencies (DAG)
   - Assign skills to each task
   - Estimate complexity and hours

4. **Write Plan Files**
   Create these files in \`.plans/issue-${issueNumber}/\`:
   - \`plan.md\` - Full implementation plan (use template)
   - \`checklist.md\` - Progress tracking
   - \`decisions.md\` - Design decisions and Q&A log
   - \`snippets.md\` - Relevant code context

5. **Post Summary**
   When planning is complete, the plan will be synced to GitHub.

## Important Guidelines
- Each task should be completable by a single worker agent
- Tasks should have clear scope (specific files)
- Validation criteria must be testable
- Consider parallel execution opportunities

Begin analyzing the issue and creating the implementation plan.`;
}

/**
 * Parse tasks from plan.md content.
 */
function parsePlanTasks(planContent: string): Array<{
  taskId: string;
  name: string;
  description: string;
  skills: string[];
  scope: { files: string[]; description: string };
  dependencies: { blockedBy: string[]; blocks: string[] };
  validation: string[];
}> {
  const tasks: Array<{
    taskId: string;
    name: string;
    description: string;
    skills: string[];
    scope: { files: string[]; description: string };
    dependencies: { blockedBy: string[]; blocks: string[] };
    validation: string[];
  }> = [];

  // Strategy 1: YAML-block format (#### Task N: Name + ```yaml```)
  const taskMatches = planContent.matchAll(/#### Task \d+: (.+?)\n\n```yaml\n([\s\S]*?)```/g);

  for (const match of taskMatches) {
    const name = match[1];
    const yaml = match[2];

    const taskId = extractYamlValue(yaml, "task_id") || `task-${tasks.length + 1}`;
    const description = extractYamlBlock(yaml, "description");
    const skills = extractYamlArray(yaml, "skills");
    const files = extractYamlArray(yaml, "files");
    const blockedBy = extractYamlArray(yaml, "blocked_by");
    const blocks = extractYamlArray(yaml, "blocks");
    const validation = extractYamlArray(yaml, "validation");

    tasks.push({
      taskId,
      name,
      description,
      skills,
      scope: { files, description: extractYamlBlock(yaml, "description") },
      dependencies: { blockedBy, blocks },
      validation,
    });
  }

  if (tasks.length > 0) return tasks;

  // Strategy 2: Markdown heading format (## Task N — Name or ## Task N: Name)
  // Split on ## Task headings and parse each section
  const mdSections = planContent.split(/^## Task \d+\s*[—–:-]\s*/m).slice(1);

  for (const section of mdSections) {
    const nameMatch = section.match(/^(.+?)(?:\n|$)/);
    const name = nameMatch?.[1]?.replace(/\s*\(.*?\)\s*$/, "").trim() || `Task ${tasks.length + 1}`;

    // Extract files from **File:** or **Files:** lines
    const fileMatches = section.matchAll(/\*\*Files?\*\*:\s*`([^`]+)`/g);
    const files = [...fileMatches].map((m) => m[1]);

    // Extract acceptance criteria from - [ ] lines
    const validation = [...section.matchAll(/^- \[[ x]\]\s*(.+)$/gm)].map((m) => m[1]);

    // Extract description: everything between the name and first sub-heading or acceptance criteria
    const descMatch = section.match(/\n\n([\s\S]*?)(?=\n\*\*Acceptance|$)/);
    const description = descMatch?.[1]?.trim() || section.slice(0, 200).trim();

    tasks.push({
      taskId: `task-${tasks.length + 1}`,
      name,
      description,
      skills: [],
      scope: { files, description },
      dependencies: { blockedBy: [], blocks: [] },
      validation,
    });
  }

  return tasks;
}

function extractYamlValue(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
  return match?.[1]?.trim() || "";
}

function extractYamlBlock(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`${key}:\\s*\\|\\n([\\s\\S]*?)(?=\\n\\w|$)`));
  return match?.[1]?.trim() || "";
}

function extractYamlArray(yaml: string, key: string): string[] {
  // Match array format: key: [item1, item2] or key:\n  - item1\n  - item2
  const inlineMatch = yaml.match(new RegExp(`${key}:\\s*\\[([^\\]]+)\\]`));
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  const listMatch = yaml.match(new RegExp(`${key}:\\n((?:\\s+-\\s+.+\\n?)+)`));
  if (listMatch) {
    return listMatch[1]
      .split("\n")
      .map((s) => s.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return [];
}

main();
