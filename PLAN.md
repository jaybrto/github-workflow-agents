# Claude Code GitHub Integration: Complete Implementation Plan
## With Long-Lived Pods, Git Worktrees, Parallel Sessions, and Resilient Question Handling

**Date Created:** February 5, 2026
**Last Updated:** February 10, 2026
**Version:** 3.4
**Target Setup:** k3s self-hosted runners with persistent Longhorn storage, SQLite tracking, and long-lived pods
**Implementation Method:** Claude Code CLI with integrated bash validation
**Estimated Time:** 4-5 hours for full setup + implementation

---

## Changelog

### v4.0 (February 14, 2026) - XState, RabbitMQ, Orchestrator, Mobile App

#### Architecture Overhaul
- **XState v5 state machine** at the pod level replacing lookup-table state management
- **RabbitMQ as communication backbone** — bidirectional messaging between pods, orchestrator, and mobile app
- **Extracted orchestrator service** — centralized control plane outside repo pods
- **Complete Redis removal** — SQLite per pod, RabbitMQ for cross-service communication

#### Live Terminal Streaming (Phase 20)
- Raw PTY byte streaming via tmux pipe-pane + WebSocket relay
- Mid-stream join via snapshot + stream
- Asciicast v2 recordings uploaded to MinIO S3
- SVG snapshots at lifecycle events stored in SQLite

#### Native Android App (Phase 21)
- Kotlin/Jetpack Compose with Termux terminal-view (200x50, truecolor)
- MQTT via Paho (native TCP primary, WSS fallback)
- Self-hosted push notifications via ntfy.sh (no Firebase)
- Three connectivity paths: LAN TCP → WARP TCP → WSS fallback

#### Security Hardening (Phase 16)
- Timing-safe HMAC verification for webhooks (fail closed)
- Webhook delivery deduplication via in-memory Map with 1-hour TTL

#### Infrastructure
- ntfy.sh self-hosted on K3s for push notifications
- MinIO S3 bucket for asciicast recordings with lifecycle policies
- Cloudflare Tunnel routes for MQTT WSS, terminal relay, ntfy, and orchestrator API
- WARP private network routing for native TCP MQTT access

#### New Dependencies
- Added: `xstate@^5.26.0`, `amqplib@^0.10.7`, `ansi-to-svg`, `@aws-sdk/client-s3`
- Removed: `ioredis`, `@opentelemetry/instrumentation-ioredis`

---

### v3.4 (February 10, 2026) - Enhanced Project Fields & Screenshot Tracking

#### 🆕 New Custom Fields for Session Visibility
Added 5 new custom fields to GitHub Project for better session observability:
| Field | Type | Purpose |
|-------|------|---------|
| Pod Name | TEXT | K8s pod running the session (from `hostname` or `POD_NAME` env) |
| Tmux Window | TEXT | Tmux window/pane ID for the session |
| Kubectl Command | TEXT | Full command to attach: `kubectl exec -it <pod> -- tmux attach -t gwa-work:<window>` |
| Worktree Path | TEXT | Git worktree path (e.g., `/home/runner/worktrees/issue-42`) |
| Sub Agents Used | TEXT | Comma-separated names of spawned Claude sub-agents |

#### 🆕 Project Item ID Tracking
- Webhook passes `project_item_id` to transitions
- Fallback: query GitHub API using issue number
- Always stored in SQLite sessions table for persistence

#### 🆕 Screenshot Lifecycle Management
- Screenshots always saved to `/tmp/gwa-screenshots/` for troubleshooting
- Tracked in SQLite `screenshots` table with session_id
- Attached to comments only on errors/anomalies (cost optimization)
- Automatically deleted when session transitions to Done

#### 🆕 Progress Comments
- Status updates posted to issue as work progresses
- Shows active sub-agents, current task, completion progress
- Dynamic updates when architect spawns workers

#### 🆕 Enhanced `start-planning.ts`
- Calls `updateSessionFields()` with all new fields
- Posts REPL start comment to issue with attach command
- Stores project_item_id in SQLite

#### 🔧 Schema Migration
- Added `project_item_id TEXT` column to sessions table
- Index on `project_item_id` for fast lookups

---

### v3.3 (February 9, 2026) - Column Transition Triggers

#### 🆕 Selective Workflow Triggers
- Not every column move triggers Claude - each transition has specific action
- Trigger matrix defines what runs on each transition
- Claude, Playwright, CI/CD, or nothing depending on transition

#### 🆕 Trigger Types by Transition
| Transition | Trigger | Action |
|------------|---------|--------|
| Todo → Planning | **Claude** | Create session, start planning REPL |
| Planning → In Progress | **Claude** | Inject `prompt.md` into existing REPL |
| In Progress → QA | **Playwright** | Run e2e tests (Claude paused) |
| QA → Review | None | Status update only |
| QA → In Progress | **Claude** | Resume REPL with failure context |
| Review → Done | **CI/CD** | Deploy to production + cleanup session |
| Any → Blocked | None | Session preserved, waiting |
| Blocked → Previous | **Claude** | Send answer to REPL |

#### 🆕 Workflow YAML Pattern
- Single workflow routes based on `from` and `to` columns
- Conditional steps for each trigger type
- Scripts: `start-planning-session.sh`, `inject-prompt.sh`, `run-playwright.sh`, `deploy-and-cleanup.sh`

---

### v3.2 (February 9, 2026) - Unified Session Lifecycle

#### 🆕 One Session Per Project Item
- Session created when item enters **Planning** column
- Same session persists through: Planning → In Progress → QA → Review
- Session only destroyed when item reaches **Done**
- Blocked state preserves session, returns to previous column

#### 🆕 Session State Mapping
| Column | Session Status | Tmux State |
|--------|---------------|------------|
| Todo | (none) | (none) |
| Planning | `running` | Window 1: planning agent |
| In Progress | `running` | Window 1: architect, Windows 2-N: workers |
| QA | `paused` | Windows preserved, no active REPL |
| Blocked | `blocked` | Windows preserved, waiting for input |
| Review | `idle` | Windows preserved, awaiting merge |
| Done | `completed` | All windows destroyed |

#### 🆕 Benefits
- Context preserved across entire lifecycle (planning → implementation)
- Single session ID enables `claude --resume` across phases
- Human can attach to same tmux window throughout
- Worker windows (2,3,4...) ephemeral, architect window (1) persists
- Simpler crash recovery - just resume the one session

---

### v3.1 (February 9, 2026) - Planning Templates & Plan-Issue Sync

#### 🆕 Planning Templates
- Rigid document templates for planning phase in `templates/plans/`
- `plan.md` - Full implementation spec with agent orchestration section
- `prompt.md` - Injection prompt templates for architect and workers
- `checklist.md` - Progress tracking with quick commands
- `decisions.md` - Q&A log, design decisions, assumptions
- `snippets.md` - Code context excerpts for worker agents
- Plans instantiated to `.plans/issue-{N}/` per issue

#### 🆕 Plan-Issue Sync (`src/lib/plan-sync.ts`)
- Plans surfaced in GitHub issue description with status table
- Collapsible plan summary posted as issue comment
- Progress updates posted during implementation
- Project item custom fields updated with plan metadata
- Humans can review plans without cloning repo

#### 🆕 Agent Orchestration in Plans
- Task breakdown with skills, dependencies, scope
- Worker assignments with tmux window numbers
- Dependency graph for parallel execution
- Validation criteria per task

---

### v3.0 (February 9, 2026) - GitHub Projects & Multi-Agent Swarm

#### 🆕 GitHub Projects Integration (Phase 12)
- Full GitHub Projects v2 integration with GraphQL API
- Project workflow: Todo → Planning → In Progress → QA → Blocked → Review → Done
- Column-based workflow triggers (move to Planning → start planning session)
- 18+ custom fields: Session ID, Tmux Window, Pod Name, Kubectl Command, etc.
- Project template stored in `templates/github-project.json`
- `src/lib/projects.ts` - update items, sync fields, add comments
- `src/lib/pr-filter.ts` - only process Claude-created PRs (branch `claude/*` + label)
- New tables: `project_items`, `implementation_plans`, `qa_runs`

#### 🆕 Multi-Agent Swarm Architecture (Phase 13)
- Architect + Worker pattern in same tmux session, multiple windows
- Architect orchestrates, breaks down plans, assigns tasks
- Workers work in parallel on specific tasks, report progress
- `src/lib/swarm.ts` - spawn workers, track progress, validate work
- New table: `agent_tasks` for inter-agent communication
- Project-specific agents/skills committed to target repos
- Templates: `templates/agents/`, `templates/skills/`

#### 🆕 Planning Mode
- Detailed implementation plans stored in `.plans/issue-{N}.md`
- Plans also linked in issue description
- Work breakdown for parallel sub-agent execution
- Human approval gates (move card to approve plan)
- `implementation_plans` table tracks versions and approvals

#### 🆕 QA Automation (Phase 12)
- Playwright e2e tests triggered when item moves to QA column
- `qa_runs` table tracks test results
- Failures detailed for Claude to fix when moved back to In Progress
- Auto-move to Review if all tests pass (optional)

#### 🆕 Project Onboarding (Phase 14)
- ArgoCD PostSync hook creates GitHub Project automatically
- Helm values for project configuration
- `src/setup-project.ts` - creates project, columns, fields, links repo
- Copies agent/skill templates to new repos

#### 🔒 Smart PR Filtering
- Only triggers on PRs created by Claude or allowed authors
- Branch naming: `claude/issue-{N}-{description}`
- Label: `created-by-claude`
- Ignores other AI agents (Jules, Gemini, etc.)

---

### v2.1 (February 9, 2026) - Crash Recovery & Dependency Updates

#### 🆕 Crash Recovery & Replay
- Added `claude_session_id` to sessions table for `claude --resume`
- New `responses` table - stores Claude's responses for crash replay
- New `checkpoints` table - state snapshots before major actions (git state, tmux capture)
- New `conversation_history` table - ordered message log for replay
- Enhanced `recovery.ts` with `buildResumeCommand()` for interrupted sessions
- New `checkpoint.ts` utility for creating checkpoints and recording history

#### 🆕 Dependency Updates
- New `updater.ts` - checks for Claude CLI and SDK updates
- New `update_queue` and `dependency_versions` tables
- Entrypoint applies pending updates on pod startup (when no active sessions)
- Weekly CronJob (`claude-update`) for forced dependency refresh

#### 🔄 Redis → SQLite Migration
- All session tracking migrated from Redis to SQLite (WAL mode)
- Database stored on Longhorn PVC - no external dependency
- Cleanup CronJob updated to use SQLite queries
- All workflow YAML updated to poll SQLite instead of Redis

#### 📸 Lightweight Screenshots
- Base64 inline images for GitHub comments (<75KB limit)
- CLI tools: `aha` + `wkhtmltoimage` instead of heavy npm packages
- Conditional vision verification (only when anomalies detected)

---

### v2.0 (February 5, 2026) - Initial Implementation
- Interactive REPL architecture (not headless)
- Long-lived pods with Longhorn storage
- Git worktrees for parallel work
- Question/answer flow via PR comments
- Hybrid Bun + Shell tooling

---

## Executive Summary

This plan implements a **production-ready Claude Code automation system** that:

- ✅ Runs **one persistent pod per repository** (not ephemeral runners)
- ✅ Uses **Interactive Claude REPL** (long-lived sessions, not headless one-shots)
- ✅ Handles **multiple concurrent work streams** via git worktrees + tmux windows
- ✅ **Persists session data** across pod restarts using Longhorn
- ✅ **Tracks work→tmux mappings** in SQLite for intelligent resumption
- ✅ **Blocks gracefully** when Claude asks questions (REPL stays running, waiting)
- ✅ **Resumes seamlessly** when you respond with `@claude-answer: ...` (no restart needed)
- ✅ Provides **hybrid human oversight** (attach to tmux anytime, take over, guide Claude)
- ✅ Uses **hybrid Bun + Shell tooling** (type-safe SDK interactions + simple orchestration)
- ✅ **Scoped sessions:** Feature work → PR created → new session for PR review
- ✅ **GitHub Projects integration** with column-based workflow triggers
- ✅ **Multi-agent swarm** with architect + worker agents in separate tmux windows
- ✅ **Planning mode** with detailed implementation plans and human approval gates
- ✅ **QA automation** via Playwright e2e tests triggered by project column moves
- ✅ **Smart PR filtering** - only triggers on Claude-created PRs (not other AI agents)

### Execution Modes

| Mode | Use Case | How |
|------|----------|-----|
| **Interactive REPL** | Primary work (features, PR review) | `claude` in tmux, long-lived |
| **Headless** | Quick isolated tasks | `claude --print "task"` |
| **SDK** | Vision verification, summaries | `@anthropic-ai/sdk` API calls |

---

## Interactive REPL Architecture

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  FEATURE SESSION                                                 │
│                                                                  │
│  Issue Created/Assigned                                          │
│       │                                                          │
│       ▼                                                          │
│  Claude REPL starts in tmux window                               │
│       │                                                          │
│       ├─► Works on feature in git worktree                       │
│       ├─► Asks questions → REPL blocks → answer via tmux         │
│       ├─► Human can attach anytime                               │
│       ├─► Creates commits, pushes to branch                      │
│       │                                                          │
│       ▼                                                          │
│  Creates PR (gh pr create)                                       │
│       │                                                          │
│       ▼                                                          │
│  SESSION ENDS ─────────────────────────────────────────────────► │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PR SESSION                                                      │
│                                                                  │
│  PR Created/Updated/Commented                                    │
│       │                                                          │
│       ▼                                                          │
│  NEW Claude REPL starts in tmux window                           │
│       │                                                          │
│       ├─► Reviews feedback, makes changes                        │
│       ├─► Asks clarifying questions → blocks → gets answers      │
│       ├─► Human can attach to guide                              │
│       ├─► Pushes updates to PR branch                            │
│       │                                                          │
│       ▼                                                          │
│  PR Merged or Closed                                             │
│       │                                                          │
│       ▼                                                          │
│  SESSION ENDS ─────────────────────────────────────────────────► │
└─────────────────────────────────────────────────────────────────┘
```

### How the REPL Works

**Starting a session:**
```bash
# GitHub Actions workflow sends to tmux:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:pr-123 \
  "cd /home/runner/worktrees/pr-123 && claude" Enter

# Wait for REPL to initialize, then send the prompt:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:pr-123 \
  "Implement feature X based on issue #42" Enter
```

**Question handling:**
```bash
# Claude asks a question → REPL blocks waiting for input
# Bun tool detects question (pattern matching + SQLite status)
# Posts question to GitHub PR comment
# User responds: @claude-answer: Use approach B

# Webhook triggers, answer sent to REPL:
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:pr-123 \
  "Use approach B" Enter

# Claude continues with full context preserved
```

**Human takeover:**
```bash
# Attach to watch Claude work:
kubectl exec -it claude-runner-0 -- tmux attach -t claude-work:pr-123

# Now you can:
# - Watch Claude's thinking in real-time
# - Type directly to guide Claude
# - Ctrl+B d to detach and let Claude continue
```

**Session end:**
```bash
# After PR created (feature session) or PR merged (PR session):
# Claude writes status to SQLite: status=complete
# Workflow detects completion, cleans up tmux window
# Worktree preserved for potential follow-up
```

### SQLite Status Tracking

Claude writes status to SQLite so workflows can poll without parsing tmux output:

```typescript
// Claude updates status via Bun tools
db.run(`UPDATE sessions SET status = ?, last_activity_at = unixepoch() WHERE id = ?`,
  ['blocked', 'pr-123']);

// Workflow polls via kubectl exec
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT status FROM sessions WHERE id = 'pr-123'"
# Returns: running | blocked | complete | error | interrupted
```

```sql
-- Session status flow:
-- pending → starting → running → blocked → running → complete
--                  ↓                                    ↓
--              interrupted                           error

-- Workflow queries:
SELECT status, last_activity_at FROM sessions WHERE id = 'pr-123';

-- Check for pending questions:
SELECT question FROM questions
WHERE session_id = 'pr-123' AND status = 'posted';
```

### Question Detection

**Dual approach for reliability:**

1. **Explicit (preferred):** Claude uses `/ask` command or calls `ask-question` tool
   - Claude: `/ask Should I use caching here?`
   - Tool writes to SQLite, posts to GitHub, waits for answer

2. **Pattern detection (fallback):** Monitor `tmux capture-pane` output
   - Look for: "?", "Should I", "Do you want", "I have a question"
   - If detected and SQLite status isn't "blocked", treat as question
   - Prevents missed questions if Claude forgets to use explicit tool

---

## Implementation with Claude Code CLI

**This plan is designed to be implemented using Claude Code CLI** (the `claude` command-line tool).

### Why Claude Code CLI for Implementation?

- ✅ **Integrated bash validation:** Claude can write files AND validate them using real tools
- ✅ **File operations:** Claude reads/writes/tests directly in your implementation directory
- ✅ **Real validation:** yamllint, bash -n, shellcheck, docker build --dry-run (not simulation)
- ✅ **Immediate feedback:** Validation errors caught before you deploy
- ✅ **Incremental delivery:** Phase by phase, validated as you go

### Workflow

```
1. Create implementation directory
   mkdir ~/claude-implementation
   cd ~/claude-implementation
   
2. Start Claude Code CLI
   claude
   
3. Paste the implementation prompt (with full plan)
   
4. Claude generates artifacts with integrated bash validation:
   - Writes Dockerfile → validates with: docker build --dry-run
   - Writes YAML → validates with: yamllint
   - Writes bash scripts → validates with: bash -n
   - Shows validation output for each
   
5. Once Claude confirms all ready:
   - Files exist in /Users/jay.barreto/dev/util/bto/github-workflow-agents/
   - All validated and production-ready
   - Ready for `kubectl apply` and `docker build`
```

---

## Executive Summary (Original)

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Phase 1: Generate OAuth Token](#phase-1-generate-oauth-token)
3. [Phase 2: k3s Infrastructure Setup (Longhorn, StorageClass)](#phase-2-k3s-infrastructure-setup)
4. [Phase 3: StatefulSet & Long-Lived Pod Configuration](#phase-3-statefulset--long-lived-pod-configuration)
5. [Phase 4: SQLite Database Schema & Tracking](#phase-4-sqlite-database-schema--tracking)
6. [Phase 5: GitHub App Installation & Secrets](#phase-5-github-app-installation--secrets)
7. [Phase 6: Container Image Build](#phase-6-container-image-build)
8. [Phase 6b: Bun CLI Tools (Hybrid Approach)](#phase-6b-bun-cli-tools)
9. [Phase 6c: Screenshot Capture & Vision Verification](#phase-6c-screenshot-capture--vision-verification-lightweight)
10. [Phase 7: GitHub Workflows (Main + Question Response)](#phase-7-github-workflows)
11. [Phase 8: CronJob for Cleanup](#phase-8-cronjob-for-cleanup)
12. [Phase 9: Repository Configuration (CLAUDE.md, Skills)](#phase-9-repository-configuration)
13. [Phase 10: Testing & Validation](#phase-10-testing--validation)
14. [Phase 11: Troubleshooting & Monitoring](#phase-11-troubleshooting--monitoring)
15. [Phase 12: GitHub Projects Integration](#phase-12-github-projects-integration)
16. [Phase 13: Multi-Agent Swarm Architecture](#phase-13-multi-agent-swarm-architecture)
17. [Phase 14: Project Onboarding (Helm/ArgoCD)](#phase-14-project-onboarding-helmargocd)
18. [v4.0 Upgrade Plan](#v40-upgrade-plan)
19. [Phase 15: v4.0 Prerequisites](#phase-15-v40-prerequisites)
20. [Phase 16: Security Hardening](#phase-16-security-hardening)
21. [Phase 17: XState State Machine](#phase-17-xstate-state-machine)
22. [Phase 18: Remove Redis](#phase-18-remove-redis)
23. [Phase 19: RabbitMQ Backbone + Orchestrator](#phase-19-rabbitmq-backbone--orchestrator-extraction)
24. [Phase 20: Live Terminal Streaming](#phase-20-live-terminal-streaming--snapshots)
25. [Phase 21: Native Android App](#phase-21-native-android-mobile-app)
26. [Phase 22: Behavioral Test Suite](#phase-22-behavioral-test-suite)
27. [Phase 23: v4.0 Documentation & Cleanup](#phase-23-v40-documentation--cleanup)

---

## Prerequisites

Before starting, ensure you have:

- ✅ Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`
- ✅ Anthropic API key configured (for Claude Code)
- ✅ k3s cluster running (6 nodes as per your homelab)
- ✅ `kubectl` access to your k3s cluster
- ✅ **Longhorn installed** (for persistent volumes including SQLite DB)
- ✅ GitHub repository admin access
- ✅ GitHub CLI (`gh`) installed locally
- ✅ Bun installed (for building CLI tools)

**Note:** Redis is NOT required. Session tracking uses SQLite stored on the Longhorn PVC.

### Validation Tools (Claude Code CLI will use these for validation)

These should be available on your system where you'll run `claude` command:

```bash
# YAML validation
yamllint --version
python3 -c "import yaml; print('yaml available')"

# Bash validation
bash --version
shellcheck --version  # optional but recommended

# Docker validation (for Dockerfile)
docker --version

# k8s/kubectl (for testing manifests)
kubectl version
```

If any are missing:

```bash
# Ubuntu/Debian
sudo apt-get install yamllint shellcheck docker.io

# macOS
brew install yamllint shellcheck docker

# Python yaml module (if not installed)
pip install pyyaml
```

---

## Implementation Setup (Before Starting Any Phase)

### Create Implementation Directory

```bash
# Create a clean directory for all implementation artifacts
mkdir -p ~/claude-implementation
cd ~/claude-implementation

# This is where Claude Code CLI will write all YAML, Dockerfiles, and scripts
# After Claude finishes, you'll deploy from this directory
```

### Start Claude Code CLI

```bash
# In your implementation directory
claude

# Claude is now ready to generate artifacts
```

### What Claude Will Do

When you paste the implementation prompt into Claude:
1. **Generate artifacts** using Write tool (creates files in /Users/jay.barreto/dev/util/bto/github-workflow-agents/)
2. **Validate each artifact** using bash_tool (yamllint, bash -n, docker build --dry-run, etc.)
3. **Show validation results** in the terminal
4. **Confirm "ready to deploy"** when all validation passes

---

## Phase 1: Generate OAuth Token

### Step 1.1: Generate Long-Lived OAuth Token

On your local machine with Claude CLI installed:

```bash
# Make sure you're logged into Claude Max subscription
claude /login

# Generate long-lived token
claude setup-token

# This outputs something like:
# {
#   "access_token": "sk-ant-oat01-...",
#   "refresh_token": "sk-ant-oat01-refresh-...",
#   "expires_at": "2026-03-06..."
# }
```

### Step 1.2: Save Token Safely

```bash
# Copy access_token (NOT refresh_token for this workflow)
# You'll need: sk-ant-oat01-...
```

**⚠️ CRITICAL:** Store this token securely. Never commit it to Git.

---

## Phase 2: k3s Infrastructure Setup

### Step 2.1: Verify Longhorn Installation

```bash
# Check if Longhorn is installed
kubectl get namespace longhorn-system
kubectl get pods -n longhorn-system | head -10

# If not installed, follow Longhorn docs: https://longhorn.io/docs/latest/deploy/install/install-with-helm/
```

### Step 2.2: Create Claude-Specific StorageClass

```bash
kubectl apply -f - <<'EOF'
apiVersion: storage.longhorn.io/v1beta1
kind: StorageClass
metadata:
  name: longhorn-claude
provisioner: driver.longhorn.io/longhorn
parameters:
  numberOfReplicas: "2"  # Replicate across nodes for HA
  staleReplicaTimeout: "2880"
  defaultDataLocality: "best-effort"
allowVolumeExpansion: true

---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: claude-session-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn-claude
  resources:
    requests:
      storage: 50Gi  # Enough for multi-session history + code checkouts
EOF
```

### Step 2.3: Verify Storage

```bash
# Check StorageClass
kubectl get sc longhorn-claude

# Check PVC
kubectl get pvc claude-session-pvc
# Should show: Bound
```

---

## Phase 3: StatefulSet & Long-Lived Pod Configuration

### Step 3.1: Create ConfigMap for Pod Initialization

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: claude-runner-init
  namespace: default
data:
  entrypoint.sh: |
    #!/bin/bash
    set -e

    REPO=${REPO:-}
    POD_NAME=$(hostname)
    DB_PATH=/home/runner/.claude/gwa.db

    echo "[Claude Runner] Starting long-lived pod for repo: $REPO"

    # Authenticate with GitHub
    if [ -f "/run/secrets/github_token" ]; then
      gh auth login --with-token < /run/secrets/github_token
    fi

    # Initialize database and run recovery
    echo "[Claude Runner] Initializing SQLite database..."
    if command -v bun &> /dev/null && [ -f /home/runner/.claude/schema.sql ]; then
      bun run /home/runner/.claude/init-db.ts 2>/dev/null || true
    fi

    # Run startup recovery for interrupted sessions
    echo "[Claude Runner] Running recovery for interrupted sessions..."
    if command -v bun &> /dev/null && [ -f /home/runner/dist/bin/recovery ]; then
      /home/runner/dist/bin/recovery 2>/dev/null || true
    fi

    # Apply pending dependency updates if no active sessions
    echo "[Claude Runner] Checking for pending updates..."
    if command -v bun &> /dev/null && [ -f /home/runner/dist/bin/check-updates ]; then
      /home/runner/dist/bin/check-updates --apply-pending 2>/dev/null || true
    fi

    # Clone repo once (main worktree)
    if [ ! -d /home/runner/repo ]; then
      echo "[Claude Runner] Cloning repo..."
      git clone https://github.com/${REPO}.git /home/runner/repo
    fi

    # Create worktrees directory
    mkdir -p /home/runner/worktrees

    # Register this pod in SQLite config
    sqlite3 $DB_PATH "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('pod_name', '$POD_NAME', unixepoch())"
    sqlite3 $DB_PATH "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('repo', '$REPO', unixepoch())"

    # Initialize tmux session if not running
    if ! pgrep -x tmux > /dev/null; then
      echo "[Claude Runner] Starting tmux session..."

      # Create main session with status window
      tmux new-session -d -s claude-work -x 200 -y 50 -c /home/runner/repo

      # Window 0: Status/monitoring
      tmux rename-window -t claude-work:0 "status"
      tmux send-keys -t claude-work:status \
        "watch -n 5 'sqlite3 -header -column $DB_PATH \"SELECT id, status, github_number FROM sessions WHERE status IN (\\\"running\\\", \\\"blocked\\\")\" 2>/dev/null || echo \"Waiting for work...\"'" Enter
    fi

    echo "[Claude Runner] Pod ready. Keeping session alive..."
    exec tail -f /dev/null
EOF
```

### Step 3.2: Create Service for pod accessibility

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Service
metadata:
  name: claude-runner
  namespace: default
spec:
  clusterIP: None
  selector:
    app: claude-runner
  ports:
  - name: tmux
    port: 22
    targetPort: 22
EOF
```

### Step 3.3: Deploy StatefulSet

**NOTE:** Update `REPO` value for each repo you want to track:

```bash
kubectl apply -f - <<'EOF'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: claude-runner
  namespace: default
spec:
  serviceName: claude-runner
  replicas: 1
  selector:
    matchLabels:
      app: claude-runner
      repo: "owner-repo"  # CHANGE THIS: owner/repo or owner-repo
  template:
    metadata:
      labels:
        app: claude-runner
        repo: "owner-repo"  # CHANGE THIS
    spec:
      containers:
      - name: claude-agent
        image: your-registry/claude-runner:latest  # Built in Phase 6
        imagePullPolicy: IfNotPresent
        resources:
          requests:
            memory: "2Gi"
            cpu: "1000m"
          limits:
            memory: "4Gi"
            cpu: "2000m"
        env:
        - name: REPO
          value: "owner/repo"  # CHANGE THIS
        - name: DB_PATH
          value: "/home/runner/.claude/gwa.db"
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        volumeMounts:
        - name: claude-session
          mountPath: /home/runner/.claude
        - name: shared-tmux
          mountPath: /tmp/tmux
        - name: init-script
          mountPath: /entrypoint.sh
          subPath: entrypoint.sh
        lifecycle:
          postStart:
            exec:
              command:
              - /bin/bash
              - -c
              - |
                chmod +x /entrypoint.sh
                /entrypoint.sh &
      volumes:
      - name: shared-tmux
        emptyDir: {}
      - name: init-script
        configMap:
          name: claude-runner-init
          defaultMode: 0755
  volumeClaimTemplates:
  - metadata:
      name: claude-session
    spec:
      accessModes:
        - ReadWriteOnce
      storageClassName: longhorn-claude
      resources:
        requests:
          storage: 50Gi
EOF
```

