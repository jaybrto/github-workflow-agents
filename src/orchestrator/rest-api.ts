/**
 * Orchestrator REST API
 *
 * Provides HTTP endpoints for querying aggregated session state,
 * answering blocked sessions, and fetching terminal snapshots/recordings.
 */

import type { SessionAggregator } from "./session-aggregator.js";
import type { AmqpPublishFn } from "./webhook-handler.js";
import type { Database } from "bun:sqlite";

export interface RestApiDeps {
  aggregator: SessionAggregator;
  publishToAmqp: AmqpPublishFn;
  db: Database;
}

/** Parse a URL path into segments */
function parsePath(url: string): string[] {
  const { pathname } = new URL(url);
  return pathname.split("/").filter(Boolean);
}

/** Create the REST API request handler */
export function createRestApi(deps: RestApiDeps) {
  const { aggregator, publishToAmqp, db } = deps;

  return async function handleRequest(request: Request): Promise<Response> {
    const segments = parsePath(request.url);
    const method = request.method;

    try {
      // GET /health
      if (method === "GET" && segments[0] === "health") {
        return json({
          status: "ok",
          uptime: process.uptime(),
          pods: aggregator.getPodHealth(),
          sessionCount: aggregator.getSessions().length,
        });
      }

      // GET /sessions
      if (method === "GET" && segments[0] === "sessions" && segments.length === 1) {
        const sessions = aggregator.getSessions();
        return json(sessions);
      }

      // GET /sessions/:id
      if (method === "GET" && segments[0] === "sessions" && segments.length === 2) {
        const sessionId = segments[1];
        const session = aggregator.getSession(sessionId);
        if (!session) {
          return json({ error: "Session not found" }, 404);
        }
        const activity = aggregator.getActivityFeed(sessionId);
        return json({ ...session, activity });
      }

      // POST /sessions/:id/answer
      if (method === "POST" && segments[0] === "sessions" && segments[2] === "answer") {
        const sessionId = segments[1];
        const session = aggregator.getSession(sessionId);
        if (!session) {
          return json({ error: "Session not found" }, 404);
        }

        const body = await request.json() as { answer: string };
        if (!body.answer) {
          return json({ error: "Missing answer field" }, 400);
        }

        await publishToAmqp(`gwa.commands.send_answer`, {
          sessionId,
          answer: body.answer,
          timestamp: Date.now(),
        });

        return json({ status: "answer_sent", sessionId });
      }

      // GET /sessions/:id/snapshots
      if (method === "GET" && segments[0] === "sessions" && segments[2] === "snapshots") {
        const sessionId = segments[1];
        const snapshots = db
          .query(
            `SELECT session_id, event_type, created_at FROM activity_feed
             WHERE session_id = ? AND routing_key LIKE '%snapshot%'
             ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sessionId);
        return json(snapshots);
      }

      // GET /sessions/:id/recordings
      if (method === "GET" && segments[0] === "sessions" && segments[2] === "recordings") {
        const sessionId = segments[1];
        const recordings = db
          .query(
            `SELECT session_id, payload, created_at FROM activity_feed
             WHERE session_id = ? AND routing_key LIKE '%recording%'
             ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sessionId);
        return json(recordings);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(`[RestAPI] Error handling ${method} /${segments.join("/")}:`, error);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
