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
                                        │  rabbitmq_web_mqtt   │
                                        │  port 15675 /ws      │
                                        └──────────┬───────────┘
                                                   │
                                                   │ Cloudflare Tunnel
                                                   │ wss://mqtt.bto.bar/ws
                                                   ▼
                                        ┌──────────────────────┐
                                        │  React Native App    │
                                        │  (Expo Dev Build)    │
                                        │  mqtt.js over WSS    │
                                        │  + expo-notifications│
                                        │  + FCM push          │
                                        └──────────────────────┘
```

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

### Cloudflare Tunnel + MQTT/WebSocket

- **100-second idle timeout.** Non-configurable on non-Enterprise plans. MQTT keepalive must be < 100 seconds. **Use 60-second keepalive.**
- **Periodic infrastructure restarts.** Cloudflare deploys cause connection drops. **Must implement reconnection with exponential backoff.**
- **Reports of 20-30 second unexplained drops** (cloudflared [#1282](https://github.com/cloudflare/cloudflared/issues/1282)). **Multiple cloudflared replicas mitigate this** (we already run 2).
- **Tunnel type must be HTTP** (not TCP) for WebSocket proxying.

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

### 4.5 Push Notification Bridge

**New file:** `src/lib/push-bridge.ts`

A small service (can run in the webhook pod or as a sidecar) that:
1. Subscribes to MQTT topics `gwa/+/+/+/blocked`, `gwa/+/+/+/error`, `gwa/+/+/+/complete`
2. On receiving a message, sends an Expo push notification via `https://exp.host/--/api/v2/push/send`
3. Expo push tokens are stored in SQLite (registered by the mobile app via a REST endpoint)

This solves the background notification problem without requiring background MQTT on the mobile app.

### 4.6 K8s Configuration

Add to `k8s/gwa-runner-statefulset.yaml`:
```yaml
env:
  - name: RABBITMQ_URL
    value: "amqp://rabbitmq.default.svc.cluster.local:5672"
```

Add Cloudflare tunnel route for MQTT WebSocket:
```yaml
# In cloudflared config
- hostname: mqtt.bto.bar
  service: http://rabbitmq.default.svc.cluster.local:15675
  originRequest:
    connectTimeout: 30s
    tcpKeepAlive: 30s
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

### 5.3 MQTT Client Configuration

```typescript
// src/mqtt/client.ts
import mqtt from 'mqtt';

const MQTT_BROKER = 'wss://mqtt.bto.bar/ws';
const KEEPALIVE = 60;  // Under Cloudflare's 100s idle timeout
const RECONNECT_PERIOD = 3000;  // 3 second base, with jitter

const client = mqtt.connect(MQTT_BROKER, {
  protocolVersion: 5,
  keepalive: KEEPALIVE,
  reconnectPeriod: RECONNECT_PERIOD,
  clean: false,  // Persistent session — receive queued messages on reconnect
  clientId: `gwa-mobile-${deviceId}`,
  properties: {
    sessionExpiryInterval: 3600,  // 1 hour session expiry
  },
});
```

**Subscription topics:**
- `gwa/+/+/+/state_change` — State machine transitions (for all issues)
- `gwa/{owner}/{repo}/{issue}/#` — All events for a specific issue (when viewing detail)

**Reconnection strategy:**
- Exponential backoff: 3s, 6s, 12s, 24s, max 60s
- Add jitter (±20%) to prevent thundering herd
- On reconnect, re-subscribe to active topics
- Log disconnect reason for debugging

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

### 5.6 Notification Categories

| Event | Priority | Title | Body |
|-------|----------|-------|------|
| `blocked` | High | "Question on #{issue}" | First 100 chars of question |
| `error` | High | "Error on #{issue}" | Error message |
| `complete` | Default | "#{issue} Complete" | Summary |
| `state_change` | Low | "#{issue} → {state}" | Only if user opted in |

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

