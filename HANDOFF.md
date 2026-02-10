# Handoff: Complete GWA End-to-End Integration

## Overview

The GitHub Workflow Agents (GWA) webhook and state machine are fully functional. This session needs to:
1. Build and deploy the missing `gwa-*` binaries to the K8s pod
2. Set up SQLite database for session persistence (NOT Redis - we use SQLite now)
3. Test the full end-to-end flow with actual REPL sessions
4. Verify all 17 handlers work with real Claude Code sessions

## Current State

### What's Working
- **Webhook deployed**: `gwa-webhook` pod running in K8s default namespace
- **Cloudflare tunnel**: `git-hooks.bto.bar` routes to webhook via `bto-services-prod` tunnel
- **GitHub App**: `Workflow-Agents-BTO` installed on `bto-labs` org with `projects_v2_item` events
- **State machine**: All 17 handlers trigger correctly for 38 valid transitions
- **Cross-org access**: Webhook resolves issue details from `bto-labs` before triggering workflows in `jaybrto`

### What's NOT Working
- **Handler execution fails**: `kubectl exec "$POD" -- gwa-architect/gwa-cleanup/gwa-respond` fails because binaries don't exist
- **No session persistence**: SQLite database not initialized in the pod
- **No actual REPL sessions**: Can't test pause/resume without the full stack

## Architecture

```
GitHub Project (bto-labs)
       │
       │ projects_v2_item webhook
       ▼
┌─────────────────────┐
│  gwa-webhook pod    │  ← Cloudflare tunnel (git-hooks.bto.bar)
│  (receives events)  │
└─────────────────────┘
       │
       │ workflow_dispatch API
       ▼
┌─────────────────────┐
│  GitHub Actions     │  ← project-sync.yml workflow
│  (self-hosted)      │
└─────────────────────┘
       │
       │ kubectl exec
       ▼
┌─────────────────────┐
│  gwa-runner-0 pod   │  ← StatefulSet with Longhorn PVC
│  (Claude sessions)  │
└─────────────────────┘
       │
       ├── gwa-architect (planning/implementation)
       ├── gwa-cleanup (session cleanup)
       ├── gwa-respond (handle @claude-answer)
       └── SQLite DB (/home/runner/gwa.db)
```

## Handler Reference

Each handler is triggered by a column transition and executes in the workflow:

| Handler | Transition | What It Should Do |
|---------|------------|-------------------|
| `start-planning` | Todo → Planning | Create session, start Claude REPL for planning |
| `inject-prompt` | Planning → In Progress | Send implementation prompt to existing session |
| `run-playwright` | In Progress → QA | Run Playwright e2e tests |
| `status-update` | QA → Review | Post summary comment, notify reviewers |
| `deploy-and-cleanup` | Review → Done | Merge PR, cleanup session |
| `pause-for-question` | Any → Blocked | Pause session, post question to issue |
| `send-answer` | Blocked → Any | Resume session with answer |
| `resume-with-failures` | QA → In Progress | Resume with test failure context |
| `request-retest` | Review → QA | Re-run tests |
| `request-replanning` | Any → Planning | Reset session to planning phase |
| `resume-implementation` | Review → In Progress | Resume implementation work |
| `cancel-session` | Any → Todo | Cancel and cleanup session |
| `reopen-issue` | Done → Any | Create new session for reopened issue |
| `quick-start` | Todo → In Progress | Skip planning, start implementation directly |
| `close-without-work` | Any → Done | Close without implementation |
| `skip-qa` | In Progress → Review | Skip tests, go to review |
| `skip-implementation` | Planning → QA | Pre-built solution, skip to QA |

## Files to Understand

### Webhook Handler
- **`src/webhook/handler.ts`**: Receives GitHub webhooks, maps transitions to handlers, triggers workflows
- **`Dockerfile.webhook`**: Builds the webhook binary
- **`k8s/gwa-webhook.yaml`**: Webhook deployment + cloudflared tunnel

### Workflow
- **`.github/workflows/project-sync.yml`**: Dispatched by webhook, executes handlers via kubectl

### CLI Tools (need to be built/deployed)
- **`src/architect.ts`**: Creates plans, spawns workers - NEEDS WORK
- **`src/cleanup.ts`**: Cleans up sessions - NEEDS WORK
- **`src/respond.ts`**: Handles @claude-answer responses - NEEDS WORK
- **`src/orchestrate.ts`**: Main PR orchestration - EXISTS

### Database
- **`schema.sql`**: SQLite schema (v2.1) - USE THIS
- **`src/lib/db.ts`**: Database client - USE THIS

### Existing Infrastructure
- **`k8s/gwa-runner-statefulset.yaml`**: Runner pod definition
- **`k8s/gwa-runner-configmap.yaml`**: Configuration

## SQLite Schema (NOT Redis)

Recent decision: Use SQLite for ALL persistence, not Redis. The schema is in `schema.sql`:

Key tables:
- `sessions`: Core session tracking (issue, repo, status, tmux_session, worktree_path)
- `questions`: Claude questions and answers
- `agent_tasks`: Swarm worker task tracking
- `activity_log`: Full audit trail
- `checkpoints`: State snapshots for recovery
- `commits`: Commits made by Claude

