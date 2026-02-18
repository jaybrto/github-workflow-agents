/**
 * Behavioral Test: AMQP Command -> XState Transition
 *
 * Tests that receiving an AMQP command message triggers the correct
 * XState transition and publishes a state_change event back.
 * Uses mocks for AMQP -- no running broker required.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createActor } from "xstate";
import { sessionMachine, getStateName, columnTransitionToEvent } from "../../lib/state-machine.js";
import { SessionState, type AmqpMessage, type SessionContext } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Simulated AMQP command handler (mirrors what the runner pod does)
// ---------------------------------------------------------------------------

interface StateChangeEvent {
  sessionId: string;
  newState: string;
  triggerEvent: string;
}

/**
 * Simulates the AMQP command handler that:
 * 1. Receives a command message
 * 2. Maps it to an XState event
 * 3. Sends the event to the actor
 * 4. Publishes a state_change event back
 */
function createCommandHandler(
  actors: Map<string, ReturnType<typeof createActor<typeof sessionMachine>>>,
  publishedEvents: StateChangeEvent[],
) {
  return (msg: AmqpMessage) => {
    const payload = msg.payload as { fromColumn: string; toColumn: string };
    const eventType = columnTransitionToEvent(payload.fromColumn, payload.toColumn);
    if (!eventType) {
      throw new Error(`Unknown column transition: ${payload.fromColumn} -> ${payload.toColumn}`);
    }

    const actor = actors.get(msg.sessionId);
    if (!actor) {
      throw new Error(`No actor for session: ${msg.sessionId}`);
    }

    actor.send({ type: eventType });

    const newState = getStateName(actor);
    publishedEvents.push({
      sessionId: msg.sessionId,
      newState,
      triggerEvent: eventType,
    });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AMQP Command -> XState Transitions", () => {
  let actors: Map<string, ReturnType<typeof createActor<typeof sessionMachine>>>;
  let publishedEvents: StateChangeEvent[];
  let handler: ReturnType<typeof createCommandHandler>;

  const defaultCtx: SessionContext = {
    sessionId: "amqp-test-1",
    previousState: null,
    issueNumber: 10,
    repoOwner: "jaybrto",
    repoName: "test-repo",
  };

  function createActorInState(sessionId: string, state: string, ctx?: Partial<SessionContext>) {
    const fullCtx = { ...defaultCtx, ...ctx, sessionId };
    const actor = createActor(sessionMachine, {
      snapshot: sessionMachine.resolveState({
        value: state,
        context: fullCtx,
      }),
    });
    actor.start();
    actors.set(sessionId, actor);
    return actor;
  }

  beforeEach(() => {
    actors = new Map();
    publishedEvents = [];
    handler = createCommandHandler(actors, publishedEvents);
  });

  afterEach(() => {
    for (const actor of actors.values()) {
      actor.stop();
    }
  });

  test("AMQP command triggers idle -> planning transition", () => {
    createActorInState("sess-1", "idle");

    const msg: AmqpMessage = {
      routingKey: "gwa.commands.jaybrto.test-repo.transition",
      payload: { fromColumn: "Todo", toColumn: "Planning" },
      timestamp: Date.now(),
      sessionId: "sess-1",
    };

    handler(msg);

    expect(getStateName(actors.get("sess-1")!)).toBe("planning");
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0].newState).toBe("planning");
    expect(publishedEvents[0].triggerEvent).toBe("START_PLANNING");
  });

  test("AMQP command triggers planning -> inProgress transition", () => {
    createActorInState("sess-2", "planning");

    handler({
      routingKey: "gwa.commands.jaybrto.test-repo.transition",
      payload: { fromColumn: "Planning", toColumn: "In Progress" },
      timestamp: Date.now(),
      sessionId: "sess-2",
    });

    expect(getStateName(actors.get("sess-2")!)).toBe("inProgress");
    expect(publishedEvents[0].triggerEvent).toBe("INJECT_PROMPT");
  });

  test("AMQP command triggers blocked -> resume with correct guard", () => {
    createActorInState("sess-3", "blocked", { previousState: SessionState.QA });

    handler({
      routingKey: "gwa.commands.jaybrto.test-repo.transition",
      payload: { fromColumn: "Blocked", toColumn: "QA" },
      timestamp: Date.now(),
      sessionId: "sess-3",
    });

    expect(getStateName(actors.get("sess-3")!)).toBe("qa");
    expect(publishedEvents[0].newState).toBe("qa");
  });

  test("full lifecycle through AMQP commands", () => {
    createActorInState("sess-full", "idle");

    const transitions = [
      { from: "Todo", to: "Planning" },
      { from: "Planning", to: "In Progress" },
      { from: "In Progress", to: "QA" },
      { from: "QA", to: "Review" },
      { from: "Review", to: "Done" },
    ];

    for (const t of transitions) {
      handler({
        routingKey: "gwa.commands.jaybrto.test-repo.transition",
        payload: { fromColumn: t.from, toColumn: t.to },
        timestamp: Date.now(),
        sessionId: "sess-full",
      });
    }

    expect(getStateName(actors.get("sess-full")!)).toBe("done");
    expect(publishedEvents).toHaveLength(5);
    expect(publishedEvents.map((e) => e.newState)).toEqual([
      "planning",
      "inProgress",
      "qa",
      "review",
      "done",
    ]);
  });

  test("unknown column transition throws error", () => {
    createActorInState("sess-err", "idle");

    expect(() =>
      handler({
        routingKey: "gwa.commands.jaybrto.test-repo.transition",
        payload: { fromColumn: "Unknown", toColumn: "Nowhere" },
        timestamp: Date.now(),
        sessionId: "sess-err",
      }),
    ).toThrow("Unknown column transition");
  });

  test("command for nonexistent session throws error", () => {
    expect(() =>
      handler({
        routingKey: "gwa.commands.jaybrto.test-repo.transition",
        payload: { fromColumn: "Todo", toColumn: "Planning" },
        timestamp: Date.now(),
        sessionId: "nonexistent",
      }),
    ).toThrow("No actor for session");
  });

  test("state_change event published for each transition", () => {
    createActorInState("sess-pub", "inProgress");

    handler({
      routingKey: "gwa.commands.jaybrto.test-repo.transition",
      payload: { fromColumn: "In Progress", toColumn: "Blocked" },
      timestamp: Date.now(),
      sessionId: "sess-pub",
    });

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toEqual({
      sessionId: "sess-pub",
      newState: "blocked",
      triggerEvent: "PAUSE_FOR_QUESTION",
    });
  });
});
