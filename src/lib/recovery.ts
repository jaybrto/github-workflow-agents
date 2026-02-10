/**
 * Session Recovery Module
 *
 * Handles recovery of interrupted sessions after pod restarts.
 * Marks stale sessions as interrupted and builds resume commands.
 */

import { getDatabase, logActivity } from "./db.js";

export interface InterruptedSession {
  id: string;
  claude_session_id: string | null;
  github_number: number;
  github_type: string;
  repo: string;
  tmux_window: number | null;
  worktree_path: string | null;
  last_checkpoint_id: number | null;
}

/**
 * Mark all active sessions as interrupted on pod startup.
 * Called during entrypoint initialization.
 */
export function recoverStaleSessions(): number {
  const db = getDatabase();

  // Mark all active sessions as interrupted
  const result = db.run(`
    UPDATE sessions
    SET status = 'interrupted',
        repl_active = 0,
        interrupted_at = unixepoch(),
        last_activity_at = unixepoch()
    WHERE status IN ('running', 'blocked', 'starting')
      AND repl_active = 1
  `);

  // Log the recovery for each affected session
  if (result.changes > 0) {
    const affectedSessions = db
      .query(
        `SELECT id FROM sessions WHERE status = 'interrupted' AND interrupted_at >= unixepoch() - 2`
      )
      .all() as { id: string }[];

    for (const session of affectedSessions) {
      logActivity(session.id, "session_interrupted", { reason: "pod_restart" }, "system");
    }

    console.log(`[Recovery] Marked ${result.changes} stale sessions as interrupted`);
  } else {
    console.log("[Recovery] No stale sessions found");
  }

  return result.changes;
}

/**
 * Get interrupted sessions that can be resumed.
 * Prioritizes sessions with Claude session IDs for --resume support.
 */
export function getResumableSessions(): InterruptedSession[] {
  const db = getDatabase();

  return db
    .query(
      `
    SELECT
      s.id,
      s.claude_session_id,
      s.github_number,
      s.github_type,
      s.repo,
      s.tmux_window,
      s.worktree_path,
      (SELECT MAX(id) FROM checkpoints c WHERE c.session_id = s.id) as last_checkpoint_id
    FROM sessions s
    WHERE s.status = 'interrupted'
    ORDER BY s.interrupted_at DESC
  `
    )
    .all() as InterruptedSession[];
}

/**
 * Get interrupted sessions that have Claude session IDs (best for resumption).
 */
export function getSessionsWithClaudeId(): InterruptedSession[] {
  const db = getDatabase();

  return db
    .query(
      `
    SELECT
      s.id,
      s.claude_session_id,
      s.github_number,
      s.github_type,
      s.repo,
      s.tmux_window,
      s.worktree_path,
      (SELECT MAX(id) FROM checkpoints c WHERE c.session_id = s.id) as last_checkpoint_id
    FROM sessions s
    WHERE s.status = 'interrupted'
      AND s.claude_session_id IS NOT NULL
    ORDER BY s.interrupted_at DESC
  `
    )
    .all() as InterruptedSession[];
}

/**
 * Build a resume command for an interrupted session.
 * Uses Claude's --resume if session ID is available, otherwise builds a replay prompt.
 */
