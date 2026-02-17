# GWA Deep Review & Recommendations

**Version:** 3.4 | **Date:** February 11, 2026

## Executive Summary

The GWA codebase is a well-structured production system with solid foundations: clean TypeScript, proper K8s persistence, comprehensive telemetry, and a thorough 38-transition state machine covering real-world workflows. However, the state machine is implemented as a flat lookup table with no runtime validation, session state is split across Redis and SQLite without consistency guarantees, and there are no behavioral tests for business logic. This review identifies 8 concrete improvements ordered by priority.

---

## Critical Issues

### 1. State Machine Is a Flat Lookup Table

**File:** `src/webhook/handler.ts:233-303`

The entire 38-transition state machine is a `Record<string, string>` mapping `"FromColumn:ToColumn"` to handler names. There is zero validation that the transition is legal given the current session state:

- Users can drag GitHub Project cards to any column manually
- API calls can force any transition
- No guard checks session prerequisites (e.g., "does a plan exist before moving to In Progress?")
- SQLite `sessions.status` (running/blocked/starting/interrupted/error/complete) is disconnected from project board columns (Todo/Planning/In Progress/QA/Blocked/Review/Done)
- Invalid transitions (e.g., Todo → QA) silently no-op instead of failing explicitly
- Valid transitions (e.g., skip-qa) run even if the session is in an `interrupted` state

### 2. No Webhook Delivery Deduplication

**File:** `src/webhook/handler.ts:349-400`

GitHub webhooks can be retried on timeout or 5xx. The `X-GitHub-Delivery` ID is logged but never deduplicated. A retry could trigger `start-planning` twice for the same issue, creating duplicate sessions and tmux windows.

### 3. Dual Persistence Creates Consistency Gaps

Redis stores session state with 7-day TTL (`src/lib/redis.ts`), SQLite stores the same data permanently (`src/lib/db.ts`), and the webhook handler has its own transition map. These three sources of truth can diverge:

- Redis TTL expires but SQLite still shows active session
- Pod restart marks sessions as `interrupted` in SQLite but Redis still shows `running`
- No transactional guarantee between Redis write and SQLite write

### 4. Test Coverage Is Structural, Not Behavioral

The 7 test files validate that modules export the right functions, files exist, and TypeScript parses. There are zero tests for:

- State transition logic (is `QA → In Progress` valid when session status is X?)
- Claude subprocess error handling paths
- Recovery after partial failures
- Swarm task dependency resolution
- Concurrent session handling with SQLite WAL

### 5. Recovery Is Best-Effort

**File:** `src/lib/recovery.ts`

- No mechanism to automatically re-trigger workflows after recovery
- Resume prompt injected via shell with basic escaping (line 171-173) — complex prompts with backticks or shell metacharacters could break
- `clearOldInterruptedSessions()` marks sessions as `error` after 24 hours but doesn't notify anyone

### 6. Signature Verification Fails Open

**File:** `src/webhook/handler.ts:65-76`

If `WEBHOOK_SECRET` is empty, `verifySignature()` returns `true`. In production this should fail closed. Additionally, the signature comparison uses `===` which is vulnerable to timing attacks — should use `crypto.timingSafeEqual`.

---

## Recommendations

### 1. Formal State Machine with XState v5

**Why XState over Dapr:**

| Criteria | XState | Dapr Workflows |
|----------|--------|---------------|
| Infrastructure overhead | Zero (in-process library) | Sidecar per pod (~128MB), placement service, scheduler |
| Language fit | Native TypeScript | gRPC SDK, proto definitions |
| Visualization | Built-in inspector + state diagrams | External monitoring only |
| Serialization | JSON snapshots → SQLite | Requires Dapr state store |
| Learning curve | Small (one library) | Large (new runtime + concepts) |
| Scale fit | Perfect for 1-10 concurrent sessions | Designed for 1000+ distributed actors |

XState runs in-process in your Bun TypeScript stack — no sidecar, no new infrastructure. It produces visual state diagrams, has typed guards and actions, and serializable snapshots work with your existing SQLite checkpoint system.

**Implementation sketch:**

