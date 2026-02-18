# GitHub Workflow Agents (GWA) v4.0

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
- **XState v5 State Machine**: 7 states, 38 transitions with snapshot persistence
- **RabbitMQ AMQP Backbone**: Event distribution and command routing between pods and orchestrator
- **Multi-Agent Swarm**: Architect agent spawns worker agents for parallel task execution
- **Persistent Sessions**: SQLite with WAL mode for all session state
- **Live Terminal Streaming**: WebSocket relay for real-time terminal output
- **Push Notifications**: Mobile alerts via ntfy.sh for blocked, error, and complete events
- **Session Recordings**: Asciicast v2 format with MinIO storage and presigned playback URLs
- **Git Worktrees**: Isolated worktree per issue for safe parallel work
- **Observability**: Full OpenTelemetry instrumentation (traces, metrics, logs)

### Column Transition Automation

GWA handles all possible project board column transitions via webhook. When an item moves between columns, the webhook triggers the appropriate handler.

#### State Machine

```
                                    ┌─────────────────────────────────────┐
                                    │            BLOCKED                   │
                                    │         (awaiting input)             │
                                    └───────────────┬─────────────────────┘
                                          ▲         │ send-answer
                      pause-for-question  │         ▼
┌──────────┐  start-   ┌──────────┐  inject-  ┌───────────┐  run-      ┌──────┐
│   TODO   │──planning─▶│ PLANNING │──prompt──▶│IN PROGRESS│──playwright▶│  QA  │
└──────────┘           └──────────┘           └───────────┘            └──────┘
     ▲                       ▲                      ▲                      │
     │ cancel-session        │ request-replanning  │ resume-with-failures │
     └───────────────────────┴─────────────────────┴──────────────────────┘
                                                                           │
                                    ┌──────────────────────────────────────┘
                                    │ status-update
                                    ▼
                              ┌──────────┐  deploy-and-  ┌──────────┐
                              │  REVIEW  │───cleanup────▶│   DONE   │
                              └──────────┘               └──────────┘
                                    │                          │
                                    │ request-retest           │ reopen-issue
                                    ▼                          ▼
                                  (QA)                    (any column)
```

#### Handler Reference

| Handler | Transition(s) | Action |
|---------|---------------|--------|
| **Forward Flow** |||
| `start-planning` | Todo → Planning | Create session, spawn architect for planning |
| `inject-prompt` | Planning → In Progress | Plan approved, start implementation |
| `run-playwright` | In Progress → QA | Run Playwright e2e tests |
| `status-update` | QA → Review | Tests passed, notify for review |
| `deploy-and-cleanup` | Review → Done | Merge PR, deploy, cleanup session |
| **Blocked Handling** |||
| `pause-for-question` | Any → Blocked | Pause session, await human input |
| `send-answer` | Blocked → Planning/In Progress/QA/Review | Resume session with answer |
| **Iteration** |||
| `resume-with-failures` | QA → In Progress | Resume with test failure context |
| `request-retest` | Review → QA | Re-run tests after review feedback |
| **Backward Transitions** |||
| `request-replanning` | In Progress/QA/Review → Planning | Return to planning phase |
| `resume-implementation` | Review → In Progress | Resume implementation work |
| `cancel-session` | Any → Todo | Cancel and cleanup current session |
| **Reopening** |||
| `reopen-issue` | Done → Any | Create new session for reopened issue |
| **Direct Jumps** |||
| `quick-start` | Todo → In Progress | Skip planning, start immediately |
| `close-without-work` | Any → Done | Close as won't-fix/duplicate |
| `skip-qa` | In Progress → Review | Skip tests, go to review |
| `skip-implementation` | Planning → QA | Pre-built solution, skip to QA |

#### Complete Transition Matrix

| From ↓ / To → | Todo | Planning | In Progress | QA | Blocked | Review | Done |
|---------------|------|----------|-------------|----|---------|---------|----|
| **Todo** | - | start-planning | quick-start | - | pause-for-question | - | close-without-work |
| **Planning** | cancel-session | - | inject-prompt | skip-implementation | pause-for-question | - | close-without-work |
| **In Progress** | cancel-session | request-replanning | - | run-playwright | pause-for-question | skip-qa | close-without-work |
| **QA** | cancel-session | request-replanning | resume-with-failures | - | pause-for-question | status-update | close-without-work |
| **Blocked** | cancel-session | send-answer | send-answer | send-answer | - | send-answer | - |
| **Review** | cancel-session | request-replanning | resume-implementation | request-retest | pause-for-question | - | deploy-and-cleanup |
| **Done** | reopen-issue | reopen-issue | reopen-issue | reopen-issue | reopen-issue | reopen-issue | - |

