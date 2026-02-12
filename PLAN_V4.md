# GWA v4.0 Implementation Plan

**Date:** February 11, 2026
**Status:** Draft — Pending Review

## Overview

This plan upgrades GWA from a lookup-table state machine with dual persistence to a formally verified XState state machine with SQLite-only persistence, real-time MQTT streaming to a React Native (Expo) mobile app, and hardened webhook handling.

### Architecture After v4.0

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GitHub Project Board (bto-labs)                                         │
│  Columns: Todo │ Planning │ In Progress │ QA │ Blocked │ Review │ Done   │
└──────────┬───────────────────────────────────────────────────────────────┘
           │ projects_v2_item webhook
           ▼
┌──────────────────────┐
│  gwa-webhook pod     │  ← Cloudflare tunnel (git-hooks.bto.bar)
│  Bun HTTP server     │
│  + Deduplication     │
│  + Timing-safe HMAC  │
└──────────┬───────────┘
           │ workflow_dispatch API
           ▼
┌──────────────────────┐
│  GitHub Actions      │  ← project-sync.yml (self-hosted runner)
│  kubectl exec        │
└──────────┬───────────┘
           ▼
┌──────────────────────────────────────────────────────────────┐
│  gwa-runner-0 pod (StatefulSet + Longhorn PVC)               │
│                                                               │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ XState v5   │──▶│ SQLite (WAL) │──▶│ AMQP Publisher   │  │
│  │ State       │   │ Single       │   │ (amqplib)        │  │
│  │ Machine     │   │ Source of    │   │ → amq.topic      │  │
│  │ + Guards    │   │ Truth        │   │   exchange       │  │
│  │ + Actions   │   │              │   │                  │  │
│  └─────────────┘   └──────────────┘   └────────┬─────────┘  │
│                                                  │            │
│  ┌─────────────┐   ┌──────────────┐             │            │
│  │ Claude Code │   │ tmux         │             │            │
│  │ Subprocess  │   │ Sessions     │             │            │
│  └─────────────┘   └──────────────┘             │            │
└──────────────────────────────────────────────────┼────────────┘
                                                   │
                                                   │ AMQP 0.9.1
                                                   ▼
                                        ┌──────────────────────┐
                                        │  RabbitMQ            │
                                        │  (existing K3s)      │
                                        │  rabbitmq_mqtt       │
                                        │  port 1883 (native)  │
                                        │  + rabbitmq_web_mqtt │
                                        │  port 15675 /ws      │
                                        └──────────┬───────────┘
                                                   │
                    ┌──────────────────────────────┼──────────────────┐
                    │                              │                  │
                    ▼ (Primary)                    ▼ (Fallback)       ▼
         ┌────────────────────┐       ┌──────────────────┐  ┌───────────────┐
         │ WARP + Private Net │       │ Cloudflare Tunnel│  │ Push Bridge   │
         │ Zero Trust Gateway │       │ wss://mqtt.bto.  │  │ (sidecar)     │
         │ 10.43.x.x:1883    │       │ bar/ws           │  │ MQTT → Expo   │
         │ raw TCP (8hr idle) │       │ (100s timeout)   │  │ Push API      │
         └────────┬───────────┘       └────────┬─────────┘  └───────┬───────┘
                  │                             │                    │
                  ▼                             ▼                    ▼
         ┌─────────────────────────────────────────────────────────────────┐
         │  Native Android App (Kotlin/Jetpack Compose)                    │
         │                                                                 │
         │  Terminal: Termux terminal-view (native Canvas, 200x50)        │
         │  MQTT:     Paho native TCP (LAN/WARP) or WSS (fallback)       │
         │  FG Svc:   Optional always-on MQTT via foreground service      │
         │  BG Push:  Firebase FCM (process-stopping events only)         │
         │  Resume:   Sync missed MQTT messages on foreground return      │
         │  Relay:    OkHttp WebSocket to terminal relay (raw PTY bytes)  │
         │                                                                 │
         │  Notification throttling: grouped + debounced per-session      │
         └─────────────────────────────────────────────────────────────────┘
```

### Connectivity Model: LAN TCP → WARP TCP → WSS Fallback

The native Android app supports three MQTT connectivity paths (tried in order):

| Path | Transport | Idle Timeout | Requires | When Used |
|------|-----------|-------------|----------|-----------|
| **LAN (primary)** | Native TCP to `10.43.x.x:1883` | **Unlimited** (direct) | On homelab WiFi/LAN | Device on local network |
| **WARP (secondary)** | Native TCP to `10.43.x.x:1883` via WireGuard | **8 hours** (Gateway proxy) | Cloudflare One agent | Away from home, WARP active |
| **WSS (fallback)** | WebSocket to `wss://mqtt.bto.bar/ws` | **100 seconds** | Nothing extra | WARP unavailable |

The app probes the private RabbitMQ IP on startup. If reachable (LAN or WARP), it uses native MQTT TCP — no WebSocket, no tunnel, no `rabbitmq_web_mqtt` plugin needed. Only falls back to WSS when the private IP is unreachable. Native TCP also means `rabbitmq_mqtt` plugin (port 1883) is the primary, not `rabbitmq_web_mqtt` (port 15675).

---

## Research Findings — Gotchas to Account For

### XState v5 + Bun

