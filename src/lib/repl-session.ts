/**
 * Interactive REPL session management for long-lived Claude processes.
 * Manages Claude REPL lifecycle within tmux windows.
 */
import { randomUUID } from "crypto";
import {
  ensureSession,
  createWindow,
  sendCommand,
  sendKeys,
  windowExists,
  killWindow,
  capturePane,
  setEnvironment,
} from "./tmux.js";
import { getDatabase } from "./db.js";
import { log, withSpan, Metrics } from "./telemetry.js";
import { ClaudeAuthError, detectAuthFailure, preloadClaudeConfig } from "./claude.js";
import { getAccessToken } from "./credentials-manager.js";
import { handleDialogIfPresent, ClaudeDialogError } from "./dialog-handler.js";

// ============================================================================
// TYPES
// ============================================================================

export interface REPLSession {
  sessionId: string; // UUID
  tmuxWindow: number;
  workingDir: string;
  startedAt: number;
  status: "starting" | "running" | "waiting" | "completed" | "error";
}

export interface REPLStartResult {
  session: REPLSession;
  kubectlAttachCommand: string;
  tmuxAttachCommand: string;
}

// ============================================================================
// SESSION STORAGE (SQLite)
// ============================================================================

function storeSession(session: REPLSession): void {
  const db = getDatabase();
  // Use sessions table with repl-specific fields
  db.run(
    `INSERT OR REPLACE INTO sessions
      (id, type, status, github_number, github_type, repo, tmux_window, worktree_path, started_at, last_activity_at, claude_session_id)
     VALUES (?, 'repl', ?, 0, 'repl', 'repl', ?, ?, ?, unixepoch(), ?)`,
    [
      session.sessionId,
      session.status,
      session.tmuxWindow,
      session.workingDir,
      Math.floor(session.startedAt / 1000),
      session.sessionId,
    ]
  );
}

function loadSession(sessionId: string): REPLSession | null {
  const db = getDatabase();
  const row = db
    .query(`SELECT * FROM sessions WHERE id = ? AND type = 'repl'`)
    .get(sessionId) as {
      id: string;
      status: string;
      tmux_window: number | null;
      worktree_path: string | null;
      started_at: number | null;
    } | null;

  if (!row || row.tmux_window === null) return null;

  return {
    sessionId: row.id,
    tmuxWindow: row.tmux_window,
    workingDir: row.worktree_path || "",
    startedAt: (row.started_at || 0) * 1000,
    status: row.status as REPLSession["status"],
  };
}

function updateSessionStatus(
  sessionId: string,
  status: REPLSession["status"]
): void {
  const db = getDatabase();
  db.run(
    `UPDATE sessions SET status = ?, last_activity_at = unixepoch() WHERE id = ?`,
    [status, sessionId]
  );
}

function deleteSession(sessionId: string): void {
  const db = getDatabase();
  db.run(`DELETE FROM sessions WHERE id = ? AND type = 'repl'`, [sessionId]);
}

function touchSession(sessionId: string): void {
  const db = getDatabase();
  db.run(
    `UPDATE sessions SET last_activity_at = unixepoch() WHERE id = ?`,
    [sessionId]
  );
}

function getSessionIdByWindow(tmuxWindow: number): string | null {
  const db = getDatabase();
  const row = db
    .query(`SELECT id FROM sessions WHERE tmux_window = ? AND type = 'repl' AND status NOT IN ('completed', 'error') ORDER BY created_at DESC LIMIT 1`)
    .get(tmuxWindow) as { id: string } | null;
  return row?.id || null;
}

// ============================================================================
// ATTACH COMMAND GENERATION
// ============================================================================

/**
 * Generate commands for attaching to the REPL session.
 */
export function generateAttachCommands(
  podName: string,
  tmuxWindow: number
): { kubectl: string; tmux: string } {
  const kubectlCmd = `kubectl exec -it ${podName} -- tmux attach -t gwa-work:${tmuxWindow}`;
  const tmuxCmd = `tmux select-window -t gwa-work:${tmuxWindow}`;

  return {
    kubectl: kubectlCmd,
    tmux: tmuxCmd,
  };
}

// ============================================================================
// REPL LIFECYCLE
// ============================================================================

/**
 * Start a new Claude REPL session in a tmux window.
 *
 * @param workingDir - Working directory for the REPL
 * @param prompt - Initial prompt to send to Claude
 * @returns REPL session info and attach commands
 */
