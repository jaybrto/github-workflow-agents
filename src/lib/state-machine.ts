/**
 * XState v5 State Machine for GWA Session Lifecycle
 *
 * Manages session state transitions matching the 38 valid transitions
 * defined in the webhook handler. Provides guards, snapshot persistence,
 * and column-to-event mapping.
 */

import { createMachine, createActor, type Actor, type Snapshot } from "xstate";
import { SessionState, type SessionEvent, type SessionContext } from "../shared/types.js";
import { getDatabase } from "./db.js";
import { publishStateChange } from "./amqp.js";
import { takeSnapshot } from "./terminal-relay.js";
import { log } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Snapshot capture (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Capture a terminal snapshot during a state transition.
 * Failures are logged as warnings and never block the transition.
 */
function captureTransitionSnapshot(context: SessionContext, eventType: string): void {
  if (!context.sessionId || !context.tmuxWindow) return;
  takeSnapshot(context.sessionId, context.tmuxWindow, eventType).catch((err) => {
    log("warn", `Snapshot capture failed during ${eventType}`, {
      sessionId: context.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Machine definition
// ---------------------------------------------------------------------------

export const sessionMachine = createMachine({
  id: "gwa-session",
  initial: "idle",
  types: {} as {
    context: SessionContext;
    events: SessionEvent;
  },
  context: {
    sessionId: "",
    previousState: null,
    issueNumber: 0,
    repoOwner: "",
    repoName: "",
  },
  states: {
    idle: {
      on: {
        START_PLANNING: {
          target: "planning",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_start");
          },
        },
        QUICK_START: { target: "inProgress" },
        CLOSE_WITHOUT_WORK: { target: "done" },
        PAUSE_FOR_QUESTION: {
          target: "blocked",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_blocked");
          },
        },
      },
    },
    planning: {
      on: {
        PLANNING_COMPLETE: {
          target: "planningComplete",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "planning_complete");
          },
        },
        INJECT_PROMPT: {
          target: "inProgress",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "work_started");
          },
        },
        PAUSE_FOR_QUESTION: {
          target: "blocked",
          actions: ({ context }) => {
            context.previousState = SessionState.Planning;
            captureTransitionSnapshot(context, "session_blocked");
          },
        },
        CANCEL_SESSION: { target: "idle" },
        CLOSE_WITHOUT_WORK: {
          target: "done",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_complete");
          },
        },
        SKIP_IMPLEMENTATION: { target: "qa" },
      },
    },
    planningComplete: {
      on: {
        INJECT_PROMPT: {
          target: "inProgress",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "work_started");
          },
        },
        REQUEST_REPLANNING: { target: "planning" },
        CANCEL_SESSION: { target: "idle" },
      },
    },
    inProgress: {
      on: {
        RUN_TESTS: {
          target: "qa",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "qa_started");
          },
        },
        PAUSE_FOR_QUESTION: {
          target: "blocked",
          actions: ({ context }) => {
            context.previousState = SessionState.InProgress;
            captureTransitionSnapshot(context, "session_blocked");
          },
        },
        REQUEST_REPLANNING: { target: "planning" },
        CANCEL_SESSION: { target: "idle" },
        CLOSE_WITHOUT_WORK: {
          target: "done",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_complete");
          },
        },
        SKIP_QA: {
          target: "review",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "review_started");
          },
        },
      },
    },
    qa: {
      on: {
        STATUS_UPDATE: {
          target: "review",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "review_started");
          },
        },
        RESUME_WITH_FAILURES: { target: "inProgress" },
        PAUSE_FOR_QUESTION: {
          target: "blocked",
          actions: ({ context }) => {
            context.previousState = SessionState.QA;
            captureTransitionSnapshot(context, "session_blocked");
          },
        },
        REQUEST_REPLANNING: { target: "planning" },
        CANCEL_SESSION: { target: "idle" },
        CLOSE_WITHOUT_WORK: {
          target: "done",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_complete");
          },
        },
      },
    },
    blocked: {
      on: {
        SEND_ANSWER: [
          {
            target: "planning",
            guard: "previousWasPlanning",
            actions: ({ context }) => {
              captureTransitionSnapshot(context, "session_resumed");
            },
          },
          {
            target: "inProgress",
            guard: "previousWasInProgress",
            actions: ({ context }) => {
              captureTransitionSnapshot(context, "session_resumed");
            },
          },
          {
            target: "qa",
            guard: "previousWasQA",
            actions: ({ context }) => {
              captureTransitionSnapshot(context, "session_resumed");
            },
          },
          {
            target: "review",
            guard: "previousWasReview",
            actions: ({ context }) => {
              captureTransitionSnapshot(context, "session_resumed");
            },
          },
        ],
        CANCEL_SESSION: { target: "idle" },
      },
    },
    review: {
      on: {
        DEPLOY_AND_CLEANUP: {
          target: "done",
          actions: ({ context }) => {
            captureTransitionSnapshot(context, "session_complete");
          },
        },
        REQUEST_RETEST: { target: "qa" },
        PAUSE_FOR_QUESTION: {
          target: "blocked",
          actions: ({ context }) => {
            context.previousState = SessionState.Review;
            captureTransitionSnapshot(context, "session_blocked");
          },
        },
        REQUEST_REPLANNING: { target: "planning" },
        RESUME_IMPLEMENTATION: { target: "inProgress" },
        CANCEL_SESSION: { target: "idle" },
      },
    },
    done: {
      on: {
        REOPEN_ISSUE: { target: "idle" },
      },
    },
  },
}, {
  guards: {
    hasNoActiveSession: ({ context }) => !context.sessionId,
    planExists: () => true,
    previousWasPlanning: ({ context }) => context.previousState === SessionState.Planning,
    previousWasInProgress: ({ context }) => context.previousState === SessionState.InProgress,
    previousWasQA: ({ context }) => context.previousState === SessionState.QA,
    previousWasReview: ({ context }) => context.previousState === SessionState.Review,
  },
});

