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
         │  React Native App (Expo Dev Build)                              │
         │                                                                 │
         │  Foreground: mqtt.js (WARP native TCP or WSS fallback)         │
         │  Background: FCM push (process-stopping events only)           │
         │  Resume:     Sync missed MQTT messages on foreground return    │
         │                                                                 │
         │  Notification throttling: grouped + debounced per-session      │
         └─────────────────────────────────────────────────────────────────┘
```

### Connectivity Model: WARP Primary, WSS Fallback

The mobile app supports two MQTT connectivity paths:

| Path | Transport | Idle Timeout | Requires | When Used |
|------|-----------|-------------|----------|-----------|
| **WARP (primary)** | Native TCP via private IP | **8 hours** (Gateway proxy) | Cloudflare One agent on device | WARP VPN detected active |
| **WSS (fallback)** | WebSocket over HTTPS tunnel | **100 seconds** | Nothing extra | WARP unavailable or disconnected |

The app detects WARP availability at startup by attempting a TCP connection to the private RabbitMQ IP. If reachable, it uses native MQTT (`mqtt://10.43.x.x:1883`). If not, it falls back to WSS (`wss://mqtt.bto.bar/ws`) with a 60-second keepalive.

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

### React Native MQTT

- **Library:** `mqtt.js` v5.15.0+ is the only viable option. Pure JS, Expo-compatible, full MQTT 5.0.
- **Transport:** WebSocket only (`wss://`). No native TCP in Expo managed workflow.
- **Gotcha: Background MQTT is impossible.** Android kills WebSocket connections when backgrounded. `expo-background-task` has a 15-minute minimum interval. **Solution:** Use FCM push notifications for background delivery. Server-side MQTT subscriber forwards critical events (blocked, error, complete) as push notifications.
- **Gotcha: Expo SDK 54+ requires dev builds for notifications.** Push notifications no longer work in Expo Go. Must use `npx expo run:android` or EAS Build.
- **Gotcha: FCM v1 mandatory.** Legacy API shut down Sept 2024. Need both `google-services.json` (app identity) and Service Account Key JSON (server credentials). Different files, different security posture.
- **Gotcha: OEM battery optimization.** Xiaomi, Huawei, Samsung aggressively kill background processes. Push notifications may be delayed on these devices. No programmatic fix — users must whitelist the app manually.

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
3. Sends via Expo Push API: `POST https://exp.host/--/api/v2/push/send`
4. Expo push tokens stored in SQLite (`push_tokens` table)
5. Handles Expo push receipts — removes invalid tokens automatically

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

## Phase 5: React Native Mobile App

### 5.1 Project Setup

```bash
npx create-expo-app gwa-mobile --template blank-typescript
cd gwa-mobile
npx expo install mqtt expo-notifications expo-device expo-constants
npx expo install @react-navigation/native @react-navigation/native-stack
npx expo install react-native-screens react-native-safe-area-context
```

**Expo SDK:** 54+ (requires dev builds for notifications)
**Build:** EAS Build (`eas build --platform android --profile development`)

### 5.2 App Structure

```
gwa-mobile/
├── app/                          # Expo Router pages
│   ├── _layout.tsx               # Root layout with navigation
│   ├── index.tsx                 # Session list screen
│   ├── session/[id].tsx          # Session detail screen
│   └── settings.tsx              # MQTT broker config, push token
├── src/
│   ├── mqtt/
│   │   ├── client.ts             # mqtt.js connection manager
│   │   ├── topics.ts             # Topic constants and helpers
│   │   └── reconnect.ts          # Exponential backoff reconnection
│   ├── notifications/
│   │   ├── setup.ts              # FCM + Expo notification setup
│   │   └── handlers.ts           # Notification tap handlers
│   ├── api/
│   │   ├── sessions.ts           # REST API calls to GWA
│   │   └── answer.ts             # POST answer to blocked session
│   ├── store/
│   │   └── sessions.ts           # Zustand store for session state
│   ├── components/
│   │   ├── SessionCard.tsx        # Session list item
│   │   ├── ActivityFeed.tsx       # Real-time activity stream
│   │   ├── StateIndicator.tsx     # XState state visualization
│   │   ├── AnswerModal.tsx        # Answer blocked session question
│   │   └── ScreenshotViewer.tsx   # Terminal screenshot display
│   └── types/
│       └── events.ts             # Shared types (mirror from GWA)
├── app.json                      # Expo config
├── eas.json                      # EAS Build config
└── tsconfig.json
```

### 5.3 MQTT Client Configuration (Dual-Path: WARP Primary, WSS Fallback)

