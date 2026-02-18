/**
 * Shared test helpers for behavioral tests.
 *
 * Provides in-memory SQLite databases, session factories, and XState actor helpers.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { createActor } from "xstate";
import { sessionMachine, getStateName } from "../../lib/state-machine.js";
import type { SessionContext } from "../../shared/types.js";

const SCHEMA_PATH = `${import.meta.dir}/../../../schema.sql`;

/**
 * Create an in-memory SQLite database with the full GWA schema applied.
 */
export function createTestDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  const schema = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(schema);
  return db;
}

/**
 * Create the orchestrator-specific schema (session_aggregator tables).
 * The orchestrator uses its own SQLite DB with different table names.
 */
export function createOrchestratorDatabase(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      pod_name TEXT NOT NULL DEFAULT 'unknown',
      state TEXT NOT NULL DEFAULT 'unknown',
      issue_number INTEGER NOT NULL DEFAULT 0,
      repo TEXT NOT NULL DEFAULT '',
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
      healthy INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

export interface TestSessionOpts {
  id?: string;
  type?: string;
  status?: string;
  github_number?: number;
  github_type?: string;
  repo?: string;
  branch?: string;
  tmux_window?: number | null;
  worktree_path?: string | null;
  initial_prompt?: string;
  project_item_id?: string;
}

/**
 * Insert a test session into the given database with sensible defaults.
 */
export function createTestSession(db: Database, sessionId: string, opts: TestSessionOpts = {}): void {
  db.run(
    `INSERT INTO sessions (id, type, status, github_number, github_type, repo, branch, tmux_window, worktree_path, initial_prompt, project_item_id, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    [
      sessionId,
      opts.type ?? "feature",
      opts.status ?? "pending",
      opts.github_number ?? 42,
      opts.github_type ?? "issue",
      opts.repo ?? "jaybrto/test-repo",
      opts.branch ?? `feature/issue-${opts.github_number ?? 42}`,
      opts.tmux_window !== undefined ? opts.tmux_window : 1,
      opts.worktree_path !== undefined ? opts.worktree_path : `/home/runner/worktrees/${sessionId}`,
      opts.initial_prompt ?? "Test prompt",
      opts.project_item_id ?? null,
    ],
  );
}

/**
 * Insert a test screenshot record into the database.
 */
export function createTestScreenshot(
  db: Database,
  sessionId: string,
  filePath: string,
  eventType = "question",
): number {
  const result = db.run(
    `INSERT INTO screenshots (session_id, file_path, file_size, event_type)
     VALUES (?, ?, ?, ?)`,
    [sessionId, filePath, 1024, eventType],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Insert a test question record into the database.
 */
export function createTestQuestion(db: Database, sessionId: string, question: string): number {
  const result = db.run(
    `INSERT INTO questions (session_id, question, status)
     VALUES (?, ?, 'pending')`,
    [sessionId, question],
  );
  return Number(result.lastInsertRowid);
}

/**
 * Insert a test activity log entry.
 */
export function createTestActivity(
  db: Database,
  sessionId: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO activity_log (session_id, event, details, actor)
     VALUES (?, ?, ?, 'test')`,
    [sessionId, event, details ? JSON.stringify(details) : null],
  );
}

/** Default XState context for tests */
export const defaultContext: SessionContext = {
  sessionId: "test-session-1",
  previousState: null,
  issueNumber: 42,
  repoOwner: "jaybrto",
  repoName: "test-repo",
};

/**
 * Create an XState actor in the given state with optional context overrides.
 */
export function actorInState(
  state: string,
  context?: Partial<SessionContext>,
): ReturnType<typeof createActor<typeof sessionMachine>> {
  const ctx = { ...defaultContext, ...context };
  const actor = createActor(sessionMachine, {
    snapshot: sessionMachine.resolveState({
      value: state,
      context: ctx,
    }),
  });
  actor.start();
  return actor;
}

/**
 * Persist an XState actor snapshot to the given database.
 * This is a test-only version that does NOT call AMQP.
 */
export function persistSnapshotToDb(
  db: Database,
  sessionId: string,
  actor: ReturnType<typeof createActor<typeof sessionMachine>>,
): void {
  const snapshot = actor.getSnapshot();
  const json = JSON.stringify(snapshot, (_key, value) =>
    value === undefined ? null : value,
  );
  db.run(
    `UPDATE sessions SET xstate_snapshot = ?, xstate_schema_version = 1 WHERE id = ?`,
    [json, sessionId],
  );
}

/**
 * Restore an XState actor from the database snapshot.
 * Test-only version that reads directly from the given db.
 */
export function restoreActorFromDb(
  db: Database,
  sessionId: string,
): ReturnType<typeof createActor<typeof sessionMachine>> | null {
  const row = db
    .query(`SELECT xstate_snapshot FROM sessions WHERE id = ?`)
    .get(sessionId) as { xstate_snapshot: string | null } | null;

  if (!row?.xstate_snapshot) return null;

  const snapshot = JSON.parse(row.xstate_snapshot);
  const actor = createActor(sessionMachine, { snapshot });
  actor.start();
  return actor;
}
