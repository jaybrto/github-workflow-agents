# Planning Phase Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign `start-planning` to use Opus 4.6 in plan-only mode with a new `gwa-planning-complete` CLI tool that posts the plan comment, cleans up tmux/worktree, and updates the status comment.

**Architecture:** Claude REPL launches with `--model claude-opus-4-6` and a constrained prompt that prohibits file creation. When done, Claude calls `gwa-planning-complete` which posts the plan to the issue, updates the lifecycle comment, kills the tmux window, and removes the worktree.

**Tech Stack:** Bun, TypeScript, XState v5, @octokit/rest, node-tmux

---

## Task 1: Add `PLANNING_COMPLETE` event and `planningComplete` state to XState machine

**Files:**
- Modify: `src/shared/types.ts:19-36` (SessionEvent union)
- Modify: `src/shared/types.ts:8-16` (SessionState enum)
- Modify: `src/lib/state-machine.ts:71-94` (planning state transitions)
- Modify: `src/lib/state-machine.ts:393-405` (stateNameToSessionState map)

**Step 1: Add `PlanningComplete` to SessionState enum**

In `src/shared/types.ts`, add the new state:

```typescript
export enum SessionState {
  Idle = 'idle',
  Planning = 'planning',
  PlanningComplete = 'planning_complete',  // NEW
  InProgress = 'in_progress',
  QA = 'qa',
  Blocked = 'blocked',
  Review = 'review',
  Done = 'done',
}
```

**Step 2: Add `PLANNING_COMPLETE` to SessionEvent union**

In `src/shared/types.ts`, add:

```typescript
export type SessionEvent =
  | { type: 'START_PLANNING' }
  | { type: 'PLANNING_COMPLETE' }  // NEW
  | { type: 'INJECT_PROMPT' }
  // ... rest unchanged
```

**Step 3: Add `planningComplete` state to XState machine**

In `src/lib/state-machine.ts`, add transition from `planning` and the new state:

```typescript
// In the planning state, add:
planning: {
  on: {
    PLANNING_COMPLETE: {
      target: "planningComplete",
      actions: ({ context }) => {
        captureTransitionSnapshot(context, "planning_complete");
      },
    },
    INJECT_PROMPT: { /* existing */ },
    // ... rest unchanged
  },
},

// Add new state after planning:
planningComplete: {
  on: {
    INJECT_PROMPT: {
      target: "inProgress",
      actions: ({ context }) => {
        captureTransitionSnapshot(context, "work_started");
      },
    },
    REQUEST_REPLANNING: { target: "planning" },
    CANCEL_SESSION: { target: "idle" },
  },
},
```

**Step 4: Update stateNameToSessionState map**

In `src/lib/state-machine.ts`, add mapping:

```typescript
const map: Record<string, SessionState> = {
  idle: SessionState.Idle,
  planning: SessionState.Planning,
  planningComplete: SessionState.PlanningComplete,  // NEW
  inProgress: SessionState.InProgress,
  // ... rest unchanged
};
```

**Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors)

**Step 6: Commit**

```bash
git add src/shared/types.ts src/lib/state-machine.ts
git commit -m "feat(state): add PLANNING_COMPLETE event and planningComplete state"
```

---

## Task 2: Add `planning_complete` comment type to comment-generator

**Files:**
- Modify: `src/lib/comment-generator.ts:41-68` (types)
- Modify: `src/lib/comment-generator.ts:159-193` (template)
- Modify: `src/lib/comment-generator.ts:336-394` (switch)

**Step 1: Add PlanningCompleteInput interface**

After `SessionCompleteInput` in `src/lib/comment-generator.ts`:

```typescript
// Planning phase lifecycle completion
export interface PlanningCompleteInput {
  type: "planning_complete";
  sessionId: string;
  startedAt?: number;    // epoch seconds
  completedAt?: number;  // epoch seconds
}
```

Add to the `CommentInput` union:

```typescript
export type CommentInput =
  | REPLStartInput
  | HeadlessCompleteInput
  | ErrorInput
  | QuestionInput
  | ProgressInput
  | SessionCompleteInput
  | PlanningCompleteInput;  // NEW
```

