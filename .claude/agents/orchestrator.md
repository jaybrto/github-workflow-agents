# Orchestrator Agent

You are a specialized agent for building the extracted orchestrator service in GWA (v4.0 feature).

## Your Scope

The orchestrator is a **centralized control plane** that runs in its own pod, separate from repo runner pods.

### Files to Create
- `src/orchestrator/server.ts` - HTTP server + RabbitMQ subscriber
- `src/orchestrator/webhook-handler.ts` - Migrated webhook logic
- `src/orchestrator/session-manager.ts` - Global session view across all pods
- `src/orchestrator/push-bridge.ts` - ntfy.sh notification bridge
- `src/orchestrator/api.ts` - REST API for mobile app
- `k8s/gwa-orchestrator.yaml` - Orchestrator deployment

### Files to Modify
- `src/webhook/handler.ts` - Extract shared logic to orchestrator
- Cloudflare Tunnel configuration - Add orchestrator route

## Architecture

```
GitHub Project (bto-labs)
       │ projects_v2_item webhook
       ▼
Orchestrator Service (own pod)
  ├── Webhook receiver
  ├── RabbitMQ pub/sub
  ├── REST API for mobile
  ├── Push bridge (ntfy.sh)
  ├── Global session view
  └── SQLite (aggregated state)
       │
       │ RabbitMQ (commands down, events up)
       ▼
gwa-runner-0..N pods (one per repo)
```

## Responsibilities

1. **Webhook Reception:** Receive GitHub webhooks, validate, dedup
2. **Command Publishing:** Publish transition commands to correct repo pod via RabbitMQ
3. **Event Aggregation:** Subscribe to all pod events, maintain global state
4. **REST API:** Serve session state, trigger actions from mobile app
5. **Push Bridge:** Forward process-stopping events to ntfy.sh
6. **Health Monitoring:** Track pod heartbeats, detect failures

## REST API (for mobile app)

```
GET  /api/sessions                    # List all active sessions
GET  /api/sessions/:id                # Get session details
POST /api/sessions/:id/answer         # Send answer to blocked session
POST /api/sessions/:id/cancel         # Cancel session
GET  /api/repos                       # List monitored repos
GET  /api/repos/:owner/:repo/status   # Repo status summary
```

## Conventions

- Runs as a Deployment (not StatefulSet - stateless with SQLite for cache)
- SQLite stores aggregated state from all pods (cache, not source of truth)
- Source of truth is each pod's local SQLite
- Use AMQP topic exchange for routing
- Cloudflare Tunnel route: `git-hooks.bto.bar` -> orchestrator

## Dependencies

```
amqplib@^0.10.7, @octokit/rest, bun:sqlite
```
