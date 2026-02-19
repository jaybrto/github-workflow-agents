/**
 * E2E test helpers for the GWA session lifecycle.
 *
 * Provides:
 *   - createTestDb()      — isolated in-memory SQLite with full schema
 *   - createTestActor()   — fresh XState actor starting in idle
 *   - actorInState()      — XState actor pre-positioned in a given state
 *   - sendAndExpect()     — send event and assert resulting state
 */

import { Database } from "bun:sqlite";
import { createActor } from "xstate";
import { readFileSync } from "fs";
import { join } from "path";
import { sessionMachine } from "../../lib/state-machine.js";
import type { SessionContext } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

const schemaLocations = [
  // Relative to this file: src/tests/e2e/helpers.ts -> project root is 3 dirs up
  join(import.meta.dir, "../../../schema.sql"),
  // Pod / container paths
  "/opt/gwa/schema.sql",
  "/home/runner/.claude/schema.sql",
];

function loadSchema(): string {
  for (const loc of schemaLocations) {
    try {
      return readFileSync(loc, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error(
    `schema.sql not found. Tried:\n${schemaLocations.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Database factory
// ---------------------------------------------------------------------------

/**
 * Create an isolated in-memory SQLite database with the full GWA schema.
 * Each call returns a completely independent database — no shared state.
 */
export function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(loadSchema());
  return db;
}

// ---------------------------------------------------------------------------
// Default test context
// ---------------------------------------------------------------------------

export const defaultTestContext: SessionContext = {
  sessionId: "e2e-test-session",
  previousState: null,
  issueNumber: 1,
  repoOwner: "jaybrto",
  repoName: "e2e-test-repo",
};

// ---------------------------------------------------------------------------
// Actor factories
// ---------------------------------------------------------------------------

/**
 * Create a fresh XState actor starting in idle with the default test context.
 * Each call returns an independent actor with no shared state.
 */
export function createTestActor(): ReturnType<typeof createActor<typeof sessionMachine>> {
  const actor = createActor(sessionMachine, {
    snapshot: sessionMachine.resolveState({
      value: "idle",
      context: defaultTestContext,
    }),
  });
  actor.start();
  return actor;
}

/**
 * Create an XState actor pre-positioned in the given state.
 * Useful for testing transitions that start mid-lifecycle without
 * having to replay all preceding events.
 *
 * @param state    - XState state name (e.g. "inProgress", "blocked")
 * @param context  - Optional context overrides (e.g. previousState for blocked)
 */
export function actorInState(
  state: string,
  context?: Partial<SessionContext>,
): ReturnType<typeof createActor<typeof sessionMachine>> {
  const ctx = { ...defaultTestContext, ...context };
  const actor = createActor(sessionMachine, {
    snapshot: sessionMachine.resolveState({
      value: state,
      context: ctx,
    }),
  });
  actor.start();
  return actor;
}

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

/**
 * Send an event to an actor and assert it lands in the expected state.
 * Throws a descriptive error if the state does not match.
 *
 * @param actor         - Running XState actor
 * @param event         - Event object to send (must have `type`)
 * @param expectedState - XState state name to assert after send
 */
export function sendAndExpect(
  actor: ReturnType<typeof createActor<typeof sessionMachine>>,
  event: { type: string; [key: string]: unknown },
  expectedState: string,
): void {
  actor.send(event as Parameters<typeof actor.send>[0]);
  const snapshot = actor.getSnapshot();
  const currentState =
    typeof snapshot.value === "string"
      ? snapshot.value
      : JSON.stringify(snapshot.value);

  if (!snapshot.matches(expectedState)) {
    throw new Error(
      `sendAndExpect failed:\n` +
        `  Event:    ${event.type}\n` +
        `  Expected: ${expectedState}\n` +
        `  Got:      ${currentState}`,
    );
  }
}
