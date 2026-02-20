/**
 * Haiku-powered dialog detection and dismissal for Claude Code CLI.
 * Detects interactive TUI dialogs blocking Claude from starting in tmux
 * windows and auto-dismisses them by sending key sequences.
 */
import Anthropic from "@anthropic-ai/sdk";
import { capturePane, sendKeys } from "./tmux.js";
import { log } from "./telemetry.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 256;
const MAX_ATTEMPTS = 3;
const MAX_KEYS = 10;
const KEY_DELAY_MS = 200;
const POST_DISMISS_WAIT_MS = 1000;

/** Allowed tmux key names that Haiku can send */
const ALLOWED_KEYS = new Set([
  "Down",
  "Up",
  "Enter",
  "Tab",
  "Space",
  "Escape",
  "y",
  "n",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

/** Known dialog patterns that can be dismissed without an API call */
const KNOWN_DIALOGS: Array<{
  pattern: RegExp;
  keys: string[];
  reason: string;
}> = [
  {
    pattern: /bypass permissions/i,
    keys: ["Enter"],
    reason: "Accepting bypass permissions dialog",
  },
  {
    pattern: /trust this project/i,
    keys: ["Enter"],
    reason: "Trusting project directory",
  },
  {
    pattern: /Choose the text style|text style that looks best|Dark mode.*Light mode/i,
    keys: ["Enter"],
    reason: "Selecting default theme (dark mode)",
  },
  {
    pattern: /Select login method.*Claude account with subscription/is,
    keys: ["Enter"],
    reason: "Selecting Claude account with subscription login",
  },
  {
    pattern: /Browser didn't open.*Paste code here/is,
    keys: ["Escape"],
    reason: "Dismissing OAuth browser flow (token already cached)",
  },
];

const SYSTEM_PROMPT = `You are monitoring a terminal where Claude Code CLI is starting up.
Check if there is an interactive dialog, prompt, or permission request
blocking Claude from running.

If blocked, respond with the tmux key sequence to accept/proceed.
Always accept permissions, agree to terms, and choose options that
let Claude Code start. Use tmux key names: Down, Up, Enter, Tab,
Space, Escape, y, n, or digits 0-9.

Respond ONLY with JSON (no markdown):
{"blocked": true, "keys": ["Down", "Enter"], "reason": "Accepting bypass permissions"}
or
{"blocked": false}`;

// ============================================================================
// ERROR CLASS
// ============================================================================

/**
 * Error thrown when Claude Code is stuck on an interactive dialog
 * that could not be auto-dismissed.
 */
export class ClaudeDialogError extends Error {
  public readonly capturedOutput: string;

  constructor(message: string, capturedOutput: string) {
    super(message);
    this.name = "ClaudeDialogError";
    this.capturedOutput = capturedOutput;
  }
}

// ============================================================================
// ANTHROPIC CLIENT
// ============================================================================

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ============================================================================
// RESPONSE PARSING
// ============================================================================

interface DialogResponse {
  blocked: boolean;
  keys: string[];
  reason: string;
}

/**
 * Parse and validate a Haiku JSON response for dialog detection.
 * Filters keys to the allowed whitelist and enforces max key count.
 */
export function parseDialogResponse(raw: string): DialogResponse {
  const trimmed = raw.trim();
  const parsed = JSON.parse(trimmed);

  const blocked = Boolean(parsed.blocked);

  if (!blocked) {
    return { blocked: false, keys: [], reason: "" };
  }

  const rawKeys: unknown[] = Array.isArray(parsed.keys) ? parsed.keys : [];
  const keys = rawKeys
    .filter((k): k is string => typeof k === "string" && ALLOWED_KEYS.has(k))
    .slice(0, MAX_KEYS);

  const reason = typeof parsed.reason === "string" ? parsed.reason : "";

  return { blocked, keys, reason };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Check if an interactive dialog is blocking Claude startup in a tmux window,
 * and attempt to dismiss it using Haiku-suggested key sequences.
 *
 * @param windowIndex - The tmux window index to check
 * @throws ClaudeDialogError if the dialog cannot be dismissed after max attempts
 */
export async function handleDialogIfPresent(
  windowIndex: number
): Promise<void> {
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const paneText = await capturePane(windowIndex, 30);

      // Quick-exit: pane is empty or shows normal Claude operation
      if (looksNormal(paneText)) {
        return;
      }

      // Fast path: check known dialog patterns before calling Haiku
      const knownMatch = matchKnownDialog(paneText);
      if (knownMatch) {
        log("info", "Known dialog matched, dismissing without API call", {
          windowIndex,
          attempt,
          reason: knownMatch.reason,
        });
        for (const key of knownMatch.keys) {
          await sendKeys(windowIndex, key);
          await Bun.sleep(KEY_DELAY_MS);
        }
        await Bun.sleep(POST_DISMISS_WAIT_MS);
        continue;
      }

      // Ask Haiku whether the pane shows a blocking dialog
      const response = await askHaiku(paneText);

      if (!response.blocked) {
        return;
      }

      log("info", "Dialog detected in tmux pane", {
        windowIndex,
        attempt,
        reason: response.reason,
        keyCount: response.keys.length,
      });

      if (response.keys.length === 0) {
        log("warn", "Haiku reported blocked but returned no valid keys", {
          windowIndex,
          attempt,
        });
        // Still retry — Haiku may return better keys on next capture
        await Bun.sleep(POST_DISMISS_WAIT_MS);
        continue;
      }

      // Send each key with a small delay
      for (const key of response.keys) {
        await sendKeys(windowIndex, key);
        await Bun.sleep(KEY_DELAY_MS);
      }

      // Wait for the dialog to dismiss
      await Bun.sleep(POST_DISMISS_WAIT_MS);

      // On last attempt, check if still blocked
      if (attempt === MAX_ATTEMPTS) {
        const finalPane = await capturePane(windowIndex, 30);
        if (!looksNormal(finalPane)) {
          const finalCheck = await askHaiku(finalPane);
          if (finalCheck.blocked) {
            throw new ClaudeDialogError(
              `Failed to dismiss interactive dialog after ${MAX_ATTEMPTS} attempts. ` +
                `Last reason: ${response.reason || "unknown"}`,
              finalPane
            );
          }
        }
      }
    }
  } catch (error) {
    // Re-throw ClaudeDialogError as-is
    if (error instanceof ClaudeDialogError) {
      throw error;
    }

    // Swallow other errors (API failures, etc.) — don't block Claude startup
    log("warn", "Dialog handler failed, continuing without dialog check", {
      windowIndex,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if pane text matches a known dialog pattern.
 * Returns the matching entry or null if no match.
 */
function matchKnownDialog(
  paneText: string
): { keys: string[]; reason: string } | null {
  for (const dialog of KNOWN_DIALOGS) {
    if (dialog.pattern.test(paneText)) {
      return { keys: dialog.keys, reason: dialog.reason };
    }
  }
  return null;
}

/**
 * Quick heuristic: does the pane text look like normal Claude operation?
 * Returns true if we should skip the Haiku check entirely.
 */
function looksNormal(paneText: string): boolean {
  const trimmed = paneText.trim();

  // Empty or whitespace-only pane
  if (trimmed.length === 0) {
    return true;
  }

  // Check last few non-empty lines for typical Claude ready indicators
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return true;
  }

  const lastLine = lines[lines.length - 1].trim();

  // Claude REPL prompt ("> " at start of line)
  if (lastLine.startsWith(">") && lastLine.length <= 2) {
    return true;
  }

  // Claude is processing (spinner, thinking, etc.)
  if (
    lastLine.includes("Thinking") ||
    lastLine.includes("⠋") ||
    lastLine.includes("⠙") ||
    lastLine.includes("⠹") ||
    lastLine.includes("⠸") ||
    lastLine.includes("⠼") ||
    lastLine.includes("⠴") ||
    lastLine.includes("⠦") ||
    lastLine.includes("⠧") ||
    lastLine.includes("⠇") ||
    lastLine.includes("⠏")
  ) {
    return true;
  }

  return false;
}

/**
 * Ask Haiku to analyze the pane text and determine if a dialog is blocking.
 */
async function askHaiku(paneText: string): Promise<DialogResponse> {
  const client = getAnthropicClient();

  const message = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: paneText }],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    return { blocked: false, keys: [], reason: "" };
  }

  return parseDialogResponse(content.text);
}