### Step 3.4: Verify Pod is Running

```bash
# Check StatefulSet
kubectl get statefulset claude-runner

# Check pod
kubectl get pods -l app=claude-runner
# Should show: claude-runner-0 in Running state

# Verify tmux is ready
kubectl exec -it claude-runner-0 -- tmux list-windows -t claude-work
```

---

## Phase 4: SQLite Database Schema & Tracking

### Why SQLite Instead of Redis?

- **Co-located with session data** - Lives on same Longhorn PVC
- **No network dependency** - Database down ≠ workflow broken
- **Richer queries** - Joins, aggregations, full audit history
- **Startup recovery** - Easy to mark stale sessions on pod restart
- **One source of truth** - No split between Redis and filesystem

### Step 4.1: Database Location

```
/home/runner/.claude/
├── gwa.db                    # Single SQLite database (WAL mode)
├── gwa.db-wal                # WAL file (auto-created)
├── gwa.db-shm                # Shared memory (auto-created)
└── sessions/
    ├── pr-123/               # Session working directory
    └── issue-42/
```

### Step 4.2: Complete Schema

```sql
-- /home/runner/.claude/schema.sql

-- Enable WAL mode for concurrent access (5+ sessions)
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

-- ============================================
-- SESSIONS: Core session tracking
-- ============================================
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,              -- "pr-123" or "issue-42"
    type TEXT NOT NULL,               -- "feature" | "pr" | "review"
    status TEXT NOT NULL DEFAULT 'pending',
                                      -- "pending" | "starting" | "running" |
                                      -- "blocked" | "complete" | "error" | "interrupted"

    -- GitHub context
    github_number INTEGER NOT NULL,   -- PR or Issue number
    github_type TEXT NOT NULL,        -- "pull_request" | "issue"
    branch TEXT,                      -- Branch name
    base_branch TEXT,                 -- Target branch (for PRs)

    -- Infrastructure
    tmux_window INTEGER,              -- tmux window number
    worktree_path TEXT,               -- /home/runner/worktrees/pr-123
    repl_pid INTEGER,                 -- PID of claude process (for liveness check)
    repl_active INTEGER DEFAULT 0,    -- 1 if REPL is running
    claude_session_id TEXT,           -- Claude CLI's internal session ID for --resume

    -- Timestamps
    created_at INTEGER DEFAULT (unixepoch()),
    started_at INTEGER,               -- When REPL started
    completed_at INTEGER,
    interrupted_at INTEGER,           -- Set on crash recovery
    last_activity_at INTEGER,         -- Updated on any activity

    -- Summary
    initial_prompt TEXT,              -- What started this session
    completion_summary TEXT,          -- Final summary when done
    error_message TEXT                -- If status = "error"
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_github ON sessions(github_type, github_number);

-- ============================================
-- QUESTIONS: Track all questions and answers
-- ============================================
CREATE TABLE questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    -- Question
    question TEXT NOT NULL,
    question_context TEXT,            -- What Claude was doing when it asked
    screenshot_path TEXT,             -- Path to screenshot file
    github_comment_id INTEGER,        -- ID of posted GitHub comment

    -- Answer
    answer TEXT,
    answered_by TEXT,                 -- GitHub username

    -- Timestamps
    asked_at INTEGER DEFAULT (unixepoch()),
    posted_at INTEGER,                -- When posted to GitHub
    answered_at INTEGER,

    -- Status
    status TEXT DEFAULT 'pending'     -- "pending" | "posted" | "answered" | "timeout"
);

CREATE INDEX idx_questions_session ON questions(session_id);
CREATE INDEX idx_questions_status ON questions(status);

-- ============================================
-- PROMPTS: Track all prompts sent to session
-- ============================================
CREATE TABLE prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    prompt TEXT NOT NULL,
    source TEXT NOT NULL,             -- "initial" | "followup" | "answer" | "human_takeover"
    triggered_by TEXT,                -- GitHub username or "workflow"
    github_comment_id INTEGER,        -- Source comment if from GitHub

    sent_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_prompts_session ON prompts(session_id);

-- ============================================
-- COMMITS: Track commits made by Claude
-- ============================================
CREATE TABLE commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    commit_hash TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    files_changed INTEGER,
    insertions INTEGER,
    deletions INTEGER,

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_commits_session ON commits(session_id);

-- ============================================
-- TOOL_CALLS: Track tools Claude uses
-- ============================================
CREATE TABLE tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    tool_name TEXT NOT NULL,          -- "Read", "Edit", "Bash", etc.
    tool_input TEXT,                  -- JSON of input params (truncated)
    tool_result TEXT,                 -- Summary of result (truncated)
    success INTEGER DEFAULT 1,        -- 1 = success, 0 = failed
    duration_ms INTEGER,

    called_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name);

-- ============================================
-- ACTIVITY_LOG: Audit trail of all events
-- ============================================
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,

    event TEXT NOT NULL,              -- See event types below
    details TEXT,                     -- JSON with event-specific data
    actor TEXT,                       -- "claude" | "workflow" | GitHub username

    created_at INTEGER DEFAULT (unixepoch())
);

-- Event types:
-- "session_created", "session_started", "session_interrupted", "session_completed"
-- "repl_started", "repl_crashed", "repl_recovered"
-- "prompt_sent", "question_asked", "question_answered", "question_timeout"
-- "commit_created", "pr_created", "pr_merged"
-- "human_attached", "human_detached", "human_input"
-- "error", "warning"

CREATE INDEX idx_activity_session ON activity_log(session_id);
CREATE INDEX idx_activity_event ON activity_log(event);
CREATE INDEX idx_activity_time ON activity_log(created_at);

-- ============================================
-- SCREENSHOTS: Track captured screenshots
-- ============================================
CREATE TABLE screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,

    file_path TEXT NOT NULL,          -- /home/runner/.claude/screenshots/...
    file_size INTEGER,
    event_type TEXT,                  -- "question" | "completion" | "error"

    captured_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_screenshots_session ON screenshots(session_id);

-- ============================================
-- CONFIG: Runtime configuration
-- ============================================
CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);

-- Default config
INSERT INTO config (key, value) VALUES
    ('pod_name', 'claude-runner-0'),
    ('repo', ''),
    ('initialized_at', unixepoch()),
    ('schema_version', '1');

-- ============================================
-- UPDATE_QUEUE: Track pending dependency updates
-- ============================================
CREATE TABLE update_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_type TEXT NOT NULL,        -- "image" | "npm" | "cli" | "all"
    target_version TEXT,              -- Version to update to (optional)
    reason TEXT,                      -- Why update was triggered

    queued_at INTEGER DEFAULT (unixepoch()),
    applied_at INTEGER,
    status TEXT DEFAULT 'pending',    -- "pending" | "applied" | "skipped" | "failed"
    error_message TEXT
);

CREATE INDEX idx_update_queue_status ON update_queue(status);

-- ============================================
-- DEPENDENCY_VERSIONS: Track installed versions
-- ============================================
CREATE TABLE dependency_versions (
    package TEXT PRIMARY KEY,         -- "@anthropic-ai/claude-code", "@anthropic-ai/sdk", etc.
    installed_version TEXT,
    latest_known_version TEXT,
    last_checked_at INTEGER,
    last_updated_at INTEGER
);

-- ============================================
-- RESPONSES: Store Claude's responses for replay
-- ============================================
CREATE TABLE responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_id INTEGER REFERENCES prompts(id) ON DELETE SET NULL,

    response_type TEXT NOT NULL,      -- "text" | "tool_use" | "thinking" | "error"
    content TEXT NOT NULL,            -- The actual response content
    content_truncated INTEGER DEFAULT 0, -- 1 if content was truncated for storage

    -- For tool use responses
    tool_name TEXT,                   -- If response_type = "tool_use"
    tool_input TEXT,                  -- JSON of tool input

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_responses_session ON responses(session_id);
CREATE INDEX idx_responses_prompt ON responses(prompt_id);

-- ============================================
-- CHECKPOINTS: State snapshots before major actions
-- ============================================
CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    checkpoint_type TEXT NOT NULL,    -- "pre_commit" | "pre_pr" | "pre_merge" | "manual" | "periodic"
    summary TEXT NOT NULL,            -- Claude's summary of current understanding
    files_modified TEXT,              -- JSON array of modified files
    pending_actions TEXT,             -- JSON of what Claude was about to do

    -- For recovery
    tmux_capture TEXT,                -- Full tmux pane content at checkpoint
    git_status TEXT,                  -- Output of git status at checkpoint
    git_diff_stat TEXT,               -- Output of git diff --stat at checkpoint

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_checkpoints_session ON checkpoints(session_id);
CREATE INDEX idx_checkpoints_type ON checkpoints(checkpoint_type);

-- ============================================
-- CONVERSATION_HISTORY: Ordered log for replay
-- ============================================
CREATE TABLE conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    role TEXT NOT NULL,               -- "user" | "assistant" | "system"
    content TEXT NOT NULL,            -- The message content
    content_type TEXT DEFAULT 'text', -- "text" | "tool_use" | "tool_result"

    -- Ordering
    sequence_num INTEGER NOT NULL,    -- Order within session
    turn_num INTEGER,                 -- Conversation turn number

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_conversation_session ON conversation_history(session_id, sequence_num);
```

### Step 4.3: Database Initialization

The database is initialized on first pod startup via `src/lib/db.ts`:

```typescript
import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';

const DB_PATH = '/home/runner/.claude/gwa.db';
const SCHEMA_PATH = '/home/runner/.claude/schema.sql';

export function initDatabase(): Database {
  const db = new Database(DB_PATH);

  // Enable WAL mode for concurrent access
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');

  // Check if initialized
  const hasSchema = db.query(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'
  `).get();

  if (!hasSchema) {
    console.log('[DB] Initializing database schema...');
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    db.exec(schema);
  }

  return db;
}

export function getDatabase(): Database {
  const db = new Database(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
```

### Step 4.4: Startup Recovery

When the pod restarts, mark any "running" sessions as interrupted and prepare for resume:

```typescript
// src/lib/recovery.ts
import { getDatabase } from './db';

export interface InterruptedSession {
  id: string;
  claude_session_id: string | null;
  github_number: number;
  github_type: string;
  tmux_window: number;
  worktree_path: string;
  last_checkpoint_id: number | null;
}

export function recoverStaleSessions(): number {
  const db = getDatabase();

  // Mark all active sessions as interrupted
  const result = db.run(`
    UPDATE sessions
    SET status = 'interrupted',
        repl_active = 0,
        interrupted_at = unixepoch(),
        last_activity_at = unixepoch()
    WHERE status IN ('running', 'blocked', 'starting')
      AND repl_active = 1
  `);

  // Log the recovery
  if (result.changes > 0) {
    db.run(`
      INSERT INTO activity_log (session_id, event, details, actor)
      SELECT id, 'session_interrupted',
             json_object('reason', 'pod_restart'), 'system'
      FROM sessions WHERE status = 'interrupted' AND interrupted_at = unixepoch()
    `);
  }

  console.log(`[Recovery] Marked ${result.changes} stale sessions as interrupted`);
  return result.changes;
}

/**
 * Get interrupted sessions that can be resumed
 */
export function getResumableSessions(): InterruptedSession[] {
  const db = getDatabase();

  return db.query(`
    SELECT
      s.id,
      s.claude_session_id,
      s.github_number,
      s.github_type,
      s.tmux_window,
      s.worktree_path,
      (SELECT MAX(id) FROM checkpoints c WHERE c.session_id = s.id) as last_checkpoint_id
    FROM sessions s
    WHERE s.status = 'interrupted'
      AND s.claude_session_id IS NOT NULL
    ORDER BY s.interrupted_at DESC
  `).all() as InterruptedSession[];
}

/**
 * Build resume command for an interrupted session
 */
export function buildResumeCommand(session: InterruptedSession): string {
  const db = getDatabase();

  // Try to use Claude's --resume if we have the session ID
  if (session.claude_session_id) {
    return `claude --resume ${session.claude_session_id}`;
  }

  // Otherwise, build a replay prompt from checkpoints and conversation history
  const checkpoint = db.query(`
    SELECT summary, pending_actions FROM checkpoints
    WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(session.id) as { summary: string; pending_actions: string } | null;

  const lastPrompts = db.query(`
    SELECT content FROM conversation_history
    WHERE session_id = ? AND role = 'user'
    ORDER BY sequence_num DESC LIMIT 3
  `).all(session.id) as { content: string }[];

  let resumePrompt = 'You were working on this task but the session was interrupted.\n\n';

  if (checkpoint) {
    resumePrompt += `**Your last checkpoint:**\n${checkpoint.summary}\n\n`;
    if (checkpoint.pending_actions) {
      resumePrompt += `**You were about to:**\n${checkpoint.pending_actions}\n\n`;
    }
  }

  if (lastPrompts.length > 0) {
    resumePrompt += '**Recent context:**\n';
    lastPrompts.reverse().forEach(p => {
      resumePrompt += `- ${p.content.substring(0, 200)}...\n`;
    });
  }

  resumePrompt += '\nPlease continue from where you left off.';

  return `claude -p "${resumePrompt.replace(/"/g, '\\"')}"`;
}
```

### Step 4.5: Debugging Queries

```bash
# Connect to SQLite in pod
kubectl exec -it claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db

# Useful queries:

# All active sessions
SELECT id, type, status, github_number, tmux_window
FROM sessions WHERE status IN ('running', 'blocked');

# Session with full details
SELECT s.*,
       (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id) as question_count,
       (SELECT COUNT(*) FROM commits c WHERE c.session_id = s.id) as commit_count
FROM sessions s WHERE s.id = 'pr-123';

# Pending questions
SELECT q.*, s.github_number
FROM questions q
JOIN sessions s ON q.session_id = s.id
WHERE q.status = 'posted';

# Recent activity
SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 20;

# Tool usage stats
SELECT tool_name, COUNT(*) as calls, AVG(duration_ms) as avg_ms
FROM tool_calls GROUP BY tool_name ORDER BY calls DESC;
```

---

## Phase 5: GitHub App Installation & Secrets

### Step 5.1: Install Claude GitHub App

```bash
cd /path/to/your/repo

# Run installation
claude /install-github-app

# Follow prompts to:
# 1. Click the link to GitHub app page
# 2. Install the app
# 3. Select your repository
# 4. Authorize
```

### Step 5.2: Add OAuth Token Secret

In GitHub web interface:

1. Go to **your-repo > Settings > Secrets and variables > Actions**
2. Click **New repository secret**
3. **Name:** `CLAUDE_CODE_OAUTH_TOKEN`
4. **Value:** `sk-ant-oat01-...` (from Phase 1.2)
5. Click **Add secret**

### Step 5.3: Create GitHub PAT for GitHub Actions

1. Go to **Settings > Developer settings > Personal access tokens > Tokens (classic)**
2. Click **Generate new token (classic)**
3. **Name:** `CLAUDE_RUNNER_PAT`
4. **Scopes needed:**
   - ✅ `repo` (Full control of private repositories)
   - ✅ `workflow` (Update GitHub Action workflows)
5. Copy the token and add as secret `GITHUB_TOKEN_RUNNER`

---

## Phase 6: Container Image Build

### Step 6.1: Create Dockerfile

```dockerfile
# Dockerfile for Claude Code runner with Bun tools
FROM oven/bun:latest as builder

WORKDIR /app

# Copy package.json and bun.lockb for dependencies
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --production

# Build Bun scripts into executables
COPY src/ src/
RUN bun build ./src/ask-question.ts --target bun --outdir ./dist/bin && \
    mv ./dist/bin/ask-question.ts ./dist/bin/ask-question && \
    bun build ./src/debug-db.ts --target bun --outdir ./dist/bin && \
    mv ./dist/bin/debug-db.ts ./dist/bin/debug-db && \
    bun build ./src/pod-health-check.ts --target bun --outdir ./dist/bin && \
    mv ./dist/bin/pod-health-check.ts ./dist/bin/pod-health-check && \
    bun build ./src/lib/updater.ts --target bun --outdir ./dist/bin && \
    mv ./dist/bin/updater.ts ./dist/bin/check-updates

# Runtime stage
FROM oven/bun:latest

# Install tmux, sqlite3, gh, git, screenshot tools, etc.
RUN apt-get update && apt-get install -y \
    tmux \
    sqlite3 \
    gh \
    git \
    curl \
    jq \
    watch \
    aha \
    wkhtmltopdf \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Copy compiled Bun scripts from builder
COPY --from=builder /app/dist/bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/*

# Create runner user
RUN useradd -m -d /home/runner runner
USER runner

# Set up Claude config directory
RUN mkdir -p /home/runner/.claude && \
    mkdir -p /home/runner/.config/gh

WORKDIR /home/runner

# Copy entrypoint will be mounted via ConfigMap
ENTRYPOINT ["tail", "-f", "/dev/null"]
```

### Step 6.2: Build and Push Image

```bash
# Build locally or use your container registry
docker build -t your-registry/claude-runner:latest .

# Push to registry
docker push your-registry/claude-runner:latest

# Update StatefulSet image reference (Phase 3.3)
```

---

## Phase 6b: Bun CLI Tools

This project uses a **hybrid Shell + Bun approach**:
- **Bun TypeScript** for tools that interact with external services (GitHub API, SQLite)
- **Shell scripts** for pure orchestration (kubectl, docker commands)

### Why Bun for CLI Tools?

- Type-safe interactions with GitHub SDK (`@octokit/rest`) and SQLite (`bun:sqlite`)
- Better error handling, retries, and structured logging
- Compiles to standalone binaries (no runtime dependencies in container)
- Aligns with tech stack preference (Bun, Go, Node.js — no Python)

### Step 6b.1: Create `package.json`

```json
{
  "name": "claude-runner-tools",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@octokit/rest": "^21.0.0",
    "@anthropic-ai/sdk": "^0.30.0"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "@types/node": "^22.0.0"
  }
}
```

**Note:** SQLite is built into Bun (`bun:sqlite`), no external dependency needed.

### Step 6b.2: `src/ask-question.ts` (Critical Path)

**Called by Claude from within the interactive REPL** when it needs user input.

This tool does NOT spawn Claude - it's called BY Claude to:
1. Post question to GitHub PR comment (with optional screenshot)
2. Update SQLite status to "blocked"
3. Wait for answer (polling SQLite)
4. Return answer to Claude so it can continue

```typescript
// Called from Claude REPL like:
// /mcp ask-question "Should I use caching for this endpoint?"

import { Database } from 'bun:sqlite';
import { Octokit } from '@octokit/rest';
import { captureScreen, toBase64DataUri } from './lib/screenshot';
import { getDatabase } from './lib/db';

export async function askQuestion(options: {
  question: string;
  sessionId: string;
  pod: string;
  window: string;
}): Promise<string> {
  const db = getDatabase();
  const github = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Get session info
  const session = db.query(`
    SELECT github_number, id FROM sessions WHERE id = ?
  `).get(options.sessionId) as { github_number: number; id: string };

  if (!session) throw new Error(`Session not found: ${options.sessionId}`);

  // Update session status to blocked
  db.run(`UPDATE sessions SET status = 'blocked', last_activity_at = unixepoch() WHERE id = ?`,
    [options.sessionId]);

  // Capture screenshot for context
  let screenshotMd = '';
  let screenshotPath = '';
  try {
    const screenshot = await captureScreen({ pod: options.pod, window: options.window });
    screenshotPath = `/home/runner/.claude/screenshots/${options.sessionId}-${Date.now()}.png`;
    await Bun.write(screenshotPath, screenshot);
    screenshotMd = `\n\n**Claude's screen:**\n![screenshot](${toBase64DataUri(screenshot)})`;
  } catch { /* continue without screenshot */ }

  // Post to GitHub
  const [owner, repo] = (process.env.REPO || '').split('/');
  const { data: comment } = await github.rest.issues.createComment({
    owner, repo,
    issue_number: session.github_number,
    body: `## 🤔 Claude is asking:\n\n${options.question}${screenshotMd}\n\n---\n**Reply with:** \`@claude-answer: your response\``
  });

  // Record question in database
  db.run(`
    INSERT INTO questions (session_id, question, screenshot_path, github_comment_id, status, posted_at)
    VALUES (?, ?, ?, ?, 'posted', unixepoch())
  `, [options.sessionId, options.question, screenshotPath, comment.id]);

  db.run(`
    INSERT INTO activity_log (session_id, event, details, actor)
    VALUES (?, 'question_asked', json_object('question', ?), 'claude')
  `, [options.sessionId, options.question]);

  // Wait for answer (webhook will update questions table)
  const answer = await pollForAnswer(db, options.sessionId);

  // Update status back to running
  db.run(`UPDATE sessions SET status = 'running', last_activity_at = unixepoch() WHERE id = ?`,
    [options.sessionId]);

  return answer;
}

async function pollForAnswer(db: Database, sessionId: string, timeoutMs = 86400000): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const question = db.query(`
      SELECT answer FROM questions
      WHERE session_id = ? AND status = 'answered'
      ORDER BY answered_at DESC LIMIT 1
    `).get(sessionId) as { answer: string } | null;

    if (question?.answer) {
      return question.answer;
    }

    await Bun.sleep(5000);  // Poll every 5 seconds
  }

  throw new Error('Timeout waiting for answer');
}
```

### Step 6b.3: `src/debug-db.ts`

Type-safe SQLite state inspection tool:

```typescript
import { getDatabase } from './lib/db';

export function debugDatabase() {
  const db = getDatabase();

  console.log('\n=== Active Sessions ===');
  const sessions = db.query(`
    SELECT id, type, status, github_number, tmux_window, repl_active,
           datetime(last_activity_at, 'unixepoch') as last_activity
    FROM sessions
    WHERE status NOT IN ('complete', 'error')
    ORDER BY last_activity_at DESC
  `).all();
  console.table(sessions);

  console.log('\n=== Pending Questions ===');
  const questions = db.query(`
    SELECT q.id, q.session_id, substr(q.question, 1, 50) as question,
           q.status, datetime(q.asked_at, 'unixepoch') as asked_at
    FROM questions q
    WHERE q.status IN ('pending', 'posted')
    ORDER BY q.asked_at DESC
  `).all();
  console.table(questions);

  console.log('\n=== Recent Activity ===');
  const activity = db.query(`
    SELECT session_id, event, actor,
           datetime(created_at, 'unixepoch') as time
    FROM activity_log
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  console.table(activity);

  console.log('\n=== Tool Usage Stats ===');
  const tools = db.query(`
    SELECT tool_name, COUNT(*) as calls,
           ROUND(AVG(duration_ms)) as avg_ms,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
    FROM tool_calls
    GROUP BY tool_name
    ORDER BY calls DESC
    LIMIT 10
  `).all();
  console.table(tools);
}

// CLI entry point
if (import.meta.main) {
  debugDatabase();
}
```

### Step 6b.4: `src/pod-health-check.ts`

Structured health check with GitHub integration:

- Checks pod status via `kubectl`
- Checks SQLite database integrity
- Queries GitHub workflow status via `@octokit/rest`
- Returns structured JSON health report

### Step 6b.5: `src/lib/updater.ts`

**Dependency update logic** - checks for updates and applies when safe:

```typescript
// src/lib/updater.ts
import { $ } from 'bun';
import { getDatabase } from './db';

interface UpdateCheck {
  hasUpdates: boolean;
  packages: Array<{ name: string; current: string; latest: string }>;
}

/**
 * Check for dependency updates without applying them
 */
export async function checkForUpdates(): Promise<UpdateCheck> {
  const packages: UpdateCheck['packages'] = [];

  // Check Claude CLI version
  try {
    const currentCli = await $`claude --version`.text();
    const latestCli = await $`npm view @anthropic-ai/claude-code version`.text();

    if (currentCli.trim() !== latestCli.trim()) {
      packages.push({
        name: '@anthropic-ai/claude-code',
        current: currentCli.trim(),
        latest: latestCli.trim()
      });
    }
  } catch { /* ignore errors */ }

  // Check SDK versions via bun
  try {
    const outdated = await $`bun outdated --json`.json() as any[];
    for (const pkg of outdated) {
      if (['@anthropic-ai/sdk', '@octokit/rest'].includes(pkg.name)) {
        packages.push({
          name: pkg.name,
          current: pkg.current,
          latest: pkg.latest
        });
      }
    }
  } catch { /* ignore errors */ }

  return {
    hasUpdates: packages.length > 0,
    packages
  };
}

/**
 * Check if it's safe to update (no active sessions)
 */
export function canUpdate(): { safe: boolean; activeSessions: number } {
  const db = getDatabase();

  const result = db.query(`
    SELECT COUNT(*) as count FROM sessions
    WHERE status IN ('running', 'blocked', 'starting')
  `).get() as { count: number };

  return {
    safe: result.count === 0,
    activeSessions: result.count
  };
}

/**
 * Queue an update for later if sessions are active
 */
export function queueUpdate(updateType: string, reason: string, targetVersion?: string): void {
  const db = getDatabase();

  // Check if already queued
  const existing = db.query(`
    SELECT id FROM update_queue WHERE status = 'pending' AND update_type = ?
  `).get(updateType);

  if (!existing) {
    db.run(`
      INSERT INTO update_queue (update_type, target_version, reason)
      VALUES (?, ?, ?)
    `, [updateType, targetVersion || null, reason]);

    db.run(`
      INSERT INTO activity_log (event, details, actor)
      VALUES ('update_queued', json_object('type', ?, 'reason', ?), 'updater')
    `, [updateType, reason]);

    console.log(`[Updater] Queued ${updateType} update: ${reason}`);
  }
}

/**
 * Apply pending updates (call on pod startup or when all sessions complete)
 */
export async function applyPendingUpdates(): Promise<number> {
  const db = getDatabase();

  const pending = db.query(`
    SELECT id, update_type, target_version FROM update_queue WHERE status = 'pending'
  `).all() as Array<{ id: number; update_type: string; target_version: string | null }>;

  if (pending.length === 0) {
    return 0;
  }

  console.log(`[Updater] Applying ${pending.length} pending updates...`);

  let applied = 0;
  for (const update of pending) {
    try {
      await applyUpdate(update.update_type, update.target_version);

      db.run(`
        UPDATE update_queue SET status = 'applied', applied_at = unixepoch()
        WHERE id = ?
      `, [update.id]);

      db.run(`
        INSERT INTO activity_log (event, details, actor)
        VALUES ('update_applied', json_object('type', ?, 'id', ?), 'updater')
      `, [update.update_type, update.id]);

      applied++;
    } catch (err) {
      db.run(`
        UPDATE update_queue SET status = 'failed', error_message = ?
        WHERE id = ?
      `, [String(err), update.id]);
    }
  }

  return applied;
}

/**
 * Apply a specific update type
 */
async function applyUpdate(updateType: string, targetVersion?: string): Promise<void> {
  switch (updateType) {
    case 'cli':
      console.log('[Updater] Updating Claude CLI...');
      await $`npm update -g @anthropic-ai/claude-code`;
      break;

    case 'npm':
      console.log('[Updater] Updating npm packages...');
      await $`bun update @anthropic-ai/sdk @octokit/rest`;
      break;

    case 'all':
      await applyUpdate('cli');
      await applyUpdate('npm');
      break;

    default:
      throw new Error(`Unknown update type: ${updateType}`);
  }

  // Record new versions
  await recordCurrentVersions();
}

/**
 * Record current installed versions to database
 */
export async function recordCurrentVersions(): Promise<void> {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Claude CLI
  try {
    const cliVersion = (await $`claude --version`.text()).trim();
    db.run(`
      INSERT INTO dependency_versions (package, installed_version, last_updated_at)
      VALUES ('@anthropic-ai/claude-code', ?, ?)
      ON CONFLICT(package) DO UPDATE SET installed_version = ?, last_updated_at = ?
    `, [cliVersion, now, cliVersion, now]);
  } catch { /* ignore */ }

  // npm packages
  try {
    const pkgJson = await Bun.file('package.json').json();
    for (const [name, version] of Object.entries(pkgJson.dependencies || {})) {
      db.run(`
        INSERT INTO dependency_versions (package, installed_version, last_updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(package) DO UPDATE SET installed_version = ?, last_updated_at = ?
      `, [name, version, now, version, now]);
    }
  } catch { /* ignore */ }
}

/**
 * Main entry point - check and update if safe
 */
export async function checkAndUpdateIfSafe(): Promise<{
  checked: boolean;
  updated: boolean;
  queued: boolean;
  details: string;
}> {
  const { hasUpdates, packages } = await checkForUpdates();

  if (!hasUpdates) {
    return { checked: true, updated: false, queued: false, details: 'No updates available' };
  }

  const { safe, activeSessions } = canUpdate();

  if (safe) {
    await applyPendingUpdates();
    for (const pkg of packages) {
      if (pkg.name === '@anthropic-ai/claude-code') {
        await applyUpdate('cli');
      } else {
        await applyUpdate('npm');
      }
    }
    return {
      checked: true,
      updated: true,
      queued: false,
      details: `Updated: ${packages.map(p => p.name).join(', ')}`
    };
  } else {
    queueUpdate('all', `${packages.length} packages outdated`, undefined);
    return {
      checked: true,
      updated: false,
      queued: true,
      details: `${activeSessions} active sessions, update queued`
    };
  }
}
```

### Step 6b.6: `src/lib/checkpoint.ts`

**Capture state checkpoints before major actions** for crash recovery:

```typescript
// src/lib/checkpoint.ts
import { $ } from 'bun';
import { getDatabase } from './db';
import { captureScreen } from './screenshot';

export type CheckpointType = 'pre_commit' | 'pre_pr' | 'pre_merge' | 'manual' | 'periodic';

export interface CheckpointOptions {
  sessionId: string;
  type: CheckpointType;
  summary: string;
  pendingActions?: string[];
  pod?: string;
  window?: string;
}

/**
 * Create a checkpoint before a major action
 * Called by Claude before commits, PR creation, etc.
 */
export async function createCheckpoint(options: CheckpointOptions): Promise<number> {
  const db = getDatabase();

  // Capture current git state
  let gitStatus = '';
  let gitDiffStat = '';
  let filesModified: string[] = [];

  try {
    gitStatus = await $`git status --short`.text();
    gitDiffStat = await $`git diff --stat`.text();

    // Parse modified files
    const statusLines = gitStatus.split('\n').filter(l => l.trim());
    filesModified = statusLines.map(l => l.substring(3).trim());
  } catch { /* ignore git errors */ }

  // Capture tmux pane if available
  let tmuxCapture = '';
  if (options.pod && options.window) {
    try {
      const screenshot = await captureScreen({
        pod: options.pod,
        window: options.window,
        captureText: true  // Just get text, not image
      });
      tmuxCapture = screenshot.text || '';
    } catch { /* ignore */ }
  }

  // Insert checkpoint
  const result = db.run(`
    INSERT INTO checkpoints (
      session_id, checkpoint_type, summary, files_modified,
      pending_actions, tmux_capture, git_status, git_diff_stat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    options.sessionId,
    options.type,
    options.summary,
    JSON.stringify(filesModified),
    options.pendingActions ? JSON.stringify(options.pendingActions) : null,
    tmuxCapture,
    gitStatus,
    gitDiffStat
  ]);

  // Log checkpoint creation
  db.run(`
    INSERT INTO activity_log (session_id, event, details, actor)
    VALUES (?, 'checkpoint_created', json_object('type', ?, 'summary', ?), 'claude')
  `, [options.sessionId, options.type, options.summary.substring(0, 100)]);

  console.log(`[Checkpoint] Created ${options.type} checkpoint for ${options.sessionId}`);
  return result.lastInsertRowid as number;
}

/**
 * Get the latest checkpoint for a session
 */
export function getLatestCheckpoint(sessionId: string): {
  summary: string;
  pendingActions: string[] | null;
  filesModified: string[];
  createdAt: number;
} | null {
  const db = getDatabase();

  const checkpoint = db.query(`
    SELECT summary, pending_actions, files_modified, created_at
    FROM checkpoints WHERE session_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(sessionId) as any;

  if (!checkpoint) return null;

  return {
    summary: checkpoint.summary,
    pendingActions: checkpoint.pending_actions ? JSON.parse(checkpoint.pending_actions) : null,
    filesModified: checkpoint.files_modified ? JSON.parse(checkpoint.files_modified) : [],
    createdAt: checkpoint.created_at
  };
}

/**
 * Store a conversation turn for replay capability
 */
export function recordConversationTurn(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  contentType: 'text' | 'tool_use' | 'tool_result' = 'text'
): void {
  const db = getDatabase();

  // Get next sequence number
  const lastSeq = db.query(`
    SELECT MAX(sequence_num) as max_seq FROM conversation_history WHERE session_id = ?
  `).get(sessionId) as { max_seq: number | null };

  const nextSeq = (lastSeq?.max_seq || 0) + 1;

  db.run(`
    INSERT INTO conversation_history (session_id, role, content, content_type, sequence_num)
    VALUES (?, ?, ?, ?, ?)
  `, [sessionId, role, content, contentType, nextSeq]);
}

/**
 * Store Claude's response for replay
 */
export function recordResponse(
  sessionId: string,
  promptId: number | null,
  responseType: 'text' | 'tool_use' | 'thinking' | 'error',
  content: string,
  toolName?: string,
  toolInput?: object
): void {
  const db = getDatabase();

  // Truncate content if too large (keep first 50KB)
  const maxLength = 50000;
  const truncated = content.length > maxLength;
  const storedContent = truncated ? content.substring(0, maxLength) : content;

  db.run(`
    INSERT INTO responses (session_id, prompt_id, response_type, content, content_truncated, tool_name, tool_input)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    sessionId,
    promptId,
    responseType,
    storedContent,
    truncated ? 1 : 0,
    toolName || null,
    toolInput ? JSON.stringify(toolInput) : null
  ]);
}

