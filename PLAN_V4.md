# GWA v4.0 Implementation Plan

**Date:** February 11, 2026
**Last Updated:** February 14, 2026
**Status:** Draft — Pending Review

## Overview

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

## Phase 0: Prerequisites

### 0.1 Configure RabbitMQ (Already in K3s)

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

### 0.2 Deploy ntfy.sh

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

### 0.3 Verify ansi-to-svg Bun Compatibility

```bash
bun add ansi-to-svg
bun -e "const a2s = require('ansi-to-svg'); console.log(typeof a2s)"
```

Fallback: use `ansi-to-html` (actively maintained) + wrap in SVG `<foreignObject>`.

### 0.4 Create MinIO Bucket

```bash
mc mb minio/gwa-recordings
mc ilm add minio/gwa-recordings --transition-days 7 --storage-class REDUCED_REDUNDANCY
mc ilm add minio/gwa-recordings --expiry-days 30
```

---

## Phase 1: Security Hardening

### 1.1 Fix Webhook Signature Verification

**File:** `src/webhook/handler.ts`

Changes:
- Import `timingSafeEqual` from `crypto`
- Change `verifySignature()` to return `false` when `WEBHOOK_SECRET` is empty (fail closed)
- Replace `===` string comparison with `timingSafeEqual` for the HMAC check
- Add length check before `timingSafeEqual` (mismatched lengths throw)

### 1.2 Add Webhook Delivery Deduplication

Use in-memory `Map<string, number>` with a 1-hour TTL for deduplication. GitHub retries happen within minutes, not hours. Migrate to SQLite if we need cross-restart deduplication later.

**File changes:**
- `src/webhook/handler.ts`: Check delivery map before processing. Insert delivery ID after processing.

---

## Phase 2: XState State Machine (Pod Level)

XState runs **inside each runner pod**, not in the webhook/orchestrator. The orchestrator publishes transition commands via RabbitMQ; the pod validates via XState before executing.

### 2.1 Install XState

```bash
bun add xstate@^5.26.0
```

### 2.2 Create State Machine Definition

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

### 2.3 State Persistence in SQLite

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

### 2.4 Integration with Orchestrator via RabbitMQ

The orchestrator publishes transition commands to `gwa.commands.{owner}.{repo}.transition`. Each pod subscribes to its own repo topic. On receiving a command:

1. Load XState actor from SQLite snapshot
2. Map column transition to XState event via `columnTransitionToEvent()`
3. Send event to actor -- XState validates the transition
4. If valid: persist snapshot, execute handler, publish state_change event
5. If invalid: publish error event, post GitHub comment explaining the invalid transition

This replaces the current `workflow_dispatch` -> GitHub Actions -> `kubectl exec` chain with direct RabbitMQ messaging.

### 2.5 Integrate with Transition Handlers

Each `src/transitions/*.ts` handler:
1. Loads the XState actor from SQLite snapshot
2. Verifies current state matches expected (defense in depth)
3. Performs its work (create session, run tests, etc.)
4. Updates context (e.g., `hasPlan = true` after planning completes)
5. Persists updated snapshot
6. Publishes state_change event to RabbitMQ

### 2.6 State Machine Tests

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

## Phase 3: Remove Redis (Complete)

Redis is embedded in **21 files** across the codebase. This phase removes ALL Redis references and consolidates on SQLite (local) + RabbitMQ (cross-service).

### 3.1 Source File Migrations

| File | Action |
|------|--------|
| `src/lib/redis.ts` | **DELETE** (190 lines, 12 functions) |
| `src/lib/repl-session.ts` | **REWRITE** -- migrate all 6 `getRedisClient()` calls to SQLite. Store REPL session state in `sessions` table (extend with `repl_session_id`, `repl_status` fields) |
| `src/orchestrate.ts` | **REWRITE** -- replace all 8 Redis calls (`getSession`, `createSession`, `updateSessionStatus`, `closeRedis`) with SQLite equivalents from `db.ts` |
| `src/health-check.ts` | **UPDATE** -- remove Redis health check, add SQLite health check (`PRAGMA integrity_check`) |
| `src/debug-redis.ts` | **DELETE** and replace with `src/debug-db.ts` that queries SQLite |
| `src/lib/telemetry.ts` | **UPDATE** -- remove `IORedisInstrumentation`, remove `Metrics.recordRedisOperation()` |
| `src/lib/types.ts` | **UPDATE** -- remove `PRSession` and `PRQuestion` Redis types, use canonical `SessionState` enum |

