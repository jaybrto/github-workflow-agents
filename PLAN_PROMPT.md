# Claude Code CLI Implementation Prompt

**Use this prompt with Claude Code CLI (`claude` command) to generate all artifacts with integrated bash validation.**

---

## Document Version & Changelog

**Version:** 3.4
**Last Updated:** February 10, 2026

### What's New (v3.4)

**🆕 Enhanced Session Fields for Observability:**
5 new custom fields in GitHub Project for better session visibility:
| Field | Type | Purpose |
|-------|------|---------|
| Pod Name | TEXT | K8s pod name (from `hostname`, fallback `POD_NAME` env) |
| Tmux Window | TEXT | Tmux window/pane ID |
| Kubectl Command | TEXT | Full attach command for copy-paste |
| Worktree Path | TEXT | Git worktree location |
| Sub Agents Used | TEXT | Comma-separated spawned agent names |

**🆕 Project Item ID Tracking:**
- Webhook passes `--item-id` to transitions
- Fallback: query GitHub API using issue number
- Stored in SQLite `sessions.project_item_id`

**🆕 Screenshot Lifecycle Management:**
- Always saved to `/tmp/gwa-screenshots/` for troubleshooting
- Tracked in SQLite `screenshots` table
- Attached to comments only on errors/anomalies
- Deleted when session transitions to Done

**🆕 Progress Comments:**
- Posted to issue as work progresses
- Shows active sub-agents, current task, completion %
- Updated when architect spawns workers

**🆕 Enhanced start-planning.ts:**
- Calls `updateSessionFields()` with all new fields
- Posts REPL start comment to issue
- Stores project_item_id in SQLite

---

### What's New (v3.3)

**🆕 Column Transition Trigger Matrix:**
- Not every column move triggers Claude - each has specific action
- Selective triggers: Claude, Playwright, CI/CD, or nothing
- Single workflow routes based on `from` → `to` columns

**🆕 Trigger Types:**
| Transition             | Trigger        | Action                     |
| ---------------------- | -------------- | -------------------------- |
| Todo → Planning        | **Claude**     | Create session, start REPL |
| Planning → In Progress | **Claude**     | Inject `prompt.md`         |
| In Progress → QA       | **Playwright** | Run e2e tests              |
| QA → Review            | None           | Status only                |
| QA → In Progress       | **Claude**     | Resume with failures       |
| Review → Done          | **CI/CD**      | Deploy + cleanup           |
| Any → Blocked          | None           | Session preserved          |
| Blocked → Previous     | **Claude**     | Send answer                |

**🆕 Trigger Scripts:**
- `start-planning-session.sh` - Create Claude session
- `inject-prompt.sh` - Send prompt.md to existing REPL
- `run-playwright.sh` - Run e2e tests (no Claude)
- `deploy-and-cleanup.sh` - CI/CD + destroy session
- `resume-with-failures.sh` - Send test failures to Claude
- `send-answer.sh` - Unblock Claude with answer

---

### What's New (v3.2)

**🆕 Unified Session Lifecycle:**
- **One session per project item** - created at Planning, destroyed at Done
- Session persists through: Planning → In Progress → QA → Review
- Same `claude_session_id` enables `--resume` across all phases
- Human can attach to same tmux window throughout entire lifecycle

**🆕 Session State Mapping:**
| Column      | Session Status | Tmux Windows                      |
| ----------- | -------------- | --------------------------------- |
| Todo        | (none)         | (none)                            |
| Planning    | `running`      | Window 1: planning agent          |
| In Progress | `running`      | Window 1: architect, 2-N: workers |
| QA          | `paused`       | Windows preserved                 |
| Blocked     | `blocked`      | Windows preserved                 |
| Review      | `idle`         | Window 1 preserved                |
| Done        | `completed`    | **All windows destroyed**         |

**🆕 Benefits:**
- Planning context preserved during implementation
- Single session ID for crash recovery
- Worker windows (2,3,4...) ephemeral, architect window (1) persists
- Simpler mental model: item lifecycle = session lifecycle

---

### What's New (v3.1)

**🆕 Planning Templates:**
- Rigid document templates for planning phase in `templates/plans/`
- `plan.md` - Full implementation spec with **agent orchestration section**
- `prompt.md` - Injection prompt templates for architect and workers
- `checklist.md` - Progress tracking with quick commands
- `decisions.md` - Q&A log, design decisions, assumptions
- `snippets.md` - Code context excerpts for worker agents
- Plans instantiated to `.plans/issue-{N}/` per issue

**🆕 Plan-Issue Sync (`src/lib/plan-sync.ts`):**
- Plans surfaced in GitHub issue description with status table
- Collapsible plan summary posted as issue comment
- Progress updates posted during implementation
- Humans can review plans without cloning repo

**🆕 Agent Orchestration in Plans:**
- Task breakdown with skills, dependencies, scope per worker
- Dependency graph defines parallel execution order
- Skills assigned to architect and workers
- Validation criteria ensures task completion

---

### What's New (v3.0)

