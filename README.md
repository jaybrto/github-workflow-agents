# GitHub Workflow Agents (GWA) v3.3

Automated Claude Code integration for GitHub with persistent sessions, multi-agent orchestration, and GitHub Projects workflow automation on Kubernetes.

## Overview

GWA transforms GitHub issues into completed, tested pull requests using Claude Code agents. Issues flow through a GitHub Project board (Todo → Planning → In Progress → QA → Review → Done), with Claude agents automatically handling each phase transition.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GitHub Project Board                               │
├─────────┬──────────┬─────────────┬────────┬─────────┬──────────┬───────────┤
│  Todo   │ Planning │ In Progress │   QA   │ Blocked │  Review  │   Done    │
│         │          │             │        │         │          │           │
│ ┌─────┐ │ ┌─────┐  │  ┌─────┐    │┌─────┐ │ ┌─────┐ │ ┌─────┐  │  ┌─────┐  │
│ │Issue│─┼▶│Plan │──┼─▶│Build│────┼▶│Test│─┼▶│Wait │─┼▶│Review│──┼─▶│Merge│  │
│ └─────┘ │ └─────┘  │  └─────┘    │└─────┘ │ └─────┘ │ └─────┘  │  └─────┘  │
└─────────┴──────────┴─────────────┴────────┴─────────┴──────────┴───────────┘
              │              │            │        │
              ▼              ▼            ▼        ▼
         ┌─────────┐   ┌──────────┐  ┌────────┐ ┌────────┐
         │Architect│   │ Workers  │  │Playwright│ │Human  │
         │ Agent   │   │ (Swarm)  │  │  Tests   │ │ Input │
         └─────────┘   └──────────┘  └────────┘ └────────┘
```

## Features

### Core Capabilities
- **GitHub Projects Integration**: Automated workflow via column transitions
- **Multi-Agent Swarm**: Architect agent spawns worker agents for parallel task execution
- **Persistent Sessions**: SQLite + Redis for session state across pod restarts
- **Git Worktrees**: Isolated worktree per issue for safe parallel work
- **Observability**: Full OpenTelemetry instrumentation (traces, metrics, logs)

### Column Transition Automation

| Transition | Trigger | Action |
|------------|---------|--------|
| Todo → Planning | Issue added to board | Create session, start planning REPL |
| Planning → In Progress | Plan approved | Inject implementation prompt |
| In Progress → QA | Code complete | Run Playwright e2e tests |
| QA → In Progress | Tests fail | Resume REPL with failure context |
| Blocked → Previous | Answer received | Send answer to blocked REPL |
| Review → Done | Review approved | Merge PR, cleanup session |

### Security Features
- Input validation on all CLI parameters
- Command injection prevention (temp file approach)
- SQL injection prevention (parameterized queries)
- Path traversal protection (allowlisted directories)
- Environment variable whitelisting for subprocesses

## Architecture

### System Components

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  GitHub Action  │────▶│  GWA Runner Pod  │────▶│   Claude Code   │
│   (trigger)     │     │  (StatefulSet)   │     │   (in tmux)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌──────────┐    ┌───────────┐    ┌──────────┐
        │  SQLite  │    │  Redis    │    │  Alloy   │
        │ (sessions)│    │ (cache)   │    │  (OTEL)  │
        └──────────┘    └───────────┘    └──────────┘
```

### CLI Tools

| Tool | Purpose |
|------|---------|
| `gwa-orchestrate` | Main PR work lifecycle |
| `gwa-respond` | Handle `@claude-answer` responses |
| `gwa-cleanup` | Clean up stale sessions (CronJob) |
| `gwa-architect` | Create plans and spawn workers |
| `gwa-worker` | Execute assigned sub-tasks |
| `gwa-setup-project` | Create GitHub Project for new repo |
| `gwa-start-planning` | Todo → Planning transition |
| `gwa-inject-prompt` | Planning → In Progress transition |
| `gwa-run-playwright` | In Progress → QA transition |
| `gwa-resume-with-failures` | QA → In Progress transition |
| `gwa-send-answer` | Blocked → Previous transition |
| `gwa-deploy-and-cleanup` | Review → Done transition |

### Tech Stack