### 3.2 Test Migrations

| File | Action |
|------|--------|
| `src/tests/imports.test.ts` | Remove `redis.getRedisClient` and `redis.closeRedis` export checks |
| `src/tests/preflight.test.ts` | Remove `ioredis` dependency assertion, add `xstate`/`amqplib` assertions |
| `tests/helm-chart.test.ts` | Remove `REDIS_HOST`/`REDIS_PORT` assertions, add `RABBITMQ_URL` assertion |

### 3.3 Infrastructure Migrations

| File | Action |
|------|--------|
| `helm/gwa-runner/values.yaml` | Remove `redis` section, add `rabbitmq.url`, `ntfy.url`, `minio.endpoint` |
| `helm/gwa-runner/templates/configmap.yaml` | Replace `redis-cli SET` pod registration with `sqlite3` insert. Replace tmux status window `redis-cli SMEMBERS` with `sqlite3` query |
| `helm/gwa-runner/templates/statefulset.yaml` | Remove `REDIS_HOST`/`REDIS_PORT` env vars, add `RABBITMQ_URL` |
| `helm/gwa-runner/templates/cronjob-cleanup.yaml` | Remove Redis env vars |
| `k8s/gwa-runner-statefulset.yaml` | Remove Redis env vars, add `RABBITMQ_URL` |
| `k8s/gwa-cleanup-cronjob.yaml` | Remove Redis env vars |

### 3.4 Package Cleanup

| File | Action |
|------|--------|
| `package.json` | Remove `ioredis`, remove `@opentelemetry/instrumentation-ioredis`, remove `build:debug-redis` script |

### 3.5 Create SQLite Active Sessions View

```sql
CREATE VIEW active_sessions AS
SELECT * FROM sessions
WHERE status NOT IN ('done', 'error', 'cancelled')
ORDER BY last_activity_at DESC;
```

### 3.6 Ensure SQLite Write Safety

- Verify `busy_timeout = 5000` is set on every `getDatabase()` call (already done in `configurePragmas`)
- Verify write transactions use `BEGIN IMMEDIATE`
- Add retry logic for `SQLITE_BUSY` in critical paths

---

## Phase 4: RabbitMQ Backbone + Orchestrator Extraction

### 4.1 Install Dependencies

```bash
bun add amqplib@^0.10.7
bun add -d @types/amqplib
```

### 4.2 Create AMQP Publisher Module (Pod Side)

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

### 4.3 Integrate with Activity Logging

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

### 4.4 Publish XState Transitions

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

### 4.5 Extract Orchestrator Service

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

### 4.6 Push Notification Bridge (ntfy.sh)

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

### 4.7 REST API (Part of Orchestrator)

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

### 4.8 K8s & Network Configuration

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

## Phase 5: Live Terminal Streaming & Snapshots

### Design Principles

1. **Stream raw PTY bytes, not parsed output.** Immune to Claude Code platform changes.
2. **Single Bun process multiplexes all sessions.** No per-session daemons.
3. **Mid-stream join via snapshot + stream.** New viewers get current screen state instantly.
4. **Dual-write: live stream + asciicast recording.** Recordings uploaded to MinIO S3.
5. **Snapshots at lifecycle events.** Stored as SVG in SQLite + published via AMQP.

### 5.1 Terminal Relay Service

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

### 5.2 WebSocket Server (Multiplexed)

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

### 5.3 Snapshot Capture at Lifecycle Events

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

### 5.4 Asciicast v2 Recordings on MinIO S3

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

### 5.5 Mobile Viewer Integration

Live terminal streaming and recording playback are handled by the native Android app (Phase 6.4 and 6.7):

**Live streaming:** OkHttp WebSocket to `ws://10.43.x.x:8080/stream/{sessionId}` -> Termux TerminalView
**Recording playback:** Presigned MinIO S3 URL -> asciinema-player in WebView
**Snapshots:** SVG rendered from REST API endpoint on orchestrator

---

## Phase 6: Native Android Mobile App (Kotlin/Jetpack Compose)

### 6.1 Project Setup

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

### 6.2 App Structure

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

### 6.3 MQTT Connection Manager (Native TCP Primary)

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

### 6.4 Live Terminal Viewer (Termux TerminalView)

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

### 6.5 Push Notifications (ntfy.sh)

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

### 6.6 Notification Strategy

**Process-stopping events only:** `blocked`, `error`, `complete`. Everything else syncs via MQTT on foreground return.

**Throttling:** Handled server-side by the push bridge in the orchestrator (Phase 4.6).

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

