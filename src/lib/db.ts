/**
 * SQLite Database Module
 *
 * Handles database initialization, connection management, and common operations.
 * Uses Bun's built-in SQLite with WAL mode for concurrent access.
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { dirname } from "path";

// Schema path — safe to capture at module load (does not change between tests)
const SCHEMA_PATH = process.env.SCHEMA_PATH || "/opt/gwa/schema.sql";

// Database path — read at call time so tests can override via process.env.DB_PATH
function getDbPath(): string {
  return process.env.DB_PATH || "/home/runner/gwa.db";
}

// Connection pool for concurrent access
let dbInstance: Database | null = null;

/**
 * Get a database connection with proper settings.
 * Uses a singleton pattern for the main process.
 */
export function getDatabase(): Database {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = new Database(getDbPath());
  configurePragmas(dbInstance);
  return dbInstance;
}

/**
 * Create a new database connection (for use in subprocesses).
 * Caller is responsible for closing this connection.
 */
export function createConnection(): Database {
  const db = new Database(getDbPath());
  configurePragmas(db);
  return db;
}

/**
 * Configure SQLite pragmas for optimal performance and safety.
 */
function configurePragmas(db: Database): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA cache_size=-64000"); // 64MB cache
}

/**
 * Initialize the database schema if not already created.
 * Called on pod startup.
 */