**🆕 GitHub Projects Integration (Phase 12):**
- Full GitHub Projects v2 integration with GraphQL API
- Project workflow: Todo → Planning → In Progress → QA → Blocked → Review → Done
- Column-based workflow triggers for Claude behavior changes
- 18+ custom fields (Estimated Hours, Complexity, Risk Level, etc.)
- `src/lib/projects.ts` - GraphQL mutations, status updates, sync to custom fields
- `src/lib/pr-filter.ts` - Only trigger on Claude-created PRs (`claude/*` branch + `created-by-claude` label)
- New tables: `project_items`, `implementation_plans`, `qa_runs`

**🆕 Multi-Agent Swarm Architecture (Phase 13):**
- Architect + Worker pattern in same tmux session, multiple windows
- Architect creates implementation plan, spawns workers for parallel execution
- Workers report progress via `agent_tasks` table
- `src/lib/swarm.ts` - Spawn workers, track progress, aggregate results
- New table: `agent_tasks`

**🆕 Planning Mode:**
- Detailed implementation plans stored in `.plans/issue-{N}.md`
- Plans linked in issue description via `implementation_plans` table
- Work breakdown for parallel sub-agent execution

**🆕 QA Automation:**
- Playwright e2e tests triggered when item moves to QA column
- `qa_runs` table tracks test results (passed, failed, skipped)
- Automatic column move to Blocked on test failure

**🆕 Project Onboarding (Phase 14):**
- ArgoCD PostSync hook creates GitHub Project automatically
- `src/setup-project.ts` - Creates project, configures columns, adds custom fields
- Template stored in `templates/github-project.json`
- Helm chart for multi-repo onboarding

### Previous Versions

<details>
<summary><strong>v2.1 - Crash Recovery & Dependency Updates</strong></summary>

**🆕 Crash Recovery & Replay:**
- `src/lib/checkpoint.ts` - State checkpoints before major actions (commits, PRs)
- `conversation_history` table - Ordered log of all messages for replay
- `responses` table - Stores Claude's responses for crash recovery
- `checkpoints` table - Git state, tmux capture, pending actions at checkpoint time
- `claude_session_id` column in sessions - Enables `claude --resume` after crash
- Enhanced `src/lib/recovery.ts` with `buildResumeCommand()` for replay

**🆕 Dependency Updates:**
- `src/lib/updater.ts` - Check/queue/apply updates for Claude CLI and SDKs
- `update_queue` table - Queued updates applied on pod restart
- `dependency_versions` table - Track installed versions
- Weekly CronJob (`claude-update`) for forced refresh
- Entrypoint runs pending updates when no active sessions

**🔄 Redis → SQLite Migration:**
- All session tracking now uses SQLite (WAL mode) on Longhorn PVC
- No Redis dependency - database co-located with session data
- Startup recovery marks stale sessions as "interrupted"

**📸 Lightweight Screenshots:**
- Base64 inline images (<75KB) - no GitHub CDN upload needed
- Uses CLI tools: `aha` (ANSI→HTML), `wkhtmltoimage` (HTML→PNG)
- Conditional vision verification - only calls API when anomalies detected

</details>

---

## Your Prompt to Claude Code CLI