### Security Features
- Input validation on all CLI parameters
- Command injection prevention (temp file approach)
- SQL injection prevention (parameterized queries)
- Path traversal protection (allowlisted directories)
- Environment variable whitelisting for subprocesses

## Architecture

### System Components

```
                    ┌──────────────────────────────────────────────────────┐
                    │              GitHub Project Board                     │
                    └──────────────────────┬───────────────────────────────┘
                                           │ projects_v2_item webhook
                                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         Orchestrator Service                              │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ Webhook      │  │ REST API      │  │ Push Bridge │  │  Session    │ │
│  │ Handler      │  │ (port 3001)   │  │ (ntfy.sh)   │  │ Aggregator  │ │
│  └──────┬───────┘  └───────────────┘  └─────────────┘  └─────────────┘ │
└─────────┼──────────────────────────────────────────────────────────────┘
          │ AMQP commands                        ▲ AMQP events
          ▼                                      │
┌──────────────────────────────────────────────────────────────────────────┐
│                            RabbitMQ                                       │
│  gwa.commands (topic)  |  gwa.events (topic)  |  gwa.heartbeat (topic)  │
└─────────┬──────────────────────────────────────┬─────────────────────────┘
          │ commands                              ▲ events + heartbeats
          ▼                                      │
┌──────────────────────────────────────────────────────────────────────────┐
│                     GWA Runner Pod (StatefulSet)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  ┌───────────┐  │
│  │ XState v5   │  │ Claude Code  │  │ Terminal Relay │  │  SQLite   │  │
│  │ State Mach. │  │ (in tmux)    │  │  (WS :8080)    │  │  (WAL)    │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  └───────────┘  │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐                                      │
│  │ OTEL → Alloy │  │ MinIO Upload │                                      │
│  └──────────────┘  └──────────────┘                                      │
└──────────────────────────────────────────────────────────────────────────┘
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

| Concern | Technology | Purpose |
|---------|-----------|---------|
| Runtime | Bun (compiled binaries) | TypeScript execution and binary compilation |
| Container | Node.js 22 (for Claude Code CLI) | Claude Code subprocess host |
| Orchestration | Kubernetes (K3s) | Pod scheduling and management |
| Storage | Longhorn (persistent volumes) | Session data persistence across restarts |
| Database | SQLite (bun:sqlite, WAL mode) | All session and activity persistence |
| State Machine | XState v5 | Session lifecycle with 7 states, 38 transitions |
| Message Broker | RabbitMQ (AMQP via amqplib) | Event distribution, command routing, heartbeats |
| Push Notifications | ntfy.sh | Mobile alerts for blocked/error/complete events |
| Terminal Streaming | Bun WebSocket (port 8080) | Live terminal output relay with mid-stream join |
| Session Recordings | Asciicast v2 + MinIO | Terminal recordings with presigned playback URLs |
| GitHub API | @octokit/rest + GraphQL | PRs, comments, project board mutations |
| Observability | OpenTelemetry → Alloy → Tempo/Mimir/Loki | Traces, metrics, logs |

## Prerequisites

- Kubernetes cluster (K3s recommended)
- Longhorn storage provisioner
- RabbitMQ instance (AMQP 0-9-1)
- MinIO or S3-compatible storage (for session recordings)
- GitHub App or PAT with repo permissions
- Claude Code OAuth token
- Alloy collector (for telemetry)
- ntfy.sh server (for push notifications, optional)

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
# Deploy runner pods, orchestrator, and supporting services
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
│   ├── shared/                # Canonical shared types
│   │   ├── types.ts           # SessionState, SessionEvent, AmqpMessage, etc.
│   │   └── index.ts           # Re-exports
│   ├── orchestrator/          # Orchestrator service
│   │   ├── index.ts           # Service entry point (AMQP + REST)
│   │   ├── webhook-handler.ts # HMAC-verified webhook → AMQP commands
│   │   ├── session-aggregator.ts # Cross-pod session state aggregation
│   │   ├── push-bridge.ts     # ntfy.sh push notifications
│   │   └── rest-api.ts        # REST API (sessions, answers, snapshots)
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
│       ├── db.ts              # SQLite database
│       ├── amqp.ts            # RabbitMQ AMQP client (publish, subscribe, heartbeats)
│       ├── state-machine.ts   # XState v5 session lifecycle machine
│       ├── terminal-relay.ts  # WebSocket relay, snapshots, asciicast recordings
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
├── schema.sql                 # SQLite schema
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

- **SQLite**: All session state, XState snapshots, activity logs, and terminal snapshots (WAL mode)
- **RabbitMQ**: Event distribution between runner pods and orchestrator
- **MinIO**: Asciicast v2 session recordings with presigned playback URLs
- **Longhorn**: Persists `~/.claude/` and SQLite database across pod restarts
- **Worktrees**: Isolated at `/home/runner/worktrees/issue-{N}/`

## Observability

### Traces

Sent to Tempo via Alloy (gRPC on port 4317):
- `orchestrate` - Full PR processing span
- `transition.*` - Column transition handlers
- `swarm.*` - Multi-agent operations
- `amqp.*` - RabbitMQ publish/consume operations

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
# Telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.alloy.svc.cluster.local:4317
OTEL_SERVICE_NAME=github-workflow-agents
OTEL_SERVICE_VERSION=4.0.0
DEPLOYMENT_ENVIRONMENT=production

# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@rabbitmq.default.svc.cluster.local:5672

# MinIO (for session recordings)
MINIO_ENDPOINT=http://minio.default.svc.cluster.local:9000
MINIO_BUCKET=gwa-recordings
MINIO_ACCESS_KEY=<access-key>
MINIO_SECRET_KEY=<secret-key>

# Push Notifications
NTFY_URL=https://ntfy.bto.bar/gwa

# Orchestrator
ORCHESTRATOR_PORT=3001
ORCHESTRATOR_DB_PATH=/tmp/gwa-orchestrator.db

# Terminal Streaming
WS_PORT=8080
```