/**
 * Capture Claude CLI's session ID when REPL starts
 */
export async function captureClaudeSessionId(sessionId: string, pod: string, window: string): Promise<string | null> {
  const db = getDatabase();

  try {
    // Claude stores session info in ~/.claude/
    // Try to find the most recent session file
    const result = await $`kubectl exec ${pod} -- ls -t /home/runner/.claude/sessions/ | head -1`.text();
    const claudeSessionId = result.trim();

    if (claudeSessionId) {
      db.run(`UPDATE sessions SET claude_session_id = ? WHERE id = ?`,
        [claudeSessionId, sessionId]);
      console.log(`[Session] Captured Claude session ID: ${claudeSessionId}`);
      return claudeSessionId;
    }
  } catch { /* ignore */ }

  return null;
}
```

### Step 6b.7: `src/session-complete.ts`

**Called by Claude when work is done** to signal session completion:

```typescript
// Called from Claude REPL like:
// /mcp session-complete --session pr-123 --summary "Feature implemented, PR created"

import { Database } from 'bun:sqlite';
import { Octokit } from '@octokit/rest';
import { getDatabase } from './lib/db';
import { captureScreen, toBase64DataUri } from './lib/screenshot';

export async function sessionComplete(options: {
  sessionId: string;
  summary: string;
  pod: string;
  window: string;
}): Promise<void> {
  const db = getDatabase();
  const github = new Octokit({ auth: process.env.GITHUB_TOKEN });

  // Get session info
  const session = db.query(`
    SELECT github_number, github_type FROM sessions WHERE id = ?
  `).get(options.sessionId) as { github_number: number; github_type: string } | null;

  if (!session) throw new Error(`Session not found: ${options.sessionId}`);

  // Capture final screenshot
  let screenshotMd = '';
  let screenshotPath = '';
  try {
    const screenshot = await captureScreen({ pod: options.pod, window: options.window });
    screenshotPath = `/home/runner/.claude/screenshots/${options.sessionId}-complete.png`;
    await Bun.write(screenshotPath, screenshot);
    screenshotMd = `\n\n**Final state:**\n![screenshot](${toBase64DataUri(screenshot)})`;
  } catch { /* continue without */ }

  // Update session in database
  db.run(`
    UPDATE sessions
    SET status = 'complete',
        completed_at = unixepoch(),
        completion_summary = ?,
        repl_active = 0,
        last_activity_at = unixepoch()
    WHERE id = ?
  `, [options.summary, options.sessionId]);

  // Record screenshot
  if (screenshotPath) {
    db.run(`
      INSERT INTO screenshots (session_id, file_path, event_type)
      VALUES (?, ?, 'completion')
    `, [options.sessionId, screenshotPath]);
  }

  // Log completion
  db.run(`
    INSERT INTO activity_log (session_id, event, details, actor)
    VALUES (?, 'session_completed', json_object('summary', ?), 'claude')
  `, [options.sessionId, options.summary]);

  // Post completion summary to GitHub
  const [owner, repo] = (process.env.REPO || '').split('/');
  await github.rest.issues.createComment({
    owner, repo,
    issue_number: session.github_number,
    body: `## ✅ Claude completed\n\n${options.summary}${screenshotMd}`
  });

  // Get session stats for final message
  const stats = db.query(`
    SELECT
      (SELECT COUNT(*) FROM commits WHERE session_id = ?) as commits,
      (SELECT COUNT(*) FROM questions WHERE session_id = ?) as questions,
      (SELECT COUNT(*) FROM tool_calls WHERE session_id = ?) as tool_calls
  `).get(options.sessionId, options.sessionId, options.sessionId) as any;

  console.log(`\n✅ Session ${options.sessionId} marked complete.`);
  console.log(`   Commits: ${stats.commits}, Questions: ${stats.questions}, Tool calls: ${stats.tool_calls}`);
  console.log('   REPL can be closed.\n');
}
```

### Step 6b.5: Compilation

Bun tools are compiled to standalone binaries in the Dockerfile (Phase 6.1):

```bash
# In the Dockerfile builder stage:
bun build ./src/ask-question.ts --target bun --outdir ./dist/bin
bun build ./src/debug-db.ts --target bun --outdir ./dist/bin
bun build ./src/pod-health-check.ts --target bun --outdir ./dist/bin

# Binaries are copied to /usr/local/bin/ in the runtime stage
```

### Step 6b.6: Shell Script — `scripts/deploy-all.sh`

Pure orchestration script that stays as shell (no external API interaction):

```bash
#!/bin/bash
set -euo pipefail

# Orchestrates kubectl apply for all k8s manifests
# Orchestrates docker build/push
# No GitHub SDK or database driver needed — just command sequencing
```

---

## Phase 6c: Screenshot Capture & Vision Verification (Lightweight)

This phase adds **optional screenshot capture** for debugging and transparency, with **conditional vision verification** for edge cases.

### Why Screenshots?

When things don't go as planned, seeing what Claude saw is invaluable:
- Capture terminal state when questions are asked
- Include in GitHub PR comments for context
- Debug issues without attaching to tmux

### Step 6c.1: Screenshot Approach

**GitHub Constraints:**
- Issue comments: ~65535 characters max
- Base64 inline images: **~75KB practical limit** (after encoding overhead)
- No public API for CDN uploads to `user-attachments`

**Solution:** Capture tmux → Convert to PNG → Compress → Base64 inline

```bash
# Install dependencies (in Dockerfile)
apt-get install -y aha wkhtmltopdf  # aha converts ANSI to HTML, wkhtmltoimage renders

# Capture pipeline:
# 1. tmux capture-pane -p -e  (ANSI text with escape codes)
# 2. aha --no-header           (convert to HTML)
# 3. wkhtmltoimage --quality 50 (render to compressed PNG)
# 4. Base64 encode for GitHub comment
```

### Step 6c.2: `src/lib/screenshot.ts`

Lightweight screenshot capture without heavy dependencies:

```typescript
import { $ } from 'bun';

export interface ScreenshotOptions {
  pod: string;
  window: string;
  maxSizeKB?: number;  // Default: 70 (leaves room for base64 overhead)
}

export async function captureScreen(options: ScreenshotOptions): Promise<Buffer> {
  const { pod, window, maxSizeKB = 70 } = options;

  // Capture ANSI text from tmux
  const ansiText = await $`kubectl exec ${pod} -- tmux capture-pane -t ${window} -p -e`.text();

  // Convert to HTML via aha, then to PNG via wkhtmltoimage
  const html = await $`echo ${ansiText} | aha --no-header`.text();

  // Render to PNG with compression
  const png = await $`echo ${html} | wkhtmltoimage --quality 50 --width 800 - -`.arrayBuffer();

  let buffer = Buffer.from(png);

  // If still too large, resize
  if (buffer.length > maxSizeKB * 1024) {
    // Fallback: capture as plain text, smaller render
    const smallPng = await $`echo ${html} | wkhtmltoimage --quality 30 --width 600 - -`.arrayBuffer();
    buffer = Buffer.from(smallPng);
  }

  return buffer;
}

export function toBase64DataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}
```

### Step 6c.3: Conditional Vision Verification

**Key insight:** Vision verification is expensive (API call, latency, cost). Only use when needed.

```typescript
// src/lib/vision-verify.ts
import Anthropic from '@anthropic-ai/sdk';

export interface VerificationResult {
  verified: boolean;
  confidence: number;  // 0-100
  issues?: string[];
}

