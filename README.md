# GitHub Workflow Agents (GWA)

Automated Claude Code integration for GitHub PRs with persistent sessions on Kubernetes. Manage AI-powered code review and implementation through GitHub issues and pull requests.

## Overview

GWA runs Claude Code in long-lived Kubernetes pods with tmux session management. When a PR is opened or updated, Claude automatically reviews code, implements changes, and responds to feedback—all while maintaining conversation context across interactions.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  GitHub Action  │────▶│  GWA Runner Pod  │────▶│   Claude Code   │
│   (trigger)     │     │  (StatefulSet)   │     │   (in tmux)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
              ┌─────────┐ ┌────────┐ ┌─────────┐
              │  Redis  │ │ Longhorn│ │  Alloy  │
              │(sessions)│ │(storage)│ │ (OTEL) │
              └─────────┘ └────────┘ └─────────┘
```

## Features

- **Persistent Sessions**: Claude conversations persist across pod restarts via Longhorn storage
- **Git Worktrees**: Each PR gets an isolated worktree for safe parallel work
- **Session Tracking**: Redis tracks PR-to-tmux-window mappings with 7-day TTL
- **Observability**: Full OpenTelemetry instrumentation (traces, metrics, logs) via Grafana LGTM stack
- **Auto-Instrumentation**: Automatic tracing for Redis and HTTP calls

## Architecture

### Components

| Component | Description |
|-----------|-------------|
| `gwa-orchestrate` | Main PR work lifecycle - creates worktrees, runs Claude |
| `gwa-respond` | Handles `@claude-answer` responses from users |
| `gwa-cleanup` | CronJob that cleans up stale PR sessions |
| `gwa-health-check` | Liveness/readiness probe endpoint |
| `gwa-debug-redis` | Debug utility for Redis inspection |

### Tech Stack

| Concern | Technology |
|---------|------------|
| Runtime | Bun (compiled binaries) |
| Container | Node.js 22 (for Claude Code CLI) |
| Orchestration | Kubernetes (K3s) |
| Storage | Longhorn (persistent volumes) |
| Session State | Redis (ioredis) |
| GitHub API | @octokit/rest |
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
  --from-literal=claude-oauth-token=sk-ant-xxxx
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

### 4. Configure GitHub Actions

Add workflows that trigger `gwa-orchestrate` on PR events:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  orchestrate:
    runs-on: self-hosted
    steps:
      - name: Run GWA Orchestrate
        run: |
          gwa-orchestrate \
            --pr ${{ github.event.pull_request.number }} \
            --repo ${{ github.repository }} \
            --trigger pr_opened \
            --actor ${{ github.actor }}
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

# Build binaries
bun run build
```

### Building the Container

```bash
# Build locally
docker build -t ghcr.io/jaybrto/github-workflow-agents:dev .

# Or push to trigger CI build
git push origin main
```

### Running Locally

```bash
# Port-forward Redis
kubectl port-forward svc/redis 6379:6379 &

# Port-forward Alloy (for telemetry)
kubectl port-forward -n alloy svc/alloy 4317:4317 4318:4318 &

# Run orchestrate
OTEL_SERVICE_NAME=github-workflow-agents \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 \
REDIS_HOST=localhost \
bun run src/orchestrate.ts --pr 123 --repo owner/repo --trigger manual
```

## CLI Tools

### gwa-orchestrate

Main entry point for PR processing.

```bash
gwa-orchestrate \
  --pr <number> \
  --repo <owner/repo> \
  --trigger <pr_opened|pr_updated|comment|manual> \
  [--branch <branch-name>] \
  [--comment <comment-text>] \
  [--actor <github-username>]
```

### gwa-respond

Handle user responses to Claude questions.

```bash
gwa-respond \
  --pr <number> \
  --repo <owner/repo> \
  --comment <answer-text> \
  --actor <github-username>
```

### gwa-cleanup

Clean up stale sessions (usually run via CronJob).

```bash
gwa-cleanup [--dry-run]
```

## Observability

GWA uses OpenTelemetry for full observability:

### Traces

Sent to Tempo via Alloy (gRPC on port 4317):
- `orchestrate` - Full PR processing span
- `respond` - Answer handling span
- `redis.*` - Auto-instrumented Redis commands
- `HTTP *` - Auto-instrumented HTTP calls

### Metrics

Sent to Mimir via Alloy:
- `gwa_pr_orchestrations_total` - PR orchestration runs
- `gwa_pr_responses_total` - Response handling runs
- `gwa_claude_invocations_total` - Claude CLI invocations
- `gwa_claude_duration_seconds` - Claude invocation duration
- `gwa_github_api_calls_total` - GitHub API calls
- `gwa_sessions_active` - Active Claude sessions

### Logs

Sent to Loki via Alloy (HTTP on port 4318):
- Structured JSON logs with trace correlation
- Automatic `trace_id` and `span_id` injection

### Environment Variables

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.alloy.svc.cluster.local:4317
OTEL_SERVICE_NAME=github-workflow-agents
OTEL_SERVICE_VERSION=1.0.0
DEPLOYMENT_ENVIRONMENT=production
```

## Project Structure

```
├── .claude/                    # Claude Code configuration
│   ├── CLAUDE.md              # Project context for Claude
│   ├── commands/              # Simple slash commands
│   └── skills/                # Complex multi-file skills
├── .github/workflows/         # GitHub Actions
│   └── build-image.yml        # Container build workflow
├── k8s/                       # Kubernetes manifests
│   ├── gwa-runner-statefulset.yaml
│   ├── gwa-cleanup-cronjob.yaml
│   └── ...
├── src/
│   ├── orchestrate.ts         # Main PR orchestration
│   ├── respond.ts             # Answer handling
│   ├── cleanup.ts             # Stale session cleanup
│   ├── health-check.ts        # Health probe
│   ├── debug-redis.ts         # Redis debug tool
│   └── lib/
│       ├── claude.ts          # Claude Code subprocess
│       ├── github.ts          # GitHub API client
│       ├── redis.ts           # Redis client
│       ├── tmux.ts            # Tmux session management
│       ├── git.ts             # Git operations
│       ├── telemetry.ts       # OpenTelemetry setup
│       └── types.ts           # TypeScript types
├── Dockerfile                 # Multi-stage build
├── package.json
└── tsconfig.json
```

## How It Works

### PR Workflow

1. **PR Opened/Updated**: GitHub Action triggers `gwa-orchestrate`
2. **Session Check**: Check Redis for existing session
3. **Worktree Setup**: Create/update git worktree for the PR
4. **Claude Execution**: Run Claude Code with the PR context
5. **Result Handling**: Post comments, update status checks
6. **Session Persistence**: Store session info in Redis

### Question Flow

1. **Claude Asks**: Claude posts a question via PR comment
2. **User Answers**: User replies with `@claude-answer: <response>`
3. **Answer Processed**: GitHub Action triggers `gwa-respond`
4. **Session Resumed**: Claude continues with `--continue` flag

### Session Persistence

- **Redis**: Tracks PR → tmux window mappings (7-day TTL)
- **Longhorn**: Persists `~/.claude/` directory across restarts
- **Worktrees**: Isolated git worktrees in `/home/runner/worktrees/pr-{N}/`

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/issue-123-description`
3. Make changes following the existing code style
4. Run type checks: `bun run typecheck`
5. Commit with conventional commits: `git commit -m "feat(scope): description"`
6. Push and open a PR

## License

MIT
