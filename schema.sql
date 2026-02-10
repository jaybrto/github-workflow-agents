-- GitHub Workflow Agents - SQLite Schema
-- Version: 2.1
-- Date: 2026-02-09

-- Enable WAL mode for concurrent access (5+ sessions)
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;

-- ============================================
-- SESSIONS: Core session tracking
-- ============================================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,              -- "pr-123" or "issue-42"
    type TEXT NOT NULL,               -- "feature" | "pr" | "review"
    status TEXT NOT NULL DEFAULT 'pending',
                                      -- "pending" | "starting" | "running" |
                                      -- "blocked" | "complete" | "error" | "interrupted"

    -- GitHub context
    github_number INTEGER NOT NULL,   -- PR or Issue number
    github_type TEXT NOT NULL,        -- "pull_request" | "issue"
    repo TEXT NOT NULL,               -- "owner/repo"
    branch TEXT,                      -- Branch name
    base_branch TEXT,                 -- Target branch (for PRs)

    -- Infrastructure
    tmux_window INTEGER,              -- tmux window number
    worktree_path TEXT,               -- /home/runner/worktrees/pr-123
    repl_pid INTEGER,                 -- PID of claude process (for liveness check)
    repl_active INTEGER DEFAULT 0,    -- 1 if REPL is running
    claude_session_id TEXT,           -- Claude CLI's internal session ID for --resume

    -- Timestamps
    created_at INTEGER DEFAULT (unixepoch()),
    started_at INTEGER,               -- When REPL started
    completed_at INTEGER,
    interrupted_at INTEGER,           -- Set on crash recovery
    last_activity_at INTEGER,         -- Updated on any activity

    -- Summary
    initial_prompt TEXT,              -- What started this session
    completion_summary TEXT,          -- Final summary when done
    error_message TEXT                -- If status = "error"
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_github ON sessions(github_type, github_number);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);

-- ============================================
-- QUESTIONS: Track all questions and answers
-- ============================================
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    -- Question
    question TEXT NOT NULL,
    question_context TEXT,            -- What Claude was doing when it asked
    screenshot_path TEXT,             -- Path to screenshot file
    github_comment_id INTEGER,        -- ID of posted GitHub comment

    -- Answer
    answer TEXT,
    answered_by TEXT,                 -- GitHub username

    -- Timestamps
    asked_at INTEGER DEFAULT (unixepoch()),
    posted_at INTEGER,                -- When posted to GitHub
    answered_at INTEGER,

    -- Status
    status TEXT DEFAULT 'pending'     -- "pending" | "posted" | "answered" | "timeout"
);

CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status);

-- ============================================
-- PROMPTS: Track all prompts sent to session
-- ============================================
CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    prompt TEXT NOT NULL,
    source TEXT NOT NULL,             -- "initial" | "followup" | "answer" | "human_takeover"
    triggered_by TEXT,                -- GitHub username or "workflow"
    github_comment_id INTEGER,        -- Source comment if from GitHub

    sent_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);

-- ============================================
-- COMMITS: Track commits made by Claude
-- ============================================
CREATE TABLE IF NOT EXISTS commits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    commit_hash TEXT NOT NULL,
    commit_message TEXT NOT NULL,
    files_changed INTEGER,
    insertions INTEGER,
    deletions INTEGER,

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_commits_session ON commits(session_id);

-- ============================================
-- TOOL_CALLS: Track tools Claude uses
-- ============================================
CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    tool_name TEXT NOT NULL,          -- "Read", "Edit", "Bash", etc.
    tool_input TEXT,                  -- JSON of input params (truncated)
    tool_result TEXT,                 -- Summary of result (truncated)
    success INTEGER DEFAULT 1,        -- 1 = success, 0 = failed
    duration_ms INTEGER,

    called_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);

-- ============================================
-- ACTIVITY_LOG: Audit trail of all events
-- ============================================
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,

    event TEXT NOT NULL,              -- See event types below
    details TEXT,                     -- JSON with event-specific data
    actor TEXT,                       -- "claude" | "workflow" | GitHub username

    created_at INTEGER DEFAULT (unixepoch())
);

-- Event types:
-- "session_created", "session_started", "session_interrupted", "session_completed"
-- "repl_started", "repl_crashed", "repl_recovered"
-- "prompt_sent", "question_asked", "question_answered", "question_timeout"
-- "commit_created", "pr_created", "pr_merged"
-- "human_attached", "human_detached", "human_input"
-- "error", "warning"

CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id);
CREATE INDEX IF NOT EXISTS idx_activity_event ON activity_log(event);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(created_at);

-- ============================================
-- SCREENSHOTS: Track captured screenshots
-- ============================================
CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,

    file_path TEXT NOT NULL,          -- /home/runner/.claude/screenshots/...
    file_size INTEGER,
    event_type TEXT,                  -- "question" | "completion" | "error"

    captured_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);

-- ============================================
-- CONFIG: Runtime configuration
-- ============================================
CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);

-- ============================================
-- UPDATE_QUEUE: Track pending dependency updates
-- ============================================
CREATE TABLE IF NOT EXISTS update_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    update_type TEXT NOT NULL,        -- "image" | "npm" | "cli" | "all"
    target_version TEXT,              -- Version to update to (optional)
    reason TEXT,                      -- Why update was triggered

    queued_at INTEGER DEFAULT (unixepoch()),
    applied_at INTEGER,
    status TEXT DEFAULT 'pending',    -- "pending" | "applied" | "skipped" | "failed"
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_update_queue_status ON update_queue(status);

-- ============================================
-- DEPENDENCY_VERSIONS: Track installed versions
-- ============================================
CREATE TABLE IF NOT EXISTS dependency_versions (
    package TEXT PRIMARY KEY,         -- "@anthropic-ai/claude-code", "@anthropic-ai/sdk", etc.
    installed_version TEXT,
    latest_known_version TEXT,
    last_checked_at INTEGER,
    last_updated_at INTEGER
);

-- ============================================
-- RESPONSES: Store Claude's responses for replay
-- ============================================
CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt_id INTEGER REFERENCES prompts(id) ON DELETE SET NULL,

    response_type TEXT NOT NULL,      -- "text" | "tool_use" | "thinking" | "error"
    content TEXT NOT NULL,            -- The actual response content
    content_truncated INTEGER DEFAULT 0, -- 1 if content was truncated for storage

    -- For tool use responses
    tool_name TEXT,                   -- If response_type = "tool_use"
    tool_input TEXT,                  -- JSON of tool input

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id);
CREATE INDEX IF NOT EXISTS idx_responses_prompt ON responses(prompt_id);

-- ============================================
-- CHECKPOINTS: State snapshots before major actions
-- ============================================
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    checkpoint_type TEXT NOT NULL,    -- "pre_commit" | "pre_pr" | "pre_merge" | "manual" | "periodic"
    summary TEXT NOT NULL,            -- Claude's summary of current understanding
    files_modified TEXT,              -- JSON array of modified files
    pending_actions TEXT,             -- JSON of what Claude was about to do

    -- For recovery
    tmux_capture TEXT,                -- Full tmux pane content at checkpoint
    git_status TEXT,                  -- Output of git status at checkpoint
    git_diff_stat TEXT,               -- Output of git diff --stat at checkpoint

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_type ON checkpoints(checkpoint_type);

-- ============================================
-- CONVERSATION_HISTORY: Ordered log for replay
-- ============================================
CREATE TABLE IF NOT EXISTS conversation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,

    role TEXT NOT NULL,               -- "user" | "assistant" | "system"
    content TEXT NOT NULL,            -- The message content
    content_type TEXT DEFAULT 'text', -- "text" | "tool_use" | "tool_result"

    -- Ordering
    sequence_num INTEGER NOT NULL,    -- Order within session
    turn_num INTEGER,                 -- Conversation turn number

    created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_history(session_id, sequence_num);

-- ============================================
-- AGENT_TASKS: Swarm worker task tracking
-- ============================================
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,             -- "architect" | "worker"
    task_id TEXT NOT NULL,                -- From plan (e.g., "task-001")
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
                                          -- "pending" | "in_progress" | "completed" | "failed" | "blocked"
    tmux_window INTEGER,
    skills TEXT,                          -- JSON array of skills
    scope TEXT,                           -- JSON: {files: string[], description: string}
    dependencies TEXT,                    -- JSON: {blockedBy: string[], blocks: string[]}
    validation TEXT,                      -- JSON array of validation criteria
    progress INTEGER DEFAULT 0,           -- 0-100
    result TEXT,                          -- JSON: {success, filesCreated, filesModified, summary, error?}
    created_at INTEGER DEFAULT (unixepoch()),
    started_at INTEGER,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status);