```typescript
// src/mqtt/client.ts
import mqtt from 'mqtt';

// Dual-path connectivity
const WARP_BROKER = 'mqtt://10.43.X.X:1883';      // Private IP via WARP (raw TCP, 8hr idle)
const WSS_BROKER = 'wss://mqtt.bto.bar/ws';        // Public hostname (WebSocket, 100s idle)

const WARP_KEEPALIVE = 300;  // 5 minutes — WARP has 8hr idle, so keepalive is relaxed
const WSS_KEEPALIVE = 60;    // 60 seconds — must stay under Cloudflare's 100s idle timeout
const RECONNECT_PERIOD = 3000;

async function detectWarp(): Promise<boolean> {
  // Attempt TCP connection to private RabbitMQ IP with 3s timeout
  // If reachable, WARP is active and routing private traffic
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`http://10.43.X.X:15672/api/health/checks/alarms`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  }
}

const isWarp = await detectWarp();
const brokerUrl = isWarp ? WARP_BROKER : WSS_BROKER;
const keepalive = isWarp ? WARP_KEEPALIVE : WSS_KEEPALIVE;

const client = mqtt.connect(brokerUrl, {
  protocolVersion: 5,
  keepalive,
  reconnectPeriod: RECONNECT_PERIOD,
  clean: false,  // Persistent session — receive queued messages on reconnect
  clientId: `gwa-mobile-${deviceId}`,
  properties: {
    sessionExpiryInterval: 3600,  // 1 hour session expiry
  },
});
```

**On WARP disconnection:** If the WARP connection drops (e.g., Android kills VPN background), the reconnection handler detects the failure and falls back to WSS automatically. On next successful reconnect via WSS, persistent session ensures queued messages are delivered.

**Subscription topics:**
- `gwa/+/+/+/state_change` — State machine transitions (for all issues)
- `gwa/{owner}/{repo}/{issue}/#` — All events for a specific issue (when viewing detail)

**Reconnection strategy:**
- Exponential backoff: 3s, 6s, 12s, 24s, max 60s
- Add jitter (±20%) to prevent thundering herd
- On reconnect failure, re-detect WARP availability and switch transport if needed
- On reconnect, re-subscribe to active topics
- Log disconnect reason and transport type for debugging

### 5.4 Screens

**Session List (index.tsx):**
- Fetches initial session list via REST: `GET https://gwa-api.bto.bar/api/sessions`
- Subscribes to `gwa/+/+/+/state_change` for real-time updates
- Shows: issue number, repo, current state (color-coded), last activity time
- Pull-to-refresh

**Session Detail (session/[id].tsx):**
- Subscribes to `gwa/{owner}/{repo}/{issue}/#` for all events
- Sections:
  - **State:** Current XState state with visual indicator
  - **Activity Feed:** Real-time scrolling list of activity events
  - **Question (if blocked):** Shows question text + answer input
  - **Screenshot:** Latest terminal screenshot (fetched on demand)
  - **Context:** Session metadata (branch, worktree, agent, duration)

**Answer Modal:**
- Text input for answering blocked session questions
- Publishes answer via REST: `POST https://gwa-api.bto.bar/api/sessions/{id}/answer`
- (REST, not MQTT, because the answer needs server-side validation and processing)

### 5.5 Push Notification Setup

```typescript
// src/notifications/setup.ts
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';

async function registerForPushNotifications() {
  if (!Device.isDevice) return null; // Emulators can't receive push

  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return null;

  // Create notification channel (required for Android 8+)
  await Notifications.setNotificationChannelAsync('gwa-alerts', {
    name: 'GWA Alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
  });

  const token = await Notifications.getExpoPushTokenAsync({
    projectId: Constants.expoConfig?.extra?.eas?.projectId,
  });

  // Register token with GWA backend
  await fetch('https://gwa-api.bto.bar/api/push-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.data, platform: 'android' }),
  });

  return token;
}
```

### 5.6 Notification Strategy: Process-Stopping Events Only

**Principle:** Only events that halt a session's progress and require human action generate push notifications. Everything else is synced when the app returns to foreground.

#### Push Notification Categories (Background)

| Event | Priority | Title | Body | Action |
|-------|----------|-------|------|--------|
| `blocked` | **High** | "#{issue}: Question" | First 100 chars of question | Tap → Answer Modal |
| `error` | **High** | "#{issue}: Error" | Error message | Tap → Session Detail |
| `complete` | Default | "#{issue}: Complete" | "PR merged" / "Done" summary | Tap → Session Detail |

These are the **only** events pushed. All three share the trait that the session has stopped making progress.

#### NOT Pushed (Foreground Sync Only)

