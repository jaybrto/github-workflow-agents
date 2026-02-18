/**
 * Behavioral Test: Terminal Relay Stream Lifecycle
 *
 * Tests the terminal streaming lifecycle: FIFO creation, asciicast recording,
 * snapshot capture, and recording upload. Uses mocked tmux, Bun.spawn,
 * and S3 to avoid external dependencies.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from "fs";
import { createTestDatabase, createTestSession } from "./helpers.js";

// ---------------------------------------------------------------------------
// Asciicast v2 format helpers (mirroring terminal-relay.ts logic)
// ---------------------------------------------------------------------------

function writeAsciicastHeader(path: string, width = 200, height = 50): void {
  const header = JSON.stringify({
    version: 2,
    width,
    height,
    timestamp: Math.floor(Date.now() / 1000),
    env: { TERM: "xterm-256color", SHELL: "/bin/bash" },
  });
  writeFileSync(path, header + "\n");
}

function appendAsciicastEvent(path: string, startedAt: number, data: string): void {
  const elapsed = (Date.now() - startedAt) / 1000;
  const event = JSON.stringify([elapsed, "o", data]);
  const { appendFileSync } = require("fs");
  appendFileSync(path, event + "\n");
}

// ---------------------------------------------------------------------------
// Mock stream lifecycle
// ---------------------------------------------------------------------------

interface MockStreamState {
  sessionId: string;
  fifoPath: string;
  recordingPath: string;
  startedAt: number;
  active: boolean;
}

interface S3Upload {
  bucket: string;
  key: string;
  sizeBytes: number;
}

const MOCK_STREAMS_DIR = "/tmp/gwa-test-streams";
const MOCK_RECORDINGS_DIR = "/tmp/gwa-test-recordings";

function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function createMockStreamManager(db: Database) {
  const streams = new Map<string, MockStreamState>();
  const uploads: S3Upload[] = [];

  return {
    streams,
    uploads,

    async startStream(sessionId: string): Promise<void> {
      if (streams.has(sessionId)) {
        throw new Error(`Stream already active for ${sessionId}`);
      }

      ensureDir(MOCK_STREAMS_DIR);
      ensureDir(MOCK_RECORDINGS_DIR);

      const fifoPath = `${MOCK_STREAMS_DIR}/${sessionId}.fifo`;
      const recordingPath = `${MOCK_RECORDINGS_DIR}/${sessionId}.cast`;

      // Simulate FIFO creation (just a regular file for testing)
      writeFileSync(fifoPath, "");

      // Initialize asciicast recording
      writeAsciicastHeader(recordingPath);

      streams.set(sessionId, {
        sessionId,
        fifoPath,
        recordingPath,
        startedAt: Date.now(),
        active: true,
      });

      // Log to DB
      db.run(
        `INSERT INTO activity_log (session_id, event, actor) VALUES (?, 'pane_stream_started', 'system')`,
        [sessionId],
      );
    },

    simulateData(sessionId: string, data: string): void {
      const state = streams.get(sessionId);
      if (!state || !state.active) {
        throw new Error(`No active stream for ${sessionId}`);
      }
      appendAsciicastEvent(state.recordingPath, state.startedAt, data);
    },

    async takeSnapshot(sessionId: string, eventType: string): Promise<{ svgData: string; capturedAt: number }> {
      const capturedAt = Math.floor(Date.now() / 1000);
      const svgData = `<svg>mock snapshot for ${sessionId}</svg>`;

      db.run(
        `INSERT INTO terminal_snapshots (session_id, svg_data, event_type, captured_at)
         VALUES (?, ?, ?, ?)`,
        [sessionId, svgData, eventType, capturedAt],
      );

      return { svgData, capturedAt };
    },

    async stopStream(sessionId: string): Promise<S3Upload | null> {
      const state = streams.get(sessionId);
      if (!state) return null;

      state.active = false;
      streams.delete(sessionId);

      // Simulate upload to S3/MinIO
      let upload: S3Upload | null = null;
      if (existsSync(state.recordingPath)) {
        const fileData = readFileSync(state.recordingPath);
        const s3Key = `recordings/${sessionId}/${Math.floor(Date.now() / 1000)}.cast`;

        upload = {
          bucket: "gwa-recordings",
          key: s3Key,
          sizeBytes: fileData.length,
        };
        uploads.push(upload);

        // Clean up local recording
        unlinkSync(state.recordingPath);
      }

      // Clean up FIFO
      if (existsSync(state.fifoPath)) {
        unlinkSync(state.fifoPath);
      }

      db.run(
        `INSERT INTO activity_log (session_id, event, details, actor)
         VALUES (?, 'pane_stream_stopped', ?, 'system')`,
        [sessionId, JSON.stringify({ durationMs: Date.now() - state.startedAt })],
      );

      return upload;
    },

    isActive(sessionId: string): boolean {
      return streams.has(sessionId) && (streams.get(sessionId)?.active ?? false);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Terminal Relay Stream Lifecycle", () => {
  let db: Database;
  let manager: ReturnType<typeof createMockStreamManager>;
  const sessionId = "terminal-test-1";

  beforeEach(() => {
    db = createTestDatabase();
    createTestSession(db, sessionId);
    manager = createMockStreamManager(db);
  });

  afterEach(() => {
    db.close();
    // Clean up temp directories
    try { rmSync(MOCK_STREAMS_DIR, { recursive: true }); } catch {}
    try { rmSync(MOCK_RECORDINGS_DIR, { recursive: true }); } catch {}
  });

  test("start stream creates FIFO and recording file", async () => {
    await manager.startStream(sessionId);

    expect(manager.isActive(sessionId)).toBe(true);

    const state = manager.streams.get(sessionId)!;
    expect(existsSync(state.fifoPath)).toBe(true);
    expect(existsSync(state.recordingPath)).toBe(true);
  });

  test("starting duplicate stream throws error", async () => {
    await manager.startStream(sessionId);

    expect(() => manager.startStream(sessionId)).toThrow("Stream already active");
  });

  test("recording file has valid asciicast v2 header", async () => {
    await manager.startStream(sessionId);

    const state = manager.streams.get(sessionId)!;
    const content = readFileSync(state.recordingPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(1);

    const header = JSON.parse(lines[0]);
    expect(header.version).toBe(2);
    expect(header.width).toBe(200);
    expect(header.height).toBe(50);
    expect(typeof header.timestamp).toBe("number");
    expect(header.env.TERM).toBe("xterm-256color");
  });

  test("simulated data appends to recording as asciicast events", async () => {
    await manager.startStream(sessionId);

    manager.simulateData(sessionId, "$ echo hello\r\n");
    manager.simulateData(sessionId, "hello\r\n");
    manager.simulateData(sessionId, "$ ls -la\r\n");

    const state = manager.streams.get(sessionId)!;
    const content = readFileSync(state.recordingPath, "utf-8");
    const lines = content.trim().split("\n");

    // Header + 3 events
    expect(lines.length).toBe(4);

    // Verify event format: [timestamp, "o", data]
    for (let i = 1; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      expect(Array.isArray(event)).toBe(true);
      expect(event.length).toBe(3);
      expect(typeof event[0]).toBe("number"); // elapsed seconds
      expect(event[1]).toBe("o"); // output event type
      expect(typeof event[2]).toBe("string"); // data
    }
  });

  test("take snapshot stores in SQLite", async () => {
    await manager.startStream(sessionId);

    const snapshot = await manager.takeSnapshot(sessionId, "checkpoint");

    expect(snapshot.svgData).toContain(sessionId);
    expect(typeof snapshot.capturedAt).toBe("number");

    // Verify in DB
    const rows = db
      .query(`SELECT * FROM terminal_snapshots WHERE session_id = ?`)
      .all(sessionId) as Array<{
        session_id: string;
        svg_data: string;
        event_type: string;
        captured_at: number;
      }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("checkpoint");
    expect(rows[0].svg_data).toContain("mock snapshot");
  });

  test("stop stream uploads recording to S3 and cleans up", async () => {
    await manager.startStream(sessionId);

    manager.simulateData(sessionId, "test data\r\n");

    const state = manager.streams.get(sessionId)!;
    const fifoPath = state.fifoPath;
    const recordingPath = state.recordingPath;

    const upload = await manager.stopStream(sessionId);

    // Recording uploaded
    expect(upload).not.toBeNull();
    expect(upload!.bucket).toBe("gwa-recordings");
    expect(upload!.key).toContain(`recordings/${sessionId}/`);
    expect(upload!.key).toEndWith(".cast");
    expect(upload!.sizeBytes).toBeGreaterThan(0);

    // Local files cleaned up
    expect(existsSync(recordingPath)).toBe(false);
    expect(existsSync(fifoPath)).toBe(false);

    // Stream no longer active
    expect(manager.isActive(sessionId)).toBe(false);
  });

  test("stop stream for nonexistent session returns null", async () => {
    const result = await manager.stopStream("nonexistent");
    expect(result).toBeNull();
  });

  test("activity log records stream start and stop", async () => {
    await manager.startStream(sessionId);
    await manager.stopStream(sessionId);

    const logs = db
      .query(`SELECT event FROM activity_log WHERE session_id = ? ORDER BY created_at`)
      .all(sessionId) as Array<{ event: string }>;

    const events = logs.map((l) => l.event);
    expect(events).toContain("pane_stream_started");
    expect(events).toContain("pane_stream_stopped");
  });

  test("multiple snapshots can be taken mid-stream", async () => {
    await manager.startStream(sessionId);

    await manager.takeSnapshot(sessionId, "planning_start");
    manager.simulateData(sessionId, "working...\r\n");
    await manager.takeSnapshot(sessionId, "checkpoint");
    manager.simulateData(sessionId, "more work...\r\n");
    await manager.takeSnapshot(sessionId, "error");

    const snapshots = db
      .query(`SELECT event_type FROM terminal_snapshots WHERE session_id = ? ORDER BY captured_at`)
      .all(sessionId) as Array<{ event_type: string }>;

    expect(snapshots).toHaveLength(3);
    expect(snapshots.map((s) => s.event_type)).toEqual([
      "planning_start",
      "checkpoint",
      "error",
    ]);
  });

  test("full stream lifecycle: start -> data -> snapshot -> stop -> verify upload", async () => {
    await manager.startStream(sessionId);

    // Simulate terminal activity
    manager.simulateData(sessionId, "$ bun test\r\n");
    manager.simulateData(sessionId, "PASS: all tests passed\r\n");

    // Take a snapshot mid-stream
    await manager.takeSnapshot(sessionId, "checkpoint");

    // Stop and upload
    const upload = await manager.stopStream(sessionId);

    // Verify upload tracked
    expect(manager.uploads).toHaveLength(1);
    expect(upload!.sizeBytes).toBeGreaterThan(0);

    // Verify snapshot persisted
    const snapshots = db
      .query(`SELECT COUNT(*) as count FROM terminal_snapshots WHERE session_id = ?`)
      .get(sessionId) as { count: number };
    expect(snapshots.count).toBe(1);

    // Verify activity log
    const logs = db
      .query(`SELECT event FROM activity_log WHERE session_id = ?`)
      .all(sessionId) as Array<{ event: string }>;
    expect(logs.map((l) => l.event)).toContain("pane_stream_started");
    expect(logs.map((l) => l.event)).toContain("pane_stream_stopped");
  });
});