```typescript
// src/lib/state-machine.ts
import { createMachine, assign } from 'xstate';

const gwaMachine = createMachine({
  id: 'gwa-workflow',
  initial: 'todo',
  context: {
    sessionId: null,
    issueNumber: 0,
    repo: '',
    hasPlan: false,
    testsPassed: false,
    previousState: null as string | null,
  },
  states: {
    todo: {
      on: {
        START_PLANNING: { target: 'planning', guard: 'hasNoActiveSession' },
        QUICK_START: { target: 'inProgress', guard: 'hasNoActiveSession' },
        CLOSE: 'done',
        BLOCK: 'blocked',
      },
    },
    planning: {
      entry: ['createSession', 'startPlanningREPL'],
      on: {
        PLAN_APPROVED: { target: 'inProgress', guard: 'planExists' },
        BLOCK: { target: 'blocked', actions: 'savePreviousState' },
        CANCEL: { target: 'todo', actions: 'destroySession' },
        CLOSE: 'done',
        SKIP_IMPL: { target: 'qa', guard: 'planExists' },
      },
    },
    inProgress: {
      entry: ['injectImplementationPrompt'],
      on: {
        IMPL_COMPLETE: 'qa',
        BLOCK: { target: 'blocked', actions: 'savePreviousState' },
        CANCEL: { target: 'todo', actions: 'destroySession' },
        REPLAN: 'planning',
        SKIP_QA: 'review',
        CLOSE: 'done',
      },
    },
    qa: {
      entry: ['runPlaywright'],
      on: {
        TESTS_PASSED: 'review',
        TESTS_FAILED: 'inProgress',
        BLOCK: { target: 'blocked', actions: 'savePreviousState' },
        CANCEL: { target: 'todo', actions: 'destroySession' },
        REPLAN: 'planning',
        CLOSE: 'done',
      },
    },
    blocked: {
      entry: ['pauseSession', 'postQuestion'],
      on: {
        ANSWER_RECEIVED: [
          { target: 'planning', guard: 'previousWasPlanning' },
          { target: 'inProgress', guard: 'previousWasInProgress' },
          { target: 'qa', guard: 'previousWasQA' },
          { target: 'review', guard: 'previousWasReview' },
        ],
        CANCEL: { target: 'todo', actions: 'destroySession' },
      },
    },
    review: {
      on: {
        APPROVED: 'done',
        REQUEST_CHANGES: 'inProgress',
        RETEST: 'qa',
        REPLAN: 'planning',
        BLOCK: { target: 'blocked', actions: 'savePreviousState' },
        CANCEL: { target: 'todo', actions: 'destroySession' },
        CLOSE: 'done',
      },
    },
    done: {
      entry: ['deployAndCleanup'],
      on: {
        REOPEN: 'todo',
      },
    },
  },
});
```

**Key benefits:**

- **Guards** like `planExists` prevent invalid transitions (e.g., moving to In Progress without a plan)
- **Blocked state** remembers where it came from via `previousState` context
- **Invalid transitions throw** instead of silently no-oping
- **Serializable snapshots** via `actor.getSnapshot()` go straight into SQLite
- **`@xstate/inspect`** gives real-time state visualization via WebSocket

### 2. Eliminate Redis, Consolidate on SQLite

Redis and SQLite store overlapping session data. Remove Redis entirely:

1. Replace `src/lib/redis.ts` session cache with a SQLite view: `CREATE VIEW active_sessions AS SELECT * FROM sessions WHERE status NOT IN ('complete', 'error')`
2. Add a `webhook_deliveries` table for deduplication (replacing what Redis would do)
3. One fewer infrastructure dependency = one fewer failure mode

The `redis.ts` module's functions (`getSession`, `createSession`, `podActivePrs`) all have SQLite equivalents in `db.ts` already.

### 3. Real-Time Progress Streaming

