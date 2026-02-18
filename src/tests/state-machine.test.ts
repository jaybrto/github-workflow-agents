/**
 * XState v5 State Machine Tests
 *
 * Tests all valid transitions, invalid transitions, guard conditions,
 * snapshot round-trip persistence, and column-to-event mapping.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";
import { createActor } from "xstate";
import {
  sessionMachine,
  columnTransitionToEvent,
  createSessionActor,
  getStateName,
  canTransition,
  stateNameToSessionState,
} from "../lib/state-machine.js";
import { SessionState, type SessionContext } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const defaultContext: SessionContext = {
  sessionId: "test-session-1",
  previousState: null,
  issueNumber: 42,
  repoOwner: "jaybrto",
  repoName: "test-repo",
};

/** Create a fresh actor in a given state for testing */
function actorInState(
  state: string,
  context?: Partial<SessionContext>,
): ReturnType<typeof createActor<typeof sessionMachine>> {
  const ctx = { ...defaultContext, ...context };
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
// Valid transitions — forward flow (happy path)
// ---------------------------------------------------------------------------
describe("valid transitions — forward flow", () => {
  test("idle -> planning via START_PLANNING", () => {
    const actor = actorInState("idle");
    actor.send({ type: "START_PLANNING" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("planning -> inProgress via INJECT_PROMPT", () => {
    const actor = actorInState("planning");
    actor.send({ type: "INJECT_PROMPT" });
    expect(getStateName(actor)).toBe("inProgress");
  });

  test("inProgress -> qa via RUN_TESTS", () => {
    const actor = actorInState("inProgress");
    actor.send({ type: "RUN_TESTS" });
    expect(getStateName(actor)).toBe("qa");
  });

  test("qa -> review via STATUS_UPDATE", () => {
    const actor = actorInState("qa");
    actor.send({ type: "STATUS_UPDATE" });
    expect(getStateName(actor)).toBe("review");
  });

  test("review -> done via DEPLOY_AND_CLEANUP", () => {
    const actor = actorInState("review");
    actor.send({ type: "DEPLOY_AND_CLEANUP" });
    expect(getStateName(actor)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Valid transitions — blocked state
// ---------------------------------------------------------------------------
describe("valid transitions — blocked state handling", () => {
  test("planning -> blocked via PAUSE_FOR_QUESTION sets previousState", () => {
    const actor = actorInState("planning");
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.Planning);
  });

  test("inProgress -> blocked via PAUSE_FOR_QUESTION sets previousState", () => {
    const actor = actorInState("inProgress");
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.InProgress);
  });

  test("qa -> blocked via PAUSE_FOR_QUESTION sets previousState", () => {
    const actor = actorInState("qa");
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.QA);
  });

  test("review -> blocked via PAUSE_FOR_QUESTION sets previousState", () => {
    const actor = actorInState("review");
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.Review);
  });

  test("blocked -> planning via SEND_ANSWER when previousState was planning", () => {
    const actor = actorInState("blocked", { previousState: SessionState.Planning });
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("blocked -> inProgress via SEND_ANSWER when previousState was inProgress", () => {
    const actor = actorInState("blocked", { previousState: SessionState.InProgress });
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("inProgress");
  });

  test("blocked -> qa via SEND_ANSWER when previousState was qa", () => {
    const actor = actorInState("blocked", { previousState: SessionState.QA });
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("qa");
  });

  test("blocked -> review via SEND_ANSWER when previousState was review", () => {
    const actor = actorInState("blocked", { previousState: SessionState.Review });
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("review");
  });
});

// ---------------------------------------------------------------------------
// Valid transitions — QA iteration and backward
// ---------------------------------------------------------------------------
describe("valid transitions — iteration and backward", () => {
  test("qa -> inProgress via RESUME_WITH_FAILURES", () => {
    const actor = actorInState("qa");
    actor.send({ type: "RESUME_WITH_FAILURES" });
    expect(getStateName(actor)).toBe("inProgress");
  });

  test("review -> qa via REQUEST_RETEST", () => {
    const actor = actorInState("review");
    actor.send({ type: "REQUEST_RETEST" });
    expect(getStateName(actor)).toBe("qa");
  });

  test("inProgress -> planning via REQUEST_REPLANNING", () => {
    const actor = actorInState("inProgress");
    actor.send({ type: "REQUEST_REPLANNING" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("qa -> planning via REQUEST_REPLANNING", () => {
    const actor = actorInState("qa");
    actor.send({ type: "REQUEST_REPLANNING" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("review -> planning via REQUEST_REPLANNING", () => {
    const actor = actorInState("review");
    actor.send({ type: "REQUEST_REPLANNING" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("review -> inProgress via RESUME_IMPLEMENTATION", () => {
    const actor = actorInState("review");
    actor.send({ type: "RESUME_IMPLEMENTATION" });
    expect(getStateName(actor)).toBe("inProgress");
  });
});

// ---------------------------------------------------------------------------
// Valid transitions — cancel and reopen
// ---------------------------------------------------------------------------
describe("valid transitions — cancel and reopen", () => {
  const cancelStates = ["planning", "inProgress", "qa", "review", "blocked"];

  for (const state of cancelStates) {
    test(`${state} -> idle via CANCEL_SESSION`, () => {
      const actor = actorInState(state, {
        previousState: state === "blocked" ? SessionState.Planning : null,
      });
      actor.send({ type: "CANCEL_SESSION" });
      expect(getStateName(actor)).toBe("idle");
    });
  }

  test("done -> idle via REOPEN_ISSUE", () => {
    const actor = actorInState("done");
    actor.send({ type: "REOPEN_ISSUE" });
    expect(getStateName(actor)).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// Valid transitions — direct jumps
// ---------------------------------------------------------------------------
describe("valid transitions — direct jumps", () => {
  test("idle -> inProgress via QUICK_START", () => {
    const actor = actorInState("idle");
    actor.send({ type: "QUICK_START" });
    expect(getStateName(actor)).toBe("inProgress");
  });

  test("idle -> done via CLOSE_WITHOUT_WORK", () => {
    const actor = actorInState("idle");
    actor.send({ type: "CLOSE_WITHOUT_WORK" });
    expect(getStateName(actor)).toBe("done");
  });

  test("planning -> done via CLOSE_WITHOUT_WORK", () => {
    const actor = actorInState("planning");
    actor.send({ type: "CLOSE_WITHOUT_WORK" });
    expect(getStateName(actor)).toBe("done");
  });

  test("inProgress -> done via CLOSE_WITHOUT_WORK", () => {
    const actor = actorInState("inProgress");
    actor.send({ type: "CLOSE_WITHOUT_WORK" });
    expect(getStateName(actor)).toBe("done");
  });

  test("qa -> done via CLOSE_WITHOUT_WORK", () => {
    const actor = actorInState("qa");
    actor.send({ type: "CLOSE_WITHOUT_WORK" });
    expect(getStateName(actor)).toBe("done");
  });

  test("inProgress -> review via SKIP_QA", () => {
    const actor = actorInState("inProgress");
    actor.send({ type: "SKIP_QA" });
    expect(getStateName(actor)).toBe("review");
  });

  test("planning -> qa via SKIP_IMPLEMENTATION", () => {
    const actor = actorInState("planning");
    actor.send({ type: "SKIP_IMPLEMENTATION" });
    expect(getStateName(actor)).toBe("qa");
  });

  test("idle -> blocked via PAUSE_FOR_QUESTION", () => {
    const actor = actorInState("idle");
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions
// ---------------------------------------------------------------------------
describe("invalid transitions", () => {
  test("idle -> done via DEPLOY_AND_CLEANUP is rejected", () => {
    const actor = actorInState("idle");
    expect(canTransition(actor, { type: "DEPLOY_AND_CLEANUP" })).toBe(false);
  });

  test("idle -> qa via RUN_TESTS is rejected", () => {
    const actor = actorInState("idle");
    expect(canTransition(actor, { type: "RUN_TESTS" })).toBe(false);
  });

  test("done -> inProgress via INJECT_PROMPT is rejected", () => {
    const actor = actorInState("done");
    expect(canTransition(actor, { type: "INJECT_PROMPT" })).toBe(false);
  });

  test("planning -> review via DEPLOY_AND_CLEANUP is rejected", () => {
    const actor = actorInState("planning");
    expect(canTransition(actor, { type: "DEPLOY_AND_CLEANUP" })).toBe(false);
  });

  test("qa -> idle via QUICK_START is rejected", () => {
    const actor = actorInState("qa");
    expect(canTransition(actor, { type: "QUICK_START" })).toBe(false);
  });

  test("blocked without previousState cannot SEND_ANSWER to any state", () => {
    const actor = actorInState("blocked", { previousState: null });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard conditions
// ---------------------------------------------------------------------------
describe("guard conditions", () => {
  test("previousWasPlanning guard passes when previousState is planning", () => {
    const actor = actorInState("blocked", { previousState: SessionState.Planning });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(true);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("planning");
  });

  test("previousWasInProgress guard passes when previousState is inProgress", () => {
    const actor = actorInState("blocked", { previousState: SessionState.InProgress });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(true);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("inProgress");
  });

  test("previousWasQA guard passes when previousState is qa", () => {
    const actor = actorInState("blocked", { previousState: SessionState.QA });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(true);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("qa");
  });

  test("previousWasReview guard passes when previousState is review", () => {
    const actor = actorInState("blocked", { previousState: SessionState.Review });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(true);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("review");
  });

  test("no guard matches when previousState is null", () => {
    const actor = actorInState("blocked", { previousState: null });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(false);
  });

  test("no guard matches when previousState is idle", () => {
    const actor = actorInState("blocked", { previousState: SessionState.Idle });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot persistence round-trip (directly tests serialization logic)
// ---------------------------------------------------------------------------
describe("snapshot persistence", () => {
  const TEST_DB_PATH = "/tmp/gwa-xstate-test.db";
  let testDb: Database;

  beforeAll(() => {
    // Set env before any module caching happens
    process.env.DB_PATH = TEST_DB_PATH;

    // Clean up any previous test DB
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    testDb = new Database(TEST_DB_PATH);
    testDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'feature',
        status TEXT NOT NULL DEFAULT 'pending',
        github_number INTEGER NOT NULL DEFAULT 0,
        github_type TEXT NOT NULL DEFAULT 'issue',
        repo TEXT NOT NULL DEFAULT '',
        xstate_snapshot TEXT,
        xstate_schema_version INTEGER DEFAULT 1
      );
    `);
  });

  afterAll(() => {
    testDb.close();
    // Reset env
    delete process.env.DB_PATH;
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  test("snapshot serialization round-trip preserves state", () => {
    // Create actor, transition to planning
    const actor = createSessionActor(defaultContext);
    actor.send({ type: "START_PLANNING" });
    expect(getStateName(actor)).toBe("planning");

    // Serialize snapshot
    const snapshot = actor.getSnapshot();
    const json = JSON.stringify(snapshot, (_key, value) =>
      value === undefined ? null : value,
    );

    // Store in DB directly
    testDb.run(
      `INSERT INTO sessions (id, xstate_snapshot) VALUES (?, ?)`,
      ["test-roundtrip-1", json],
    );

    // Read back and restore
    const row = testDb
      .query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`)
      .get("test-roundtrip-1") as { xstate_snapshot: string };
    expect(row.xstate_snapshot).toBeTruthy();

    const parsed = JSON.parse(row.xstate_snapshot);
    expect(parsed.value).toBe("planning");

    // Restore actor from snapshot
    const restored = createActor(sessionMachine, { snapshot: parsed });
    restored.start();
    expect(getStateName(restored)).toBe("planning");

    // Verify restored actor can continue transitioning
    restored.send({ type: "INJECT_PROMPT" });
    expect(getStateName(restored)).toBe("inProgress");
  });

  test("context is preserved through snapshot round-trip", () => {
    const ctx: SessionContext = {
      sessionId: "test-context-rt",
      previousState: null,
      issueNumber: 99,
      repoOwner: "testorg",
      repoName: "testrepo",
    };

    const actor = createSessionActor(ctx);
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "PAUSE_FOR_QUESTION" });

    const json = JSON.stringify(actor.getSnapshot(), (_key, value) =>
      value === undefined ? null : value,
    );

    testDb.run(
      `INSERT INTO sessions (id, xstate_snapshot) VALUES (?, ?)`,
      ["test-context-rt", json],
    );

    const row = testDb
      .query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`)
      .get("test-context-rt") as { xstate_snapshot: string };

    const restored = createActor(sessionMachine, { snapshot: JSON.parse(row.xstate_snapshot) });
    restored.start();

    const restoredCtx = restored.getSnapshot().context;
    expect(restoredCtx.sessionId).toBe("test-context-rt");
    expect(restoredCtx.issueNumber).toBe(99);
    expect(restoredCtx.repoOwner).toBe("testorg");
    expect(restoredCtx.repoName).toBe("testrepo");
    expect(restoredCtx.previousState).toBe(SessionState.Planning);
  });

  test("undefined context values are serialized as null", () => {
    const actor = createSessionActor({
      sessionId: "test-undef",
      previousState: null,
      issueNumber: 1,
      repoOwner: "",
      repoName: "",
    });

    const json = JSON.stringify(actor.getSnapshot(), (_key, value) =>
      value === undefined ? null : value,
    );
    const parsed = JSON.parse(json);

    // previousState should be null, not undefined
    expect(parsed.context.previousState).toBeNull();
  });

  test("full lifecycle snapshot persistence", () => {
    // Walk through idle -> planning -> blocked -> planning -> inProgress
    const actor = createSessionActor({
      ...defaultContext,
      sessionId: "test-lifecycle",
    });

    // idle -> planning
    actor.send({ type: "START_PLANNING" });
    let json = JSON.stringify(actor.getSnapshot(), (_key, v) => v === undefined ? null : v);
    testDb.run(
      `INSERT INTO sessions (id, xstate_snapshot) VALUES (?, ?)`,
      ["test-lifecycle", json],
    );

    // Restore, then planning -> blocked
    let row = testDb.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get("test-lifecycle") as { xstate_snapshot: string };
    let restored = createActor(sessionMachine, { snapshot: JSON.parse(row.xstate_snapshot) });
    restored.start();
    restored.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(restored)).toBe("blocked");
    expect(restored.getSnapshot().context.previousState).toBe(SessionState.Planning);

    // Persist blocked state
    json = JSON.stringify(restored.getSnapshot(), (_key, v) => v === undefined ? null : v);
    testDb.run(`UPDATE sessions SET xstate_snapshot = ? WHERE id = ?`, [json, "test-lifecycle"]);

    // Restore, then blocked -> planning (via SEND_ANSWER)
    row = testDb.query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`).get("test-lifecycle") as { xstate_snapshot: string };
    restored = createActor(sessionMachine, { snapshot: JSON.parse(row.xstate_snapshot) });
    restored.start();
    expect(canTransition(restored, { type: "SEND_ANSWER" })).toBe(true);
    restored.send({ type: "SEND_ANSWER" });
    expect(getStateName(restored)).toBe("planning");
  });
});

// ---------------------------------------------------------------------------
// Column transition to event mapping
// ---------------------------------------------------------------------------
describe("columnTransitionToEvent", () => {
  test("maps forward flow transitions", () => {
    expect(columnTransitionToEvent("Todo", "Planning")).toBe("START_PLANNING");
    expect(columnTransitionToEvent("Planning", "In Progress")).toBe("INJECT_PROMPT");
    expect(columnTransitionToEvent("In Progress", "QA")).toBe("RUN_TESTS");
    expect(columnTransitionToEvent("QA", "Review")).toBe("STATUS_UPDATE");
    expect(columnTransitionToEvent("Review", "Done")).toBe("DEPLOY_AND_CLEANUP");
  });

  test("maps blocked transitions", () => {
    expect(columnTransitionToEvent("Planning", "Blocked")).toBe("PAUSE_FOR_QUESTION");
    expect(columnTransitionToEvent("In Progress", "Blocked")).toBe("PAUSE_FOR_QUESTION");
    expect(columnTransitionToEvent("QA", "Blocked")).toBe("PAUSE_FOR_QUESTION");
    expect(columnTransitionToEvent("Review", "Blocked")).toBe("PAUSE_FOR_QUESTION");
    expect(columnTransitionToEvent("Todo", "Blocked")).toBe("PAUSE_FOR_QUESTION");
  });

  test("maps unblocked transitions", () => {
    expect(columnTransitionToEvent("Blocked", "Planning")).toBe("SEND_ANSWER");
    expect(columnTransitionToEvent("Blocked", "In Progress")).toBe("SEND_ANSWER");
    expect(columnTransitionToEvent("Blocked", "QA")).toBe("SEND_ANSWER");
    expect(columnTransitionToEvent("Blocked", "Review")).toBe("SEND_ANSWER");
  });

  test("maps cancel transitions", () => {
    expect(columnTransitionToEvent("Planning", "Todo")).toBe("CANCEL_SESSION");
    expect(columnTransitionToEvent("In Progress", "Todo")).toBe("CANCEL_SESSION");
    expect(columnTransitionToEvent("QA", "Todo")).toBe("CANCEL_SESSION");
    expect(columnTransitionToEvent("Review", "Todo")).toBe("CANCEL_SESSION");
    expect(columnTransitionToEvent("Blocked", "Todo")).toBe("CANCEL_SESSION");
  });

  test("maps reopen transitions", () => {
    expect(columnTransitionToEvent("Done", "Todo")).toBe("REOPEN_ISSUE");
    expect(columnTransitionToEvent("Done", "Planning")).toBe("REOPEN_ISSUE");
    expect(columnTransitionToEvent("Done", "In Progress")).toBe("REOPEN_ISSUE");
  });

  test("maps direct jump transitions", () => {
    expect(columnTransitionToEvent("Todo", "In Progress")).toBe("QUICK_START");
    expect(columnTransitionToEvent("Todo", "Done")).toBe("CLOSE_WITHOUT_WORK");
    expect(columnTransitionToEvent("In Progress", "Review")).toBe("SKIP_QA");
    expect(columnTransitionToEvent("Planning", "QA")).toBe("SKIP_IMPLEMENTATION");
  });

  test("returns null for unknown transitions", () => {
    expect(columnTransitionToEvent("Unknown", "Planning")).toBeNull();
    expect(columnTransitionToEvent("Todo", "Unknown")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stateNameToSessionState mapping
// ---------------------------------------------------------------------------
describe("stateNameToSessionState", () => {
  test("maps all XState state names to SessionState enum", () => {
    expect(stateNameToSessionState("idle")).toBe(SessionState.Idle);
    expect(stateNameToSessionState("planning")).toBe(SessionState.Planning);
    expect(stateNameToSessionState("inProgress")).toBe(SessionState.InProgress);
    expect(stateNameToSessionState("qa")).toBe(SessionState.QA);
    expect(stateNameToSessionState("blocked")).toBe(SessionState.Blocked);
    expect(stateNameToSessionState("review")).toBe(SessionState.Review);
    expect(stateNameToSessionState("done")).toBe(SessionState.Done);
  });

  test("falls back to Idle for unknown state names", () => {
    expect(stateNameToSessionState("nonexistent")).toBe(SessionState.Idle);
  });
});

// ---------------------------------------------------------------------------
// createSessionActor
// ---------------------------------------------------------------------------
describe("createSessionActor", () => {
  test("creates actor in idle state with given context", () => {
    const actor = createSessionActor(defaultContext);
    expect(getStateName(actor)).toBe("idle");
    expect(actor.getSnapshot().context.sessionId).toBe(defaultContext.sessionId);
    expect(actor.getSnapshot().context.issueNumber).toBe(42);
  });

  test("created actor can receive events", () => {
    const actor = createSessionActor(defaultContext);
    actor.send({ type: "START_PLANNING" });
    expect(getStateName(actor)).toBe("planning");
  });
});
