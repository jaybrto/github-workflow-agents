/**
 * Orchestrator REST API tests
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionAggregator } from "../orchestrator/session-aggregator.js";
import { createRestApi } from "../orchestrator/rest-api.js";
import type { AmqpPublishFn } from "../orchestrator/webhook-handler.js";

let db: Database;
let aggregator: SessionAggregator;
let handleRequest: (req: Request) => Promise<Response>;
let lastPublished: { routingKey: string; payload: unknown } | null = null;

const mockPublish: AmqpPublishFn = async (routingKey, payload) => {
  lastPublished = { routingKey, payload };
};

function initTestDb(): Database {
  const testDb = new Database(":memory:");
  testDb.exec("PRAGMA journal_mode=WAL");
  testDb.exec("PRAGMA foreign_keys=ON");
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      pod_name TEXT NOT NULL,
      state TEXT NOT NULL,
      issue_number INTEGER DEFAULT 0,
      repo TEXT DEFAULT '',
      last_event_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      routing_key TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pod_health (
      pod_name TEXT PRIMARY KEY,
      last_heartbeat INTEGER NOT NULL,
      healthy INTEGER DEFAULT 1
    );
  `);
  return testDb;
}

beforeAll(() => {
  db = initTestDb();
  aggregator = new SessionAggregator(db);

  // Seed a test session
  aggregator.handleEvent({
    routingKey: "gwa.events.session.started",
    payload: { podName: "gwa-runner-0", state: "in_progress", issueNumber: 42, repo: "jaybrto/test-repo" },
    timestamp: Date.now(),
    sessionId: "pr-42",
  });

  handleRequest = createRestApi({ aggregator, publishToAmqp: mockPublish, db });
});

afterAll(() => {
  db.close();
});

describe("GET /health", () => {
  test("returns ok status", async () => {
    const res = await handleRequest(new Request("http://localhost:3001/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("GET /sessions", () => {
  test("returns list of sessions", async () => {
    const res = await handleRequest(new Request("http://localhost:3001/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].sessionId).toBe("pr-42");
  });
});

describe("GET /sessions/:id", () => {
  test("returns session detail with activity feed", async () => {
    const res = await handleRequest(new Request("http://localhost:3001/sessions/pr-42"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe("pr-42");
    expect(body.state).toBe("in_progress");
    expect(Array.isArray(body.activity)).toBe(true);
  });

  test("returns 404 for unknown session", async () => {
    const res = await handleRequest(new Request("http://localhost:3001/sessions/pr-999"));
    expect(res.status).toBe(404);
  });
});

describe("POST /sessions/:id/answer", () => {
  test("forwards answer via AMQP", async () => {
    lastPublished = null;
    const res = await handleRequest(
      new Request("http://localhost:3001/sessions/pr-42/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "Use the --force flag" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("answer_sent");
    expect(lastPublished).not.toBeNull();
    expect(lastPublished!.routingKey).toBe("gwa.commands.send_answer");
  });

  test("returns 400 if answer field is missing", async () => {
    const res = await handleRequest(
      new Request("http://localhost:3001/sessions/pr-42/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 for unknown session", async () => {
    const res = await handleRequest(
      new Request("http://localhost:3001/sessions/pr-999/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("unknown routes", () => {
  test("returns 404 for unknown path", async () => {
    const res = await handleRequest(new Request("http://localhost:3001/unknown"));
    expect(res.status).toBe(404);
  });
});