For mobile monitoring (like [Happy Coder](https://happy.engineering/)):

**Recommended: SSE endpoint + PWA**

Add a `/stream/:sessionId` Server-Sent Events endpoint to the webhook handler or a new lightweight Bun service:

```typescript
// src/stream/handler.ts
Bun.serve({
  port: 3001,
  fetch(req) {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/stream\/(.+)/);
    if (!match) return new Response("Not found", { status: 404 });

    const sessionId = match[1];
    let lastSeen = Math.floor(Date.now() / 1000) - 300; // Last 5 minutes

    return new Response(
      new ReadableStream({
        start(controller) {
          const interval = setInterval(() => {
            const activities = db.query(
              `SELECT * FROM activity_log
               WHERE session_id = ? AND timestamp > ?
               ORDER BY timestamp ASC`
            ).all(sessionId, lastSeen);

            for (const activity of activities) {
              controller.enqueue(`data: ${JSON.stringify(activity)}\n\n`);
              lastSeen = activity.timestamp;
            }
          }, 2000);

          req.signal.addEventListener("abort", () => clearInterval(interval));
        },
      }),
      { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
    );
  },
});
```

**Additional endpoints:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/sessions` | GET | List active sessions with status |
| `GET /api/sessions/:id` | GET | Session detail with XState snapshot |
| `GET /stream/:id` | GET | SSE real-time activity stream |
| `POST /api/sessions/:id/answer` | POST | Answer a blocked session's question |
| `GET /api/sessions/:id/screenshot` | GET | Latest tmux screenshot (PNG) |

Expose through the existing Cloudflare tunnel. A PWA gives home-screen install on Android with push notifications via Web Push API, avoiding a native app.

**Alternative: Happy Coder integration**

Replace `claude` with `happy` in `src/lib/swarm.ts:562` and `src/lib/repl-session.ts` to get Happy Coder's encrypted mobile streaming with minimal code changes. Tradeoff: depends on their relay infrastructure.

### 4. Webhook Delivery Deduplication

Add to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  handler TEXT,
  transition TEXT,
  processed_at INTEGER DEFAULT (unixepoch()),
  result TEXT
);
CREATE INDEX idx_webhook_deliveries_age ON webhook_deliveries(processed_at);
```

Check before processing in `handler.ts`:

```typescript
const existing = db.query(
  'SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ?'
).get(deliveryId);
if (existing) {
  console.log(`[Webhook] Duplicate delivery ${deliveryId}, skipping`);
  return new Response("OK", { status: 200 });
}
```

### 5. Fix Signature Verification

```typescript
import { createHmac, timingSafeEqual } from "crypto";

function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.error("[Webhook] FATAL: No webhook secret configured");
    return false; // Fail closed
  }

  const expected = `sha256=${createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;

  if (signature.length !== expected.length) return false;

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### 6. Add Behavioral Unit Tests

Priority test areas:

```
src/tests/
├── state-machine.test.ts      # Every valid transition, every invalid transition, guards
├── recovery.test.ts           # Pod restart simulation, checkpoint replay
├── swarm-dependencies.test.ts # Blocked tasks, circular deps, concurrent completion
├── webhook-dedup.test.ts      # Duplicate deliveries, concurrent identical events
├── claude-subprocess.test.ts  # Timeout, exit codes, stream-json parsing
└── session-lifecycle.test.ts  # Full Todo→Done flow with SQLite assertions
```

These can all run locally with in-memory SQLite (`new Database(":memory:")`) and mocked externals.

### 7. Consolidate Session State

With XState, the SQLite `sessions.status` field stores the XState snapshot JSON directly:

```typescript
const stateToColumn: Record<string, string> = {
  'todo': 'Todo',
  'planning': 'Planning',
  'inProgress': 'In Progress',
  'qa': 'QA',
  'blocked': 'Blocked',
  'review': 'Review',
  'done': 'Done',
};
```

The mapping becomes bidirectional and eliminates drift between the GitHub Project board, the database, and the in-memory state.

### 8. Why NOT Dapr

| Concern | Assessment |
|---------|-----------|
| Sidecar overhead | ~128MB per pod; gwa-runner is already at 4-8GB with resource pressure |
| Infrastructure | Requires Dapr runtime (placement service, scheduler, state store) on K3s |
| Scale fit | Designed for 1000+ distributed actors; GWA has 1-10 concurrent sessions |
| Actor model mismatch | One session per issue through a linear state machine ≠ actor pattern |
| Complexity | Adds gRPC SDK, proto definitions, sidecar config, CRDs |
| Alternative | XState gives everything needed with zero infrastructure overhead |

Dapr would make sense if you were running 100+ repos with thousands of concurrent sessions requiring distributed coordination. At current scale, it's over-engineering.

---

## Priority Order

| # | Change | Impact | Effort | Risk |
|---|--------|--------|--------|------|
| 1 | Fix signature verification (fail closed + timing-safe) | Security | Small | None |
| 2 | Add webhook delivery deduplication table | Reliability | Small | None |
| 3 | Implement XState state machine | Correctness | Medium | Low |
| 4 | Remove Redis, consolidate on SQLite | Simplicity | Medium | Low |
| 5 | Add SSE streaming endpoint | Visibility | Medium | None |
| 6 | Add behavioral unit tests | Reliability | Medium | None |
| 7 | Build PWA for mobile monitoring | UX | Large | None |
| 8 | Consolidate session state with XState snapshots | Consistency | Medium | Low |

---

## Dependencies to Add

```json
{
  "xstate": "^5.19.0",
  "@xstate/inspect": "^0.8.0"
}
```

No new infrastructure required. All changes run within the existing Bun + K3s stack.