export async function verifyIfNeeded(options: {
  textCapture: string;      // From tmux capture-pane (plain text)
  expectedState: 'question' | 'thinking' | 'complete' | 'error';
  screenshot?: Buffer;      // Only needed if verification triggers
}): Promise<VerificationResult> {

  // Quick heuristic checks - most cases don't need vision
  const anomalies = detectAnomalies(options.textCapture, options.expectedState);

  if (anomalies.length === 0) {
    // Text looks good, no need for vision API call
    return { verified: true, confidence: 90 };
  }

  // Anomaly detected - now we call vision API
  if (!options.screenshot) {
    return { verified: false, confidence: 50, issues: anomalies };
  }

  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',  // Sonnet is cheaper, fast enough
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Does this terminal screenshot show a "${options.expectedState}" state? Answer YES or NO, then briefly explain any issues.`
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: options.screenshot.toString('base64')
          }
        }
      ]
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const isYes = text.toUpperCase().startsWith('YES');

  return {
    verified: isYes,
    confidence: isYes ? 85 : 40,
    issues: isYes ? undefined : [text]
  };
}

function detectAnomalies(text: string, expected: string): string[] {
  const anomalies: string[] = [];

  // Check for obvious mismatches
  if (expected === 'question' && !text.includes('?')) {
    anomalies.push('Expected question but no "?" found');
  }
  if (expected === 'complete' && text.includes('error')) {
    anomalies.push('Expected completion but found "error"');
  }
  if (expected === 'error' && text.includes('success')) {
    anomalies.push('Expected error but found "success"');
  }
  // Empty or truncated output
  if (text.trim().length < 10) {
    anomalies.push('Output seems truncated or empty');
  }

  return anomalies;
}
```

### Step 6c.4: Update `ask-question.ts` with Screenshot

```typescript
// Add to existing ask-question.ts
import { captureScreen, toBase64DataUri } from './lib/screenshot';
import { verifyIfNeeded } from './lib/vision-verify';

export async function handleQuestion(
  question: string,
  options: {
    repo: string;
    prNumber: number;
    sessionId: string;
    pod: string;
    window: string;
    github: Octokit;
    db: Database;
  }
): Promise<string> {

  // Capture screenshot for context
  let screenshotMarkdown = '';
  try {
    const screenshot = await captureScreen({
      pod: options.pod,
      window: options.window,
      maxSizeKB: 70  // Stay under GitHub's inline limit
    });

    // Optional: verify if something looks off
    const verification = await verifyIfNeeded({
      textCapture: question,
      expectedState: 'question',
      screenshot
    });

    if (verification.verified) {
      screenshotMarkdown = `\n\n**Claude's screen when asking:**\n\n![screenshot](${toBase64DataUri(screenshot)})`;
    } else {
      // Include anyway but note the issue
      screenshotMarkdown = `\n\n**Claude's screen (unverified):**\n\n![screenshot](${toBase64DataUri(screenshot)})\n\n> ⚠️ Verification issues: ${verification.issues?.join(', ')}`;
    }
  } catch (err) {
    console.warn('Screenshot capture failed, continuing without:', err);
    // Continue without screenshot - not critical
  }

  // Post question to GitHub WITH screenshot
  const [owner, repo] = options.repo.split('/');
  await options.github.rest.issues.createComment({
    owner,
    repo,
    issue_number: options.prNumber,
    body: `## 🤔 Claude is asking:\n\n${question}${screenshotMarkdown}\n\n---\n**To respond:** Reply with \`@claude-answer: your answer\``
  });

  // ... rest of existing logic (SQLite, polling, etc.)
}
```

### Step 6c.5: Dockerfile Updates

Add screenshot dependencies:

```dockerfile
# In runtime stage, add:
RUN apt-get update && apt-get install -y \
    aha \
    wkhtmltopdf \
    && rm -rf /var/lib/apt/lists/*
```

### Step 6c.6: When Screenshots Are Captured

Screenshots are **only captured on major events** to avoid noise:

| Event | Screenshot? | Why |
|-------|-------------|-----|
| Question asked | ✅ Yes | User needs context to answer |
| Work complete | ✅ Yes | Proof of final state |
| Error occurred | ✅ Yes | Debugging context |
| Thinking | ❌ No | Too noisy, not actionable |
| Tool use | ❌ No | Covered by completion screenshot |

### Step 6c.7: Vision Verification Triggers

Vision API is only called when:
1. Text heuristics detect an anomaly
2. Screenshot was successfully captured
3. The event is important (question/completion/error)

**Cost control:** ~$0.003 per verification (Sonnet + small image)

---

## Phase 7: GitHub Workflows

### Step 7.1: Main Claude Code Workflow

Create `.github/workflows/claude-code-blocking.yml`:

```yaml
name: Claude Code with Resilient Blocking

on:
  pull_request:
    types: [opened, reopened, synchronize]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: "PR number to work on"
        required: true

env:
  REPO: ${{ github.repository }}
  DB_PATH: /home/runner/.claude/gwa.db

jobs:
  claude-work:
    runs-on: self-hosted
    container:
      image: your-registry/claude-runner:latest
    timeout-minutes: 1440  # 24 hour max
    steps:
    - name: Checkout code
      uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - name: Get or create git worktree for this PR
      id: worktree-setup
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        BRANCH=${{ github.head_ref || 'main' }}
        WORKTREE_PATH="/home/runner/worktrees/pr-${PR_NUM}"
        
        # Check if worktree already exists
        if git -C /home/runner/repo worktree list | grep -q "${WORKTREE_PATH}"; then
          echo "Worktree already exists for PR #${PR_NUM}"
          echo "is_new=false" >> $GITHUB_OUTPUT
        else
          echo "Creating new worktree for PR #${PR_NUM}"
          
          # Create worktree from the branch
          cd /home/runner/repo
          git worktree add "${WORKTREE_PATH}" "${BRANCH}" 2>/dev/null || \
            git worktree add "${WORKTREE_PATH}" "origin/${BRANCH}" || \
            git worktree add "${WORKTREE_PATH}" main
          
          echo "is_new=true" >> $GITHUB_OUTPUT
        fi
        
        echo "worktree_path=${WORKTREE_PATH}" >> $GITHUB_OUTPUT

    - name: Get or create tmux session for this PR
      id: tmux-setup
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        POD_NAME=$(hostname)
        WORKTREE_PATH=${{ steps.worktree-setup.outputs.worktree_path }}
        SESSION_ID="pr-${PR_NUM}"

        # Query SQLite for existing session
        EXISTING=$(kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} \
          "SELECT tmux_window, status FROM sessions WHERE id = '${SESSION_ID}'" 2>/dev/null || echo "")

        if [ -z "$EXISTING" ]; then
          # Assign new tmux window
          WINDOW_ID=$(tmux list-windows -t claude-work -F "#{window_index}" | sort -n | tail -1)
          NEXT_WINDOW=$((WINDOW_ID + 1))

          # Create window with working directory set to this PR's worktree
          tmux new-window -t claude-work:${NEXT_WINDOW} -n "pr-${PR_NUM}" -c "${WORKTREE_PATH}"

          # Insert new session into SQLite
          kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} "
            INSERT INTO sessions (id, type, status, github_number, github_type,
                                  tmux_window, worktree_path, initial_prompt)
            VALUES ('${SESSION_ID}', 'pr', 'pending', ${PR_NUM}, 'pull_request',
                    ${NEXT_WINDOW}, '${WORKTREE_PATH}',
                    '${{ github.event.pull_request.body || 'Review PR' }}');

            INSERT INTO activity_log (session_id, event, actor)
            VALUES ('${SESSION_ID}', 'session_created', 'workflow');
          "

          echo "window_id=${NEXT_WINDOW}" >> $GITHUB_OUTPUT
          echo "is_new=true" >> $GITHUB_OUTPUT
        else
          EXISTING_WINDOW=$(echo "$EXISTING" | cut -d'|' -f1)
          EXISTING_STATUS=$(echo "$EXISTING" | cut -d'|' -f2)

          echo "window_id=${EXISTING_WINDOW}" >> $GITHUB_OUTPUT

          if [ "$EXISTING_STATUS" = "interrupted" ]; then
            echo "is_new=true" >> $GITHUB_OUTPUT  # Treat interrupted as new
          else
            echo "is_new=false" >> $GITHUB_OUTPUT
          fi

          # Update last activity
          kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} \
            "UPDATE sessions SET last_activity_at = unixepoch() WHERE id = '${SESSION_ID}'"
        fi

        echo "pod_name=${POD_NAME}" >> $GITHUB_OUTPUT
        echo "session_id=${SESSION_ID}" >> $GITHUB_OUTPUT

    - name: Start or Resume Interactive Claude REPL
      id: claude-repl
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        WINDOW_ID=${{ steps.tmux-setup.outputs.window_id }}
        WORKTREE_PATH=${{ steps.worktree-setup.outputs.worktree_path }}
        POD_NAME=${{ steps.tmux-setup.outputs.pod_name }}
        IS_NEW=${{ steps.tmux-setup.outputs.is_new }}
        SESSION_ID=${{ steps.tmux-setup.outputs.session_id }}

        echo "[Claude] Interactive REPL for PR #${PR_NUM} in window ${WINDOW_ID}"

        # Check if REPL is already running
        REPL_ACTIVE=$(kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} \
          "SELECT repl_active FROM sessions WHERE id = '${SESSION_ID}'" 2>/dev/null || echo "0")

        if [ "$REPL_ACTIVE" != "1" ]; then
          echo "[Claude] Starting new interactive REPL session..."

          # Start Claude REPL (interactive mode, no --print)
          kubectl exec ${POD_NAME} -- tmux send-keys -t claude-work:${WINDOW_ID} \
            "cd ${WORKTREE_PATH} && claude" Enter

          # Wait for REPL to initialize
          sleep 3

          # Mark REPL as active in SQLite
          kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} "
            UPDATE sessions
            SET repl_active = 1, status = 'starting', started_at = unixepoch()
            WHERE id = '${SESSION_ID}';

            INSERT INTO activity_log (session_id, event, actor)
            VALUES ('${SESSION_ID}', 'repl_started', 'workflow');
          "
        else
          echo "[Claude] REPL already running, sending new prompt..."
        fi

        # Build the prompt based on trigger type
        if [ "$IS_NEW" = "true" ]; then
          PROMPT="Work on PR #${PR_NUM}: ${{ github.event.pull_request.body || 'Review and address the PR' }}"
        else
          if [ -n "${{ github.event.comment.body }}" ]; then
            PROMPT="Address this feedback: ${{ github.event.comment.body }}"
          else
            PROMPT="Continue working on the current task"
          fi
        fi

        # Send prompt to running REPL
        kubectl exec ${POD_NAME} -- tmux send-keys -t claude-work:${WINDOW_ID} \
          "${PROMPT}" Enter

        # Record prompt and update status
        kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} "
          UPDATE sessions
          SET status = 'running', last_activity_at = unixepoch()
          WHERE id = '${SESSION_ID}';

          INSERT INTO prompts (session_id, prompt, source, triggered_by)
          VALUES ('${SESSION_ID}', '$(echo "${PROMPT}" | sed "s/'/''/g")', 'workflow', 'github-actions');
        "

        echo "session_id=${SESSION_ID}" >> $GITHUB_OUTPUT

    - name: Monitor REPL Status via SQLite
      id: monitor
      continue-on-error: true
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        WINDOW_ID=${{ steps.tmux-setup.outputs.window_id }}
        POD_NAME=${{ steps.tmux-setup.outputs.pod_name }}
        SESSION_ID=${{ steps.claude-repl.outputs.session_id }}

        TIMEOUT=3600  # 1 hour max per workflow run
        ELAPSED=0
        HEALTH_CHECK_INTERVAL=30
        LAST_HEALTH_CHECK=0

        echo "[Monitor] Polling SQLite for session status..."

        while [ $ELAPSED -lt $TIMEOUT ]; do
          sleep 5
          ELAPSED=$((ELAPSED + 5))

          # Health check every 30 seconds
          if [ $((ELAPSED - LAST_HEALTH_CHECK)) -ge $HEALTH_CHECK_INTERVAL ]; then
            # Check SQLite is accessible
            if ! kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} "SELECT 1" > /dev/null 2>&1; then
              echo "[ERROR] SQLite unreachable"
              echo "exit_status=db_error" >> $GITHUB_OUTPUT
              exit 1
            fi
            LAST_HEALTH_CHECK=$ELAPSED
            echo "[Health] OK at ${ELAPSED}s"
          fi

          # Poll SQLite for status (Claude writes this)
          STATUS=$(kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} \
            "SELECT status FROM sessions WHERE id = '${SESSION_ID}'" 2>/dev/null || echo "unknown")

          case "$STATUS" in
            "complete")
              echo "[Monitor] Claude completed work"
              echo "exit_status=complete" >> $GITHUB_OUTPUT
              exit 0
              ;;
            "blocked")
              echo "[Monitor] Claude is blocked waiting for answer"
              # Question already posted to GitHub by Claude's ask-question tool
              # Answer will come via webhook → claude-code-respond.yml
              echo "exit_status=blocked" >> $GITHUB_OUTPUT
              exit 0
              ;;
            "error")
              echo "[Monitor] Claude encountered an error"
              echo "exit_status=error" >> $GITHUB_OUTPUT
              exit 1
              ;;
            "running")
              # Still working, continue polling
              ;;
            *)
              # Fallback: check tmux output for patterns
              OUTPUT=$(kubectl exec ${POD_NAME} -- \
                tmux capture-pane -t claude-work:${WINDOW_ID} -p -S -20 2>/dev/null || echo "")

              if echo "$OUTPUT" | grep -qE "^\?|Should I|Do you want|I have a question"; then
                echo "[Monitor] Detected question in output (fallback detection)"
                kubectl exec ${POD_NAME} -- sqlite3 ${DB_PATH} \
                  "UPDATE sessions SET status = 'blocked' WHERE id = '${SESSION_ID}'"
              fi
              ;;
          esac
        done

        echo "[Monitor] Timeout reached, workflow will re-trigger on next event"
        echo "exit_status=timeout" >> $GITHUB_OUTPUT

    - name: Handle graceful exit if pod crashed
      if: failure() && steps.claude-run.outputs.exit_status == 'pod_crashed'
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        
        # Mark as waiting for webhook resume in SQLite
        kubectl exec claude-runner-0 -- sqlite3 $DB_PATH \
          "UPDATE sessions SET status = 'interrupted', interrupted_at = unixepoch() WHERE id = 'pr-${PR_NUM}'"
        
        # Post a comment
        gh pr comment $PR_NUM -b "⚠️ **Pod Crashed While Waiting**\n\nThe runner pod restarted, but your session was saved on Longhorn!\n\nOnce you reply with \`@claude-answer: your answer\`, Claude will resume automatically."

    - name: Capture and post results
      if: success()
      run: |
        PR_NUM=${{ github.event.pull_request.number || github.event.inputs.pr_number }}
        WINDOW_ID=${{ steps.tmux-setup.outputs.window_id }}
        
        OUTPUT=$(tmux capture-pane -t claude-work:${WINDOW_ID} -p -S -100)
        
        gh pr comment $PR_NUM -b "✅ **Claude Work Complete**\n\n\`\`\`\n${OUTPUT}\n\`\`\`"
```

### Step 7.2: Question Response Webhook Workflow

Create `.github/workflows/claude-code-respond.yml`:

```yaml
name: Claude Question Response with Pod Recovery

on:
  issue_comment:
    types: [created, edited]

env:
  DB_PATH: /home/runner/.claude/gwa.db

jobs:
  handle-response:
    runs-on: self-hosted
    container:
      image: your-registry/claude-runner:latest
    steps:
    - name: Checkout code
      uses: actions/checkout@v4

    - name: Check if this is a Claude answer
      id: check-answer
      run: |
        COMMENT="${{ github.event.comment.body }}"
        
        if echo "$COMMENT" | grep -q "@claude-answer:"; then
          ANSWER=$(echo "$COMMENT" | grep -oP '@claude-answer:\s*\K.*' | head -1)
          echo "answer=${ANSWER}" >> $GITHUB_OUTPUT
          echo "is_answer=true" >> $GITHUB_OUTPUT
        else
          echo "is_answer=false" >> $GITHUB_OUTPUT
        fi

    - name: Store answer and get session info
      id: store-answer
      if: steps.check-answer.outputs.is_answer == 'true'
      run: |
        PR_NUM=${{ github.event.issue.number }}
        REPO=${{ github.repository }}
        SESSION_ID="pr-${PR_NUM}"
        ANSWER="${{ steps.check-answer.outputs.answer }}"
        ACTOR="${{ github.actor }}"

        # Get session info from SQLite
        SESSION_INFO=$(kubectl exec claude-runner-0 -- sqlite3 ${DB_PATH} "
          SELECT tmux_window, repl_active FROM sessions WHERE id = '${SESSION_ID}'
        " 2>/dev/null || echo "")

        if [ -z "$SESSION_INFO" ]; then
          echo "pod_running=false" >> $GITHUB_OUTPUT
          exit 0
        fi

        WINDOW=$(echo "$SESSION_INFO" | cut -d'|' -f1)
        REPL_ACTIVE=$(echo "$SESSION_INFO" | cut -d'|' -f2)

        echo "window=${WINDOW}" >> $GITHUB_OUTPUT
        echo "session_id=${SESSION_ID}" >> $GITHUB_OUTPUT

        if [ "$REPL_ACTIVE" = "1" ]; then
          echo "pod_running=true" >> $GITHUB_OUTPUT

          # Update question with answer
          kubectl exec claude-runner-0 -- sqlite3 ${DB_PATH} "
            UPDATE questions
            SET answer = '$(echo "${ANSWER}" | sed "s/'/''/g")',
                answered_by = '${ACTOR}',
                answered_at = unixepoch(),
                status = 'answered'
            WHERE session_id = '${SESSION_ID}' AND status = 'posted';

            INSERT INTO activity_log (session_id, event, details, actor)
            VALUES ('${SESSION_ID}', 'question_answered',
                    json_object('answered_by', '${ACTOR}'), '${ACTOR}');
          "
        else
          echo "pod_running=false" >> $GITHUB_OUTPUT
        fi

    - name: Send answer to running REPL
      if: steps.store-answer.outputs.pod_running == 'true'
      run: |
        WINDOW=${{ steps.store-answer.outputs.window }}
        SESSION_ID=${{ steps.store-answer.outputs.session_id }}
        ANSWER="${{ steps.check-answer.outputs.answer }}"

        # Send answer directly to the running REPL via tmux
        kubectl exec claude-runner-0 -- \
          tmux send-keys -t claude-work:${WINDOW} \
          "${ANSWER}" Enter

        # Update session status
        kubectl exec claude-runner-0 -- sqlite3 ${DB_PATH} "
          UPDATE sessions
          SET status = 'running', last_activity_at = unixepoch()
          WHERE id = '${SESSION_ID}';
        "

        echo "✅ Answer sent to running REPL - Claude will continue with full context"

    - name: Handle pod restart case
      if: steps.store-answer.outputs.pod_running == 'false'
      run: |
        PR_NUM=${{ github.event.issue.number }}
        SESSION_ID="pr-${PR_NUM}"
        ANSWER="${{ steps.check-answer.outputs.answer }}"

        # Store answer for when session resumes
        kubectl exec claude-runner-0 -- sqlite3 ${DB_PATH} "
          UPDATE questions
          SET answer = '$(echo "${ANSWER}" | sed "s/'/''/g")',
              answered_by = '${{ github.actor }}',
              answered_at = unixepoch(),
              status = 'answered'
          WHERE session_id = '${SESSION_ID}' AND status = 'posted';

          UPDATE sessions
          SET status = 'interrupted'
          WHERE id = '${SESSION_ID}';

          INSERT INTO activity_log (session_id, event, details, actor)
          VALUES ('${SESSION_ID}', 'answer_received_while_interrupted',
                  json_object('answer', '$(echo "${ANSWER}" | sed "s/'/''/g")'), '${{ github.actor }}');
        " 2>/dev/null || true

        gh pr comment $PR_NUM -b "🔄 **Answer Saved**

Your answer has been saved. The session was interrupted but will resume with your answer when the workflow triggers next.

The next workflow trigger will pick up where we left off."
```

---

## Phase 8: CronJob for Cleanup

### Step 8.1: Deploy Cleanup CronJob

```bash
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: claude-cleanup
  namespace: default
spec:
  schedule: "0 * * * *"  # Hourly
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: claude-cleanup
          containers:
          - name: cleanup
            image: your-registry/claude-runner:latest
            command:
            - /bin/bash
            - -c
            - |
              POD_NAME=claude-runner-0
              DB_PATH=/home/runner/.claude/gwa.db

              echo "[Cleanup] Checking for closed PRs to clean up..."

              # Get all non-complete sessions from SQLite
              SESSIONS=$(kubectl exec ${POD_NAME} -- sqlite3 $DB_PATH \
                "SELECT id, github_number, tmux_window, worktree_path FROM sessions WHERE status NOT IN ('complete', 'error')" 2>/dev/null || echo "")

              echo "$SESSIONS" | while IFS='|' read -r SESSION_ID PR_NUM WINDOW WORKTREE; do
                [ -z "$SESSION_ID" ] && continue

                # Get repo from config
                REPO=$(kubectl exec ${POD_NAME} -- sqlite3 $DB_PATH \
                  "SELECT value FROM config WHERE key = 'repo'" 2>/dev/null)

                # Check if PR is closed
                if ! gh pr view ${PR_NUM} -R ${REPO} &>/dev/null 2>&1; then
                  echo "[Cleanup] Cleaning up closed PR #${PR_NUM} (session: ${SESSION_ID})"

                  # Close tmux window
                  if [ -n "$WINDOW" ]; then
                    kubectl exec ${POD_NAME} -- \
                      tmux kill-window -t claude-work:${WINDOW} 2>/dev/null || true
                  fi

                  # Remove git worktree
                  if [ -n "$WORKTREE" ]; then
                    kubectl exec ${POD_NAME} -- \
                      git -C /home/runner/repo worktree remove "${WORKTREE}" --force 2>/dev/null || true
                  fi

                  # Mark session as complete in SQLite
                  kubectl exec ${POD_NAME} -- sqlite3 $DB_PATH \
                    "UPDATE sessions SET status = 'complete', completed_at = unixepoch(), completion_summary = 'Cleaned up - PR closed' WHERE id = '${SESSION_ID}'"

                  echo "[Cleanup] Session ${SESSION_ID} cleaned up"
                fi
              done

              echo "[Cleanup] Done"
          restartPolicy: OnFailure
EOF
```

### Step 8.2: Create RBAC for Cleanup Job

```bash
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: claude-cleanup
  namespace: default

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: claude-cleanup
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "exec"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: claude-cleanup
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: claude-cleanup
subjects:
- kind: ServiceAccount
  name: claude-cleanup
  namespace: default
EOF
```

### Step 8.3: Weekly Dependency Update CronJob

Force-refresh dependencies weekly to ensure Claude CLI and SDKs stay current:

```bash
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: CronJob
metadata:
  name: claude-update
  namespace: default
spec:
  schedule: "0 3 * * 0"  # Weekly at 3am Sunday
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: claude-cleanup  # Reuse existing RBAC
          containers:
          - name: updater
            image: your-registry/claude-runner:latest
            command:
            - /bin/bash
            - -c
            - |
              POD_NAME=claude-runner-0

              echo "[Update] Checking for dependency updates..."

              # Check if any active sessions
              ACTIVE=$(kubectl exec ${POD_NAME} -- sqlite3 /home/runner/.claude/gwa.db \
                "SELECT COUNT(*) FROM sessions WHERE status IN ('running', 'blocked', 'starting')" 2>/dev/null || echo "0")

              if [ "$ACTIVE" = "0" ]; then
                echo "[Update] No active sessions, applying updates..."

                # Update Claude CLI
                kubectl exec ${POD_NAME} -- npm update -g @anthropic-ai/claude-code 2>/dev/null || true

                # Update npm packages
                kubectl exec ${POD_NAME} -- bash -c "cd /home/runner/repo && bun update" 2>/dev/null || true

                # Record new versions to database
                kubectl exec ${POD_NAME} -- bun run /home/runner/src/lib/updater.ts recordVersions 2>/dev/null || true

                echo "[Update] Updates complete."
              else
                echo "[Update] ${ACTIVE} active sessions, queueing update for later..."

                # Queue update for next pod restart
                kubectl exec ${POD_NAME} -- sqlite3 /home/runner/.claude/gwa.db \
                  "INSERT INTO update_queue (update_type, reason, status) VALUES ('all', 'Weekly scheduled update', 'pending')" 2>/dev/null || true
              fi
          restartPolicy: OnFailure
EOF
```

---

## Phase 9: Repository Configuration

### Step 9.1: Create `.claude/CLAUDE.md`

In your repository root, create `.claude/CLAUDE.md`:

```markdown
# Claude Code Project Guidelines

## Project Context
- **Purpose:** [Your project description]
- **Tech Stack:** Bun, Go, Node.js (NO Python)
- **Infrastructure:** k3s cluster (6 nodes) with PostgreSQL HA, NATS, DAPR stack, SQLite on Longhorn
- **Key Infrastructure:** OPNsense firewall, Cloudflare Zero Trust, dual ISP failover

## Repository Structure
\`\`\`
├── .github/
│   ├── workflows/        # GitHub Actions workflows
│   └── issues/          # Issue templates
├── .claude/
│   ├── commands/        # Reusable slash commands
│   ├── skills/          # Custom skills
│   └── agents/          # Specialized agents (optional)
├── docs/                # Project documentation
├── src/                 # Source code
├── tests/               # Test files
└── README.md
\`\`\`

## Operational Notes for Claude

### When You Need Input
If you encounter ambiguity or need clarification:
1. Post your question as a PR comment with clear context
2. Wait for the human to respond with: `@claude-answer: your answer here`
3. Resume work with the provided guidance

### Git Worktree Awareness
- You work in: `/home/runner/worktrees/pr-{NUMBER}/`
- This is isolated from other PR work
- The main repo is at: `/home/runner/repo/`
- Always commit and push to your PR branch

### Session Persistence
- Your session data persists on Longhorn even if the pod restarts
- You can resume with `claude --continue --from-pr {NUMBER}`
- Full conversation history is maintained

## Git Workflow Standards

### Branch Naming
- **Feature:** `feature/issue-{NUMBER}-{description}`
- **Bug Fix:** `fix/issue-{NUMBER}-{description}`
- **Refactor:** `refactor/{description}`

### Commit Messages
Follow Conventional Commits:
\`\`\`
<type>(<scope>): <description>

<optional body>
\`\`\`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `infra`, `chore`

## Testing & Code Quality

- All new features must include tests
- Run tests locally before pushing
- Ensure 80%+ code coverage for new code

## Common Patterns

### Process an Issue
\`\`\`bash
/process-issue 42
\`\`\`

### Review a PR
\`\`\`bash
/review-pr 15
\`\`\`

## Documentation
- Keep README.md up to date
- Document non-obvious architectural decisions
- Link related issues/PRs in comments
```

### Step 9.2: Create Skills Directory

```bash
mkdir -p .claude/skills
mkdir -p .claude/commands
```

### Step 9.3: Create Custom Commands

Create `.claude/commands/process-issue.md`:

```markdown
# /process-issue

Process a GitHub issue: analyze, implement, test, and create PR.

## Usage

```bash
/process-issue 42
```

## What it does

1. Reads issue #42 details
2. Creates feature branch: `feature/issue-42-...`
3. Implements solution
4. Runs tests
5. Creates PR with details

## Prerequisites

- Issue must exist and be assigned or labeled with "claude"
```

---

## Phase 10: Testing & Validation

### Step 10.1: Verify Infrastructure

```bash
# Check pod is running
kubectl get pods -l app=claude-runner

# Check PVC is bound
kubectl get pvc claude-session-pvc

# Check StatefulSet
kubectl get statefulset claude-runner

# Check tmux is ready
kubectl exec -it claude-runner-0 -- tmux list-windows -t claude-work
```

### Step 10.2: Test Worktree Creation

```bash
# Get into the pod
kubectl exec -it claude-runner-0 -- bash

# Inside pod:
cd /home/runner/repo
git worktree add ../worktrees/test-123 -b test-branch-123
git worktree list

# Cleanup
git worktree remove ../worktrees/test-123 --force
```

### Step 10.3: Test SQLite Database

```bash
# From your machine, verify SQLite database
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "PRAGMA integrity_check"
# Should return: ok

# Check tables exist
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  ".tables"
# Should show: sessions, questions, prompts, commits, tool_calls, activity_log, screenshots, config

# Test WAL mode is enabled
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "PRAGMA journal_mode"
# Should return: wal
```

### Step 10.4: Test Workflow Trigger

Create a test PR and watch the GitHub Actions workflow:

```bash
# Create a test branch
git checkout -b test/claude-integration
echo "# Test" > test.md
git add test.md
git commit -m "test: add test file"
git push -u origin test/claude-integration

# Create PR
gh pr create --title "Test: Claude Integration" \
  --body "Testing Claude Code workflow" \
  --base main
```

Monitor the workflow in GitHub Actions → View logs

### Step 10.5: Test Question & Response

Manually test the blocking question flow:

```bash
# In your pod, get Claude to ask a question somehow
# (You could manually create a scenario)

# Then from GitHub, respond:
gh pr comment <PR_NUM> -b "@claude-answer: Use hooks instead of Context API"

# Watch the webhook trigger and Claude resume
```

---

## Phase 11: Troubleshooting & Monitoring

### Issue: Pod stuck in CrashLoopBackOff

```bash
# Check logs
kubectl logs claude-runner-0

# Check if entrypoint.sh exists
kubectl exec claude-runner-0 -- ls -la /entrypoint.sh

# Manually run entrypoint
kubectl exec claude-runner-0 -- bash /entrypoint.sh
```

### Issue: Worktree creation fails

```bash
# Inside the pod
cd /home/runner/repo
git status

# Check if git is configured
git config user.name
git config user.email
```

### Issue: SQLite database issues

```bash
# Check database integrity
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "PRAGMA integrity_check"

# Check if database file exists
kubectl exec claude-runner-0 -- ls -la /home/runner/.claude/gwa.db

# If corrupt, reinitialize (WARNING: loses all session data)
kubectl exec claude-runner-0 -- rm /home/runner/.claude/gwa.db*
kubectl rollout restart statefulset claude-runner
```

### Issue: Tmux window doesn't exist after attach

```bash
# Re-initialize tmux
kubectl exec claude-runner-0 -- tmux kill-session -t claude-work
kubectl exec claude-runner-0 -- tmux new-session -d -s claude-work
```

### Issue: Pod stuck on Claude Code login/auth screen *(FIXED in v1.1.0)*

Pods can get stuck on the Claude Code authentication screen despite `CLAUDE_CODE_OAUTH_TOKEN` being set. This silently prevents the pod from processing commands.

**Root cause:** tmux sessions may not propagate env vars to new windows; token may expire without detection.

**Three-layer fix implemented:**

1. **Prevention** — Auth tokens explicitly pushed into tmux session via `tmux set-environment`:
   - Entrypoint (`helm/configmap.yaml`): pushes tokens on session creation and refreshes on restart
   - `src/lib/repl-session.ts`: calls `setEnvironment()` before creating REPL windows
   - `src/lib/tmux.ts`: new `setEnvironment()` wraps `tmux set-environment`

2. **Detection** — Auth screen patterns checked after Claude launch:
   - `src/lib/claude.ts`: `detectAuthFailure()` checks output against 15 auth-screen patterns
   - REPL mode: pane captured 3s after launch, checked for patterns, window killed if stuck
   - Headless mode: stderr/stdout checked before returning generic errors
   - Pre-flight: `checkAuthEnvironment()` validates env vars exist before any launch

3. **Notification** — GitHub PR comment posted with remediation:
   - `src/orchestrate.ts`: `postAuthStuckComment()` posts comment with pod name, timestamp, and fix steps

**If it still happens (token expired):**

```bash
# Refresh the token
kubectl create secret generic gwa-secrets \
  --from-literal=claude-oauth-token=<new-token> \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart the pod
kubectl rollout restart statefulset gwa-runner
```

**Files changed:** `src/lib/claude.ts`, `src/lib/tmux.ts`, `src/lib/repl-session.ts`, `src/orchestrate.ts`, `helm/gwa-runner/templates/configmap.yaml`

### Monitoring: Check Active Sessions

```bash
# Query SQLite for active sessions
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT id, type, status, github_number, tmux_window FROM sessions WHERE status IN ('running', 'blocked')"

# Check tmux windows
kubectl exec claude-runner-0 -- tmux list-windows -t claude-work

# Attach and observe
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work
```

---

## Quick Start Deployment Checklist

- [ ] **Infrastructure:** Longhorn installed, PVC created
- [ ] **Pod:** StatefulSet deployed, pod running
- [ ] **SQLite:** Database initialized, WAL mode enabled
- [x] **Auth Detection:** Claude auth-screen detection and PR notification (v1.1.0)
- [ ] **GitHub:** OAuth token generated and stored in secrets
- [ ] **Container:** Image built and pushed to registry
- [ ] **Workflows:** Both workflows (.yml files) created and committed
- [ ] **CronJob:** Cleanup job deployed with RBAC
- [ ] **Repository:** `.claude/CLAUDE.md` created with project guidelines
- [ ] **Testing:** All 5 test scenarios passing

---

## Implementation in Claude Code

To have Claude Opus 4.5 implement everything:

1. **Create the full architecture document** (this file is ready)
2. **Create implementation tasks breakdown** (see next section)
3. **Pass to Claude Opus 4.5** with clear prompts

---

## Prompt for Claude Opus 4.5

Use this prompt template when working with Claude Opus:

```
I have a comprehensive implementation plan for a production Claude Code integration
system with persistent pods, git worktrees, SQLite tracking, and resilient question handling.

Here's the complete plan: [PASTE THIS ENTIRE DOCUMENT]

My k3s homelab has:
- 6 nodes
- PostgreSQL HA (3-pod)
- Longhorn for persistent storage (SQLite lives here)
- Traefik ingress
- NATS JetStream
- Tech stack: Bun, Go, Node.js (NO Python)

I need you to:

1. **Review the plan** and flag any issues or improvements
2. **Create the Dockerfile** for the Claude runner container (multi-stage Bun build)
3. **Create Bun CLI tools** (src/ask-question.ts, src/debug-db.ts, src/pod-health-check.ts, src/lib/updater.ts) with package.json
4. **Generate all YAML manifests** (StorageClass, StatefulSet, CronJob, RBAC)
5. **Create the GitHub workflow files** (.github/workflows/)
6. **Create repository configuration files** (.claude/CLAUDE.md, .claude/commands/)
7. **Provide step-by-step deployment instructions** for my specific setup
8. **Create monitoring and debugging scripts**

Please structure output as:
- Phase deliverables in order
- Ready-to-deploy YAML
- Ready-to-commit Dockerfiles and workflow files
- Bun CLI tools (TypeScript) for GitHub/SQLite interactions
- Shell scripts for deployment orchestration

Start with Phase 1 artifacts (Dockerfile, StorageClass) and build up.
```

---

## Key Architecture Decisions

### Why Long-Lived Pod?
- Persists session data across GitHub Action runs
- Maintains tmux windows for multiple PRs
- Reduces startup overhead
- Enables true session continuity

### Why Git Worktrees?
- Isolates each PR's working directory
- Prevents file conflicts during parallel work
- Maintains separate git indices per branch
- Natural cleanup via CronJob

### Why SQLite?
- Co-located with session data on Longhorn — no network dependency
- Embedded database — database down ≠ workflow broken
- Richer queries — joins, aggregations, full audit history
- WAL mode handles 5+ concurrent sessions without contention
- Single source of truth — no split between cache and persistent storage
- Startup recovery — easy to mark stale sessions on pod restart

### Why Longhorn?
- Replication across nodes for HA
- Automatic backup capabilities
- Flexible storage allocation (1TB-4TB mounts)
- Survives pod restarts

### Why Blocking with Health Checks?
- Simple mental model (GitHub Action waits for answer)
- Natural GitHub workflow (respond in PR comments)
- Health checks detect pod crashes early
- Graceful fallback to webhook resume

### Why Interactive REPL (Not Headless)?

**Headless approach (`claude --print`) has limitations:**
- Each invocation is a new process — context lost between runs
- Questions cause workflow exit — must restart entire flow
- No human takeover — can't attach and guide mid-session
- Relies on `--continue` flag which has limits

**Interactive REPL solves these:**
- REPL stays running in tmux for entire work scope
- Questions block the REPL — answer via `tmux send-keys`, Claude continues
- Human can attach anytime: `kubectl exec -it ... tmux attach`
- Full conversation context preserved
- Natural session boundaries (feature complete → PR created)

**When to use headless/SDK instead:**
- Vision verification (isolated API call)
- Quick summaries (no context needed)
- PR description generation
- Any task that doesn't need conversation history

### Why Hybrid Shell + Bun?
- Bun TypeScript for external service interactions (GitHub API, SQLite) — type safety, proper error handling, SDK support
- Shell for pure orchestration (kubectl apply, docker build) — simple, no dependencies, universal
- Bun compiles to standalone binaries — no runtime dependencies in container
- Aligns with tech stack (Bun, Go, Node.js — no Python)
- Better maintainability for complex logic while keeping simplicity for command sequencing

### Why Lightweight Screenshots?
- GitHub doesn't expose CDN upload API for issue attachments (only web UI does)
- Base64 inline images limited to ~75KB after encoding overhead
- Heavy image libraries (canvas, sharp) add container bloat
- CLI tools (aha, wkhtmltoimage) are lighter and already available in Debian
- Vision verification is expensive - only call when anomalies detected
- Screenshots are debugging aids, not core functionality

---

## Phase 12: GitHub Projects Integration

### Overview

GitHub Projects v2 provides the workflow backbone for Claude's work. Project items move through columns, triggering different Claude behaviors.

### Step 12.1: Project Workflow Columns & Session Lifecycle

**Key Principle:** One persistent session per project item. Session created at Planning, destroyed at Done.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Project Item Lifecycle = Session Lifecycle                                  │
│                                                                              │
│  ┌─────────┐                                                                │
│  │  Todo   │  ← No session yet (human hasn't started it)                    │
│  └────┬────┘                                                                │
│       │ Human moves to Planning                                             │
│       ▼                                                                      │
│  ┌──────────┐                                                               │
│  │ Planning │  ← SESSION CREATED (tmux window 1, SQLite row, worktree)      │
│  └────┬─────┘    Claude planning agent starts in window 1                   │
│       │          Creates .plans/issue-{N}/, asks questions                  │
│       │          Same session throughout planning iterations                │
│       ▼                                                                      │
│  ┌─────────────┐                                                            │
│  │ In Progress │  ← SAME SESSION continues                                  │
│  └────┬────────┘    Architect uses existing window 1                        │
│       │             Spawns workers in windows 2, 3, 4...                    │
│       │             Workers destroyed after task complete, window 1 persists│
│       ▼                                                                      │
│  ┌────┐                                                                     │
│  │ QA │  ← SAME SESSION (paused while Playwright tests run)                 │
│  └─┬──┘    If tests fail → back to In Progress, session resumes            │
│    │       If tests pass → auto-move to Review                              │
│    ▼                                                                         │
│  ┌────────┐                                                                 │
│  │ Review │  ← SAME SESSION (idle, available if human has questions)        │
│  └────┬───┘    Human reviews PR, may ask Claude for changes                 │
│       │                                                                      │
│       │ Human merges PR, moves to Done                                      │
│       ▼                                                                      │
│  ┌──────┐                                                                   │
│  │ Done │  ← SESSION DESTROYED                                              │
│  └──────┘    Cleanup: tmux windows killed, worktree removed                 │
│              SQLite row marked 'completed' (retained for history)           │
│                                                                              │
│            ┌─────────┐                                                      │
│            │ Blocked │  ← SESSION PRESERVED (waiting for human input)       │
│            └─────────┘    Can enter from any column                         │
│                           Returns to previous column when answered          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Session State by Column:**

| Column | Session Status | Tmux Windows | REPL Active |
|--------|---------------|--------------|-------------|
| Todo | (none) | (none) | No |
| Planning | `running` | Window 1: planning agent | Yes |
| In Progress | `running` | Window 1: architect, 2-N: workers | Yes |
| QA | `paused` | All windows preserved | No (tests running) |
| Blocked | `blocked` | All windows preserved | No (waiting) |
| Review | `idle` | Window 1 preserved | No (awaiting merge) |
| Done | `completed` | **All windows destroyed** | No |

**Workflow Rules:**
- **Todo → Planning:** Human moves when ready → **SESSION CREATED**
- **Planning → In Progress:** Human approves plan → Same session continues
- **In Progress → QA:** Implementation complete → Session paused, tests run
- **QA → Review:** Tests pass → Session idle
- **QA → In Progress:** Tests fail → Session resumes for fixes
- **Review → Done:** PR merged → **SESSION DESTROYED**
- **Any → Blocked:** Claude asks question → Session preserved, waiting
- **Blocked → Previous:** Answer received → Session resumes

**Benefits of Unified Session:**
- Planning context available during implementation (no re-explaining)
- Single `claude_session_id` for `--resume` across all phases
- Human can `tmux attach` to same window at any point
- Crash recovery simplified - one session to resume
- Worker windows ephemeral, architect window persistent

### Step 12.2: Planning Templates

The Planning column uses rigid document templates to create a complete orchestration blueprint. Templates are stored in `templates/plans/` and instantiated to `.plans/issue-{N}/` for each issue.

**Template Structure:**

```
templates/plans/
├── README.md         # Template documentation
├── plan.md           # Full implementation spec (REQUIRED)
├── prompt.md         # Injection prompt for agents (REQUIRED)
├── checklist.md      # Progress tracking (REQUIRED)
├── decisions.md      # Q&A and design decisions (REQUIRED)
└── snippets.md       # Code context for workers (OPTIONAL)

.plans/issue-42/      # Instantiated for Issue #42
├── plan.md           # Filled with issue-specific content
├── prompt.md         # Rendered with issue context
├── checklist.md      # Tracks implementation progress
├── decisions.md      # Logs all questions and answers
└── snippets.md       # Relevant code excerpts
```

**Template Contents:**

| Template | Sections | Purpose |
|----------|----------|---------|
| `plan.md` | Executive Summary, Requirements, Technical Design, **Agent Orchestration**, Risk Assessment, Testing Strategy | Complete implementation specification with worker task breakdown |
| `prompt.md` | Context, Task Scope, Skills, Constraints, Progress Reporting | Injected into Claude REPL when work begins |
| `checklist.md` | Task Progress, Validation Steps, Quick Commands, Test Results | Real-time tracking during implementation |
| `decisions.md` | Questions & Answers, Design Decisions, Assumptions, Rejected Alternatives | Audit trail of planning decisions |
| `snippets.md` | Key Files, Code Snippets, Interfaces, Patterns, Database Schema | Code context so workers don't re-search |

**Agent Orchestration in plan.md:**

The most critical section - defines exactly how work is parallelized:

```yaml
# From plan.md - Agent Orchestration section

architect:
  session_id: "issue-42"
  tmux_window: 1
  skills:
    - /setup-safety    # Git safety before any commits
    - /handoff         # Context for crash recovery
  max_workers: 5
  coordination_strategy: dependency_graph

tasks:
  - task_id: task-001
    agent_type: worker
    tmux_window: 2
    estimated_hours: 2
    complexity: medium
    skills:
      - /parallel-tdd
    scope:
      files:
        - src/lib/auth.ts
        - src/lib/auth.test.ts
      description: |
        Implement OAuth2 token refresh logic with automatic retry.
    dependencies:
      blocked_by: []
      blocks: [task-002, task-003]
    validation:
      - Unit tests pass
      - Token refresh works with expired tokens

  - task_id: task-002
    agent_type: worker
    tmux_window: 3
    # ... more task definitions
```

**Planning → Implementation Handoff:**

When human approves plan and moves item to "In Progress":

```typescript
// 1. Load plan and prompt
const plan = await Bun.file(`.plans/issue-${n}/plan.md`).text();
const promptTemplate = await Bun.file(`.plans/issue-${n}/prompt.md`).text();

// 2. Render architect prompt
const architectPrompt = renderPrompt(promptTemplate, {
  ROLE: 'architect',
  ISSUE_NUMBER: n,
  ISSUE_TITLE: issue.title,
  TASK_SUMMARY_TABLE: extractTaskTable(plan),
  SKILLS: extractArchitectSkills(plan),
});

// 3. Inject into tmux REPL
await tmux.sendKeys('claude', Enter);
await sleep(2000);
await tmux.sendKeys(architectPrompt, Enter);

// 4. Architect reads plan.md, spawns workers from task definitions
```

**Worker Prompt Injection:**

Each worker gets a scoped prompt:

```typescript
// Architect spawns worker for task-001
const workerPrompt = renderPrompt(promptTemplate, {
  ROLE: 'worker',
  TASK_ID: 'task-001',
  TASK_NAME: task.name,
  SCOPE_FILES: task.scope.files.join('\n'),
  TASK_DESCRIPTION: task.scope.description,
  SKILLS: task.skills,
  INPUTS: task.inputs,
  OUTPUTS: task.outputs,
  VALIDATION_STEPS: task.validation.join('\n'),
});

// Create new tmux window for worker
await tmux.newWindow(`claude-work:${task.tmux_window}`);
await tmux.sendKeys(`claude-work:${task.tmux_window}`, 'claude', Enter);
await sleep(2000);
await tmux.sendKeys(`claude-work:${task.tmux_window}`, workerPrompt, Enter);
```

### Step 12.3: Plan-Issue Sync (`src/lib/plan-sync.ts`)

Plans live in the repo (`.plans/issue-{N}/`) but are **also surfaced in the GitHub issue** so humans can review without cloning.

**What Gets Synced:**

| Location | Content | When Updated |
|----------|---------|--------------|
| Issue Description | Plan links table with status | Planning complete, status changes |
| Issue Comment | Collapsible plan summary | Planning complete |
| Issue Comment | Progress updates | During implementation |
| Project Item Fields | Plan metadata | Planning complete, throughout |

**Issue Description Linking:**

```markdown
<!-- GWA-PLAN-LINK -->
---
### 🤖 Claude Implementation Plan

| Resource | Link |
|----------|------|
| 📋 Full Plan | [`.plans/issue-42/plan.md`](.plans/issue-42/plan.md) |
| ✅ Checklist | [`.plans/issue-42/checklist.md`](.plans/issue-42/checklist.md) |
| 📝 Decisions | [`.plans/issue-42/decisions.md`](.plans/issue-42/decisions.md) |
| 💻 Code Context | [`.plans/issue-42/snippets.md`](.plans/issue-42/snippets.md) |

| Metric | Value |
|--------|-------|
| **Status** | 👀 Pending Review - Awaiting human approval |
| **Version** | v1 |
| **Tasks** | 5 |
| **Files Changed** | 8 |

<!-- /GWA-PLAN-LINK -->
```

**Plan Summary Comment:**

When planning completes, Claude posts a collapsible summary:

```markdown
## 📋 Implementation Plan Complete

Brief executive summary of what will be built...

<details>
<summary><strong>📊 Task Breakdown (5 tasks)</strong></summary>

| Task ID | Name | Complexity | Dependencies |
|---------|------|------------|--------------|
| task-001 | Implement auth module | medium | none |
| task-002 | Add token refresh | medium | task-001 |
...
</details>

<details>
<summary><strong>📁 Files to Change</strong></summary>

| Action | File Path | Description |
|--------|-----------|-------------|
| CREATE | `src/lib/auth.ts` | OAuth2 authentication |
...
</details>
```

**Implementation:**

```typescript
// src/lib/plan-sync.ts

export async function linkPlanToIssue(
  config: PlanSyncConfig,
  planStatus: PlanStatus
): Promise<void> {
  const { owner, repo, issueNumber, octokit } = config;

  const { data: issue } = await octokit.issues.get({
    owner, repo, issue_number: issueNumber,
  });

  const planSection = generatePlanLinkSection(issueNumber, planStatus);

  let updatedBody: string;
  if (issue.body?.includes('<!-- GWA-PLAN-LINK -->')) {
    // Update existing section
    updatedBody = issue.body.replace(
      /<!-- GWA-PLAN-LINK -->[\s\S]*?<!-- \/GWA-PLAN-LINK -->/,
      planSection
    );
  } else {
    // Append new section
    updatedBody = (issue.body || '') + '\n\n' + planSection;
  }

  await octokit.issues.update({
    owner, repo, issue_number: issueNumber, body: updatedBody,
  });
}

export async function postPlanSummary(
  config: PlanSyncConfig,
  planContent: string
): Promise<void> {
  const summary = extractExecutiveSummary(planContent);
  const taskTable = extractTaskTable(planContent);
  const fileChanges = extractFileChanges(planContent);

  await octokit.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: `## 📋 Implementation Plan Complete\n\n${summary}\n\n<details>...`
  });
}

export async function postProgressUpdate(
  config: PlanSyncConfig,
  completedTasks: string[],
  inProgressTasks: string[],
  overallProgress: number
): Promise<void> {
  const progressBar = generateProgressBar(overallProgress);

  await octokit.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: `## 📊 Progress Update\n\n${progressBar} **${overallProgress}%**\n\n...`
  });
}
```

**Full sync on planning complete:**

```typescript
// Called when planning phase finishes
await fullPlanSync(config, planContent, projectItemId);
// 1. Updates issue description with plan links
// 2. Posts plan summary comment
// 3. Updates project item custom fields
```

See `templates/lib/plan-sync.ts` for complete implementation.

### Step 12.4: Project Custom Fields

| Field | Type | Purpose |
|-------|------|---------|
| `Claude Session ID` | Text | Internal session ID |
| `Tmux Session` | Text | tmux session name (e.g., `claude-work`) |
| `Tmux Window` | Number | Window number in tmux |
| `Pod Name` | Text | K8s pod running the session |
| `Kubectl Attach Command` | Text | Full command to attach (for quick copy) |
| `Branch Name` | Text | Git branch being worked on |
| `PR Number` | Number | Created PR number |
| `Questions Asked` | Number | Count of questions asked |
| `Plan Iterations` | Number | How many planning cycles |
| `Session Duration` | Text | How long Claude has worked |
| `Last Claude Activity` | Date | Last activity timestamp |
| `Plan Approved` | Checkbox | Human approved the plan |
| `Tests Passed` | Checkbox | QA tests passed |
| `Commits Count` | Number | How many commits made |
| `Files Changed` | Number | Scope of changes |
| `Last Error` | Text | Most recent error if any |
| `Architect Agent ID` | Text | For swarm tracking |
| `Worker Agents` | Text | Active worker agent IDs |
| `Task List` | Text | Current task list (synced from Claude) |

### Step 12.5: Project Template

Store in `templates/github-project.json`:

```json
{
  "name": "GWA Project - {{REPO_NAME}}",
  "description": "GitHub Workflow Agents project board for {{REPO_NAME}}",
  "columns": [
    {
      "name": "Todo",
      "description": "Items ready for work. Move to Planning when ready for Claude."
    },
    {
      "name": "Planning",
      "description": "Claude analyzes requirements, asks questions, creates detailed implementation plan.",
      "triggers": {
        "on_enter": "start_planning_session",
        "claude_mode": "planning"
      }
    },
    {
      "name": "In Progress",
      "description": "Claude implements with sub-agents. Plan must be approved first.",
      "triggers": {
        "on_enter": "start_implementation_session",
        "claude_mode": "implementation",
        "requires": ["plan_approved"]
      }
    },
    {
      "name": "QA",
      "description": "Playwright e2e tests run automatically.",
      "triggers": {
        "on_enter": "run_playwright_tests",
        "auto_move_on_pass": "Review",
        "on_fail": "log_failures_for_claude"
      }
    },
    {
      "name": "Blocked",
      "description": "Claude is waiting for human input.",
      "triggers": {
        "on_answer": "move_to_previous_column"
      }
    },
    {
      "name": "Review",
      "description": "PR ready for human review."
    },
    {
      "name": "Done",
      "description": "Work complete, PR merged."
    }
  ],
  "custom_fields": [
    {"name": "Claude Session ID", "type": "text"},
    {"name": "Tmux Session", "type": "text"},
    {"name": "Tmux Window", "type": "number"},
    {"name": "Pod Name", "type": "text"},
    {"name": "Kubectl Attach Command", "type": "text"},
    {"name": "Branch Name", "type": "text"},
    {"name": "PR Number", "type": "number"},
    {"name": "Questions Asked", "type": "number", "default": 0},
    {"name": "Plan Iterations", "type": "number", "default": 0},
    {"name": "Session Duration", "type": "text"},
    {"name": "Last Claude Activity", "type": "date"},
    {"name": "Plan Approved", "type": "checkbox", "default": false},
    {"name": "Tests Passed", "type": "checkbox", "default": false},
    {"name": "Commits Count", "type": "number", "default": 0},
    {"name": "Files Changed", "type": "number", "default": 0},
    {"name": "Last Error", "type": "text"},
    {"name": "Architect Agent ID", "type": "text"},
    {"name": "Worker Agents", "type": "text"},
    {"name": "Task List", "type": "text"}
  ]
}
```

### Step 12.6: `src/lib/projects.ts`

GitHub Projects v2 uses GraphQL API:

```typescript
// src/lib/projects.ts
import { Octokit } from '@octokit/rest';
import { getDatabase } from './db';

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

interface ProjectItem {
  id: string;
  title: string;
  status: string;
  fields: Record<string, any>;
}

interface ProjectConfig {
  projectId: string;
  owner: string;
  repo: string;
  fieldIds: Record<string, string>;  // field name → field ID mapping
  columnIds: Record<string, string>; // column name → option ID mapping
}

/**
 * Get project configuration (cached in SQLite)
 */
