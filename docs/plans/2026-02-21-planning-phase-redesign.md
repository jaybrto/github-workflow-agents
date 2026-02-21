# Planning Phase Redesign

**Date:** 2026-02-21
**Status:** Approved
**Scope:** `start-planning.ts`, new `planning-complete.ts`, comment-generator, state machine

---

## Problem

The current `start-planning` transition launches Claude in REPL mode with Sonnet and a prompt that instructs it to create plan files, commit them, push, and post a summary comment. This has several issues:

1. **Wrong model** — Planning is an architectural task that benefits from Opus 4.6, not Sonnet
2. **Plan lives in files** — The plan is scattered across `.plans/` files in the worktree. It should be a single GitHub issue comment for visibility
3. **No cleanup** — After planning, the tmux window and worktree stay alive indefinitely
4. **No status update** — The original "Claude is working" comment is never updated to reflect completion
5. **No plan-only constraint** — Claude can write arbitrary files during planning when it should only analyze and produce a plan

## Design

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ start-planning.ts (modified)                                     │
│                                                                  │
│ 1. Create worktree (for codebase exploration, read-only intent)  │
│ 2. Create tmux window                                            │
│ 3. Post "Claude is working" status comment (save comment ID)     │
│ 4. Launch: claude --dangerously-skip-permissions                 │
│            --model claude-opus-4-6                                │
│ 5. Send planning-only prompt                                     │
│ 6. Exit (fire-and-forget)                                        │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Claude REPL (Opus 4.6, in tmux window)                           │
│                                                                  │
│ - Reads issue description                                        │
│ - Explores codebase (read files, grep, LSP)                      │
│ - May ask questions via gwa-ask-question (blocks, polls, resumes)│
│ - Produces plan as markdown text                                 │
│ - Calls: gwa-planning-complete --issue N --repo R --plan "..."   │
│                                                                  │
│ Claude's prompt constrains it to analysis only:                   │
│   - DO NOT create files, branches, or commits                    │
│   - DO NOT write code or make changes                            │
│   - DO analyze, explore, and plan                                │
└─────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│ gwa-planning-complete (new CLI tool)                             │
│                                                                  │
│ 1. Post plan as new issue comment                                │
│ 2. Update status comment → "Planning complete. Duration: Xm"    │
│ 3. Update session status → planning_complete                     │
│ 4. Kill tmux window                                              │
│ 5. Remove git worktree                                           │
│ 6. Log activity + telemetry                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Session State Flow

```
pending → running → (blocked → running)* → planning_complete
```

`planning_complete` is a new terminal state distinct from `complete`. It signals that planning finished but implementation hasn't started. The project board item stays in "Planning" column. Moving to "In Progress" triggers the implementation phase which creates a fresh worktree.

### Changes Required

#### 1. `src/transitions/start-planning.ts`

- **Model flag**: Add `--model claude-opus-4-6` to the `claude` REPL launch command
- **Prompt rewrite**: Replace the current file-creation prompt with a plan-analysis-only prompt that:
  - Instructs Claude to analyze the issue and explore the codebase
  - Explicitly prohibits file creation, commits, and pushes
  - Tells Claude to call `gwa-planning-complete` when done with the plan markdown
  - Includes `gwa-ask-question` instructions for clarifying questions
- **Remove plan directory creation**: No longer create `.plans/` directory or copy templates
- **Keep worktree creation**: Claude needs repo access to explore code

#### 2. New `src/planning-complete.ts`

CLI interface:
```
gwa-planning-complete \
  --issue <number> \
  --repo <owner/repo> \
  --plan "<markdown plan text>"
```

Actions:
1. Post plan as a new comment on the GitHub issue
2. Look up `status_comment_id` from session record
3. Update the status comment body to a "Planning complete" template with duration
4. Update session status to `planning_complete` in SQLite
5. Log `planning_completed` activity event
6. Get tmux window from session record, kill it
7. Get worktree path from session record, remove it via `git worktree remove`
8. Shut down telemetry and exit

#### 3. `src/lib/comment-generator.ts`

Add a new comment type `planning_complete`:

```typescript
export interface PlanningCompleteInput {
  type: "planning_complete";
  sessionId: string;
  startedAt?: number;
  completedAt?: number;
}
```

Template for the status comment update:
```
**Planning complete**

| Detail | Value |
|--------|-------|
| Session ID | `{sessionId}` |
| Status | Planning Complete |
| Duration | {duration} |

The plan has been posted as a comment below.
Moving this item to "In Progress" will start implementation.
```

#### 4. `src/lib/state-machine.ts`

Add `planning_complete` as a valid terminal state in the XState machine, reachable from `running` via a `PLANNING_COMPLETE` event.

#### 5. `package.json`

Add `gwa-planning-complete` to the build targets.

#### 6. `Dockerfile`

Add `gwa-planning-complete` binary to the COPY list.

### Planning Prompt

The new planning prompt sent to Claude (written to temp file, read via REPL):

```markdown
You are an architect analyzing a GitHub issue to create an implementation plan.

## Issue #{N}: {title}

{issue body}

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
```
gwa-ask-question --issue {N} --repo {repo} --question "your question"
```
This posts a comment and blocks until the answer arrives.

### When Planning is Complete

Call this tool with your full plan as markdown:
```
gwa-planning-complete --issue {N} --repo {repo} --plan "$(cat <<'PLAN'
## Implementation Plan

[your plan here]
PLAN
)"
```

The plan should include:
1. **Requirements Summary** — what needs to be built
2. **Technical Approach** — architecture decisions, patterns to use
3. **Files to Modify/Create** — specific paths with descriptions
4. **Task Breakdown** — numbered tasks with dependencies
5. **Risks & Considerations** — edge cases, backwards compatibility
```

### Model Selection Context

| Phase | Model | Rationale |
|-------|-------|-----------|
| Planning (this phase) | Opus 4.6 | Architectural analysis requires strongest reasoning |
| Implementation | Sonnet 4.6 | Code writing, tests — good balance of speed/quality |
| Exploration/search subagents | Haiku 4.5 | File search, grep, simple lookups — cheapest |