| Concern | Technology |
|---------|------------|
| Runtime | Bun (compiled binaries) |
| Container | Node.js 22 (for Claude Code CLI) |
| Orchestration | Kubernetes (K3s) |
| Storage | Longhorn (persistent volumes) |
| Database | SQLite with WAL mode |
| Session Cache | Redis (ioredis) |
| GitHub API | @octokit/rest + GraphQL |
| Observability | OpenTelemetry → Alloy → Tempo/Mimir/Loki |

## Prerequisites

- Kubernetes cluster (K3s recommended)
- Longhorn storage provisioner
- Redis instance
- GitHub App or PAT with repo permissions
- Claude Code OAuth token
- Alloy collector (for telemetry)

## Installation

### 1. Create Secrets

```bash
kubectl create secret generic gwa-secrets \
  --from-literal=github-token=ghp_xxxx \
  --from-literal=claude-oauth-token=sk-ant-xxxx \
  --from-literal=anthropic-api-key=sk-ant-xxxx
```

### 2. Create GHCR Pull Secret

```bash
kubectl create secret docker-registry ghcr-secret \
  --docker-server=ghcr.io \
  --docker-username=YOUR_GITHUB_USERNAME \
  --docker-password=YOUR_GITHUB_PAT
```

### 3. Deploy to Kubernetes

```bash
kubectl apply -f k8s/
```

### 4. Setup GitHub Project (per repository)

```bash
gwa-setup-project --org <organization> --repo <repo-name>
```

### 5. Configure GitHub Actions

Add the workflow that triggers on project card movements:

```yaml
name: GWA Project Sync
on:
  project_card:
    types: [moved]
  issues:
    types: [opened, labeled]

jobs:
  sync:
    runs-on: self-hosted
    steps:
      - name: Handle Column Transition
        run: |
          # Transitions are handled by the respective gwa-* tools
          # based on the source and destination columns
```

## Development

### Local Setup

```bash
# Install dependencies
bun install

# Type check
bun run typecheck

# Run tests
bun test

# Build all binaries
bun run build
```

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/tests/preflight.test.ts

# Run with coverage
bun test --coverage
```

### Test Coverage

| Test File | Coverage |
|-----------|----------|
| `db.test.ts` | Schema validation, CRUD operations |
| `imports.test.ts` | Library export validation |
| `templates.test.ts` | File existence, JSON validation |
| `preflight.test.ts` | Pre-deployment checks |

### Building the Container

```bash
# Build locally
docker build -t ghcr.io/jaybrto/github-workflow-agents:dev .

# Or push to trigger CI build
git push origin main
```

## Project Structure

```
├── .claude/                    # Claude Code configuration
│   └── CLAUDE.md              # Project context for Claude
├── .github/workflows/         # GitHub Actions
│   ├── build-image.yml        # Container build
│   └── project-sync.yml       # Project card sync
├── k8s/                       # Kubernetes manifests
│   ├── gwa-runner-statefulset.yaml
│   ├── gwa-runner-configmap.yaml
│   ├── gwa-cleanup-cronjob.yaml
│   └── charts/                # Helm charts
│       └── gwa-onboarding/    # ArgoCD onboarding
├── src/
│   ├── orchestrate.ts         # Main PR orchestration
│   ├── respond.ts             # Answer handling
│   ├── cleanup.ts             # Stale session cleanup
│   ├── architect.ts           # Plan creation, worker spawning
│   ├── worker.ts              # Sub-task execution
│   ├── setup-project.ts       # GitHub Project setup
│   ├── transitions/           # Column transition handlers
│   │   ├── start-planning.ts
│   │   ├── inject-prompt.ts
│   │   ├── run-playwright.ts
│   │   ├── resume-with-failures.ts
│   │   ├── send-answer.ts
│   │   └── deploy-and-cleanup.ts
│   ├── tests/                 # Test suite
│   │   ├── db.test.ts
│   │   ├── imports.test.ts
│   │   ├── templates.test.ts
│   │   └── preflight.test.ts
│   └── lib/
│       ├── claude.ts          # Claude Code subprocess
│       ├── github.ts          # GitHub API client
│       ├── projects.ts        # GitHub Projects v2 GraphQL
│       ├── redis.ts           # Redis client
│       ├── db.ts              # SQLite database
│       ├── tmux.ts            # Tmux session management
│       ├── swarm.ts           # Multi-agent orchestration
│       ├── telemetry.ts       # OpenTelemetry setup
│       ├── pr-filter.ts       # Claude PR detection
│       ├── plan-sync.ts       # Plan-to-issue linking
│       ├── task-analyzer.ts   # REPL vs headless decision
│       ├── comment-generator.ts # Smart PR comments
│       ├── repl-session.ts    # REPL lifecycle
│       ├── checkpoint.ts      # State snapshots
│       └── recovery.ts        # Session recovery
├── templates/
│   ├── github-project.json    # Project board template
│   └── plans/                 # Plan document templates
│       ├── plan.md
│       ├── prompt.md
│       ├── checklist.md
│       ├── decisions.md
│       └── snippets.md
├── schema.sql                 # SQLite schema (v2.1)
├── Dockerfile                 # Multi-stage build
└── package.json
```

## How It Works

### Issue-to-PR Workflow

1. **Issue Created**: Add to project board "Todo" column
2. **Planning Started**: `gwa-start-planning` creates session, Claude designs solution
3. **Plan Approved**: Move to "In Progress", `gwa-inject-prompt` starts implementation
4. **Implementation**: Claude (or worker swarm) builds the feature
5. **QA Phase**: `gwa-run-playwright` runs e2e tests
6. **Review**: Human reviews the PR
7. **Completion**: `gwa-deploy-and-cleanup` merges and cleans up

### Multi-Agent Swarm

For complex tasks, the Architect agent can spawn worker agents:

```
┌────────────────────────────────────────────────────┐
│                 Architect Agent                     │
│  - Analyzes requirements                           │
│  - Creates task breakdown                          │
│  - Spawns workers for parallel execution           │
│  - Aggregates results                              │
└────────────────────────────────────────────────────┘
         │           │           │
         ▼           ▼           ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ Worker  │ │ Worker  │ │ Worker  │
    │ Task 1  │ │ Task 2  │ │ Task 3  │
    └─────────┘ └─────────┘ └─────────┘
