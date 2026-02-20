/**
 * Session Aggregator
 *
 * Subscribes to gwa.events.# via AMQP and maintains an aggregated view
 * of all sessions across all runner pods. Stores state in the
 * orchestrator's own SQLite database.
 */

import { Database } from "bun:sqlite";
import type { AmqpMessage } from "../shared/types.js";

/** In-memory session data aggregated from pod events */
export interface AggregatedSession {
  sessionId: string;
  podName: string;
  state: string;
  issueNumber: number;
  repo: string;
  lastEventAt: number;
  createdAt: number;
}

/** Pod health entry */
export interface PodHealth {
  podName: string;
  lastHeartbeat: number;
  healthy: boolean;
}

const POD_HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds

export class SessionAggregator {
  private sessions = new Map<string, AggregatedSession>();
  private pods = new Map<string, PodHealth>();
  private db: Database;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  /** Start periodic health checks */
  start(): void {
    this.healthCheckTimer = setInterval(() => this.checkPodHealth(), 30_000);
    if (typeof this.healthCheckTimer === "object" && "unref" in this.healthCheckTimer) {
      this.healthCheckTimer.unref();
    }
    console.log("[SessionAggregator] Started with 30s health check interval");
  }

  /** Stop periodic health checks */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Process an incoming AMQP event */
  handleEvent(message: AmqpMessage): void {
    const { routingKey, payload, sessionId, timestamp } = message;

    if (routingKey.startsWith("gwa.events.heartbeat")) {
      this.handleHeartbeat(payload as { podName: string }, timestamp);
      return;
    }

    if (routingKey.startsWith("gwa.events.session")) {
      this.handleSessionEvent(routingKey, sessionId, payload, timestamp);
      return;
    }

    // Store all events in the activity feed
    this.storeActivityEvent(sessionId, routingKey, payload, timestamp);
  }

  private handleHeartbeat(payload: { podName: string }, timestamp: number): void {
    const { podName } = payload;
    const existing = this.pods.get(podName);

    if (existing) {
      existing.lastHeartbeat = timestamp;
      existing.healthy = true;
    } else {
      this.pods.set(podName, { podName, lastHeartbeat: timestamp, healthy: true });
    }

    this.db.run(
      `INSERT INTO pod_health (pod_name, last_heartbeat, healthy)
       VALUES (?, ?, 1)
       ON CONFLICT(pod_name) DO UPDATE SET last_heartbeat = excluded.last_heartbeat, healthy = 1`,
      [podName, timestamp],
    );
  }

  private handleSessionEvent(
    routingKey: string,
    sessionId: string,
    payload: unknown,
    timestamp: number,
  ): void {
    const data = payload as Record<string, unknown>;
    const podName = (data.podName as string) || "unknown";
    const state = (data.state as string) || "unknown";
    const issueNumber = (data.issueNumber as number) || 0;
    const repo = (data.repo as string) || "";

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.state = state;
      existing.lastEventAt = timestamp;
      existing.podName = podName;
    } else {
      this.sessions.set(sessionId, {
        sessionId,
        podName,
        state,
        issueNumber,
        repo,
        lastEventAt: timestamp,
        createdAt: timestamp,
      });
    }

    // Persist to SQLite
    this.db.run(
      `INSERT INTO sessions (session_id, pod_name, state, issue_number, repo, last_event_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         state = excluded.state,
         pod_name = excluded.pod_name,
         last_event_at = excluded.last_event_at`,
      [sessionId, podName, state, issueNumber, repo, timestamp, timestamp],
    );

    this.storeActivityEvent(sessionId, routingKey, payload, timestamp);
  }

  private storeActivityEvent(
    sessionId: string,
    routingKey: string,
    payload: unknown,
    timestamp: number,
  ): void {
    this.db.run(
      `INSERT INTO activity_feed (session_id, routing_key, payload, created_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, routingKey, JSON.stringify(payload), timestamp],
    );
  }

  /** Check all pods for heartbeat timeouts */
  private checkPodHealth(): void {
    const now = Date.now();
    for (const [podName, pod] of this.pods) {
      if (pod.healthy && now - pod.lastHeartbeat > POD_HEARTBEAT_TIMEOUT_MS) {
        pod.healthy = false;
        console.warn(`[SessionAggregator] Pod ${podName} marked unhealthy (no heartbeat for ${POD_HEARTBEAT_TIMEOUT_MS / 1000}s)`);
        this.db.run(
          `UPDATE pod_health SET healthy = 0 WHERE pod_name = ?`,
          [podName],
        );
      }
    }
  }

  /** Get all sessions */
  getSessions(): AggregatedSession[] {
    return Array.from(this.sessions.values());
  }

  /** Get a single session by ID */
  getSession(sessionId: string): AggregatedSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Get activity feed for a session */
  getActivityFeed(sessionId: string, limit = 50): Array<{
    routing_key: string;
    payload: string;
    created_at: number;
  }> {
    return this.db
      .query(
        `SELECT routing_key, payload, created_at FROM activity_feed
         WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{
        routing_key: string;
        payload: string;
        created_at: number;
      }>;
  }

  /** Get recent activity across all sessions */
  getRecentActivity(limit = 10): Array<{
    session_id: string;
    routing_key: string;
    payload: unknown;
    created_at: number;
  }> {
    const rows = this.db
      .query(
        `SELECT session_id, routing_key, payload, created_at FROM activity_feed
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
        session_id: string;
        routing_key: string;
        payload: string | null;
        created_at: number;
      }>;

    return rows.map((row) => {
      let payload: unknown = null;
      if (row.payload) {
        try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
      }
      return { session_id: row.session_id, routing_key: row.routing_key, payload, created_at: row.created_at };
    });
  }

  /** Get all pod health info */
  getPodHealth(): PodHealth[] {
    return Array.from(this.pods.values());
  }
}
