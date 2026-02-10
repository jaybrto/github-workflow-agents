#!/usr/bin/env bun
/**
 * Start Planning Session
 * Trigger: Todo → Planning
 * Action: Create session, setup worktree, start REPL with planning prompt
 */

import { parseArgs } from "util";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import { getOctokit } from "../lib/github.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";

const WORKTREES_PATH = "/home/runner/worktrees";
const REPO_PATH = "/home/runner/repo";

interface StartPlanningArgs {
  issue: number;
  repo: string;
}

async function exec(
  command: string,
  args: string[],
  cwd?: string
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
      repo: { type: "string" },
    },
  });

  const args: StartPlanningArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
  };

  if (!args.issue || !args.repo) {
    console.error("Usage: gwa-start-planning --issue <number> --repo <owner/repo>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan("transition.start-planning", async (span) => {
      span.setAttribute("issue.number", args.issue);
      span.setAttribute("issue.repo", args.repo);

      log("info", `Starting planning session for issue #${args.issue}`, {
        repo: args.repo,
      });

      await startPlanningSession(args.issue, args.repo);
      success = true;
    });
  } catch (error) {
    log("error", "Failed to start planning session", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function startPlanningSession(issueNumber: number, repo: string): Promise<void> {
  const sessionId = `issue-${issueNumber}`;
  const branchName = `claude/issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;
  const planDir = `${worktreePath}/.plans/${sessionId}`;
  const [owner, repoName] = repo.split("/");

  // 1. Ensure tmux session exists
  await tmux.ensureSession();

  // 2. Fetch latest
  log("debug", "Fetching latest changes");
  await exec("git", ["fetch", "--all", "--prune"], REPO_PATH);

  // 3. Create or update worktree
  const worktreeExists = (await exec("git", ["worktree", "list"], REPO_PATH))
    .stdout.includes(worktreePath);

  if (worktreeExists) {
    log("debug", "Worktree exists, updating");
    await exec("git", ["fetch", "origin"], worktreePath);
    await exec("git", ["checkout", "-B", branchName], worktreePath);
  } else {
    log("debug", "Creating worktree");
    // Check if branch exists remotely
    const branchExists = (await exec("git", ["ls-remote", "--heads", "origin", branchName], REPO_PATH))
      .stdout.includes(branchName);

    if (branchExists) {
      await exec("git", ["worktree", "add", worktreePath, branchName], REPO_PATH);
    } else {
      await exec("git", ["worktree", "add", "-b", branchName, worktreePath, "origin/main"], REPO_PATH);
    }
  }

  // 4. Create plan directory
  await Bun.write(`${planDir}/.gitkeep`, "");

  // Copy templates if they exist
  const templatesDir = `${REPO_PATH}/templates/plans`;
  try {
    const templates = ["plan.md", "checklist.md", "decisions.md", "snippets.md", "prompt.md"];
    for (const template of templates) {
      const src = `${templatesDir}/${template}`;
      const dest = `${planDir}/${template}`;
      const file = Bun.file(src);
      if (await file.exists()) {
        await Bun.write(dest, file);
      }
    }
  } catch {
    log("debug", "No templates to copy");
  }

  // 5. Get issue details
  const octokit = getOctokit();
  const { data: issue } = await octokit.issues.get({
    owner,
    repo: repoName,
    issue_number: issueNumber,
  });

  // 6. Build planning prompt
  const planningPrompt = `You are an architect agent creating an implementation plan.

## Issue #${issueNumber}: ${issue.title}

${issue.body || "No description provided."}

## Your Task

Create a comprehensive implementation plan:

1. **Analyze Requirements** - Extract functional and non-functional requirements
2. **Design Solution** - Determine files to create/modify, patterns to use
3. **Break Down into Tasks** - Create 3-7 parallelizable tasks with dependencies
4. **Write Plan Files** - Create files in .plans/${sessionId}/

When planning is complete, the project item will be moved to 'In Progress'.
Use /handoff if you need to pause and resume later.`;

  // 7. Initialize database and create session
  db.initDatabase();
  db.createSession({
    id: sessionId,
    type: "feature",
    github_number: issueNumber,
    github_type: "issue",
    repo,
    branch: branchName,
    worktree_path: worktreePath,
    initial_prompt: `Planning session for issue #${issueNumber}`,
  });

  db.logActivity(sessionId, "planning_started", { issue: issueNumber }, "workflow");

  // 8. Create tmux window
  const windowNum = await tmux.createWindow(sessionId, worktreePath);

  // Update session with window number
  db.updateSessionStatus(sessionId, "running", { tmux_window: windowNum });

  // 9. Start Claude REPL
  log("info", "Starting Claude REPL");
  await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions");

  // Wait for REPL to initialize
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 10. Send planning prompt
  log("info", "Sending planning prompt");
  // Write prompt to temp file for reliable sending
  const tempFile = `/tmp/gwa-prompt-${sessionId}.md`;
  await Bun.write(tempFile, planningPrompt);
  await tmux.sendCommand(windowNum, `Read ${tempFile} and follow the instructions.`);

  log("info", "Planning session started", {
    sessionId,
    window: windowNum,
    worktree: worktreePath,
  });

  console.log(`
Planning session started:
  Session ID: ${sessionId}
  Tmux Window: ${windowNum}
  Worktree: ${worktreePath}

Attach with: kubectl exec -it gwa-runner-0 -- tmux attach -t gwa-work:${windowNum}
`);
}

main();
