#!/usr/bin/env bun
/**
 * Inject Prompt
 * Trigger: Planning → In Progress
 * Action: Send prompt.md content to existing REPL session
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";

const WORKTREES_PATH = "/home/runner/worktrees";

interface InjectPromptArgs {
  issue: number;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      issue: { type: "string" },
    },
  });

  const args: InjectPromptArgs = {
    issue: parseInt(values.issue || "0", 10),
  };

  if (!args.issue) {
    console.error("Usage: gwa-inject-prompt --issue <number>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan("transition.inject-prompt", async (span) => {
      span.setAttribute("issue.number", args.issue);

      log("info", `Injecting implementation prompt for issue #${args.issue}`);

      await injectPrompt(args.issue);
      success = true;
    });
  } catch (error) {
    log("error", "Failed to inject prompt", {
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

async function injectPrompt(issueNumber: number): Promise<void> {
  const sessionId = `issue-${issueNumber}`;
  const worktreePath = `${WORKTREES_PATH}/${sessionId}`;
  const planDir = `${worktreePath}/.plans/${sessionId}`;
  const promptFile = `${planDir}/prompt.md`;
  const planFile = `${planDir}/plan.md`;

  // 1. Get session from database
  db.initDatabase();
  const session = db.getSession(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status !== "running" && session.status !== "blocked") {
    throw new Error(`Session ${sessionId} is not running (status: ${session.status})`);
  }

  const windowNum = session.tmux_window;
  if (!windowNum) {
    throw new Error(`No tmux window found for session ${sessionId}`);
  }

  // 2. Verify tmux window exists
  if (!(await tmux.windowExists(windowNum))) {
    throw new Error(`Tmux window ${windowNum} no longer exists`);
  }

  // 3. Build implementation prompt
  let implementationPrompt: string;

  if (existsSync(promptFile)) {
    log("debug", "Loading prompt from prompt.md");
    implementationPrompt = readFileSync(promptFile, "utf-8");
  } else {
    log("debug", "No prompt.md found, using default implementation prompt");

    let planContent = "";
    if (existsSync(planFile)) {
      planContent = readFileSync(planFile, "utf-8");
    }

    implementationPrompt = `## Plan Approved - Begin Implementation

The plan has been approved. Begin implementing the tasks defined in the plan.

### Implementation Guidelines
1. Follow the task order defined in the dependency graph
2. Create/modify files as specified in the plan
3. Run tests after each significant change
4. Commit changes with conventional commit messages
5. Update checklist.md as you complete tasks

### Plan Summary
${planContent}

Begin with the first task that has no dependencies.`;
  }

  // 4. Update session status
  db.updateSessionStatus(sessionId, "running");
  db.logActivity(sessionId, "implementation_started", {}, "workflow");

  // 5. Send prompt to REPL
  log("info", `Sending implementation prompt to window ${windowNum}`);

  // Write to temp file for reliable sending
  const tempFile = `/tmp/gwa-impl-prompt-${sessionId}.md`;
  await Bun.write(tempFile, implementationPrompt);
  await tmux.sendCommand(windowNum, `Read ${tempFile} and follow the instructions.`);

  log("info", "Implementation prompt injected", {
    sessionId,
    window: windowNum,
  });

  console.log(`
Implementation prompt injected:
  Session ID: ${sessionId}
  Tmux Window: ${windowNum}

Attach with: kubectl exec -it gwa-runner-0 -- tmux attach -t gwa-work:${windowNum}
`);
}

main();