export function initDatabase(): Database {
  const db = getDatabase();

  // Check if schema is initialized
  const hasSchema = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`)
    .get();

  if (!hasSchema) {
    console.log("[DB] Initializing database schema...");

    // Try to load schema from file
    if (existsSync(SCHEMA_PATH)) {
      const schema = readFileSync(SCHEMA_PATH, "utf-8");
      db.exec(schema);
      console.log("[DB] Schema loaded from file");
    } else {
      // Inline minimal schema for bootstrapping
      console.log("[DB] Schema file not found, creating minimal schema");
      createMinimalSchema(db);
    }

    // Set initial config
    db.run(
      `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())`,
      ["initialized_at", String(Date.now())]
    );
    db.run(
      `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())`,
      ["schema_version", "2.1"]
    );
  }

  // Migrate: add status_comment_id if missing (v4.8)
  const cols = db
    .query("PRAGMA table_info(sessions)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "status_comment_id")) {
    db.run("ALTER TABLE sessions ADD COLUMN status_comment_id INTEGER");
    console.log("[DB] Migrated: added status_comment_id column");
  }

  return db;
}

/**
 * Create minimal schema for bootstrapping when schema.sql is not available.
 */
function createMinimalSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      github_number INTEGER NOT NULL,
      github_type TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT,
      base_branch TEXT,
      tmux_window INTEGER,
      worktree_path TEXT,
      repl_pid INTEGER,
      repl_active INTEGER DEFAULT 0,
      claude_session_id TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      interrupted_at INTEGER,
      last_activity_at INTEGER,
      initial_prompt TEXT,
      completion_summary TEXT,
      error_message TEXT,
      project_item_id TEXT,
      xstate_snapshot TEXT,
      xstate_schema_version INTEGER DEFAULT 1,
      status_comment_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      question_context TEXT,
      screenshot_path TEXT,
      github_comment_id INTEGER,
      answer TEXT,
      answered_by TEXT,
      asked_at INTEGER DEFAULT (unixepoch()),
      posted_at INTEGER,
      answered_at INTEGER,
      status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      details TEXT,
      actor TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

/**
 * Retry wrapper for critical write operations that may encounter SQLITE_BUSY.
 * Retries up to 3 times with exponential backoff.
 */
export function withRetry<T>(fn: () => T, maxRetries: number = 3): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      const isBusy =
        error instanceof Error &&
        (error.message.includes("SQLITE_BUSY") || error.message.includes("database is locked"));
      if (!isBusy || attempt === maxRetries) {
        throw error;
      }
      // Exponential backoff: 50ms, 100ms, 200ms
      const delayMs = 50 * Math.pow(2, attempt);
      Bun.sleepSync(delayMs);
    }
  }
  throw lastError;
}

/**
 * Close the database connection.
 * Call this before process exit for clean shutdown.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ============================================
// Session Operations
// ============================================

export interface Session {
  id: string;
  type: string;
  status: string;
  github_number: number;
  github_type: string;
  repo: string;
  branch: string | null;
  base_branch: string | null;
  tmux_window: number | null;
  worktree_path: string | null;
  repl_pid: number | null;
  repl_active: number;
  claude_session_id: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  interrupted_at: number | null;
  last_activity_at: number | null;
  initial_prompt: string | null;
  completion_summary: string | null;
  error_message: string | null;
  // Phase 15 (v3.4) - GitHub Projects integration
  project_item_id: string | null;
  // XState integration (v4.0)
  xstate_snapshot: string | null;
  xstate_schema_version: number | null;
  // Lifecycle comment tracking (v4.8)
  status_comment_id: number | null;
}

export function getSession(sessionId: string): Session | null {
  const db = getDatabase();
  return db.query(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as Session | null;
}

export function getSessionByPR(repo: string, prNumber: number): Session | null {
  const db = getDatabase();
  return db
    .query(`SELECT * FROM sessions WHERE repo = ? AND github_number = ? ORDER BY created_at DESC LIMIT 1`)
    .get(repo, prNumber) as Session | null;
}

export function createSession(data: {
  id: string;
  type: string;
  github_number: number;
  github_type: string;
  repo: string;
  branch?: string;
  base_branch?: string;
  tmux_window?: number;
  worktree_path?: string;
  initial_prompt?: string;
  // Phase 15 (v3.4) - GitHub Projects integration
  project_item_id?: string;
}): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO sessions (id, type, github_number, github_type, repo, branch, base_branch, tmux_window, worktree_path, initial_prompt, project_item_id, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      [
        data.id,
        data.type,
        data.github_number,
        data.github_type,
        data.repo,
        data.branch || null,
        data.base_branch || null,
        data.tmux_window || null,
        data.worktree_path || null,
        data.initial_prompt || null,
        data.project_item_id || null,
      ]
    );
    db.run(
      `INSERT INTO activity_log (session_id, event, details, actor) VALUES (?, ?, ?, ?)`,
      [data.id, "session_created", JSON.stringify({ type: data.type }), "workflow"]
    );
  });
  tx();
}

export function updateSessionStatus(
  sessionId: string,
  status: string,
  additionalFields?: Record<string, string | number | null>
): void {
  const db = getDatabase();

  let sql = `UPDATE sessions SET status = ?, last_activity_at = unixepoch()`;
  const params: (string | number | null)[] = [status];

  // Handle specific status transitions
  if (status === "running" || status === "starting") {
    sql += `, started_at = COALESCE(started_at, unixepoch()), repl_active = 1`;
  } else if (status === "complete") {
    sql += `, completed_at = unixepoch(), repl_active = 0`;
  } else if (status === "error") {
    sql += `, repl_active = 0`;
  } else if (status === "interrupted") {
    sql += `, interrupted_at = unixepoch(), repl_active = 0`;
  } else if (status === "blocked") {
    sql += `, repl_active = 1`; // REPL is still running, just blocked
  }

  // Add any additional fields
  if (additionalFields) {
    for (const [key, value] of Object.entries(additionalFields)) {
      sql += `, ${key} = ?`;
      params.push(value);
    }
  }

  sql += ` WHERE id = ?`;
  params.push(sessionId);

  db.run(sql, params);
}

export function touchSession(sessionId: string): void {
  const db = getDatabase();
  db.run(`UPDATE sessions SET last_activity_at = unixepoch() WHERE id = ?`, [sessionId]);
}

// ============================================
// Question Operations
// ============================================

export interface Question {
  id: number;
  session_id: string;
  question: string;
  question_context: string | null;
  screenshot_path: string | null;
  github_comment_id: number | null;
  answer: string | null;
  answered_by: string | null;
  asked_at: number;
  posted_at: number | null;
  answered_at: number | null;
  status: string;
}

export function createQuestion(data: {
  session_id: string;
  question: string;
  question_context?: string;
  screenshot_path?: string;
}): number {
  const db = getDatabase();
  let lastId = 0;
  const tx = db.transaction(() => {
    const result = db.run(
      `INSERT INTO questions (session_id, question, question_context, screenshot_path)
       VALUES (?, ?, ?, ?)`,
      [data.session_id, data.question, data.question_context || null, data.screenshot_path || null]
    );
    lastId = Number(result.lastInsertRowid);
    db.run(
      `INSERT INTO activity_log (session_id, event, details, actor) VALUES (?, ?, ?, ?)`,
      [data.session_id, "question_asked", JSON.stringify({ question: data.question.substring(0, 200) }), "claude"]
    );
  });
  tx();
  return lastId;
}

export function updateQuestionPosted(questionId: number, githubCommentId: number): void {
  const db = getDatabase();
  db.run(
    `UPDATE questions SET status = 'posted', posted_at = unixepoch(), github_comment_id = ? WHERE id = ?`,
    [githubCommentId, questionId]
  );
}

export function answerQuestion(questionId: number, answer: string, answeredBy: string): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.run(
      `UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = unixepoch() WHERE id = ?`,
      [answer, answeredBy, questionId]
    );

    // Get session ID for logging (inside transaction so it sees the updated row)
    const question = db.query(`SELECT session_id FROM questions WHERE id = ?`).get(questionId) as {
      session_id: string;
    } | null;

    if (question) {
      db.run(
        `INSERT INTO activity_log (session_id, event, details, actor) VALUES (?, ?, ?, ?)`,
        [question.session_id, "question_answered", JSON.stringify({ answeredBy }), answeredBy]
      );
    }
  });
  tx();
}

export function getPendingQuestion(sessionId: string): Question | null {
  const db = getDatabase();
  return db
    .query(`SELECT * FROM questions WHERE session_id = ? AND status = 'posted' ORDER BY asked_at DESC LIMIT 1`)
    .get(sessionId) as Question | null;
}

export function getQuestionByPR(repo: string, prNumber: number): Question | null {
  const db = getDatabase();
  return db
    .query(
      `SELECT q.* FROM questions q
       JOIN sessions s ON q.session_id = s.id
       WHERE s.repo = ? AND s.github_number = ? AND q.status = 'posted'
       ORDER BY q.asked_at DESC LIMIT 1`
    )
    .get(repo, prNumber) as Question | null;
}

// ============================================
// Activity Log Operations
// ============================================

export function logActivity(
  sessionId: string | null,
  event: string,
  details?: Record<string, unknown>,
  actor?: string
): void {
  const db = getDatabase();
  db.run(
    `INSERT INTO activity_log (session_id, event, details, actor) VALUES (?, ?, ?, ?)`,
    [sessionId, event, details ? JSON.stringify(details) : null, actor || "system"]
  );
}

// ============================================
// Config Operations
// ============================================

export function getConfig(key: string): string | null {
  const db = getDatabase();
  const result = db.query(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | null;
  return result?.value || null;
}

export function setConfig(key: string, value: string): void {
  const db = getDatabase();
  db.run(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, unixepoch())`, [key, value]);
}