export async function startREPL(
  workingDir: string,
  prompt: string
): Promise<REPLStartResult> {
  return withSpan(
    "repl.start",
    async (span) => {
      const sessionId = randomUUID();
      span.setAttribute("repl.session_id", sessionId);
      span.setAttribute("repl.working_dir", workingDir);

      log("info", "Starting REPL session", {
        sessionId,
        workingDir,
        promptLength: prompt.length,
      });

      // Ensure the main tmux session exists
      await ensureSession();

      // Propagate auth env vars into the tmux session so new windows inherit them
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (oauthToken) {
        await setEnvironment("CLAUDE_CODE_OAUTH_TOKEN", oauthToken);
      }
      if (apiKey) {
        await setEnvironment("ANTHROPIC_API_KEY", apiKey);
      }

      // Create a new window for this REPL
      const windowName = `repl-${sessionId.slice(0, 8)}`;
      const tmuxWindow = await createWindow(windowName, workingDir);
      span.setAttribute("repl.tmux_window", tmuxWindow);

      log("info", "Created tmux window for REPL", {
        sessionId,
        tmuxWindow,
        windowName,
      });

      // Create initial session record
      const session: REPLSession = {
        sessionId,
        tmuxWindow,
        workingDir,
        startedAt: Date.now(),
        status: "starting",
      };

      // Store session in SQLite
      storeSession(session);

      // Pre-load Claude config to prevent first-run dialogs
      preloadClaudeConfig();

      // Ensure tmux session has the fresh token from disk (not the stale K8s env var)
      const freshToken = getAccessToken();
      if (freshToken) {
        await sendKeys(tmuxWindow, `export CLAUDE_CODE_OAUTH_TOKEN='${freshToken}'\n`);
        await Bun.sleep(200);
      }

      // Start Claude in interactive mode (no --print flag)
      await sendCommand(tmuxWindow, "claude --dangerously-skip-permissions");

      // Wait for Claude to initialize (3s to allow auth check)
      await Bun.sleep(3000);

      // Check if Claude is stuck on the auth/login screen
      const paneOutput = await capturePane(tmuxWindow, 30);
      if (detectAuthFailure(paneOutput)) {
        log("error", "Claude stuck on auth screen in REPL", {
          sessionId,
          tmuxWindow,
          paneOutput: paneOutput.slice(0, 500),
        });

        // Clean up the stuck window and session
        await killWindow(tmuxWindow);
        deleteSession(sessionId);

        throw new ClaudeAuthError(
          `Claude is stuck on the authentication screen. ` +
          `CLAUDE_CODE_OAUTH_TOKEN may be expired or invalid. ` +
          `Captured output: ${paneOutput.slice(0, 300)}`
        );
      }

      // Check for interactive dialogs blocking Claude startup
      try {
        await handleDialogIfPresent(tmuxWindow);
      } catch (error) {
        if (error instanceof ClaudeDialogError) {
          log("error", "Claude stuck on interactive dialog in REPL", {
            sessionId,
            tmuxWindow,
            capturedOutput: error.capturedOutput.slice(0, 500),
          });
          await killWindow(tmuxWindow);
          deleteSession(sessionId);
          throw error;
        }
        throw error;
      }

      // Send the initial prompt
      await sendKeys(tmuxWindow, prompt);
      await sendKeys(tmuxWindow, "Enter");

      // Update status to running
      session.status = "running";
      updateSessionStatus(sessionId, "running");

      log("info", "REPL session started and prompt sent", {
        sessionId,
        tmuxWindow,
      });

      Metrics.sessionStarted();

      // Get pod name from environment
      const podName = process.env.POD_NAME || "gwa-runner-0";
      const attachCommands = generateAttachCommands(podName, tmuxWindow);

      return {
        session,
        kubectlAttachCommand: attachCommands.kubectl,
        tmuxAttachCommand: attachCommands.tmux,
      };
    },
    {
      attributes: {
        "repl.working_dir": workingDir,
        "repl.prompt_length": prompt.length,
      },
    }
  );
}

/**
 * Send text input to a running REPL session.
 *
 * @param sessionId - The REPL session ID
 * @param text - Text to send to the REPL
 */
export async function sendToREPL(
  sessionId: string,
  text: string
): Promise<void> {
  return withSpan(
    "repl.send",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);
      span.setAttribute("repl.text_length", text.length);

      const session = loadSession(sessionId);

      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      // Verify the window still exists
      const exists = await windowExists(session.tmuxWindow);
      if (!exists) {
        updateSessionStatus(sessionId, "error");
        throw new Error(`Tmux window no longer exists for session: ${sessionId}`);
      }

      log("info", "Sending text to REPL", {
        sessionId,
        tmuxWindow: session.tmuxWindow,
        textLength: text.length,
      });

      // Send the text followed by Enter
      await sendKeys(session.tmuxWindow, text);
      await sendKeys(session.tmuxWindow, "Enter");

      // Touch the session to keep it alive
      touchSession(sessionId);
    },
    {
      attributes: {
        "repl.session_id": sessionId,
        "repl.text_length": text.length,
      },
    }
  );
}

/**
 * Get the current status of a REPL session.
 *
 * @param sessionId - The REPL session ID
 * @returns Session info or null if not found
 */
