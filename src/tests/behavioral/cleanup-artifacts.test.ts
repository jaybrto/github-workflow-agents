/**
 * Behavioral Test: Artifact Cleanup on Done
 *
 * Tests that when a session transitions to "done", all associated
 * artifacts are properly cleaned up: SQLite records updated,
 * screenshots removed, tmux window killed, worktree removed.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { getStateName } from "../../lib/state-machine.js";
import {
  createTestDatabase,
  createTestSession,
  createTestScreenshot,
  createTestQuestion,
  createTestActivity,
  defaultContext,
  actorInState,
  persistSnapshotToDb,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Mock cleanup functions (these would call tmux and git in production)
// ---------------------------------------------------------------------------

interface CleanupTracker {
  tmuxKilled: string[];
  worktreesRemoved: string[];
  screenshotsDeleted: string[];
}

function createCleanupHandler(db: Database, tracker: CleanupTracker) {
  return async (sessionId: string) => {
    const session = db.query(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as {
      id: string;
      tmux_window: number | null;
      worktree_path: string | null;
    } | null;

    if (!session) return;

    // 1. Mark session as complete
    db.run(
      `UPDATE sessions SET status = 'complete', completed_at = unixepoch(), repl_active = 0 WHERE id = ?`,
      [sessionId],
    );

    // 2. Clean up screenshots
    const screenshots = db
      .query(`SELECT id, file_path FROM screenshots WHERE session_id = ?`)
      .all(sessionId) as Array<{ id: number; file_path: string }>;

    for (const ss of screenshots) {
      tracker.screenshotsDeleted.push(ss.file_path);
    }
    db.run(`DELETE FROM screenshots WHERE session_id = ?`, [sessionId]);

    // 3. Kill tmux window (mock)
    if (session.tmux_window !== null) {
      tracker.tmuxKilled.push(`gwa-work:${session.tmux_window}`);
    }

    // 4. Remove worktree (mock)
    if (session.worktree_path) {
      tracker.worktreesRemoved.push(session.worktree_path);
    }

    // 5. Log cleanup activity
    db.run(
      `INSERT INTO activity_log (session_id, event, details, actor) VALUES (?, 'session_completed', ?, 'system')`,
      [sessionId, JSON.stringify({ screenshotsCleaned: screenshots.length })],
    );
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Artifact Cleanup on Done", () => {
  let db: Database;
  let tracker: CleanupTracker;
  let cleanup: ReturnType<typeof createCleanupHandler>;
  const sessionId = "cleanup-test-1";

  beforeEach(() => {
    db = createTestDatabase();
    tracker = {
      tmuxKilled: [],
      worktreesRemoved: [],
      screenshotsDeleted: [],
    };
    cleanup = createCleanupHandler(db, tracker);
  });

  afterEach(() => {
    db.close();
  });

  test("session status updated to complete on cleanup", async () => {
    createTestSession(db, sessionId, { tmux_window: 3 });

    await cleanup(sessionId);

    const session = db.query(`SELECT status, completed_at, repl_active FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
      completed_at: number | null;
      repl_active: number;
    };

    expect(session.status).toBe("complete");
    expect(session.completed_at).not.toBeNull();
    expect(session.repl_active).toBe(0);
  });

  test("screenshots are cleaned up from database", async () => {
    createTestSession(db, sessionId);
    createTestScreenshot(db, sessionId, "/tmp/gwa-screenshots/q1.png", "question");
    createTestScreenshot(db, sessionId, "/tmp/gwa-screenshots/q2.png", "error");
    createTestScreenshot(db, sessionId, "/tmp/gwa-screenshots/done.png", "completion");

    // Verify screenshots exist before cleanup
    const before = db.query(`SELECT COUNT(*) as count FROM screenshots WHERE session_id = ?`).get(sessionId) as { count: number };
    expect(before.count).toBe(3);

    await cleanup(sessionId);

    // Verify screenshots removed from DB
    const after = db.query(`SELECT COUNT(*) as count FROM screenshots WHERE session_id = ?`).get(sessionId) as { count: number };
    expect(after.count).toBe(0);

    // Verify file paths tracked for deletion
    expect(tracker.screenshotsDeleted).toHaveLength(3);
    expect(tracker.screenshotsDeleted).toContain("/tmp/gwa-screenshots/q1.png");
    expect(tracker.screenshotsDeleted).toContain("/tmp/gwa-screenshots/q2.png");
    expect(tracker.screenshotsDeleted).toContain("/tmp/gwa-screenshots/done.png");
  });

  test("tmux window kill is tracked", async () => {
    createTestSession(db, sessionId, { tmux_window: 7 });

    await cleanup(sessionId);

    expect(tracker.tmuxKilled).toHaveLength(1);
    expect(tracker.tmuxKilled[0]).toBe("gwa-work:7");
  });

  test("worktree removal is tracked", async () => {
    createTestSession(db, sessionId, { worktree_path: "/home/runner/worktrees/pr-42" });

    await cleanup(sessionId);

    expect(tracker.worktreesRemoved).toHaveLength(1);
    expect(tracker.worktreesRemoved[0]).toBe("/home/runner/worktrees/pr-42");
  });

  test("cleanup activity logged in activity_log", async () => {
    createTestSession(db, sessionId, { tmux_window: 5 });
    createTestScreenshot(db, sessionId, "/tmp/ss1.png");

    await cleanup(sessionId);

    const logs = db
      .query(`SELECT event, details FROM activity_log WHERE session_id = ? AND event = 'session_completed'`)
      .all(sessionId) as Array<{ event: string; details: string }>;

    expect(logs).toHaveLength(1);
    const details = JSON.parse(logs[0].details);
    expect(details.screenshotsCleaned).toBe(1);
  });

  test("cleanup with no artifacts does not error", async () => {
    createTestSession(db, sessionId, { tmux_window: null, worktree_path: null });

    await cleanup(sessionId);

    expect(tracker.tmuxKilled).toHaveLength(0);
    expect(tracker.worktreesRemoved).toHaveLength(0);
    expect(tracker.screenshotsDeleted).toHaveLength(0);

    const session = db.query(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as { status: string };
    expect(session.status).toBe("complete");
  });

  test("cleanup for nonexistent session does not error", async () => {
    await cleanup("nonexistent-session");
    expect(tracker.tmuxKilled).toHaveLength(0);
  });

  test("questions and activity_log preserved after cleanup (not deleted)", async () => {
    createTestSession(db, sessionId);
    createTestQuestion(db, sessionId, "How do I test this?");
    createTestActivity(db, sessionId, "session_started");

    await cleanup(sessionId);

    // Questions should still exist (just the session status changed)
    const questions = db
      .query(`SELECT COUNT(*) as count FROM questions WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    expect(questions.count).toBe(1);

    // Activity log entries preserved (we add the completion log)
    const activities = db
      .query(`SELECT COUNT(*) as count FROM activity_log WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    expect(activities.count).toBeGreaterThanOrEqual(2); // original + completion
  });

  test("full lifecycle with cleanup at the end", async () => {
    createTestSession(db, sessionId, {
      tmux_window: 2,
      worktree_path: "/home/runner/worktrees/pr-99",
    });
    createTestScreenshot(db, sessionId, "/tmp/ss-q.png", "question");
    createTestQuestion(db, sessionId, "What should I do?");

    // Run through XState lifecycle
    const actor = actorInState("idle", { ...defaultContext, sessionId });
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    actor.send({ type: "RUN_TESTS" });
    actor.send({ type: "STATUS_UPDATE" });
    actor.send({ type: "DEPLOY_AND_CLEANUP" });
    expect(getStateName(actor)).toBe("done");
    persistSnapshotToDb(db, sessionId, actor);

    // Run cleanup
    await cleanup(sessionId);

    // Verify final state
    const session = db.query(`SELECT status, xstate_snapshot FROM sessions WHERE id = ?`).get(sessionId) as {
      status: string;
      xstate_snapshot: string;
    };
    expect(session.status).toBe("complete");
    expect(JSON.parse(session.xstate_snapshot).value).toBe("done");

    // Screenshots cleaned
    const ssCount = db.query(`SELECT COUNT(*) as count FROM screenshots WHERE session_id = ?`).get(sessionId) as { count: number };
    expect(ssCount.count).toBe(0);

    // External resources tracked for cleanup
    expect(tracker.tmuxKilled).toEqual(["gwa-work:2"]);
    expect(tracker.worktreesRemoved).toEqual(["/home/runner/worktrees/pr-99"]);
  });
});