export async function getProjectConfig(owner: string, repo: string): Promise<ProjectConfig | null> {
  const db = getDatabase();

  const cached = db.query(`
    SELECT value FROM config WHERE key = 'project_config'
  `).get() as { value: string } | null;

  if (cached) {
    return JSON.parse(cached.value);
  }

  // Fetch from GitHub if not cached
  return await fetchAndCacheProjectConfig(owner, repo);
}

/**
 * Update a project item's status (column)
 */
export async function updateItemStatus(
  itemId: string,
  newStatus: 'Todo' | 'Planning' | 'In Progress' | 'QA' | 'Blocked' | 'Review' | 'Done',
  token: string
): Promise<void> {
  const config = await getProjectConfig(process.env.GITHUB_OWNER!, process.env.GITHUB_REPO!);
  if (!config) throw new Error('Project not configured');

  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }
  `;

  await graphqlRequest(mutation, {
    projectId: config.projectId,
    itemId,
    fieldId: config.fieldIds['Status'],
    optionId: config.columnIds[newStatus]
  }, token);

  // Log activity
  const db = getDatabase();
  db.run(`
    INSERT INTO activity_log (event, details, actor)
    VALUES ('project_status_updated', json_object('item_id', ?, 'new_status', ?), 'claude')
  `, [itemId, newStatus]);
}

/**
 * Update custom fields on a project item
 */
export async function updateItemFields(
  itemId: string,
  fields: Record<string, any>,
  token: string
): Promise<void> {
  const config = await getProjectConfig(process.env.GITHUB_OWNER!, process.env.GITHUB_REPO!);
  if (!config) throw new Error('Project not configured');

  for (const [fieldName, value] of Object.entries(fields)) {
    const fieldId = config.fieldIds[fieldName];
    if (!fieldId) continue;

    const mutation = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(
          input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: $value
          }
        ) {
          projectV2Item { id }
        }
      }
    `;

    const fieldValue = formatFieldValue(fieldName, value);
    await graphqlRequest(mutation, {
      projectId: config.projectId,
      itemId,
      fieldId,
      value: fieldValue
    }, token);
  }
}

/**
 * Add a comment to the linked issue/PR
 */
export async function addItemComment(
  itemId: string,
  comment: string,
  token: string
): Promise<void> {
  const github = new Octokit({ auth: token });

  // Get the issue/PR number from the project item
  const item = await getProjectItem(itemId, token);
  if (!item?.content?.number) return;

  const [owner, repo] = (process.env.REPO || '').split('/');
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: item.content.number,
    body: comment
  });
}

/**
 * Update the item description (for task list sync)
 */
export async function updateItemDescription(
  itemId: string,
  taskListMarkdown: string,
  token: string
): Promise<void> {
  const item = await getProjectItem(itemId, token);
  if (!item?.content?.number) return;

  const github = new Octokit({ auth: token });
  const [owner, repo] = (process.env.REPO || '').split('/');

  // Get current body and update task list section
  const issue = await github.rest.issues.get({ owner, repo, issue_number: item.content.number });
  const currentBody = issue.data.body || '';

  // Replace or append task list section
  const taskListSection = `\n\n---\n## Claude Task List\n\n${taskListMarkdown}\n`;
  const marker = '## Claude Task List';

  let newBody: string;
  if (currentBody.includes(marker)) {
    // Replace existing section
    newBody = currentBody.replace(/## Claude Task List[\s\S]*?(?=\n---|\n## |$)/, `## Claude Task List\n\n${taskListMarkdown}\n`);
  } else {
    // Append new section
    newBody = currentBody + taskListSection;
  }

  await github.rest.issues.update({
    owner,
    repo,
    issue_number: item.content.number,
    body: newBody
  });
}

/**
 * Sync session data to project item fields
 */
export async function syncSessionToProject(
  sessionId: string,
  projectItemId: string,
  token: string
): Promise<void> {
  const db = getDatabase();

  const session = db.query(`
    SELECT
      s.*,
      (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id) as question_count,
      (SELECT COUNT(*) FROM commits c WHERE c.session_id = s.id) as commit_count
    FROM sessions s WHERE s.id = ?
  `).get(sessionId) as any;

  if (!session) return;

  // Calculate duration
  const startTime = session.started_at || session.created_at;
  const duration = startTime
    ? formatDuration(Date.now() / 1000 - startTime)
    : 'Not started';

  // Build kubectl attach command
  const attachCmd = session.tmux_window
    ? `kubectl exec -it ${session.pod_name || 'claude-runner-0'} -- tmux attach -t claude-work:${session.tmux_window}`
    : '';

  await updateItemFields(projectItemId, {
    'Claude Session ID': sessionId,
    'Tmux Session': 'claude-work',
    'Tmux Window': session.tmux_window,
    'Pod Name': session.pod_name || 'claude-runner-0',
    'Kubectl Attach Command': attachCmd,
    'Branch Name': session.branch,
    'Questions Asked': session.question_count,
    'Commits Count': session.commit_count,
    'Session Duration': duration,
    'Last Claude Activity': new Date().toISOString()
  }, token);
}

// Helper functions
async function graphqlRequest(query: string, variables: any, token: string): Promise<any> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  return response.json();
}

function formatFieldValue(fieldName: string, value: any): any {
  // Format based on field type
  if (typeof value === 'number') return { number: value };
  if (typeof value === 'boolean') return { checkbox: value };
  if (value instanceof Date) return { date: value.toISOString() };
  return { text: String(value) };
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function getProjectItem(itemId: string, token: string): Promise<any> {
  const query = `
    query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          id
          content {
            ... on Issue { number title }
            ... on PullRequest { number title }
          }
        }
      }
    }
  `;
  const result = await graphqlRequest(query, { itemId }, token);
  return result.data?.node;
}

async function fetchAndCacheProjectConfig(owner: string, repo: string): Promise<ProjectConfig | null> {
  // Implementation to fetch project config from GitHub
  // and cache in SQLite config table
  return null; // TODO: Implement
}
```

### Step 12.7: PR Trigger Filtering

Only trigger on Claude-created PRs:

```typescript
// src/lib/pr-filter.ts

const ALLOWED_AUTHORS = ['claude-code-bot', 'jaybrto']; // Add your username
const CLAUDE_BRANCH_PREFIX = 'claude/';
const CLAUDE_LABEL = 'created-by-claude';

export interface PRFilterResult {
  shouldProcess: boolean;
  reason: string;
}

/**
 * Check if a PR should be processed by Claude workflows
 */
export function shouldProcessPR(pr: {
  author: string;
  branch: string;
  labels: string[];
}): PRFilterResult {
  // Check if author is allowed
  if (ALLOWED_AUTHORS.includes(pr.author)) {
    return { shouldProcess: true, reason: 'Author is allowed' };
  }

  // Check for Claude branch naming convention
  if (pr.branch.startsWith(CLAUDE_BRANCH_PREFIX)) {
    return { shouldProcess: true, reason: 'Branch follows Claude naming convention' };
  }

  // Check for Claude label
  if (pr.labels.includes(CLAUDE_LABEL)) {
    return { shouldProcess: true, reason: 'PR has Claude label' };
  }

  // Default: don't process
  return {
    shouldProcess: false,
    reason: `PR not created by Claude (author: ${pr.author}, branch: ${pr.branch})`
  };
}

/**
 * Mark a branch/PR as created by Claude
 */
export function getClaudeBranchName(issueNumber: number, description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30);
  return `${CLAUDE_BRANCH_PREFIX}issue-${issueNumber}-${slug}`;
}
```

### Step 12.8: Column Transition Trigger Matrix

**Not every column move triggers Claude.** Each transition has a specific action type:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Column Transition Triggers                                                  │
│                                                                              │
│  Todo → Planning         TRIGGER: Claude (create session)                   │
│                          Action: Create REPL in tmux window 1               │
│                          Script: start-planning-session.sh                  │
│                                                                              │
│  Planning → In Progress  TRIGGER: Claude (inject prompt)                    │
│                          Action: Send .plans/issue-{N}/prompt.md to REPL    │
│                          Script: inject-prompt.sh                           │
│                          Prereq: plan_approved = true                       │
│                                                                              │
│  In Progress → QA        TRIGGER: Playwright (NOT Claude)                   │
│                          Action: Run e2e tests, update qa_runs table        │
│                          Script: run-playwright.sh                          │
│                          Claude session: paused                             │
│                                                                              │
│  QA → Review             NO TRIGGER                                         │
│                          Tests passed, awaiting human review                │
│                                                                              │
│  QA → In Progress        TRIGGER: Claude (resume with failures)             │
│                          Action: Send test failure summary to REPL          │
│                          Script: resume-with-failures.sh                    │
│                                                                              │
│  Review → Done           TRIGGER: CI/CD Pipeline (NOT Claude)               │
│                          Action: Deploy to production, cleanup session      │
│                          Script: deploy-and-cleanup.sh                      │
│                                                                              │
│  Any → Blocked           NO TRIGGER                                         │
│                          Session preserved, waiting for human input         │
│                                                                              │
│  Blocked → Previous      TRIGGER: Claude (send answer)                      │
│                          Action: tmux send-keys with the answer             │
│                          Script: send-answer.sh                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Trigger Summary Table:**

| Transition | Trigger Type | Script | Claude Action |
|------------|--------------|--------|---------------|
| → Todo | None | - | - |
| Todo → Planning | **Claude** | `start-planning-session.sh` | Create session |
| Planning → In Progress | **Claude** | `inject-prompt.sh` | Inject prompt.md |
| In Progress → QA | **Playwright** | `run-playwright.sh` | Paused |
| QA → Review | None | - | Idle |
| QA → In Progress | **Claude** | `resume-with-failures.sh` | Resume |
| Review → Done | **CI/CD** | `deploy-and-cleanup.sh` | Destroyed |
| Any → Blocked | None | - | Preserved |
| Blocked → Previous | **Claude** | `send-answer.sh` | Resume |

### Step 12.9: Workflow YAML for Project Triggers

Create `.github/workflows/project-item-moved.yml`:

```yaml
name: Project Item Column Change

on:
  projects_v2_item:
    types: [edited]

jobs:
  route-action:
    runs-on: self-hosted
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Detect transition
        id: transition
        env:
          FROM_COLUMN: ${{ github.event.changes.field_value.from.name }}
          TO_COLUMN: ${{ github.event.changes.field_value.to.name }}
          ITEM_ID: ${{ github.event.projects_v2_item.node_id }}
        run: |
          echo "from=${FROM_COLUMN}" >> $GITHUB_OUTPUT
          echo "to=${TO_COLUMN}" >> $GITHUB_OUTPUT
          echo "item_id=${ITEM_ID}" >> $GITHUB_OUTPUT
          echo "Transition: ${FROM_COLUMN} → ${TO_COLUMN}"

      # ═══════════════════════════════════════════════════════════════
      # CLAUDE TRIGGERS
      # ═══════════════════════════════════════════════════════════════

      - name: "Claude: Start Planning Session"
        if: |
          steps.transition.outputs.from == 'Todo' &&
          steps.transition.outputs.to == 'Planning'
        run: |
          ./scripts/start-planning-session.sh "${{ steps.transition.outputs.item_id }}"

      - name: "Claude: Inject Implementation Prompt"
        if: |
          steps.transition.outputs.from == 'Planning' &&
          steps.transition.outputs.to == 'In Progress'
        run: |
          ./scripts/inject-prompt.sh "${{ steps.transition.outputs.item_id }}"

      - name: "Claude: Resume After QA Failure"
        if: |
          steps.transition.outputs.from == 'QA' &&
          steps.transition.outputs.to == 'In Progress'
        run: |
          ./scripts/resume-with-failures.sh "${{ steps.transition.outputs.item_id }}"

      - name: "Claude: Send Answer from Blocked"
        if: |
          steps.transition.outputs.from == 'Blocked'
        run: |
          ./scripts/send-answer.sh "${{ steps.transition.outputs.item_id }}" \
            "${{ steps.transition.outputs.to }}"

      # ═══════════════════════════════════════════════════════════════
      # PLAYWRIGHT TRIGGERS
      # ═══════════════════════════════════════════════════════════════

      - name: "Playwright: Run E2E Tests"
        if: |
          steps.transition.outputs.from == 'In Progress' &&
          steps.transition.outputs.to == 'QA'
        run: |
          ./scripts/run-playwright.sh "${{ steps.transition.outputs.item_id }}"

      # ═══════════════════════════════════════════════════════════════
      # CI/CD TRIGGERS
      # ═══════════════════════════════════════════════════════════════

      - name: "CI/CD: Deploy to Production"
        if: |
          steps.transition.outputs.from == 'Review' &&
          steps.transition.outputs.to == 'Done'
        run: |
          ./scripts/deploy-and-cleanup.sh "${{ steps.transition.outputs.item_id }}"

      # ═══════════════════════════════════════════════════════════════
      # NO-OP TRANSITIONS (logging only)
      # ═══════════════════════════════════════════════════════════════

      - name: "No-Op: QA → Review"
        if: |
          steps.transition.outputs.from == 'QA' &&
          steps.transition.outputs.to == 'Review'
        run: |
          echo "Tests passed. PR ready for human review. No action needed."

      - name: "No-Op: → Blocked"
        if: |
          steps.transition.outputs.to == 'Blocked'
        run: |
          echo "Session preserved. Waiting for human input via @claude-answer."
```

### Step 12.10: Trigger Scripts

**`scripts/start-planning-session.sh`** - Creates Claude session:

```bash
#!/bin/bash
set -euo pipefail

ITEM_ID="$1"

# Get issue number from project item
ISSUE_NUMBER=$(kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts \
  get-issue-number --item-id "$ITEM_ID")

# Create session in SQLite
SESSION_ID="issue-${ISSUE_NUMBER}"
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "INSERT INTO sessions (id, type, status, github_number, tmux_window, created_at)
   VALUES ('${SESSION_ID}', 'issue', 'running', ${ISSUE_NUMBER}, 1, unixepoch())"

# Create tmux window and start Claude REPL
kubectl exec claude-runner-0 -- tmux new-window -t claude-work:1 -n "issue-${ISSUE_NUMBER}"
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "cd /home/runner/worktrees/issue-${ISSUE_NUMBER}" Enter
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "claude" Enter

# Wait for REPL to initialize
sleep 3

# Send planning prompt
PLANNING_PROMPT="You are starting the Planning phase for Issue #${ISSUE_NUMBER}.

Read the issue description and create a complete implementation plan in .plans/issue-${ISSUE_NUMBER}/.

Use the templates from templates/plans/ and fill in all sections.
Ask clarifying questions as needed.
When the plan is complete, update the issue with a summary."

kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "$PLANNING_PROMPT" Enter

echo "Planning session started for Issue #${ISSUE_NUMBER}"
```

**`scripts/inject-prompt.sh`** - Injects prompt.md into existing REPL:

```bash
#!/bin/bash
set -euo pipefail

ITEM_ID="$1"

# Get issue number and session
ISSUE_NUMBER=$(kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts \
  get-issue-number --item-id "$ITEM_ID")

# Verify plan is approved
APPROVED=$(kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "SELECT plan_approved FROM project_items WHERE id = '${ITEM_ID}'")

if [ "$APPROVED" != "1" ]; then
  echo "ERROR: Plan not approved. Cannot start implementation."
  exit 1
fi

# Read the prompt.md file
PROMPT=$(kubectl exec claude-runner-0 -- cat "/home/runner/worktrees/issue-${ISSUE_NUMBER}/.plans/issue-${ISSUE_NUMBER}/prompt.md")

# Send to existing REPL window
kubectl exec claude-runner-0 -- tmux send-keys -t claude-work:1 "$PROMPT" Enter

# Update session status
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE sessions SET status = 'running' WHERE id = 'issue-${ISSUE_NUMBER}'"

echo "Implementation prompt injected for Issue #${ISSUE_NUMBER}"
```

**`scripts/run-playwright.sh`** - Runs e2e tests (no Claude):

```bash
#!/bin/bash
set -euo pipefail

ITEM_ID="$1"

ISSUE_NUMBER=$(kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts \
  get-issue-number --item-id "$ITEM_ID")

# Pause Claude session
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE sessions SET status = 'paused' WHERE id = 'issue-${ISSUE_NUMBER}'"

# Run Playwright tests
kubectl exec claude-runner-0 -- bash -c "
  cd /home/runner/worktrees/issue-${ISSUE_NUMBER}
  bun run test:e2e 2>&1 | tee /tmp/playwright-results.txt
  EXIT_CODE=\${PIPESTATUS[0]}

  # Record results in SQLite
  bun run /home/runner/src/lib/qa.ts record-results \
    --session issue-${ISSUE_NUMBER} \
    --item-id ${ITEM_ID} \
    --output /tmp/playwright-results.txt \
    --exit-code \$EXIT_CODE
"

echo "Playwright tests complete for Issue #${ISSUE_NUMBER}"
```

**`scripts/deploy-and-cleanup.sh`** - Deploy and destroy session:

```bash
#!/bin/bash
set -euo pipefail

ITEM_ID="$1"

ISSUE_NUMBER=$(kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts \
  get-issue-number --item-id "$ITEM_ID")

# Run deployment pipeline (customize for your setup)
echo "Deploying changes from Issue #${ISSUE_NUMBER}..."
# kubectl apply -f ... or argocd sync or helm upgrade

# Cleanup session
kubectl exec claude-runner-0 -- bash -c "
  # Kill all tmux windows for this session
  tmux kill-window -t claude-work:1 2>/dev/null || true

  # Remove worktree
  cd /home/runner/repo
  git worktree remove /home/runner/worktrees/issue-${ISSUE_NUMBER} --force 2>/dev/null || true

  # Mark session complete
  sqlite3 /home/runner/.claude/gwa.db \"
    UPDATE sessions SET status = 'completed', completed_at = unixepoch()
    WHERE id = 'issue-${ISSUE_NUMBER}'
  \"
"

echo "Session cleaned up for Issue #${ISSUE_NUMBER}"
```

### Step 12.11: SQLite Schema Updates

Add to schema.sql:

```sql
-- ============================================
-- PROJECT_ITEMS: Track GitHub Project items
-- ============================================
CREATE TABLE project_items (
    id TEXT PRIMARY KEY,              -- GitHub Project item node ID
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,

    -- GitHub context
    issue_number INTEGER,
    pr_number INTEGER,
    title TEXT,

    -- Project state
    current_column TEXT,              -- Current column name
    previous_column TEXT,             -- For returning from Blocked
    project_id TEXT,                  -- GitHub Project ID

    -- Timestamps
    created_at INTEGER DEFAULT (unixepoch()),
    last_synced_at INTEGER,

    -- Cached field values (for quick access)
    plan_approved INTEGER DEFAULT 0,
    tests_passed INTEGER DEFAULT 0
);