export async function getREPLStatus(
  sessionId: string
): Promise<REPLSession | null> {
  return withSpan(
    "repl.get_status",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);

      const session = loadSession(sessionId);

      if (!session) {
        log("debug", "REPL session not found", { sessionId });
        return null;
      }

      // Verify the window still exists and update status if needed
      const exists = await windowExists(session.tmuxWindow);
      if (!exists && session.status !== "completed" && session.status !== "error") {
        log("warn", "REPL tmux window no longer exists, marking as completed", {
          sessionId,
          tmuxWindow: session.tmuxWindow,
        });
        updateSessionStatus(sessionId, "completed");
        session.status = "completed";
      }

      return session;
    },
    {
      attributes: {
        "repl.session_id": sessionId,
      },
    }
  );
}

/**
 * Stop and clean up a REPL session.
 *
 * @param sessionId - The REPL session ID to stop
 */
export async function stopREPL(sessionId: string): Promise<void> {
  return withSpan(
    "repl.stop",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);

      const session = loadSession(sessionId);

      if (!session) {
        log("warn", "Attempted to stop non-existent REPL session", { sessionId });
        return;
      }

      log("info", "Stopping REPL session", {
        sessionId,
        tmuxWindow: session.tmuxWindow,
      });

      // Kill the tmux window if it exists
      const exists = await windowExists(session.tmuxWindow);
      if (exists) {
        try {
          // First try to gracefully exit Claude
          await sendKeys(session.tmuxWindow, "q"); // 'q' typically exits Claude REPL
          await Bun.sleep(500);

          // Check if still running
          const stillExists = await windowExists(session.tmuxWindow);
          if (stillExists) {
            // Force kill the window
            await killWindow(session.tmuxWindow);
          }
        } catch (error) {
          log("warn", "Error during graceful REPL shutdown, force killing", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          try {
            await killWindow(session.tmuxWindow);
          } catch {
            // Window may already be gone
          }
        }
      }

      // Remove session from SQLite
      deleteSession(sessionId);

      Metrics.sessionEnded();

      log("info", "REPL session stopped", { sessionId });
    },
    {
      attributes: {
        "repl.session_id": sessionId,
      },
    }
  );
}

/**
 * Capture recent output from a REPL session.
 *
 * @param sessionId - The REPL session ID
 * @param lines - Number of lines to capture (default: 50)
 * @returns Recent output text
 */
export async function captureREPLOutput(
  sessionId: string,
  lines: number = 50
): Promise<string> {
  return withSpan(
    "repl.capture_output",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);
      span.setAttribute("repl.capture_lines", lines);

      const session = loadSession(sessionId);

      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      const exists = await windowExists(session.tmuxWindow);
      if (!exists) {
        throw new Error(`Tmux window no longer exists for session: ${sessionId}`);
      }

      return capturePane(session.tmuxWindow, lines);
    },
    {
      attributes: {
        "repl.session_id": sessionId,
        "repl.capture_lines": lines,
      },
    }
  );
}

/**
 * Mark a REPL session as waiting for user input.
 *
 * @param sessionId - The REPL session ID
 */
export async function markREPLWaiting(sessionId: string): Promise<void> {
  return withSpan(
    "repl.mark_waiting",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);

      const session = loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      updateSessionStatus(sessionId, "waiting");
      log("info", "REPL session marked as waiting", { sessionId });
    },
    {
      attributes: {
        "repl.session_id": sessionId,
      },
    }
  );
}

/**
 * Mark a REPL session as completed successfully.
 *
 * @param sessionId - The REPL session ID
 */
export async function markREPLCompleted(sessionId: string): Promise<void> {
  return withSpan(
    "repl.mark_completed",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);

      const session = loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      updateSessionStatus(sessionId, "completed");
      Metrics.sessionEnded();
      log("info", "REPL session marked as completed", { sessionId });
    },
    {
      attributes: {
        "repl.session_id": sessionId,
      },
    }
  );
}

/**
 * Mark a REPL session as errored.
 *
 * @param sessionId - The REPL session ID
 */
export async function markREPLError(sessionId: string): Promise<void> {
  return withSpan(
    "repl.mark_error",
    async (span) => {
      span.setAttribute("repl.session_id", sessionId);

      const session = loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      updateSessionStatus(sessionId, "error");
      Metrics.sessionEnded();
      log("warn", "REPL session marked as error", { sessionId });
    },
    {
      attributes: {
        "repl.session_id": sessionId,
      },
    }
  );
}

/**
 * Get session ID by tmux window number.
 *
 * @param tmuxWindow - The tmux window number
 * @returns Session ID or null if not found
 */
export async function getSessionByWindow(
  tmuxWindow: number
): Promise<string | null> {
  return getSessionIdByWindow(tmuxWindow);
}
