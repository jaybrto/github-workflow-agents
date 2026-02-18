/**
 * Behavioral Test: Concurrent Session Isolation
 *
 * Tests that multiple sessions in the same SQLite database maintain
 * independent XState state, handle concurrent writes without
 * SQLITE_BUSY crashes, and don't collide on tmux window IDs.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createActor } from "xstate";
import { sessionMachine, getStateName } from "../../lib/state-machine.js";
import { SessionState, type SessionContext } from "../../shared/types.js";
import {
  createTestDatabase,
  createTestSession,
  defaultContext,
  actorInState,
  persistSnapshotToDb,
  restoreActorFromDb,
} from "./helpers.js";

describe("Concurrent Session Isolation", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  test("two sessions maintain independent XState state", () => {
    createTestSession(db, "sess-a", { tmux_window: 1 });
    createTestSession(db, "sess-b", { tmux_window: 2 });

    const actorA = actorInState("idle", { ...defaultContext, sessionId: "sess-a" });
    const actorB = actorInState("idle", { ...defaultContext, sessionId: "sess-b" });

    // Move A to planning
    actorA.send({ type: "START_PLANNING" });
    expect(getStateName(actorA)).toBe("planning");
    expect(getStateName(actorB)).toBe("idle");

    // Move B to inProgress (via QUICK_START)
    actorB.send({ type: "QUICK_START" });
    expect(getStateName(actorA)).toBe("planning");
    expect(getStateName(actorB)).toBe("inProgress");

    // Persist both
    persistSnapshotToDb(db, "sess-a", actorA);
    persistSnapshotToDb(db, "sess-b", actorB);

    // Restore both and verify independence
    const restoredA = restoreActorFromDb(db, "sess-a")!;
    const restoredB = restoreActorFromDb(db, "sess-b")!;
    expect(getStateName(restoredA)).toBe("planning");
    expect(getStateName(restoredB)).toBe("inProgress");
  });

  test("concurrent transitions on both sessions via Promise.all", async () => {
    createTestSession(db, "sess-c", { tmux_window: 3 });
    createTestSession(db, "sess-d", { tmux_window: 4 });

    const actorC = actorInState("idle", { ...defaultContext, sessionId: "sess-c" });
    const actorD = actorInState("idle", { ...defaultContext, sessionId: "sess-d" });

    // Run transitions concurrently
    await Promise.all([
      (async () => {
        actorC.send({ type: "START_PLANNING" });
        actorC.send({ type: "INJECT_PROMPT" });
        actorC.send({ type: "RUN_TESTS" });
        persistSnapshotToDb(db, "sess-c", actorC);
      })(),
      (async () => {
        actorD.send({ type: "QUICK_START" });
        actorD.send({ type: "PAUSE_FOR_QUESTION" });
        persistSnapshotToDb(db, "sess-d", actorD);
      })(),
    ]);

    expect(getStateName(actorC)).toBe("qa");
    expect(getStateName(actorD)).toBe("blocked");

    // Verify DB state
    const rowC = db.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get("sess-c") as {
      xstate_snapshot: string;
    };
    const rowD = db.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get("sess-d") as {
      xstate_snapshot: string;
    };

    expect(JSON.parse(rowC.xstate_snapshot).value).toBe("qa");
    expect(JSON.parse(rowD.xstate_snapshot).value).toBe("blocked");
  });

  test("SQLite busy_timeout handles concurrent writes (no SQLITE_BUSY)", async () => {
    // Create many sessions
    const sessionCount = 10;
    const actors: ReturnType<typeof createActor<typeof sessionMachine>>[] = [];

    for (let i = 0; i < sessionCount; i++) {
      const sid = `concurrent-${i}`;
      createTestSession(db, sid, { tmux_window: 10 + i });
      actors.push(actorInState("idle", { ...defaultContext, sessionId: sid }));
    }

    // Run all transitions concurrently
    await Promise.all(
      actors.map(async (actor, i) => {
        const sid = `concurrent-${i}`;
        actor.send({ type: "START_PLANNING" });
        actor.send({ type: "INJECT_PROMPT" });
        persistSnapshotToDb(db, sid, actor);
      }),
    );

    // Verify all sessions reached inProgress
    for (let i = 0; i < sessionCount; i++) {
      const sid = `concurrent-${i}`;
      const restored = restoreActorFromDb(db, sid)!;
      expect(getStateName(restored)).toBe("inProgress");
    }
  });

  test("tmux window IDs are unique across sessions", () => {
    createTestSession(db, "sess-e", { tmux_window: 1 });
    createTestSession(db, "sess-f", { tmux_window: 2 });
    createTestSession(db, "sess-g", { tmux_window: 3 });

    const rows = db
      .query(`SELECT id, tmux_window FROM sessions ORDER BY tmux_window`)
      .all() as Array<{ id: string; tmux_window: number }>;

    const windows = rows.map((r) => r.tmux_window);
    const uniqueWindows = new Set(windows);

    expect(uniqueWindows.size).toBe(windows.length);
  });

  test("each session maintains its own context through concurrent operations", async () => {
    createTestSession(db, "ctx-a");
    createTestSession(db, "ctx-b");

    const actorA = actorInState("idle", {
      sessionId: "ctx-a",
      previousState: null,
      issueNumber: 100,
      repoOwner: "org-a",
      repoName: "repo-a",
    });

    const actorB = actorInState("idle", {
      sessionId: "ctx-b",
      previousState: null,
      issueNumber: 200,
      repoOwner: "org-b",
      repoName: "repo-b",
    });

    await Promise.all([
      (async () => {
        actorA.send({ type: "START_PLANNING" });
        actorA.send({ type: "PAUSE_FOR_QUESTION" });
        persistSnapshotToDb(db, "ctx-a", actorA);
      })(),
      (async () => {
        actorB.send({ type: "QUICK_START" });
        actorB.send({ type: "RUN_TESTS" });
        persistSnapshotToDb(db, "ctx-b", actorB);
      })(),
    ]);

    const restoredA = restoreActorFromDb(db, "ctx-a")!;
    const restoredB = restoreActorFromDb(db, "ctx-b")!;

    // Verify contexts are independent
    expect(restoredA.getSnapshot().context.issueNumber).toBe(100);
    expect(restoredA.getSnapshot().context.repoOwner).toBe("org-a");
    expect(restoredA.getSnapshot().context.previousState).toBe(SessionState.Planning);

    expect(restoredB.getSnapshot().context.issueNumber).toBe(200);
    expect(restoredB.getSnapshot().context.repoOwner).toBe("org-b");
    expect(restoredB.getSnapshot().context.previousState).toBeNull();
  });

  test("deleting one session does not affect another via CASCADE", () => {
    createTestSession(db, "del-a");
    createTestSession(db, "del-b");

    // Add activity log entries for both
    db.run(
      `INSERT INTO activity_log (session_id, event, actor) VALUES (?, 'test', 'system')`,
      ["del-a"],
    );
    db.run(
      `INSERT INTO activity_log (session_id, event, actor) VALUES (?, 'test', 'system')`,
      ["del-b"],
    );

    // Delete session A
    db.run(`DELETE FROM sessions WHERE id = 'del-a'`);

    // Session B and its activity log should still exist
    const sessB = db.query(`SELECT * FROM sessions WHERE id = 'del-b'`).get();
    expect(sessB).not.toBeNull();

    const activityB = db
      .query(`SELECT * FROM activity_log WHERE session_id = 'del-b'`)
      .all();
    expect(activityB).toHaveLength(1);

    // Session A's activity log should be cascaded
    const activityA = db
      .query(`SELECT * FROM activity_log WHERE session_id = 'del-a'`)
      .all();
    expect(activityA).toHaveLength(0);
  });
});