```
I'm using Claude Code CLI to implement a production Claude Code GitHub integration system called Github Workflow Agents (GWA).

## Core Architecture: Interactive REPL (Not Headless)

**Key difference from typical setups:**
- Claude runs as an **interactive REPL** in tmux (stays running)
- NOT headless one-shot execution (`claude --print`)
- Questions don't exit the process - REPL blocks, answer sent via `tmux send-keys`
- Full conversation context preserved across interactions
- Human can attach anytime: `kubectl exec -it ... tmux attach`

**Session lifecycle:**
- Feature work: Issue → Claude works → PR created → session ends
- PR work: PR trigger → Claude reviews/iterates → PR merged → session ends

**When to use headless/SDK instead:**
- Vision verification (isolated API call)
- Quick summaries
- Any task not needing conversation history

## My Infrastructure

**k3s Homelab Details:**
- 6 nodes with varied storage (1TB-4TB Longhorn mounts)
- PostgreSQL HA (3-pod) running at postgres.default.svc.cluster.local
- Longhorn storage with StorageClass "longhorn" already installed
- Traefik ingress, NATS JetStream, DAPR stack
- OPNsense firewall, Cloudflare Zero Trust, dual ISP (AT&T 5Gb + Comcast 2Gb)
- Tech stack: Bun, Go, Node.js (NO Python)
- **SQLite for session tracking** (stored on Longhorn PVC, no Redis needed)

**GitHub Setup:**
- Organization: jaybrto
- Repository: https://github.com/jaybrto/github-workflow-agents.git
- Admin access to settings, secrets, actions

**Current Location:** /Users/jay.barreto/dev/util/bto/github-workflow-agents

## Complete Implementation Plan

@PLAN.md

## Implementation Method: Claude Code CLI with Bash Validation

I want you to implement this using the Write tool to create files and bash_tool to validate.

For each artifact, use this workflow:
1. Write the file using the Write tool
2. Validate using bash_tool with real validation commands
3. Show me the validation results
4. Only confirm "ready to deploy" if validation passes

### Validation Commands to Use

**For YAML files:**
```bash
yamllint <filename>
```

**For Bash scripts:**
```bash
bash -n <filename>
shellcheck <filename>
```

**For Dockerfile:**
```bash
docker build --dry-run -f Dockerfile .
```

## What I Need You to Implement

### Phase 1-2: Infrastructure (Longhorn, StorageClass, PVC)
- [ ] **File:** longhorn-claude-storageclass.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result
  
- [ ] **File:** claude-session-pvc.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result

### Phase 3: StatefulSet & Pod Configuration
- [ ] **File:** claude-runner-configmap.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result
  
- [ ] **File:** claude-runner-statefulset.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result
  
- [ ] **File:** claude-runner-service.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result

### Phase 6: Container Image
- [ ] **File:** Dockerfile
  - Write to file
  - Validate with: docker build --dry-run -f Dockerfile .
  - Show validation result
  
- [ ] **File:** build-and-push.sh
  - Write to file
  - Validate with: bash -n
  - Show validation result

### Phase 7: GitHub Workflows
- [ ] **File:** .github/workflows/claude-code-blocking.yml
  - Write to file
  - Validate with: yamllint
  - Show validation result
  
- [ ] **File:** .github/workflows/claude-code-respond.yml
  - Write to file
  - Validate with: yamllint
  - Show validation result

### Phase 8: Cleanup & Maintenance
- [ ] **File:** claude-cleanup-cronjob.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result
  
- [ ] **File:** claude-cleanup-rbac.yaml
  - Write to file
  - Validate with: yamllint
  - Show validation result

### Phase 9: Repository Configuration
- [ ] **File:** .claude/CLAUDE.md
  - Write to file
  - This is markdown, just verify it exists
  
- [ ] **File:** .claude/commands/process-issue.md
  - Write to file
  - This is markdown, just verify it exists

### Phase 11: Bun CLI Tools & Screenshot Support

**Bun CLI Tools (type-safe, GitHub SDK integration):**

- [ ] **File:** src/lib/db.ts
  - Database initialization and connection
  - Uses: bun:sqlite (built-in, no dependency)
  - WAL mode for concurrent access

- [ ] **File:** src/lib/recovery.ts
  - Startup recovery for interrupted sessions
  - Marks stale "running" sessions as "interrupted"

- [ ] **File:** schema.sql
  - Complete SQLite schema (sessions, questions, prompts, commits, tool_calls, activity_log, screenshots, config)
  - Stored at /home/runner/.claude/schema.sql

- [ ] **File:** src/ask-question.ts
  - Write to file
  - Validate with: bun check (type check)
  - **Called BY Claude from within the REPL** (not calling Claude)
  - Posts question to GitHub, updates SQLite status to "blocked"
  - Polls SQLite for answer, returns it to Claude
  - Includes: Screenshot capture and inline embedding

- [ ] **File:** src/session-complete.ts
  - Write to file
  - Validate with: bun check (type check)
  - **Called BY Claude when work scope is done**
  - Updates SQLite status to "complete"
  - Posts summary to GitHub with final screenshot

- [ ] **File:** src/debug-db.ts
  - Write to file
  - Validate with: bun check (type check)
  - Show validation result
  - Uses: bun:sqlite, console.table for formatting

- [ ] **File:** src/pod-health-check.ts
  - Write to file
  - Validate with: bun check (type check)
  - Show validation result
  - Uses: @octokit/rest, child_process for kubectl

- [ ] **File:** src/lib/screenshot.ts
  - Write to file
  - Validate with: bun check (type check)
  - Captures tmux pane → ANSI → HTML (aha) → PNG (wkhtmltoimage)
  - Compresses to <75KB for GitHub inline base64
  - No heavy dependencies (canvas, sharp) - uses CLI tools

- [ ] **File:** src/lib/vision-verify.ts
  - Write to file
  - Validate with: bun check (type check)
  - Conditional verification - only calls Claude API when anomalies detected
  - Uses Sonnet for cost efficiency (~$0.003/call)
  - Fallback: assume text is valid if vision fails

- [ ] **File:** src/lib/updater.ts
  - Write to file
  - Validate with: bun check (type check)
  - Checks for Claude CLI and SDK updates
  - Queues updates if sessions are active
  - Applies updates on pod startup when safe

- [ ] **File:** src/lib/checkpoint.ts
  - Write to file
  - Validate with: bun check (type check)
  - Creates state checkpoints before major actions (commits, PRs)
  - Stores conversation history for replay
  - Captures Claude CLI session ID for --resume

- [ ] **File:** package.json
  - Create with dependencies: @octokit/rest, @anthropic-ai/sdk, @types/node (SQLite via bun:sqlite built-in)
  - Validate with: bun install --dry-run (verify deps resolve)
  - Show validation result

**Shell Script (pure orchestration):**

- [ ] **File:** scripts/deploy-all.sh
  - Write to file
  - Validate with: bash -n
  - Show validation result
  - No external dependencies, just kubectl/docker commands

### Phase 12: GitHub Projects Integration

- [ ] **File:** src/lib/projects.ts
  - Write to file
  - Validate with: bun check (type check)
  - GraphQL mutations for GitHub Projects v2 API
  - Update item status, sync custom fields, add comments

- [ ] **File:** src/lib/pr-filter.ts
  - Write to file
  - Validate with: bun check (type check)
  - Filter triggers to only Claude-created PRs
  - Checks: branch starts with `claude/*` AND has `created-by-claude` label

- [ ] **File:** src/lib/plan-sync.ts
  - Write to file
  - Validate with: bun check (type check)
  - Links plan files to GitHub issues
  - Posts plan summary as collapsible comment
  - Updates issue description with plan links and status

- [ ] **File:** .github/workflows/project-item-moved.yml
  - Write to file
  - Validate with: yamllint
  - Triggers on project item column changes
  - Routes to Claude, Playwright, CI/CD, or no-op based on transition

- [ ] **File:** scripts/start-planning-session.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Creates Claude session when Todo → Planning
  - Creates tmux window, starts REPL, sends planning prompt

- [ ] **File:** scripts/inject-prompt.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Injects prompt.md when Planning → In Progress
  - Requires plan_approved = true

- [ ] **File:** scripts/run-playwright.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Runs e2e tests when In Progress → QA
  - Pauses Claude session, records results

- [ ] **File:** scripts/deploy-and-cleanup.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Deploys to production when Review → Done
  - Destroys session, removes worktree

- [ ] **File:** scripts/resume-with-failures.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Sends test failures to Claude when QA → In Progress

- [ ] **File:** scripts/send-answer.sh
  - Write to file
  - Validate with: bash -n, shellcheck
  - Sends answer to Claude when Blocked → Previous

- [ ] **File:** templates/plans/plan.md
  - Planning template with agent orchestration section
  - Task breakdown, skills, dependencies, validation

- [ ] **File:** templates/plans/prompt.md
  - Injection prompt template for architect/workers
  - Role-based rendering

- [ ] **File:** templates/plans/checklist.md
  - Progress tracking template
  - Quick commands, validation steps

- [ ] **File:** templates/plans/decisions.md
  - Q&A log, design decisions, assumptions

- [ ] **File:** templates/plans/snippets.md
  - Code context excerpts for workers

### Phase 13: Multi-Agent Swarm Architecture

- [ ] **File:** src/lib/swarm.ts
  - Write to file
  - Validate with: bun check (type check)
  - Architect + Worker pattern management
  - Spawns workers in separate tmux windows
  - Tracks progress via `agent_tasks` table

- [ ] **File:** src/architect.ts
  - Write to file
  - Validate with: bun check (type check)
  - Creates implementation plans from issues
  - Breaks down work for parallel execution
  - Aggregates worker results

- [ ] **File:** src/worker.ts
  - Write to file
  - Validate with: bun check (type check)
  - Executes assigned sub-tasks
  - Reports progress to architect via SQLite

### Phase 14: Project Onboarding

- [ ] **File:** src/setup-project.ts
  - Write to file
  - Validate with: bun check (type check)
  - Creates GitHub Project with configured columns
  - Adds 18+ custom fields
  - Called by ArgoCD PostSync hook

- [ ] **File:** templates/github-project.json
  - Write to file
  - Project template with columns and custom field definitions

- [ ] **File:** k8s/charts/gwa-onboarding/templates/postsync-job.yaml
  - Write to file
  - Validate with: yamllint
  - ArgoCD PostSync hook to run setup-project.ts

### Phase 15: Enhanced Session Fields & Screenshots (v3.4)

**Prerequisites (verify first):**
- [ ] SQLite database initialized: `kubectl exec gwa-runner-0 -- sqlite3 /home/runner/gwa.db ".tables"`
- [ ] gwa-* binaries exist: `kubectl exec gwa-runner-0 -- ls /usr/local/bin/gwa-*`
- [ ] Basic REPL flow works: Move test issue Todo → Planning

**Schema Migration:**
- [ ] **Run:** `ALTER TABLE sessions ADD COLUMN project_item_id TEXT;`
- [ ] **Run:** `CREATE INDEX idx_sessions_project_item ON sessions(project_item_id);`

**Update templates/github-project.json:**
- [ ] Add 5 new custom fields after existing 18:
  - Pod Name (TEXT) - "Name of the K8s pod running this session"
  - Tmux Window (TEXT) - "Tmux window/pane ID for this session"
  - Kubectl Command (TEXT) - "Full command to attach to the running session"
  - Worktree Path (TEXT) - "Git worktree path for this session"
  - Sub Agents Used (TEXT) - "Comma-separated names of spawned Claude sub-agents"

**Update src/lib/projects.ts:**
- [ ] Add to CUSTOM_FIELDS constant:
  ```typescript
  POD_NAME: "Pod Name",
  TMUX_WINDOW: "Tmux Window",
  KUBECTL_COMMAND: "Kubectl Command",
  WORKTREE_PATH: "Worktree Path",
  SUB_AGENTS_USED: "Sub Agents Used",
  ```
- [ ] Extend updateSessionFields() to accept:
  - podName?: string
  - tmuxWindow?: string
  - kubectlCommand?: string
  - worktreePath?: string
  - subAgentsUsed?: string

**Update src/transitions/start-planning.ts:**
- [ ] Import `os` for hostname
- [ ] Get pod name: `const podName = os.hostname() || process.env.POD_NAME || "unknown";`
- [ ] Accept `--item-id` arg from webhook
- [ ] If no item-id, query GitHub API: getProjectItem(projectId, issueNumber, owner, repo)
- [ ] Store project_item_id in SQLite: add to createSession() call
- [ ] Build kubectl command: `kubectl exec -it ${podName} -- tmux attach -t gwa-work:${windowNum}`
- [ ] Call updateSessionFields() with all new fields
- [ ] Call generateComment() with type "repl_start"
- [ ] Post comment to issue via octokit.issues.createComment()

**Update src/lib/screenshot.ts:**
- [ ] Add saveScreenshotToDisk() function:
  ```typescript
  export async function saveScreenshotToDisk(
    sessionId: string,
    buffer: Buffer,
    eventType: "question" | "completion" | "error" | "progress"
  ): Promise<string>
  ```
- [ ] Save to /tmp/gwa-screenshots/{sessionId}-{eventType}-{timestamp}.png
- [ ] Insert into screenshots table with session_id, file_path, file_size, event_type
- [ ] Return file path

**Update src/transitions/deploy-and-cleanup.ts:**
- [ ] Add cleanupSessionScreenshots() function:
  ```typescript
  async function cleanupSessionScreenshots(sessionId: string): Promise<void>
  ```
- [ ] Query screenshots table for session_id
- [ ] Delete each file from disk
- [ ] Delete records from screenshots table
- [ ] Call this function before session cleanup

**Update src/lib/swarm.ts:**
- [ ] When spawning worker, get current subAgentsUsed from project item
- [ ] Append new agent name to list
- [ ] Call updateSessionFields() with updated subAgentsUsed
- [ ] Post progress comment with new agent info

**Update src/lib/comment-generator.ts:**
- [ ] Add ProgressInput interface:
  ```typescript
  export interface ProgressInput {
    type: "progress";
    sessionId: string;
    message: string;
    subAgents?: string[];
    currentTask?: string;
    tasksCompleted?: number;
    tasksTotal?: number;
  }
  ```
- [ ] Add generateProgressComment() function
- [ ] Add "progress" to CommentInput union type

## Output Format

For each artifact, provide:

1. **File path and name:** Where it goes (relative to /Users/jay.barreto/dev/util/bto/github-workflow-agents/)
2. **File content:** Complete, ready-to-use
3. **Validation:** Run the validation command using bash_tool
4. **Validation result:** Show pass/fail with output
5. **Next step:** Which file comes next

## Delivery Order (Phase by Phase)

**Phase 1-2 First (Infrastructure):**
1. longhorn-claude-storageclass.yaml
2. claude-session-pvc.yaml
→ Wait for me to confirm before moving to Phase 3

**Phase 3 (StatefulSet):**
1. claude-runner-configmap.yaml
2. claude-runner-statefulset.yaml
3. claude-runner-service.yaml
→ Wait for me to confirm before moving to Phase 6

**Phase 6 (Container):**
1. Dockerfile
2. build-and-push.sh
→ Wait for me to confirm before moving to Phase 7

**Phase 7 (Workflows):**
1. .github/workflows/claude-code-blocking.yml
2. .github/workflows/claude-code-respond.yml
→ Wait for me to confirm before moving to Phase 8

**Phase 8 (Cleanup):**
1. claude-cleanup-cronjob.yaml
2. claude-cleanup-rbac.yaml
→ Wait for me to confirm before moving to Phase 9

**Phase 9 (Config):**
1. .claude/CLAUDE.md
2. .claude/commands/process-issue.md
→ Wait for me to confirm before moving to Phase 11

**Phase 11 (Tools for Interactive REPL):**
1. package.json (Bun dependencies: @octokit/rest, @anthropic-ai/sdk)
2. schema.sql (Complete SQLite schema including responses, checkpoints, conversation_history)
3. src/lib/db.ts (Database init, WAL mode, connection)
4. src/lib/recovery.ts (Startup recovery, resume command builder)
5. src/lib/screenshot.ts (tmux capture → PNG → base64)
6. src/lib/vision-verify.ts (conditional Claude vision verification)
7. src/lib/updater.ts (dependency update logic, queue/apply updates)
8. src/lib/checkpoint.ts (state checkpoints, conversation history, Claude session capture)
9. src/ask-question.ts (called BY Claude to post questions, polls SQLite for answer)
10. src/session-complete.ts (called BY Claude to signal work done)
11. src/debug-db.ts (SQLite state inspection)
12. src/pod-health-check.ts (structured health checks)
13. scripts/deploy-all.sh (Shell — pure orchestration)
→ Wait for me to confirm before moving to Phase 12

**Phase 12 (GitHub Projects Integration):**
1. src/lib/projects.ts (GraphQL API, status updates, custom fields)
2. src/lib/pr-filter.ts (Claude-created PR detection)
3. .github/workflows/project-sync.yml (column change triggers)
→ Wait for me to confirm before moving to Phase 13

**Phase 13 (Multi-Agent Swarm):**
1. src/lib/swarm.ts (Architect + Worker pattern, tmux windows)
2. src/architect.ts (Plan creation, worker spawning)
3. src/worker.ts (Sub-task execution, progress reporting)
→ Wait for me to confirm before moving to Phase 14

**Phase 14 (Project Onboarding):**
1. templates/github-project.json (Project template)
2. src/setup-project.ts (Project creation, custom fields)
3. k8s/charts/gwa-onboarding/templates/postsync-job.yaml (ArgoCD hook)
→ Wait for me to confirm before moving to Phase 15

**Phase 15 (Enhanced Session Fields & Screenshots - v3.4):**
1. Verify prerequisites (SQLite init, binaries, basic flow)
2. Run schema migration (add project_item_id column)
3. Update templates/github-project.json (add 5 new custom fields)
4. Update src/lib/projects.ts (CUSTOM_FIELDS + updateSessionFields)
5. Update src/transitions/start-planning.ts (field updates + comment posting)
6. Update src/lib/screenshot.ts (add saveScreenshotToDisk)
7. Update src/transitions/deploy-and-cleanup.ts (screenshot cleanup)
8. Update src/lib/swarm.ts (track sub-agents, update fields)
9. Update src/lib/comment-generator.ts (add progress comment type)

## Key Constraints

- Use yamllint for YAML validation (real tool, not simulation)
- Use bash -n for bash script syntax checking
- Use docker build --dry-run for Dockerfile validation
- Only say "ready to deploy" if validation passes
- Longhorn persistence at /home/runner/.claude/
- Worktrees at /home/runner/worktrees/pr-{NUMBER}/
- Session data stored in SQLite on Longhorn PVC
- No Python - only Bun/Go/Node.js
- Bun CLI tools compiled to standalone binaries in Dockerfile
- External service interactions (GitHub API, SQLite) use Bun TypeScript with SDKs
- Pure orchestration scripts (kubectl, docker) stay as shell
- package.json dependencies: @octokit/rest, @anthropic-ai/sdk (SQLite is built into Bun)
- Session data AND workflow state on Longhorn (SQLite database)

### Screenshot Constraints

- GitHub inline base64 images limited to ~75KB (65535 char limit / 1.37 encoding overhead)
- No GitHub CDN upload API available - must use inline base64
- Use lightweight CLI tools (aha, wkhtmltoimage) instead of heavy npm packages (canvas, sharp)
- Only capture screenshots on major events (questions, completion, errors) - not on every thinking step
- Vision verification is conditional - only call Claude API when text heuristics detect anomalies
- Fallback gracefully if screenshot capture fails - it's a debugging aid, not critical path

## Validation as You Go

After each phase, I'll tell you:
- ✅ "Looks good, continue" → Move to next phase
- ❌ "I need to modify X" → You adjust and re-validate
- 🤔 "Explain this section" → You clarify the artifact

---

## Let's Start

**Begin with Phase 1-2 (Infrastructure).**

For each file:
1. Write to /Users/jay.barreto/dev/util/bto/github-workflow-agents/
2. Validate yaml with yamllint
3. Validate shell with shellcheck
4. Validate typescript with "bun run --filter 'src/*' typecheck"
5. Show validation output
6. Say "Phase 1-2 ready to deploy" when both pass

Ready? Start with longhorn-claude-storageclass.yaml.
```

### Step 2: Start Claude Code CLI

```bash
cc
```

### Step 3: Paste the Prompt

1. **Copy the prompt above** (the triple-backtick section starting with "I'm using Claude Code CLI...")
2. **Replace placeholders:**
   - `jaybrto` - Your GitHub organization
   - `https://github.com/jaybrto/github-workflow-agents.git` - Your repository name
3. **Append the full implementation plan** - Copy-paste the entire `Claude_Code_Complete_Implementation_Plan.md` file
4. **Paste into Claude Code CLI** and press Enter

### Step 4: Claude Generates with Validation

Claude will:
1. **Write files** to /Users/jay.barreto/dev/util/bto/github-workflow-agents/ using Write tool
2. **Validate each** using bash_tool (yamllint, bash -n, docker build --dry-run, etc.)
3. **Show results** - you see the validation output
4. **Ask for confirmation** - "Ready to move to next phase?"

### Step 5: Files Are Ready

After Claude completes each phase:

```bash
# Check what was created
ls -la /Users/jay.barreto/dev/util/bto/github-workflow-agents/

# All files are validated and production-ready
```

---

## Workflow During Implementation

**Claude's process for each artifact:**

```
📝 Write longhorn-claude-storageclass.yaml
   ↓
✅ Validate: yamllint longhorn-claude-storageclass.yaml
   ↓
📊 Show validation result: "✅ YAML is valid"
   ↓
▶️ Move to next artifact
```

**Example of what you'll see:**

```
Writing file: longhorn-claude-storageclass.yaml

Validating with yamllint...
✅ No YAML errors found

Validation passed! This file is ready to deploy.

Next: Creating claude-session-pvc.yaml...
```

---

## What You'll Get Back

After Claude finishes (usually 20-30 minutes per phase):

```
/Users/jay.barreto/dev/util/bto/github-workflow-agents/
├── longhorn-claude-storageclass.yaml    ✅ Validated
├── claude-session-pvc.yaml              ✅ Validated
├── claude-runner-configmap.yaml         ✅ Validated
├── claude-runner-statefulset.yaml       ✅ Validated
├── claude-runner-service.yaml           ✅ Validated
├── Dockerfile                           ✅ Validated
├── package.json                         ✅ Validated
├── build-and-push.sh                    ✅ Validated
├── schema.sql                           ✅ SQLite schema
├── src/
│   ├── ask-question.ts                  ✅ Validated (called BY Claude from REPL)
│   ├── session-complete.ts              ✅ Validated (signals work done)
│   ├── debug-db.ts                      ✅ Validated (SQLite inspection)
│   ├── pod-health-check.ts              ✅ Validated
│   ├── architect.ts                     ✅ Validated (plan creation, worker spawning)
│   ├── worker.ts                        ✅ Validated (sub-task execution)
│   ├── setup-project.ts                 ✅ Validated (GitHub Project creation)
│   └── lib/
│       ├── db.ts                        ✅ Validated (SQLite connection, WAL mode)
│       ├── recovery.ts                  ✅ Validated (startup recovery, resume builder)
│       ├── screenshot.ts                ✅ Validated (tmux → PNG → base64)
│       ├── vision-verify.ts             ✅ Validated (conditional Claude vision)
│       ├── updater.ts                   ✅ Validated (dependency updates)
│       ├── checkpoint.ts                ✅ Validated (crash recovery, replay)
│       ├── projects.ts                  ✅ Validated (GitHub Projects v2 GraphQL)
│       ├── pr-filter.ts                 ✅ Validated (Claude-created PR detection)
│       ├── plan-sync.ts                 ✅ Validated (plan-issue linking)
│       └── swarm.ts                     ✅ Validated (Architect + Worker pattern)
├── .github/
│   └── workflows/
│       ├── claude-code-blocking.yml     ✅ Validated
│       ├── claude-code-respond.yml      ✅ Validated
│       └── project-item-moved.yml       ✅ Validated (column transition triggers)
├── scripts/
│   ├── deploy-all.sh                    ✅ Validated
│   ├── start-planning-session.sh        ✅ Validated (Todo → Planning)
│   ├── inject-prompt.sh                 ✅ Validated (Planning → In Progress)
│   ├── run-playwright.sh                ✅ Validated (In Progress → QA)
│   ├── deploy-and-cleanup.sh            ✅ Validated (Review → Done)
│   ├── resume-with-failures.sh          ✅ Validated (QA → In Progress)
│   └── send-answer.sh                   ✅ Validated (Blocked → Previous)
├── templates/
│   ├── github-project.json              ✅ Project template
│   └── plans/
│       ├── plan.md                      ✅ Implementation plan template
│       ├── prompt.md                    ✅ Agent injection prompt template
│       ├── checklist.md                 ✅ Progress tracking template
│       ├── decisions.md                 ✅ Q&A and decisions template
│       └── snippets.md                  ✅ Code context template
├── k8s/
│   └── charts/
│       └── gwa-onboarding/
│           └── templates/
│               └── postsync-job.yaml    ✅ Validated (ArgoCD hook)
├── claude-cleanup-cronjob.yaml          ✅ Validated
└── claude-cleanup-rbac.yaml             ✅ Validated
```

**All files are validated and ready to deploy.**

---

## After Implementation

Once Claude finishes all phases:

```bash
# You're in /Users/jay.barreto/dev/util/bto/github-workflow-agents/

# Install Bun dependencies (needed for Docker build)
bun install

# Build and push container (includes Bun tool compilation)
docker build -t your-registry/claude-runner:latest .
docker push your-registry/claude-runner:latest

# Deploy infrastructure
kubectl apply -f longhorn-claude-storageclass.yaml
kubectl apply -f claude-session-pvc.yaml

# Deploy StatefulSet and services
kubectl apply -f claude-runner-*.yaml

# Deploy cleanup job
kubectl apply -f claude-cleanup-*.yaml

# Deploy using orchestration script
bash scripts/deploy-all.sh

# All done! Ready to test.
```

---

## Pro Tips for Working with Claude Code CLI

1. **Ask for validation explicitly** - If Claude doesn't validate, ask: "Can you validate this with bash_tool?"
2. **Request debugging scripts** - Ask for shell scripts to inspect state as you go
3. **Review before deploying** - Ask Claude: "Is this production-ready?" before you kubectl apply
4. **Iterative feedback** - After each phase: "This looks good, move to next phase" or "I need to adjust X"
5. **Keep your terminal clear** - See validation results clearly as they appear

---

## Phase 15 Only Prompt (v3.4 - Enhanced Session Fields & Screenshots)

**Use this prompt if earlier phases are already complete and you only need to implement Phase 15.**

```
I'm implementing Phase 15 (v3.4) of the GitHub Workflow Agents (GWA) project - Enhanced Session Fields & Screenshots.

## Current State
- Phases 1-14 are complete (infrastructure, StatefulSet, workflows, projects integration)
- Webhook and state machine are functional
- gwa-* binaries are deployed to the pod
- Need to: initialize SQLite, verify REPL flow, add new custom fields, enhance screenshots

## Working Directory
/Users/jay.barreto/dev/util/bto/github-workflow-agents

## What I Need You to Implement

### Step 1: Prerequisites Verification
First, verify the pod is ready:
```bash
# Check binaries exist
kubectl exec gwa-runner-0 -- ls /usr/local/bin/gwa-*

# Check if SQLite is initialized
kubectl exec gwa-runner-0 -- sqlite3 /home/runner/gwa.db ".tables"

# If no tables, initialize:
kubectl cp schema.sql gwa-runner-0:/tmp/schema.sql
kubectl exec gwa-runner-0 -- sqlite3 /home/runner/gwa.db < /tmp/schema.sql
```

### Step 2: Schema Migration
Add project_item_id column to sessions table:
```sql
ALTER TABLE sessions ADD COLUMN project_item_id TEXT;
CREATE INDEX idx_sessions_project_item ON sessions(project_item_id);
```

### Step 3: Update templates/github-project.json
Add 5 new custom fields after the existing 18:
- Pod Name (TEXT) - "Name of the K8s pod running this session"
- Tmux Window (TEXT) - "Tmux window/pane ID for this session"
- Kubectl Command (TEXT) - "Full command to attach to the running session"
- Worktree Path (TEXT) - "Git worktree path for this session"
- Sub Agents Used (TEXT) - "Comma-separated names of spawned Claude sub-agents"

### Step 4: Update src/lib/projects.ts
1. Add to CUSTOM_FIELDS constant:
   - POD_NAME: "Pod Name"
   - TMUX_WINDOW: "Tmux Window"
   - KUBECTL_COMMAND: "Kubectl Command"
   - WORKTREE_PATH: "Worktree Path"
   - SUB_AGENTS_USED: "Sub Agents Used"

2. Extend updateSessionFields() to accept:
   - podName?: string
   - tmuxWindow?: string
   - kubectlCommand?: string
   - worktreePath?: string
   - subAgentsUsed?: string

### Step 5: Update src/transitions/start-planning.ts
1. Import `os` module for hostname
2. Get pod name: `const podName = os.hostname() || process.env.POD_NAME || "unknown";`
3. Accept `--item-id` argument from webhook
4. If no item-id provided, query GitHub API using getProjectItem()
5. Store project_item_id in SQLite sessions table
6. Build kubectl command: `kubectl exec -it ${podName} -- tmux attach -t gwa-work:${windowNum}`
7. Call updateSessionFields() with all new fields
8. Call generateComment() with type "repl_start"
9. Post comment to issue via octokit.issues.createComment()

### Step 6: Update src/lib/screenshot.ts
Add saveScreenshotToDisk() function:
```typescript
export async function saveScreenshotToDisk(
  sessionId: string,
  buffer: Buffer,
  eventType: "question" | "completion" | "error" | "progress"
): Promise<string> {
  const timestamp = Date.now();
  const filename = `${sessionId}-${eventType}-${timestamp}.png`;
  const dir = "/tmp/gwa-screenshots";
  const filePath = `${dir}/${filename}`;

  // Ensure directory exists
  await Bun.write(`${dir}/.gitkeep`, "");
  await Bun.write(filePath, buffer);

  // Track in SQLite
  const db = getDatabase();
  db.run(`
    INSERT INTO screenshots (session_id, file_path, file_size, event_type)
    VALUES (?, ?, ?, ?)
  `, [sessionId, filePath, buffer.length, eventType]);

  return filePath;
}
```

### Step 7: Update src/transitions/deploy-and-cleanup.ts
Add cleanupSessionScreenshots() function:
```typescript
async function cleanupSessionScreenshots(sessionId: string): Promise<void> {
  const db = getDatabase();
  const screenshots = db.query(`
    SELECT file_path FROM screenshots WHERE session_id = ?
  `).all(sessionId) as { file_path: string }[];

  for (const { file_path } of screenshots) {
    try {
      await unlink(file_path);
      log("debug", `Deleted screenshot: ${file_path}`);
    } catch {
      // Ignore if already deleted
    }
  }

  db.run(`DELETE FROM screenshots WHERE session_id = ?`, [sessionId]);
  log("info", `Cleaned up ${screenshots.length} screenshots for session ${sessionId}`);
}
```
Call this function during session cleanup.

### Step 8: Update src/lib/swarm.ts
When spawning a worker:
1. Get current subAgentsUsed from project item or SQLite
2. Append new agent name to comma-separated list
3. Call updateSessionFields() with updated subAgentsUsed
4. Post progress comment showing new agent

### Step 9: Update src/lib/comment-generator.ts
Add progress comment type:
```typescript
export interface ProgressInput {
  type: "progress";
  sessionId: string;
  message: string;
  subAgents?: string[];
  currentTask?: string;
  tasksCompleted?: number;
  tasksTotal?: number;
}

function generateProgressComment(input: ProgressInput): string {
  let comment = `🔄 **Progress Update**\n\n${input.message}\n`;

  if (input.subAgents?.length) {
    comment += `\n**Active Agents:** ${input.subAgents.join(", ")}\n`;
  }
  if (input.currentTask) {
    comment += `\n**Current Task:** ${input.currentTask}\n`;
  }
  if (input.tasksTotal) {
    const pct = Math.round(((input.tasksCompleted || 0) / input.tasksTotal) * 100);
    comment += `\n**Progress:** ${input.tasksCompleted || 0}/${input.tasksTotal} tasks (${pct}%)\n`;
  }

  return comment;
}
```
Add "progress" to CommentInput union type.

## Validation
After each file modification:
1. Run type check: `bun run typecheck`
2. Run tests: `bun test`
3. Show validation results

## Key Constraints
- Pod name: Use `os.hostname()`, fallback to `POD_NAME` env var
- Screenshots: Always save to /tmp/gwa-screenshots/, attach to comments only on errors
- Project item ID: Get from webhook `--item-id`, fallback to GitHub API query
- Sub agents: Update field as soon as workers are spawned
- Tech stack: Bun, TypeScript only (NO Python)

## Delivery Order
1. Verify prerequisites
2. Run schema migration
3. templates/github-project.json
4. src/lib/projects.ts
5. src/transitions/start-planning.ts
6. src/lib/screenshot.ts
7. src/transitions/deploy-and-cleanup.ts
8. src/lib/swarm.ts
9. src/lib/comment-generator.ts

Start with Step 1 - Prerequisites Verification.
```
