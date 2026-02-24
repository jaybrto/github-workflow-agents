# Quick Reference & Deployment Checklist

**Keep this handy during implementation and ongoing operations.**

---

## Implementation with Claude Code CLI

### Before Starting Claude

```bash
# 1. Create implementation directory
mkdir -p ~/claude-implementation
cd ~/claude-implementation

# 2. Verify validation tools
yamllint --version
bash -V
docker --version
python3 -c "import yaml; print('yaml available')"

# 3. Start Claude Code CLI
claude
```

### During Claude Implementation

**Claude will:**
- Write files using Write tool → saves to ~/claude-implementation/
- Validate using bash_tool → runs yamllint, bash -n, docker build --dry-run
- Show you validation results
- Ask "Ready for next phase?"

**You should:**
- Watch validation output
- Ask questions if something seems wrong
- Say "Continue to next phase" when ready
- Never manually edit files Claude creates (let Claude fix issues)

### After Claude Completes Each Phase

```bash
# Check what was created
ls -la ~/claude-implementation/

# Verify files exist and are validated
cat <filename>  # Review if needed
```

---

## Architecture at a Glance

### Core Concept: Interactive REPL (Not Headless)

```
┌─────────────────────────────────────────────────────────────┐
│  GitHub (Issues/PRs)                                         │
│  ├─ Issue assigned → Feature session starts                  │
│  ├─ PR created → PR session starts                           │
│  └─ @claude-answer: → Answer sent to running REPL            │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  GitHub Actions (self-hosted runner)                         │
│  ├─ .github/workflows/claude-code-blocking.yml               │
│  │   └─ Starts REPL, sends prompt, polls SQLite for status   │
│  └─ .github/workflows/claude-code-respond.yml                │
│      └─ Sends answer to running REPL via tmux send-keys      │
└──────────────┬──────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────┐
│  k3s Cluster (default namespace)                             │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  StatefulSet: claude-runner-0                        │    │
│  │  ├─ 1 persistent pod per repo                        │    │
│  │  ├─ Mount: /home/runner/.claude/ (Longhorn)          │    │
│  │  ├─ Process: tmux session (claude-work)              │    │
│  │  │  ├─ window 0: status monitor                      │    │
│  │  │  ├─ window 1: Issue #42 → Interactive REPL 🔄     │    │
│  │  │  ├─ window 2: PR #123 → Interactive REPL 🔄       │    │
│  │  │  └─ ... (each window = one Claude REPL)           │    │
│  │  └─ Storage: 50Gi Longhorn PVC                       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  SQLite Database (on Longhorn PVC)                   │    │
│  │  └─ /home/runner/.claude/gwa.db                      │    │
│  │     ├─ sessions: status, tmux_window, repl_active    │    │
│  │     ├─ questions: question, answer, status           │    │
│  │     ├─ activity_log: full audit trail                │    │
│  │     └─ Workflow polls via kubectl exec sqlite3       │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Longhorn PVC: claude-session-pvc (50Gi)             │    │
│  │  └─ Persists ~/.claude/ across pod restarts          │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Execution Modes

| Mode | Use Case | How |
|------|----------|-----|
| **Interactive REPL** | Primary work (features, PR review) | `claude` in tmux, long-lived |
| **Headless** | Quick isolated tasks | `claude --print "task"` |
| **SDK** | Vision verification, summaries | `@anthropic-ai/sdk` API calls |

### Session Lifecycle (v3.2)

**One session per project item** - created at Planning, destroyed at Done.

```
┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌────┐    ┌────────┐    ┌──────┐
│  Todo   │ →  │ Planning │ →  │ In Progress │ →  │ QA │ →  │ Review │ →  │ Done │
└─────────┘    └──────────┘    └─────────────┘    └────┘    └────────┘    └──────┘
     │              │                 │              │           │           │
  (none)      SESSION           SAME SESSION      PAUSED       IDLE      DESTROYED
              CREATED           continues         (tests)    (review)    (cleanup)
            (window 1)        (windows 2-N)