### 6.7 Recording Playback

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

### 6.8 Settings Screen

- **Transport status:** Shows current connection (LAN TCP / WARP TCP / WSS) with latency
- **Always-on MQTT:** Toggle for foreground service
- **Battery optimization:** Detect if app is battery-optimized -> prompt user to whitelist
- **WARP status:** Check if Cloudflare One agent is installed and connected
- **Broker config:** Override private IP, port, WSS URL (for testing)
- **ntfy config:** Topic name, server URL

---

## Phase 7: Behavioral Test Suite

### 7.1 State Machine Tests

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

### 7.2 Webhook Deduplication Tests

**File:** `src/tests/webhook-dedup.test.ts`

- Duplicate delivery ID is rejected
- Different delivery IDs are both processed
- TTL cleanup removes old entries

### 7.3 AMQP Messaging Tests

**File:** `src/tests/amqp-messaging.test.ts`

- Events published with correct routing key
- Commands received and dispatched to XState
- Publish failure doesn't crash the handler
- Connection recovery after broker restart
- Message format matches GWAMessage schema

### 7.4 Session Lifecycle Tests

**File:** `src/tests/session-lifecycle.test.ts`

- Full Todo -> Done lifecycle with assertions at each step
- Blocked -> Resume preserves session state
- Pod restart recovery: interrupted sessions detected and resumable
- Concurrent sessions for different issues don't interfere
- Cleanup removes all artifacts (tmux window, worktree, DB records, MinIO recordings)

### 7.5 Terminal Relay Tests

**File:** `src/tests/terminal-relay.test.ts`

- FIFO read + WebSocket publish round-trip
- Mid-stream join delivers snapshot then incremental data
- Asciicast recording format validation
- MinIO S3 upload on session completion
- Snapshot capture at lifecycle events

---

## Phase 8: Documentation & Cleanup

### 8.1 Update README.md

- Replace ASCII state diagram with XState-generated diagram
- Update architecture section with orchestrator + RabbitMQ messaging
- Add mobile app section
- Update tech stack table (remove Redis, add XState, amqplib, ntfy.sh)
- Update security section (timing-safe HMAC, fail-closed verification)

### 8.2 Update CLAUDE.md

- Remove Redis from SDK stack table
- Add XState, amqplib, ntfy.sh to SDK stack table
- Add terminal relay to operational notes
- Add orchestrator architecture notes
- Update RabbitMQ configuration notes

### 8.3 Update CHANGELOG.md

Document all v4.0 changes.

---

## Task Checklist

### Phase 0: Prerequisites
- [ ] 0.1 Enable RabbitMQ plugins: `rabbitmq_mqtt`, `rabbitmq_web_mqtt`, `rabbitmq_management`
- [ ] 0.2 Verify MQTT connectivity and topic routing from within cluster
- [ ] 0.3 Deploy ntfy.sh to K3s cluster
- [ ] 0.4 Add Cloudflare tunnel route for ntfy (`ntfy.bto.bar`)
- [ ] 0.5 Create MinIO bucket `gwa-recordings` with lifecycle policies
- [ ] 0.6 Verify `ansi-to-svg` works with Bun (or identify fallback)
- [ ] 0.7 Create `src/shared/types.ts` with canonical enums and message schema

### Phase 1: Security Hardening
- [ ] 1.1 Import `timingSafeEqual` in `src/webhook/handler.ts`
- [ ] 1.2 Change `verifySignature()` to fail closed when secret is empty
- [ ] 1.3 Replace `===` with `timingSafeEqual` for HMAC comparison
- [ ] 1.4 Add length check before `timingSafeEqual`
- [ ] 1.5 Add in-memory deduplication `Map` with 1-hour TTL
- [ ] 1.6 Check `X-GitHub-Delivery` against dedup map before processing
- [ ] 1.7 Write tests for signature verification edge cases
- [ ] 1.8 Write tests for deduplication logic
- [ ] 1.9 Run `bun run typecheck` -- verify clean