// ============================================
// Cleanup Operations
// ============================================

export function cleanupOldSessions(olderThanDays: number = 7): number {
  const db = getDatabase();
  const cutoffTime = Math.floor(Date.now() / 1000) - olderThanDays * 24 * 60 * 60;

  const result = db.run(
    `DELETE FROM sessions WHERE status IN ('complete', 'error') AND completed_at < ?`,
    [cutoffTime]
  );

  return result.changes;
}

export function getActiveSessionCount(): number {
  const db = getDatabase();
  const result = db
    .query(`SELECT COUNT(*) as count FROM sessions WHERE status IN ('running', 'blocked', 'starting')`)
    .get() as { count: number };

  return result.count;
}

// ============================================
// Provision Session Operations
// ============================================

export function ensureProvisionSessionsTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provision_sessions (
      id TEXT PRIMARY KEY,
      pod_name TEXT NOT NULL,
      tmux_window INTEGER,
      oauth_url TEXT,
      kubectl_command TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      bundle_id TEXT,
      s3_key TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER
    );
  `);
}

export function getProvisionSession(id: string): Record<string, unknown> | null {
  const db = getDatabase();
  return db.query("SELECT * FROM provision_sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
}

export function getLatestProvisionSession(): Record<string, unknown> | null {
  const db = getDatabase();
  return db.query("SELECT * FROM provision_sessions ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | null;
}

export function upsertProvisionSession(session: {
  id: string;
  podName: string;
  tmuxWindow?: number;
  oauthUrl?: string;
  kubectlCommand?: string;
  status: string;
  bundleId?: string;
  s3Key?: string;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO provision_sessions
      (id, pod_name, tmux_window, oauth_url, kubectl_command, status, bundle_id, s3_key, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM provision_sessions WHERE id = ?), unixepoch()), ?)`,
    [
      session.id,
      session.podName,
      session.tmuxWindow ?? null,
      session.oauthUrl ?? null,
      session.kubectlCommand ?? null,
      session.status,
      session.bundleId ?? null,
      session.s3Key ?? null,
      session.id,
      session.status === "complete" || session.status === "failed" ? Math.floor(Date.now() / 1000) : null,
    ]
  );
}
