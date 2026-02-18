# Handoff: GWA v4.0 — Complete Architecture

## Overview

**Version:** 4.0.0 (February 17, 2026)

GitHub Workflow Agents (GWA) v4.0 is a complete architectural overhaul. The system now uses XState v5 for state management, RabbitMQ for event distribution, and a dedicated orchestrator service for cross-pod coordination. Redis has been fully removed.

## Current State

**Completed Phases:** 15 (Prerequisites), 16 (Security Hardening), 17 (XState), 18 (Remove Redis), 19 (RabbitMQ + Orchestrator), 20 (Terminal Streaming — except 20.17 tunnel route), 22 (Behavioral Tests)

### What's Working
- **Webhook deployed**: `gwa-webhook` pod running in K8s default namespace
- **Cloudflare tunnel**: `git-hooks.bto.bar` routes to webhook via `bto-services-prod` tunnel
- **GitHub App**: `Workflow-Agents-BTO` installed on `bto-labs` org with `projects_v2_item` events
- **XState v5 state machine**: 7 states, 38 transitions with snapshot persistence in SQLite
- **RabbitMQ AMQP backbone**: Topic exchanges for events, commands, and heartbeats
- **Orchestrator service**: REST API, session aggregator, push bridge (ntfy.sh)
- **Terminal streaming**: WebSocket relay on port 8080 with mid-stream join
- **Session recordings**: Asciicast v2 format with MinIO upload and presigned URLs
- **Terminal snapshots**: SVG via ansi-to-svg stored in SQLite
- **Security**: Timing-safe HMAC verification, webhook deduplication (1-hour TTL)
- **Shared types**: Canonical types in `src/shared/types.ts`
- **Cross-org access**: Webhook resolves issue details from `bto-labs` before triggering workflows
- **Binaries deployed**: `gwa-*` binaries in the pod at `/usr/local/bin/`
- **SQLite persistence**: All session state, XState snapshots, activity logs (WAL mode)
- **Behavioral tests**: Full lifecycle test suite

### Remaining Manual Steps
- **Cloudflare tunnel route for terminal relay**: `terminal.bto.bar` → `:8080` (Phase 20.17 — manual infrastructure config)

### What Was Removed in v4.0
- **Redis**: Completely removed (ioredis, instrumentation, redis.ts, debug-redis.ts)
- **workflow_dispatch chain**: Replaced by AMQP command publishing

## Architecture

```
GitHub Project (bto-labs)
       |
       | projects_v2_item webhook
       v
+------------------------------------------+
|         Orchestrator Service              |
|  Webhook Handler | REST API (port 3001)  |
|  Push Bridge     | Session Aggregator    |
+---------+--------------------------------+
          | AMQP commands       ^ AMQP events
          v                     |
+------------------------------------------+
|              RabbitMQ                     |
|  gwa.commands | gwa.events | gwa.heartbeat|
+---------+----------------------------+---+
          | commands                   ^ events
          v                            |
+------------------------------------------+
|        GWA Runner Pod (StatefulSet)       |
|  XState v5   | Claude Code (tmux)        |
|  Terminal Relay (WS :8080)  | SQLite     |
|  OTEL -> Alloy | MinIO Upload            |
+------------------------------------------+
```

## Key Components

### XState v5 State Machine (`src/lib/state-machine.ts`)
- 7 states: idle, planning, inProgress, qa, blocked, review, done
- 38 column-to-event mappings matching all valid GitHub Project transitions
- Guards for blocked state return (previousWasPlanning, previousWasInProgress, etc.)
- Snapshot persistence to SQLite `sessions.xstate_snapshot` column
- Automatic AMQP state change publishing on transitions

### RabbitMQ AMQP (`src/lib/amqp.ts`)
- Singleton connection with auto-reconnect (exponential backoff)
- Publisher confirms via ConfirmChannel
- Three topic exchanges: `gwa.events`, `gwa.commands`, `gwa.heartbeat`
- 30-second heartbeat interval with pod health monitoring
- Graceful shutdown with SIGTERM/SIGINT handlers

### Orchestrator (`src/orchestrator/`)
- **index.ts**: Service entry point, initializes its own SQLite DB, AMQP, REST API
- **webhook-handler.ts**: HMAC verification, deduplication, publishes AMQP commands
- **session-aggregator.ts**: Subscribes to `gwa.events.#`, maintains cross-pod state
- **push-bridge.ts**: ntfy.sh notifications with debounce (30s) and rate limiting (5/min)
- **rest-api.ts**: Sessions, answers, snapshots, recordings endpoints

