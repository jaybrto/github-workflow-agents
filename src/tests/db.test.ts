/**
 * Database tests for GWA
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync } from "fs";
import { Database } from "bun:sqlite";

// Test database path
const TEST_DB_PATH = "/tmp/gwa-test.db";
const SCHEMA_PATH = `${import.meta.dir}/../../schema.sql`;

describe("Database Schema", () => {
  let db: Database;

  beforeAll(async () => {
    // Remove test database if exists
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }

    // Create fresh database
    db = new Database(TEST_DB_PATH);

    // Load schema
    if (existsSync(SCHEMA_PATH)) {
      const schema = await Bun.file(SCHEMA_PATH).text();
      db.exec(schema);
    } else {
      throw new Error(`Schema file not found: ${SCHEMA_PATH}`);
    }
  });

  afterAll(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  test("schema file exists", () => {
    expect(existsSync(SCHEMA_PATH)).toBe(true);
  });

  test("sessions table exists with correct columns", () => {
    const result = db.query("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
      type: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("id");
    expect(columns).toContain("type");
    expect(columns).toContain("status");
    expect(columns).toContain("github_number");
    expect(columns).toContain("github_type");
    expect(columns).toContain("repo");
    expect(columns).toContain("tmux_window");
    expect(columns).toContain("worktree_path");
    expect(columns).toContain("created_at");
  });

  test("questions table exists with correct columns", () => {
    const result = db.query("PRAGMA table_info(questions)").all() as Array<{
      name: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("id");
    expect(columns).toContain("session_id");
    expect(columns).toContain("question");
    expect(columns).toContain("answer");
    expect(columns).toContain("status");
  });

  test("agent_tasks table exists with correct columns", () => {
    const result = db.query("PRAGMA table_info(agent_tasks)").all() as Array<{
      name: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("id");
    expect(columns).toContain("session_id");
    expect(columns).toContain("agent_type");
    expect(columns).toContain("task_id");
    expect(columns).toContain("status");
    expect(columns).toContain("progress");
    expect(columns).toContain("result");
  });

  test("activity_log table exists", () => {
    const result = db.query("PRAGMA table_info(activity_log)").all() as Array<{
      name: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("session_id");
    expect(columns).toContain("event");
    expect(columns).toContain("details");
    expect(columns).toContain("actor");
  });

  test("checkpoints table exists", () => {
    const result = db.query("PRAGMA table_info(checkpoints)").all() as Array<{
      name: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("session_id");
    expect(columns).toContain("checkpoint_type");
    expect(columns).toContain("summary");
  });

  test("config table exists", () => {
    const result = db.query("PRAGMA table_info(config)").all() as Array<{
      name: string;
    }>;
    const columns = result.map((r) => r.name);

    expect(columns).toContain("key");
    expect(columns).toContain("value");
  });

  test("can insert and query session", () => {
    db.run(`
      INSERT INTO sessions (id, type, status, github_number, github_type, repo)
      VALUES ('test-1', 'feature', 'pending', 123, 'issue', 'owner/repo')
    `);

    const row = db.query("SELECT * FROM sessions WHERE id = 'test-1'").get() as {
      id: string;
      status: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.id).toBe("test-1");
    expect(row?.status).toBe("pending");
  });

  test("can insert agent_task", () => {
    db.run(`
      INSERT INTO agent_tasks (id, session_id, agent_type, task_id, name, status)
      VALUES ('task-1', 'test-1', 'worker', 'task-001', 'Test Task', 'pending')
    `);

    const row = db.query("SELECT * FROM agent_tasks WHERE id = 'task-1'").get() as {
      id: string;
      status: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.id).toBe("task-1");
    expect(row?.status).toBe("pending");
  });

  test("can log activity", () => {
    db.run(`
      INSERT INTO activity_log (session_id, event, details, actor)
      VALUES ('test-1', 'test_event', '{"foo":"bar"}', 'test')
    `);

    const row = db.query("SELECT * FROM activity_log WHERE session_id = 'test-1'").get() as {
      event: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.event).toBe("test_event");
  });

  test("indexes exist", () => {
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
      name: string;
    }>;
    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_sessions_status");
    expect(indexNames).toContain("idx_questions_session");
    expect(indexNames).toContain("idx_agent_tasks_session");
    expect(indexNames).toContain("idx_activity_session");
  });

  test("sequential writes maintain data integrity", () => {
    const sessionIds = Array.from({ length: 10 }, (_, i) => `sess-integrity-${i}`);

    for (const id of sessionIds) {
      db.run(
        `INSERT INTO sessions (id, type, status, github_number, github_type, repo, branch, base_branch)
         VALUES (?, 'feature', 'running', ?, 'issue', 'owner/repo', 'feat/test', 'main')`,
        [id, parseInt(id.split("-")[2])]
      );
    }

    const count = db
      .query(`SELECT COUNT(*) as n FROM sessions WHERE id LIKE 'sess-integrity-%'`)
      .get() as { n: number };
    expect(count.n).toBe(10);
  });

  test("transaction rolls back on error, leaving no partial writes", () => {
    let threw = false;
    try {
      const tx = db.transaction(() => {
        db.run(
          `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
           VALUES (?, 'feature', 'running', 999, 'issue', 'owner/repo')`,
          ["sess-rollback-1"]
        );
        // Force a constraint violation — duplicate primary key
        db.run(
          `INSERT INTO sessions (id, type, status, github_number, github_type, repo)
           VALUES (?, 'feature', 'running', 999, 'issue', 'owner/repo')`,
          ["sess-rollback-1"]
        );
      });
      tx();
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    const row = db
      .query(`SELECT id FROM sessions WHERE id = 'sess-rollback-1'`)
      .get() as { id: string } | null;
    expect(row).toBeNull();
  });
});
