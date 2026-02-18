/**
 * Orchestrator Service Entry Point
 *
 * Initializes the orchestrator's own SQLite database, AMQP connections,
 * session aggregator, push bridge, and REST API server.
 */

import { Database } from "bun:sqlite";
import { SessionAggregator } from "./session-aggregator.js";
import { PushBridge } from "./push-bridge.js";
import { createRestApi } from "./rest-api.js";
import type { AmqpMessage } from "../shared/types.js";
import type { AmqpPublishFn } from "./webhook-handler.js";

const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT || "3001");
const DB_PATH = process.env.ORCHESTRATOR_DB_PATH || "/tmp/gwa-orchestrator.db";

// ---------------------------------------------------------------------------
// SQLite schema for the orchestrator's own database
// ---------------------------------------------------------------------------

function initOrchestratorDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      pod_name TEXT NOT NULL,
      state TEXT NOT NULL,
      issue_number INTEGER DEFAULT 0,
      repo TEXT DEFAULT '',
      last_event_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orch_sessions_state ON sessions(state);
    CREATE INDEX IF NOT EXISTS idx_orch_sessions_pod ON sessions(pod_name);

    CREATE TABLE IF NOT EXISTS activity_feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      routing_key TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orch_activity_session ON activity_feed(session_id);
    CREATE INDEX IF NOT EXISTS idx_orch_activity_time ON activity_feed(created_at);

    CREATE TABLE IF NOT EXISTS pod_health (
      pod_name TEXT PRIMARY KEY,
      last_heartbeat INTEGER NOT NULL,
      healthy INTEGER DEFAULT 1
    );
  `);

  console.log(`[Orchestrator] Database initialized at ${dbPath}`);
  return db;
}

// ---------------------------------------------------------------------------
// AMQP connection (uses amqplib if available, otherwise stubs)
// ---------------------------------------------------------------------------

interface AmqpConnection {
  publish: AmqpPublishFn;
  subscribe: (pattern: string, handler: (msg: AmqpMessage) => void) => Promise<void>;
  close: () => Promise<void>;
}

async function connectAmqp(): Promise<AmqpConnection> {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.warn("[Orchestrator] RABBITMQ_URL not set, using stub AMQP");
    return createStubAmqp();
  }

  try {
    const amqplib = await import("amqplib");
    const conn = await amqplib.connect(url);
    const channel = await conn.createChannel();
    const exchange = "gwa.topic";

    await channel.assertExchange(exchange, "topic", { durable: true });

    const publish: AmqpPublishFn = async (routingKey, payload) => {
      channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true },
      );
    };

    const subscribe = async (
      pattern: string,
      handler: (msg: AmqpMessage) => void,
    ) => {
      const q = await channel.assertQueue("", { exclusive: true });
      await channel.bindQueue(q.queue, exchange, pattern);
      channel.consume(q.queue, (msg) => {
        if (!msg) return;
        try {
          const parsed = JSON.parse(msg.content.toString()) as AmqpMessage;
          handler(parsed);
        } catch (err) {
          console.error("[Orchestrator] Failed to parse AMQP message:", err);
        }
        channel.ack(msg);
      });
    };

    const close = async () => {
      await channel.close();
      await conn.close();
    };

    console.log("[Orchestrator] Connected to RabbitMQ");
    return { publish, subscribe, close };
  } catch (error) {
    console.error("[Orchestrator] Failed to connect to RabbitMQ, using stub:", error);
    return createStubAmqp();
  }
}

function createStubAmqp(): AmqpConnection {
  return {
    publish: async (routingKey, payload) => {
      console.log(`[StubAMQP] publish ${routingKey}:`, JSON.stringify(payload).slice(0, 200));
    },
    subscribe: async (_pattern, _handler) => {
      console.log(`[StubAMQP] subscribe ${_pattern} (stub, no-op)`);
    },
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[Orchestrator] Starting...");

  // 1. Initialize orchestrator SQLite database
  const db = initOrchestratorDb(DB_PATH);

  // 2. Connect AMQP
  const amqp = await connectAmqp();

  // 3. Start session aggregator
  const aggregator = new SessionAggregator(db);
  aggregator.start();

  await amqp.subscribe("gwa.events.#", (msg) => {
    aggregator.handleEvent(msg);
  });

  // 4. Start push bridge
  const pushBridge = new PushBridge();
  await amqp.subscribe("gwa.events.#", (msg) => {
    pushBridge.handleEvent(msg);
  });

  // 5. Start REST API
  const restHandler = createRestApi({
    aggregator,
    publishToAmqp: amqp.publish,
    db,
  });

  const server = Bun.serve({
    port: ORCHESTRATOR_PORT,
    fetch: restHandler,
  });

  console.log(`[Orchestrator] REST API listening on http://localhost:${server.port}`);

  // 6. Graceful shutdown
  const shutdown = async () => {
    console.log("[Orchestrator] Shutting down...");
    aggregator.stop();
    server.stop();
    await amqp.close();
    db.close();
    console.log("[Orchestrator] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal error:", err);
  process.exit(1);
});