```

| Column | Session Status | Tmux Windows | REPL Active |
|--------|---------------|--------------|-------------|
| Todo | (none) | (none) | No |
| Planning | `running` | Window 1: planning agent | Yes |
| In Progress | `running` | Window 1: architect, 2-N: workers | Yes |
| QA | `paused` | All windows preserved | No |
| Blocked | `blocked` | All windows preserved | No |
| Review | `idle` | Window 1 preserved | No |
| Done | `completed` | **All destroyed** | No |

**Key:** Session ID stays same from Planning → Done. Use `claude --resume {session_id}` to recover.

### Column Transition Triggers (v3.3)

Not every column move triggers Claude. Each transition has a specific action:

| Transition | Trigger | Script | Action |
|------------|---------|--------|--------|
| Todo → Planning | **Claude** | `start-planning-session.sh` | Create session |
| Planning → In Progress | **Claude** | `inject-prompt.sh` | Inject prompt.md |
| In Progress → QA | **Playwright** | `run-playwright.sh` | Run e2e tests |
| QA → Review | None | - | Status only |
| QA → In Progress | **Claude** | `resume-with-failures.sh` | Resume |
| Review → Done | **CI/CD** | `deploy-and-cleanup.sh` | Deploy + destroy |
| Any → Blocked | None | - | Preserved |
| Blocked → Previous | **Claude** | `send-answer.sh` | Send answer |

**Tooling Approach:** Hybrid Shell + Bun
- **Bun TypeScript** (compiled to binaries): `gwa-orchestrate`, `gwa-respond`, `gwa-cleanup`, `gwa-debug-db`, `gwa-health-check`, `gwa-ask-question`, `gwa-session-complete`, `gwa-architect`, `gwa-worker`, `gwa-setup-project`, `gwa-start-planning`, `gwa-inject-prompt`, `gwa-run-playwright`, `gwa-resume-with-failures`, `gwa-send-answer`, `gwa-deploy-and-cleanup`, `gwa-terminal-relay`, `gwa-webhook`, `gwa-credentials-backup`, `gwa-push-credentials`, `gwa-provision`, `gwa-credential-history`, `gwa-provision-environment`, `gwa-planning-complete`
- **Bun Libraries**: `src/lib/screenshot.ts`, `src/lib/vision-verify.ts`
- **Shell scripts** (pure orchestration): `deploy-all.sh`
- **Screenshot capture**: tmux → aha (ANSI→HTML) → wkhtmltoimage (PNG) → base64 inline

---

## Deployment Phases Checklist

### ✅ Pre-Deployment
- [x] k3s cluster accessible (`kubectl get nodes`)
- [x] Longhorn installed (`kubectl get sc longhorn`)
- [x] GitHub CLI installed and authenticated (`gh auth status`)
- [x] Claude Code CLI installed (`claude --version`)
- [x] Validation tools installed:
  - [x] `yamllint --version`
  - [x] `bash -V`
  - [x] `docker --version`
  - [x] `python3 -c "import yaml"`
- [x] Implementation directory created (`mkdir -p ~/claude-implementation`)
- [x] Container registry access (for pushing image)
- [x] Bun installed (`bun --version`)
- [x] Screenshot tools available (for Dockerfile): `aha`, `wkhtmltopdf`

**Note:** Redis is NOT required - using SQLite on Longhorn PVC instead.

### ✅ Phase 1: Infrastructure
- [x] StorageClass created (`kubectl get sc longhorn-claude`)
- [x] PVC created (`kubectl get pvc claude-session-pvc` → Bound)
- [x] PVC size: 50Gi ✓

### ✅ Phase 2: Container Image
- [x] Dockerfile reviewed and customized
- [x] Image built locally or in CI
- [x] Bun dependencies installed (`bun install` before build)
- [x] Bun tools compile successfully (check Docker build logs)
- [x] Image pushed to registry
- [x] Registry URL updated in StatefulSet

### ✅ Phase 3: StatefulSet & Pod
- [x] ConfigMap deployed (`kubectl get cm claude-runner-init`)
- [x] StatefulSet deployed (`kubectl get statefulset claude-runner`)
- [x] Pod running (`kubectl get pods -l app=claude-runner` → Running)
- [x] PVC mounted correctly (`kubectl exec claude-runner-0 -- ls /home/runner/.claude/`)
- [x] tmux session exists (`kubectl exec claude-runner-0 -- tmux list-windows -t claude-work`)

### ✅ Phase 4: SQLite Database
- [x] Schema file exists (`/home/runner/.claude/schema.sql`)
- [x] Database initialized (`/home/runner/.claude/gwa.db`)
- [x] WAL mode enabled
- [x] Startup recovery tested

### ✅ Phase 5: GitHub Configuration
- [x] Claude GitHub App installed
- [x] OAuth token added to secrets (`gh secret list` → CLAUDE_CODE_OAUTH_TOKEN)
- [x] GitHub PAT added to secrets

### ✅ Phase 7: GitHub Workflows
- [x] `.github/workflows/claude-code-blocking.yml` committed
- [x] `.github/workflows/claude-code-respond.yml` committed
- [x] Workflows visible in GitHub Actions UI

### ✅ Phase 8: Cleanup
- [x] CronJob deployed (`kubectl get cronjob claude-cleanup`)
- [x] RBAC created (`kubectl get sa claude-cleanup`)
- [x] Cleanup job can access pods

### ✅ Phase 9: Repository Config
- [x] `.claude/CLAUDE.md` created and committed
- [x] `.claude/commands/` directory created
- [x] Commands documented

### ✅ Phase 10: Testing
- [x] Test 1: Create test PR, watch workflow trigger
- [x] Test 2: Verify worktree created in pod
- [x] Test 3: Check tmux window created
- [x] Test 4: Verify SQLite session tracking
- [x] Test 5: Test @claude-answer response
- [x] Test 6: Verify screenshots appear in PR comments (question/completion)
- [x] Test 7: Confirm screenshot size <75KB (check base64 length in comment)

---

## Claude Code CLI Implementation Phases

**Track Claude's progress as it generates and validates artifacts:**

### ✅ Claude Phase 1-2: Infrastructure
- [x] Claude generates: longhorn-claude-storageclass.yaml
- [x] Claude validates with: yamllint
- [x] Status: Generated ✅ Validated ✅
- [x] Claude generates: claude-session-pvc.yaml
- [x] Claude validates with: yamllint
- [x] Status: Generated ✅ Validated ✅

### ✅ Claude Phase 3: StatefulSet & Pod
- [x] Claude generates: claude-runner-configmap.yaml (Validated ✅)
- [x] Claude generates: claude-runner-statefulset.yaml (Validated ✅)
- [x] Claude generates: claude-runner-service.yaml (Validated ✅)

### ✅ Claude Phase 6: Container Image
- [x] Claude generates: Dockerfile (Validated with: docker build --dry-run ✅)
- [x] Claude generates: build-and-push.sh (Validated with: bash -n ✅)

### ✅ Claude Phase 7: GitHub Workflows
- [x] Claude generates: .github/workflows/claude-code-blocking.yml (Validated ✅)
- [x] Claude generates: .github/workflows/claude-code-respond.yml (Validated ✅)

### ✅ Claude Phase 8: Cleanup
- [x] Claude generates: claude-cleanup-cronjob.yaml (Validated ✅)
- [x] Claude generates: claude-cleanup-rbac.yaml (Validated ✅)

### ✅ Claude Phase 9: Repository Config
- [x] Claude generates: .claude/CLAUDE.md (Created ✅)
- [x] Claude generates: .claude/commands/process-issue.md (Created ✅)
- [x] Claude generates: .claude/commands/review-pr.md (Created ✅)

### ✅ Claude Phase 11: Bun CLI Tools for Interactive REPL
- [x] Claude generates: package.json (Bun deps + @anthropic-ai/sdk — Validated ✅)
- [x] Claude generates: schema.sql (Complete SQLite schema — Validated ✅)
- [x] Claude generates: src/lib/db.ts (SQLite connection, WAL mode — Validated ✅)
- [x] Claude generates: src/lib/recovery.ts (Startup recovery — Validated ✅)
- [x] Claude generates: src/lib/screenshot.ts (tmux → PNG → base64 — Validated ✅)
- [x] Claude generates: src/lib/vision-verify.ts (conditional vision — Validated ✅)
- [x] Claude generates: src/lib/updater.ts (dependency updates — Validated ✅)
- [x] Claude generates: src/lib/checkpoint.ts (crash recovery, replay — Validated ✅)
- [x] Claude generates: src/ask-question.ts (**called BY Claude** to post questions — Validated ✅)
- [x] Claude generates: src/session-complete.ts (**called BY Claude** when done — Validated ✅)
- [x] Claude generates: src/debug-db.ts (SQLite inspection — Validated ✅)
- [x] Claude generates: src/pod-health-check.ts (structured health checks — Validated ✅)
- [x] Claude generates: scripts/deploy-all.sh (Shell orchestration — Validated ✅)

### ✅ Claude Phase 12: GitHub Projects Integration
- [x] Claude generates: src/lib/projects.ts (GraphQL API, status updates — Validated ✅)
- [x] Claude generates: src/lib/pr-filter.ts (Claude-created PR detection — Validated ✅)
- [x] Claude generates: src/lib/plan-sync.ts (plan-issue linking — Validated ✅)
- [x] Claude generates: .github/workflows/project-sync.yml (column triggers — Validated ✅)
- [x] Claude generates: templates/plans/plan.md (implementation plan template — Validated ✅)
- [x] Claude generates: templates/plans/prompt.md (agent injection prompt — Validated ✅)
- [x] Claude generates: templates/plans/checklist.md (progress tracking — Validated ✅)
- [x] Claude generates: templates/plans/decisions.md (Q&A and decisions — Validated ✅)
- [x] Claude generates: templates/plans/snippets.md (code context — Validated ✅)

### ✅ Claude Phase 13: Multi-Agent Swarm Architecture
- [x] Claude generates: src/lib/swarm.ts (Architect + Worker pattern — Validated ✅)
- [x] Claude generates: src/architect.ts (Plan creation, worker spawning — Validated ✅)
- [x] Claude generates: src/worker.ts (Sub-task execution — Validated ✅)

### ✅ Claude Phase 14: Project Onboarding
- [x] Claude generates: templates/github-project.json (Project template — Validated ✅)
- [x] Claude generates: src/setup-project.ts (Project creation — Validated ✅)
- [x] Claude generates: k8s/charts/gwa-onboarding/templates/postsync-job.yaml (ArgoCD hook — Validated ✅)

### ✅ Claude Phase 15: Enhanced Session Fields & Screenshots (v3.4)

**Prerequisites:**
- [x] SQLite database initialized in pod (`sqlite3 /home/runner/gwa.db < schema.sql`)
- [x] gwa-* binaries deployed to pod (`ls /usr/local/bin/gwa-*`)
- [x] Basic REPL flow works (Todo → Planning creates session)

**New Custom Fields:**
- [x] templates/github-project.json updated with 5 new fields:
  - [x] Pod Name (TEXT)
  - [x] Tmux Window (TEXT)
  - [x] Kubectl Command (TEXT)
  - [x] Worktree Path (TEXT)
  - [x] Sub Agents Used (TEXT)

**projects.ts Updates:**
- [x] CUSTOM_FIELDS extended with: POD_NAME, TMUX_WINDOW, KUBECTL_COMMAND, WORKTREE_PATH, SUB_AGENTS_USED
- [x] updateSessionFields() accepts new fields: podName, tmuxWindow, kubectlCommand, worktreePath, subAgentsUsed

**start-planning.ts Updates:**
- [x] Gets pod name from `hostname` with `POD_NAME` env fallback
- [x] Accepts `--item-id` from webhook, fallback to GitHub API query
- [x] Stores project_item_id in SQLite sessions table
- [x] Calls updateSessionFields() with all new fields
- [x] Posts REPL start comment to issue via generateComment()

**Screenshot Lifecycle:**
- [x] screenshot.ts has saveScreenshotToDisk() function
- [x] Screenshots saved to /tmp/gwa-screenshots/
- [x] Screenshots tracked in SQLite screenshots table
- [x] Attached to comments only on errors/anomalies
- [x] deploy-and-cleanup.ts deletes screenshots when session ends

**Schema Migration:**
- [x] sessions table has project_item_id column
- [x] Index exists on project_item_id

**Sub-Agent Tracking:**
- [x] swarm.ts updates Sub Agents Used field when spawning workers
- [x] Progress comments posted with active agent names

**Comment Types:**
- [x] comment-generator.ts has "progress" type for status updates
- [x] Progress shows: active agents, current task, completion percentage

---

## Deployment Phases Checklist

### Claude Code CLI Commands (During Implementation)

```bash
# Start Claude in implementation directory
cd ~/claude-implementation
claude