export function buildResumeCommand(session: InterruptedSession): string {
  const db = getDatabase();

  // Try to use Claude's --resume if we have the session ID
  if (session.claude_session_id) {
    return `claude --resume ${session.claude_session_id}`;
  }

  // Otherwise, build a replay prompt from checkpoints and conversation history
  const checkpoint = db
    .query(
      `
    SELECT summary, pending_actions FROM checkpoints
    WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
  `
    )
    .get(session.id) as { summary: string; pending_actions: string } | null;

  const lastPrompts = db
    .query(
      `
    SELECT content FROM conversation_history
    WHERE session_id = ? AND role = 'user'
    ORDER BY sequence_num DESC LIMIT 3
  `
    )
    .all(session.id) as { content: string }[];

  let resumePrompt =
    "You were working on this task but the session was interrupted due to a pod restart.\n\n";

  if (checkpoint) {
    resumePrompt += `**Your last checkpoint:**\n${checkpoint.summary}\n\n`;
    if (checkpoint.pending_actions) {
      try {
        const actions = JSON.parse(checkpoint.pending_actions);
        resumePrompt += `**You were about to:**\n${JSON.stringify(actions, null, 2)}\n\n`;
      } catch {
        resumePrompt += `**You were about to:**\n${checkpoint.pending_actions}\n\n`;
      }
    }
  }

  if (lastPrompts.length > 0) {
    resumePrompt += "**Recent context:**\n";
    lastPrompts.reverse().forEach((p) => {
      const truncated = p.content.length > 200 ? p.content.substring(0, 200) + "..." : p.content;
      resumePrompt += `- ${truncated}\n`;
    });
  }

  resumePrompt += "\nPlease continue from where you left off.";

  // Escape the prompt for shell usage
  const escapedPrompt = resumePrompt.replace(/"/g, '\\"').replace(/\$/g, "\\$");

  return `claude -p "${escapedPrompt}"`;
}

/**
 * Get context summary for an interrupted session.
 * Useful for displaying to users or for decision-making.
 */
export function getSessionRecoveryContext(sessionId: string): {
  hasClaudeSessionId: boolean;
  hasCheckpoint: boolean;
  lastCheckpointSummary: string | null;
  conversationTurns: number;
  lastActivity: string;
  worktreePath: string | null;
} {
  const db = getDatabase();

  const session = db
    .query(`SELECT claude_session_id, worktree_path, last_activity_at FROM sessions WHERE id = ?`)
    .get(sessionId) as {
    claude_session_id: string | null;
    worktree_path: string | null;
    last_activity_at: number | null;
  } | null;

  if (!session) {
    return {
      hasClaudeSessionId: false,
      hasCheckpoint: false,
      lastCheckpointSummary: null,
      conversationTurns: 0,
      lastActivity: "never",
      worktreePath: null,
    };
  }

  const checkpoint = db
    .query(`SELECT summary FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(sessionId) as { summary: string } | null;

  const turnCount = db
    .query(`SELECT MAX(turn_num) as max_turn FROM conversation_history WHERE session_id = ?`)
    .get(sessionId) as { max_turn: number | null };

  const lastActivityDate = session.last_activity_at
    ? new Date(session.last_activity_at * 1000).toISOString()
    : "never";

  return {
    hasClaudeSessionId: !!session.claude_session_id,
    hasCheckpoint: !!checkpoint,
    lastCheckpointSummary: checkpoint?.summary || null,
    conversationTurns: turnCount?.max_turn || 0,
    lastActivity: lastActivityDate,
    worktreePath: session.worktree_path,
  };
}

/**
 * Mark a session as recovered (status changes from interrupted to running).
 */
export function markSessionRecovered(sessionId: string): void {
  const db = getDatabase();

  db.run(
    `
    UPDATE sessions
    SET status = 'running',
        repl_active = 1,
        last_activity_at = unixepoch()
    WHERE id = ?
  `,
    [sessionId]
  );

  logActivity(sessionId, "session_recovered", {}, "system");
}

/**
 * Clear interrupted sessions that are too old to recover.
 */
export function clearOldInterruptedSessions(olderThanHours: number = 24): number {
  const db = getDatabase();
  const cutoffTime = Math.floor(Date.now() / 1000) - olderThanHours * 60 * 60;

  const result = db.run(
    `
    UPDATE sessions
    SET status = 'error',
        error_message = 'Session abandoned after interruption timeout'
    WHERE status = 'interrupted' AND interrupted_at < ?
  `,
    [cutoffTime]
  );

  return result.changes;
}
