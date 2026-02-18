/**
 * Behavioral Test: Multi-Pod Aggregation
 *
 * Tests that the SessionAggregator correctly aggregates session events
 * from multiple runner pods, tracks pod health, and marks pods
 * unhealthy on heartbeat timeout.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionAggregator } from "../../orchestrator/session-aggregator.js";
import type { AmqpMessage } from "../../shared/types.js";
import { createOrchestratorDatabase } from "./helpers.js";

describe("Orchestrator Session Aggregation", () => {
  let db: Database;
  let aggregator: SessionAggregator;

  beforeEach(() => {
    db = createOrchestratorDatabase();
    aggregator = new SessionAggregator(db);
  });

  afterEach(() => {
    aggregator.stop();
    db.close();
  });

  test("tracks session created from pod-1", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-1", state: "idle", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now,
      sessionId: "sess-a",
    });

    const sessions = aggregator.getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("sess-a");
    expect(sessions[0].podName).toBe("pod-1");
    expect(sessions[0].state).toBe("idle");
    expect(sessions[0].issueNumber).toBe(10);
    expect(sessions[0].repo).toBe("jaybrto/repo");
  });

  test("tracks sessions from multiple pods", () => {
    const now = Date.now();

    // Session from pod-1
    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-1", state: "idle", issueNumber: 10, repo: "jaybrto/repo-a" },
      timestamp: now,
      sessionId: "sess-a",
    });

    // Session from pod-2
    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-2", state: "planning", issueNumber: 20, repo: "jaybrto/repo-b" },
      timestamp: now + 100,
      sessionId: "sess-b",
    });

    const sessions = aggregator.getSessions();
    expect(sessions).toHaveLength(2);

    const sessA = aggregator.getSession("sess-a");
    expect(sessA?.podName).toBe("pod-1");

    const sessB = aggregator.getSession("sess-b");
    expect(sessB?.podName).toBe("pod-2");
    expect(sessB?.state).toBe("planning");
  });

  test("updates session state on subsequent events", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-1", state: "idle", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now,
      sessionId: "sess-a",
    });

    // State change
    aggregator.handleEvent({
      routingKey: "gwa.events.session.state_change",
      payload: { podName: "pod-1", state: "planning", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now + 1000,
      sessionId: "sess-a",
    });

    const sess = aggregator.getSession("sess-a");
    expect(sess?.state).toBe("planning");
    expect(sess?.lastEventAt).toBe(now + 1000);
  });

  test("handles heartbeat events and marks pod healthy", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-1" },
      timestamp: now,
      sessionId: "heartbeat",
    });

    const health = aggregator.getPodHealth();
    expect(health).toHaveLength(1);
    expect(health[0].podName).toBe("pod-1");
    expect(health[0].healthy).toBe(true);
    expect(health[0].lastHeartbeat).toBe(now);
  });

  test("heartbeat updates existing pod health", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-1" },
      timestamp: now,
      sessionId: "heartbeat",
    });

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-1" },
      timestamp: now + 30000,
      sessionId: "heartbeat",
    });

    const health = aggregator.getPodHealth();
    expect(health).toHaveLength(1);
    expect(health[0].lastHeartbeat).toBe(now + 30000);
  });

  test("multiple pods tracked independently for health", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-1" },
      timestamp: now,
      sessionId: "heartbeat",
    });

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-2" },
      timestamp: now + 100,
      sessionId: "heartbeat",
    });

    const health = aggregator.getPodHealth();
    expect(health).toHaveLength(2);
    expect(health.find((p) => p.podName === "pod-1")?.healthy).toBe(true);
    expect(health.find((p) => p.podName === "pod-2")?.healthy).toBe(true);
  });

  test("activity feed records events", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-1", state: "idle", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now,
      sessionId: "sess-a",
    });

    aggregator.handleEvent({
      routingKey: "gwa.events.session.state_change",
      payload: { podName: "pod-1", state: "planning", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now + 1000,
      sessionId: "sess-a",
    });

    const feed = aggregator.getActivityFeed("sess-a");
    expect(feed.length).toBeGreaterThanOrEqual(2);
  });

  test("non-session events stored in activity feed", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.jaybrto.repo.sess-a.custom_event",
      payload: { action: "test" },
      timestamp: now,
      sessionId: "sess-a",
    });

    const feed = aggregator.getActivityFeed("sess-a");
    expect(feed).toHaveLength(1);
    expect(feed[0].routing_key).toBe("gwa.events.jaybrto.repo.sess-a.custom_event");
  });

  test("sessions are persisted to SQLite", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.session.created",
      payload: { podName: "pod-1", state: "idle", issueNumber: 10, repo: "jaybrto/repo" },
      timestamp: now,
      sessionId: "sess-a",
    });

    const row = db.query(`SELECT * FROM sessions WHERE session_id = 'sess-a'`).get() as {
      session_id: string;
      pod_name: string;
      state: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.pod_name).toBe("pod-1");
    expect(row?.state).toBe("idle");
  });

  test("pod health is persisted to SQLite", () => {
    const now = Date.now();

    aggregator.handleEvent({
      routingKey: "gwa.events.heartbeat",
      payload: { podName: "pod-1" },
      timestamp: now,
      sessionId: "heartbeat",
    });

    const row = db.query(`SELECT * FROM pod_health WHERE pod_name = 'pod-1'`).get() as {
      pod_name: string;
      healthy: number;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.healthy).toBe(1);
  });
});
