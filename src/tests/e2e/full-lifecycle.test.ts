/**
 * GWA Session Lifecycle — End-to-End Tests
 *
 * Drives the XState session machine through all 7 states using the real
 * sessionMachine, real in-memory SQLite, and no live infrastructure.
 *
 * States covered: idle → planning → inProgress → qa → review → done
 * Paths covered:
 *   - Happy path: full 5-event forward traversal
 *   - Blocked/resume: inProgress → blocked → inProgress (guard-safe)
 *   - Individual step assertions
 *   - Fresh actor isolation via beforeEach
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createActor } from "xstate";
import { SessionState } from "../../shared/types.js";
import { sessionMachine } from "../../lib/state-machine.js";
import { createTestActor, actorInState, sendAndExpect, createTestDb } from "./helpers.js";

describe("GWA session lifecycle E2E", () => {
  let actor: ReturnType<typeof createActor<typeof sessionMachine>>;

  beforeEach(() => {
    // Each test gets a completely fresh actor in idle state.
    actor = createTestActor();
  });

  // -------------------------------------------------------------------------
  // Test 1: initial state
  // -------------------------------------------------------------------------

  test("1. starts in idle state", () => {
    expect(actor.getSnapshot().matches("idle")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: idle → planning
  // -------------------------------------------------------------------------

  test("2. idle → planning via START_PLANNING", () => {
    sendAndExpect(actor, { type: "START_PLANNING" }, "planning");
  });

  // -------------------------------------------------------------------------
  // Test 3: planning → inProgress
  // -------------------------------------------------------------------------

  test("3. planning → inProgress via INJECT_PROMPT", () => {
    actor.send({ type: "START_PLANNING" });
    sendAndExpect(actor, { type: "INJECT_PROMPT" }, "inProgress");
  });

  // -------------------------------------------------------------------------
  // Test 4: inProgress → qa
  // -------------------------------------------------------------------------

  test("4. inProgress → qa via RUN_TESTS", () => {
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    sendAndExpect(actor, { type: "RUN_TESTS" }, "qa");
  });

  // -------------------------------------------------------------------------
  // Test 5: qa → review
  // -------------------------------------------------------------------------

  test("5. qa → review via STATUS_UPDATE", () => {
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    actor.send({ type: "RUN_TESTS" });
    sendAndExpect(actor, { type: "STATUS_UPDATE" }, "review");
  });

  // -------------------------------------------------------------------------
  // Test 6: review → done
  // -------------------------------------------------------------------------

  test("6. review → done via DEPLOY_AND_CLEANUP", () => {
    actor.send({ type: "START_PLANNING" });
    actor.send({ type: "INJECT_PROMPT" });
    actor.send({ type: "RUN_TESTS" });
    actor.send({ type: "STATUS_UPDATE" });
    sendAndExpect(actor, { type: "DEPLOY_AND_CLEANUP" }, "done");
  });

  // -------------------------------------------------------------------------
  // Test 7: full happy path in one go
  // -------------------------------------------------------------------------

  test("7. full happy path: idle → done in 5 transitions", () => {
    const events = [
      "START_PLANNING",
      "INJECT_PROMPT",
      "RUN_TESTS",
      "STATUS_UPDATE",
      "DEPLOY_AND_CLEANUP",
    ] as const;

    for (const type of events) {
      actor.send({ type });
    }

    expect(actor.getSnapshot().matches("done")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8: blocked/resume via PAUSE_FOR_QUESTION + SEND_ANSWER
  //
  // The SEND_ANSWER transition in the blocked state is guarded — it checks
  // context.previousState to determine which state to return to. The
  // PAUSE_FOR_QUESTION action sets context.previousState automatically.
  //
  // Strategy: start fresh from inProgress, pause, then resume.
  // We use actorInState() to skip the idle→planning→inProgress setup
  // so this test focuses purely on the blocked/resume logic.
  // -------------------------------------------------------------------------

  test("8. blocked/resume: inProgress → blocked → inProgress", () => {
    // Start directly in inProgress (skips irrelevant setup)
    const blockedActor = actorInState("inProgress");

    // inProgress → blocked (action sets previousState = InProgress)
    blockedActor.send({ type: "PAUSE_FOR_QUESTION" });
    expect(blockedActor.getSnapshot().matches("blocked")).toBe(true);
    expect(blockedActor.getSnapshot().context.previousState).toBe(
      SessionState.InProgress,
    );

    // blocked → inProgress via SEND_ANSWER (guard: previousWasInProgress)
    blockedActor.send({ type: "SEND_ANSWER" });
    expect(blockedActor.getSnapshot().matches("inProgress")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 9: actor isolation — beforeEach creates a fresh actor each time
  // -------------------------------------------------------------------------

  test("9. auto-reset: fresh actor per test starts in idle", () => {
    // If beforeEach is working correctly, the actor handed to this test
    // is always in idle — regardless of what previous tests did to their actors.
    expect(actor.getSnapshot().matches("idle")).toBe(true);
    expect(actor.getSnapshot().value).toBe("idle");
  });

  // -------------------------------------------------------------------------
  // Bonus: schema-backed database can be created and used alongside actors
  // -------------------------------------------------------------------------

  test("10. in-memory SQLite schema loads without error", () => {
    // createTestDb() applies the full GWA schema to an in-memory database.
    // This verifies the schema is reachable and valid SQL.
    const db = createTestDb();

    // Verify key tables exist by querying them.
    const tables = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("questions");
    expect(tableNames).toContain("activity_log");
    expect(tableNames).toContain("terminal_snapshots");

    db.close();
  });
});
