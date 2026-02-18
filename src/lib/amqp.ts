/**
 * RabbitMQ AMQP Client Module
 *
 * Provides singleton connection management, publisher confirms, event publishing,
 * command subscription, heartbeats, and graceful shutdown for GWA sessions.
 */

import amqplib, { type ConfirmChannel, type ConsumeMessage } from "amqplib";
import type { AmqpMessage } from "../shared/types.js";
import { getActiveSessionCount } from "./db.js";

// amqplib.connect() returns ChannelModel in newer @types/amqplib versions.
// Use a permissive type to avoid version-specific type mismatches.
type AmqpConnection = {
  createConfirmChannel(): Promise<ConfirmChannel>;
  close(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
const EXCHANGE_EVENTS = "gwa.events";
const EXCHANGE_HEARTBEAT = "gwa.heartbeat";
const EXCHANGE_COMMANDS = "gwa.commands";
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let connection: AmqpConnection | null = null;
let publishChannel: ConfirmChannel | null = null;
let consumeChannel: ConfirmChannel | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

// Store active consumer info for re-subscription after reconnect
let activeConsumer: {
  owner: string;
  repo: string;
  handler: (msg: AmqpMessage) => void | Promise<void>;
} | null = null;

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Get or create the singleton AMQP connection.
 * Sets up auto-reconnect on disconnect.
 */
export async function getConnection(): Promise<AmqpConnection> {
  if (connection) return connection;

  connection = await amqplib.connect(RABBITMQ_URL) as unknown as AmqpConnection;
  reconnectAttempt = 0;
  console.log("[AMQP] Connected to", RABBITMQ_URL.replace(/\/\/.*@/, "//***@"));

  connection.on("close", () => {
    console.log("[AMQP] Connection closed");
    connection = null;
    publishChannel = null;
    consumeChannel = null;
    if (!isShuttingDown) {
      scheduleReconnect();
    }
  });

  connection.on("error", (...args: unknown[]) => {
    const err = args[0] as Error;
    console.error("[AMQP] Connection error:", err?.message);
  });

  return connection;
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimer) return;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY_MS);
  reconnectAttempt++;
  console.log(`[AMQP] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await getConnection();
      await ensureExchanges();
      // Re-subscribe if there was an active consumer
      if (activeConsumer) {
        const { owner, repo, handler } = activeConsumer;
        await subscribeCommands(owner, repo, handler);
      }
    } catch (err) {
      console.error("[AMQP] Reconnect failed:", (err as Error).message);
      if (!isShuttingDown) {
        scheduleReconnect();
      }
    }
  }, delay);
}

/**
 * Get or create the publish confirm channel.
 */
async function getPublishChannel(): Promise<ConfirmChannel> {
  if (publishChannel) return publishChannel;

  const conn = await getConnection();
  publishChannel = await conn.createConfirmChannel();

  publishChannel.on("close", () => {
    publishChannel = null;
  });

  publishChannel.on("error", (err) => {
    console.error("[AMQP] Publish channel error:", err.message);
    publishChannel = null;
  });

  return publishChannel;
}

/**
 * Get or create the consumer channel.
 */
async function getConsumeChannel(): Promise<ConfirmChannel> {
  if (consumeChannel) return consumeChannel;

  const conn = await getConnection();
  consumeChannel = await conn.createConfirmChannel();

  consumeChannel.on("close", () => {
    consumeChannel = null;
  });

  consumeChannel.on("error", (err) => {
    console.error("[AMQP] Consume channel error:", err.message);
    consumeChannel = null;
  });

  return consumeChannel;
}

// ---------------------------------------------------------------------------
// Exchange setup
// ---------------------------------------------------------------------------

/**
 * Ensure all required exchanges exist.
 */
async function ensureExchanges(): Promise<void> {
  const ch = await getPublishChannel();
  await ch.assertExchange(EXCHANGE_EVENTS, "topic", { durable: true });
  await ch.assertExchange(EXCHANGE_HEARTBEAT, "topic", { durable: true });
  await ch.assertExchange(EXCHANGE_COMMANDS, "topic", { durable: true });
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Publish an event to the gwa.events exchange.
 *
 * Routing key format: gwa.events.{owner}.{repo}.{session}.{eventType}
 * Fire-and-forget: publish failures are logged but do not throw.
 */
export async function publishEvent(
  routingKey: string,
  payload: Record<string, unknown>,
  sessionId: string,
  traceId?: string,
): Promise<void> {
  try {
    const ch = await getPublishChannel();
    await ensureExchanges();

    const message: AmqpMessage = {
      routingKey,
      payload,
      timestamp: Date.now(),
      sessionId,
      traceId,
    };

    const content = Buffer.from(JSON.stringify(message));
    ch.publish(EXCHANGE_EVENTS, routingKey, content, {
      persistent: true,
      contentType: "application/json",
    });

    // Fire-and-forget: don't await confirms for events
  } catch (err) {
    console.error("[AMQP] Failed to publish event:", (err as Error).message);
  }
}

/**
 * Build a routing key for session events.
 */
export function buildRoutingKey(
  owner: string,
  repo: string,
  sessionId: string,
  eventType: string,
): string {
  return `gwa.events.${owner}.${repo}.${sessionId}.${eventType}`;
}

// ---------------------------------------------------------------------------
// Subscribing
// ---------------------------------------------------------------------------

/**
 * Subscribe to commands for a specific owner/repo.
 *
 * Creates an exclusive, auto-delete queue bound to the gwa.commands exchange
 * with pattern: gwa.commands.{owner}.{repo}.#
 */
export async function subscribeCommands(
  owner: string,
  repo: string,
  handler: (msg: AmqpMessage) => void | Promise<void>,
): Promise<void> {
  const ch = await getConsumeChannel();
  await ch.assertExchange(EXCHANGE_COMMANDS, "topic", { durable: true });

  const bindingKey = `gwa.commands.${owner}.${repo}.#`;
  const q = await ch.assertQueue("", { exclusive: true, autoDelete: true });
  await ch.bindQueue(q.queue, EXCHANGE_COMMANDS, bindingKey);

  // Store for re-subscription on reconnect
  activeConsumer = { owner, repo, handler };

  console.log(`[AMQP] Subscribed to commands: ${bindingKey}`);

  ch.consume(q.queue, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    try {
      const parsed: AmqpMessage = JSON.parse(msg.content.toString());
      await handler(parsed);
      ch.ack(msg);
    } catch (err) {
      console.error("[AMQP] Error processing command:", (err as Error).message);
      // Negative ack without requeue to avoid infinite loops
      ch.nack(msg, false, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Start publishing heartbeat messages at regular intervals.
 *
 * Publishes to gwa.heartbeat.{owner}.{repo} every 30 seconds.
 * Uses unref() so the timer doesn't prevent process exit.
 */
export function startHeartbeat(owner: string, repo: string): void {
  if (heartbeatTimer) return;

  const podName = process.env.POD_NAME || (typeof globalThis.process !== "undefined" ? globalThis.process.env.HOSTNAME : undefined) || "unknown";

  const publish = async () => {
    try {
      const ch = await getPublishChannel();
      await ensureExchanges();

      const routingKey = `gwa.heartbeat.${owner}.${repo}`;
      const message: AmqpMessage = {
        routingKey,
        payload: {
          podName,
          activeSessionCount: getActiveSessionCount(),
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
        sessionId: "heartbeat",
      };

      const content = Buffer.from(JSON.stringify(message));
      ch.publish(EXCHANGE_HEARTBEAT, routingKey, content, {
        contentType: "application/json",
      });
    } catch (err) {
      console.error("[AMQP] Heartbeat publish failed:", (err as Error).message);
    }
  };

  heartbeatTimer = setInterval(publish, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  console.log(`[AMQP] Heartbeat started for ${owner}/${repo}`);
}

/**
 * Stop the heartbeat timer.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Activity event publishing (integration with db.ts logActivity)
// ---------------------------------------------------------------------------

/**
 * Publish an activity event to AMQP. Intended to be called alongside
 * logActivity() in db.ts. Fire-and-forget.
 */
export function publishActivityEvent(
  sessionId: string,
  event: string,
  details?: Record<string, unknown>,
  owner?: string,
  repo?: string,
): void {
  if (!owner || !repo) return;

  const routingKey = buildRoutingKey(owner, repo, sessionId, event);
  // Don't await — fire-and-forget
  publishEvent(routingKey, { event, details }, sessionId).catch(() => {
    // Already logged inside publishEvent
  });
}

// ---------------------------------------------------------------------------
// State change publishing (integration with state-machine.ts)
// ---------------------------------------------------------------------------

/**
 * Publish a state change event to AMQP after a successful XState transition.
 * Fire-and-forget — AMQP failures do NOT block state transitions.
 */
export function publishStateChange(
  sessionId: string,
  newState: string,
  triggerEvent: string,
  context: { repoOwner: string; repoName: string; issueNumber: number },
): void {
  const routingKey = buildRoutingKey(
    context.repoOwner,
    context.repoName,
    sessionId,
    "state_change",
  );

  publishEvent(
    routingKey,
    {
      newState,
      triggerEvent,
      issueNumber: context.issueNumber,
      repoOwner: context.repoOwner,
      repoName: context.repoName,
    },
    sessionId,
  ).catch(() => {
    // Already logged inside publishEvent
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Close all AMQP channels and the connection.
 */
export async function closeAmqp(): Promise<void> {
  isShuttingDown = true;

  // Clear pending timers
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();

  // Clear consumer state
  activeConsumer = null;

  // Close channels
  try {
    if (consumeChannel) {
      await consumeChannel.close();
      consumeChannel = null;
    }
  } catch (err) {
    console.error("[AMQP] Error closing consume channel:", (err as Error).message);
  }

  try {
    if (publishChannel) {
      await publishChannel.close();
      publishChannel = null;
    }
  } catch (err) {
    console.error("[AMQP] Error closing publish channel:", (err as Error).message);
  }

  // Close connection
  try {
    if (connection) {
      await connection.close();
      connection = null;
    }
  } catch (err) {
    console.error("[AMQP] Error closing connection:", (err as Error).message);
  }

  console.log("[AMQP] Shutdown complete");
}

// Register shutdown handlers
process.on("SIGTERM", () => {
  closeAmqp().catch((err) => {
    console.error("[AMQP] Shutdown error:", (err as Error).message);
  });
});

process.on("SIGINT", () => {
  closeAmqp().catch((err) => {
    console.error("[AMQP] Shutdown error:", (err as Error).message);
  });
});

// ---------------------------------------------------------------------------
// Test helpers (exported for test mocking/reset)
// ---------------------------------------------------------------------------

/**
 * Reset internal state. Only for testing.
 */
export function _resetForTesting(): void {
  connection = null;
  publishChannel = null;
  consumeChannel = null;
  reconnectAttempt = 0;
  reconnectTimer = null;
  heartbeatTimer = null;
  isShuttingDown = false;
  activeConsumer = null;
}