### Phase 2: XState State Machine (Pod Level)
- [ ] 2.1 Install `xstate@^5.26.0`
- [ ] 2.2 Create `src/lib/state-machine.ts` with machine definition
- [ ] 2.3 Define all 7 states with transitions matching README
- [ ] 2.4 Implement guards: `hasNoActiveSession`, `planExists`, `previousWas*`
- [ ] 2.5 Implement `columnTransitionToEvent()` mapping function
- [ ] 2.6 Add `xstate_snapshot` and `xstate_schema_version` columns to sessions table
- [ ] 2.7 Implement `persistSnapshot()` and `restoreActor()` helper functions
- [ ] 2.8 Handle `undefined` -> `null` in JSON serialization
- [ ] 2.9 Integrate with AMQP command subscriber (replace workflow_dispatch chain)
- [ ] 2.10 Update each transition handler to load/verify/persist XState state
- [ ] 2.11 Map `blocked` state `previousState` context correctly
- [ ] 2.12 Publish `state_change` event to RabbitMQ on every transition
- [ ] 2.13 Write state machine unit tests (all valid transitions)
- [ ] 2.14 Write state machine unit tests (all invalid transitions)
- [ ] 2.15 Write state machine unit tests (guard conditions)
- [ ] 2.16 Write snapshot round-trip tests
- [ ] 2.17 Run `bun run typecheck` -- verify clean
- [ ] 2.18 Run `bun test` -- verify all pass

### Phase 3: Remove Redis (Complete -- 21 Files)
- [ ] 3.1 Delete `src/lib/redis.ts`
- [ ] 3.2 Rewrite `src/lib/repl-session.ts` -- migrate ALL 6 Redis operations to SQLite
- [ ] 3.3 Extend `sessions` table with REPL-specific fields (`repl_session_id`, `repl_status`)
- [ ] 3.4 Update `src/orchestrate.ts` -- replace all 8 Redis calls with SQLite
- [ ] 3.5 Update `src/health-check.ts` -- remove Redis check, add SQLite check
- [ ] 3.6 Delete `src/debug-redis.ts`, create `src/debug-db.ts`
- [ ] 3.7 Remove `build:debug-redis` script from `package.json`
- [ ] 3.8 Remove `IORedisInstrumentation` from `src/lib/telemetry.ts`
- [ ] 3.9 Remove `Metrics.recordRedisOperation()` and all call sites
- [ ] 3.10 Update `src/lib/types.ts` -- remove Redis types, use canonical `SessionState`
- [ ] 3.11 Create `active_sessions` SQL view
- [ ] 3.12 Remove `ioredis` from `package.json`
- [ ] 3.13 Remove `@opentelemetry/instrumentation-ioredis` from `package.json`
- [ ] 3.14 Update `src/tests/imports.test.ts` -- remove Redis export checks
- [ ] 3.15 Update `src/tests/preflight.test.ts` -- remove `ioredis` assertion, add `xstate`/`amqplib`
- [ ] 3.16 Update `tests/helm-chart.test.ts` -- remove Redis assertions, add RabbitMQ
- [ ] 3.17 Update Helm `values.yaml` -- remove `redis` section, add `rabbitmq`, `ntfy`, `minio`
- [ ] 3.18 Update Helm `configmap.yaml` -- replace `redis-cli` with `sqlite3` commands
- [ ] 3.19 Update Helm `statefulset.yaml` -- remove `REDIS_HOST`/`REDIS_PORT`, add `RABBITMQ_URL`
- [ ] 3.20 Update Helm `cronjob-cleanup.yaml` -- remove Redis env vars
- [ ] 3.21 Update `k8s/gwa-runner-statefulset.yaml` -- remove Redis env vars
- [ ] 3.22 Update `k8s/gwa-cleanup-cronjob.yaml` -- remove Redis env vars
- [ ] 3.23 Verify `busy_timeout = 5000` on all `getDatabase()` calls
- [ ] 3.24 Verify write transactions use `BEGIN IMMEDIATE`
- [ ] 3.25 Add `SQLITE_BUSY` retry logic for critical paths
- [ ] 3.26 Run `bun run typecheck` -- verify clean
- [ ] 3.27 Run `bun test` -- verify all pass