### Terminal Relay (`src/lib/terminal-relay.ts`)
- WebSocket server on port 8080 at `/ws/{sessionId}`
- tmux pipe-pane -> FIFO -> reader process -> WebSocket broadcast
- Asciicast v2 recording written alongside stream
- SVG snapshots via ansi-to-svg stored in SQLite
- MinIO upload on stream stop with presigned URL generation

### Shared Types (`src/shared/types.ts`)
- `SessionState` enum (7 states)
- `SessionEvent` union type (17 event types)
- `AmqpMessage` interface (routing key, payload, timestamp, sessionId, traceId)
- `PushNotification` interface (type, title, body, priority, tags)
- `TerminalSnapshot` interface (sessionId, svgData, eventType, capturedAt)
- `RecordingMetadata` interface (s3Key, durationMs, sizeBytes, format)
- `ColumnTransition` interface (from, to, itemId, projectId)
- `SessionContext` interface (XState machine context)

## Handler Reference

Each handler is triggered by a column transition and executes in the workflow:

| Handler | Transition | What It Does |
|---------|------------|-------------|
| `start-planning` | Todo -> Planning | Create session, start Claude REPL for planning |
| `inject-prompt` | Planning -> In Progress | Send implementation prompt to existing session |
| `run-playwright` | In Progress -> QA | Run Playwright e2e tests |
| `status-update` | QA -> Review | Post summary comment, notify reviewers |
| `deploy-and-cleanup` | Review -> Done | Merge PR, cleanup session |
| `pause-for-question` | Any -> Blocked | Pause session, post question to issue |
| `send-answer` | Blocked -> Any | Resume session with answer |
| `resume-with-failures` | QA -> In Progress | Resume with test failure context |
| `request-retest` | Review -> QA | Re-run tests |
| `request-replanning` | Any -> Planning | Reset session to planning phase |
| `resume-implementation` | Review -> In Progress | Resume implementation work |
| `cancel-session` | Any -> Todo | Cancel and cleanup session |
| `reopen-issue` | Done -> Any | Create new session for reopened issue |
| `quick-start` | Todo -> In Progress | Skip planning, start implementation directly |
| `close-without-work` | Any -> Done | Close without implementation |
| `skip-qa` | In Progress -> Review | Skip tests, go to review |
| `skip-implementation` | Planning -> QA | Pre-built solution, skip to QA |

## Files to Understand

### Core v4.0 Files
- **`src/shared/types.ts`**: All canonical types
- **`src/lib/state-machine.ts`**: XState v5 session lifecycle
- **`src/lib/amqp.ts`**: RabbitMQ AMQP client
- **`src/lib/terminal-relay.ts`**: WebSocket streaming, snapshots, recordings
- **`src/orchestrator/index.ts`**: Orchestrator service entry point

### Webhook Handler
- **`src/webhook/handler.ts`**: Receives GitHub webhooks, maps transitions to handlers
- **`src/orchestrator/webhook-handler.ts`**: HMAC-verified webhook -> AMQP commands

### CLI Tools
- **`src/architect.ts`**: Creates plans, spawns workers
- **`src/cleanup.ts`**: Cleans up sessions
- **`src/respond.ts`**: Handles @claude-answer responses
- **`src/orchestrate.ts`**: Main PR orchestration

### Database
- **`schema.sql`**: SQLite schema
- **`src/lib/db.ts`**: Database client with WAL mode

## Environment Variables

```bash
# RabbitMQ
RABBITMQ_URL=amqp://guest:guest@rabbitmq.default.svc.cluster.local:5672

# MinIO
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

# Telemetry
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy.alloy.svc.cluster.local:4317
OTEL_SERVICE_NAME=github-workflow-agents
OTEL_SERVICE_VERSION=4.0.0
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

# Orchestrator logs
kubectl logs -l component=orchestrator -f

# Exec into runner pod
kubectl exec -it gwa-runner-0 -- bash

# Check RabbitMQ queues
kubectl exec -it rabbitmq-0 -- rabbitmqctl list_queues

# Check workflow runs
gh run list --workflow=project-sync.yml --limit=10
```