### Phase 4: AMQP Publishing
- [ ] 4.1 Install `amqplib@^0.10.7` and `@types/amqplib`
- [ ] 4.2 Create `src/lib/amqp.ts` with singleton connection + auto-reconnect
- [ ] 4.3 Implement `publishActivity()` with publisher confirms
- [ ] 4.4 Define routing key convention: `gwa.{owner}.{repo}.{issue}.{eventType}`
- [ ] 4.5 Integrate with `logActivity()` in `src/lib/db.ts` (fire-and-forget)
- [ ] 4.6 Publish XState state_change events on every transition
- [ ] 4.7 Create `src/lib/push-bridge.ts` — MQTT subscriber → Expo push
- [ ] 4.8 Add `push_tokens` table to `schema.sql`
- [ ] 4.9 Add `RABBITMQ_URL` env var to StatefulSet
- [ ] 4.10 Add MQTT WebSocket Cloudflare tunnel route
- [ ] 4.11 Enable `rabbitmq_web_mqtt` plugin on RabbitMQ
- [ ] 4.12 Write AMQP publish tests (mock broker)
- [ ] 4.13 Write push bridge tests
- [ ] 4.14 Run `bun run typecheck` — verify clean
- [ ] 4.15 Run `bun test` — verify all pass

### Phase 5: React Native Mobile App
- [ ] 5.1 Create Expo project with TypeScript template
- [ ] 5.2 Install dependencies: `mqtt`, `expo-notifications`, `expo-device`, navigation
- [ ] 5.3 Configure `app.json` with Android package name, FCM
- [ ] 5.4 Add `google-services.json` for FCM
- [ ] 5.5 Create MQTT client module with 60s keepalive, reconnection
- [ ] 5.6 Implement exponential backoff with jitter for reconnection
- [ ] 5.7 Create Zustand store for session state management
- [ ] 5.8 Build Session List screen (index.tsx)
- [ ] 5.9 Build Session Detail screen with activity feed
- [ ] 5.10 Build Answer Modal for blocked sessions
- [ ] 5.11 Build Screenshot Viewer component
- [ ] 5.12 Build State Indicator component (color-coded states)
- [ ] 5.13 Set up Expo notifications with channel configuration
- [ ] 5.14 Register push token with GWA backend on app launch
- [ ] 5.15 Handle notification taps — navigate to correct session
- [ ] 5.16 Configure EAS Build for development and production profiles
- [ ] 5.17 Build APK with `eas build --platform android`
- [ ] 5.18 Test on physical Android device
- [ ] 5.19 Test MQTT connection through Cloudflare tunnel
- [ ] 5.20 Test push notifications (blocked, error, complete events)
- [ ] 5.21 Test reconnection behavior (kill network, reconnect)

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
| RabbitMQ | Enable `rabbitmq_web_mqtt` plugin, port 15675 |
| Cloudflare Tunnel | Add route `mqtt.bto.bar` → `rabbitmq:15675` |
| Cloudflare Tunnel | Add route `gwa-api.bto.bar` → `gwa-runner:3001` |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| XState snapshot incompatibility after machine changes | Medium | High | Store schema version, write migration functions |
| Cloudflare drops MQTT connections frequently | Medium | Low | 60s keepalive + exponential backoff reconnection + push notifications as fallback |
| amqplib large message bug on Bun (#5627) | Low | Low | Our payloads are < 4KB JSON |
| SQLite BUSY under concurrent writes | Low | Medium | 5s busy_timeout + BEGIN IMMEDIATE + short transactions |
| OEM battery optimization kills push notifications | Medium | Low | Document manual whitelist steps in app settings screen |
| React Native mqtt.js Expo Metro resolution | Low | Low | Fixed in Expo SDK 54+; use `unstable_enablePackageExports` if needed |
| XState history state bug (#5178) | Low | Low | We use context.previousState instead of XState history states |