### Phase 4: RabbitMQ Backbone + Orchestrator Extraction
- [ ] 4.1 Install `amqplib@^0.10.7` and `@types/amqplib`
- [ ] 4.2 Create `src/lib/amqp.ts` -- singleton connection + auto-reconnect + publisher confirms
- [ ] 4.3 Implement `publishEvent()` with routing key `gwa.events.{owner}.{repo}.{session}.{eventType}`
- [ ] 4.4 Implement `subscribeCommands()` for `gwa.commands.{owner}.{repo}.#`
- [ ] 4.5 Integrate with `logActivity()` in `src/lib/db.ts` (fire-and-forget)
- [ ] 4.6 Publish heartbeat every 30s to `gwa.heartbeat.{owner}.{repo}`
- [ ] 4.7 Create `src/orchestrator/` directory structure
- [ ] 4.8 Move webhook handler logic to `src/orchestrator/webhook-handler.ts`
- [ ] 4.9 Create `src/orchestrator/session-aggregator.ts` -- subscribe to all pod events
- [ ] 4.10 Create `src/orchestrator/rest-api.ts` with Bun.serve
- [ ] 4.11 Implement all REST endpoints (sessions, answer, snapshots, recordings)
- [ ] 4.12 Create `src/orchestrator/push-bridge.ts` -- ntfy.sh integration
- [ ] 4.13 Implement per-session debounce (30s) in push bridge
- [ ] 4.14 Implement global rate limit (5 notifications/minute)
- [ ] 4.15 Implement per-session cooldown (5 minutes)
- [ ] 4.16 Create orchestrator's own SQLite database for aggregated state
- [ ] 4.17 Create `Dockerfile.orchestrator` for orchestrator image
- [ ] 4.18 Create K8s Deployment manifest for orchestrator
- [ ] 4.19 Add `RABBITMQ_URL` env var to runner StatefulSet
- [ ] 4.20 Add MQTT WebSocket Cloudflare tunnel route (WSS fallback)
- [ ] 4.21 Configure Cloudflare Tunnel private network route for WARP path
- [ ] 4.22 Configure Zero Trust Split Tunnels to include K3s service CIDR
- [ ] 4.23 Enable `rabbitmq_mqtt` + `rabbitmq_web_mqtt` plugins
- [ ] 4.24 Write AMQP publish/subscribe tests (mock broker)
- [ ] 4.25 Write push bridge throttling tests
- [ ] 4.26 Write orchestrator REST API tests
- [ ] 4.27 Run `bun run typecheck` -- verify clean
- [ ] 4.28 Run `bun test` -- verify all pass

### Phase 5: Live Terminal Streaming & Snapshots
- [ ] 5.1 Create `src/lib/terminal-relay.ts` -- main relay service module
- [ ] 5.2 Implement `startPaneStream()` -- mkfifo + tmux pipe-pane + FIFO reader
- [ ] 5.3 Implement `stopPaneStream()` -- detach pipe-pane + close FIFO + upload to MinIO
- [ ] 5.4 Implement Bun WebSocket server with pub/sub topics per pane
- [ ] 5.5 Implement mid-stream join -- `capture-pane -e -p` snapshot on WebSocket connect
- [ ] 5.6 Implement asciicast v2 dual-write (NDJSON append alongside live stream)
- [ ] 5.7 Add `terminal_snapshots` table to `schema.sql`
- [ ] 5.8 Implement `takeSnapshot()` -- capture-pane + ansi-to-svg + SQLite store
- [ ] 5.9 Integrate snapshot triggers with XState transition actions
- [ ] 5.10 Install `ansi-to-svg` npm package (or fallback)
- [ ] 5.11 Install `@aws-sdk/client-s3` for MinIO uploads
- [ ] 5.12 Implement MinIO S3 upload on session completion
- [ ] 5.13 Add presigned URL generation for recording playback
- [ ] 5.14 Integrate `startPaneStream()` into session creation workflow
- [ ] 5.15 Integrate `stopPaneStream()` into session cleanup workflow
- [ ] 5.16 Add `build:terminal-relay` script to `package.json`
- [ ] 5.17 Add Cloudflare tunnel route for terminal relay (`terminal.bto.bar` -> `:8080`)
- [ ] 5.18 Add port 8080 to runner Service/StatefulSet
- [ ] 5.19 Write tests: FIFO read + WebSocket publish round-trip
- [ ] 5.20 Write tests: mid-stream join snapshot + incremental data
- [ ] 5.21 Write tests: asciicast recording format validation
- [ ] 5.22 Write tests: MinIO S3 upload
- [ ] 5.23 Write tests: snapshot capture at lifecycle events
- [ ] 5.24 Run `bun run typecheck` -- verify clean
- [ ] 5.25 Run `bun test` -- verify all pass