**Step 2: Add generatePlanningCompleteComment template function**

After `generateSessionCompleteComment`:

```typescript
function generatePlanningCompleteComment(input: PlanningCompleteInput): string {
  let duration = "";
  if (input.startedAt && input.completedAt) {
    const seconds = input.completedAt - input.startedAt;
    if (seconds >= 3600) {
      duration = `${(seconds / 3600).toFixed(1)}h`;
    } else if (seconds >= 60) {
      duration = `${Math.round(seconds / 60)}m`;
    } else {
      duration = `${seconds}s`;
    }
  }

  let comment = `**Planning complete**

| Detail | Value |
|--------|-------|
| Session ID | \`${input.sessionId}\` |
| Status | Planning Complete |`;

  if (duration) {
    comment += `\n| Duration | ${duration} |`;
  }

  comment += `

The plan has been posted as a comment below.
Moving this item to "In Progress" will start implementation.`;

  return comment;
}
```

**Step 3: Add case to generateComment switch**

In the switch statement:

```typescript
case "planning_complete":
  span.setAttribute("comment.session_id", input.sessionId);
  return {
    body: generatePlanningCompleteComment(input),
    usedAI: false,
  };
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/comment-generator.ts
git commit -m "feat(comments): add planning_complete comment type"
```

---

## Task 3: Create `gwa-planning-complete` CLI tool

**Files:**
- Create: `src/planning-complete.ts`

**Step 1: Create the planning-complete CLI**

Create `src/planning-complete.ts` following the pattern of `session-complete.ts`:

```typescript
#!/usr/bin/env bun
import {
  withSpan,
  Metrics,
  shutdown as shutdownTelemetry,
  log,
} from "./lib/telemetry.js";

import { parseArgs } from "util";
import * as db from "./lib/db.js";
import * as github from "./lib/github.js";
import * as tmux from "./lib/tmux.js";
import { generateComment } from "./lib/comment-generator.js";
import { restoreActor, persistSnapshot, getStateName } from "./lib/state-machine.js";

const REPO_PATH = "/home/runner/repo";