| Event | Reason |
|-------|--------|
| `state_change` | Informational — session is still progressing, no action needed |
| `activity` | Streaming output — only meaningful in real-time UI context |
| `screenshot` | Large payload, only useful when actively viewing session |

#### Android Notification Channels

```typescript
// High-priority channel for process-stopping events
await Notifications.setNotificationChannelAsync('gwa-action-required', {
  name: 'Action Required',
  importance: Notifications.AndroidImportance.HIGH,
  vibrationPattern: [0, 250, 250, 250],
  sound: 'default',
  groupId: 'gwa-alerts',
});

// Default channel for completions
await Notifications.setNotificationChannelAsync('gwa-completions', {
  name: 'Completions',
  importance: Notifications.AndroidImportance.DEFAULT,
  sound: 'default',
  groupId: 'gwa-alerts',
});
```

#### Throttling (Handled by Push Bridge, see Phase 4.5)

- **Per-session debounce:** 30 seconds (collapse rapid events from same session)
- **Global rate limit:** Max 5 notifications/minute (queue overflow)
- **Per-session cooldown:** 5 minutes (prevent same session spamming)
- **Android grouping:** Collapsed summary when 3+ unread ("3 sessions need attention")

#### Foreground Resume Sync

When the app returns from background to foreground:

```typescript
// src/mqtt/client.ts — AppState listener
import { AppState } from 'react-native';

AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    // 1. MQTT persistent session delivers queued messages automatically
    //    (clean: false ensures RabbitMQ queued messages during disconnect)

    // 2. Fetch latest state from REST API as a consistency check
    //    This catches anything missed if MQTT session expired
    syncSessionsFromAPI();

    // 3. Re-detect WARP availability (VPN may have toggled)
    reconnectWithTransportDetection();
  }
});
```

The MQTT persistent session (`clean: false`) is the primary sync mechanism — RabbitMQ queues messages during disconnect and delivers them in FIFO order on reconnect. The REST API call is a safety net in case the MQTT session expired (default: 1 hour).

---

## Phase 6: REST API for Mobile

### 6.1 API Endpoint Service

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

### 6.2 Schema Addition for Push Tokens

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

## Phase 7: Behavioral Test Suite

### 7.1 State Machine Tests

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

### 7.2 Webhook Deduplication Tests

**File:** `src/tests/webhook-dedup.test.ts`

```
- Duplicate delivery ID is rejected
- Different delivery IDs are both processed
- TTL cleanup removes old entries
- Concurrent identical deliveries (only one processes)
```

### 7.3 AMQP Publishing Tests

**File:** `src/tests/amqp-publish.test.ts`

```
- Activity events are published with correct routing key
- State change events include XState snapshot
- Publish failure doesn't crash the handler
- Connection recovery after broker restart
- Message format matches mobile app expectations
```

### 7.4 Session Lifecycle Tests

**File:** `src/tests/session-lifecycle.test.ts`

```
- Full Todo → Done lifecycle with assertions at each step
- Blocked → Resume preserves session state
- Pod restart recovery: interrupted sessions detected and resumable
- Concurrent sessions for different issues don't interfere
- Cleanup removes all artifacts (tmux window, worktree, DB records)
```

---

## Phase 8: Documentation & Cleanup

### 8.1 Update README.md

- Replace ASCII state diagram with XState-generated diagram
- Update architecture section with AMQP/MQTT streaming
- Add mobile app section
- Update tech stack table (remove Redis, add XState, amqplib, mqtt.js)
- Update security section (timing-safe HMAC, fail-closed verification)

### 8.2 Update CLAUDE.md

- Remove Redis from SDK stack table
- Add XState to SDK stack table
- Add amqplib to SDK stack table
- Update operational notes with AMQP configuration

### 8.3 Update CHANGELOG.md

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