# Continue working in the same session
# (stay in claude session, don't exit)

# If you exit accidentally:
claude --continue  # Resume last session

# If you need to start fresh:
cd ~/claude-implementation
rm -rf *  # Clear old artifacts
claude   # Start fresh session
```

### Asking Claude to Re-validate

If you need Claude to re-validate a file:

```
# In Claude CLI session:
Can you validate the file <filename>?
Run: yamllint <filename>
Show me the results.
```

### Deployment Commands

**After Claude finishes all phases, all files are in:**
```
~/claude-implementation/
├── YAML files (*.yaml)
├── Dockerfile
├── package.json
├── schema.sql              # SQLite schema
├── src/                    # Bun TypeScript tools (for Interactive REPL)
│   ├── ask-question.ts     # Called BY Claude to post questions
│   ├── session-complete.ts # Called BY Claude when work done
│   ├── debug-db.ts         # SQLite state inspection
│   ├── pod-health-check.ts
│   └── lib/
│       ├── db.ts           # SQLite connection, WAL mode
│       ├── recovery.ts     # Startup recovery
│       ├── screenshot.ts   # tmux → PNG → base64
│       ├── vision-verify.ts # Conditional Claude vision
│       ├── updater.ts      # Dependency update logic
│       └── checkpoint.ts   # Crash recovery, replay
├── scripts/                # Shell orchestration
│   └── deploy-all.sh
└── .github/workflows/
```

**Deploy in this order:**

```bash
# 1. Copy files to your repo (optional)
cd ~/claude-implementation
cp -r . /path/to/your/repo/

# 2. Apply infrastructure
kubectl apply -f ~/claude-implementation/longhorn-claude-storageclass.yaml
kubectl apply -f ~/claude-implementation/claude-session-pvc.yaml

# 3. Verify PVC is bound before continuing
kubectl get pvc claude-session-pvc
# Should show: Bound

# 4. Deploy StatefulSet & Services
kubectl apply -f ~/claude-implementation/claude-runner-configmap.yaml
kubectl apply -f ~/claude-implementation/claude-runner-statefulset.yaml
kubectl apply -f ~/claude-implementation/claude-runner-service.yaml

# 5. Verify pod is running
kubectl get pods -l app=claude-runner
# Should show: claude-runner-0 in Running state

# 6. Install Bun dependencies and build container
cd ~/claude-implementation
bun install
docker build -t your-registry/claude-runner:latest .
docker push your-registry/claude-runner:latest

# 7. Update StatefulSet with correct image
kubectl set image statefulset/claude-runner \
  claude-agent=your-registry/claude-runner:latest

# 8. Deploy using orchestration script
bash ~/claude-implementation/scripts/deploy-all.sh

# 9. Deploy CronJob for cleanup
kubectl apply -f ~/claude-implementation/claude-cleanup-cronjob.yaml
kubectl apply -f ~/claude-implementation/claude-cleanup-rbac.yaml

# 10. Commit to your repo
cd /path/to/your/repo
git add .github/workflows/ .claude/ scripts/ monitoring/
git commit -m "feat: Add Claude Code integration with persistent pods"
git push origin main
```

### Monitoring Commands
```bash
# Check pod status
kubectl get pods -l app=claude-runner
kubectl get statefulset claude-runner
kubectl get pvc claude-session-pvc

# Attach to pod and view tmux
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work

# Watch-only attach (read-only)
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work -r

# List tmux windows
kubectl exec -it claude-runner-0 -- tmux list-windows -t claude-work

# Debug SQLite state (Bun CLI tool — compiled to binary in container)
kubectl exec claude-runner-0 -- debug-db

# Check pod health (Bun CLI tool)
kubectl exec claude-runner-0 -- pod-health-check

# View tmux status
./monitoring/tmux-status.sh
```

### Debugging Commands
```bash
# Check pod logs
kubectl logs claude-runner-0
kubectl logs claude-runner-0 -f  # follow

# Execute command in pod
kubectl exec -it claude-runner-0 -- bash

# Check file mounts
kubectl exec claude-runner-0 -- ls -la /home/runner/.claude/
kubectl exec claude-runner-0 -- ls -la /home/runner/worktrees/

# Verify SQLite database
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db "PRAGMA integrity_check"

# Check git worktrees
kubectl exec claude-runner-0 -- git -C /home/runner/repo worktree list

# View tmux session content
kubectl exec claude-runner-0 -- tmux capture-pane -t claude-work:1 -p
```

### Cleanup Commands
```bash
# Remove a specific PR's worktree manually
kubectl exec claude-runner-0 -- git -C /home/runner/repo worktree remove /home/runner/worktrees/pr-123 --force

# Kill a tmux window manually
kubectl exec claude-runner-0 -- tmux kill-window -t claude-work:2

# Clear session data for a PR (use with caution)
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "DELETE FROM sessions WHERE id = 'pr-123'"

# Restart the pod (full reset)
kubectl rollout restart statefulset claude-runner
```

---

## Workflow Triggers

### GitHub Actions Triggers

**Workflow 1: claude-code-blocking.yml**
- Triggers on: `pull_request` (opened, reopened, synchronize)
- Triggers on: `issue_comment` (created)
- Can trigger via: `@claude` mention in PR/issue

**Workflow 2: claude-code-respond.yml**
- Triggers on: `issue_comment` (created, edited)
- Detects: `@claude-answer: your answer here`
- Responds to: Blocked Claude sessions waiting for input

### Manual Trigger
```bash
# Manually trigger workflow for PR #123
gh workflow run claude-code-blocking.yml -f pr_number=123
```

---

## Interactive REPL Commands

### Starting a REPL Session
```bash
# Workflow starts REPL in tmux window:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "claude" Enter

# Wait for init, then send prompt:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "Implement feature X" Enter
```

### Sending Answers to Blocked REPL
```bash
# User posts: @claude-answer: Use approach B
# Webhook sends to running REPL:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "Use approach B" Enter
```

### Human Takeover
```bash
# Attach to watch/guide Claude:
kubectl exec -it claude-runner-0 -- tmux attach -t claude-work:1

# Detach (let Claude continue):
# Press: Ctrl+B then D
```

### Session Status (SQLite)
```bash
# Check session status:
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT status FROM sessions WHERE id = 'pr-123'"
# Returns: running | blocked | complete | error | interrupted

# Check if REPL is active:
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT repl_active FROM sessions WHERE id = 'pr-123'"
# Returns: 1 or 0

# Full session details:
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT * FROM sessions WHERE id = 'pr-123'"
```

---

## SQLite Commands Cheat Sheet

```bash
# Connect to SQLite in pod
kubectl exec -it claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db

# Inside sqlite3:

# All active sessions
SELECT id, type, status, github_number, tmux_window, repl_active
FROM sessions WHERE status IN ('running', 'blocked');

# Session details
SELECT * FROM sessions WHERE id = 'pr-123';

