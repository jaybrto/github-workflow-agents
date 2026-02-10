/**
 * Checkpoint Module
 *
 * Creates state checkpoints before major actions (commits, PRs, merges).
 * Records conversation history for crash recovery and replay.
 */

import { getDatabase, logActivity } from "./db.js";
import { execSync } from "child_process";

export type CheckpointType = "pre_commit" | "pre_pr" | "pre_merge" | "manual" | "periodic";

export interface CheckpointData {
  sessionId: string;
  type: CheckpointType;
  summary: string;
  filesModified?: string[];
  pendingActions?: Record<string, unknown>;
  captureTmux?: boolean;
  captureGit?: boolean;
}

/**
 * Create a checkpoint for the session.
 * Captures current state before a major action.
 */
export function createCheckpoint(data: CheckpointData): number {
  const db = getDatabase();

  // Get session's worktree path for git operations
  const session = db
    .query(`SELECT worktree_path, tmux_window FROM sessions WHERE id = ?`)
    .get(data.sessionId) as { worktree_path: string | null; tmux_window: number | null } | null;

  let tmuxCapture: string | null = null;
  let gitStatus: string | null = null;
  let gitDiffStat: string | null = null;

  // Capture tmux pane content if requested
  if (data.captureTmux !== false && session && session.tmux_window !== null) {
    try {
      tmuxCapture = execSync(
        `tmux capture-pane -t claude-work:${session.tmux_window} -p -S -1000`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
    } catch {
      // Ignore tmux capture errors
    }
  }

  // Capture git state if requested and worktree exists
  if (data.captureGit !== false && session?.worktree_path) {
    try {
      gitStatus = execSync(`git -C "${session.worktree_path}" status --short`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      gitDiffStat = execSync(`git -C "${session.worktree_path}" diff --stat`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch {
      // Ignore git capture errors
    }
  }

  const result = db.run(
    `INSERT INTO checkpoints (
      session_id, checkpoint_type, summary, files_modified, pending_actions,
      tmux_capture, git_status, git_diff_stat
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.sessionId,
      data.type,
      data.summary,
      data.filesModified ? JSON.stringify(data.filesModified) : null,
      data.pendingActions ? JSON.stringify(data.pendingActions) : null,
      tmuxCapture,
      gitStatus,
      gitDiffStat,
    ]
  );

  logActivity(data.sessionId, "checkpoint_created", { type: data.type }, "claude");

  return Number(result.lastInsertRowid);
}

/**
 * Record a conversation message for replay.
 */
export function recordConversation(data: {
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  contentType?: "text" | "tool_use" | "tool_result";
  turnNum?: number;
}): number {
  const db = getDatabase();

  // Get next sequence number
  const lastSeq = db
    .query(`SELECT MAX(sequence_num) as max_seq FROM conversation_history WHERE session_id = ?`)
    .get(data.sessionId) as { max_seq: number | null };

  const sequenceNum = (lastSeq?.max_seq || 0) + 1;

  const result = db.run(
    `INSERT INTO conversation_history (session_id, role, content, content_type, sequence_num, turn_num)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.sessionId,
      data.role,
      data.content,
      data.contentType || "text",
      sequenceNum,
      data.turnNum || null,
    ]
  );

  return Number(result.lastInsertRowid);
}

/**
 * Record a Claude response (for crash replay).
 */
export function recordResponse(data: {
  sessionId: string;
  promptId?: number;
  responseType: "text" | "tool_use" | "thinking" | "error";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}): number {
  const db = getDatabase();

  // Truncate content if too long (keep first 50KB)
  const maxContentLength = 50000;
  const content = data.content.length > maxContentLength
    ? data.content.substring(0, maxContentLength)
    : data.content;
  const contentTruncated = data.content.length > maxContentLength ? 1 : 0;

  const result = db.run(
    `INSERT INTO responses (session_id, prompt_id, response_type, content, content_truncated, tool_name, tool_input)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.sessionId,
      data.promptId || null,
      data.responseType,
      content,
      contentTruncated,
      data.toolName || null,
      data.toolInput ? JSON.stringify(data.toolInput) : null,
    ]
  );

  return Number(result.lastInsertRowid);
}

/**
 * Capture and store Claude CLI's session ID for --resume support.
 */
export function captureClaudeSessionId(gwaSessionId: string, claudeSessionId: string): void {
  const db = getDatabase();

  db.run(`UPDATE sessions SET claude_session_id = ?, last_activity_at = unixepoch() WHERE id = ?`, [
    claudeSessionId,
    gwaSessionId,
  ]);

  logActivity(gwaSessionId, "claude_session_captured", { claudeSessionId }, "system");
}

/**
 * Get the latest checkpoint for a session.
 */
export function getLatestCheckpoint(sessionId: string): {
  id: number;
  type: CheckpointType;
  summary: string;
  filesModified: string[] | null;
  pendingActions: Record<string, unknown> | null;
  gitStatus: string | null;
  createdAt: number;
} | null {
  const db = getDatabase();

  const checkpoint = db
    .query(
      `SELECT id, checkpoint_type as type, summary, files_modified, pending_actions, git_status, created_at as createdAt
       FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId) as {
    id: number;
    type: CheckpointType;
    summary: string;
    files_modified: string | null;
    pending_actions: string | null;
    git_status: string | null;
    createdAt: number;
  } | null;

  if (!checkpoint) return null;

  return {
    id: checkpoint.id,
    type: checkpoint.type,
    summary: checkpoint.summary,
    filesModified: checkpoint.files_modified ? JSON.parse(checkpoint.files_modified) : null,
    pendingActions: checkpoint.pending_actions ? JSON.parse(checkpoint.pending_actions) : null,
    gitStatus: checkpoint.git_status,
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Get conversation history for replay.
 */
export function getConversationHistory(
  sessionId: string,
  limit?: number
): Array<{
  role: string;
  content: string;
  contentType: string;
  sequenceNum: number;
  turnNum: number | null;
}> {
  const db = getDatabase();

  let query = `
    SELECT role, content, content_type as contentType, sequence_num as sequenceNum, turn_num as turnNum
    FROM conversation_history
    WHERE session_id = ?
    ORDER BY sequence_num ASC
  `;

  if (limit) {
    query += ` LIMIT ${limit}`;
  }

  return db.query(query).all(sessionId) as Array<{
    role: string;
    content: string;
    contentType: string;
    sequenceNum: number;
    turnNum: number | null;
  }>;
}

/**
 * Record a tool call for tracking.
 */
export function recordToolCall(data: {
  sessionId: string;
  toolName: string;
  toolInput?: string;
  toolResult?: string;
  success?: boolean;
  durationMs?: number;
}): number {
  const db = getDatabase();

  // Truncate input/result to reasonable size (keep first 5KB each)
  const maxLength = 5000;
  const toolInput = data.toolInput && data.toolInput.length > maxLength
    ? data.toolInput.substring(0, maxLength) + "..."
    : data.toolInput;
  const toolResult = data.toolResult && data.toolResult.length > maxLength
    ? data.toolResult.substring(0, maxLength) + "..."
    : data.toolResult;

  const result = db.run(
    `INSERT INTO tool_calls (session_id, tool_name, tool_input, tool_result, success, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.sessionId,
      data.toolName,
      toolInput || null,
      toolResult || null,
      data.success !== false ? 1 : 0,
      data.durationMs || null,
    ]
  );

  return Number(result.lastInsertRowid);
}

/**
 * Record a commit made by Claude.
 */
export function recordCommit(data: {
  sessionId: string;
  commitHash: string;
  commitMessage: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}): number {
  const db = getDatabase();

  const result = db.run(
    `INSERT INTO commits (session_id, commit_hash, commit_message, files_changed, insertions, deletions)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.sessionId,
      data.commitHash,
      data.commitMessage,
      data.filesChanged || null,
      data.insertions || null,
      data.deletions || null,
    ]
  );

  logActivity(data.sessionId, "commit_created", { hash: data.commitHash }, "claude");

  return Number(result.lastInsertRowid);
}

/**
 * Create a pre-commit checkpoint automatically.
 */
export function createPreCommitCheckpoint(
  sessionId: string,
  summary: string,
  filesModified: string[]
): number {
  return createCheckpoint({
    sessionId,
    type: "pre_commit",
    summary,
    filesModified,
    captureTmux: true,
    captureGit: true,
  });
}

/**
 * Create a pre-PR checkpoint automatically.
 */
export function createPrePRCheckpoint(
  sessionId: string,
  summary: string,
  pendingActions: Record<string, unknown>
): number {
  return createCheckpoint({
    sessionId,
    type: "pre_pr",
    summary,
    pendingActions,
    captureTmux: true,
    captureGit: true,
  });
}
