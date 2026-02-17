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
import { getRedisClient } from "./redis.js";
import { log, withSpan, Metrics } from "./telemetry.js";
import { ClaudeAuthError, detectAuthFailure } from "./claude.js";

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
// REDIS KEYS
// ============================================================================

const REPL_TTL_SECONDS = 86400; // 24 hours

function replSessionKey(sessionId: string): string {
  return `repl:session:${sessionId}`;
}

function replByWindowKey(tmuxWindow: number): string {
  return `repl:window:${tmuxWindow}`;
}

// ============================================================================
// SESSION STORAGE
// ============================================================================

async function storeSession(session: REPLSession): Promise<void> {
  const redis = getRedisClient();
  const key = replSessionKey(session.sessionId);

  await redis.hset(key, {
    session_id: session.sessionId,
    tmux_window: session.tmuxWindow.toString(),
    working_dir: session.workingDir,
    started_at: session.startedAt.toString(),
    status: session.status,
  });

  await redis.expire(key, REPL_TTL_SECONDS);

  // Also store reverse lookup by window
  const windowKey = replByWindowKey(session.tmuxWindow);
  await redis.set(windowKey, session.sessionId, "EX", REPL_TTL_SECONDS);
}

async function loadSession(sessionId: string): Promise<REPLSession | null> {
  const redis = getRedisClient();
  const data = await redis.hgetall(replSessionKey(sessionId));

  if (!data || !data.session_id) return null;

  return {
    sessionId: data.session_id,
    tmuxWindow: parseInt(data.tmux_window, 10),
    workingDir: data.working_dir,
    startedAt: parseInt(data.started_at, 10),
    status: data.status as REPLSession["status"],
  };
}

async function updateSessionStatus(
  sessionId: string,
  status: REPLSession["status"]
): Promise<void> {
  const redis = getRedisClient();
  await redis.hset(replSessionKey(sessionId), "status", status);
}

async function deleteSession(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  const session = await loadSession(sessionId);

  if (session) {
    await redis.del(replSessionKey(sessionId));
    await redis.del(replByWindowKey(session.tmuxWindow));
  }
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

      // Store session in Redis
      await storeSession(session);

      // Start Claude in interactive mode (no --print flag)
      await sendCommand(tmuxWindow, "claude");

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
        await deleteSession(sessionId);

        throw new ClaudeAuthError(
          `Claude is stuck on the authentication screen. ` +
          `CLAUDE_CODE_OAUTH_TOKEN may be expired or invalid. ` +
          `Captured output: ${paneOutput.slice(0, 300)}`
        );
      }

      // Send the initial prompt
      await sendKeys(tmuxWindow, prompt);
      await sendKeys(tmuxWindow, "Enter");

      // Update status to running
      session.status = "running";
      await updateSessionStatus(sessionId, "running");

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

      const session = await loadSession(sessionId);

      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      // Verify the window still exists
      const exists = await windowExists(session.tmuxWindow);
      if (!exists) {
        await updateSessionStatus(sessionId, "error");
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
      const redis = getRedisClient();
      await redis.expire(replSessionKey(sessionId), REPL_TTL_SECONDS);
      await redis.expire(replByWindowKey(session.tmuxWindow), REPL_TTL_SECONDS);
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

      const session = await loadSession(sessionId);

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
        await updateSessionStatus(sessionId, "completed");
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

      const session = await loadSession(sessionId);

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

      // Remove session from Redis
      await deleteSession(sessionId);

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

      const session = await loadSession(sessionId);

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

      const session = await loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      await updateSessionStatus(sessionId, "waiting");
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

      const session = await loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      await updateSessionStatus(sessionId, "completed");
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

      const session = await loadSession(sessionId);
      if (!session) {
        throw new Error(`REPL session not found: ${sessionId}`);
      }

      await updateSessionStatus(sessionId, "error");
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
  const redis = getRedisClient();
  return redis.get(replByWindowKey(tmuxWindow));
}