// ---------------------------------------------------------------------------
// Column name to event mapping
// ---------------------------------------------------------------------------

/** Map GitHub Project column transition to XState event type */
const COLUMN_TRANSITION_MAP: Record<string, SessionEvent["type"]> = {
  "Todo:Planning": "START_PLANNING",
  "Planning:In Progress": "INJECT_PROMPT",
  "In Progress:QA": "RUN_TESTS",
  "QA:Review": "STATUS_UPDATE",
  "Review:Done": "DEPLOY_AND_CLEANUP",

  // Blocked
  "Planning:Blocked": "PAUSE_FOR_QUESTION",
  "In Progress:Blocked": "PAUSE_FOR_QUESTION",
  "QA:Blocked": "PAUSE_FOR_QUESTION",
  "Review:Blocked": "PAUSE_FOR_QUESTION",
  "Todo:Blocked": "PAUSE_FOR_QUESTION",

  // Unblocked
  "Blocked:Planning": "SEND_ANSWER",
  "Blocked:In Progress": "SEND_ANSWER",
  "Blocked:QA": "SEND_ANSWER",
  "Blocked:Review": "SEND_ANSWER",

  // QA iteration
  "QA:In Progress": "RESUME_WITH_FAILURES",
  "Review:QA": "REQUEST_RETEST",

  // Backward transitions
  "In Progress:Planning": "REQUEST_REPLANNING",
  "QA:Planning": "REQUEST_REPLANNING",
  "Review:Planning": "REQUEST_REPLANNING",
  "Review:In Progress": "RESUME_IMPLEMENTATION",

  // Cancel
  "Planning:Todo": "CANCEL_SESSION",
  "In Progress:Todo": "CANCEL_SESSION",
  "QA:Todo": "CANCEL_SESSION",
  "Review:Todo": "CANCEL_SESSION",
  "Blocked:Todo": "CANCEL_SESSION",

  // Reopen
  "Done:Todo": "REOPEN_ISSUE",
  "Done:Planning": "REOPEN_ISSUE",
  "Done:In Progress": "REOPEN_ISSUE",
  "Done:QA": "REOPEN_ISSUE",
  "Done:Review": "REOPEN_ISSUE",
  "Done:Blocked": "REOPEN_ISSUE",

  // Direct jumps
  "Todo:In Progress": "QUICK_START",
  "Todo:Done": "CLOSE_WITHOUT_WORK",
  "Planning:Done": "CLOSE_WITHOUT_WORK",
  "In Progress:Done": "CLOSE_WITHOUT_WORK",
  "QA:Done": "CLOSE_WITHOUT_WORK",
  "In Progress:Review": "SKIP_QA",
  "Planning:QA": "SKIP_IMPLEMENTATION",
};

