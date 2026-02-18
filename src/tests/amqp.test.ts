/**
 * AMQP Client Tests
 *
 * Tests connection management, publishing, subscribing, heartbeats,
 * and graceful shutdown with mocked amqplib.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock, jest } from "bun:test";
import type { AmqpMessage } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Mock amqplib before importing amqp module
// ---------------------------------------------------------------------------

// Track calls made to mock channels/connections
let mockPublishCalls: Array<{
  exchange: string;
  routingKey: string;
  content: Buffer;
  options?: Record<string, unknown>;
}> = [];

let mockAssertExchangeCalls: Array<{
  exchange: string;
  type: string;
  options?: Record<string, unknown>;
}> = [];

let mockAssertQueueCalls: Array<{ queue: string; options?: Record<string, unknown> }> = [];
let mockBindQueueCalls: Array<{ queue: string; exchange: string; pattern: string }> = [];
let mockConsumeCalls: Array<{ queue: string }> = [];
let mockChannelCloseCalls = 0;
let mockConnectionCloseCalls = 0;
let consumeCallback: ((msg: { content: Buffer } | null) => void) | null = null;

// Event handlers
let connectionCloseHandler: (() => void) | null = null;
let connectionErrorHandler: ((err: Error) => void) | null = null;
let channelCloseHandler: (() => void) | null = null;
let channelErrorHandler: ((err: Error) => void) | null = null;

const mockChannel = {
  assertExchange: mock((exchange: string, type: string, options?: Record<string, unknown>) => {
    mockAssertExchangeCalls.push({ exchange, type, options });
    return Promise.resolve({});
  }),
  assertQueue: mock((queue: string, options?: Record<string, unknown>) => {
    mockAssertQueueCalls.push({ queue, options });
    return Promise.resolve({ queue: "amq.gen-test-queue" });
  }),
  bindQueue: mock((queue: string, exchange: string, pattern: string) => {
    mockBindQueueCalls.push({ queue, exchange, pattern });
    return Promise.resolve({});
  }),
  publish: mock(
    (
      exchange: string,
      routingKey: string,
      content: Buffer,
      options?: Record<string, unknown>,
    ) => {
      mockPublishCalls.push({ exchange, routingKey, content, options });
      return true;
    },
  ),
  consume: mock((queue: string, callback: (msg: { content: Buffer } | null) => void) => {
    mockConsumeCalls.push({ queue });
    consumeCallback = callback;
    return Promise.resolve({ consumerTag: "test-consumer" });
  }),
  ack: mock(() => {}),
  nack: mock(() => {}),
  close: mock(() => {
    mockChannelCloseCalls++;
    return Promise.resolve();
  }),
  on: mock((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "close") channelCloseHandler = handler as () => void;
    if (event === "error") channelErrorHandler = handler as (err: Error) => void;
  }),
};

const mockConnection = {
  createConfirmChannel: mock(() => Promise.resolve(mockChannel)),
  close: mock(() => {
    mockConnectionCloseCalls++;
    return Promise.resolve();
  }),
  on: mock((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "close") connectionCloseHandler = handler as () => void;
    if (event === "error") connectionErrorHandler = handler as (err: Error) => void;
  }),
};

// Mock amqplib
mock.module("amqplib", () => ({
  default: {
    connect: mock(() => Promise.resolve(mockConnection)),
  },
  connect: mock(() => Promise.resolve(mockConnection)),
}));

// Mock db.ts to avoid SQLite dependency
// Include all exports to prevent breaking other test files in the same process
const noop = () => {};
const noopNull = () => null;
const noopZero = () => 0;
mock.module("../lib/db.js", () => ({
  getDatabase: () => ({}),
  createConnection: () => ({}),
  initDatabase: () => ({}),
  withRetry: (fn: () => unknown) => fn(),
  closeDatabase: noop,
  getSession: noopNull,
  getSessionByPR: noopNull,
  createSession: noop,
  updateSessionStatus: noop,
  touchSession: noop,
  createQuestion: noopZero,
  updateQuestionPosted: noop,
  answerQuestion: noop,
  getPendingQuestion: noopNull,
  getQuestionByPR: noopNull,
  logActivity: noop,
  getConfig: noopNull,
  setConfig: noop,
  cleanupOldSessions: noopZero,
  getActiveSessionCount: () => 2,
}));

// Now import the module under test
const {
  getConnection,
  publishEvent,
  buildRoutingKey,
  subscribeCommands,
  startHeartbeat,
  stopHeartbeat,
  closeAmqp,
  publishActivityEvent,
  publishStateChange,
  _resetForTesting,
} = await import("../lib/amqp.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  mockPublishCalls = [];
  mockAssertExchangeCalls = [];
  mockAssertQueueCalls = [];
  mockBindQueueCalls = [];
  mockConsumeCalls = [];
  mockChannelCloseCalls = 0;
  mockConnectionCloseCalls = 0;
  consumeCallback = null;
  connectionCloseHandler = null;
  connectionErrorHandler = null;
  channelCloseHandler = null;
  channelErrorHandler = null;
  mockChannel.close.mockClear();
  mockConnection.close.mockClear();
  mockConnection.createConfirmChannel.mockClear();
  mockChannel.ack.mockClear();
  mockChannel.nack.mockClear();
  _resetForTesting();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AMQP connection management", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    await closeAmqp();
    resetMocks();
  });

  test("getConnection creates a connection", async () => {
    const conn = await getConnection();
    expect(conn).toBe(mockConnection as any);
  });

  test("getConnection returns singleton on second call", async () => {
    const conn1 = await getConnection();
    const conn2 = await getConnection();
    expect(conn1).toBe(conn2);
  });

  test("connection registers close and error handlers", async () => {
    await getConnection();
    expect(connectionCloseHandler).not.toBeNull();
    expect(connectionErrorHandler).not.toBeNull();
  });
});

describe("publishEvent", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    await closeAmqp();
    resetMocks();
  });

  test("publishes to gwa.events exchange with correct routing key", async () => {
    const routingKey = "gwa.events.jaybrto.test-repo.session-1.created";
    await publishEvent(routingKey, { foo: "bar" }, "session-1");

    expect(mockPublishCalls.length).toBe(1);
    expect(mockPublishCalls[0].exchange).toBe("gwa.events");
    expect(mockPublishCalls[0].routingKey).toBe(routingKey);
  });

  test("wraps payload in AmqpMessage envelope", async () => {
    const routingKey = "gwa.events.jaybrto.test-repo.session-1.created";
    await publishEvent(routingKey, { action: "test" }, "session-1", "trace-abc");

    const content = JSON.parse(mockPublishCalls[0].content.toString()) as AmqpMessage;
    expect(content.routingKey).toBe(routingKey);
    expect(content.sessionId).toBe("session-1");
    expect(content.traceId).toBe("trace-abc");
    expect(content.payload).toEqual({ action: "test" });
    expect(typeof content.timestamp).toBe("number");
  });

  test("sets persistent and content type options", async () => {
    await publishEvent("gwa.events.test", {}, "session-1");
    expect(mockPublishCalls[0].options).toEqual({
      persistent: true,
      contentType: "application/json",
    });
  });

  test("does not throw on publish failure", async () => {
    // Simulate publish throwing
    mockChannel.publish.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });

    // Should not throw
    await publishEvent("gwa.events.test", {}, "session-1");
  });
});

describe("buildRoutingKey", () => {
  test("formats routing key correctly", () => {
    const key = buildRoutingKey("jaybrto", "my-repo", "sess-42", "state_change");
    expect(key).toBe("gwa.events.jaybrto.my-repo.sess-42.state_change");
  });
});

describe("subscribeCommands", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    await closeAmqp();
    resetMocks();
  });

  test("creates exclusive auto-delete queue with correct binding", async () => {
    const handler = mock(() => {});
    await subscribeCommands("jaybrto", "test-repo", handler);

    // Queue is exclusive and auto-delete
    expect(mockAssertQueueCalls.length).toBeGreaterThanOrEqual(1);
    const queueCall = mockAssertQueueCalls.find((c) => c.options?.exclusive);
    expect(queueCall).toBeTruthy();
    expect(queueCall?.options?.exclusive).toBe(true);
    expect(queueCall?.options?.autoDelete).toBe(true);

    // Binding pattern
    const bindCall = mockBindQueueCalls.find(
      (c) => c.pattern === "gwa.commands.jaybrto.test-repo.#",
    );
    expect(bindCall).toBeTruthy();
    expect(bindCall?.exchange).toBe("gwa.commands");
  });

  test("handler receives parsed AmqpMessage", async () => {
    const received: AmqpMessage[] = [];
    const handler = async (msg: AmqpMessage) => {
      received.push(msg);
    };

    await subscribeCommands("jaybrto", "test-repo", handler);

    // Simulate message delivery
    expect(consumeCallback).not.toBeNull();
    const testMessage: AmqpMessage = {
      routingKey: "gwa.commands.jaybrto.test-repo.restart",
      payload: { action: "restart" },
      timestamp: Date.now(),
      sessionId: "session-99",
    };
    const content = Buffer.from(JSON.stringify(testMessage));
    await consumeCallback!({ content } as any);

    expect(received.length).toBe(1);
    expect(received[0].sessionId).toBe("session-99");
    expect(received[0].payload).toEqual({ action: "restart" });
  });

  test("acks message after successful processing", async () => {
    const handler = mock(() => {});
    await subscribeCommands("jaybrto", "test-repo", handler);

    const msg = {
      content: Buffer.from(
        JSON.stringify({
          routingKey: "test",
          payload: {},
          timestamp: Date.now(),
          sessionId: "s1",
        }),
      ),
    };
    await consumeCallback!(msg as any);
    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
  });

  test("nacks message on handler error", async () => {
    const handler = mock(() => {
      throw new Error("processing failed");
    });
    await subscribeCommands("jaybrto", "test-repo", handler);

    const msg = {
      content: Buffer.from(
        JSON.stringify({
          routingKey: "test",
          payload: {},
          timestamp: Date.now(),
          sessionId: "s1",
        }),
      ),
    };
    await consumeCallback!(msg as any);
    expect(mockChannel.nack).toHaveBeenCalledTimes(1);
  });
});

describe("heartbeat", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    stopHeartbeat();
    await closeAmqp();
    resetMocks();
  });

  test("startHeartbeat does not throw", () => {
    expect(() => startHeartbeat("jaybrto", "test-repo")).not.toThrow();
    stopHeartbeat();
  });

  test("stopHeartbeat clears the interval", () => {
    startHeartbeat("jaybrto", "test-repo");
    stopHeartbeat();
    // Starting again should work (timer was cleared)
    expect(() => startHeartbeat("jaybrto", "test-repo")).not.toThrow();
    stopHeartbeat();
  });
});

describe("graceful shutdown", () => {
  beforeEach(resetMocks);

  test("closeAmqp closes channels and connection", async () => {
    await getConnection();
    // Create publish channel by publishing
    await publishEvent("test", {}, "s1");

    await closeAmqp();

    expect(mockChannelCloseCalls).toBeGreaterThanOrEqual(1);
    expect(mockConnectionCloseCalls).toBe(1);
  });

  test("closeAmqp is idempotent", async () => {
    await closeAmqp();
    await closeAmqp();
    // Should not throw
  });
});

describe("publishActivityEvent", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    await closeAmqp();
    resetMocks();
  });

  test("publishes event with correct routing key", async () => {
    publishActivityEvent("session-1", "session_created", { type: "feature" }, "jaybrto", "repo");

    // Give the fire-and-forget promise time to resolve
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPublishCalls.length).toBe(1);
    expect(mockPublishCalls[0].routingKey).toBe(
      "gwa.events.jaybrto.repo.session-1.session_created",
    );
  });

  test("skips publish when owner or repo is missing", () => {
    publishActivityEvent("session-1", "test_event");
    // Should not have published
    expect(mockPublishCalls.length).toBe(0);
  });
});

describe("publishStateChange", () => {
  beforeEach(resetMocks);
  afterEach(async () => {
    await closeAmqp();
    resetMocks();
  });

  test("publishes state change event with correct payload", async () => {
    publishStateChange("session-42", "planning", "START_PLANNING", {
      repoOwner: "jaybrto",
      repoName: "test-repo",
      issueNumber: 99,
    });

    // Give fire-and-forget time
    await new Promise((r) => setTimeout(r, 50));

    expect(mockPublishCalls.length).toBe(1);
    expect(mockPublishCalls[0].routingKey).toBe(
      "gwa.events.jaybrto.test-repo.session-42.state_change",
    );

    const content = JSON.parse(mockPublishCalls[0].content.toString()) as AmqpMessage;
    expect(content.payload).toEqual({
      newState: "planning",
      triggerEvent: "START_PLANNING",
      issueNumber: 99,
      repoOwner: "jaybrto",
      repoName: "test-repo",
    });
  });
});

// Restore all mocked modules to prevent pollution of subsequent test files
afterAll(() => {
  mock.restore();
});
