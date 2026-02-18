/**
 * Behavioral Test: Full Session Lifecycle
 *
 * Tests the complete flow: idle -> planning -> inProgress -> qa -> review -> done
 * with XState actor transitions persisted to SQLite at every step.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getStateName } from "../../lib/state-machine.js";
import { SessionState } from "../../shared/types.js";
import {
  createTestDatabase,
  createTestSession,
  defaultContext,
  actorInState,
  persistSnapshotToDb,
  restoreActorFromDb,
} from "./helpers.js";

describe("Full Session Lifecycle", () => {
  let db: Database;
  const sessionId = "lifecycle-test-1";

  beforeEach(() => {
    db = createTestDatabase();
    createTestSession(db, sessionId, { github_number: 42 });
  });

  afterEach(() => {
    db.close();
  });

  test("idle -> planning -> inProgress -> qa -> review -> done with snapshots", () => {
    // Start: create actor in idle state
    const actor = actorInState("idle", { ...defaultContext, sessionId });
    expect(getStateName(actor)).toBe("idle");
    persistSnapshotToDb(db, sessionId, actor);

    // Verify snapshot stored in DB
    let row = db.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get(sessionId) as {
      xstate_snapshot: string;
    };
    expect(row.xstate_snapshot).toBeTruthy();
    let parsed = JSON.parse(row.xstate_snapshot);
    expect(parsed.value).toBe("idle");

    // Step 1: idle -> planning
    actor.send({ type: "START_PLANNING" });
    expect(getStateName(actor)).toBe("planning");
    persistSnapshotToDb(db, sessionId, actor);

    row = db.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get(sessionId) as {
      xstate_snapshot: string;
    };
    parsed = JSON.parse(row.xstate_snapshot);
    expect(parsed.value).toBe("planning");

    // Step 2: planning -> inProgress
    actor.send({ type: "INJECT_PROMPT" });
    expect(getStateName(actor)).toBe("inProgress");
    persistSnapshotToDb(db, sessionId, actor);

    // Step 3: inProgress -> qa
    actor.send({ type: "RUN_TESTS" });
    expect(getStateName(actor)).toBe("qa");
    persistSnapshotToDb(db, sessionId, actor);

    // Step 4: qa -> review
    actor.send({ type: "STATUS_UPDATE" });
    expect(getStateName(actor)).toBe("review");
    persistSnapshotToDb(db, sessionId, actor);

    // Step 5: review -> done
    actor.send({ type: "DEPLOY_AND_CLEANUP" });
    expect(getStateName(actor)).toBe("done");
    persistSnapshotToDb(db, sessionId, actor);

    // Mark session complete in DB
    db.run(
      `UPDATE sessions SET status = 'complete', completed_at = unixepoch() WHERE id = ?`,
      [sessionId],
    );

    // Verify final state
    row = db.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get(sessionId) as {
      xstate_snapshot: string;
    };
    parsed = JSON.parse(row.xstate_snapshot);
    expect(parsed.value).toBe("done");

    const session = db.query(`SELECT status, completed_at FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
      completed_at: number | null;
    };
    expect(session.status).toBe("complete");
    expect(session.completed_at).not.toBeNull();
  });

  test("restored actor from snapshot continues where it left off", () => {
    // Create actor, transition to inProgress, persist
    const actor = actorInState("idle", { ...defaultContext, sessionId });
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    expect(getStateName(actor)).toBe("inProgress");
    persistSnapshotToDb(db, sessionId, actor);

    // Restore from DB
    const restored = restoreActorFromDb(db, sessionId);
    expect(restored).not.toBeNull();
    expect(getStateName(restored!)).toBe("inProgress");

    // Continue transitioning from restored state
    restored!.send({ type: "RUN_TESTS" });
    expect(getStateName(restored!)).toBe("qa");

    restored!.send({ type: "STATUS_UPDATE" });
    expect(getStateName(restored!)).toBe("review");

    restored!.send({ type: "DEPLOY_AND_CLEANUP" });
    expect(getStateName(restored!)).toBe("done");
  });

  test("context is preserved through full lifecycle", () => {
    const ctx = {
      sessionId,
      previousState: null as SessionState | null,
      issueNumber: 99,
      repoOwner: "testorg",
      repoName: "myrepo",
    };

    const actor = actorInState("idle", ctx);
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    actor.send({ type: "RUN_TESTS" });
    persistSnapshotToDb(db, sessionId, actor);

    const restored = restoreActorFromDb(db, sessionId);
    expect(restored).not.toBeNull();

    const restoredCtx = restored!.getSnapshot().context;
    expect(restoredCtx.sessionId).toBe(sessionId);
    expect(restoredCtx.issueNumber).toBe(99);
    expect(restoredCtx.repoOwner).toBe("testorg");
    expect(restoredCtx.repoName).toBe("myrepo");
  });

  test("snapshot persisted at every step can be individually restored", () => {
    // We'll use separate session IDs to store snapshots at each step
    const steps = [
      { event: null, expectedState: "idle" },
      { event: { type: "START_PLANNING" as const }, expectedState: "planning" },
      { event: { type: "INJECT_PROMPT" as const }, expectedState: "inProgress" },
      { event: { type: "RUN_TESTS" as const }, expectedState: "qa" },
      { event: { type: "STATUS_UPDATE" as const }, expectedState: "review" },
      { event: { type: "DEPLOY_AND_CLEANUP" as const }, expectedState: "done" },
    ];

    const actor = actorInState("idle", { ...defaultContext, sessionId });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepSessionId = `${sessionId}-step-${i}`;
      createTestSession(db, stepSessionId);

      if (step.event) {
        actor.send(step.event);
      }

      expect(getStateName(actor)).toBe(step.expectedState);
      persistSnapshotToDb(db, stepSessionId, actor);
    }

    // Verify each step can be restored independently
    for (let i = 0; i < steps.length; i++) {
      const stepSessionId = `${sessionId}-step-${i}`;
      const restored = restoreActorFromDb(db, stepSessionId);
      expect(restored).not.toBeNull();
      expect(getStateName(restored!)).toBe(steps[i].expectedState);
    }
  });
});