export function columnTransitionToEvent(
  from: string,
  to: string,
): SessionEvent["type"] | null {
  const key = `${from}:${to}`;
  return COLUMN_TRANSITION_MAP[key] ?? null;
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

/**
 * Replace undefined values with null for JSON serialization.
 * XState context may contain undefined values that JSON.stringify drops.
 */
function replaceUndefined(_key: string, value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Persist an XState actor snapshot to SQLite and publish state change via AMQP */
export function persistSnapshot(
  sessionId: string,
  snapshot: Snapshot<unknown>,
  triggerEvent?: string,
): void {
  const db = getDatabase();
  const json = JSON.stringify(snapshot, replaceUndefined);

  db.run(
    `UPDATE sessions
     SET xstate_snapshot = ?, xstate_schema_version = ?
     WHERE id = ?`,
    [json, SCHEMA_VERSION, sessionId],
  );

  // Fire-and-forget AMQP state change event
  const snapshotAny = snapshot as { value?: string; context?: SessionContext };
  if (snapshotAny.value && snapshotAny.context) {
    const stateName = typeof snapshotAny.value === "string"
      ? snapshotAny.value
      : JSON.stringify(snapshotAny.value);
    publishStateChange(sessionId, stateName, triggerEvent || "unknown", {
      repoOwner: snapshotAny.context.repoOwner,
      repoName: snapshotAny.context.repoName,
      issueNumber: snapshotAny.context.issueNumber,
    });
  }
}

/** Restore an XState actor from a persisted snapshot */
export function restoreActor(
  sessionId: string,
): Actor<typeof sessionMachine> | null {
  const db = getDatabase();

  const row = db
    .query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`)
    .get(sessionId) as { xstate_snapshot: string | null } | null;

  if (!row?.xstate_snapshot) {
    return null;
  }

  const snapshot = JSON.parse(row.xstate_snapshot);
  const actor = createActor(sessionMachine, { snapshot });
  actor.start();
  return actor;
}

/** Create a fresh actor for a new session */
export function createSessionActor(
  context: SessionContext,
): Actor<typeof sessionMachine> {
  const actor = createActor(sessionMachine, {
    input: context,
    snapshot: sessionMachine.resolveState({
      value: "idle",
      context,
    }),
  });
  actor.start();
  return actor;
}

/** Get the XState state name from the current actor snapshot */
export function getStateName(
  actor: Actor<typeof sessionMachine>,
): string {
  const snapshot = actor.getSnapshot();
  if (typeof snapshot.value === "string") {
    return snapshot.value;
  }
  return JSON.stringify(snapshot.value);
}

/** Check if an actor can accept a given event */
export function canTransition(
  actor: Actor<typeof sessionMachine>,
  event: SessionEvent,
): boolean {
  const snapshot = actor.getSnapshot();
  return snapshot.can(event);
}

/** Map XState state names to SessionState enum */
export function stateNameToSessionState(stateName: string): SessionState {
  const map: Record<string, SessionState> = {
    idle: SessionState.Idle,
    planning: SessionState.Planning,
    planningComplete: SessionState.PlanningComplete,
    inProgress: SessionState.InProgress,
    qa: SessionState.QA,
    blocked: SessionState.Blocked,
    review: SessionState.Review,
    done: SessionState.Done,
  };
  return map[stateName] ?? SessionState.Idle;
}
