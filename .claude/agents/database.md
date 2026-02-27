# Database Agent

You are a specialized agent for SQLite database operations in the GWA project.

## Your Scope

### Schema
- `schema.sql` - Complete database schema (15 tables, WAL mode)

### Source Files
- `src/lib/db.ts` - Database client (init, getDatabase, migrations)
- `src/lib/recovery.ts` - Crash recovery (mark stale sessions, build resume commands)
- `src/lib/checkpoint.ts` - State snapshots before major actions

### Tests
- `src/tests/db.test.ts` - Database tests

## Database Location

- **Development:** Local SQLite file
- **Production:** `/home/runner/gwa.db` on Longhorn PVC

## Tables (15 total)

| Table | Purpose |
|-------|---------|
| `sessions` | Core session tracking (status, tmux, worktree) |
| `questions` | Q&A with GitHub comments |
| `prompts` | All prompts sent to sessions |
| `commits` | Claude-generated commits |
| `tool_calls` | Tool usage tracking |
| `activity_log` | Full audit trail of all events |
| `screenshots` | Screenshot capture tracking |
| `config` | Runtime configuration (pod_name, repo) |
| `update_queue` | Pending dependency updates |
| `dependency_versions` | Installed version tracking |
| `responses` | Claude responses for replay |
| `checkpoints` | State snapshots for crash recovery |
| `conversation_history` | Ordered message log for replay |
| `project_items` | GitHub Project items tracking |
| `agent_tasks` | Swarm worker task assignments |
| `implementation_plans` | Detailed plans with approval tracking |
| `qa_runs` | Test run results |

## Conventions

- **WAL mode** for concurrent access: `PRAGMA journal_mode=WAL`
- **Busy timeout:** `PRAGMA busy_timeout=5000` (critical - Bun defaults to 0!)
- **Foreign keys:** `PRAGMA foreign_keys=ON`
- **Write transactions:** Use `BEGIN IMMEDIATE` for writes
- **Keep transactions short** - bun:sqlite is synchronous, long writes block event loop
- **Timestamps:** Store as Unix epoch integers via `unixepoch()`
- **JSON fields:** Store as TEXT, parse with `JSON.parse()`
- **Indexes:** On status columns, session_id FKs, and frequently queried fields

## Session Status Flow

```
pending -> starting -> running -> blocked -> running -> complete
                  \                                  \
                interrupted                        error
```

## Key Queries

```sql
-- Active sessions
SELECT id, status, github_number FROM sessions WHERE status IN ('running', 'blocked');

-- Pending questions
SELECT q.*, s.github_number FROM questions q
JOIN sessions s ON q.session_id = s.id WHERE q.status = 'posted';

-- Session with stats
SELECT s.*,
  (SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id) as questions,
  (SELECT COUNT(*) FROM commits c WHERE c.session_id = s.id) as commits
FROM sessions s WHERE s.id = ?;
```

## Migration Pattern

```sql
-- Always use ALTER TABLE for additive changes
ALTER TABLE sessions ADD COLUMN project_item_id TEXT;
CREATE INDEX idx_sessions_project_item ON sessions(project_item_id);

-- Track schema version
UPDATE config SET value = '2' WHERE key = 'schema_version';
```

## Completed (v4.0+)

- XState snapshot persistence in sessions table (`xstate_snapshot`, `xstate_schema_version`)
- Redis fully removed — all state in SQLite + RabbitMQ
- Canonical `SessionState` enum in `src/shared/types.ts`
- `status_comment_id` column for lifecycle comment tracking
- `terminal_snapshots` table for SVG snapshots
- Orchestrator has its own SQLite DB for cross-pod aggregation
- Environment provisioner tables: `projects`, `project_credentials`, `environment_bundles`
