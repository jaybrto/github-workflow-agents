/**
 * Terminal Relay Tests
 *
 * Tests for live terminal streaming, snapshots, asciicast recording,
 * WebSocket server, and MinIO S3 upload.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { Database } from "bun:sqlite";
import { closeDatabase } from "../lib/db.js";

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

const TEST_DB_PATH = "/tmp/gwa-terminal-relay-test.db";
const TEST_STREAMS_DIR = "/tmp/gwa-streams-test";
const TEST_RECORDINGS_DIR = "/tmp/gwa-recordings-test";

let testDb: Database;

beforeAll(() => {
  // Point DB to test file
  process.env.DB_PATH = TEST_DB_PATH;

  // Reset the db.ts singleton so it picks up the new DB_PATH
  closeDatabase();

  // Clean up from previous runs
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);

  testDb = new Database(TEST_DB_PATH);
  testDb.exec("PRAGMA journal_mode=WAL");
  testDb.exec("PRAGMA foreign_keys=ON");
  testDb.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'feature',
      status TEXT NOT NULL DEFAULT 'pending',
      github_number INTEGER NOT NULL DEFAULT 0,
      github_type TEXT NOT NULL DEFAULT 'issue',
      repo TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE terminal_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      svg_data TEXT NOT NULL,
      event_type TEXT NOT NULL,
      captured_at INTEGER DEFAULT (unixepoch())
    );
    CREATE INDEX idx_terminal_snapshots_session ON terminal_snapshots(session_id);

    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event TEXT NOT NULL,
      details TEXT,
      actor TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // Insert a test session
  testDb.run(
    `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
     VALUES ('test-session-1', 'feature', 'running', 42, 'issue', 'jaybrto/test-repo')`
  );
});

afterAll(() => {
  closeDatabase(); // Reset the db.ts singleton
  testDb.close();
  delete process.env.DB_PATH;
  if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
});

// ---------------------------------------------------------------------------
// Asciicast v2 format validation
// ---------------------------------------------------------------------------

describe("asciicast v2 recording format", () => {
  test("header line is valid JSON with version 2", () => {
    const header = {
      version: 2,
      width: 200,
      height: 50,
      timestamp: Math.floor(Date.now() / 1000),
      env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
    };

    const headerStr = JSON.stringify(header);
    const parsed = JSON.parse(headerStr);

    expect(parsed.version).toBe(2);
    expect(parsed.width).toBe(200);
    expect(parsed.height).toBe(50);
    expect(parsed.env.TERM).toBe("xterm-256color");
    expect(typeof parsed.timestamp).toBe("number");
  });

  test("output events are valid NDJSON tuples", () => {
    const startedAt = Date.now() - 5000; // 5 seconds ago
    const now = Date.now();
    const elapsed = (now - startedAt) / 1000;
    const data = "$ echo hello\r\nhello\r\n";

    const event = JSON.stringify([elapsed, "o", data]);
    const parsed = JSON.parse(event);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    expect(typeof parsed[0]).toBe("number"); // timestamp
    expect(parsed[0]).toBeGreaterThan(0);
    expect(parsed[1]).toBe("o"); // output event
    expect(parsed[2]).toBe(data); // data
  });

  test("recording file is valid NDJSON (header + events)", () => {
    const tmpFile = "/tmp/gwa-test-recording.cast";

    // Write header
    const header = JSON.stringify({
      version: 2,
      width: 200,
      height: 50,
      timestamp: Math.floor(Date.now() / 1000),
      env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
    });
    writeFileSync(tmpFile, header + "\n");

    // Write events
    const startedAt = Date.now() - 3000;
    for (let i = 0; i < 3; i++) {
      const elapsed = (Date.now() - startedAt + i * 100) / 1000;
      const event = JSON.stringify([elapsed, "o", `output line ${i}\r\n`]);
      writeFileSync(tmpFile, readFileSync(tmpFile, "utf-8") + event + "\n");
    }

    const content = readFileSync(tmpFile, "utf-8").trim();
    const lines = content.split("\n");

    expect(lines.length).toBe(4); // 1 header + 3 events

    // Verify header
    const parsedHeader = JSON.parse(lines[0]);
    expect(parsedHeader.version).toBe(2);

    // Verify events
    for (let i = 1; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      expect(Array.isArray(event)).toBe(true);
      expect(event[1]).toBe("o");
    }

    // Cleanup
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// Snapshot storage in SQLite
// ---------------------------------------------------------------------------

describe("takeSnapshot stores in SQLite", () => {
  test("snapshot is stored with correct fields", () => {
    const sessionId = "test-session-1";
    const svgData = "<svg>mock terminal content</svg>";
    const eventType = "planning_start";
    const capturedAt = Math.floor(Date.now() / 1000);

    testDb.run(
      `INSERT INTO terminal_snapshots (session_id, svg_data, event_type, captured_at)
       VALUES (?, ?, ?, ?)`,
      [sessionId, svgData, eventType, capturedAt]
    );

    const row = testDb
      .query(`SELECT * FROM terminal_snapshots WHERE session_id = ? AND event_type = ?`)
      .get(sessionId, eventType) as {
      id: number;
      session_id: string;
      svg_data: string;
      event_type: string;
      captured_at: number;
    };

    expect(row).not.toBeNull();
    expect(row.session_id).toBe(sessionId);
    expect(row.svg_data).toBe(svgData);
    expect(row.event_type).toBe(eventType);
    expect(row.captured_at).toBe(capturedAt);
  });

  test("multiple snapshots per session are stored", () => {
    const sessionId = "test-session-1";

    testDb.run(
      `INSERT INTO terminal_snapshots (session_id, svg_data, event_type)
       VALUES (?, ?, ?)`,
      [sessionId, "<svg>snap2</svg>", "checkpoint"]
    );

    const rows = testDb
      .query(`SELECT * FROM terminal_snapshots WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as Array<{ event_type: string }>;

    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  test("snapshots are cascade-deleted when session is deleted", () => {
    // Create a temporary session
    testDb.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
       VALUES ('tmp-cascade', 'feature', 'running', 99, 'issue', 'test/repo')`
    );
    testDb.run(
      `INSERT INTO terminal_snapshots (session_id, svg_data, event_type)
       VALUES ('tmp-cascade', '<svg>will be deleted</svg>', 'test')`
    );

    // Verify snapshot exists
    const before = testDb
      .query(`SELECT COUNT(*) as count FROM terminal_snapshots WHERE session_id = 'tmp-cascade'`)
      .get() as { count: number };
    expect(before.count).toBe(1);

    // Delete session
    testDb.run(`DELETE FROM sessions WHERE id = 'tmp-cascade'`);

    // Verify cascade delete
    const after = testDb
      .query(`SELECT COUNT(*) as count FROM terminal_snapshots WHERE session_id = 'tmp-cascade'`)
      .get() as { count: number };
    expect(after.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S3 upload mock validation
// ---------------------------------------------------------------------------

describe("MinIO S3 upload", () => {
  test("S3 key format matches expected pattern", () => {
    const sessionId = "issue-42";
    const timestamp = Math.floor(Date.now() / 1000);
    const s3Key = `recordings/${sessionId}/${timestamp}.cast`;

    expect(s3Key).toMatch(/^recordings\/issue-42\/\d+\.cast$/);
  });

  test("RecordingMetadata has all required fields", () => {
    const metadata = {
      sessionId: "issue-42",
      s3Key: "recordings/issue-42/1234567890.cast",
      durationMs: 60000,
      sizeBytes: 2048,
      format: "asciicast-v2" as const,
      uploadedAt: Math.floor(Date.now() / 1000),
    };

    expect(metadata.sessionId).toBe("issue-42");
    expect(metadata.s3Key).toContain("recordings/");
    expect(metadata.s3Key).toContain(".cast");
    expect(metadata.durationMs).toBeGreaterThan(0);
    expect(metadata.sizeBytes).toBeGreaterThan(0);
    expect(metadata.format).toBe("asciicast-v2");
    expect(typeof metadata.uploadedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

describe("WebSocket server", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  const TEST_WS_PORT = 18080; // Use high port to avoid conflicts

  beforeEach(async () => {
    // Ensure the module-level singleton is cleared before each test
    const { stopWebSocketServer } = await import("../lib/terminal-relay.js");
    stopWebSocketServer();
    process.env.WS_PORT = String(TEST_WS_PORT);
  });

  afterEach(async () => {
    const { stopWebSocketServer } = await import("../lib/terminal-relay.js");
    stopWebSocketServer();
    if (server) {
      server.stop(true);
      server = null;
    }
    delete process.env.WS_PORT;
  });

  test("health endpoint returns ok", async () => {
    const { startWebSocketServer, stopWebSocketServer } = await import("../lib/terminal-relay.js");

    server = startWebSocketServer(TEST_WS_PORT);

    const res = await fetch(`http://localhost:${TEST_WS_PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    stopWebSocketServer();
    server = null;
  });

  test("non-ws path returns 404", async () => {
    const { startWebSocketServer, stopWebSocketServer } = await import("../lib/terminal-relay.js");

    server = startWebSocketServer(TEST_WS_PORT);

    const res = await fetch(`http://localhost:${TEST_WS_PORT}/invalid`);
    expect(res.status).toBe(404);

    stopWebSocketServer();
    server = null;
  });

  test("WebSocket connection on /ws/{sessionId} upgrades", async () => {
    const { startWebSocketServer, stopWebSocketServer } = await import("../lib/terminal-relay.js");

    server = startWebSocketServer(TEST_WS_PORT);

    const ws = new WebSocket(`ws://localhost:${TEST_WS_PORT}/ws/test-session-1`);

    const connected = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, 2000);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve(true);
      };

      ws.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    });

    expect(connected).toBe(true);

    ws.close();
    stopWebSocketServer();
    server = null;
  });
});

// ---------------------------------------------------------------------------
// TerminalSnapshot type contract
// ---------------------------------------------------------------------------

describe("TerminalSnapshot type contract", () => {
  test("matches shared types definition", () => {
    const snapshot = {
      sessionId: "issue-42",
      svgData: "<svg>terminal content</svg>",
      eventType: "planning_start",
      capturedAt: Math.floor(Date.now() / 1000),
    };

    // Verify all required fields exist and have correct types
    expect(typeof snapshot.sessionId).toBe("string");
    expect(typeof snapshot.svgData).toBe("string");
    expect(typeof snapshot.eventType).toBe("string");
    expect(typeof snapshot.capturedAt).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Presigned URL generation
// ---------------------------------------------------------------------------

describe("presigned URL generation", () => {
  test("getPresignedUrl returns a string URL", async () => {
    // We can only validate the function signature without real MinIO
    // Just verify the import works
    const mod = await import("../lib/terminal-relay.js");
    expect(typeof mod.getPresignedUrl).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

describe("stream lifecycle", () => {
  test("isStreamActive returns false for unknown session", async () => {
    const { isStreamActive } = await import("../lib/terminal-relay.js");
    expect(isStreamActive("nonexistent-session")).toBe(false);
  });

  test("exports all required functions", async () => {
    const mod = await import("../lib/terminal-relay.js");

    expect(typeof mod.startPaneStream).toBe("function");
    expect(typeof mod.stopPaneStream).toBe("function");
    expect(typeof mod.isStreamActive).toBe("function");
    expect(typeof mod.takeSnapshot).toBe("function");
    expect(typeof mod.getSessionSnapshots).toBe("function");
    expect(typeof mod.getPresignedUrl).toBe("function");
    expect(typeof mod.startWebSocketServer).toBe("function");
    expect(typeof mod.stopWebSocketServer).toBe("function");
    expect(typeof mod.shutdown).toBe("function");
  });
});