```

### Session Persistence

- **SQLite**: Primary session store with full audit trail
- **Redis**: Fast PR→session lookups (7-day TTL)
- **Longhorn**: Persists `~/.claude/` across pod restarts
- **Worktrees**: Isolated at `/home/runner/worktrees/issue-{N}/`

## Observability

### Traces

Sent to Tempo via Alloy (gRPC on port 4317):
- `orchestrate` - Full PR processing span
- `transition.*` - Column transition handlers
- `swarm.*` - Multi-agent operations
- `redis.*` - Auto-instrumented Redis commands

### Metrics

Sent to Mimir via Alloy:
- `gwa_pr_orchestrations_total` - PR orchestration runs
- `gwa_claude_invocations_total` - Claude CLI invocations
- `gwa_claude_duration_seconds` - Claude invocation duration
- `gwa_github_api_calls_total` - GitHub API calls
- `gwa_sessions_active` - Active Claude sessions
- `gwa_swarm_workers_total` - Swarm worker operations

### Logs

Sent to Loki via Alloy (HTTP on port 4318):
- Structured JSON logs with trace correlation
- Automatic `trace_id` and `span_id` injection

### Environment Variables

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.alloy.svc.cluster.local:4317
OTEL_SERVICE_NAME=github-workflow-agents
OTEL_SERVICE_VERSION=3.3.0
DEPLOYMENT_ENVIRONMENT=production
```

## Database Schema

GWA uses SQLite with WAL mode for concurrent access. Key tables:

| Table | Purpose |
|-------|---------|
| `sessions` | Core session tracking |
| `questions` | Claude questions and answers |
| `agent_tasks` | Swarm worker task tracking |
| `activity_log` | Full audit trail |
| `checkpoints` | State snapshots for recovery |
| `commits` | Commits made by Claude |

See `schema.sql` for full schema (v2.1).

## Security

### Input Validation
- Repo format: `^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$`
- PR number: `1-999999999`
- Actor format: GitHub username pattern
- Comment size: Max 64KB

### Injection Prevention
- Shell commands use temp files for user content
- SQL queries use parameterized values
- Template paths validated against allowlist

### Environment Variables
- Claude subprocess receives whitelisted env vars only
- Sensitive tokens not passed to child processes

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/issue-123-description`
3. Make changes following the existing code style
4. Run type checks: `bun run typecheck`
5. Run tests: `bun test`
6. Commit with conventional commits: `git commit -m "feat(scope): description"`
7. Push and open a PR

## License

MIT