# Pending questions
SELECT session_id, question, status, datetime(asked_at, 'unixepoch') as asked
FROM questions WHERE status = 'posted';

# Recent activity
SELECT session_id, event, actor, datetime(created_at, 'unixepoch') as time
FROM activity_log ORDER BY created_at DESC LIMIT 20;

# Manual answer setting (emergency)
UPDATE questions SET answer = 'Use hooks', answered_at = unixepoch(), status = 'answered'
WHERE session_id = 'pr-123' AND status = 'posted';

# Clear session data (DANGEROUS)
DELETE FROM sessions WHERE id = 'pr-999';

# Tool usage stats
SELECT tool_name, COUNT(*) as calls, ROUND(AVG(duration_ms)) as avg_ms
FROM tool_calls GROUP BY tool_name ORDER BY calls DESC;

# Check for pending updates
SELECT * FROM update_queue WHERE status = 'pending';

# View installed dependency versions
SELECT package, installed_version, last_updated_at FROM dependency_versions;
```

---

## Dependency Update Commands

### Check for Updates
```bash
# Check what updates are available (doesn't apply)
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/updater.ts check

# Check if safe to update (no active sessions)
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT COUNT(*) FROM sessions WHERE status IN ('running', 'blocked', 'starting')"
# Returns: 0 means safe to update
```

### Manual Update (when safe)
```bash
# Update Claude CLI
kubectl exec claude-runner-0 -- npm update -g @anthropic-ai/claude-code

# Update npm packages
kubectl exec claude-runner-0 -- bash -c "cd /home/runner/repo && bun update"

# Record new versions
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/updater.ts recordVersions
```

### Queue Update (for later)
```bash
# Queue update if sessions are active
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "INSERT INTO update_queue (update_type, reason) VALUES ('all', 'Manual queue')"
```

### Apply Pending Updates
```bash
# Apply all pending updates (usually done on pod restart)
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/updater.ts applyPending

# Or restart pod to trigger update check
kubectl rollout restart statefulset claude-runner
```

### CronJobs
```bash
# Check update CronJob status
kubectl get cronjob claude-update
kubectl logs -l job-name=claude-update --tail=50

# Check cleanup CronJob status
kubectl get cronjob claude-cleanup
kubectl logs -l job-name=claude-cleanup --tail=50
```

---

## Crash Recovery Commands

### Check for Interrupted Sessions
```bash
# List all interrupted sessions that can be resumed
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT id, github_number, claude_session_id, interrupted_at FROM sessions WHERE status = 'interrupted'"

# Check if Claude session ID was captured (for --resume)
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT claude_session_id FROM sessions WHERE id = 'pr-123'"
```

### View Last Checkpoint
```bash
# Get the latest checkpoint for a session
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT checkpoint_type, summary, datetime(created_at, 'unixepoch') as time
   FROM checkpoints WHERE session_id = 'pr-123' ORDER BY created_at DESC LIMIT 1"

# View pending actions from checkpoint
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT pending_actions FROM checkpoints WHERE session_id = 'pr-123' ORDER BY created_at DESC LIMIT 1"