CREATE INDEX idx_project_items_session ON project_items(session_id);
CREATE INDEX idx_project_items_column ON project_items(current_column);

-- ============================================
-- IMPLEMENTATION_PLANS: Store detailed plans
-- ============================================
CREATE TABLE implementation_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_item_id TEXT REFERENCES project_items(id),

    -- Plan content
    version INTEGER DEFAULT 1,        -- Plan iteration number
    summary TEXT,                     -- High-level summary
    plan_markdown TEXT,               -- Full plan in markdown
    file_path TEXT,                   -- Path to .plans/issue-{N}.md

    -- Approval
    approved INTEGER DEFAULT 0,
    approved_by TEXT,
    approved_at INTEGER,

    -- Sub-agent work breakdown
    work_breakdown TEXT,              -- JSON array of sub-tasks

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_plans_session ON implementation_plans(session_id);
CREATE INDEX idx_plans_approved ON implementation_plans(approved);

-- ============================================
-- QA_RUNS: Track test runs
-- ============================================
CREATE TABLE qa_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    project_item_id TEXT REFERENCES project_items(id),

    -- Test results
    passed INTEGER DEFAULT 0,         -- 1 if all tests passed
    total_tests INTEGER,
    passed_tests INTEGER,
    failed_tests INTEGER,
    skipped_tests INTEGER,

    -- Failure details
    failure_summary TEXT,             -- Summary for Claude to fix
    failure_details TEXT,             -- Full test output

    -- Timing
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    duration_ms INTEGER
);

CREATE INDEX idx_qa_runs_session ON qa_runs(session_id);
CREATE INDEX idx_qa_runs_passed ON qa_runs(passed);
```

---

## Phase 13: Multi-Agent Swarm Architecture

### Overview

When an item moves to "In Progress", Claude operates as a **swarm** with:
- **Architect Agent**: Main orchestrator in tmux window 0, creates detailed plans, assigns work
- **Worker Agents**: Sub-agents in separate tmux windows, work on specific tasks in parallel

### Step 13.1: Swarm Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  tmux session: claude-work                                        │
│                                                                   │
│  Window 0: Architect (pr-123)                                     │
│  ├─ Reads implementation plan                                     │
│  ├─ Breaks down into parallel tasks                               │
│  ├─ Spawns worker agents in windows 1-N                           │
│  ├─ Monitors worker progress                                      │
│  ├─ Validates completed work                                      │
│  └─ Merges and commits final result                               │
│                                                                   │
│  Window 1: Worker-1 (task: implement auth module)                 │
│  ├─ Works on assigned task                                        │
│  ├─ Reports progress to Architect                                 │
│  └─ Signals completion                                            │
│                                                                   │
│  Window 2: Worker-2 (task: implement API routes)                  │
│  ├─ Works on assigned task                                        │
│  ├─ Reports progress to Architect                                 │
│  └─ Signals completion                                            │
│                                                                   │
│  Window 3: Worker-3 (task: write tests)                           │
│  └─ ...                                                           │
└──────────────────────────────────────────────────────────────────┘
```

### Step 13.2: Agent Communication

Workers communicate with Architect via SQLite:

```sql
-- AGENT_TASKS: Track sub-agent work
CREATE TABLE agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    -- Agent info
    agent_id TEXT NOT NULL,           -- "architect" | "worker-1" | "worker-2" etc.
    agent_type TEXT NOT NULL,         -- "architect" | "worker"
    tmux_window INTEGER,

    -- Task assignment
    task_description TEXT,
    task_files TEXT,                  -- JSON array of files to work on
    task_status TEXT DEFAULT 'pending', -- "pending" | "in_progress" | "complete" | "failed"

    -- Progress
    progress_pct INTEGER DEFAULT 0,
    last_status_message TEXT,

    -- Timing
    assigned_at INTEGER DEFAULT (unixepoch()),
    started_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX idx_agent_tasks_session ON agent_tasks(session_id);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(task_status);
```

### Step 13.3: `src/lib/swarm.ts`

```typescript
// src/lib/swarm.ts
import { $ } from 'bun';
import { getDatabase } from './db';

export interface WorkerTask {
  taskId: number;
  description: string;
  files: string[];
}

export interface SwarmConfig {
  sessionId: string;
  projectItemId: string;
  planId: number;
  maxWorkers: number;
}

/**
 * Start the architect agent
 */
export async function startArchitect(config: SwarmConfig): Promise<string> {
  const db = getDatabase();

  // Create architect task record
  const result = db.run(`
    INSERT INTO agent_tasks (session_id, agent_id, agent_type, tmux_window, task_description, task_status)
    VALUES (?, 'architect', 'architect', 0, 'Orchestrate implementation', 'in_progress')
  `, [config.sessionId]);

  // Get the implementation plan
  const plan = db.query(`
    SELECT work_breakdown FROM implementation_plans WHERE id = ?
  `).get(config.planId) as { work_breakdown: string } | null;

  if (!plan?.work_breakdown) {
    throw new Error('No work breakdown found in plan');
  }

  const tasks = JSON.parse(plan.work_breakdown) as WorkerTask[];

  // Spawn workers for each task (up to maxWorkers)
  const workerCount = Math.min(tasks.length, config.maxWorkers);
  for (let i = 0; i < workerCount; i++) {
    await spawnWorker(config.sessionId, i + 1, tasks[i]);
  }

  return 'architect';
}

/**
 * Spawn a worker agent in a new tmux window
 */
export async function spawnWorker(
  sessionId: string,
  windowNum: number,
  task: WorkerTask
): Promise<string> {
  const db = getDatabase();
  const agentId = `worker-${windowNum}`;

  // Create worker task record
  db.run(`
    INSERT INTO agent_tasks (session_id, agent_id, agent_type, tmux_window, task_description, task_files, task_status)
    VALUES (?, ?, 'worker', ?, ?, ?, 'pending')
  `, [sessionId, agentId, windowNum, task.description, JSON.stringify(task.files)]);

  // Create new tmux window
  await $`tmux new-window -t claude-work:${windowNum} -n ${agentId}`;

  // Start Claude in the window with the task
  const prompt = buildWorkerPrompt(task);
  await $`tmux send-keys -t claude-work:${windowNum} "claude" Enter`;
  await Bun.sleep(2000); // Wait for REPL to start
  await $`tmux send-keys -t claude-work:${windowNum} ${JSON.stringify(prompt)} Enter`;

  // Update status
  db.run(`
    UPDATE agent_tasks SET task_status = 'in_progress', started_at = unixepoch()
    WHERE session_id = ? AND agent_id = ?
  `, [sessionId, agentId]);

  return agentId;
}

/**
 * Check worker progress
 */
export function getWorkerStatus(sessionId: string): Array<{
  agentId: string;
  status: string;
  progress: number;
  lastMessage: string;
}> {
  const db = getDatabase();

  return db.query(`
    SELECT agent_id, task_status, progress_pct, last_status_message
    FROM agent_tasks
    WHERE session_id = ? AND agent_type = 'worker'
  `).all(sessionId) as any[];
}

/**
 * Worker reports progress to architect
 */
export function reportProgress(
  sessionId: string,
  agentId: string,
  progress: number,
  message: string
): void {
  const db = getDatabase();

  db.run(`
    UPDATE agent_tasks
    SET progress_pct = ?, last_status_message = ?
    WHERE session_id = ? AND agent_id = ?
  `, [progress, message, sessionId, agentId]);
}

/**
 * Worker signals task completion
 */
export function completeTask(sessionId: string, agentId: string): void {
  const db = getDatabase();

  db.run(`
    UPDATE agent_tasks
    SET task_status = 'complete', progress_pct = 100, completed_at = unixepoch()
    WHERE session_id = ? AND agent_id = ?
  `, [sessionId, agentId]);

  // Log activity
  db.run(`
    INSERT INTO activity_log (session_id, event, details, actor)
    VALUES (?, 'worker_completed', json_object('agent_id', ?), ?)
  `, [sessionId, agentId, agentId]);
}

/**
 * Check if all workers are complete
 */
export function allWorkersComplete(sessionId: string): boolean {
  const db = getDatabase();

  const result = db.query(`
    SELECT COUNT(*) as incomplete FROM agent_tasks
    WHERE session_id = ? AND agent_type = 'worker' AND task_status != 'complete'
  `).get(sessionId) as { incomplete: number };

  return result.incomplete === 0;
}

function buildWorkerPrompt(task: WorkerTask): string {
  return `You are a worker agent. Your task:

${task.description}

Files to work on:
${task.files.map(f => `- ${f}`).join('\n')}

Instructions:
1. Focus ONLY on your assigned task
2. Do not modify files outside your scope
3. Run tests for your changes
4. When complete, call: /task-complete

Report progress periodically using: /report-progress <percentage> <message>`;
}
```

### Step 13.4: Project-Specific Agents & Skills

When Claude analyzes a new project, it creates agents/skills in the target repo:

```
target-repo/
├── .claude/
│   ├── agents/
│   │   ├── architect.md      # Project-specific architect instructions
│   │   ├── frontend-worker.md # Frontend-focused worker
│   │   ├── backend-worker.md  # Backend-focused worker
│   │   └── test-worker.md     # Test-focused worker
│   ├── skills/
│   │   ├── analyze-codebase.md
│   │   ├── implement-feature.md
│   │   └── write-tests.md
│   └── CLAUDE.md             # Project context
```

Template for project-specific architect (`templates/agents/architect.md`):

```markdown
# Architect Agent

You are the architect agent for {{PROJECT_NAME}}.

## Your Role
- Break down implementation plans into parallel tasks
- Assign tasks to worker agents based on their specialization
- Monitor worker progress
- Validate completed work before merging
- Resolve conflicts between worker outputs

## Project Context
{{PROJECT_CONTEXT}}

## Available Workers
{{WORKER_LIST}}

## Workflow
1. Read the implementation plan from `.plans/issue-{N}.md`
2. Identify parallelizable tasks
3. Spawn workers using `/spawn-worker <type> <task>`
4. Monitor with `/worker-status`
5. Validate with `/validate-work <agent-id>`
6. Merge with `/merge-work`
```

---

## Phase 14: Project Onboarding (Helm/ArgoCD)

### Overview

When onboarding a new repository, the system automatically:
1. Creates a GitHub Project from template
2. Links the repository to the project
3. Sets up custom fields and columns
4. Creates project-specific agents/skills

### Step 14.1: Helm Values for Project Setup

Add to `values.yaml`:

```yaml
projectSetup:
  enabled: true
  # GitHub token with project:write scope
  githubToken: ""  # Set via --set or sealed secret

  # Template location
  templatePath: "templates/github-project.json"

  # Default project settings
  defaultColumns:
    - Todo
    - Planning
    - In Progress
    - QA
    - Blocked
    - Review
    - Done

  # Allowed authors for PR processing
  allowedAuthors:
    - claude-code-bot
    - jaybrto

  # Agent templates to copy to new repos
  agentTemplates:
    - templates/agents/architect.md
    - templates/agents/frontend-worker.md
    - templates/agents/backend-worker.md
    - templates/agents/test-worker.md

  # Skill templates to copy
  skillTemplates:
    - templates/skills/analyze-codebase.md
    - templates/skills/implement-feature.md
    - templates/skills/write-tests.md
```

### Step 14.2: ArgoCD Sync Hook for Project Creation

Add `k8s/project-setup-job.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: gwa-project-setup
  annotations:
    argocd.argoproj.io/hook: PostSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
spec:
  template:
    spec:
      serviceAccountName: gwa-setup
      containers:
      - name: setup
        image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
        command:
        - bun
        - run
        - /home/runner/src/setup-project.ts
        env:
        - name: GITHUB_TOKEN
          valueFrom:
            secretKeyRef:
              name: gwa-secrets
              key: github-token
        - name: REPO
          value: "{{ .Values.repo }}"
        - name: TEMPLATE_PATH
          value: "{{ .Values.projectSetup.templatePath }}"
        volumeMounts:
        - name: templates
          mountPath: /templates
      volumes:
      - name: templates
        configMap:
          name: gwa-templates
      restartPolicy: OnFailure
```

### Step 14.3: `src/setup-project.ts`

```typescript
// src/setup-project.ts
import { Octokit } from '@octokit/rest';

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

interface ProjectTemplate {
  name: string;
  description: string;
  columns: Array<{ name: string; description: string }>;
  custom_fields: Array<{ name: string; type: string; default?: any }>;
}

async function main() {
  const token = process.env.GITHUB_TOKEN!;
  const repo = process.env.REPO!;
  const templatePath = process.env.TEMPLATE_PATH || '/templates/github-project.json';

  const [owner, repoName] = repo.split('/');

  console.log(`[Setup] Creating GitHub Project for ${repo}...`);

  // Load template
  const template = await Bun.file(templatePath).json() as ProjectTemplate;

  // Replace template variables
  template.name = template.name.replace('{{REPO_NAME}}', repoName);
  template.description = template.description.replace('{{REPO_NAME}}', repoName);

  // Create project
  const projectId = await createProject(owner, template, token);
  console.log(`[Setup] Created project: ${projectId}`);

  // Create columns (status field options)
  await createColumns(projectId, template.columns, token);
  console.log(`[Setup] Created columns`);

  // Create custom fields
  await createCustomFields(projectId, template.custom_fields, token);
  console.log(`[Setup] Created custom fields`);

  // Link repository to project
  await linkRepository(projectId, owner, repoName, token);
  console.log(`[Setup] Linked repository`);

  // Copy agent templates to repo
  await copyAgentTemplates(owner, repoName, token);
  console.log(`[Setup] Copied agent templates`);

  // Copy skill templates to repo
  await copySkillTemplates(owner, repoName, token);
  console.log(`[Setup] Copied skill templates`);

  console.log(`[Setup] Project setup complete!`);
}

async function createProject(owner: string, template: ProjectTemplate, token: string): Promise<string> {
  const mutation = `
    mutation($ownerId: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $ownerId, title: $title }) {
        projectV2 { id }
      }
    }
  `;

  // Get owner ID
  const ownerQuery = `
    query($login: String!) {
      user(login: $login) { id }
      organization(login: $login) { id }
    }
  `;

  const ownerResult = await graphqlRequest(ownerQuery, { login: owner }, token);
  const ownerId = ownerResult.data.organization?.id || ownerResult.data.user?.id;

  const result = await graphqlRequest(mutation, {
    ownerId,
    title: template.name
  }, token);

  return result.data.createProjectV2.projectV2.id;
}

async function createColumns(projectId: string, columns: Array<{ name: string }>, token: string): Promise<void> {
  // Get the Status field ID
  const query = `
    query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          field(name: "Status") { ... on ProjectV2SingleSelectField { id } }
        }
      }
    }
  `;

  const result = await graphqlRequest(query, { projectId }, token);
  const statusFieldId = result.data.node.field.id;

  // Add each column as a status option
  for (const column of columns) {
    const mutation = `
      mutation($fieldId: ID!, $name: String!) {
        updateProjectV2Field(input: {
          fieldId: $fieldId
          singleSelectOptions: [{ name: $name }]
        }) {
          projectV2Field { id }
        }
      }
    `;

    await graphqlRequest(mutation, { fieldId: statusFieldId, name: column.name }, token);
  }
}

async function createCustomFields(
  projectId: string,
  fields: Array<{ name: string; type: string }>,
  token: string
): Promise<void> {
  for (const field of fields) {
    const mutation = `
      mutation($projectId: ID!, $name: String!, $dataType: ProjectV2FieldType!) {
        createProjectV2Field(input: {
          projectId: $projectId
          name: $name
          dataType: $dataType
        }) {
          projectV2Field { id }
        }
      }
    `;

    const dataType = mapFieldType(field.type);
    await graphqlRequest(mutation, { projectId, name: field.name, dataType }, token);
  }
}

async function linkRepository(projectId: string, owner: string, repo: string, token: string): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $repositoryId: ID!) {
      linkProjectV2ToRepository(input: {
        projectId: $projectId
        repositoryId: $repositoryId
      }) {
        repository { id }
      }
    }
  `;

  // Get repository ID
  const repoQuery = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { id }
    }
  `;

  const repoResult = await graphqlRequest(repoQuery, { owner, name: repo }, token);
  const repositoryId = repoResult.data.repository.id;

  await graphqlRequest(mutation, { projectId, repositoryId }, token);
}

async function copyAgentTemplates(owner: string, repo: string, token: string): Promise<void> {
  const github = new Octokit({ auth: token });
  const templateDir = '/templates/agents';

  const files = await Bun.file(`${templateDir}`).exists()
    ? (await $`ls ${templateDir}`).text().split('\n').filter(Boolean)
    : [];

  for (const file of files) {
    const content = await Bun.file(`${templateDir}/${file}`).text();

    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: `.claude/agents/${file}`,
      message: 'chore: add GWA agent template',
      content: Buffer.from(content).toString('base64')
    });
  }
}

async function copySkillTemplates(owner: string, repo: string, token: string): Promise<void> {
  const github = new Octokit({ auth: token });
  const templateDir = '/templates/skills';

  const files = await Bun.file(`${templateDir}`).exists()
    ? (await $`ls ${templateDir}`).text().split('\n').filter(Boolean)
    : [];

  for (const file of files) {
    const content = await Bun.file(`${templateDir}/${file}`).text();

    await github.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: `.claude/skills/${file}`,
      message: 'chore: add GWA skill template',
      content: Buffer.from(content).toString('base64')
    });
  }
}

function mapFieldType(type: string): string {
  const mapping: Record<string, string> = {
    text: 'TEXT',
    number: 'NUMBER',
    date: 'DATE',
    checkbox: 'CHECKBOX'
  };
  return mapping[type] || 'TEXT';
}

async function graphqlRequest(query: string, variables: any, token: string): Promise<any> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  return response.json();
}

main().catch(console.error);
```

### Step 14.4: Implementation Plan Storage

Plans are stored in the repo at `.plans/issue-{NUMBER}.md`:

```markdown
# Implementation Plan: Issue #42 - Add User Authentication

**Created:** 2026-02-09
**Status:** Approved
**Plan Version:** 3
**Iterations:** 3 (questions answered)

## Summary

Implement JWT-based authentication with refresh tokens...

## Work Breakdown (for sub-agents)

### Task 1: Auth Module (Worker-1)
- Files: `src/auth/`, `src/middleware/auth.ts`
- Create JWT utilities
- Implement login/logout handlers

### Task 2: User Model (Worker-2)
- Files: `src/models/user.ts`, `src/db/migrations/`
- Add user table migration
- Create User model with password hashing

### Task 3: API Routes (Worker-3)
- Files: `src/routes/auth.ts`
- POST /auth/login
- POST /auth/logout
- POST /auth/refresh

### Task 4: Tests (Worker-4)
- Files: `tests/auth/`
- Unit tests for auth module
- Integration tests for auth routes

## Questions & Answers

**Q1:** Should we use bcrypt or argon2 for password hashing?
**A1:** Use argon2, it's more modern and memory-hard.

**Q2:** What should the JWT expiry be?
**A2:** 15 minutes for access token, 7 days for refresh token.

## Approval

- [x] Plan reviewed by human
- [x] Work breakdown is parallelizable
- [x] All questions answered
```

## v4.0 Upgrade Plan

This plan upgrades GWA from a lookup-table state machine with dual persistence (Redis + SQLite) to:

- **XState v5 state machine** at the pod level with SQLite-only persistence
- **RabbitMQ as the communication backbone** — bidirectional messaging between pods, orchestrator, and mobile app
- **Extracted orchestrator service** — centralized control plane outside repo pods
- **Live terminal streaming** via tmux pipe-pane with MinIO S3 recordings
- **Native Android app** (Kotlin/Jetpack Compose) with Termux terminal-view
- **Self-hosted push notifications** via ntfy.sh (no Firebase, no Google dependencies)
- **Complete Redis removal** — SQLite per pod, RabbitMQ for cross-service communication

### Architecture After v4.0

```
+------------------------------------------------------------------------+
|  GitHub Project Board (bto-labs)                                        |
|  Columns: Todo | Planning | In Progress | QA | Blocked | Review | Done  |
+----------+-------------------------------------------------------------+
           | projects_v2_item webhook
           v
+------------------------------+
|  Orchestrator Service        |  <-- Cloudflare tunnel (git-hooks.bto.bar)
|  (Deployment - own pod)      |
|                              |
|  * Webhook receiver          |
|  * RabbitMQ pub/sub          |
|  * REST API for mobile       |
|  * Push bridge (ntfy.sh)     |
|  * Global session view       |
|  * SQLite (aggregated state) |
+----------+-------------------+
           | RabbitMQ (commands down, events up)
           |
     +-----+-------------------------------------------+
     |                    |                             |
     v                    v                             v
+--------------------+  +--------------------+  +--------------------+
| gwa-runner-0       |  | gwa-runner-1       |  | gwa-runner-N       |
| (repo-A)           |  | (repo-B)           |  | (repo-N)           |
|                    |  |                    |  |                    |
| XState v5 machine  |  | XState v5 machine  |  | XState v5 machine  |
| SQLite (local)     |  | SQLite (local)     |  | SQLite (local)     |
| AMQP pub/sub       |  | AMQP pub/sub       |  | AMQP pub/sub       |
| Claude Code        |  | Claude Code        |  | Claude Code        |
| tmux sessions      |  | tmux sessions      |  | tmux sessions      |
| Terminal relay WS  |  | Terminal relay WS  |  | Terminal relay WS  |
+--------------------+  +--------------------+  +--------------------+
     |                    |                             |
     | AMQP 0.9.1 (events)                             |
     v                    v                             v
+------------------------------------------------------------------+
|  RabbitMQ (existing K3s cluster)                                  |
|  amq.topic exchange                                               |
|  rabbitmq_mqtt plugin   (port 1883  - native TCP for mobile)     |
|  rabbitmq_web_mqtt      (port 15675 - WSS fallback for mobile)   |
+----------+----------------------------+--------------------------+
           |                            |
           v (MQTT)                     v
+---------------------+       +---------------------+
| WARP / LAN TCP      |       | ntfy.sh (K3s)       |
| 10.43.x.x:1883     |       | Self-hosted push     |
| (8hr / unlimited)   |       | Process-stopping     |
| or WSS fallback     |       | events only          |
+----------+----------+       +----------+----------+
           |                             |
           v                             v
+------------------------------------------------------------------+
|  Native Android App (Kotlin / Jetpack Compose)                    |
|                                                                    |
|  Terminal:  Termux terminal-view (native Canvas, 200x50)          |
|  MQTT:      Paho native TCP (LAN/WARP) or WSS (fallback)         |
|  FG Svc:    Optional always-on MQTT via foreground service        |
|  BG Push:   ntfy.sh (process-stopping events only, self-hosted)  |
|  Resume:    Sync missed MQTT messages on foreground return        |
|  Relay:     OkHttp WebSocket to terminal relay (raw PTY bytes)    |
|  Recordings: Presigned MinIO S3 URLs for asciicast playback      |
|                                                                    |
|  Notification throttling: grouped + debounced per-session         |
+------------------------------------------------------------------+
```

### Message Flow

```
Commands (orchestrator --> pods):
  gwa.commands.{owner}.{repo}.transition     GitHub project column change
  gwa.commands.{owner}.{repo}.answer         User answered blocked agent
  gwa.commands.{owner}.{repo}.cancel         Cancel session

Events (pods --> orchestrator + mobile):
  gwa.events.{owner}.{repo}.{session}.state_change   XState transitions
  gwa.events.{owner}.{repo}.{session}.activity        Claude output, git ops
  gwa.events.{owner}.{repo}.{session}.blocked          Agent needs input
  gwa.events.{owner}.{repo}.{session}.error            Session failed
  gwa.events.{owner}.{repo}.{session}.complete         Session done
  gwa.events.{owner}.{repo}.{session}.terminal         Terminal snapshot event

Heartbeats (pods --> orchestrator):
  gwa.heartbeat.{owner}.{repo}               Pod alive + session summary
```

### Connectivity Model: LAN TCP --> WARP TCP --> WSS Fallback

The native Android app supports three MQTT connectivity paths (tried in order):

| Path | Transport | Idle Timeout | Requires | When Used |
|------|-----------|-------------|----------|-----------|
| **LAN (primary)** | Native TCP to `10.43.x.x:1883` | **Unlimited** (direct) | On homelab WiFi/LAN | Device on local network |
| **WARP (secondary)** | Native TCP to `10.43.x.x:1883` via WireGuard | **8 hours** (Gateway proxy) | Cloudflare One agent | Away from home, WARP active |
| **WSS (fallback)** | WebSocket to `wss://mqtt.bto.bar/ws` | **100 seconds** | Nothing extra | WARP unavailable |

The app probes the private RabbitMQ IP on startup. If reachable (LAN or WARP), it uses native MQTT TCP. Only falls back to WSS when the private IP is unreachable.

---

## Shared Types Module

**New file:** `src/shared/types.ts`

Single source of truth for enums, message schemas, and constants used across orchestrator, pods, and mobile app.

```typescript
// === Session States (XState canonical set) ===
export const SessionState = {
  TODO: 'todo',
  PLANNING: 'planning',
  IN_PROGRESS: 'inProgress',
  QA: 'qa',
  BLOCKED: 'blocked',
  REVIEW: 'review',
  DONE: 'done',
} as const;
export type SessionState = typeof SessionState[keyof typeof SessionState];

// === AMQP Event Types ===
export const EventType = {
  STATE_CHANGE: 'state_change',
  ACTIVITY: 'activity',
  BLOCKED: 'blocked',
  ERROR: 'error',
  COMPLETE: 'complete',
  TERMINAL_SNAPSHOT: 'terminal_snapshot',
  HEARTBEAT: 'heartbeat',
} as const;
export type EventType = typeof EventType[keyof typeof EventType];

// === Process-stopping events (trigger push notifications) ===
export const PUSH_WORTHY_EVENTS: EventType[] = ['blocked', 'error', 'complete'];

// === AMQP Message Envelope ===
export interface GWAMessage<T = unknown> {
  version: 1;
  messageId: string;           // UUID for dedup
  timestamp: number;           // Unix ms
  source: string;              // pod name or 'orchestrator'
  owner: string;
  repo: string;
  sessionId?: string;
  eventType: EventType;
  data: T;
}

// === Status Migration Map (legacy --> XState) ===
export const STATUS_MIGRATION: Record<string, SessionState> = {
  // Redis PRSession statuses
  active: SessionState.IN_PROGRESS,
  waiting: SessionState.BLOCKED,
  completed: SessionState.DONE,
  // Redis REPLSession statuses
  starting: SessionState.TODO,
  running: SessionState.IN_PROGRESS,
  // SQLite session statuses
  pending: SessionState.TODO,
  complete: SessionState.DONE,
  interrupted: SessionState.DONE,
  cancelled: SessionState.DONE,
  blocked: SessionState.BLOCKED,
  error: SessionState.DONE,
};
```

For the native Android app, these types are mirrored as Kotlin data classes. The JSON message schema is the contract.

---

## Research Findings -- Gotchas to Account For

### XState v5 + Bun