Database location: `/home/runner/gwa.db` (on Longhorn PVC)

## What You Need To Do

### 1. Build and Deploy GWA Binaries

The binaries need to be compiled and available in the runner pod:

```bash
# Build all binaries
bun run build

# Binaries created in dist/:
# - gwa-orchestrate
# - gwa-respond
# - gwa-cleanup
# - gwa-architect
# - gwa-worker
# etc.
```

Options for deployment:
1. **Bake into container image**: Update `Dockerfile` to include compiled binaries
2. **Copy to PVC**: Copy binaries to Longhorn volume and add to PATH
3. **ConfigMap/Secret mount**: Mount binaries from ConfigMap

Recommended: Update `Dockerfile` to include all binaries, rebuild and push image.

### 2. Initialize SQLite Database

The runner pod needs the SQLite database initialized:

```bash
# In the pod:
sqlite3 /home/runner/gwa.db < schema.sql
```

Or create an init container that does this.

### 3. Verify Environment Variables

The runner pod needs these env vars (check `k8s/gwa-runner-statefulset.yaml`):
- `GITHUB_TOKEN`: For GitHub API calls
- `CLAUDE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`: For Claude Code
- `GWA_DB_PATH`: Path to SQLite database (default: `/home/runner/gwa.db`)

### 4. Test End-to-End Flow

Use the test project in `bto-labs`:
- **Project**: "GWA Demo Workflow" (number: 1)
- **Test issue**: #3 "Test: Org-level webhook triggers"

Test script available:
```bash
./scripts/test-all-transitions.sh
```

Or manually test a flow:
```bash
# Move item Todo → Planning (triggers start-planning)
gh api graphql -f query='
mutation {
  updateProjectV2ItemFieldValue(
    input: {
      projectId: "PVT_kwDOD4hwbM4BOzHX"
      itemId: "PVTI_lADOD4hwbM4BOzHXzglJ-wI"
      fieldId: "PVTSSF_lADOD4hwbM4BOzHXzg9ZPE8"
      value: { singleSelectOptionId: "33a0f031" }
    }
  ) {
    projectV2Item { id }
  }
}'

# Check webhook logs
kubectl logs -l component=webhook -f

# Check workflow runs
gh run list --workflow=project-sync.yml --limit=5
```

### 5. Verify REPL Session Lifecycle

Test the full lifecycle:
1. **Todo → Planning**: Should create tmux session, start Claude REPL
2. **Planning → Blocked**: Should pause session, post question
3. **Blocked → Planning**: Should resume with answer
4. **Planning → In Progress**: Should inject implementation prompt
5. **In Progress → QA**: Should run tests
6. **QA → Review**: Should post summary
7. **Review → Done**: Should merge and cleanup

## Column Option IDs (for GraphQL mutations)

```
Todo: d73904c2
Planning: 33a0f031
In Progress: d3f535bb
QA: e5fb302c
Blocked: c6b20921
Review: 5a692329
Done: da43ec98
```

## Secrets Required

In K8s default namespace:
- `gwa-secrets`: Contains `github-token`, `claude-oauth-token`, `anthropic-api-key`
- `gwa-webhook-secrets`: Contains `github-app-secret`
- `ghcr-pull-secret`: Docker registry credentials for GHCR

## Debugging Commands

```bash
# Webhook logs
kubectl logs -l component=webhook -f

# Runner pod logs
kubectl logs gwa-runner-0 -f

# Exec into runner pod
kubectl exec -it gwa-runner-0 -- bash

# Check workflow runs
gh run list --workflow=project-sync.yml --limit=10

# View specific workflow run logs
gh run view <RUN_ID> --log

# Test webhook endpoint
curl -X POST https://git-hooks.bto.bar/ -H "Content-Type: application/json" -d '{}'
# Should return 401 (invalid signature) - means webhook is reachable
```

## Key Commits for Context

```
d8a7450 test(transitions): add comprehensive state transition test script
9fcd22f feat(webhook): add comprehensive state transition handling
5da0362 fix(webhook): resolve issue details in webhook to avoid cross-org token issues
d8f53d3 fix(workflow): accept webhook inputs and fetch issue details from content_id
f8d90bd feat(webhook): add GitHub App webhook handler for project column transitions
```

## Success Criteria

The end-to-end integration is complete when:
1. ✅ Moving an issue Todo → Planning creates a Claude REPL session
2. ✅ The session persists in SQLite with correct metadata
3. ✅ Moving to Blocked pauses the session
4. ✅ Moving from Blocked resumes with the answer
5. ✅ Moving to Done cleans up the session
6. ✅ All 17 handlers execute without errors
7. ✅ Test script `./scripts/test-all-transitions.sh` passes

## Notes

- The webhook runs in a separate pod from the runner (separation of concerns)
- Cross-org access works because webhook has GitHub App access to bto-labs
- Workflow runs on self-hosted runner which has kubectl access to the cluster
- Longhorn PVC ensures session data persists across pod restarts
- SQLite with WAL mode handles concurrent access from multiple handlers
