/**
 * Behavioral Test: Blocked and Resume
 *
 * Tests that the blocked state correctly saves previousState
 * and that SEND_ANSWER resumes to the correct state via guards.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { getStateName, canTransition } from "../../lib/state-machine.js";
import { SessionState } from "../../shared/types.js";
import {
  createTestDatabase,
  createTestSession,
  defaultContext,
  actorInState,
  persistSnapshotToDb,
  restoreActorFromDb,
} from "./helpers.js";

describe("Blocked and Resume", () => {
  let db: Database;
  const sessionId = "blocked-test-1";

  beforeEach(() => {
    db = createTestDatabase();
    createTestSession(db, sessionId);
  });

  afterEach(() => {
    db.close();
  });

  test("inProgress -> blocked -> inProgress round-trip", () => {
    const actor = actorInState("idle", { ...defaultContext, sessionId });
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    expect(getStateName(actor)).toBe("inProgress");

    // Block
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.InProgress);

    // Persist blocked state
    persistSnapshotToDb(db, sessionId, actor);

    // Restore and resume
    const restored = restoreActorFromDb(db, sessionId)!;
    expect(getStateName(restored)).toBe("blocked");
    expect(restored.getSnapshot().context.previousState).toBe(SessionState.InProgress);

    restored.send({ type: "SEND_ANSWER" });
    expect(getStateName(restored)).toBe("inProgress");
  });

  test("planning -> blocked -> planning round-trip", () => {
    const actor = actorInState("idle", { ...defaultContext, sessionId });
    actor.send({ type: "START_PLANNING" });
    expect(getStateName(actor)).toBe("planning");

    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.Planning);

    persistSnapshotToDb(db, sessionId, actor);

    const restored = restoreActorFromDb(db, sessionId)!;
    expect(canTransition(restored, { type: "SEND_ANSWER" })).toBe(true);

    restored.send({ type: "SEND_ANSWER" });
    expect(getStateName(restored)).toBe("planning");
  });

  test("qa -> blocked -> qa round-trip", () => {
    const actor = actorInState("qa", { ...defaultContext, sessionId });

    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.QA);

    persistSnapshotToDb(db, sessionId, actor);

    const restored = restoreActorFromDb(db, sessionId)!;
    restored.send({ type: "SEND_ANSWER" });
    expect(getStateName(restored)).toBe("qa");
  });

  test("review -> blocked -> review round-trip", () => {
    const actor = actorInState("review", { ...defaultContext, sessionId });

    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(getStateName(actor)).toBe("blocked");
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.Review);

    persistSnapshotToDb(db, sessionId, actor);

    const restored = restoreActorFromDb(db, sessionId)!;
    restored.send({ type: "SEND_ANSWER" });
    expect(getStateName(restored)).toBe("review");
  });

  test("blocked with null previousState cannot SEND_ANSWER", () => {
    const actor = actorInState("blocked", { ...defaultContext, sessionId, previousState: null });
    expect(canTransition(actor, { type: "SEND_ANSWER" })).toBe(false);
  });

  test("blocked can still CANCEL_SESSION regardless of previousState", () => {
    const actor = actorInState("blocked", {
      ...defaultContext,
      sessionId,
      previousState: SessionState.InProgress,
    });

    expect(canTransition(actor, { type: "CANCEL_SESSION" })).toBe(true);
    actor.send({ type: "CANCEL_SESSION" });
    expect(getStateName(actor)).toBe("idle");
  });

  test("multiple block-unblock cycles preserve state correctly", () => {
    const actor = actorInState("idle", { ...defaultContext, sessionId });

    // Cycle 1: planning -> blocked -> planning
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.Planning);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("planning");

    // Continue to inProgress
    actor.send({ type: "INJECT_PROMPT" });

    // Cycle 2: inProgress -> blocked -> inProgress
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.InProgress);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("inProgress");

    // Continue to qa
    actor.send({ type: "RUN_TESTS" });

    // Cycle 3: qa -> blocked -> qa
    actor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(actor.getSnapshot().context.previousState).toBe(SessionState.QA);
    actor.send({ type: "SEND_ANSWER" });
    expect(getStateName(actor)).toBe("qa");

    // Complete the lifecycle
    actor.send({ type: "STATUS_UPDATE" });
    expect(getStateName(actor)).toBe("review");
    actor.send({ type: "DEPLOY_AND_CLEANUP" });
    expect(getStateName(actor)).toBe("done");
  });
});
