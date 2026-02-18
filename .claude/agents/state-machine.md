# State Machine Agent

You are a specialized agent for implementing the XState v5 state machine in GWA (v4.0 feature).

## Your Scope

### Files to Create
- `src/lib/state-machine.ts` - XState v5 machine definition
- `src/shared/types.ts` - Shared types, enums, message schemas
- `src/tests/state-machine.test.ts` - Comprehensive state machine tests

### Files to Modify
- `src/transitions/*.ts` - Integrate XState validation before execution
- `src/lib/db.ts` - Add xstate_snapshot column operations
- `schema.sql` - Add `xstate_snapshot TEXT`, `xstate_schema_version INTEGER` columns

## XState v5 Machine Design

### States
`todo` | `planning` | `inProgress` | `qa` | `blocked` | `review` | `done`

### Context (plain data only - NO functions or class instances)
```typescript
interface GWAContext {
  sessionId: string | null;
  issueNumber: number;
  repo: string;
  owner: string;
  itemNodeId: string;
  contentNodeId: string;
  previousState: string | null;  // For blocked->resume
  hasPlan: boolean;
  hasTests: boolean;
  testsPassed: boolean;
  schemaVersion: number;
}
```

### Events (mapped from column transitions)
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

## Critical Gotchas (from research)

1. **`undefined` in snapshots:** `getPersistedSnapshot()` may return `undefined` for `output`/`error` fields. Fix: `JSON.stringify(snapshot, (_, v) => v === undefined ? null : v)`
2. **No functions in context:** Functions are silently dropped by JSON serialization. Keep context as plain data only.
3. **History state bug [#5178]:** Restoring from JSON can break history state behavior. Use `previousState` context field instead of XState history states.
4. **Machine version changes:** No built-in migration. Store schema version alongside snapshots.
5. **bun:sqlite is synchronous:** A blocked write halts the event loop. Keep transactions short.

## Persistence Pattern

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

## Integration with Orchestrator

The orchestrator publishes transition commands via RabbitMQ. Each pod:
1. Loads XState actor from SQLite snapshot
2. Maps column transition to XState event
3. Sends event - XState validates the transition
4. If valid: persist snapshot, execute handler, publish state_change event
5. If invalid: publish error event, post GitHub comment

## Test Requirements

- Every valid forward transition
- Every valid backward transition
- Every blocked->resume path (previousState correctness)
- Every guard (planExists prevents premature advancement)
- Invalid transitions are rejected
- Snapshot serialization round-trip
- Schema version migration

## Dependencies

```bash
bun add xstate@^5.26.0
```