### Phase 5: React Native Mobile App
- [ ] 5.1 Create Expo project with TypeScript template
- [ ] 5.2 Install dependencies: `mqtt`, `expo-notifications`, `expo-device`, navigation
- [ ] 5.3 Configure `app.json` with Android package name, FCM
- [ ] 5.4 Add `google-services.json` for FCM
- [ ] 5.5 Create dual-path MQTT client (WARP detection → native TCP or WSS fallback)
- [ ] 5.6 Implement WARP availability detection via private IP health check
- [ ] 5.7 Implement exponential backoff with jitter + transport failover on reconnect
- [ ] 5.8 Create Zustand store for session state management
- [ ] 5.9 Build Session List screen (index.tsx)
- [ ] 5.10 Build Session Detail screen with activity feed
- [ ] 5.11 Build Answer Modal for blocked sessions
- [ ] 5.12 Build Screenshot Viewer component
- [ ] 5.13 Build State Indicator component (color-coded states)
- [ ] 5.14 Set up Expo notifications with two channels (action-required + completions)
- [ ] 5.15 Register push token with GWA backend on app launch
- [ ] 5.16 Handle notification taps — navigate to correct session/answer modal
- [ ] 5.17 Implement AppState foreground resume sync (MQTT queue + REST safety net)
- [ ] 5.18 Configure EAS Build for development and production profiles
- [ ] 5.19 Build APK with `eas build --platform android`
- [ ] 5.20 Test on physical Android device — WARP path (native TCP)
- [ ] 5.21 Test on physical Android device — WSS fallback path
- [ ] 5.22 Test push notifications — only blocked/error/complete arrive
- [ ] 5.23 Test notification throttling — concurrent sessions don't flood
- [ ] 5.24 Test foreground resume sync — missed messages appear in UI
- [ ] 5.25 Test WARP→WSS failover — kill WARP, verify automatic fallback
- [ ] 5.26 Install + configure Cloudflare One agent on test device

### Phase 6: REST API
- [ ] 6.1 Create `src/api/handler.ts` with Bun.serve
- [ ] 6.2 Implement `GET /api/sessions` endpoint
- [ ] 6.3 Implement `GET /api/sessions/:id` endpoint (with XState snapshot)
- [ ] 6.4 Implement `POST /api/sessions/:id/answer` endpoint
- [ ] 6.5 Implement `GET /api/sessions/:id/screenshot` endpoint
- [ ] 6.6 Implement `POST /api/push-tokens` endpoint
- [ ] 6.7 Implement `DELETE /api/push-tokens` endpoint
- [ ] 6.8 Add bearer token authentication middleware
- [ ] 6.9 Add input validation on all endpoints
- [ ] 6.10 Add Cloudflare tunnel route for API
- [ ] 6.11 Add build target for `gwa-api` in `package.json`
- [ ] 6.12 Add `gwa-api` to Dockerfile
- [ ] 6.13 Write API endpoint tests
- [ ] 6.14 Run `bun run typecheck` — verify clean

### Phase 7: Behavioral Tests
- [ ] 7.1 Write full session lifecycle test (Todo → Done)
- [ ] 7.2 Write blocked → resume lifecycle test
- [ ] 7.3 Write pod restart recovery test
- [ ] 7.4 Write concurrent session isolation test
- [ ] 7.5 Write cleanup artifact verification test
- [ ] 7.6 Run full test suite — verify all pass

### Phase 8: Documentation & Cleanup
- [ ] 8.1 Update `README.md` — architecture, tech stack, state diagram
- [ ] 8.2 Update `CLAUDE.md` — remove Redis, add XState/amqplib
- [ ] 8.3 Update `CHANGELOG.md` with v4.0 changes
- [ ] 8.4 Bump `package.json` version to 4.0.0
- [ ] 8.5 Final `bun run typecheck` + `bun test`
- [ ] 8.6 Build all binaries: `bun run build`
- [ ] 8.7 Build and push Docker image
- [ ] 8.8 Deploy to K3s cluster
- [ ] 8.9 End-to-end test: move issue through full lifecycle on real project

---

## Dependencies Summary

### Add
| Package | Version | Purpose |
|---------|---------|---------|
| `xstate` | `^5.26.0` | Formal state machine |
| `amqplib` | `^0.10.7` | AMQP publishing to RabbitMQ |
| `@types/amqplib` | `^0.10.5` | TypeScript types |

### Remove
| Package | Reason |
|---------|--------|
| `ioredis` | Replaced by SQLite |

### Infrastructure
| Component | Change |
|-----------|--------|
| RabbitMQ | Enable `rabbitmq_mqtt` (port 1883) + `rabbitmq_web_mqtt` (port 15675) |
| Cloudflare Tunnel | Add public route `mqtt.bto.bar` → `rabbitmq:15675` (WSS fallback) |
| Cloudflare Tunnel | Add private network route `10.43.0.0/16` (WARP primary) |
| Cloudflare Tunnel | Add route `gwa-api.bto.bar` → `gwa-runner:3001` |
| Zero Trust | Split Tunnels Include: `10.43.0.0/16`; Gateway policy: allow RabbitMQ ports |
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
| React Native mqtt.js Expo Metro resolution | Low | Low | Fixed in Expo SDK 54+; use `unstable_enablePackageExports` if needed |
| XState history state bug (#5178) | Low | Low | We use context.previousState instead of XState history states |
| WARP battery drain on some devices | Medium | Low | Monitor reports; 5-minute keepalive on WARP path (vs 60s on WSS) reduces radio wake-ups |