interface PlanningCompleteArgs {
  issue: number;
  repo: string;
  plan: string;
  sessionId?: string;
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
      plan: { type: "string" },
      "session-id": { type: "string" },
    },
  });

  const args: PlanningCompleteArgs = {
    issue: parseInt(values.issue || "0", 10),
    repo: values.repo || "",
    plan: values.plan || "",
    sessionId: values["session-id"],
  };

  if (!args.issue || !args.repo || !args.plan) {
    console.error(
      "Usage: gwa-planning-complete --issue <number> --repo <owner/repo> --plan <markdown>"
    );
    await shutdownTelemetry();
    process.exit(1);
  }

  const [owner, repoName] = args.repo.split("/");

  if (!owner || !repoName) {
    console.error("Invalid repo format. Expected: owner/repo");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan(
      "planning-complete",
      async (span) => {
        span.setAttribute("issue.number", args.issue);
        span.setAttribute("issue.repo", args.repo);

        const sessionId = args.sessionId || `issue-${args.issue}`;
        span.setAttribute("session.id", sessionId);

        log("info", "Completing planning session", {
          repo: args.repo,
          issue: args.issue,
          sessionId,
          planLength: args.plan.length,
        });

        db.initDatabase();

        // 1. Post plan as new issue comment
        await withSpan("github.postPlanComment", async () => {
          await github.postIssueComment(owner, repoName, args.issue, args.plan);
          Metrics.recordGitHubApiCall("postIssueComment", true);
          log("info", "Posted plan comment to issue");
        });

        // 2. Get session and update status comment
        const session = db.getSession(sessionId);
        const statusCommentId = session?.status_comment_id;

        const completionComment = await generateComment({
          type: "planning_complete",
          sessionId,
          startedAt: session?.started_at ?? undefined,
          completedAt: Math.floor(Date.now() / 1000),
        });

        await withSpan("github.updateStatusComment", async () => {
          if (statusCommentId) {
            await github.updateComment(owner, repoName, statusCommentId, completionComment.body);
            Metrics.recordGitHubApiCall("issues.updateComment", true);
            log("info", "Updated lifecycle status comment", { commentId: statusCommentId });
          } else {
            await github.postIssueComment(owner, repoName, args.issue, completionComment.body);
            Metrics.recordGitHubApiCall("postIssueComment", true);
            log("info", "Posted new completion comment (no status comment ID found)");
          }
        });

        // 3. Update session status to planning_complete
        await withSpan("db.updateSession", async () => {
          db.updateSessionStatus(sessionId, "planning_complete", {
            completion_summary: `Planning complete for issue #${args.issue}`,
          });
          db.logActivity(sessionId, "planning_completed", {
            planLength: args.plan.length,
          }, "claude");
          Metrics.recordDbOperation("updateSessionStatus", true);
        });

        // 4. Transition XState: planning -> planningComplete
        await withSpan("xstate.transition", async () => {
          const actor = restoreActor(sessionId);
          if (actor) {
            actor.send({ type: "PLANNING_COMPLETE" });
            persistSnapshot(sessionId, actor.getSnapshot(), "PLANNING_COMPLETE");
            log("debug", `XState transitioned to ${getStateName(actor)}`);
          } else {
            log("warn", "No XState actor found for session", { sessionId });
          }
        });

        // 5. Kill tmux window
        if (session?.tmux_window != null) {
          await withSpan("tmux.killWindow", async () => {
            try {
              await tmux.killWindow(session.tmux_window!);
              log("info", "Killed tmux window", { window: session.tmux_window });
            } catch (error) {
              log("warn", "Failed to kill tmux window", {
                window: session.tmux_window,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }

        // 6. Remove git worktree
        if (session?.worktree_path) {
          await withSpan("git.removeWorktree", async () => {
            try {
              await exec("git", ["worktree", "remove", "--force", session.worktree_path!], REPO_PATH);
              log("info", "Removed worktree", { path: session.worktree_path });
            } catch (error) {
              log("warn", "Failed to remove worktree", {
                path: session.worktree_path,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }

        success = true;
        Metrics.sessionEnded();
        log("info", "Planning session completed", {
          sessionId,
          issue: args.issue,
        });
      },
      {
        attributes: {
          "gwa.operation": "planning-complete",
          "issue.number": args.issue,
          "issue.repo": args.repo,
        },
      }
    );

    console.log("Planning complete — plan posted to issue, session cleaned up.");
  } catch (error) {
    log("error", "Failed to complete planning session", {
      repo: args.repo,
      issue: args.issue,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    db.closeDatabase();
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

main();
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/planning-complete.ts
git commit -m "feat(planning): add gwa-planning-complete CLI tool"
```

---

## Task 4: Add build target and Dockerfile entry for `gwa-planning-complete`

**Files:**
- Modify: `package.json:6-7` (scripts.build, scripts.build:planning-complete)
- Modify: `Dockerfile:85` (COPY line)

**Step 1: Add build script to package.json**

Add to `scripts`:

```json
"build:planning-complete": "bun build src/planning-complete.ts --compile --outfile dist/gwa-planning-complete",
```

Add `&& bun run build:planning-complete` to the end of the `build` script.

**Step 2: Add COPY line to Dockerfile**

After the last `COPY --from=builder /build/dist/gwa-credentials-backup` line:

```dockerfile
COPY --from=builder /build/dist/gwa-planning-complete /usr/local/bin/
```

**Step 3: Verify build compiles**

Run: `bun run build:planning-complete`
Expected: Binary created at `dist/gwa-planning-complete`

**Step 4: Commit**

```bash
git add package.json Dockerfile
git commit -m "infra: add gwa-planning-complete to build targets and Dockerfile"
```

---

## Task 5: Modify `start-planning.ts` — add Opus model and rewrite prompt

**Files:**
- Modify: `src/transitions/start-planning.ts:144-211` (remove plan dir, rewrite prompt)
- Modify: `src/transitions/start-planning.ts:355-358` (REPL launch command)

**Step 1: Remove plan directory creation**

Delete lines 145-162 (section "4. Create plan directory" through template copying). Replace with a comment:

```typescript
// 4. Worktree is for codebase exploration only — no plan files written
```

**Step 2: Rewrite the planning prompt**

Replace the `planningPrompt` variable (lines 173-211) with:

```typescript
const planningPrompt = `You are an architect analyzing a GitHub issue to create an implementation plan.

## Issue #${issueNumber}: ${issue.title}

${issue.body || "No description provided."}

## Your Task

Analyze this issue and produce a comprehensive implementation plan. You have
full read access to the codebase via this worktree.

### What to do:
- Read the issue requirements carefully
- Explore the codebase to understand relevant files, patterns, and architecture
- Identify affected files, dependencies, and potential risks
- Break the work into 3-7 concrete, parallelizable tasks with dependencies
- Produce a single markdown plan document

### What NOT to do:
- DO NOT create, modify, or delete any files
- DO NOT make git commits or push branches
- DO NOT write any code — this is analysis only

### Asking Questions

If you need clarification from the issue author, use:
\`\`\`bash
gwa-ask-question --issue ${issueNumber} --repo ${repo} --question "your question"
\`\`\`
This posts a comment on the issue and blocks until the answer arrives.

### When Planning is Complete

Call this tool with your full plan as markdown. Write the plan to a temp file first for reliable escaping:
\`\`\`bash
cat > /tmp/plan-issue-${issueNumber}.md <<'PLAN_EOF'
## Implementation Plan for Issue #${issueNumber}

[your full plan here]
PLAN_EOF

gwa-planning-complete --issue ${issueNumber} --repo ${repo} --plan "$(cat /tmp/plan-issue-${issueNumber}.md)"
\`\`\`

The plan should include:
1. **Requirements Summary** — what needs to be built
2. **Technical Approach** — architecture decisions, patterns to use
3. **Files to Modify/Create** — specific paths with descriptions
4. **Task Breakdown** — numbered tasks with dependencies
5. **Risks & Considerations** — edge cases, backwards compatibility`;
```

**Step 3: Add `--model claude-opus-4-6` to REPL launch**

Change line 357 from:

```typescript
await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions");
```

to:

```typescript
await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions --model claude-opus-4-6");
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/transitions/start-planning.ts
git commit -m "feat(planning): use Opus 4.6, plan-only prompt, call gwa-planning-complete"
```

---

## Task 6: Bump version and update CHANGELOG

**Files:**
- Modify: `package.json:2` (version)
- Modify: `CHANGELOG.md` (add entry)

**Step 1: Bump patch version**

Change `"version": "4.11.0"` to `"version": "4.12.0"` in `package.json` (minor bump for new feature).

**Step 2: Update CHANGELOG**

Add to top of CHANGELOG.md:

```markdown
## [4.12.0] - 2026-02-21

### Changed
- Planning phase now uses Opus 4.6 model for architectural analysis
- Planning prompt is analysis-only — Claude explores the codebase and produces a plan without creating files
- Planning completion posts the plan as a GitHub issue comment instead of writing plan files

### Added
- `gwa-planning-complete` CLI tool — posts plan comment, updates status comment, kills tmux window, removes worktree
- `PLANNING_COMPLETE` XState event and `planningComplete` state for planning phase lifecycle
- `planning_complete` comment type in comment generator
```

**Step 3: Run typecheck (final verification)**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 4.12.0, update CHANGELOG"
```

---

## Task 7: Build and verify all binaries compile

**Step 1: Run full build**

Run: `bun run build`
Expected: All binaries compile including the new `gwa-planning-complete`

**Step 2: Verify the new binary exists**

Run: `ls -la dist/gwa-planning-complete`
Expected: Binary file exists

**Step 3: Verify typecheck passes**

Run: `bun run typecheck`
Expected: PASS with 0 errors

---

## Agent Teams Execution Plan

### Team Structure

- **Lead** — Coordinates phases, runs foundation tasks via subagents, spawns teammates, handles integration
- **Teammate A: state-and-comments** — XState types/machine + comment-generator (Tasks 1 + 2)
- **Teammate B: start-planning** — Prompt rewrite + model flag (Task 5)

Tasks 3, 4, 6, 7 are sequential (Task 3 depends on A's output, Tasks 4/6/7 depend on everything) — handled by lead via subagent after teammates finish.

### Phase 1: Parallel Implementation (2 Teammates)

No foundation phase is needed — Tasks 1, 2, and 5 have no shared file dependencies. All three can start immediately.

#### Teammate A: state-and-comments

**Owns (exclusive write):**
- `src/shared/types.ts`
- `src/lib/state-machine.ts`
- `src/lib/comment-generator.ts`

**Reads:** Nothing shared needed beyond what it owns.

**Tasks:**
1. Add `PlanningComplete` to `SessionState` enum in `types.ts`
2. Add `PLANNING_COMPLETE` to `SessionEvent` union in `types.ts`
3. Add `planningComplete` state to XState machine in `state-machine.ts` with `PLANNING_COMPLETE` transition from `planning`
4. Add `planningComplete` to `stateNameToSessionState` map
5. Add `PlanningCompleteInput` interface and `planning_complete` case to `comment-generator.ts`
6. Run `bun run typecheck`
7. Commit: `feat(state): add PLANNING_COMPLETE event, planningComplete state, planning_complete comment type`

#### Teammate B: start-planning

**Owns (exclusive write):**
- `src/transitions/start-planning.ts`

**Reads:** Nothing shared needed.

**Tasks:**
1. Remove plan directory creation (lines 145-162)
2. Rewrite `planningPrompt` variable — analysis-only, calls `gwa-planning-complete`, uses `gwa-ask-question`
3. Change REPL launch from `claude --dangerously-skip-permissions` to `claude --dangerously-skip-permissions --model claude-opus-4-6`
4. Run `bun run typecheck`
5. Commit: `feat(planning): use Opus 4.6, plan-only prompt, call gwa-planning-complete`

### Phase 2: Sequential (Lead via Subagent)

After both teammates complete, the lead spawns a subagent to create the `gwa-planning-complete` CLI and wire up the build.

**Task 3:** Create `src/planning-complete.ts` (new file — no conflict with any teammate's files)

**Task 4:** Add `build:planning-complete` script to `package.json`, add to `build` script, add COPY line to `Dockerfile`

**Task 6:** Bump version to `4.12.0` in `package.json`, update `CHANGELOG.md`

**Task 7:** Run `bun run build` and `bun run typecheck` to verify everything compiles.

### Phase 3: Verification (Lead)

Lead runs `superpowers:verification-before-completion`:
1. `bun run typecheck` — must pass
2. `bun run build` — all binaries must compile
3. `ls dist/gwa-planning-complete` — new binary exists

### File Ownership Matrix (No Conflicts)

| Agent | Exclusively Owns | Reads (no writes) |
|-------|-----------------|-------------------|
| **Lead** | `src/planning-complete.ts` (new), `package.json`, `Dockerfile`, `CHANGELOG.md` | Everything |
| **Teammate A** | `src/shared/types.ts`, `src/lib/state-machine.ts`, `src/lib/comment-generator.ts` | — |
| **Teammate B** | `src/transitions/start-planning.ts` | — |

### Task Dependency DAG

```
Phase 1 (Parallel):
  A: types + state-machine + comments ──┐
  B: start-planning prompt + model ─────┤
                                        │
Phase 2 (Sequential, Lead):             │
  3: planning-complete.ts (needs A) ────┤ Must complete before Phase 3
  4: package.json + Dockerfile ─────────┤
  6: version bump + CHANGELOG ──────────┘

Phase 3 (Lead):
  7: Build + typecheck verification
```

### Claude Code Session Setup

**Prerequisites:**
```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

**Execution steps:**

1. Start Claude Code in the project directory
2. Tell Claude: `Execute docs/plans/2026-02-21-planning-phase-redesign-impl.md following the Agent Teams Execution Plan`
3. Claude creates a feature branch: `git checkout -b feat/planning-phase-redesign`
4. Claude creates the task list:
   - Task P1-A: Phase 1 Teammate A work (types, state machine, comments)
   - Task P1-B: Phase 1 Teammate B work (start-planning prompt + model)
   - Task P2-3: Create planning-complete.ts (blocked by P1-A)
   - Task P2-4: Build config + Dockerfile (blocked by P2-3)
   - Task P2-6: Version bump + CHANGELOG (blocked by P2-4)
   - Task P3-7: Build verification (blocked by P2-6)
5. Claude calls `TeamCreate` with team name `planning-redesign`
6. Claude spawns 2 teammates in parallel via `Task` tool with `run_in_background: true`
7. Claude monitors via `sleep 30` + `TaskList` polling
8. When both teammates complete, Claude sends `shutdown_request` to each
9. Claude spawns a subagent to implement Tasks 3, 4, 6 sequentially
10. Claude runs Task 7 verification directly
11. Claude commits all changes

### Teammate Prompt: A (state-and-comments)

```
You are Teammate A on team planning-redesign. Your job is to add the PLANNING_COMPLETE
event type, planningComplete XState state, and planning_complete comment type.

**File Ownership:**
- You EXCLUSIVELY own: src/shared/types.ts, src/lib/state-machine.ts, src/lib/comment-generator.ts
- Do NOT touch any other files

**Tasks:**

1. In src/shared/types.ts:
   - Add PlanningComplete = 'planning_complete' to SessionState enum (after Planning)
   - Add { type: 'PLANNING_COMPLETE' } to SessionEvent union (after START_PLANNING)

2. In src/lib/state-machine.ts:
   - In the planning state's `on` object, add PLANNING_COMPLETE transition targeting "planningComplete"
     with action: captureTransitionSnapshot(context, "planning_complete")
   - Add new planningComplete state after planning with transitions:
     INJECT_PROMPT -> inProgress (with captureTransitionSnapshot "work_started")
     REQUEST_REPLANNING -> planning
     CANCEL_SESSION -> idle
   - In stateNameToSessionState map, add: planningComplete: SessionState.PlanningComplete

3. In src/lib/comment-generator.ts:
   - Add PlanningCompleteInput interface: { type: "planning_complete"; sessionId: string; startedAt?: number; completedAt?: number }
   - Add PlanningCompleteInput to CommentInput union
   - Add generatePlanningCompleteComment function (same duration logic as generateSessionCompleteComment but with "Planning complete" header and "Moving to In Progress" footer)
   - Add "planning_complete" case to the switch in generateComment

**Validation:** Run bun run typecheck — must pass with 0 errors

**When complete:** Commit with message "feat(state): add PLANNING_COMPLETE event, planningComplete state, planning_complete comment type"
Then mark your task as completed and send a completion message.
```

### Teammate Prompt: B (start-planning)

```
You are Teammate B on team planning-redesign. Your job is to modify the planning
prompt and add the Opus model flag to the Claude REPL launch.

**File Ownership:**
- You EXCLUSIVELY own: src/transitions/start-planning.ts
- Do NOT touch any other files

**Tasks:**

1. Remove plan directory creation — delete the section that creates .plans/ directory
   and copies templates (approximately lines 145-162). Replace with a comment:
   // 4. Worktree is for codebase exploration only — no plan files written

2. Rewrite the planningPrompt variable. The new prompt must:
   - Tell Claude it's an architect analyzing a GitHub issue
   - Include the issue number, title, and body
   - Instruct Claude to explore the codebase and produce a plan
   - Explicitly prohibit file creation, commits, and pushes (analysis only)
   - Tell Claude to use gwa-ask-question for clarifying questions
   - Tell Claude to call gwa-planning-complete with the plan markdown when done
   - Include writing plan to a temp file first for reliable shell escaping

3. Change the Claude REPL launch command from:
   claude --dangerously-skip-permissions
   to:
   claude --dangerously-skip-permissions --model claude-opus-4-6

**Validation:** Run bun run typecheck — must pass with 0 errors

**When complete:** Commit with message "feat(planning): use Opus 4.6, plan-only prompt, call gwa-planning-complete"
Then mark your task as completed and send a completion message.
```
