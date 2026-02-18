/**
 * Unit tests for metrics-exporter module
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";

// Test database path
const TEST_DB_PATH = "/tmp/gwa-metrics-test.db";
const SCHEMA_PATH = `${import.meta.dir}/../../schema.sql`;

// ---------------------------------------------------------------------------
// Re-mock db.js with real SQLite implementations.
// amqp.test.ts uses mock.module("../lib/db.js") to stub everything with noops.
// Bun's mock.module is process-wide, so we must override it here with a
// functional implementation backed by the test database.
// ---------------------------------------------------------------------------

let _dbInstance: Database | null = null;

function _getDatabase(): Database {
  if (!_dbInstance) {
    _dbInstance = new Database(process.env.DB_PATH || TEST_DB_PATH);
    _dbInstance.exec("PRAGMA journal_mode=WAL");
    _dbInstance.exec("PRAGMA busy_timeout=5000");
    _dbInstance.exec("PRAGMA foreign_keys=ON");
    _dbInstance.exec("PRAGMA synchronous=NORMAL");
  }
  return _dbInstance;
}

function _closeDatabase(): void {
  if (_dbInstance) {
    _dbInstance.close();
    _dbInstance = null;
  }
}

function _getConfig(key: string): string | null {
  const db = _getDatabase();
  const result = db.query("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | null;
  return result?.value || null;
}

function _setConfig(key: string, value: string): void {
  const db = _getDatabase();
  db.run("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())", [key, value]);
}

mock.module("../lib/db.js", () => ({
  getDatabase: _getDatabase,
  closeDatabase: _closeDatabase,
  getConfig: _getConfig,
  setConfig: _setConfig,
  createConnection: _getDatabase,
  initDatabase: _getDatabase,
  withRetry: (fn: () => unknown) => fn(),
  logActivity: () => {},
  getSession: () => null,
  getSessionByPR: () => null,
  createSession: () => {},
  updateSessionStatus: () => {},
  touchSession: () => {},
  createQuestion: () => 0,
  updateQuestionPosted: () => {},
  answerQuestion: () => {},
  getPendingQuestion: () => null,
  getQuestionByPR: () => null,
  cleanupOldSessions: () => 0,
  getActiveSessionCount: () => 0,
}));

describe("Metrics Exporter", () => {
  let db: Database;

  beforeAll(async () => {
    // Set test database path
    process.env.DB_PATH = TEST_DB_PATH;
    process.env.DISABLE_METRICS_EXPORT = "true"; // Disable auto-start during tests

    // Reset singleton so it picks up the new DB_PATH
    _closeDatabase();

    // Remove test database if exists
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    // Create fresh database and load schema
    db = new Database(TEST_DB_PATH);

    if (existsSync(SCHEMA_PATH)) {
      const schema = await Bun.file(SCHEMA_PATH).text();
      db.exec(schema);
    } else {
      throw new Error(`Schema file not found: ${SCHEMA_PATH}`);
    }

    // Force-initialize the mock singleton so it points to this same file.
    // This ensures metrics-exporter's getDatabase() returns a valid connection.
    _getDatabase();
  });

  afterAll(() => {
    _closeDatabase();
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  beforeEach(() => {
    // Clear test data
    db.exec("DELETE FROM sessions");
    db.exec("DELETE FROM tool_calls");
    db.exec("DELETE FROM commits");
    db.exec("DELETE FROM questions");
    db.exec("DELETE FROM agent_tasks");
    db.exec("DELETE FROM config");
  });

  test("module exports expected functions", async () => {
    const exporter = await import("../lib/metrics-exporter.js");

    expect(exporter.exportDatabaseMetrics).toBeDefined();
    expect(exporter.startMetricsExporter).toBeDefined();
    expect(exporter.stopMetricsExporter).toBeDefined();

    expect(typeof exporter.exportDatabaseMetrics).toBe("function");
    expect(typeof exporter.startMetricsExporter).toBe("function");
    expect(typeof exporter.stopMetricsExporter).toBe("function");
  });

  test("exportDatabaseMetrics handles empty database", async () => {
    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should not throw on empty database
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics processes completed sessions", async () => {
    // Insert test session
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["pr-123", "feature", "complete", 123, "pull_request", "test/repo", now - 300, now]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process the session without errors
    await exportDatabaseMetrics();

    // Verify last export timestamp was updated
    const lastExport = db.query("SELECT value FROM config WHERE key = ?").get("metrics_last_export") as
      | { value: string }
      | null;
    expect(lastExport).toBeDefined();
    expect(parseInt(lastExport!.value, 10)).toBeGreaterThan(0);
  });

  test("exportDatabaseMetrics processes tool calls", async () => {
    // Insert parent session first (FK constraint)
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pr-123", "feature", "running", 123, "pull_request", "test/repo"]
    );
    // Insert test tool calls
    db.run(
      `INSERT INTO tool_calls (session_id, tool_name, success, called_at)
       VALUES (?, ?, ?, ?)`,
      ["pr-123", "Read", 1, now]
    );
    db.run(
      `INSERT INTO tool_calls (session_id, tool_name, success, called_at)
       VALUES (?, ?, ?, ?)`,
      ["pr-123", "Edit", 1, now]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process tool calls without errors
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics processes commits", async () => {
    // Insert test session and commit
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pr-123", "feature", "running", 123, "pull_request", "test/repo"]
    );
    db.run(
      `INSERT INTO commits (session_id, commit_hash, commit_message, created_at)
       VALUES (?, ?, ?, ?)`,
      ["pr-123", "abc123", "Test commit", now]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process commits without errors
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics processes questions answered", async () => {
    // Insert test session and question
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pr-123", "feature", "blocked", 123, "pull_request", "test/repo"]
    );
    db.run(
      `INSERT INTO questions (session_id, question, status, asked_at, answered_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["pr-123", "What should I do?", "answered", now - 300, now]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process questions without errors
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics processes agent tasks", async () => {
    // Insert parent session first (FK constraint)
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["pr-123", "feature", "running", 123, "pull_request", "test/repo"]
    );
    // Insert test agent task
    db.run(
      `INSERT INTO agent_tasks (id, session_id, agent_type, task_id, name, status, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["task-1", "pr-123", "worker", "task-001", "Test Task", "completed", now]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process agent tasks without errors
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics handles batch processing", async () => {
    // Insert many sessions to test batching (BATCH_SIZE = 100)
    const now = Math.floor(Date.now() / 1000);
    const stmt = db.prepare(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < 150; i++) {
      stmt.run(`pr-${i}`, "feature", "complete", i, "pull_request", "test/repo", now - 300, now);
    }

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should handle large batch without errors
    await exportDatabaseMetrics();
  });

  test("exportDatabaseMetrics only processes new records", async () => {
    // Set last export timestamp to now
    const now = Math.floor(Date.now() / 1000);
    db.run(`INSERT INTO config (key, value) VALUES (?, ?)`, ["metrics_last_export", now.toString()]);

    // Insert old session (before last export)
    db.run(
      `INSERT INTO sessions (id, type, status, github_number, github_type, repo, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["pr-old", "feature", "complete", 1, "pull_request", "test/repo", now - 600, now - 300]
    );

    const { exportDatabaseMetrics } = await import("../lib/metrics-exporter.js");

    // Should process without errors (old record should be skipped)
    await exportDatabaseMetrics();
  });

  test("startMetricsExporter can be called multiple times", async () => {
    const { startMetricsExporter, stopMetricsExporter } = await import("../lib/metrics-exporter.js");

    // Enable metrics export for this test
    process.env.DISABLE_METRICS_EXPORT = "false";

    // Should not throw when called multiple times
    expect(() => startMetricsExporter()).not.toThrow();
    expect(() => startMetricsExporter()).not.toThrow(); // Second call should be no-op

    // Clean up
    stopMetricsExporter();
    process.env.DISABLE_METRICS_EXPORT = "true";
  });

  test("stopMetricsExporter can be called safely", async () => {
    const { stopMetricsExporter } = await import("../lib/metrics-exporter.js");

    // Should not throw even if not started
    expect(() => stopMetricsExporter()).not.toThrow();
  });

  test("metrics export respects DISABLE_METRICS_EXPORT env var", async () => {
    process.env.DISABLE_METRICS_EXPORT = "true";
    const { startMetricsExporter } = await import("../lib/metrics-exporter.js");

    // Should not throw and should respect disabled flag
    expect(() => startMetricsExporter()).not.toThrow();

    // Clean up
    process.env.DISABLE_METRICS_EXPORT = "false";
  });
});
