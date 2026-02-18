/**
 * Push Bridge tests
 *
 * Tests notification sending, per-session debounce (30s),
 * global rate limit (5/min), per-session cooldown (5 min),
 * and cross-session isolation.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PushBridge } from "../orchestrator/push-bridge.js";
import type { AmqpMessage } from "../shared/types.js";

// Mock global fetch
let fetchCalls: Array<{ url: string; options: RequestInit }> = [];

// Store original fetch
const originalFetch = globalThis.fetch;

function mockFetch() {
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, options: init || {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function makeMessage(
  routingKey: string,
  sessionId: string,
  timestamp: number,
  payload: Record<string, unknown> = {},
): AmqpMessage {
  return { routingKey, sessionId, timestamp, payload };
}

describe("PushBridge", () => {
  let bridge: PushBridge;

  beforeEach(() => {
    bridge = new PushBridge("https://ntfy.test/gwa");
    bridge.reset();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  test("sends notification for blocked event", async () => {
    const sent = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-1", Date.now(), {
        question: "Which branch?",
        repo: "jaybrto/test",
        issueNumber: 1,
      }),
    );
    expect(sent).toBe(true);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].url).toBe("https://ntfy.test/gwa");
  });

  test("sends notification for error event", async () => {
    const sent = await bridge.handleEvent(
      makeMessage("gwa.events.session.error", "pr-2", Date.now(), {
        error: "Build failed",
      }),
    );
    expect(sent).toBe(true);
    expect(fetchCalls.length).toBe(1);
  });

  test("sends notification for complete event", async () => {
    const sent = await bridge.handleEvent(
      makeMessage("gwa.events.session.complete", "pr-3", Date.now(), {
        summary: "All done",
      }),
    );
    expect(sent).toBe(true);
    expect(fetchCalls.length).toBe(1);
  });

  test("ignores events that are not blocked/error/complete", async () => {
    const sent = await bridge.handleEvent(
      makeMessage("gwa.events.session.started", "pr-1", Date.now()),
    );
    expect(sent).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("per-session debounce (30s) prevents duplicate notifications", async () => {
    const now = Date.now();

    // First notification should send
    const sent1 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-10", now),
    );
    expect(sent1).toBe(true);

    // Second notification within 30s should be debounced
    const sent2 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-10", now + 10_000),
    );
    expect(sent2).toBe(false);
    expect(fetchCalls.length).toBe(1);
  });

  test("per-session cooldown (5 min) enforced after debounce window", async () => {
    const now = Date.now();

    // First notification
    const sent1 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-20", now),
    );
    expect(sent1).toBe(true);

    // After debounce (31s) but within cooldown (5 min)
    const sent2 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-20", now + 31_000),
    );
    expect(sent2).toBe(false);

    // After cooldown (5 min + 1s)
    const sent3 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-20", now + 5 * 60_000 + 1_000),
    );
    expect(sent3).toBe(true);
    expect(fetchCalls.length).toBe(2);
  });

  test("global rate limit (5/min) enforced", async () => {
    const now = Date.now();

    // Send 5 notifications for different sessions (all should succeed)
    for (let i = 0; i < 5; i++) {
      const sent = await bridge.handleEvent(
        makeMessage("gwa.events.session.blocked", `pr-rate-${i}`, now + i),
      );
      expect(sent).toBe(true);
    }

    // 6th notification should be rate-limited
    const sent6 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-rate-5", now + 5),
    );
    expect(sent6).toBe(false);
    expect(fetchCalls.length).toBe(5);
  });

  test("different session IDs not affected by each other's cooldowns", async () => {
    const now = Date.now();

    // Notify session A
    const sentA = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-A", now),
    );
    expect(sentA).toBe(true);

    // Notify session B immediately (should succeed — different session)
    const sentB = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-B", now + 1),
    );
    expect(sentB).toBe(true);

    // Session A again within cooldown (should fail)
    const sentA2 = await bridge.handleEvent(
      makeMessage("gwa.events.session.blocked", "pr-A", now + 2),
    );
    expect(sentA2).toBe(false);

    expect(fetchCalls.length).toBe(2);
  });
});