- **Compatibility:** No known issues. Zero-dependency pure ESM. Works with `bun build --compile`.
- **Latest version:** `xstate@5.26.0` (Feb 2026).
- **Persistence:** Use `actor.getPersistedSnapshot()` -> JSON -> SQLite. Restore via `createActor(machine, { snapshot })`.
- **Gotcha: `undefined` in snapshots.** `getPersistedSnapshot()` may return `undefined` for `output`/`error` fields. `JSON.stringify` drops these, causing restore issues. **Fix:** Use a replacer function: `JSON.stringify(snapshot, (_, v) => v === undefined ? null : v)`.
- **Gotcha: No functions/classes in context.** Functions are silently dropped by JSON serialization. Class instances lose their prototype. Keep context as plain data only.
- **Gotcha: History state bug [#5178](https://github.com/statelyai/xstate/issues/5178).** Restoring from `JSON.stringify -> JSON.parse` can break history state behavior. **Mitigation:** We use the `blocked` state's `previousState` context field instead of XState history states.
- **Gotcha: Machine version changes.** No built-in migration. **Fix:** Store a schema version alongside snapshots.

### Native Android MQTT & Terminal

- **Library: Termux `terminal-view` + `terminal-emulator`** via JitPack (`com.github.termux.termux-app:terminal-view:v0.118.0`). Battle-tested terminal renderer -- handles 200x50 natively with truecolor (24-bit ANSI). Accepts raw PTY byte streams via `InputStream`/`OutputStream` pair. Renders via direct Canvas drawing, not WebView. License: GPLv3 (fine for personal tool, not distributed).
- **MQTT client: `hannesa2/paho.mqtt.android` v3.6.4** (JitPack). Actively maintained Kotlin fork of Eclipse Paho. Built-in foreground service support via `setForegroundService(notification, id)`. **Native TCP** -- connect directly to `tcp://10.43.x.x:1883`, no WebSocket wrapping needed. MQTT 3.1.1 only.
- **Gotcha: Background MQTT.** A foreground service with persistent notification can maintain MQTT connection in background, but Android Doze mode restricts network access during deep sleep windows. OEM battery killers may still kill it. **ntfy.sh remains essential as fallback.**
- **Gotcha: Doze + partial wake lock.** `PARTIAL_WAKE_LOCK` keeps CPU alive but does NOT prevent network restrictions during deep Doze. MQTT keepalive may not fire with screen off on some devices.
- **WebSocket client: OkHttp.** Best performance for Android WebSocket, native binary frame support (`ByteString`). 10x better CPU usage than Ktor for WebSocket workloads.

### RabbitMQ MQTT

- **MQTT 5.0:** Supported since RabbitMQ 3.13, but **shared subscriptions are NOT supported**. Not an issue for our 1:1 subscriber model.
- **QoS 2:** NOT supported. Connections are terminated if QoS 2 is attempted. **Use QoS 1 everywhere.**
- **Topic mapping:** MQTT `/` -> AMQP `.`. So MQTT topic `gwa/repo/42/activity` -> AMQP routing key `gwa.repo.42.activity`. **Never use dots in MQTT topics or slashes in AMQP routing keys.**
- **Retained messages:** Node-local only (not replicated across cluster), wildcards don't match retained messages. **Fetch initial state via REST API instead.**
- **Per-subscriber queues:** Each MQTT client gets dedicated queues named `mqtt-subscription-<clientID>qos[0|1]`. Single QoS level = single queue = guaranteed FIFO ordering.
- **Session persistence:** With `Clean Session = false`, queued messages survive client disconnects. Session expiry default is 1 day.

### Cloudflare WARP + Private Network Routing (Primary Path)

- **8-hour idle timeout.** When the mobile device connects via WARP to a private IP behind `cloudflared`, traffic flows through the Gateway proxy as raw TCP (Layer 4). The Gateway proxy's idle timeout is **8 hours**, not 100 seconds.
- **Architecture:** Device -> WARP (WireGuard) -> Cloudflare Edge -> Gateway Proxy -> `cloudflared` -> `rawTCPService` -> RabbitMQ:1883.
- **Split tunnel configuration required.** Must explicitly include the K3s pod CIDR (e.g., `10.43.0.0/16`) in Split Tunnel Include mode.
- **Gotcha: WARP on Android background.** Android may kill the WARP VPN process in background. Mitigations: Always-on VPN + battery optimization whitelist. **Still need push notifications as fallback.**
- **Zero Trust free tier.** Supports up to 50 users, sufficient for personal use.

### Cloudflare Tunnel + MQTT/WebSocket (Fallback Path)

- **100-second idle timeout.** Non-configurable on non-Enterprise plans. MQTT keepalive must be < 100 seconds. **Use 60-second keepalive.**
- **Periodic infrastructure restarts.** Cloudflare deploys cause connection drops. **Must implement reconnection with exponential backoff.**
- **Tunnel type must be HTTP** (not TCP) for WebSocket proxying.

### SQLite Concurrent Writes (Bun)

- **Single writer at a time** even in WAL mode. Additional writers wait on busy_timeout.
- **Gotcha: `bun:sqlite` defaults busy_timeout to 0** (instant SQLITE_BUSY failure). Must explicitly set to 5000ms.
- **Gotcha: Must use `BEGIN IMMEDIATE`** for write transactions.
- **Gotcha: `bun:sqlite` is synchronous.** A blocked write halts the Bun event loop. Keep write transactions short.
- **Publishing from Bun:** Use `amqplib` 0.10.7+ for AMQP publishing. Known Bun compatibility issue with large messages ([#5627](https://github.com/oven-sh/bun/issues/5627)) -- our payloads are small JSON, so this is fine.

### ntfy.sh (Self-Hosted Push Notifications)

- **Self-hosted on K3s** via Helm chart or simple Deployment. No Google Play Services required.
- **Server-side:** Simple HTTP POST to `https://ntfy.bto.bar/gwa-alerts` with JSON body.
- **Android client:** ntfy library handles background delivery, notification channels, and deep links.
- **Advantages over Firebase:** Fully self-hosted, no Google account, no service account keys, no SDK complexity.
- **Gotcha:** ntfy Android app must be installed as the push distributor (or use the ntfy library directly in our app).

### MinIO S3 (Asciicast Recordings)

- **Existing MinIO cluster** eliminates Longhorn PVC stress for large binary blobs.
- **S3-compatible API** with presigned URLs for mobile app access.
- **Lifecycle policies** for auto-cleanup (compress after 7 days, delete after 30).
- **Bucket:** `gwa-recordings` with prefix `{owner}/{repo}/{session}/`.

---

## Phase 15: v4.0 Prerequisites

### 15.1 Configure RabbitMQ (Already in K3s)

RabbitMQ is already deployed in the K3s cluster. Enable required plugins and verify:

```bash
rabbitmq-plugins enable rabbitmq_mqtt          # Native MQTT on port 1883
rabbitmq-plugins enable rabbitmq_web_mqtt      # MQTT over WebSocket on port 15675
rabbitmq-plugins enable rabbitmq_management    # Management API on port 15672
```

Verify MQTT connectivity from within the cluster:
```bash
kubectl exec -it rabbitmq-0 -- rabbitmqctl list_connections
```

### 15.2 Deploy ntfy.sh

Deploy self-hosted ntfy.sh for push notifications:

```yaml
# ntfy Deployment on K3s
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ntfy
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: ntfy
        image: binwiederhier/ntfy:latest
        args: ["serve", "--cache-file=/var/cache/ntfy/cache.db"]
        ports:
        - containerPort: 80
```

Add Cloudflare tunnel route: `ntfy.bto.bar` -> `ntfy.default.svc.cluster.local:80`

### 15.3 Verify ansi-to-svg Bun Compatibility

```bash
bun add ansi-to-svg
bun -e "const a2s = require('ansi-to-svg'); console.log(typeof a2s)"
```

Fallback: use `ansi-to-html` (actively maintained) + wrap in SVG `<foreignObject>`.

### 15.4 Create MinIO Bucket

```bash
mc mb minio/gwa-recordings
mc ilm add minio/gwa-recordings --transition-days 7 --storage-class REDUCED_REDUNDANCY
mc ilm add minio/gwa-recordings --expiry-days 30
```

---

## Phase 16: Security Hardening

### 16.1 Fix Webhook Signature Verification

**File:** `src/webhook/handler.ts`

Changes:
- Import `timingSafeEqual` from `crypto`
- Change `verifySignature()` to return `false` when `WEBHOOK_SECRET` is empty (fail closed)
- Replace `===` string comparison with `timingSafeEqual` for the HMAC check
- Add length check before `timingSafeEqual` (mismatched lengths throw)

### 16.2 Add Webhook Delivery Deduplication

Use in-memory `Map<string, number>` with a 1-hour TTL for deduplication. GitHub retries happen within minutes, not hours. Migrate to SQLite if we need cross-restart deduplication later.

**File changes:**
- `src/webhook/handler.ts`: Check delivery map before processing. Insert delivery ID after processing.

---

## Phase 17: XState State Machine

XState runs **inside each runner pod**, not in the webhook/orchestrator. The orchestrator publishes transition commands via RabbitMQ; the pod validates via XState before executing.

### 17.1 Install XState

```bash
bun add xstate@^5.26.0
```

### 17.2 Create State Machine Definition

**New file:** `src/lib/state-machine.ts`

**States:** `todo`, `planning`, `inProgress`, `qa`, `blocked`, `review`, `done`

**Context (plain data only):**
```typescript
interface GWAContext {
  sessionId: string | null;
  issueNumber: number;
  repo: string;
  owner: string;
  itemNodeId: string;
  contentNodeId: string;
  previousState: string | null;  // For blocked->resume transitions
  hasPlan: boolean;
  hasTests: boolean;
  testsPassed: boolean;
  schemaVersion: number;  // For snapshot migration
}
```

**Events (mapped from GitHub Project column transitions):**
```typescript
type GWAEvent =
  | { type: 'START_PLANNING' }
  | { type: 'QUICK_START' }
  | { type: 'PLAN_APPROVED' }
  | { type: 'IMPL_COMPLETE' }
  | { type: 'TESTS_PASSED' }
  | { type: 'TESTS_FAILED' }
  | { type: 'APPROVED' }
  | { type: 'REQUEST_CHANGES' }
  | { type: 'RETEST' }
  | { type: 'REPLAN' }
  | { type: 'BLOCK' }
  | { type: 'ANSWER_RECEIVED'; previousState: string }
  | { type: 'CANCEL' }
  | { type: 'CLOSE' }
  | { type: 'REOPEN' }
  | { type: 'SKIP_QA' }
  | { type: 'SKIP_IMPL' };
```

**Guards:**
```typescript
const guards = {
  hasNoActiveSession: ({ context }) => context.sessionId === null,
  planExists: ({ context }) => context.hasPlan,
  previousWasPlanning: ({ context }) => context.previousState === 'planning',
  previousWasInProgress: ({ context }) => context.previousState === 'inProgress',
  previousWasQA: ({ context }) => context.previousState === 'qa',
  previousWasReview: ({ context }) => context.previousState === 'review',
};
```

**Column-to-event mapping function:**
```typescript
function columnTransitionToEvent(from: string, to: string): GWAEvent | null
```

### 17.3 State Persistence in SQLite

**Schema addition:**
```sql
ALTER TABLE sessions ADD COLUMN xstate_snapshot TEXT;
ALTER TABLE sessions ADD COLUMN xstate_schema_version INTEGER DEFAULT 1;
```

**Persistence pattern:**
```typescript
// Save after every transition
const snapshot = actor.getPersistedSnapshot();
const json = JSON.stringify(snapshot, (_, v) => v === undefined ? null : v);
db.run('UPDATE sessions SET xstate_snapshot = ?, xstate_schema_version = ? WHERE id = ?',
  [json, SCHEMA_VERSION, sessionId]);

// Restore
const row = db.query('SELECT xstate_snapshot FROM sessions WHERE id = ?').get(sessionId);
const snapshot = row?.xstate_snapshot ? JSON.parse(row.xstate_snapshot) : undefined;
const actor = createActor(gwaMachine, { snapshot });
actor.start();
```

### 17.4 Integration with Orchestrator via RabbitMQ

The orchestrator publishes transition commands to `gwa.commands.{owner}.{repo}.transition`. Each pod subscribes to its own repo topic. On receiving a command:

1. Load XState actor from SQLite snapshot
2. Map column transition to XState event via `columnTransitionToEvent()`
3. Send event to actor -- XState validates the transition
4. If valid: persist snapshot, execute handler, publish state_change event
5. If invalid: publish error event, post GitHub comment explaining the invalid transition

This replaces the current `workflow_dispatch` -> GitHub Actions -> `kubectl exec` chain with direct RabbitMQ messaging.

### 17.5 Integrate with Transition Handlers

Each `src/transitions/*.ts` handler:
1. Loads the XState actor from SQLite snapshot
2. Verifies current state matches expected (defense in depth)
3. Performs its work (create session, run tests, etc.)
4. Updates context (e.g., `hasPlan = true` after planning completes)
5. Persists updated snapshot
6. Publishes state_change event to RabbitMQ

### 17.6 State Machine Tests

**New file:** `src/tests/state-machine.test.ts`

Test categories:
- Every valid forward transition (Todo->Planning->InProgress->QA->Review->Done)
- Every valid backward transition (Review->InProgress, QA->Planning, etc.)
- Every blocked->resume path (maintains previousState correctly)
- Every guard (planExists prevents premature advancement)
- Invalid transitions throw/reject
- Snapshot serialization round-trip (save -> restore -> same state)
- Schema version migration (future-proofing)

---

## Phase 18: Remove Redis

Redis is embedded in **21 files** across the codebase. This phase removes ALL Redis references and consolidates on SQLite (local) + RabbitMQ (cross-service).

### 18.1 Source File Migrations

| File | Action |
|------|--------|
| `src/lib/redis.ts` | **DELETE** (190 lines, 12 functions) |
| `src/lib/repl-session.ts` | **REWRITE** -- migrate all 6 `getRedisClient()` calls to SQLite. Store REPL session state in `sessions` table (extend with `repl_session_id`, `repl_status` fields) |
| `src/orchestrate.ts` | **REWRITE** -- replace all 8 Redis calls (`getSession`, `createSession`, `updateSessionStatus`, `closeRedis`) with SQLite equivalents from `db.ts` |
| `src/health-check.ts` | **UPDATE** -- remove Redis health check, add SQLite health check (`PRAGMA integrity_check`) |
| `src/debug-redis.ts` | **DELETE** and replace with `src/debug-db.ts` that queries SQLite |
| `src/lib/telemetry.ts` | **UPDATE** -- remove `IORedisInstrumentation`, remove `Metrics.recordRedisOperation()` |
| `src/lib/types.ts` | **UPDATE** -- remove `PRSession` and `PRQuestion` Redis types, use canonical `SessionState` enum |

### 18.2 Test Migrations

| File | Action |
|------|--------|
| `src/tests/imports.test.ts` | Remove `redis.getRedisClient` and `redis.closeRedis` export checks |
| `src/tests/preflight.test.ts` | Remove `ioredis` dependency assertion, add `xstate`/`amqplib` assertions |
| `tests/helm-chart.test.ts` | Remove `REDIS_HOST`/`REDIS_PORT` assertions, add `RABBITMQ_URL` assertion |

### 18.3 Infrastructure Migrations

| File | Action |
|------|--------|
| `helm/gwa-runner/values.yaml` | Remove `redis` section, add `rabbitmq.url`, `ntfy.url`, `minio.endpoint` |
| `helm/gwa-runner/templates/configmap.yaml` | Replace `redis-cli SET` pod registration with `sqlite3` insert. Replace tmux status window `redis-cli SMEMBERS` with `sqlite3` query |
| `helm/gwa-runner/templates/statefulset.yaml` | Remove `REDIS_HOST`/`REDIS_PORT` env vars, add `RABBITMQ_URL` |
| `helm/gwa-runner/templates/cronjob-cleanup.yaml` | Remove Redis env vars |
| `k8s/gwa-runner-statefulset.yaml` | Remove Redis env vars, add `RABBITMQ_URL` |
| `k8s/gwa-cleanup-cronjob.yaml` | Remove Redis env vars |

### 18.4 Package Cleanup

| File | Action |
|------|--------|
| `package.json` | Remove `ioredis`, remove `@opentelemetry/instrumentation-ioredis`, remove `build:debug-redis` script |

### 18.5 Create SQLite Active Sessions View

```sql
CREATE VIEW active_sessions AS
SELECT * FROM sessions
WHERE status NOT IN ('done', 'error', 'cancelled')
ORDER BY last_activity_at DESC;
```

### 18.6 Ensure SQLite Write Safety

- Verify `busy_timeout = 5000` is set on every `getDatabase()` call (already done in `configurePragmas`)
- Verify write transactions use `BEGIN IMMEDIATE`
- Add retry logic for `SQLITE_BUSY` in critical paths

---

## Phase 19: RabbitMQ Backbone + Orchestrator Extraction

### 19.1 Install Dependencies

```bash
bun add amqplib@^0.10.7
bun add -d @types/amqplib
```

### 19.2 Create AMQP Publisher Module (Pod Side)

**New file:** `src/lib/amqp.ts`

```typescript
export interface ActivityEvent {
  sessionId: string;
  issueNumber: number;
  repo: string;
  owner: string;
  eventType: EventType;
  data: Record<string, unknown>;
  timestamp: number;
}

export async function publishEvent(event: ActivityEvent): Promise<void>;
export async function subscribeCommands(handler: CommandHandler): Promise<void>;
export async function getPublisher(): Promise<AMQPPublisher>;
export async function closePublisher(): Promise<void>;
```

Design:
- Singleton AMQP connection with auto-reconnect
- **Publish** to `amq.topic` exchange with routing key `gwa.events.{owner}.{repo}.{session}.{eventType}`
- **Subscribe** to `gwa.commands.{owner}.{repo}.#` for incoming commands from orchestrator
- Use publisher confirms for reliability
- Non-blocking: publish failures log a warning but don't fail the handler
- Environment: `RABBITMQ_URL` (default: `amqp://rabbitmq.default.svc.cluster.local`)

### 19.3 Integrate with Activity Logging

**File:** `src/lib/db.ts`

Modify `logActivity()` to also publish to AMQP:
```typescript
export function logActivity(sessionId: string, eventType: string, data: object, actor: string) {
  // Existing SQLite insert...

  // Also publish to AMQP (fire-and-forget, non-blocking)
  publishEvent({
    sessionId,
    issueNumber: /* from session lookup */,
    repo: /* from session lookup */,
    owner: /* from session lookup */,
    eventType,
    data: { ...data, actor },
    timestamp: Date.now(),
  }).catch(err => console.warn('[AMQP] Publish failed:', err.message));
}
```

### 19.4 Publish XState Transitions

After every state machine transition, publish a `state_change` event:
```typescript
actor.subscribe((snapshot) => {
  publishEvent({
    sessionId: context.sessionId,
    issueNumber: context.issueNumber,
    repo: context.repo,
    owner: context.owner,
    eventType: 'state_change',
    data: { state: snapshot.value, context: snapshot.context },
    timestamp: Date.now(),
  });
});
```

### 19.5 Extract Orchestrator Service

**New directory:** `src/orchestrator/`

The orchestrator is a **separate Deployment** (not in any repo pod). It handles:

```
src/orchestrator/
  index.ts              # Main entry point (Bun.serve + AMQP setup)
  webhook-handler.ts    # GitHub webhook receiver (moved from src/webhook/)
  session-aggregator.ts # Subscribes to all pod events, maintains global view
  rest-api.ts           # REST API for mobile app
  push-bridge.ts        # ntfy.sh push for process-stopping events
  db.ts                 # Orchestrator's own SQLite (aggregated state)
```

**Orchestrator responsibilities:**
1. **Receive GitHub webhooks** -> map column transition -> publish to `gwa.commands.{owner}.{repo}.transition`
2. **Subscribe to `gwa.events.#`** -> update aggregated session view in local SQLite
3. **REST API** for mobile app (session list, answer questions, snapshots)
4. **Push bridge** -> subscribe to process-stopping MQTT topics -> push via ntfy.sh
5. **Heartbeat monitor** -> detect dead pods, surface in mobile app

**K8s Deployment:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gwa-orchestrator
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: orchestrator
        image: ghcr.io/jaybrto/gwa-orchestrator:latest
        ports:
        - containerPort: 3000  # Webhook + REST API
        env:
        - name: RABBITMQ_URL
          value: "amqp://rabbitmq.default.svc.cluster.local:5672"
        - name: NTFY_URL
          value: "http://ntfy.default.svc.cluster.local:80"
        - name: MINIO_ENDPOINT
          value: "http://minio.default.svc.cluster.local:9000"
```

### 19.6 Push Notification Bridge (ntfy.sh)

**Part of orchestrator:** `src/orchestrator/push-bridge.ts`

Subscribes to process-stopping MQTT topics and pushes via ntfy.sh:

**Subscribed topics (process-stopping events only):**
- `gwa/+/+/+/blocked` -- Agent asked a question, session paused until answered
- `gwa/+/+/+/error` -- Unrecoverable error, session halted
- `gwa/+/+/+/complete` -- Session finished, final result ready

**Push via ntfy.sh:**
```typescript
async function pushNotification(event: GWAMessage): Promise<void> {
  await fetch(`${NTFY_URL}/gwa-alerts`, {
    method: 'POST',
    headers: {
      'Title': `#${event.data.issueNumber}: ${event.eventType}`,
      'Priority': event.eventType === 'blocked' ? 'high' : 'default',
      'Tags': event.eventType === 'error' ? 'warning' : 'white_check_mark',
      'Click': `gwa://session/${event.sessionId}`,
    },
    body: event.data.message || `Session ${event.eventType}`,
  });
}
```

**Throttling strategy:**

1. **Per-session debounce (30 seconds).** Multiple events from the same session within 30s are collapsed into one notification.
2. **Global rate limit (max 5 notifications per minute).** Excess queued for next window.
3. **Per-session cooldown (5 minutes).** Prevents repeated error events from same session spamming.
4. **Batch delivery for queued notifications.** When app returns to foreground and syncs MQTT, those messages are NOT re-pushed.

```typescript
interface ThrottleState {
  lastNotificationAt: Map<string, number>;  // sessionId -> timestamp
  windowCount: number;
  windowStart: number;
  pendingQueue: PushMessage[];
}
```

### 19.7 REST API (Part of Orchestrator)

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/sessions` | GET | Bearer token | List active sessions (all pods) |
| `/api/sessions/:id` | GET | Bearer token | Session detail + XState state |
| `/api/sessions/:id/answer` | POST | Bearer token | Answer a blocked session (publishes to RabbitMQ) |
| `/api/sessions/:id/snapshot` | GET | Bearer token | Latest terminal snapshot |
| `/api/sessions/:id/recordings` | GET | Bearer token | List asciicast recordings (presigned MinIO URLs) |
| `/api/push-tokens` | POST | Bearer token | Register ntfy topic/device |
| `/health` | GET | None | Health check |

**Auth:** Simple bearer token (shared secret). Can upgrade to GitHub OAuth later.

### 19.8 K8s & Network Configuration

**Cloudflare Tunnel -- WSS fallback route:**
```yaml
- hostname: mqtt.bto.bar
  service: http://rabbitmq.default.svc.cluster.local:15675
  originRequest:
    connectTimeout: 30s
    tcpKeepAlive: 30s
```

**Cloudflare Tunnel -- Private network route (WARP primary path):**
```bash
cloudflared tunnel route ip add 10.43.0.0/16 <tunnel-id>
```

**Zero Trust Dashboard:**
1. Split Tunnels Include: `10.43.0.0/16`
2. Gateway Network Policy: Allow TCP to RabbitMQ ports (1883, 15672)
3. Device enrollment: Add mobile device to Zero Trust organization

**RabbitMQ plugins:**
```bash
rabbitmq-plugins enable rabbitmq_mqtt         # Port 1883 (WARP path)
rabbitmq-plugins enable rabbitmq_web_mqtt     # Port 15675 (WSS fallback)
```

---

## Phase 20: Live Terminal Streaming & Snapshots

### Design Principles

1. **Stream raw PTY bytes, not parsed output.** Immune to Claude Code platform changes.
2. **Single Bun process multiplexes all sessions.** No per-session daemons.
3. **Mid-stream join via snapshot + stream.** New viewers get current screen state instantly.
4. **Dual-write: live stream + asciicast recording.** Recordings uploaded to MinIO S3.
5. **Snapshots at lifecycle events.** Stored as SVG in SQLite + published via AMQP.

### 20.1 Terminal Relay Service

**New file:** `src/lib/terminal-relay.ts`

A single Bun process that manages all active tmux pane streams:

```typescript
interface PaneStream {
  sessionId: string;
  tmuxTarget: string;      // e.g., "gwa-work:3"
  fifoPath: string;        // /tmp/pane-pr-{N}.fifo
  recordingPath: string;   // /tmp/recordings/pr-{N}.cast (temp, uploaded to MinIO)
  recordingFile: BunFile;
  startedAt: number;
}

export function startPaneStream(sessionId: string, tmuxTarget: string): Promise<void>;
export function stopPaneStream(sessionId: string): Promise<void>;
export function getActivePanes(): PaneStream[];
```

**Starting a stream:**
1. Create named FIFO: `mkfifo /tmp/pane-pr-{N}.fifo`
2. Attach pipe-pane: `tmux pipe-pane -O -t gwa-work:{window} 'cat > /tmp/pane-pr-{N}.fifo'`
3. Open FIFO for reading (non-blocking via Bun file I/O)
4. Open asciicast v2 recording file (append mode)
5. Write asciicast header: `{"version": 2, "width": 200, "height": 50, "timestamp": ...}`
6. Begin read loop: for each chunk from FIFO, publish to WebSocket topic + append to recording

**Stopping a stream:**
1. Detach pipe-pane: `tmux pipe-pane -t gwa-work:{window}` (no command = stop piping)
2. Close FIFO and recording file
3. Take a final snapshot (capture-pane)
4. Upload recording to MinIO S3: `gwa-recordings/{owner}/{repo}/{session}/{timestamp}.cast`
5. Publish `terminal_snapshot` event to AMQP

### 20.2 WebSocket Server (Multiplexed)

```typescript
Bun.serve({
  port: 8080,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/stream/')) {
      const sessionId = url.pathname.split('/')[2];
      server.upgrade(req, { data: { sessionId } });
      return;
    }

    if (url.pathname === '/panes') {
      return Response.json(getActivePanes());
    }

    if (url.pathname.startsWith('/snapshot/')) {
      const sessionId = url.pathname.split('/')[2];
      const ansi = await capturePane(sessionId);
      return new Response(ansi, { headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname.startsWith('/snapshot-svg/')) {
      const sessionId = url.pathname.split('/')[2];
      const svg = await capturePaneSvg(sessionId);
      return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
    }

    return new Response('Not found', { status: 404 });
  },
  websocket: {
    open(ws) {
      const { sessionId } = ws.data;
      ws.subscribe(`pane:${sessionId}`);
      // Mid-stream join: send current screen state
      capturePane(sessionId).then(snapshot => {
        ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
      });
    },
    close(ws) {
      ws.unsubscribe(`pane:${ws.data.sessionId}`);
    },
  },
});
```

### 20.3 Snapshot Capture at Lifecycle Events

| Event | Trigger | What's Captured |
|-------|---------|-----------------|
| Session start | `todo -> planning` or `todo -> inProgress` | Initial terminal state |
| State transition | Any state change | Current screen (text only) |
| Blocked (question) | `* -> blocked` | Full screen + scrollback (last 200 lines) |
| Error | Error detected by Claude | Full screen + scrollback (last 500 lines) |
| Completion | `review -> done` | Full screen + scrollback (last 200 lines) |
| Crash | Process exit with non-zero code | Full screen + entire scrollback |

```typescript
async function takeSnapshot(sessionId: string, event: string): Promise<void> {
  const tmuxTarget = getTargetForSession(sessionId);

  // Capture with ANSI codes preserved (-e) and scrollback
  const ansiText = await execTmux([
    'capture-pane', '-e', '-p', '-S', '-500', '-t', tmuxTarget
  ]);

  // Convert to SVG
  const svg = ansiToSvg(ansiText, { paddingTop: 10, paddingLeft: 10, colors: 'monokai' });

  // Store in SQLite
  db.run(
    `INSERT INTO terminal_snapshots (session_id, event, ansi_text, svg, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, event, ansiText, svg, Date.now()]
  );

  // Publish snapshot event via AMQP
  publishEvent({ sessionId, eventType: 'terminal_snapshot', data: { event }, timestamp: Date.now() });
}
```

**Schema addition:**
```sql
CREATE TABLE IF NOT EXISTS terminal_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ansi_text TEXT NOT NULL,
  svg TEXT,
  captured_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_snapshots_session ON terminal_snapshots(session_id, captured_at);
```

### 20.4 Asciicast v2 Recordings on MinIO S3

Every session is automatically recorded in asciicast v2 format (NDJSON, append-only).

**Temporary local path:** `/tmp/recordings/pr-{N}-{timestamp}.cast`
**Final S3 path:** `s3://gwa-recordings/{owner}/{repo}/{session}/{timestamp}.cast`

**Upload on session completion:**
```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

async function uploadRecording(localPath: string, s3Key: string): Promise<void> {
  const client = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY!,
      secretAccessKey: process.env.MINIO_SECRET_KEY!,
    },
    forcePathStyle: true,
  });
  const body = Bun.file(localPath).stream();
  await client.send(new PutObjectCommand({
    Bucket: 'gwa-recordings',
    Key: s3Key,
    Body: body,
    ContentType: 'application/x-asciicast',
  }));
}
```

**Size estimates:**
| Session Type | Duration | Size (uncompressed) | Size (zstd) |
|---|---|---|---|
| Quick fix | 15 min | 1-3 MB | 150-450 KB |
| Feature implementation | 1 hour | 5-10 MB | 750 KB - 1.5 MB |
| Large refactor | 3 hours | 15-30 MB | 2-4.5 MB |

**Cleanup policy:** MinIO lifecycle: compress after 7 days, delete after 30 days.

### 20.5 Mobile Viewer Integration

Live terminal streaming and recording playback are handled by the native Android app (Phase 21.4 and 21.7):

**Live streaming:** OkHttp WebSocket to `ws://10.43.x.x:8080/stream/{sessionId}` -> Termux TerminalView
**Recording playback:** Presigned MinIO S3 URL -> asciinema-player in WebView
**Snapshots:** SVG rendered from REST API endpoint on orchestrator

---

## Phase 21: Native Android Mobile App

### 21.1 Project Setup

Create in Android Studio with Compose template:

**Package:** `bar.bto.gwa`
**Min SDK:** 26 (Android 8.0)
**Target SDK:** 35
**Build:** Gradle + Kotlin DSL

**Key dependencies (`build.gradle.kts`):**
```kotlin
dependencies {
    // Terminal
    implementation("com.github.termux.termux-app:terminal-view:v0.118.0")
    implementation("com.github.termux.termux-app:terminal-emulator:v0.118.0")

    // MQTT
    implementation("com.github.hannesa2:paho.mqtt.android:3.6.4")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")  // WebSocket for terminal relay
    implementation("com.squareup.retrofit2:retrofit:2.9.0") // REST API calls

    // ntfy (push notifications - no Firebase needed)
    // ntfy uses UnifiedPush or direct subscription - no SDK dependency

    // Compose
    implementation(platform("androidx.compose:compose-bom:2025.01.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.navigation:navigation-compose:2.8.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}

repositories {
    maven("https://jitpack.io")  // For Termux + Paho
}
```

### 21.2 App Structure

```
gwa-android/
  app/src/main/
    java/bar/bto/gwa/
      GwaApplication.kt              # Application class (MQTT init)
      MainActivity.kt                # Single activity (Compose NavHost)

      data/
        mqtt/
          MqttManager.kt             # Connection manager (TCP primary, WSS fallback)
          MqttForegroundService.kt   # Optional always-on MQTT service
          TransportDetector.kt       # LAN/WARP/WSS probe logic
        terminal/
          TerminalRelayClient.kt     # OkHttp WebSocket to relay server
          TerminalSessionBridge.kt   # Pipes WebSocket bytes -> TerminalSession InputStream
        api/
          GwaApi.kt                  # Retrofit interface for REST API
          SessionRepository.kt       # Sessions data layer
        push/
          NtfyReceiver.kt           # Handles ntfy push notifications

      ui/
        navigation/
          NavGraph.kt               # Compose navigation graph
        sessions/
          SessionListScreen.kt      # Session list with state indicators
          SessionListViewModel.kt
          SessionCard.kt
        detail/
          SessionDetailScreen.kt    # Activity feed + state + answer
          SessionDetailViewModel.kt
          ActivityFeed.kt
          AnswerDialog.kt
        terminal/
          TerminalScreen.kt         # Termux TerminalView in AndroidView
          TerminalViewModel.kt      # Manages WebSocket + TerminalSession
          RecordingScreen.kt        # Asciicast playback (WebView, presigned MinIO URL)
        settings/
          SettingsScreen.kt         # Broker config, transport status, battery guide
        components/
          StateIndicator.kt         # Color-coded XState state chip
          SnapshotViewer.kt         # SVG/ANSI snapshot display

      util/
        NotificationHelper.kt      # Channel creation, notification building
        BatteryOptimization.kt     # Detect + prompt for whitelisting

    res/ ...
    AndroidManifest.xml
  build.gradle.kts
```

### 21.3 MQTT Connection Manager (Native TCP Primary)

```kotlin
class MqttManager(
    private val context: Context,
    private val transportDetector: TransportDetector,
) {
    private var client: MqttAndroidClient? = null
    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    sealed class ConnectionState {
        object Disconnected : ConnectionState()
        data class Connected(val transport: Transport) : ConnectionState()
        data class Reconnecting(val attempt: Int) : ConnectionState()
    }

    enum class Transport { LAN_TCP, WARP_TCP, WSS }

    suspend fun connect() {
        val transport = transportDetector.detect()
        val (brokerUrl, keepalive) = when (transport) {
            Transport.LAN_TCP  -> "tcp://10.43.X.X:1883" to 300
            Transport.WARP_TCP -> "tcp://10.43.X.X:1883" to 300
            Transport.WSS      -> "wss://mqtt.bto.bar/ws" to 60
        }

        client = MqttAndroidClient(context, brokerUrl, "gwa-android-${deviceId}").apply {
            if (transport != Transport.WSS) {
                setForegroundService(buildMqttNotification(), MQTT_NOTIFICATION_ID)
            }
        }

        val options = MqttConnectOptions().apply {
            isCleanSession = false
            keepAliveInterval = keepalive
            isAutomaticReconnect = true
            connectionTimeout = 10
        }

        client?.connect(options)
        _connectionState.value = ConnectionState.Connected(transport)
    }
}
```

### 21.4 Live Terminal Viewer (Termux TerminalView)

```kotlin
@Composable
fun TerminalScreen(sessionId: String, viewModel: TerminalViewModel = viewModel()) {
    val terminalSession = viewModel.terminalSession

    AndroidView(
        factory = { context ->
            TerminalView(context, null).apply {
                setTextSize(24)
                attachSession(terminalSession)
                setOnKeyListener { _, _, _ -> true }  // Read-only
            }
        },
        modifier = Modifier.fillMaxSize()
    )

    LaunchedEffect(sessionId) {
        viewModel.connectToRelay(sessionId)
    }
}

class TerminalViewModel : ViewModel() {
    private val okHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val pipedOutput = PipedOutputStream()
    private val pipedInput = PipedInputStream(pipedOutput, 65536)

    val terminalSession = TerminalSession(
        /* processId */ -1,
        /* fd */ pipedInput.fd,
        /* transcript rows */ 5000,
        /* columns */ 200,
        /* rows */ 50,
        /* client */ terminalClient
    )

    fun connectToRelay(sessionId: String) {
        val relayUrl = "ws://10.43.X.X:8080/stream/$sessionId"
        val request = Request.Builder().url(relayUrl).build()

        okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                pipedOutput.write(bytes.toByteArray())
                pipedOutput.flush()
            }
            override fun onMessage(ws: WebSocket, text: String) {
                val msg = JSONObject(text)
                if (msg.getString("type") == "snapshot") {
                    pipedOutput.write(msg.getString("data").toByteArray())
                    pipedOutput.flush()
                }
            }
        })
    }
}
```

### 21.5 Push Notifications (ntfy.sh)

The Android app subscribes to the ntfy topic `gwa-alerts` on `ntfy.bto.bar`. Two approaches:

**Option A: Install ntfy Android app** (simplest) -- acts as UnifiedPush distributor.

**Option B: Direct HTTP polling** (no extra app):
```kotlin
class NtfyReceiver(private val ntfyUrl: String = "https://ntfy.bto.bar") {
    // Long-poll ntfy topic for notifications
    suspend fun subscribe(topic: String, onMessage: (NtfyMessage) -> Unit) {
        val client = OkHttpClient.Builder()
            .readTimeout(90, TimeUnit.SECONDS)
            .build()
        while (true) {
            val request = Request.Builder()
                .url("$ntfyUrl/$topic/json?poll=1&since=all")
                .build()
            // ... handle messages, build notifications
        }
    }
}
```

**Notification channels (created in `GwaApplication.onCreate()`):**
```kotlin
NotificationChannel("gwa-action-required", "Action Required", IMPORTANCE_HIGH).apply {
    vibrationPattern = longArrayOf(0, 250, 250, 250)
    setGroup("gwa-alerts")
}
NotificationChannel("gwa-completions", "Completions", IMPORTANCE_DEFAULT).apply {
    setGroup("gwa-alerts")
}
```

### 21.6 Notification Strategy

**Process-stopping events only:** `blocked`, `error`, `complete`. Everything else syncs via MQTT on foreground return.

**Throttling:** Handled server-side by the push bridge in the orchestrator (Phase 19.6).

**Foreground/background lifecycle:**
```kotlin
class AppLifecycleObserver(
    private val mqttManager: MqttManager,
    private val sessionRepo: SessionRepository,
) : DefaultLifecycleObserver {

    override fun onStart(owner: LifecycleOwner) {
        // App came to foreground
        CoroutineScope(Dispatchers.IO).launch {
            sessionRepo.syncFromApi()  // REST safety net
        }
        mqttManager.reconnectWithTransportDetection()
    }

    override fun onStop(owner: LifecycleOwner) {
        // If always-on mode: MQTT stays via foreground service
        // Otherwise: MQTT disconnects, ntfy handles critical notifications
    }
}
```

### 21.7 Recording Playback

Asciicast recordings served via presigned MinIO S3 URLs. WebView with asciinema-player for non-interactive playback:

```kotlin
@Composable
fun RecordingScreen(recordingUrl: String) {
    AndroidView(factory = { context ->
        WebView(context).apply {
            settings.javaScriptEnabled = true
            loadDataWithBaseURL(null, asciinemaPlayerHtml(recordingUrl), "text/html", "UTF-8", null)
        }
    })
}
```

### 21.8 Settings Screen

- **Transport status:** Shows current connection (LAN TCP / WARP TCP / WSS) with latency
- **Always-on MQTT:** Toggle for foreground service
- **Battery optimization:** Detect if app is battery-optimized -> prompt user to whitelist
- **WARP status:** Check if Cloudflare One agent is installed and connected
- **Broker config:** Override private IP, port, WSS URL (for testing)
- **ntfy config:** Topic name, server URL

---

## Phase 22: Behavioral Test Suite

### 22.1 State Machine Tests

**File:** `src/tests/state-machine.test.ts`

- Forward flow: Todo -> Planning -> InProgress -> QA -> Review -> Done
- Blocked from each state: Planning, InProgress, QA, Review
- Resume from blocked returns to correct previous state
- Guard: planExists prevents Planning -> InProgress without plan
- Quick start: Todo -> InProgress (skips planning)
- Skip QA: InProgress -> Review
- Cancel from every state returns to Todo
- Invalid transitions throw/reject
- Snapshot round-trip: save -> restore -> state matches
- Schema version stored with snapshot

### 22.2 Webhook Deduplication Tests

**File:** `src/tests/webhook-dedup.test.ts`

- Duplicate delivery ID is rejected
- Different delivery IDs are both processed
- TTL cleanup removes old entries

### 22.3 AMQP Messaging Tests

**File:** `src/tests/amqp-messaging.test.ts`

- Events published with correct routing key
- Commands received and dispatched to XState
- Publish failure doesn't crash the handler
- Connection recovery after broker restart
- Message format matches GWAMessage schema

### 22.4 Session Lifecycle Tests

**File:** `src/tests/session-lifecycle.test.ts`

- Full Todo -> Done lifecycle with assertions at each step
- Blocked -> Resume preserves session state
- Pod restart recovery: interrupted sessions detected and resumable
- Concurrent sessions for different issues don't interfere
- Cleanup removes all artifacts (tmux window, worktree, DB records, MinIO recordings)

### 22.5 Terminal Relay Tests

**File:** `src/tests/terminal-relay.test.ts`

- FIFO read + WebSocket publish round-trip
- Mid-stream join delivers snapshot then incremental data
- Asciicast recording format validation
- MinIO S3 upload on session completion
- Snapshot capture at lifecycle events

---

## Phase 23: v4.0 Documentation & Cleanup

### 23.1 Update README.md

- Replace ASCII state diagram with XState-generated diagram
- Update architecture section with orchestrator + RabbitMQ messaging
- Add mobile app section
- Update tech stack table (remove Redis, add XState, amqplib, ntfy.sh)
- Update security section (timing-safe HMAC, fail-closed verification)

### 23.2 Update CLAUDE.md

- Remove Redis from SDK stack table
- Add XState, amqplib, ntfy.sh to SDK stack table
- Add terminal relay to operational notes
- Add orchestrator architecture notes
- Update RabbitMQ configuration notes

### 23.3 Update CHANGELOG.md

Document all v4.0 changes.

---

## Task Checklist

### Phase 15: v4.0 Prerequisites
- [ ] 15.1 Enable RabbitMQ plugins: `rabbitmq_mqtt`, `rabbitmq_web_mqtt`, `rabbitmq_management`
- [ ] 15.2 Verify MQTT connectivity and topic routing from within cluster
- [ ] 15.3 Deploy ntfy.sh to K3s cluster
- [ ] 15.4 Add Cloudflare tunnel route for ntfy (`ntfy.bto.bar`)
- [ ] 15.5 Create MinIO bucket `gwa-recordings` with lifecycle policies
- [ ] 15.6 Verify `ansi-to-svg` works with Bun (or identify fallback)
- [ ] 15.7 Create `src/shared/types.ts` with canonical enums and message schema

### Phase 16: Security Hardening
- [ ] 16.1 Import `timingSafeEqual` in `src/webhook/handler.ts`
- [ ] 16.2 Change `verifySignature()` to fail closed when secret is empty
- [ ] 16.3 Replace `===` with `timingSafeEqual` for HMAC comparison
- [ ] 16.4 Add length check before `timingSafeEqual`
- [ ] 16.5 Add in-memory deduplication `Map` with 1-hour TTL
- [ ] 16.6 Check `X-GitHub-Delivery` against dedup map before processing
- [ ] 16.7 Write tests for signature verification edge cases
- [ ] 16.8 Write tests for deduplication logic
- [ ] 16.9 Run `bun run typecheck` -- verify clean

### Phase 17: XState State Machine
- [ ] 17.1 Install `xstate@^5.26.0`
- [ ] 17.2 Create `src/lib/state-machine.ts` with machine definition
- [ ] 17.3 Define all 7 states with transitions matching README
- [ ] 17.4 Implement guards: `hasNoActiveSession`, `planExists`, `previousWas*`
- [ ] 17.5 Implement `columnTransitionToEvent()` mapping function
- [ ] 17.6 Add `xstate_snapshot` and `xstate_schema_version` columns to sessions table
- [ ] 17.7 Implement `persistSnapshot()` and `restoreActor()` helper functions
- [ ] 17.8 Handle `undefined` -> `null` in JSON serialization
- [ ] 17.9 Integrate with AMQP command subscriber (replace workflow_dispatch chain)
- [ ] 17.10 Update each transition handler to load/verify/persist XState state
- [ ] 17.11 Map `blocked` state `previousState` context correctly
- [ ] 17.12 Publish `state_change` event to RabbitMQ on every transition
- [ ] 17.13 Write state machine unit tests (all valid transitions)
- [ ] 17.14 Write state machine unit tests (all invalid transitions)
- [ ] 17.15 Write state machine unit tests (guard conditions)
- [ ] 17.16 Write snapshot round-trip tests
- [ ] 17.17 Run `bun run typecheck` -- verify clean
- [ ] 17.18 Run `bun test` -- verify all pass

### Phase 18: Remove Redis (Complete -- 21 Files)
- [ ] 18.1 Delete `src/lib/redis.ts`
- [ ] 18.2 Rewrite `src/lib/repl-session.ts` -- migrate ALL 6 Redis operations to SQLite
- [ ] 18.3 Extend `sessions` table with REPL-specific fields (`repl_session_id`, `repl_status`)
- [ ] 18.4 Update `src/orchestrate.ts` -- replace all 8 Redis calls with SQLite
- [ ] 18.5 Update `src/health-check.ts` -- remove Redis check, add SQLite check
- [ ] 18.6 Delete `src/debug-redis.ts`, create `src/debug-db.ts`
- [ ] 18.7 Remove `build:debug-redis` script from `package.json`
- [ ] 18.8 Remove `IORedisInstrumentation` from `src/lib/telemetry.ts`
- [ ] 18.9 Remove `Metrics.recordRedisOperation()` and all call sites
- [ ] 18.10 Update `src/lib/types.ts` -- remove Redis types, use canonical `SessionState`
- [ ] 18.11 Create `active_sessions` SQL view
- [ ] 18.12 Remove `ioredis` from `package.json`
- [ ] 18.13 Remove `@opentelemetry/instrumentation-ioredis` from `package.json`
- [ ] 18.14 Update `src/tests/imports.test.ts` -- remove Redis export checks
- [ ] 18.15 Update `src/tests/preflight.test.ts` -- remove `ioredis` assertion, add `xstate`/`amqplib`
- [ ] 18.16 Update `tests/helm-chart.test.ts` -- remove Redis assertions, add RabbitMQ
- [ ] 18.17 Update Helm `values.yaml` -- remove `redis` section, add `rabbitmq`, `ntfy`, `minio`
- [ ] 18.18 Update Helm `configmap.yaml` -- replace `redis-cli` with `sqlite3` commands
- [ ] 18.19 Update Helm `statefulset.yaml` -- remove `REDIS_HOST`/`REDIS_PORT`, add `RABBITMQ_URL`
- [ ] 18.20 Update Helm `cronjob-cleanup.yaml` -- remove Redis env vars
- [ ] 18.21 Update `k8s/gwa-runner-statefulset.yaml` -- remove Redis env vars
- [ ] 18.22 Update `k8s/gwa-cleanup-cronjob.yaml` -- remove Redis env vars
- [ ] 18.23 Verify `busy_timeout = 5000` on all `getDatabase()` calls
- [ ] 18.24 Verify write transactions use `BEGIN IMMEDIATE`
- [ ] 18.25 Add `SQLITE_BUSY` retry logic for critical paths
- [ ] 18.26 Run `bun run typecheck` -- verify clean
- [ ] 18.27 Run `bun test` -- verify all pass

### Phase 19: RabbitMQ Backbone + Orchestrator Extraction
- [ ] 19.1 Install `amqplib@^0.10.7` and `@types/amqplib`
- [ ] 19.2 Create `src/lib/amqp.ts` -- singleton connection + auto-reconnect + publisher confirms
- [ ] 19.3 Implement `publishEvent()` with routing key `gwa.events.{owner}.{repo}.{session}.{eventType}`
- [ ] 19.4 Implement `subscribeCommands()` for `gwa.commands.{owner}.{repo}.#`
- [ ] 19.5 Integrate with `logActivity()` in `src/lib/db.ts` (fire-and-forget)
- [ ] 19.6 Publish heartbeat every 30s to `gwa.heartbeat.{owner}.{repo}`
- [ ] 19.7 Create `src/orchestrator/` directory structure
- [ ] 19.8 Move webhook handler logic to `src/orchestrator/webhook-handler.ts`
- [ ] 19.9 Create `src/orchestrator/session-aggregator.ts` -- subscribe to all pod events
- [ ] 19.10 Create `src/orchestrator/rest-api.ts` with Bun.serve
- [ ] 19.11 Implement all REST endpoints (sessions, answer, snapshots, recordings)
- [ ] 19.12 Create `src/orchestrator/push-bridge.ts` -- ntfy.sh integration
- [ ] 19.13 Implement per-session debounce (30s) in push bridge
- [ ] 19.14 Implement global rate limit (5 notifications/minute)
- [ ] 19.15 Implement per-session cooldown (5 minutes)
- [ ] 19.16 Create orchestrator's own SQLite database for aggregated state
- [ ] 19.17 Create `Dockerfile.orchestrator` for orchestrator image
- [ ] 19.18 Create K8s Deployment manifest for orchestrator
- [ ] 19.19 Add `RABBITMQ_URL` env var to runner StatefulSet
- [ ] 19.20 Add MQTT WebSocket Cloudflare tunnel route (WSS fallback)
- [ ] 19.21 Configure Cloudflare Tunnel private network route for WARP path
- [ ] 19.22 Configure Zero Trust Split Tunnels to include K3s service CIDR
- [ ] 19.23 Enable `rabbitmq_mqtt` + `rabbitmq_web_mqtt` plugins
- [ ] 19.24 Write AMQP publish/subscribe tests (mock broker)
- [ ] 19.25 Write push bridge throttling tests
- [ ] 19.26 Write orchestrator REST API tests
- [ ] 19.27 Run `bun run typecheck` -- verify clean
- [ ] 19.28 Run `bun test` -- verify all pass

### Phase 20: Live Terminal Streaming & Snapshots
- [ ] 20.1 Create `src/lib/terminal-relay.ts` -- main relay service module
- [ ] 20.2 Implement `startPaneStream()` -- mkfifo + tmux pipe-pane + FIFO reader
- [ ] 20.3 Implement `stopPaneStream()` -- detach pipe-pane + close FIFO + upload to MinIO
- [ ] 20.4 Implement Bun WebSocket server with pub/sub topics per pane
- [ ] 20.5 Implement mid-stream join -- `capture-pane -e -p` snapshot on WebSocket connect
- [ ] 20.6 Implement asciicast v2 dual-write (NDJSON append alongside live stream)
- [ ] 20.7 Add `terminal_snapshots` table to `schema.sql`
- [ ] 20.8 Implement `takeSnapshot()` -- capture-pane + ansi-to-svg + SQLite store
- [ ] 20.9 Integrate snapshot triggers with XState transition actions
- [ ] 20.10 Install `ansi-to-svg` npm package (or fallback)
- [ ] 20.11 Install `@aws-sdk/client-s3` for MinIO uploads
- [ ] 20.12 Implement MinIO S3 upload on session completion
- [ ] 20.13 Add presigned URL generation for recording playback
- [ ] 20.14 Integrate `startPaneStream()` into session creation workflow
- [ ] 20.15 Integrate `stopPaneStream()` into session cleanup workflow
- [ ] 20.16 Add `build:terminal-relay` script to `package.json`
- [ ] 20.17 Add Cloudflare tunnel route for terminal relay (`terminal.bto.bar` -> `:8080`)
- [ ] 20.18 Add port 8080 to runner Service/StatefulSet
- [ ] 20.19 Write tests: FIFO read + WebSocket publish round-trip
- [ ] 20.20 Write tests: mid-stream join snapshot + incremental data
- [ ] 20.21 Write tests: asciicast recording format validation
- [ ] 20.22 Write tests: MinIO S3 upload
- [ ] 20.23 Write tests: snapshot capture at lifecycle events
- [ ] 20.24 Run `bun run typecheck` -- verify clean
- [ ] 20.25 Run `bun test` -- verify all pass

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

### Phase 22: Behavioral Tests
- [ ] 22.1 Write full session lifecycle test (Todo -> Done)
- [ ] 22.2 Write blocked -> resume lifecycle test
- [ ] 22.3 Write RabbitMQ command -> pod XState transition test
- [ ] 22.4 Write orchestrator aggregation test (events from multiple pods)
- [ ] 22.5 Write concurrent session isolation test
- [ ] 22.6 Write cleanup artifact verification test (tmux + worktree + DB + MinIO)
- [ ] 22.7 Write terminal relay integration test (stream start -> data -> snapshot -> upload)
- [ ] 22.8 Run full test suite -- verify all pass

### Phase 23: v4.0 Documentation & Cleanup
- [ ] 23.1 Update `README.md` -- architecture, tech stack, orchestrator, RabbitMQ
- [ ] 23.2 Update `CLAUDE.md` -- remove Redis, add XState/amqplib/ntfy.sh/MinIO
- [ ] 23.3 Update `CHANGELOG.md` with v4.0 changes
- [ ] 23.4 Bump `package.json` version to 4.0.0
- [ ] 23.5 Final `bun run typecheck` + `bun test`
- [ ] 23.6 Build all binaries: `bun run build`
- [ ] 23.7 Build and push runner Docker image
- [ ] 23.8 Build and push orchestrator Docker image
- [ ] 23.9 Deploy orchestrator to K3s
- [ ] 23.10 Deploy updated runner to K3s
- [ ] 23.11 End-to-end test: webhook -> RabbitMQ -> pod -> MQTT -> mobile + ntfy push

---

## Dependencies Summary

### Add (Server)
| Package | Version | Purpose |
|---------|---------|---------|
| `xstate` | `^5.26.0` | Formal state machine (pod level) |
| `amqplib` | `^0.10.7` | AMQP publishing/subscribing to RabbitMQ |
| `@types/amqplib` | `^0.10.5` | TypeScript types |
| `ansi-to-svg` | `^1.1.1` | Convert terminal snapshots to SVG |
| `@aws-sdk/client-s3` | `^3.x` | MinIO S3 uploads for recordings |

### Remove (Server)
| Package | Reason |
|---------|--------|
| `ioredis` | Replaced by SQLite + RabbitMQ |
| `@opentelemetry/instrumentation-ioredis` | No longer needed |

### Android Dependencies
| Package | Purpose |
|---------|---------|
| Termux `terminal-view` + `terminal-emulator` | Native terminal rendering |
| Paho MQTT Android | Native TCP MQTT client |
| OkHttp | WebSocket for terminal relay |
| Retrofit | REST API calls |
| Compose + Material3 | UI framework |
| _(No Firebase)_ | _(ntfy.sh replaces FCM entirely)_ |

### Infrastructure
| Component | Change |
|-----------|--------|
| RabbitMQ (existing) | Enable `rabbitmq_mqtt` (1883) + `rabbitmq_web_mqtt` (15675) plugins |
| ntfy.sh | Deploy to K3s for self-hosted push notifications |
| MinIO (existing) | Create `gwa-recordings` bucket with lifecycle policies |
| Cloudflare Tunnel | Add routes: `mqtt.bto.bar`, `terminal.bto.bar`, `ntfy.bto.bar`, `gwa-api.bto.bar` |
| Cloudflare Tunnel | Add private network route `10.43.0.0/16` (WARP primary) |
| Zero Trust | Split Tunnels Include: `10.43.0.0/16`; Gateway policy: allow RabbitMQ + relay ports |
| gwa-orchestrator | New Deployment (extracted from webhook + new REST API + push bridge) |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| XState snapshot incompatibility after machine changes | Medium | High | Store schema version, write migration functions |
| Cloudflare WSS drops (100s timeout) | Medium | Low | WARP primary (8hr idle) + WSS fallback + ntfy push for critical events |
| WARP killed by Android in background | Medium | Medium | Always-on VPN + battery whitelist + ntfy push bridge as guaranteed fallback |
| Notification flood from concurrent sessions | High | Medium | Per-session debounce (30s) + global rate limit (5/min) + cooldown (5min) + Android grouping |
| amqplib large message bug on Bun (#5627) | Low | Low | Our payloads are < 4KB JSON |
| SQLite BUSY under concurrent writes | Low | Medium | 5s busy_timeout + BEGIN IMMEDIATE + short transactions |
| OEM battery optimization kills push + WARP | Medium | Medium | App detects and prompts user to whitelist; ntfy delivery retries |
| MQTT session expires during long background | Low | Medium | REST API safety net on foreground resume |
| Termux terminal-view GPLv3 license | Low | Low | Personal tool, not distributed |
| Android Doze blocks foreground service MQTT | Medium | Low | ntfy push bridge as fallback; foreground service is optional |
| XState history state bug (#5178) | Low | Low | We use context.previousState instead |
| Terminal rendering performance | N/A | N/A | **Eliminated.** Termux terminal-view: native Canvas, 200x50 at 60fps |
| tmux pipe-pane single consumer limit | Low | Low | Relay fans out via WebSocket pub/sub |
| Recordings fill storage | Low | Low | **Eliminated.** MinIO S3 with lifecycle policies (not Longhorn PVC) |
| Named FIFO orphan on crash | Low | Low | Cleanup on relay startup |
| ntfy.sh downtime | Low | Medium | MQTT foreground service as primary; ntfy is fallback. Simple stateless service, easy to restart |
| Orchestrator single point of failure | Low | High | Pods continue working autonomously; orchestrator only affects global view + webhook routing. Can run 2 replicas |
| Redis removal regression | Medium | High | Comprehensive test suite (Phase 22) validates all paths before deployment |
| `ansi-to-svg` Bun incompatibility | Low | Low | Fallback: `ansi-to-html` + SVG foreignObject wrapper |

---

## Support & Documentation

- Claude Code: https://code.claude.com
- Longhorn: https://longhorn.io/docs/
- SQLite: https://www.sqlite.org/docs.html
- GitHub Actions: https://docs.github.com/actions
- k3s: https://docs.k3s.io/

---

**Document Version:** 4.0
**Created:** February 5, 2026
**Updated:** February 17, 2026
**Architecture:** Long-lived pods + tmux + git worktrees + SQLite tracking + Longhorn persistence + XState + RabbitMQ + Orchestrator + Mobile App
**Status:** v3.4 implemented, v4.0 planned