# View git state at checkpoint
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT git_status, git_diff_stat FROM checkpoints WHERE session_id = 'pr-123' ORDER BY created_at DESC LIMIT 1"
```

### Resume an Interrupted Session
```bash
# If Claude session ID is available, use --resume
CLAUDE_SESSION=$(kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT claude_session_id FROM sessions WHERE id = 'pr-123'")
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 \
  "claude --resume ${CLAUDE_SESSION}" Enter

# If no session ID, replay from conversation history
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/recovery.ts resume pr-123
```

### View Conversation History
```bash
# Last 10 messages in a session
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT role, substr(content, 1, 100) as content_preview, datetime(created_at, 'unixepoch') as time
   FROM conversation_history WHERE session_id = 'pr-123' ORDER BY sequence_num DESC LIMIT 10"
```

### View Claude's Responses
```bash
# Recent responses in a session
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT response_type, substr(content, 1, 100) as content_preview, tool_name
   FROM responses WHERE session_id = 'pr-123' ORDER BY created_at DESC LIMIT 5"
```

### Manual Checkpoint (before risky operations)
```bash
# Trigger a manual checkpoint from Claude REPL
# (Claude should call this before major actions)
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/checkpoint.ts create \
  --session pr-123 --type manual --summary "About to refactor auth module"
```

---

## GitHub Projects Commands

### Check Project Item Status
```bash
# Get current column for a project item
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT id, title, current_column, previous_column FROM project_items WHERE issue_number = 42"

# List all items in a specific column
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT id, title, issue_number, pr_number FROM project_items WHERE current_column = 'In Progress'"
```

### View Implementation Plans
```bash
# Get latest plan for a session
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT version, summary, approved, file_path FROM implementation_plans
   WHERE session_id = 'issue-42' ORDER BY version DESC LIMIT 1"

# View work breakdown
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT work_breakdown FROM implementation_plans WHERE session_id = 'issue-42' ORDER BY version DESC LIMIT 1"
```

### Check QA Run Results
```bash
# Latest QA run for a project item
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT passed, total_tests, passed_tests, failed_tests, duration_ms
   FROM qa_runs WHERE project_item_id = 'PI_xxxx' ORDER BY started_at DESC LIMIT 1"

# View failure details
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT failure_summary, failure_details FROM qa_runs
   WHERE project_item_id = 'PI_xxxx' AND passed = 0 ORDER BY started_at DESC LIMIT 1"
```

### Update Project Item (Manual)
```bash
# Move item to different column (emergency override)
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts move \
  --item PI_xxxx --column "Blocked"

# Sync session data to project custom fields
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts sync \
  --session issue-42 --item PI_xxxx
```

### PR Filter Checks
```bash
# Test if a PR would be processed
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/pr-filter.ts check \
  --owner jaybrto --repo github-workflow-agents --pr 123

# List Claude-created PRs
gh pr list --label created-by-claude --json number,title,headRefName
```

---

## Multi-Agent Swarm Commands

### Check Swarm Status
```bash
# List all agent tasks for a session
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT agent_id, agent_type, task_status, progress_pct, tmux_window
   FROM agent_tasks WHERE session_id = 'issue-42'"

# Check architect status
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT * FROM agent_tasks WHERE session_id = 'issue-42' AND agent_type = 'architect'"

# List active workers
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT agent_id, task_description, progress_pct, last_status_message
   FROM agent_tasks WHERE session_id = 'issue-42' AND agent_type = 'worker' AND task_status = 'running'"
```

### View Tmux Windows (Multi-Agent)
```bash
# List all tmux windows for claude-work session
kubectl exec claude-runner-0 -- tmux list-windows -t claude-work

# Attach to architect window (window 1)
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work:1

# Attach to worker window (e.g., window 3)
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work:3

# View all windows in split pane (monitor mode)
kubectl exec -it claude-runner-0 -- tmux select-window -t claude-work:0
```

### Worker Task Management
```bash
# Manually complete a stuck worker task
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE agent_tasks SET task_status = 'completed', completed_at = unixepoch()
   WHERE agent_id = 'worker-abc123' AND session_id = 'issue-42'"

# Kill a specific worker window
kubectl exec claude-runner-0 -- tmux kill-window -t claude-work:3

# Spawn additional worker (for manual intervention)
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/swarm.ts spawnWorker \
  --session issue-42 --task "Complete unit tests for auth module"
```

### Architect Operations
```bash
# View implementation plan created by architect
cat .plans/issue-42.md

# Force architect to re-plan
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE implementation_plans SET approved = 0 WHERE session_id = 'issue-42'"
```

---

## GitHub Secrets Required

| Secret Name | Value | Notes |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-oat01-...` | From Phase 1 |
| `GITHUB_TOKEN_RUNNER` | `ghp_xxxx...` | GitHub PAT with repo + workflow scopes |

Verify:
```bash
gh secret list
```

---

## Common Issues & Quick Fixes

| Issue | Command to Check | Fix |
|---|---|---|
| Pod not running | `kubectl get pods -l app=claude-runner` | `kubectl logs claude-runner-0` |
| PVC not bound | `kubectl get pvc` | Check Longhorn: `kubectl get sc longhorn-claude` |
| Tmux session missing | `kubectl exec claude-runner-0 -- tmux list-sessions` | Restart pod: `kubectl rollout restart statefulset claude-runner` |
| SQLite locked | `kubectl exec claude-runner-0 -- sqlite3 gwa.db "PRAGMA journal_mode"` | Should return "wal"; if not, run `PRAGMA journal_mode=WAL` |
| Stale sessions | `kubectl exec claude-runner-0 -- sqlite3 gwa.db "SELECT * FROM sessions WHERE status='running'"` | Run recovery: restart pod or call recoverStaleSessions() |
| Worktree won't create | `kubectl exec claude-runner-0 -- git -C /home/runner/repo worktree list` | Remove stale: `git worktree prune` |
| Workflow doesn't trigger | `gh workflow list` | Verify workflow syntax: `gh workflow view claude-code-blocking.yml` |
| Screenshot too large | Check PNG size in container | Reduce quality: wkhtmltoimage --quality 30 |
| Screenshot missing | Check if aha/wkhtmltoimage installed | `apt-get install aha wkhtmltopdf` in Dockerfile |
| Vision verification fails | Check Anthropic API key | Fallback: screenshot posted without verification |
| Outdated dependencies | `kubectl exec claude-runner-0 -- claude --version` | Queue update: see Dependency Update Commands section |
| Update queue not applying | `sqlite3 gwa.db "SELECT * FROM update_queue WHERE status='pending'"` | Restart pod or run `bun run updater.ts applyPending` |

---

## Environment Variables in Workflows

These are automatically set or available:

```bash
# GitHub provided
${{ github.repository }}              # owner/repo
${{ github.event.pull_request.number }}  # PR number
${{ github.head_ref }}                # Branch name
${{ github.actor }}                   # Username who triggered

# Custom environment
DB_PATH=/home/runner/.claude/gwa.db
REPO=${{ github.repository }}
```

---

## Performance Tips

1. **Reduce SQLite polling interval** from 5s to 2s if you need faster question response
2. **Increase health check interval** from 30s to 60s if bandwidth is tight
3. **Pre-warm container image** by pulling to all nodes
4. **SQLite WAL mode** ensures data persists across crashes (default enabled)
5. **Tune Longhorn replicas** - 2 is HA, 3 is safer for larger clusters

---

## Safety Checklist Before Going Live

- [x] Tested all 5 test scenarios successfully
- [x] Can attach to pod and interact with Claude
- [x] Can respond to questions via `@claude-answer:` in PR
- [x] Pod crashes are detected and handled gracefully
- [x] Cleanup CronJob successfully removes closed PRs
- [x] Session data persists across pod restarts
- [x] Multiple concurrent PRs work in parallel
- [x] SQLite data survives pod crashes
- [x] GitHub workflows have appropriate timeouts
- [x] RBAC is least-privilege (CronJob can't delete other things)
- [x] Secrets are properly stored (not in YAML)
- [x] Container image is scanned for vulnerabilities
- [x] Longhorn backups are scheduled

---

## Day-2 Operations

### Weekly
- [ ] Check CronJob logs: `kubectl logs -n default -l job-name=claude-cleanup --tail=50`
- [ ] Check update CronJob logs: `kubectl logs -n default -l job-name=claude-update --tail=50`
- [ ] Verify Longhorn replicas: `kubectl get hr -A | grep claude-session`
- [ ] Check dependency versions: `kubectl exec claude-runner-0 -- claude --version`
- [ ] Check pending updates: `kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db "SELECT * FROM update_queue WHERE status='pending'"`

### Monthly
- [ ] Update CLAUDE.md with lessons learned
- [ ] Review and optimize question handling patterns
- [ ] Refresh OAuth token if approaching expiration
- [ ] Test disaster recovery (pod deletion → auto-reschedule)
- [ ] Review update_queue for any failed updates

### As Needed
- [ ] Manual dependency update if CronJob missed it (see Dependency Update Commands)
- [ ] Adjust resource requests/limits based on actual usage
- [ ] Add new custom commands to `.claude/commands/`
- [ ] Tune health check intervals

---

## When Things Go Wrong

### Pod won't start
```bash
kubectl logs claude-runner-0
# Fix: Usually ConfigMap mount issue or image pull failure
# Solution: Check image exists, ConfigMap exists, RBAC correct
```

### Session lost after pod restart
```bash
kubectl exec claude-runner-0 -- ls -la /home/runner/.claude/
# Should see session files from Longhorn PVC
# If not: Longhorn didn't mount correctly
```

### SQLite database issues
```bash
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db "PRAGMA integrity_check"
# Should return: ok
# If corrupt: Restore from Longhorn snapshot, or reinitialize schema
```

### Workflow doesn't trigger
```bash
gh workflow list
gh workflow view claude-code-blocking.yml --json
# Look for syntax errors, then: git push to re-trigger
```

### Stuck on blocked question
```bash
# Check if answer was received
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT question, answer, status FROM questions WHERE session_id = 'pr-123' ORDER BY id DESC LIMIT 1"

# If stuck, manually set answer in database
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE questions SET answer = 'your answer', answered_at = unixepoch(), status = 'answered' WHERE session_id = 'pr-123' AND status = 'posted'"

# And send to tmux
kubectl exec claude-runner-0 -- \
  tmux send-keys -t claude-work:1 "your answer" Enter
```

---

## Complete Implementation Timeline

**How the full process works from start to finish:**

### Step 1: Setup (5-10 minutes)
```bash
mkdir -p ~/claude-implementation
cd ~/claude-implementation

# Verify tools
yamllint --version
python3 -c "import yaml"
docker --version
kubectl version

# Start Claude
claude
```

### Step 2: Claude Phase 1-2 (10-15 minutes in Claude)
**You:** Paste the full prompt with implementation plan
**Claude:** 
- Generates longhorn-claude-storageclass.yaml
- Validates with yamllint → Shows ✅ result
- Generates claude-session-pvc.yaml
- Validates with yamllint → Shows ✅ result
- Asks: "Ready for Phase 3?"

**You:** "Yes, continue with Phase 3"

### Step 3: Claude Phase 3 (10-15 minutes in Claude)
**Claude:**
- Generates 3 YAML files (ConfigMap, StatefulSet, Service)
- Validates each with yamllint
- Shows all validation results
- Asks: "Ready for Phase 6?"

**You:** "Yes, continue with Phase 6"

### Step 4: Claude Phase 6 (5-10 minutes in Claude)
**Claude:**
- Generates Dockerfile
- Validates with: docker build --dry-run
- Generates build-and-push.sh
- Validates with: bash -n
- Shows results and asks: "Ready for Phase 7?"

**You:** "Yes, continue with Phase 7"

### Step 5: Claude Phases 7-11 (20-30 minutes in Claude)
**Claude:**
- Generates and validates GitHub workflow YAML files
- Generates and validates cleanup CronJob and RBAC YAML
- Creates repository configuration (.claude/CLAUDE.md, commands)
- Generates Bun CLI tools (src/*.ts) and package.json
- Generates shell orchestration script (scripts/deploy-all.sh)
- Each validated before moving to next
- Final message: "All phases complete and validated ✅"

**You:** "Great! I'm ready to deploy. Exit Claude now."
```bash
# Exit Claude CLI (Ctrl+C or type 'exit')
exit

# Check what was created
ls -la ~/claude-implementation/
# Should show all YAML, Dockerfile, scripts, .github/workflows/
```

### Step 6: Deploy Infrastructure (5 minutes)
```bash
# Apply YAML files in order
kubectl apply -f ~/claude-implementation/longhorn-claude-storageclass.yaml
kubectl apply -f ~/claude-implementation/claude-session-pvc.yaml

# Wait for PVC to be Bound
kubectl get pvc claude-session-pvc

# Apply StatefulSet
kubectl apply -f ~/claude-implementation/claude-runner-*.yaml

# Wait for pod to be Running
kubectl get pods -l app=claude-runner -w
```

### Step 7: Build & Push Container (5-10 minutes)
```bash
cd ~/claude-implementation
bun install  # Install dependencies for Bun tool compilation
docker build -t your-registry/claude-runner:latest .
docker push your-registry/claude-runner:latest

# Update StatefulSet to use new image
kubectl set image statefulset/claude-runner \
  claude-agent=your-registry/claude-runner:latest
```

### Step 8: Initialize & Deploy (5 minutes)
```bash
# Deploy CronJob
kubectl apply -f ~/claude-implementation/claude-cleanup-cronjob.yaml
kubectl apply -f ~/claude-implementation/claude-cleanup-rbac.yaml

# Or use the orchestration script for full deployment
bash ~/claude-implementation/scripts/deploy-all.sh
```

### Step 9: Commit to Repository (2 minutes)
```bash
cd /path/to/your/repo

# Copy files
cp -r ~/claude-implementation/.github .
cp -r ~/claude-implementation/.claude .
cp -r ~/claude-implementation/scripts .
cp -r ~/claude-implementation/monitoring .

# Commit
git add .github/ .claude/ scripts/ monitoring/
git commit -m "feat: Add Claude Code integration with persistent pods"
git push origin main
```

### Step 10: Test (5-10 minutes)
```bash
# Create test PR
git checkout -b test/claude-integration
echo "# Test" > test.md
git add test.md
git commit -m "test: add test file"
git push -u origin test/claude-integration

gh pr create --title "Test: Claude Integration" --body "Testing workflow"

# Watch workflow
gh run list --workflow=claude-code-blocking.yml --limit=1

# Attach to pod to watch Claude work
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work
```

---

**Total Time: ~90 minutes from start to Claude working on real PRs**

| Phase | Time | Activity |
|---|---|---|
| Setup | 5 min | Create directory, verify tools, start Claude |
| Claude generates & validates | 60 min | All 11 phases, artifacts created |
| Deploy infrastructure | 5 min | kubectl apply YAML files |
| Build & push container | 5 min | docker build/push |
| Initialize & deploy CronJob | 5 min | SQLite auto-init, deploy cleanup + update |
| Commit to repo | 2 min | git push |
| Test | 5 min | Create PR, verify workflow |
| **Total** | **~90 min** | **End-to-end implementation** |

---

## SQLite Database Schema

```
┌─────────────────────────────────────────────────────────────┐
│  gwa.db (WAL mode, on Longhorn PVC)                         │
│                                                              │
│  sessions ─────────────────────────────────────────────────  │
│  │ id, type, status, github_number, tmux_window,            │
│  │ worktree_path, repl_active, claude_session_id, timestamps│
│  │                                                           │
│  ├─► questions ────────────────────────────────────────────  │
│  │   │ question, answer, status, screenshot_path            │
│  │                                                           │
│  ├─► prompts ──────────────────────────────────────────────  │
│  │   │ prompt, source, triggered_by                         │
│  │                                                           │
│  ├─► commits ──────────────────────────────────────────────  │
│  │   │ commit_hash, message, files_changed                  │
│  │                                                           │
│  ├─► tool_calls ───────────────────────────────────────────  │
│  │   │ tool_name, input, result, duration_ms                │
│  │                                                           │
│  ├─► activity_log ─────────────────────────────────────────  │
│  │   │ event, details, actor, timestamp                     │
│  │                                                           │
│  ├─► responses ────────────────────────────────────────────  │
│  │   │ response_type, content, tool_name, prompt_id         │
│  │                                                           │
│  ├─► checkpoints ──────────────────────────────────────────  │
│  │   │ checkpoint_type, summary, pending_actions, git_state │
│  │                                                           │
│  ├─► conversation_history ─────────────────────────────────  │
│  │   │ role, content, sequence_num, turn_num                │
│  │                                                           │
│  ├─► implementation_plans (v3.0) ──────────────────────────  │
│  │   │ version, summary, plan_markdown, file_path,          │
│  │   │ approved, approved_by, work_breakdown                │
│  │                                                           │
│  ├─► qa_runs (v3.0) ───────────────────────────────────────  │
│  │   │ passed, total_tests, passed_tests, failed_tests,     │
│  │   │ failure_summary, failure_details, duration_ms        │
│  │                                                           │
│  └─► agent_tasks (v3.0) ───────────────────────────────────  │
│      │ agent_id, agent_type, tmux_window, task_description, │
│      │ task_status, progress_pct, last_status_message       │
│                                                              │
│  project_items (v3.0) ─────────────────────────────────────  │
│  │ id (GitHub node ID), session_id, issue_number, pr_number,│
│  │ title, current_column, previous_column, project_id,      │
│  │ plan_approved, tests_passed                              │
│                                                              │
│  screenshots ──────────────────────────────────────────────  │
│  │ file_path, event_type, session_id                        │
│                                                              │
│  config ───────────────────────────────────────────────────  │
│  │ key, value (pod_name, repo, schema_version)              │
│                                                              │
│  update_queue ─────────────────────────────────────────────  │
│  │ update_type, target_version, status, reason              │
│                                                              │
│  dependency_versions ──────────────────────────────────────  │
│  │ package, installed_version, latest_known_version         │
└─────────────────────────────────────────────────────────────┘
```

### Session Status Flow
```
pending → starting → running → blocked → running → complete
                 ↓                                    ↓
             interrupted                           error
```

### Startup Recovery
On pod restart, `recoverStaleSessions()` marks all "running" sessions as "interrupted" so workflows know to resume them.

---

## Screenshot & Vision Architecture

### Screenshot Pipeline
```
tmux capture-pane -p -e  →  aha --no-header  →  wkhtmltoimage --quality 50  →  base64
     (ANSI text)              (HTML)              (PNG <75KB)                 (inline)
```

### When Screenshots Are Captured
| Event | Screenshot | Vision Verify | Reason |
|-------|------------|---------------|--------|
| Question asked | ✅ | Conditional | User needs context |
| Work complete | ✅ | Conditional | Proof of state |
| Error occurred | ✅ | Conditional | Debugging |
| Thinking | ❌ | ❌ | Too noisy |
| Tool use | ❌ | ❌ | Not actionable |

### Vision Verification Triggers
Only calls Claude API when text heuristics detect anomalies:
- Expected "question" but no "?" found
- Expected "complete" but found "error"
- Output truncated or empty (<10 chars)

Cost: ~$0.003/verification (Sonnet + small image)

### GitHub Constraints
- No CDN upload API (only web UI can upload to user-attachments)
- Base64 inline limit: ~75KB (65535 chars / 1.37 encoding)
- Must compress PNG before embedding

---

## Glossary

| Term | Definition |
|---|---|
| **StatefulSet** | k8s resource that creates persistent, uniquely-named pods |
| **Longhorn** | Persistent storage layer for k3s (distributed block storage) |
| **PVC** | PersistentVolumeClaim - request for storage |
| **tmux** | Terminal multiplexer - manages multiple shell windows |
| **Worktree** | Git feature for checking out multiple branches in parallel |
| **SQLite** | Embedded database for session tracking (on Longhorn PVC, WAL mode) |
| **ConfigMap** | k8s config storage (where entrypoint.sh lives) |
| **RBAC** | Role-Based Access Control (least-privilege permissions) |
| **CronJob** | Scheduled job in k8s (cleanup runs hourly) |

---

## v4.0 Upgrade Checklist

### Phase 15: v4.0 Prerequisites
- [x] 15.1 Enable RabbitMQ plugins: `rabbitmq_mqtt`, `rabbitmq_web_mqtt`, `rabbitmq_management`
- [x] 15.2 Verify MQTT connectivity and topic routing from within cluster
- [x] 15.3 Deploy ntfy.sh to K3s cluster
- [x] 15.4 Add Cloudflare tunnel route for ntfy (`ntfy.bto.bar`)
- [x] 15.5 Create MinIO bucket `gwa-recordings` with lifecycle policies
- [x] 15.6 Verify `ansi-to-svg` works with Bun (or identify fallback)
- [x] 15.7 Create `src/shared/types.ts` with canonical enums and message schema

### Phase 16: Security Hardening
- [x] 16.1 Import `timingSafeEqual` in `src/webhook/handler.ts`
- [x] 16.2 Change `verifySignature()` to fail closed when secret is empty
- [x] 16.3 Replace `===` with `timingSafeEqual` for HMAC comparison
- [x] 16.4 Add length check before `timingSafeEqual`
- [x] 16.5 Add in-memory deduplication `Map` with 1-hour TTL
- [x] 16.6 Check `X-GitHub-Delivery` against dedup map before processing
- [x] 16.7 Write tests for signature verification edge cases
- [x] 16.8 Write tests for deduplication logic
- [x] 16.9 Run `bun run typecheck` -- verify clean

### Phase 17: XState State Machine (Pod Level)
- [x] 17.1 Install `xstate@^5.26.0`
- [x] 17.2 Create `src/lib/state-machine.ts` with machine definition
- [x] 17.3 Define all 7 states with transitions matching README
- [x] 17.4 Implement guards: `hasNoActiveSession`, `planExists`, `previousWas*`
- [x] 17.5 Implement `columnTransitionToEvent()` mapping function
- [x] 17.6 Add `xstate_snapshot` and `xstate_schema_version` columns to sessions table
- [x] 17.7 Implement `persistSnapshot()` and `restoreActor()` helper functions
- [x] 17.8 Handle `undefined` -> `null` in JSON serialization
- [x] 17.9 Integrate with AMQP command subscriber (replace workflow_dispatch chain)
- [x] 17.10 Update each transition handler to load/verify/persist XState state
- [x] 17.11 Map `blocked` state `previousState` context correctly
- [x] 17.12 Publish `state_change` event to RabbitMQ on every transition
- [x] 17.13 Write state machine unit tests (all valid transitions)
- [x] 17.14 Write state machine unit tests (all invalid transitions)
- [x] 17.15 Write state machine unit tests (guard conditions)
- [x] 17.16 Write snapshot round-trip tests
- [x] 17.17 Run `bun run typecheck` -- verify clean
- [x] 17.18 Run `bun test` -- verify all pass

### Phase 18: Remove Redis (Complete -- 21 Files)
- [x] 18.1 Delete `src/lib/redis.ts`
- [x] 18.2 Rewrite `src/lib/repl-session.ts` -- migrate ALL 6 Redis operations to SQLite
- [x] 18.3 Extend `sessions` table with REPL-specific fields (`repl_session_id`, `repl_status`)
- [x] 18.4 Update `src/orchestrate.ts` -- replace all 8 Redis calls with SQLite
- [x] 18.5 Update `src/health-check.ts` -- remove Redis check, add SQLite check
- [x] 18.6 Delete `src/debug-redis.ts`, create `src/debug-db.ts`
- [x] 18.7 Remove `build:debug-redis` script from `package.json`
- [x] 18.8 Remove `IORedisInstrumentation` from `src/lib/telemetry.ts`
- [x] 18.9 Remove `Metrics.recordRedisOperation()` and all call sites
- [x] 18.10 Update `src/lib/types.ts` -- remove Redis types, use canonical `SessionState`
- [x] 18.11 Create `active_sessions` SQL view
- [x] 18.12 Remove `ioredis` from `package.json`
- [x] 18.13 Remove `@opentelemetry/instrumentation-ioredis` from `package.json`
- [x] 18.14 Update `src/tests/imports.test.ts` -- remove Redis export checks
- [x] 18.15 Update `src/tests/preflight.test.ts` -- remove `ioredis` assertion, add `xstate`/`amqplib`
- [x] 18.16 Update `tests/helm-chart.test.ts` -- remove Redis assertions, add RabbitMQ
- [x] 18.17 Update Helm `values.yaml` -- remove `redis` section, add `rabbitmq`, `ntfy`, `minio`
- [x] 18.18 Update Helm `configmap.yaml` -- replace `redis-cli` with `sqlite3` commands
- [x] 18.19 Update Helm `statefulset.yaml` -- remove `REDIS_HOST`/`REDIS_PORT`, add `RABBITMQ_URL`
- [x] 18.20 Update Helm `cronjob-cleanup.yaml` -- remove Redis env vars
- [x] 18.21 Update `k8s/gwa-runner-statefulset.yaml` -- remove Redis env vars
- [x] 18.22 Update `k8s/gwa-cleanup-cronjob.yaml` -- remove Redis env vars
- [x] 18.23 Verify `busy_timeout = 5000` on all `getDatabase()` calls
- [x] 18.24 Verify write transactions use `BEGIN IMMEDIATE`
- [x] 18.25 Add `SQLITE_BUSY` retry logic for critical paths
- [x] 18.26 Run `bun run typecheck` -- verify clean
- [x] 18.27 Run `bun test` -- verify all pass

### Phase 19: RabbitMQ Backbone + Orchestrator Extraction
- [x] 19.1 Install `amqplib@^0.10.7` and `@types/amqplib`
- [x] 19.2 Create `src/lib/amqp.ts` -- singleton connection + auto-reconnect + publisher confirms
- [x] 19.3 Implement `publishEvent()` with routing key `gwa.events.{owner}.{repo}.{session}.{eventType}`
- [x] 19.4 Implement `subscribeCommands()` for `gwa.commands.{owner}.{repo}.#`
- [x] 19.5 Integrate with `logActivity()` in `src/lib/db.ts` (fire-and-forget)
- [x] 19.6 Publish heartbeat every 30s to `gwa.heartbeat.{owner}.{repo}`
- [x] 19.7 Create `src/orchestrator/` directory structure
- [x] 19.8 Move webhook handler logic to `src/orchestrator/webhook-handler.ts`
- [x] 19.9 Create `src/orchestrator/session-aggregator.ts` -- subscribe to all pod events
- [x] 19.10 Create `src/orchestrator/rest-api.ts` with Bun.serve
- [x] 19.11 Implement all REST endpoints (sessions, answer, snapshots, recordings)
- [x] 19.12 Create `src/orchestrator/push-bridge.ts` -- ntfy.sh integration
- [x] 19.13 Implement per-session debounce (30s) in push bridge
- [x] 19.14 Implement global rate limit (5 notifications/minute)
- [x] 19.15 Implement per-session cooldown (5 minutes)
- [x] 19.16 Create orchestrator's own SQLite database for aggregated state
- [x] 19.17 Orchestrator uses same Dockerfile as runner (not separate image)
- [x] 19.18 Create K8s Deployment manifest for orchestrator
- [x] 19.19 Add `RABBITMQ_URL` env var to runner StatefulSet
- [ ] 19.20 Add MQTT WebSocket Cloudflare tunnel route (WSS fallback)
- [ ] 19.21 Configure Cloudflare Tunnel private network route for WARP path
- [ ] 19.22 Configure Zero Trust Split Tunnels to include K3s service CIDR
- [x] 19.23 Enable `rabbitmq_mqtt` + `rabbitmq_web_mqtt` plugins
- [x] 19.24 Write AMQP publish/subscribe tests (mock broker)
- [x] 19.25 Write push bridge throttling tests
- [x] 19.26 Write orchestrator REST API tests
- [x] 19.27 Run `bun run typecheck` -- verify clean
- [x] 19.28 Run `bun test` -- verify all pass

### Phase 20: Live Terminal Streaming & Snapshots
- [x] 20.1 Create `src/lib/terminal-relay.ts` -- main relay service module
- [x] 20.2 Implement `startPaneStream()` -- mkfifo + tmux pipe-pane + FIFO reader
- [x] 20.3 Implement `stopPaneStream()` -- detach pipe-pane + close FIFO + upload to MinIO
- [x] 20.4 Implement Bun WebSocket server with pub/sub topics per pane
- [x] 20.5 Implement mid-stream join -- `capture-pane -e -p` snapshot on WebSocket connect
- [x] 20.6 Implement asciicast v2 dual-write (NDJSON append alongside live stream)
- [x] 20.7 Add `terminal_snapshots` table to `schema.sql`
- [x] 20.8 Implement `takeSnapshot()` -- capture-pane + ansi-to-svg + SQLite store
- [x] 20.9 Integrate snapshot triggers with XState transition actions (XState integration being added)
- [x] 20.10 Install `ansi-to-svg` npm package (or fallback)
- [x] 20.11 Install `@aws-sdk/client-s3` for MinIO uploads
- [x] 20.12 Implement MinIO S3 upload on session completion
- [x] 20.13 Add presigned URL generation for recording playback
- [x] 20.14 Integrate `startPaneStream()` into session creation workflow
- [x] 20.15 Integrate `stopPaneStream()` into session cleanup workflow
- [x] 20.16 Add `build:terminal-relay` script to `package.json`
- [ ] 20.17 Add Cloudflare tunnel route for terminal relay (`terminal.bto.bar` -> `:8080`) (Manual config needed: terminal.bto.bar → :8080)
- [x] 20.18 Add port 8080 to runner Service/StatefulSet
- [x] 20.19 Write tests: FIFO read + WebSocket publish round-trip
- [x] 20.20 Write tests: mid-stream join snapshot + incremental data
- [x] 20.21 Write tests: asciicast recording format validation
- [x] 20.22 Write tests: MinIO S3 upload
- [x] 20.23 Write tests: snapshot capture at lifecycle events
- [x] 20.24 Run `bun run typecheck` -- verify clean
- [x] 20.25 Run `bun test` -- verify all pass

### Phase 21: Native Android App (Kotlin/Jetpack Compose)
- [ ] 21.1 Create Android Studio project with Compose template (`bar.bto.gwa`)
- [ ] 21.2 Add JitPack repo + Termux terminal-view/emulator dependencies
- [ ] 21.3 Add Paho MQTT Android + OkHttp + Retrofit dependencies (NO Firebase)
- [ ] 21.4 Create `TransportDetector` -- LAN probe -> WARP probe -> WSS fallback
- [ ] 21.5 Create `MqttManager` -- native TCP primary, WSS fallback, auto-reconnect
- [ ] 21.6 Create `MqttForegroundService` -- optional always-on background MQTT
- [ ] 21.7 Create `TerminalRelayClient` -- OkHttp WebSocket to relay server
- [ ] 21.8 Create `TerminalSessionBridge` -- pipe WebSocket bytes -> TerminalSession
- [ ] 21.9 Build `TerminalScreen` -- Termux TerminalView in AndroidView (read-only, 200x50)
- [ ] 21.10 Build `TerminalViewModel` -- manages WebSocket connection + mid-stream join
- [ ] 21.11 Build `SessionListScreen` + ViewModel -- REST initial load + MQTT real-time updates
- [ ] 21.12 Build `SessionDetailScreen` + ViewModel -- activity feed + state indicator
- [ ] 21.13 Build `AnswerDialog` -- answer blocked session questions via REST
- [ ] 21.14 Build `StateIndicator` -- color-coded XState state chip composable
- [ ] 21.15 Build `SnapshotViewer` -- SVG/ANSI snapshot display
- [ ] 21.16 Build `RecordingScreen` -- asciinema-player with presigned MinIO URLs
- [ ] 21.17 Build `SettingsScreen` -- transport status, always-on toggle, ntfy config, battery guide
- [ ] 21.18 Create `NtfyReceiver` -- subscribe to ntfy.sh topic for push notifications
- [ ] 21.19 Create notification channels (action-required + completions) in Application.onCreate
- [ ] 21.20 Handle notification deep links -- navigate to session/answer dialog
- [ ] 21.21 Implement `AppLifecycleObserver` -- foreground sync (MQTT + REST safety net)
- [ ] 21.22 Implement `BatteryOptimization` helper -- detect + prompt for whitelisting
- [ ] 21.23 Add Compose navigation graph with deep link support
- [ ] 21.24 Build signed APK
- [ ] 21.25 Test on physical device -- LAN TCP path
- [ ] 21.26 Test on physical device -- WARP TCP path
- [ ] 21.27 Test on physical device -- WSS fallback
- [ ] 21.28 Test live terminal -- 200 cols, truecolor, scrollback, cursor
- [ ] 21.29 Test recording playback -- speed control, idle compression
- [ ] 21.30 Test ntfy push -- only blocked/error/complete arrive
- [ ] 21.31 Test notification throttling -- concurrent sessions don't flood
- [ ] 21.32 Test foreground resume sync -- missed MQTT messages appear
- [ ] 21.33 Test foreground service MQTT -- verify connection survives screen-off
- [ ] 21.34 Test battery optimization whitelist prompt

### Phase 22: Behavioral Test Suite
- [x] 22.1 Write full session lifecycle test (Todo -> Done)
- [x] 22.2 Write blocked -> resume lifecycle test
- [x] 22.3 Write RabbitMQ command -> pod XState transition test
- [x] 22.4 Write orchestrator aggregation test (events from multiple pods)
- [x] 22.5 Write concurrent session isolation test
- [x] 22.6 Write cleanup artifact verification test (tmux + worktree + DB + MinIO)
- [x] 22.7 Write terminal relay integration test (stream start -> data -> snapshot -> upload)
- [x] 22.8 Run full test suite -- verify all pass

### Phase 23: v4.0 Documentation & Cleanup
- [x] 23.1 Update `README.md` -- architecture, tech stack, orchestrator, RabbitMQ
- [x] 23.2 Update `CLAUDE.md` -- remove Redis, add XState/amqplib/ntfy.sh/MinIO
- [x] 23.3 Update `CHANGELOG.md` with v4.0 changes
- [x] 23.4 Bump `package.json` version to 4.0.0
- [x] 23.5 Final `bun run typecheck` + `bun test`
- [x] 23.6 Build all binaries: `bun run build`
- [x] 23.7 Build and push runner Docker image
- [x] 23.8 Build and push orchestrator Docker image
- [x] 23.9 Deploy orchestrator to K3s
- [x] 23.10 Deploy updated runner to K3s
- [ ] 23.11 End-to-end test: webhook -> RabbitMQ -> pod -> MQTT -> mobile + ntfy push

---

**Version:** 4.12.2 (XState, RabbitMQ, Live Terminal, Android App, Credential Management, Planning Redesign)
**Implementation Method:** Claude Code CLI with bash_tool validation
**Last Updated:** February 24, 2026

**Key Changes in v4.0:**
- XState state machine replacing ad-hoc state transitions
- RabbitMQ backbone replacing Redis pub/sub and workflow_dispatch chain
- Complete Redis removal (SQLite + RabbitMQ)
- Orchestrator extraction (webhook handler + REST API + push bridge)
- Live terminal streaming via tmux pipe-pane + WebSocket relay
- Terminal snapshots (ansi-to-svg) and session recordings (asciicast v2 + MinIO)
- Native Android app (Kotlin/Jetpack Compose) with MQTT, terminal view, ntfy push
- Behavioral test suite for full lifecycle validation
- Security hardening (timing-safe HMAC, webhook deduplication)

**Previous:**
- v3.4: Enhanced session fields, screenshot lifecycle
- v3.3: Column transition trigger matrix, selective triggers
- v3.2: Unified session lifecycle (one session per project item)
- v3.1: Planning templates, plan-issue sync, agent orchestration
- v3.0: GitHub Projects, Multi-Agent Swarm, Project Onboarding
- v2.1: Crash recovery, dependency updates, Redis -> SQLite migration

**Next Review:** After first successful deployment