## Database Schema

GWA uses SQLite with WAL mode for concurrent access. Key tables:

| Table | Purpose |
|-------|---------|
| `sessions` | Core session tracking with XState snapshot persistence |
| `questions` | Claude questions and answers |
| `agent_tasks` | Swarm worker task tracking |
| `activity_log` | Full audit trail |
| `checkpoints` | State snapshots for recovery |
| `commits` | Commits made by Claude |
| `terminal_snapshots` | SVG terminal snapshots (ansi-to-svg) |

See `schema.sql` for the full schema.

## Orchestrator Service

The orchestrator runs as a separate service that aggregates session state across all runner pods.

### REST API (port 3001)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with uptime, pod status, session count |
| `/sessions` | GET | List all active sessions across pods |
| `/sessions/:id` | GET | Session detail with activity feed |
| `/sessions/:id/answer` | POST | Send an answer to a blocked session |
| `/sessions/:id/snapshots` | GET | Terminal snapshots for a session |
| `/sessions/:id/recordings` | GET | Asciicast recordings for a session |

### Push Notifications

The push bridge subscribes to AMQP events and sends notifications via ntfy.sh:

| Event | Priority | Notification |
|-------|----------|-------------|
| Session blocked | High (4) | Human input needed |
| Session error | Urgent (5) | Session encountered an error |
| Session complete | Default (3) | Session finished |

Rate limiting: 30s debounce per session, 5-minute cooldown, 5 notifications/minute global cap.

## Terminal Streaming

Live terminal output is available via WebSocket on port 8080.

### WebSocket Connection

Connect to `ws://<pod-ip>:8080/ws/{sessionId}` to receive real-time terminal output. On connect, the current pane content is sent immediately for mid-stream join support.

### Snapshots

Terminal snapshots are captured as SVG via ansi-to-svg on state transitions and stored in SQLite for later retrieval.

### Recordings

Session recordings use the asciicast v2 format, uploaded to MinIO on session completion. Presigned URLs (1-hour expiry) are generated for playback.

## Security

### Webhook Verification
- Timing-safe HMAC signature verification (crypto.timingSafeEqual)
- Empty webhook secret fails closed (rejects all requests)
- Webhook delivery deduplication with 1-hour TTL prevents replay attacks

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