### Phase 6: Native Android App (Kotlin/Jetpack Compose)
- [ ] 6.1 Create Android Studio project with Compose template (`bar.bto.gwa`)
- [ ] 6.2 Add JitPack repo + Termux terminal-view/emulator dependencies
- [ ] 6.3 Add Paho MQTT Android + OkHttp + Retrofit dependencies (NO Firebase)
- [ ] 6.4 Create `TransportDetector` -- LAN probe -> WARP probe -> WSS fallback
- [ ] 6.5 Create `MqttManager` -- native TCP primary, WSS fallback, auto-reconnect
- [ ] 6.6 Create `MqttForegroundService` -- optional always-on background MQTT
- [ ] 6.7 Create `TerminalRelayClient` -- OkHttp WebSocket to relay server
- [ ] 6.8 Create `TerminalSessionBridge` -- pipe WebSocket bytes -> TerminalSession
- [ ] 6.9 Build `TerminalScreen` -- Termux TerminalView in AndroidView (read-only, 200x50)
- [ ] 6.10 Build `TerminalViewModel` -- manages WebSocket connection + mid-stream join
- [ ] 6.11 Build `SessionListScreen` + ViewModel -- REST initial load + MQTT real-time updates
- [ ] 6.12 Build `SessionDetailScreen` + ViewModel -- activity feed + state indicator
- [ ] 6.13 Build `AnswerDialog` -- answer blocked session questions via REST
- [ ] 6.14 Build `StateIndicator` -- color-coded XState state chip composable
- [ ] 6.15 Build `SnapshotViewer` -- SVG/ANSI snapshot display
- [ ] 6.16 Build `RecordingScreen` -- asciinema-player with presigned MinIO URLs
- [ ] 6.17 Build `SettingsScreen` -- transport status, always-on toggle, ntfy config, battery guide
- [ ] 6.18 Create `NtfyReceiver` -- subscribe to ntfy.sh topic for push notifications
- [ ] 6.19 Create notification channels (action-required + completions) in Application.onCreate
- [ ] 6.20 Handle notification deep links -- navigate to session/answer dialog
- [ ] 6.21 Implement `AppLifecycleObserver` -- foreground sync (MQTT + REST safety net)
- [ ] 6.22 Implement `BatteryOptimization` helper -- detect + prompt for whitelisting
- [ ] 6.23 Add Compose navigation graph with deep link support
- [ ] 6.24 Build signed APK
- [ ] 6.25 Test on physical device -- LAN TCP path
- [ ] 6.26 Test on physical device -- WARP TCP path
- [ ] 6.27 Test on physical device -- WSS fallback
- [ ] 6.28 Test live terminal -- 200 cols, truecolor, scrollback, cursor
- [ ] 6.29 Test recording playback -- speed control, idle compression
- [ ] 6.30 Test ntfy push -- only blocked/error/complete arrive
- [ ] 6.31 Test notification throttling -- concurrent sessions don't flood
- [ ] 6.32 Test foreground resume sync -- missed MQTT messages appear
- [ ] 6.33 Test foreground service MQTT -- verify connection survives screen-off
- [ ] 6.34 Test battery optimization whitelist prompt

### Phase 7: Behavioral Tests
- [ ] 7.1 Write full session lifecycle test (Todo -> Done)
- [ ] 7.2 Write blocked -> resume lifecycle test
- [ ] 7.3 Write RabbitMQ command -> pod XState transition test
- [ ] 7.4 Write orchestrator aggregation test (events from multiple pods)
- [ ] 7.5 Write concurrent session isolation test
- [ ] 7.6 Write cleanup artifact verification test (tmux + worktree + DB + MinIO)
- [ ] 7.7 Write terminal relay integration test (stream start -> data -> snapshot -> upload)
- [ ] 7.8 Run full test suite -- verify all pass

### Phase 8: Documentation & Cleanup
- [ ] 8.1 Update `README.md` -- architecture, tech stack, orchestrator, RabbitMQ
- [ ] 8.2 Update `CLAUDE.md` -- remove Redis, add XState/amqplib/ntfy.sh/MinIO
- [ ] 8.3 Update `CHANGELOG.md` with v4.0 changes
- [ ] 8.4 Bump `package.json` version to 4.0.0
- [ ] 8.5 Final `bun run typecheck` + `bun test`
- [ ] 8.6 Build all binaries: `bun run build`
- [ ] 8.7 Build and push runner Docker image
- [ ] 8.8 Build and push orchestrator Docker image
- [ ] 8.9 Deploy orchestrator to K3s
- [ ] 8.10 Deploy updated runner to K3s
- [ ] 8.11 End-to-end test: webhook -> RabbitMQ -> pod -> MQTT -> mobile + ntfy push

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
| Redis removal regression | Medium | High | Comprehensive test suite (Phase 7) validates all paths before deployment |
| `ansi-to-svg` Bun incompatibility | Low | Low | Fallback: `ansi-to-html` + SVG foreignObject wrapper |