- **Compatibility:** No known issues. Zero-dependency pure ESM. Works with `bun build --compile`.
- **Latest version:** `xstate@5.26.0` (Feb 2026).
- **Persistence:** Use `actor.getPersistedSnapshot()` → JSON → SQLite. Restore via `createActor(machine, { snapshot })`.
- **Gotcha: `undefined` in snapshots.** `getPersistedSnapshot()` may return `undefined` for `output`/`error` fields. `JSON.stringify` drops these, causing restore issues. **Fix:** Use a replacer function: `JSON.stringify(snapshot, (_, v) => v === undefined ? null : v)`.
- **Gotcha: No functions/classes in context.** Functions are silently dropped by JSON serialization. Class instances lose their prototype. Keep context as plain data only.
- **Gotcha: History state bug [#5178](https://github.com/statelyai/xstate/issues/5178).** Restoring from `JSON.stringify → JSON.parse` can break history state behavior. **Mitigation:** We use the `blocked` state's `previousState` context field instead of XState history states.
- **Gotcha: Machine version changes.** No built-in migration. **Fix:** Store a schema version alongside snapshots.

### Native Android MQTT & Terminal

- **Library: Termux `terminal-view` + `terminal-emulator`** via JitPack (`com.github.termux.termux-app:terminal-view:v0.118.0`). Battle-tested terminal renderer — handles 200x50 natively with truecolor (24-bit ANSI). Accepts raw PTY byte streams via `InputStream`/`OutputStream` pair. Renders via direct Canvas drawing, not WebView. License: GPLv3 (fine for personal tool, not distributed).
- **No alternative needed.** jackpal/androidterm (Apache 2.0) exists but is archived and far less capable. No Compose-native terminal library exists. Custom Canvas rendering is 2-4 weeks of work to match Termux quality.
- **MQTT client: `hannesa2/paho.mqtt.android` v3.6.4** (JitPack). Actively maintained Kotlin fork of Eclipse Paho. Built-in foreground service support via `setForegroundService(notification, id)`. **Native TCP** — connect directly to `tcp://10.43.x.x:1883`, no WebSocket wrapping needed. MQTT 3.1.1 only. If MQTT 5.0 is needed, use HiveMQ MQTT Client (`com.hivemq:hivemq-mqtt-client:1.3.12`).
- **Gotcha: Background MQTT.** A foreground service with persistent notification can maintain MQTT connection in background, but Android Doze mode restricts network access during deep sleep windows. OEM battery killers (Samsung, Xiaomi, Huawei) may still kill it. **FCM remains essential as fallback.**
- **Gotcha: Doze + partial wake lock.** `PARTIAL_WAKE_LOCK` keeps CPU alive but does NOT prevent network restrictions during deep Doze. MQTT keepalive may not fire with screen off on some devices.
- **WebSocket client: OkHttp.** Best performance for Android WebSocket, native binary frame support (`ByteString`), already a standard Android dependency. 10x better CPU usage than Ktor for WebSocket workloads.
- **Compose integration.** Wrap Termux `TerminalView` in `AndroidView` composable. Use `Canvas` + `drawText()` only if a pure-Compose terminal is needed later.

### RabbitMQ MQTT

- **MQTT 5.0:** Supported since RabbitMQ 3.13, but **shared subscriptions are NOT supported**. Not an issue for our 1:1 subscriber model.
- **QoS 2:** NOT supported. Connections are terminated if QoS 2 is attempted. QoS 2 subscriptions are silently downgraded to QoS 1. **Use QoS 1 everywhere.**
- **Topic mapping:** MQTT `/` → AMQP `.`. So MQTT topic `gwa/repo/42/activity` → AMQP routing key `gwa.repo.42.activity`. **Never use dots in MQTT topics or slashes in AMQP routing keys.**
- **Retained messages:** Node-local only (not replicated across cluster), wildcards don't match retained messages. **Avoid relying on retained messages for initial state — fetch via REST API instead.**
- **Per-subscriber queues:** Each MQTT client gets dedicated queues named `mqtt-subscription-<clientID>qos[0|1]`. Single QoS level = single queue = guaranteed FIFO ordering.
- **Session persistence:** With `Clean Session = false`, queued messages survive client disconnects. Session expiry default is 1 day.

### Cloudflare Tunnel + MQTT/WebSocket (Fallback Path)

- **100-second idle timeout.** Non-configurable on non-Enterprise plans. MQTT keepalive must be < 100 seconds. **Use 60-second keepalive.**
- **Periodic infrastructure restarts.** Cloudflare deploys cause connection drops. **Must implement reconnection with exponential backoff.**
- **Reports of 20-30 second unexplained drops** (cloudflared [#1282](https://github.com/cloudflare/cloudflared/issues/1282)). **Multiple cloudflared replicas mitigate this** (we already run 2).
- **Tunnel type must be HTTP** (not TCP) for WebSocket proxying.

### Cloudflare WARP + Private Network Routing (Primary Path)

- **8-hour idle timeout.** When the mobile device connects via WARP to a private IP behind `cloudflared`, traffic flows through the Gateway proxy as raw TCP (Layer 4), bypassing the HTTP proxy layer entirely. The Gateway proxy's idle timeout is **8 hours**, not 100 seconds.
- **Architecture:** Device → WARP (WireGuard) → Cloudflare Edge → Gateway Proxy → `cloudflared` → `rawTCPService` → RabbitMQ:1883. No WebSocket wrapping needed.
- **Split tunnel configuration required.** By default, RFC 1918 space is excluded from WARP routing. Must explicitly include the K3s pod CIDR (e.g., `10.43.0.0/16`) in Split Tunnel Include mode.
- **Gotcha: WARP on Android background.** Android may kill the WARP VPN process in background. Mitigations:
  - Enable Android system "Always-on VPN" for Cloudflare One app
  - Disable battery optimization for the Cloudflare One app
  - Use the Cloudflare One agent (not legacy 1.1.1.1 app) — lower CPU usage
  - **Still need push notifications as fallback** — WARP background is not guaranteed
- **Gotcha: Battery impact.** WireGuard is efficient but real-world reports are mixed (some report 10% drain in 2 hours idle). Monitor and document battery optimization settings for users.
- **Zero Trust free tier.** Supports up to 50 users, sufficient for our personal use case.
- **Spectrum is NOT an option.** MQTT support requires Enterprise plan. Not viable for our scale/budget.

### SQLite Concurrent Writes (Bun)

- **Single writer at a time** even in WAL mode. Additional writers wait on busy_timeout.
- **Gotcha: `bun:sqlite` defaults busy_timeout to 0** (instant SQLITE_BUSY failure). Must explicitly set to 5000ms.
- **Gotcha: Must use `BEGIN IMMEDIATE`** for write transactions. Plain `BEGIN` can cause immediate SQLITE_BUSY on lock upgrade, ignoring busy_timeout.
- **Gotcha: `bun:sqlite` is synchronous.** A blocked write halts the Bun event loop. Keep write transactions short.
- **Gotcha: WAL file growth.** Long-running readers prevent checkpointing. Ensure periodic reader gaps.
- **Publishing from Bun:** Use `amqplib` 0.10.7+ for AMQP publishing. Known Bun compatibility issue with large messages ([#5627](https://github.com/oven-sh/bun/issues/5627)) — our payloads are small JSON, so this is fine.

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

**Schema addition** to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  handler TEXT,
  transition TEXT NOT NULL,
  issue_number INTEGER,
  repo TEXT,
  processed_at INTEGER DEFAULT (unixepoch()),
  result TEXT CHECK(result IN ('success', 'skipped', 'error'))
);
CREATE INDEX idx_webhook_deliveries_age ON webhook_deliveries(processed_at);
```

**File changes:**
- `src/webhook/handler.ts`: Check `webhook_deliveries` table before processing. Insert delivery ID after processing. Add a daily cleanup of deliveries older than 7 days.
- Note: The webhook handler currently doesn't use SQLite. It needs a lightweight SQLite connection (the webhook pod runs separately). Add SQLite to `Dockerfile.webhook` and mount a small PVC or use an in-memory DB with periodic flush.

**Alternative:** Since the webhook pod is stateless, use an in-memory `Map<string, number>` with a 1-hour TTL for deduplication. Simpler, no persistence needed, covers the retry window. GitHub retries happen within minutes, not hours.

**Decision:** Use in-memory `Map` with TTL for Phase 1. Migrate to SQLite if we need cross-restart deduplication later.

---

## Phase 2: XState State Machine

### 2.1 Install XState

```bash
bun add xstate@^5.26.0
```

### 2.2 Create State Machine Definition

**New file:** `src/lib/state-machine.ts`

Define the GWA workflow machine with:

**States:** `todo`, `planning`, `inProgress`, `qa`, `blocked`, `review`, `done`

**Context (plain data only — no functions, no classes):**
```typescript
interface GWAContext {
  sessionId: string | null;
  issueNumber: number;
  repo: string;
  owner: string;
  itemNodeId: string;
  contentNodeId: string;
  previousState: string | null;  // For blocked→resume transitions
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

Maps the `"FromColumn:ToColumn"` string from the webhook to the appropriate XState event. Returns `null` for unknown transitions (replaces silent no-op with explicit rejection).

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

### 2.4 Integrate with Webhook Handler

**File:** `src/webhook/handler.ts`

Replace the `transitionHandlers` lookup table with:
1. Load or create XState actor for the issue
2. Map column transition to XState event via `columnTransitionToEvent()`
3. Send event to actor — XState validates the transition
4. If valid: persist snapshot, trigger handler workflow
5. If invalid: log warning, return 200 (don't retry), post GitHub comment explaining the invalid transition

### 2.5 Integrate with Transition Handlers

Each `src/transitions/*.ts` handler:
1. Loads the XState actor from SQLite snapshot
2. Verifies current state matches expected (defense in depth)
3. Performs its work (create session, run tests, etc.)
4. Updates context (e.g., `hasPlan = true` after planning completes)
5. Persists updated snapshot

### 2.6 State Machine Tests

**New file:** `src/tests/state-machine.test.ts`

Test categories:
- Every valid forward transition (Todo→Planning→InProgress→QA→Review→Done)
- Every valid backward transition (Review→InProgress, QA→Planning, etc.)
- Every blocked→resume path (maintains previousState correctly)
- Every guard (planExists prevents premature advancement)
- Invalid transitions throw/reject
- Snapshot serialization round-trip (save → restore → same state)
- Schema version migration (future-proofing)

---

## Phase 3: Remove Redis

### 3.1 Audit Redis Usage

**File:** `src/lib/redis.ts`

Current Redis operations:
- `getSession(prNumber)`: Get session by PR number
- `createSession(prNumber, session)`: Store session data
- `podActivePrs(podName)`: List active PRs on a pod
- `closeRedis()`: Cleanup

All of these have SQLite equivalents in `src/lib/db.ts`.

### 3.2 Replace Redis Calls

Search all files importing from `redis.ts`. For each call site:
- Replace `redis.getSession()` with `db.getSession()`
- Replace `redis.createSession()` with `db.createSession()`
- Replace `redis.podActivePrs()` with a SQLite query on the `sessions` table
- Remove `redis.closeRedis()` calls

### 3.3 Create SQLite Active Sessions View

```sql
CREATE VIEW active_sessions AS
SELECT * FROM sessions
WHERE status NOT IN ('complete', 'error', 'cancelled')
ORDER BY last_activity_at DESC;
```

### 3.4 Remove Redis Dependencies

- Remove `ioredis` from `package.json`
- Delete `src/lib/redis.ts`
- Remove Redis environment variables from `k8s/gwa-runner-statefulset.yaml`
- Update `src/tests/imports.test.ts` to remove Redis export checks
- Update `CLAUDE.md` SDK stack table

### 3.5 Ensure SQLite Write Safety

Review all SQLite writes across the codebase:
- Verify `busy_timeout = 5000` is set on every `getDatabase()` call
- Verify write transactions use `BEGIN IMMEDIATE` (or Bun's `.immediate()`)
- Add retry logic for `SQLITE_BUSY` in critical paths (session creation, status updates)

---

## Phase 4: AMQP Publishing from GWA

### 4.1 Install amqplib

```bash
bun add amqplib@^0.10.7
bun add -d @types/amqplib
```

### 4.2 Create AMQP Publisher Module

**New file:** `src/lib/amqp.ts`

```typescript
export interface ActivityEvent {
  sessionId: string;
  issueNumber: number;
  repo: string;
  eventType: string;  // 'state_change' | 'activity' | 'question' | 'error' | 'complete' | 'screenshot'
  data: Record<string, unknown>;
  timestamp: number;
}

export async function publishActivity(event: ActivityEvent): Promise<void>;
export async function getPublisher(): Promise<AMQPPublisher>;
export async function closePublisher(): Promise<void>;
```

Design:
- Singleton AMQP connection with auto-reconnect
- Publish to `amq.topic` exchange with routing key `gwa.{owner}.{repo}.{issueNumber}.{eventType}`
- Use publisher confirms for reliability
- Messages are JSON, small (< 4KB), so no large-message Bun issues
- Non-blocking: publish failures log a warning but don't fail the handler
- Environment: `RABBITMQ_URL` (default: `amqp://rabbitmq.default.svc.cluster.local`)

### 4.3 Integrate with Activity Logging

**File:** `src/lib/db.ts`

Modify `logActivity()` to also publish to AMQP:
```typescript
export function logActivity(sessionId: string, eventType: string, data: object, actor: string) {
  // Existing SQLite insert...

  // Also publish to AMQP (fire-and-forget, non-blocking)
  publishActivity({
    sessionId,
    issueNumber: /* from session lookup */,
    repo: /* from session lookup */,
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
  publishActivity({
    sessionId: context.sessionId,
    issueNumber: context.issueNumber,
    repo: context.repo,
    eventType: 'state_change',
    data: {
      state: snapshot.value,
      context: snapshot.context,
    },
    timestamp: Date.now(),
  });
});
```

### 4.5 Push Notification Bridge (Process-Stopping Events Only)

**New file:** `src/lib/push-bridge.ts`

A sidecar service that bridges MQTT events to push notifications, but **only for events that stop a session's progress and require human intervention**:

**Subscribed topics (process-stopping events only):**
- `gwa/+/+/+/blocked` — Agent asked a question, session paused until answered
- `gwa/+/+/+/error` — Unrecoverable error, session halted
- `gwa/+/+/+/complete` — Session finished, final result ready

**Explicitly NOT pushed (informational only — synced on foreground return):**
- `state_change` — Routine state transitions (e.g., Planning → InProgress)
- `activity` — Claude Code output, git operations, test runs
- `screenshot` — Terminal captures

**Throttling strategy (critical for concurrent sessions):**

Since many sessions may be running concurrently, unthrottled notifications would flood the device. The push bridge implements:

1. **Per-session debounce (30 seconds).** Multiple events from the same session within 30 seconds are collapsed into a single notification. The notification body updates to reflect the latest event. E.g., if session #42 hits `blocked` then `error` within 30s, only one notification is sent with the error.

2. **Global rate limit (max 5 notifications per minute).** If the rate is exceeded, queue excess notifications and deliver them in the next window. This prevents notification storms when multiple sessions hit issues simultaneously.

3. **Android notification grouping.** All GWA notifications use a single group key (`gwa-alerts`) so Android collapses them into a summary notification (e.g., "3 sessions need attention") when multiple arrive close together. Each notification within the group is still individually tappable.

4. **Cooldown per session (5 minutes).** After a notification is sent for a session, suppress duplicate notifications for that session for 5 minutes. This prevents repeated `error` events from the same failing session from spamming the user.

5. **Batch delivery for queued notifications.** When the app returns to foreground and syncs missed MQTT messages, those messages are NOT re-pushed as notifications — the app's foreground UI handles displaying them. The push bridge only fires for events that arrive while the app is backgrounded/closed.

**Implementation:**
```typescript
interface ThrottleState {
  lastNotificationAt: Map<string, number>;  // sessionId → timestamp
  windowCount: number;                       // notifications in current minute
  windowStart: number;                       // current minute window start
  pendingQueue: PushMessage[];               // overflow from rate limit
}
```

The push bridge:
1. Subscribes to MQTT process-stopping topics via `mqtt.js` (internal, no WARP needed)
2. Applies throttle/debounce logic per above rules
3. Sends via **Firebase Cloud Messaging HTTP v1 API** (`POST https://fcm.googleapis.com/v1/projects/{project}/messages:send`)
4. FCM device tokens stored in SQLite (`push_tokens` table), registered by the native Android app on launch
5. Handles FCM error responses — removes invalid/expired tokens automatically
6. Requires Firebase Service Account Key JSON for server-side auth (stored as K8s secret)

### 4.6 K8s & Network Configuration

**GWA Runner env:**
```yaml
# k8s/gwa-runner-statefulset.yaml
env:
  - name: RABBITMQ_URL
    value: "amqp://rabbitmq.default.svc.cluster.local:5672"
```

**Cloudflare Tunnel — WSS fallback route (public hostname):**
```yaml
# In cloudflared config — for non-WARP clients
- hostname: mqtt.bto.bar
  service: http://rabbitmq.default.svc.cluster.local:15675
  originRequest:
    connectTimeout: 30s
    tcpKeepAlive: 30s
```

**Cloudflare Tunnel — Private network route (WARP primary path):**
```yaml
# In cloudflared tunnel config — advertise K3s service CIDR
tunnel: <tunnel-id>
ingress:
  # ... existing rules ...
  # Private network routing is configured via cloudflared --network flag,
  # not in ingress rules. Add to cloudflared deployment:
  #   cloudflared tunnel route ip add 10.43.0.0/16 <tunnel-id>
```

**Zero Trust Dashboard configuration:**
1. **Split Tunnels (Include mode):** Add `10.43.0.0/16` (K3s service CIDR) so WARP routes this range through the tunnel
2. **Gateway Network Policy:** Allow TCP to `10.43.X.X:1883` (RabbitMQ MQTT) and `10.43.X.X:15672` (RabbitMQ management — for WARP health check)
3. **Device enrollment:** Add mobile device to Zero Trust organization (free tier, max 50 users)

**RabbitMQ plugins to enable:**
```bash
rabbitmq-plugins enable rabbitmq_mqtt         # Native MQTT on port 1883 (for WARP path)
rabbitmq-plugins enable rabbitmq_web_mqtt     # MQTT over WebSocket on port 15675 (for WSS fallback)
```

---

## Phase 5: Live Terminal Streaming & Snapshots

### Design Principles

1. **Stream raw PTY bytes, not parsed output.** This makes us immune to Claude Code platform changes — whatever the terminal shows, the viewer shows.
2. **Single Bun process multiplexes all sessions.** No per-session daemons. One WebSocket server, pub/sub topics per pane.
3. **Mid-stream join via snapshot + stream.** New viewers get the current screen state instantly, then receive incremental updates.
4. **Dual-write: live stream + asciicast recording.** Every session is automatically recorded for later playback.
5. **Snapshots at lifecycle events.** Stored as SVG for rich display in the app and PR comments.

### 5.1 Terminal Relay Service

**New file:** `src/lib/terminal-relay.ts`

A single Bun process that manages all active tmux pane streams:

```typescript
interface PaneStream {
  sessionId: string;       // PR/issue session ID
  tmuxTarget: string;      // e.g., "gwa-work:3"
  fifoPath: string;        // /tmp/pane-pr-{N}.fifo
  recordingPath: string;   // /home/runner/recordings/pr-{N}.cast
  recordingFile: BunFile;  // Asciicast v2 append-only file
  startedAt: number;
}

// Lifecycle
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

### 5.2 WebSocket Server (Multiplexed)

**Integrated into the terminal relay process:**

```typescript
Bun.serve({
  port: 8080,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for live streaming
    if (url.pathname.startsWith('/stream/')) {
      const sessionId = url.pathname.split('/')[2];
      server.upgrade(req, { data: { sessionId } });
      return;
    }

    // REST: list active panes
    if (url.pathname === '/panes') {
      return Response.json(getActivePanes());
    }

    // REST: get snapshot (current screen state as ANSI text)
    if (url.pathname.startsWith('/snapshot/')) {
      const sessionId = url.pathname.split('/')[2];
      const ansi = await capturePane(sessionId);
      return new Response(ansi, { headers: { 'Content-Type': 'text/plain' } });
    }

    // REST: get snapshot as SVG
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
      const topic = `pane:${sessionId}`;

      // Subscribe to live stream
      ws.subscribe(topic);

      // Mid-stream join: send current screen state as initial frame
      // This gives the viewer instant context before incremental updates arrive
      capturePane(sessionId).then(snapshot => {
        ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
      });
    },
    message(ws, msg) {
      // Future: handle resize requests from viewer
      // { type: 'resize', cols: 120, rows: 40 }
    },
    close(ws) {
      const { sessionId } = ws.data;
      ws.unsubscribe(`pane:${sessionId}`);
    },
  },
});
```

**Data flow per PTY chunk:**
```typescript
// In the FIFO read loop
function onPtyData(sessionId: string, data: Uint8Array) {
  const topic = `pane:${sessionId}`;
  const timestamp = (Date.now() - stream.startedAt) / 1000;

  // 1. Publish to live viewers (WebSocket pub/sub)
  server.publish(topic, data);

  // 2. Append to asciicast v2 recording
  const castLine = JSON.stringify([timestamp, 'o', new TextDecoder().decode(data)]);
  stream.recordingFile.writer().write(castLine + '\n');
}
```

### 5.3 Snapshot Capture at Lifecycle Events

**Trigger points** (integrated into XState transition actions):

| Event | Trigger | What's Captured |
|-------|---------|-----------------|
| Session start | `todo → planning` or `todo → inProgress` | Initial terminal state |
| State transition | Any state change | Current screen (lightweight, text only) |
| Blocked (question) | `* → blocked` | Full screen + scrollback (last 200 lines) |
| Error | Error detected by Claude | Full screen + scrollback (last 500 lines) |
| Completion | `review → done` | Full screen + scrollback (last 200 lines) |
| Crash | Process exit with non-zero code | Full screen + entire scrollback |

**Snapshot pipeline:**
```typescript
async function takeSnapshot(sessionId: string, event: string): Promise<void> {
  const tmuxTarget = getTargetForSession(sessionId);

  // 1. Capture with ANSI codes preserved (-e) and scrollback (-S -500)
  const ansiText = await execTmux([
    'capture-pane', '-e', '-p', '-S', '-500', '-t', tmuxTarget
  ]);

  // 2. Convert to SVG using ansi-to-svg (npm package, Bun-compatible)
  const svg = ansiToSvg(ansiText, {
    paddingTop: 10,
    paddingLeft: 10,
    colors: 'monokai',  // or match terminal theme
  });

  // 3. Store in SQLite
  db.run(
    `INSERT INTO terminal_snapshots (session_id, event, ansi_text, svg, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, event, ansiText, svg, Date.now()]
  );

  // 4. Publish snapshot event via AMQP (so mobile app knows a new snapshot exists)
  publishActivity({
    sessionId,
    eventType: 'screenshot',
    data: { event, snapshotId: lastInsertRowId },
    timestamp: Date.now(),
  });
}
```

**Schema addition:**
```sql
CREATE TABLE IF NOT EXISTS terminal_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,        -- 'start', 'transition', 'blocked', 'error', 'complete', 'crash'
  ansi_text TEXT NOT NULL,    -- Raw ANSI text (for re-rendering)
  svg TEXT,                   -- Pre-rendered SVG
  captured_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE INDEX idx_snapshots_session ON terminal_snapshots(session_id, captured_at);
```

### 5.4 Asciicast v2 Recordings

Every session is automatically recorded in asciicast v2 format (NDJSON, append-only):

**Storage:** `/home/runner/recordings/pr-{N}-{timestamp}.cast`

**Format:**
```jsonl
{"version": 2, "width": 200, "height": 50, "timestamp": 1739318400, "env": {"TERM": "xterm-256color"}}
[0.5, "o", "$ claude-code --continue\r\n"]
[1.2, "o", "\u001b[32mAnalyzing PR #42...\u001b[0m\r\n"]
[3.8, "o", "Reading src/lib/state-machine.ts...\r\n"]
```

**Size estimates:**
| Session Type | Duration | Size (uncompressed) | Size (zstd) |
|---|---|---|---|
| Quick fix | 15 min | 1-3 MB | 150-450 KB |
| Feature implementation | 1 hour | 5-10 MB | 750 KB - 1.5 MB |
| Large refactor | 3 hours | 15-30 MB | 2-4.5 MB |

**Cleanup policy:** Keep recordings for 30 days, then delete. Compress after 7 days.

**Playback:** The React Native app can play recordings via asciinema-player in a WebView. Useful for reviewing "what happened while I was away" — can fast-forward, skip idle periods, etc.

### 5.5 Mobile Viewer Integration

**When on local network (WARP or direct LAN):**
- Connect directly to `ws://10.43.x.x:8080/stream/{sessionId}`
- Full live terminal in a WebView with xterm.js
- Sub-millisecond latency on gigabit

**When remote (Cloudflare tunnel):**
- Connect via `wss://terminal.bto.bar/stream/{sessionId}`
- Same experience, slightly higher latency
- Cloudflare idle timeout less of a concern here — terminal output is continuous during active sessions

**WebView component:**

```typescript
// src/components/TerminalViewer.tsx
import { WebView } from 'react-native-webview';

const TERMINAL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css" />
  <script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
  <style>body { margin: 0; background: #1e1e1e; }</style>
</head>
<body>
  <div id="terminal"></div>
  <script>
    const term = new Terminal({
      fontSize: 11,
      fontFamily: 'monospace',
      theme: { background: '#1e1e1e' },
      scrollback: 5000,
      cols: 120,  // Limit for mobile performance (not 200)
      rows: 40,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    // Connect to relay WebSocket
    const wsUrl = window.RELAY_URL;  // Injected by React Native
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot') {
          // Mid-stream join: render current screen state
          term.write(msg.data);
        }
      } else {
        // Binary: raw PTY data
        term.write(new Uint8Array(event.data));
      }
    };

    // Handle resize
    window.addEventListener('resize', () => fitAddon.fit());
  </script>
</body>
</html>
`;

export function TerminalViewer({ sessionId, relayUrl }: Props) {
  const html = TERMINAL_HTML.replace('window.RELAY_URL', JSON.stringify(relayUrl));
  return (
    <WebView
      source={{ html }}
      style={{ flex: 1, backgroundColor: '#1e1e1e' }}
      javaScriptEnabled
      originWhitelist={['*']}
    />
  );
}
```

**Android performance note:** xterm.js at 200+ columns causes significant slowdown on Android WebView. The mobile viewer uses 120 columns. The pod-side terminal still runs at 200x50 — the viewer just gets a horizontal scroll or the content wraps. For snapshot SVGs, full 200-column width is preserved.

### 5.6 Recording Playback View

For reviewing completed or past sessions, the app uses asciinema-player in a WebView:

```typescript
// src/components/RecordingPlayer.tsx
export function RecordingPlayer({ recordingUrl }: Props) {
  const html = `
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/asciinema-player/dist/bundle/asciinema-player.css" />
    <script src="https://cdn.jsdelivr.net/npm/asciinema-player/dist/bundle/asciinema-player.min.js"></script>
    <div id="player"></div>
    <script>
      AsciinemaPlayer.create('${recordingUrl}', document.getElementById('player'), {
        speed: 2,       // Default 2x playback
        idleTimeLimit: 3, // Cap idle gaps at 3 seconds
        theme: 'monokai',
        fit: 'width',
      });
    </script>
  `;
  return <WebView source={{ html }} style={{ flex: 1 }} javaScriptEnabled />;
}
```

Playback features:
- **Speed control:** 1x, 2x, 4x, 8x
- **Idle compression:** Caps idle gaps at 3 seconds (a 1-hour session with lots of thinking time plays back in ~15 minutes)
- **Scrubbing:** Seek to any point in the recording
- **Search:** Find text in the recording (asciinema-player built-in)

---

## Phase 6: Native Android Mobile App (Kotlin/Jetpack Compose)

### 6.1 Project Setup

Create in Android Studio with Compose template:

**Package:** `bar.bto.gwa`
**Min SDK:** 26 (Android 8.0 — covers 99% of devices)
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
    // Or for MQTT 5.0: implementation("com.hivemq:hivemq-mqtt-client:1.3.12")

    // Networking
    implementation("com.squareup.okhttp3:okhttp:4.12.0")  // WebSocket for terminal relay
    implementation("com.squareup.retrofit2:retrofit:2.9.0") // REST API calls

    // Firebase
    implementation(platform("com.google.firebase:firebase-bom:33.0.0"))
    implementation("com.google.firebase:firebase-messaging-ktx")

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
├── app/src/main/
│   ├── java/bar/bto/gwa/
│   │   ├── GwaApplication.kt              # Application class (MQTT init, FCM)
│   │   ├── MainActivity.kt                # Single activity (Compose NavHost)
│   │   │
│   │   ├── data/
│   │   │   ├── mqtt/
│   │   │   │   ├── MqttManager.kt          # Connection manager (TCP primary, WSS fallback)
│   │   │   │   ├── MqttForegroundService.kt # Optional always-on MQTT service
│   │   │   │   └── TransportDetector.kt     # LAN/WARP/WSS probe logic
│   │   │   ├── terminal/
│   │   │   │   ├── TerminalRelayClient.kt   # OkHttp WebSocket to relay server
│   │   │   │   └── TerminalSessionBridge.kt # Pipes WebSocket bytes → TerminalSession InputStream
│   │   │   ├── api/
│   │   │   │   ├── GwaApi.kt               # Retrofit interface for REST API
│   │   │   │   └── SessionRepository.kt     # Sessions data layer
│   │   │   └── fcm/
│   │   │       └── GwaMessagingService.kt   # FirebaseMessagingService (FCM handler)
│   │   │
│   │   ├── ui/
│   │   │   ├── navigation/
│   │   │   │   └── NavGraph.kt             # Compose navigation graph
│   │   │   ├── sessions/
│   │   │   │   ├── SessionListScreen.kt    # Session list with state indicators
│   │   │   │   ├── SessionListViewModel.kt
│   │   │   │   └── SessionCard.kt          # List item composable
│   │   │   ├── detail/
│   │   │   │   ├── SessionDetailScreen.kt  # Activity feed + state + answer
│   │   │   │   ├── SessionDetailViewModel.kt
│   │   │   │   ├── ActivityFeed.kt         # LazyColumn of MQTT events
│   │   │   │   └── AnswerDialog.kt         # Dialog for answering blocked session
│   │   │   ├── terminal/
│   │   │   │   ├── TerminalScreen.kt       # Termux TerminalView in AndroidView
│   │   │   │   ├── TerminalViewModel.kt    # Manages WebSocket + TerminalSession
│   │   │   │   └── RecordingScreen.kt      # Asciicast playback (WebView fallback)
│   │   │   ├── settings/
│   │   │   │   └── SettingsScreen.kt       # Broker config, transport status, battery guide
│   │   │   └── components/
│   │   │       ├── StateIndicator.kt       # Color-coded XState state chip
│   │   │       └── SnapshotViewer.kt       # SVG/ANSI snapshot display
│   │   │
│   │   └── util/
│   │       ├── NotificationHelper.kt       # Channel creation, notification building
│   │       └── BatteryOptimization.kt      # Detect + prompt for whitelisting
│   │
│   ├── res/
│   │   └── ...
│   └── AndroidManifest.xml
├── build.gradle.kts
└── google-services.json                    # Firebase config
```

### 6.3 MQTT Connection Manager (Native TCP Primary)

```kotlin
// data/mqtt/MqttManager.kt
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
        val transport = transportDetector.detect()  // LAN → WARP → WSS
        val (brokerUrl, keepalive) = when (transport) {
            Transport.LAN_TCP  -> "tcp://10.43.X.X:1883" to 300   // 5 min (direct LAN, no timeout concern)
            Transport.WARP_TCP -> "tcp://10.43.X.X:1883" to 300   // 5 min (8hr Gateway idle)
            Transport.WSS      -> "wss://mqtt.bto.bar/ws" to 60   // 60s (under CF 100s idle)
        }

        client = MqttAndroidClient(context, brokerUrl, "gwa-android-${deviceId}").apply {
            if (transport != Transport.WSS) {
                // Optional: foreground service for background MQTT on LAN/WARP
                setForegroundService(buildMqttNotification(), MQTT_NOTIFICATION_ID)
            }
        }

        val options = MqttConnectOptions().apply {
            isCleanSession = false            // Persistent session — queued messages on reconnect
            keepAliveInterval = keepalive
            isAutomaticReconnect = true
            connectionTimeout = 10
        }

        client?.connect(options)
        _connectionState.value = ConnectionState.Connected(transport)
    }
}
```

**Transport detection (`TransportDetector.kt`):**
```kotlin
class TransportDetector {
    suspend fun detect(): MqttManager.Transport {
        // 1. Try direct TCP to RabbitMQ management API (works on LAN and WARP)
        if (probePrivateIp("10.43.X.X", 15672, timeoutMs = 2000)) {
            return if (isOnLocalWifi()) Transport.LAN_TCP else Transport.WARP_TCP
        }
        // 2. Fallback to WebSocket through Cloudflare tunnel
        return Transport.WSS
    }

    private fun isOnLocalWifi(): Boolean {
        // Check if current WiFi SSID matches homelab network
        // or if gateway IP matches known homelab router
    }
}
```

### 6.4 Live Terminal Viewer (Termux TerminalView)

```kotlin
// ui/terminal/TerminalScreen.kt
@Composable
fun TerminalScreen(sessionId: String, viewModel: TerminalViewModel = viewModel()) {
    val terminalSession = viewModel.terminalSession

    AndroidView(
        factory = { context ->
            TerminalView(context, null).apply {
                setTextSize(24)  // Adjustable
                attachSession(terminalSession)
                // Read-only: override onTouchEvent to disable keyboard
                setOnKeyListener { _, _, _ -> true }
            }
        },
        modifier = Modifier.fillMaxSize()
    )

    LaunchedEffect(sessionId) {
        viewModel.connectToRelay(sessionId)
    }
}

// ui/terminal/TerminalViewModel.kt
class TerminalViewModel : ViewModel() {
    private val okHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    // Bridge: WebSocket bytes → PipedOutputStream → TerminalSession InputStream
    private val pipedOutput = PipedOutputStream()
    private val pipedInput = PipedInputStream(pipedOutput, 65536)

    val terminalSession = TerminalSession(
        /* processId */ -1,
        /* fd */ pipedInput.fd,  // Simplified — actual impl uses FileDescriptor bridge
        /* transcript rows */ 5000,
        /* columns */ 200,
        /* rows */ 50,
        /* client */ terminalClient
    )

    fun connectToRelay(sessionId: String) {
        val relayUrl = "ws://10.43.X.X:8080/stream/$sessionId"  // or wss:// if remote
        val request = Request.Builder().url(relayUrl).build()

        okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // Raw PTY bytes → pipe directly to terminal emulator
                pipedOutput.write(bytes.toByteArray())
                pipedOutput.flush()
            }
            override fun onMessage(ws: WebSocket, text: String) {
                // Mid-stream join snapshot (JSON)
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

**Key advantage over xterm.js WebView:** Termux `TerminalView` renders via direct Canvas drawing with hardware acceleration. No JavaScript engine, no WebView process, no bridge overhead. Full 200 columns at native performance.

### 6.5 Push Notifications (Direct FCM)

```kotlin
// data/fcm/GwaMessagingService.kt
class GwaMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // Register token with GWA backend
        CoroutineScope(Dispatchers.IO).launch {
            GwaApi.registerPushToken(token, platform = "android")
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val eventType = data["eventType"] ?: return
        val issueNumber = data["issueNumber"] ?: return
        val sessionId = data["sessionId"] ?: return

        val notification = when (eventType) {
            "blocked" -> buildNotification(
                channel = CHANNEL_ACTION_REQUIRED,
                title = "#$issueNumber: Question",
                body = data["question"]?.take(100) ?: "Agent needs input",
                intent = deepLink("gwa://session/$sessionId/answer"),
            )
            "error" -> buildNotification(
                channel = CHANNEL_ACTION_REQUIRED,
                title = "#$issueNumber: Error",
                body = data["error"] ?: "Session failed",
                intent = deepLink("gwa://session/$sessionId"),
            )
            "complete" -> buildNotification(
                channel = CHANNEL_COMPLETIONS,
                title = "#$issueNumber: Complete",
                body = data["summary"] ?: "Session finished",
                intent = deepLink("gwa://session/$sessionId"),
            )
            else -> return
        }

        NotificationManagerCompat.from(this).notify(sessionId.hashCode(), notification)
    }
}
```

**Notification channels (created in `GwaApplication.onCreate()`):**
```kotlin
// Action Required — high priority, vibrate, sound
NotificationChannel("gwa-action-required", "Action Required", IMPORTANCE_HIGH).apply {
    vibrationPattern = longArrayOf(0, 250, 250, 250)
    setGroup("gwa-alerts")
}

// Completions — default priority
NotificationChannel("gwa-completions", "Completions", IMPORTANCE_DEFAULT).apply {
    setGroup("gwa-alerts")
}
```

### 6.6 Notification Strategy (Same as Before, Native Implementation)

**Process-stopping events only:** `blocked`, `error`, `complete`. Everything else syncs via MQTT on foreground return.

**Throttling:** Still handled server-side by the push bridge (Phase 4.5). The server sends FCM messages directly (not through Expo Push API) — simpler, one fewer hop.

**Foreground/background lifecycle:**

```kotlin
// In MainActivity or LifecycleObserver
class AppLifecycleObserver(
    private val mqttManager: MqttManager,
    private val sessionRepo: SessionRepository,
) : DefaultLifecycleObserver {

    override fun onStart(owner: LifecycleOwner) {
        // App came to foreground
        // 1. MQTT persistent session auto-delivers queued messages
        // 2. Safety net: sync from REST API in case MQTT session expired
        CoroutineScope(Dispatchers.IO).launch {
            sessionRepo.syncFromApi()
        }
        // 3. Re-detect transport (WiFi may have changed)
        mqttManager.reconnectWithTransportDetection()
    }

    override fun onStop(owner: LifecycleOwner) {
        // App went to background
        // If user enabled "always-on" mode → MQTT stays via foreground service
        // Otherwise → MQTT disconnects, FCM handles critical notifications
    }
}
```

### 6.7 Recording Playback

For asciicast recording playback, use a WebView with asciinema-player (same approach as before — this is one area where a WebView is fine since it's non-interactive playback):

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

### 6.8 Settings Screen — Battery & Transport

The Settings screen includes:
- **Transport status:** Shows current connection (LAN TCP / WARP TCP / WSS) with latency
- **Always-on MQTT:** Toggle for foreground service (persistent notification, background MQTT)
- **Battery optimization:** Detect if app is battery-optimized → prompt user to whitelist
- **WARP status:** Check if Cloudflare One agent is installed and connected
- **Broker config:** Override private IP, port, WSS URL (for testing)

```kotlin
@Composable
fun BatteryOptimizationCard() {
    val isOptimized = isBatteryOptimized(LocalContext.current)
    if (isOptimized) {
        Card {
            Text("Battery optimization is enabled for GWA.")
            Text("This may prevent background MQTT and notifications from working reliably.")
            Button(onClick = { requestBatteryWhitelist() }) {
                Text("Disable Battery Optimization")
            }
        }
    }
}
```

---

## Phase 7: REST API for Mobile

### 7.1 API Endpoint Service

**New file:** `src/api/handler.ts`

A lightweight Bun HTTP server (can share the webhook pod or run separately):

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/sessions` | GET | Bearer token | List active sessions |
| `/api/sessions/:id` | GET | Bearer token | Session detail + XState snapshot |
| `/api/sessions/:id/answer` | POST | Bearer token | Answer a blocked session question |
| `/api/sessions/:id/screenshot` | GET | Bearer token | Latest terminal screenshot |
| `/api/push-tokens` | POST | Bearer token | Register Expo push token |
| `/api/push-tokens` | DELETE | Bearer token | Unregister push token |
| `/health` | GET | None | Health check |

**Auth:** Simple bearer token (shared secret). Can upgrade to GitHub OAuth later.

### 7.2 Schema Addition for Push Tokens

```sql
CREATE TABLE IF NOT EXISTS push_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('android', 'ios', 'web')),
  device_name TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  last_used_at INTEGER DEFAULT (unixepoch())
);
```

---

## Phase 8: Behavioral Test Suite

### 8.1 State Machine Tests

**File:** `src/tests/state-machine.test.ts`

```
- Forward flow: Todo → Planning → InProgress → QA → Review → Done
- Blocked from each state: Planning, InProgress, QA, Review
- Resume from blocked returns to correct previous state
- Guard: planExists prevents Planning → InProgress without plan
- Guard: hasNoActiveSession prevents duplicate sessions
- Quick start: Todo → InProgress (skips planning)
- Skip QA: InProgress → Review
- Skip implementation: Planning → QA
- Cancel from every state returns to Todo
- Reopen from Done returns to Todo
- Invalid transitions: Todo → QA, Todo → Review, QA → Done (skipping review)
- Backward transitions: Review → InProgress, QA → Planning
- Snapshot round-trip: save → restore → state matches
- Schema version stored with snapshot
```

### 8.2 Webhook Deduplication Tests

**File:** `src/tests/webhook-dedup.test.ts`

```
- Duplicate delivery ID is rejected
- Different delivery IDs are both processed
- TTL cleanup removes old entries
- Concurrent identical deliveries (only one processes)
```

### 8.3 AMQP Publishing Tests

**File:** `src/tests/amqp-publish.test.ts`

```
- Activity events are published with correct routing key
- State change events include XState snapshot
- Publish failure doesn't crash the handler
- Connection recovery after broker restart
- Message format matches mobile app expectations
```

### 8.4 Session Lifecycle Tests

**File:** `src/tests/session-lifecycle.test.ts`

```
- Full Todo → Done lifecycle with assertions at each step
- Blocked → Resume preserves session state
- Pod restart recovery: interrupted sessions detected and resumable
- Concurrent sessions for different issues don't interfere
- Cleanup removes all artifacts (tmux window, worktree, DB records)
```

---

## Phase 9: Documentation & Cleanup

### 9.1 Update README.md

- Replace ASCII state diagram with XState-generated diagram
- Update architecture section with AMQP/MQTT streaming
- Add mobile app section
- Update tech stack table (remove Redis, add XState, amqplib, mqtt.js)
- Update security section (timing-safe HMAC, fail-closed verification)

### 9.2 Update CLAUDE.md

- Remove Redis from SDK stack table
- Add XState to SDK stack table
- Add amqplib to SDK stack table
- Add terminal relay to operational notes
- Update operational notes with AMQP configuration

### 9.3 Update CHANGELOG.md

Document all v4.0 changes.

---

## Task Checklist

### Phase 1: Security Hardening
- [ ] 1.1 Import `timingSafeEqual` in `src/webhook/handler.ts`
- [ ] 1.2 Change `verifySignature()` to fail closed when secret is empty
- [ ] 1.3 Replace `===` with `timingSafeEqual` for HMAC comparison
- [ ] 1.4 Add length check before `timingSafeEqual`
- [ ] 1.5 Add in-memory deduplication `Map` with 1-hour TTL
- [ ] 1.6 Check `X-GitHub-Delivery` against dedup map before processing
- [ ] 1.7 Write tests for signature verification edge cases
- [ ] 1.8 Write tests for deduplication logic
- [ ] 1.9 Run `bun run typecheck` — verify clean

### Phase 2: XState State Machine
- [ ] 2.1 Install `xstate@^5.26.0`
- [ ] 2.2 Create `src/lib/state-machine.ts` with machine definition
- [ ] 2.3 Define all 7 states with transitions matching README
- [ ] 2.4 Implement guards: `hasNoActiveSession`, `planExists`, `previousWas*`
- [ ] 2.5 Implement `columnTransitionToEvent()` mapping function
- [ ] 2.6 Add `xstate_snapshot` and `xstate_schema_version` columns to sessions table
- [ ] 2.7 Implement `persistSnapshot()` and `restoreActor()` helper functions
- [ ] 2.8 Handle `undefined` → `null` in JSON serialization
- [ ] 2.9 Integrate with webhook handler — replace lookup table
- [ ] 2.10 Update each transition handler to load/verify/persist XState state
- [ ] 2.11 Map `blocked` state `previousState` context correctly
- [ ] 2.12 Write state machine unit tests (all valid transitions)
- [ ] 2.13 Write state machine unit tests (all invalid transitions)
- [ ] 2.14 Write state machine unit tests (guard conditions)
- [ ] 2.15 Write snapshot round-trip tests
- [ ] 2.16 Run `bun run typecheck` — verify clean
- [ ] 2.17 Run `bun test` — verify all pass

### Phase 3: Remove Redis
- [ ] 3.1 Audit all imports of `src/lib/redis.ts` across codebase
- [ ] 3.2 Replace each Redis call with SQLite equivalent
- [ ] 3.3 Create `active_sessions` SQL view
- [ ] 3.4 Remove `ioredis` from `package.json`
- [ ] 3.5 Delete `src/lib/redis.ts`
- [ ] 3.6 Remove Redis env vars from `k8s/gwa-runner-statefulset.yaml`
- [ ] 3.7 Update `src/tests/imports.test.ts` — remove Redis checks
- [ ] 3.8 Verify `busy_timeout = 5000` on all `getDatabase()` calls
- [ ] 3.9 Verify write transactions use `BEGIN IMMEDIATE`
- [ ] 3.10 Add `SQLITE_BUSY` retry logic for critical paths
- [ ] 3.11 Run `bun run typecheck` — verify clean
- [ ] 3.12 Run `bun test` — verify all pass

### Phase 4: AMQP Publishing & Push Bridge
- [ ] 4.1 Install `amqplib@^0.10.7` and `@types/amqplib`
- [ ] 4.2 Create `src/lib/amqp.ts` with singleton connection + auto-reconnect
- [ ] 4.3 Implement `publishActivity()` with publisher confirms
- [ ] 4.4 Define routing key convention: `gwa.{owner}.{repo}.{issue}.{eventType}`
- [ ] 4.5 Integrate with `logActivity()` in `src/lib/db.ts` (fire-and-forget)
- [ ] 4.6 Publish XState state_change events on every transition
- [ ] 4.7 Create `src/lib/push-bridge.ts` — subscribe to process-stopping MQTT topics only
- [ ] 4.8 Implement per-session debounce (30s) in push bridge
- [ ] 4.9 Implement global rate limit (5 notifications/minute) with queue overflow
- [ ] 4.10 Implement per-session cooldown (5 minutes) to prevent spam
- [ ] 4.11 Implement Expo push receipt handling — auto-remove invalid tokens
- [ ] 4.12 Add `push_tokens` table to `schema.sql`
- [ ] 4.13 Add `RABBITMQ_URL` env var to StatefulSet
- [ ] 4.14 Add MQTT WebSocket Cloudflare tunnel route (WSS fallback)
- [ ] 4.15 Configure Cloudflare Tunnel private network route for WARP path
- [ ] 4.16 Configure Zero Trust Split Tunnels to include K3s service CIDR
- [ ] 4.17 Add Gateway network policy allowing TCP to RabbitMQ ports
- [ ] 4.18 Enable `rabbitmq_mqtt` + `rabbitmq_web_mqtt` plugins
- [ ] 4.19 Write AMQP publish tests (mock broker)
- [ ] 4.20 Write push bridge throttling tests (debounce, rate limit, cooldown)
- [ ] 4.21 Run `bun run typecheck` — verify clean
- [ ] 4.22 Run `bun test` — verify all pass

### Phase 5: Live Terminal Streaming & Snapshots
- [ ] 5.1 Create `src/lib/terminal-relay.ts` — main relay service module
- [ ] 5.2 Implement `startPaneStream()` — mkfifo + tmux pipe-pane + FIFO reader
- [ ] 5.3 Implement `stopPaneStream()` — detach pipe-pane + close FIFO + final snapshot
- [ ] 5.4 Implement Bun WebSocket server with pub/sub topics per pane
- [ ] 5.5 Implement mid-stream join — `capture-pane -e -p` snapshot on WebSocket connect
- [ ] 5.6 Implement asciicast v2 dual-write (NDJSON append alongside live stream)
- [ ] 5.7 Add `terminal_snapshots` table to `schema.sql`
- [ ] 5.8 Implement `takeSnapshot()` — capture-pane + ansi-to-svg + SQLite store
- [ ] 5.9 Integrate snapshot triggers with XState transition actions (start, blocked, error, complete, crash)
- [ ] 5.10 Install `ansi-to-svg` npm package for SVG snapshot generation
- [ ] 5.11 Add REST endpoints: `/panes`, `/snapshot/{id}`, `/snapshot-svg/{id}`
- [ ] 5.12 Add recording cleanup job (compress after 7 days, delete after 30)
- [ ] 5.13 Integrate `startPaneStream()` into session creation workflow
- [ ] 5.14 Integrate `stopPaneStream()` into session cleanup workflow
- [ ] 5.15 Add Cloudflare tunnel route for terminal relay (`terminal.bto.bar` → `:8080`)
- [ ] 5.16 Write tests: FIFO read + WebSocket publish round-trip
- [ ] 5.17 Write tests: mid-stream join delivers snapshot then incremental data
- [ ] 5.18 Write tests: asciicast recording format validation
- [ ] 5.19 Write tests: snapshot capture at lifecycle events
- [ ] 5.20 Run `bun run typecheck` — verify clean
- [ ] 5.21 Run `bun test` — verify all pass

### Phase 6: Native Android App (Kotlin/Jetpack Compose)
- [ ] 6.1 Create Android Studio project with Compose template (`bar.bto.gwa`)
- [ ] 6.2 Add JitPack repo + Termux terminal-view/emulator dependencies
- [ ] 6.3 Add Paho MQTT Android + OkHttp + Retrofit + Firebase dependencies
- [ ] 6.4 Add `google-services.json` for Firebase
- [ ] 6.5 Create `TransportDetector` — LAN probe → WARP probe → WSS fallback
- [ ] 6.6 Create `MqttManager` — native TCP primary, WSS fallback, auto-reconnect
- [ ] 6.7 Create `MqttForegroundService` — optional always-on background MQTT
- [ ] 6.8 Create `TerminalRelayClient` — OkHttp WebSocket to relay server
- [ ] 6.9 Create `TerminalSessionBridge` — pipe WebSocket bytes → Termux TerminalSession InputStream
- [ ] 6.10 Build `TerminalScreen` — Termux TerminalView in AndroidView (read-only, 200x50)
- [ ] 6.11 Build `TerminalViewModel` — manages WebSocket connection + mid-stream join
- [ ] 6.12 Build `SessionListScreen` + ViewModel — REST initial load + MQTT real-time updates
- [ ] 6.13 Build `SessionDetailScreen` + ViewModel — activity feed + state indicator
- [ ] 6.14 Build `AnswerDialog` — answer blocked session questions via REST
- [ ] 6.15 Build `StateIndicator` — color-coded XState state chip composable
- [ ] 6.16 Build `SnapshotViewer` — SVG/ANSI snapshot display
- [ ] 6.17 Build `RecordingScreen` — asciinema-player in WebView
- [ ] 6.18 Build `SettingsScreen` — transport status, always-on toggle, battery guide
- [ ] 6.19 Create `GwaMessagingService` — FirebaseMessagingService for FCM
- [ ] 6.20 Create notification channels (action-required + completions) in Application.onCreate
- [ ] 6.21 Handle notification deep links — navigate to session/answer dialog
- [ ] 6.22 Implement `AppLifecycleObserver` — foreground sync (MQTT queue + REST safety net)
- [ ] 6.23 Implement `BatteryOptimization` helper — detect + prompt for whitelisting
- [ ] 6.24 Add Compose navigation graph with deep link support
- [ ] 6.25 Build signed APK (or use Android Studio direct install for dev)
- [ ] 6.26 Test on physical device — LAN TCP path (verify native TCP, no WebSocket)
- [ ] 6.27 Test on physical device — WARP TCP path (Cloudflare One agent)
- [ ] 6.28 Test on physical device — WSS fallback (disable WARP, verify auto-switch)
- [ ] 6.29 Test live terminal — 200 cols, truecolor, scrollback, cursor
- [ ] 6.30 Test recording playback — speed control, idle compression
- [ ] 6.31 Test FCM push — only blocked/error/complete arrive
- [ ] 6.32 Test notification throttling — concurrent sessions don't flood
- [ ] 6.33 Test foreground resume sync — missed MQTT messages appear
- [ ] 6.34 Test foreground service MQTT — verify connection survives screen-off
- [ ] 6.35 Test battery optimization whitelist prompt

### Phase 7: REST API
- [ ] 7.1 Create `src/api/handler.ts` with Bun.serve
- [ ] 7.2 Implement `GET /api/sessions` endpoint
- [ ] 7.3 Implement `GET /api/sessions/:id` endpoint (with XState snapshot)
- [ ] 7.4 Implement `POST /api/sessions/:id/answer` endpoint
- [ ] 7.5 Implement `GET /api/sessions/:id/screenshot` endpoint (latest SVG snapshot)
- [ ] 7.6 Implement `GET /api/sessions/:id/recordings` endpoint (list asciicast files)
- [ ] 7.7 Implement `POST /api/push-tokens` endpoint
- [ ] 7.8 Implement `DELETE /api/push-tokens` endpoint
- [ ] 7.9 Add bearer token authentication middleware
- [ ] 7.10 Add input validation on all endpoints
- [ ] 7.11 Add Cloudflare tunnel route for API
- [ ] 7.12 Add build target for `gwa-api` in `package.json`
- [ ] 7.13 Add `gwa-api` to Dockerfile
- [ ] 7.14 Write API endpoint tests
- [ ] 7.15 Run `bun run typecheck` — verify clean

### Phase 8: Behavioral Tests
- [ ] 8.1 Write full session lifecycle test (Todo → Done)
- [ ] 8.2 Write blocked → resume lifecycle test
- [ ] 8.3 Write pod restart recovery test
- [ ] 8.4 Write concurrent session isolation test
- [ ] 8.5 Write cleanup artifact verification test (including terminal streams + recordings)
- [ ] 8.6 Write terminal relay integration test (stream start → data → snapshot → stop)
- [ ] 8.7 Run full test suite — verify all pass

### Phase 9: Documentation & Cleanup
- [ ] 9.1 Update `README.md` — architecture, tech stack, state diagram, terminal streaming
- [ ] 9.2 Update `CLAUDE.md` — remove Redis, add XState/amqplib/terminal-relay
- [ ] 9.3 Update `CHANGELOG.md` with v4.0 changes
- [ ] 9.4 Bump `package.json` version to 4.0.0
- [ ] 9.5 Final `bun run typecheck` + `bun test`
- [ ] 9.6 Build all binaries: `bun run build`
- [ ] 9.7 Build and push Docker image
- [ ] 9.8 Deploy to K3s cluster
- [ ] 9.9 End-to-end test: live terminal + MQTT + push notifications on real project

---

## Dependencies Summary

### Add
| Package | Version | Purpose |
|---------|---------|---------|
| `xstate` | `^5.26.0` | Formal state machine |
| `amqplib` | `^0.10.7` | AMQP publishing to RabbitMQ |
| `@types/amqplib` | `^0.10.5` | TypeScript types |
| `ansi-to-svg` | `^1.1.1` | Convert terminal snapshots to SVG |

### Remove
| Package | Reason |
|---------|--------|
| `ioredis` | Replaced by SQLite |

### Infrastructure
| Component | Change |
|-----------|--------|
| RabbitMQ | Enable `rabbitmq_mqtt` (port 1883) + `rabbitmq_web_mqtt` (port 15675) |
| Cloudflare Tunnel | Add public route `mqtt.bto.bar` → `rabbitmq:15675` (WSS fallback) |
| Cloudflare Tunnel | Add public route `terminal.bto.bar` → `gwa-runner:8080` (terminal relay) |
| Cloudflare Tunnel | Add private network route `10.43.0.0/16` (WARP primary) |
| Cloudflare Tunnel | Add route `gwa-api.bto.bar` → `gwa-runner:3001` |
| Zero Trust | Split Tunnels Include: `10.43.0.0/16`; Gateway policy: allow RabbitMQ + relay ports |
| Mobile Device | Install Cloudflare One agent, disable battery optimization |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| XState snapshot incompatibility after machine changes | Medium | High | Store schema version, write migration functions |
| Cloudflare WSS drops (100s timeout) | Medium | Low | WARP primary path (8hr idle) + WSS as fallback only + push notifications for critical events |
| WARP killed by Android in background | Medium | Medium | Always-on VPN + battery optimization whitelist + push bridge ensures process-stopping events always reach user |
| Notification flood from concurrent sessions | High | Medium | Per-session debounce (30s) + global rate limit (5/min) + per-session cooldown (5min) + Android notification grouping |
| amqplib large message bug on Bun (#5627) | Low | Low | Our payloads are < 4KB JSON |
| SQLite BUSY under concurrent writes | Low | Medium | 5s busy_timeout + BEGIN IMMEDIATE + short transactions |
| OEM battery optimization kills push + WARP | Medium | Medium | Document manual whitelist steps in app settings; app detects and prompts user to whitelist |
| MQTT session expires during long background | Low | Medium | REST API safety net on foreground resume catches anything MQTT session missed |
| Termux terminal-view GPLv3 license | Low | Low | Personal tool, not distributed; no license concern. jackpal (Apache 2.0) available as fallback |
| Paho MQTT Android lacks MQTT 5.0 | Low | Low | MQTT 3.1.1 sufficient for our pub/sub; HiveMQ client available if 5.0 needed |
| Android Doze blocks foreground service MQTT | Medium | Low | FCM push bridge as fallback; foreground service is optional "always-on" mode |
| XState history state bug (#5178) | Low | Low | We use context.previousState instead of XState history states |
| WARP battery drain on some devices | Medium | Low | Monitor reports; 5-minute keepalive on WARP path (vs 60s on WSS) reduces radio wake-ups |
| Terminal rendering performance | N/A | N/A | **Eliminated.** Termux terminal-view uses native Canvas — handles 200x50 at 60fps. No WebView. |
| tmux pipe-pane single consumer limit | Low | Low | Relay process fans out via WebSocket pub/sub; one FIFO reader, many WebSocket viewers |
| Asciicast recordings fill Longhorn PVC | Low | Medium | Auto-compress after 7 days, auto-delete after 30; typical session is 5-10MB uncompressed |
| Named FIFO orphan on crash | Low | Low | Cleanup on relay startup: remove stale FIFOs from /tmp; session cleanup also removes them |
