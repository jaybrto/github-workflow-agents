#!/usr/bin/env bun
/**
 * Start Planning Session
 * Trigger: Todo → Planning
 * Action: Create session, setup worktree, start REPL with planning prompt
 */

import { parseArgs } from "util";
import * as os from "os";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import { getOctokit } from "../lib/github.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";
import {
  getProject,
  getProjectItem,
  updateSessionFields,
  ensureCustomFields,
} from "../lib/projects.js";
import { generateComment } from "../lib/comment-generator.js";
import { preloadClaudeConfig, detectAuthFailure, ClaudeAuthError } from "../lib/claude.js";
import { isCredentialExpired, tryRecoverCredentials, provisionFromOrchestrator, getAccessToken } from "../lib/credentials-manager.js";
import { handleDialogIfPresent } from "../lib/dialog-handler.js";
import { createSessionActor, persistSnapshot, getStateName } from "../lib/state-machine.js";
import { startPaneStream } from "../lib/terminal-relay.js";

const WORKTREES_PATH = "/home/runner/worktrees";
const REPO_PATH = "/home/runner/repo";

interface StartPlanningArgs {
  issue: number;
  repo: string;
  itemId?: string; // GitHub Projects item ID (from webhook)
  projectNumber?: number; // GitHub Project number
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
      "item-id": { type: "string" },
      "project-number": { type: "string" },
    },
  });

  const args: StartPlanningArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
    itemId: values["item-id"],
    projectNumber: values["project-number"] ? parseInt(values["project-number"], 10) : undefined,
  };

  if (!args.issue || !args.repo) {
    console.error("Usage: gwa-start-planning --issue <number> --repo <owner/repo> [--item-id <id>] [--project-number <num>]");
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

      await startPlanningSession(args.issue, args.repo, args.itemId, args.projectNumber);
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

async function startPlanningSession(
  issueNumber: number,
  repo: string,
  itemId?: string,
  projectNumber?: number
): Promise<void> {
  const sessionId = `issue-${issueNumber}`;
  const branchName = `claude/issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;
  const [owner, repoName] = repo.split("/");

  // Get pod name (hostname in K8s)
  const podName = os.hostname() || process.env.POD_NAME || "unknown";

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

  // 4. Worktree is for codebase exploration only — no plan files written

  // 5. Get issue details
  const octokit = getOctokit();
  const { data: issue } = await octokit.issues.get({
    owner,
    repo: repoName,
    issue_number: issueNumber,
  });

  // 6. Build planning prompt
  const planningPrompt = `You are an architect analyzing a GitHub issue to create an implementation plan.

## Issue #${issueNumber}: ${issue.title}

${issue.body || "No description provided."}

## Your Task

Explore the codebase and produce a detailed implementation plan. Do not implement anything — your only output is the plan.

## What to do

1. Read and understand the requirements in the issue above
2. Explore the codebase to understand the existing structure, patterns, and conventions
3. Identify all files that will need to be created or modified
4. Break the work into 3-7 concrete tasks that could be executed independently or in parallel
5. Note any risks, ambiguities, or decisions that need to be made

Your plan should include:
- **Requirements Summary**: What needs to be built and why
- **Technical Approach**: Architecture decisions, patterns to follow, key design choices
- **Files to Modify/Create**: List each file with a brief description of changes
- **Task Breakdown**: 3-7 tasks with clear scope and any dependencies between them
- **Risks**: Potential issues, unknowns, or areas needing clarification

## What NOT to do

- DO NOT create, modify, or delete any files in the repository
- DO NOT run git commit, git push, or any write operations
- DO NOT implement any code
- This session is analysis only — read and explore, then output your plan

## Asking Questions

If you need clarification on requirements before finalizing the plan, post a question:

\`\`\`bash
gwa-ask-question --issue ${issueNumber} --repo ${repo} --question "Your question here"
\`\`\`

## When Planning is Complete

Write your plan to a temp file first, then call the planning-complete tool:

\`\`\`bash
# Write the plan
cat > /tmp/plan-issue-${issueNumber}.md << 'EOF'
[Your full plan in markdown]
EOF

# Submit the plan
gwa-planning-complete --issue ${issueNumber} --repo ${repo} --plan "$(cat /tmp/plan-issue-${issueNumber}.md)"
\`\`\`

The plan will be posted as a GitHub issue comment and the issue will be moved to the implementation queue.`;

  // 7. Initialize database and create session
  db.initDatabase();

  // Resolve project item ID if not provided
  let resolvedItemId = itemId;
  let project;
  if (projectNumber) {
    try {
      project = await getProject(owner, projectNumber);

      // Ensure all required custom fields exist (creates missing ones)
      const fieldResult = await ensureCustomFields(owner, projectNumber);
      if (fieldResult.created > 0) {
        log("info", `Created ${fieldResult.created} missing project fields`);
        // Re-fetch project to get newly created fields
        project = await getProject(owner, projectNumber);
      }

      if (!resolvedItemId) {
        // Query GitHub API to find project item
        const projectItem = await getProjectItem(owner, repoName, issueNumber, project.id);
        resolvedItemId = projectItem?.id;
        if (resolvedItemId) {
          log("info", `Resolved project item ID from API: ${resolvedItemId}`);
        }
      }
    } catch (error) {
      log("warn", "Failed to resolve project item", { error: String(error) });
    }
  }

  // Check for existing session (e.g., from a previous failed run)
  const existingSession = db.getSession(sessionId);
  if (existingSession) {
    log("info", `Session ${sessionId} already exists (status: ${existingSession.status}), resetting for new run`);
    db.updateSessionStatus(sessionId, "active", {
      branch: branchName,
      worktree_path: worktreePath,
      project_item_id: resolvedItemId || null,
    });
  } else {
    db.createSession({
      id: sessionId,
      type: "feature",
      github_number: issueNumber,
      github_type: "issue",
      repo,
      branch: branchName,
      worktree_path: worktreePath,
      initial_prompt: `Planning session for issue #${issueNumber}`,
      project_item_id: resolvedItemId,
    });
  }

  db.logActivity(sessionId, "planning_started", { issue: issueNumber }, "workflow");

  // Initialize XState actor and transition idle -> planning
  const actor = createSessionActor({
    sessionId,
    previousState: null,
    issueNumber,
    repoOwner: owner,
    repoName,
  });
  actor.send({ type: "START_PLANNING" });
  persistSnapshot(sessionId, actor.getSnapshot());
  log("debug", `XState transitioned to ${getStateName(actor)}`);

  // 8. Create tmux window
  const windowNum = await tmux.createWindow(sessionId, worktreePath);

  // Update session with window number
  db.updateSessionStatus(sessionId, "running", { tmux_window: windowNum });

  // Start terminal streaming
  const tmuxTarget = `gwa-work:${windowNum}`;
  try {
    await startPaneStream(sessionId, tmuxTarget);
    log("info", "Terminal streaming started", { sessionId, tmuxTarget });
  } catch (error) {
    log("warn", "Failed to start terminal streaming", { error: String(error) });
  }

  // Build kubectl attach command
  const kubectlCommand = `kubectl exec -it ${podName} -- tmux attach -t gwa-work:${windowNum}`;

  // 9. Update GitHub Project fields with session info
  if (project && resolvedItemId) {
    try {
      await updateSessionFields(project, resolvedItemId, {
        sessionId,
        branchName,
        startedAt: new Date(),
        assignedAgent: "claude-architect",
        podName,
        tmuxWindow: String(windowNum),
        kubectlCommand,
        worktreePath,
      });
      log("info", "Updated GitHub Project fields");
    } catch (error) {
      log("warn", "Failed to update project fields", { error: String(error) });
    }
  }

  // 10. Start Claude REPL
  log("info", "Starting Claude REPL");
  preloadClaudeConfig();

  // Proactive: restore credentials if token is expired (orchestrator first, then MinIO)
  if (isCredentialExpired()) {
    log("warn", "OAuth token expired before REPL start, attempting recovery");
    const provisioned = await provisionFromOrchestrator();
    if (provisioned) {
      preloadClaudeConfig();
      log("info", "Credentials provisioned from orchestrator before REPL start");
    } else {
      const recovered = await tryRecoverCredentials();
      if (!recovered) {
        await octokit.issues.createComment({
          owner,
          repo: repoName,
          issue_number: issueNumber,
          body: "**Auth failure:** OAuth token is expired and no backup is available. Manual re-login required.",
        });
        throw new Error("Auth recovery failed: no valid credentials available");
      }
      preloadClaudeConfig();
      log("info", "Credentials restored from MinIO before REPL start");
    }
  }

  // Ensure tmux session has the fresh token from disk (not the stale K8s env var)
  const freshToken = getAccessToken();
  if (freshToken) {
    await tmux.sendKeys(windowNum, `export CLAUDE_CODE_OAUTH_TOKEN='${freshToken}'\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Start Claude REPL with reactive auth retry (max 2 attempts)
  const MAX_AUTH_RETRIES = 2;
  let authRetries = 0;

  while (true) {
    await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions --model claude-opus-4-6");

    // Poll for REPL readiness — wait until the ❯ prompt appears
    const REPL_READY_TIMEOUT_MS = 30_000;
    const REPL_POLL_INTERVAL_MS = 1_000;
    let replReady = false;
    let paneOutput = "";
    let elapsed = 0;

    while (elapsed < REPL_READY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, REPL_POLL_INTERVAL_MS));
      elapsed += REPL_POLL_INTERVAL_MS;
      paneOutput = await tmux.capturePane(windowNum, 30);

      // Auth failure is visible quickly — check before waiting for full readiness
      if (detectAuthFailure(paneOutput)) break;

      if (paneOutput.includes("❯")) {
        replReady = true;
        break;
      }
    }

    if (replReady) {
      // Check for interactive dialogs blocking Claude startup
      await handleDialogIfPresent(windowNum);
      log("info", `REPL ready after ${elapsed}ms`);
      break;
    }

    // Either auth failure or timeout
    if (!detectAuthFailure(paneOutput)) {
      throw new Error(
        `Claude REPL did not become ready within ${REPL_READY_TIMEOUT_MS}ms. ` +
        `Captured: ${paneOutput.slice(0, 300)}`
      );
    }

    authRetries++;
    if (authRetries >= MAX_AUTH_RETRIES) {
      throw new ClaudeAuthError(
        `Claude stuck on auth screen after ${MAX_AUTH_RETRIES} recovery attempts. ` +
        `Captured: ${paneOutput.slice(0, 300)}`
      );
    }

    log("warn", `Auth failure detected in REPL start, attempting recovery (attempt ${authRetries})`);
    db.logActivity(sessionId, "auth_recovery_start", { attempt: authRetries }, "system");

    // Kill stuck Claude in the window, restore credentials, retry
    await tmux.sendKeys(windowNum, "C-c");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const recovered = await tryRecoverCredentials();
    db.logActivity(sessionId, "auth_recovery_result", { attempt: authRetries, recovered }, "system");
    if (!recovered) {
      throw new ClaudeAuthError("Auth recovery failed: no MinIO backup available");
    }
    preloadClaudeConfig();
    log("info", `Credentials restored, retrying Claude start (attempt ${authRetries + 1})`);
  }

  // 11. Send planning prompt
  log("info", "Sending planning prompt");
  // Write prompt to temp file for reliable sending
  const tempFile = `/tmp/gwa-prompt-${sessionId}.md`;
  await Bun.write(tempFile, planningPrompt);
  await tmux.sendCommand(windowNum, `Read ${tempFile} and follow the instructions.`);

  // 12. Post REPL start comment to GitHub issue and save comment ID for lifecycle updates
  try {
    const comment = await generateComment({
      type: "repl_start",
      sessionId,
      kubectlAttachCommand: kubectlCommand,
      tmuxAttachCommand: `tmux attach -t gwa-work:${windowNum}`,
      trigger: "Planning started",
    });
    const { data: postedComment } = await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body: comment.body,
    });
    // Save comment ID so completion can update the same comment
    db.updateSessionStatus(sessionId, "running", {
      status_comment_id: postedComment.id,
    });
    log("info", "Posted REPL start comment to issue", { commentId: postedComment.id });
  } catch (error) {
    log("warn", "Failed to post start comment", { error: String(error) });
  }

  log("info", "Planning session started", {
    sessionId,
    window: windowNum,
    worktree: worktreePath,
    podName,
    ...(resolvedItemId ? { projectItemId: resolvedItemId } : {}),
  });

  console.log(`
Planning session started:
  Session ID: ${sessionId}
  Tmux Window: ${windowNum}
  Worktree: ${worktreePath}
  Pod: ${podName}
  Project Item: ${resolvedItemId || "N/A"}

Attach with: ${kubectlCommand}
`);
}

main();
