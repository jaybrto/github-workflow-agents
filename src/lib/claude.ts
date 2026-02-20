import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import type { ClaudeStreamEvent } from "./types.js";
import { withSpan, Metrics, log } from "./telemetry.js";
import { syncConfigFromCredentials, getAccessToken } from "./credentials-manager.js";

// ============================================================================
// AUTH FAILURE DETECTION
// ============================================================================

/** Patterns that indicate Claude is stuck on the authentication/login screen */
const AUTH_FAILURE_PATTERNS = [
  "choose how to authenticate",
  "sign in at",
  "/oauth/authorize",
  "enter api key",
  "login required",
  "not authenticated",
  "authentication required",
  "authenticate with",
  "sign in to",
  "oauth.anthropic.com",
  "anthropic login",
  "max plan",
  "usage limit",
  "you need to login",
  "please authenticate",
];

/**
 * Error thrown when Claude Code is stuck on the auth/login screen.
 */
export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

/**
 * Check if output text contains patterns indicating Claude is stuck
 * on the login/authentication screen.
 */
export function detectAuthFailure(output: string): boolean {
  const lower = output.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Pre-flight check: verify Claude auth environment variables are configured.
 * Does NOT make API calls — just checks env vars exist.
 */
export function checkAuthEnvironment(): { ok: boolean; error?: string } {
  const hasOAuth = !!getAccessToken();
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  if (!hasOAuth && !hasApiKey) {
    return {
      ok: false,
      error: "No Claude credentials found (no CLAUDE_CODE_OAUTH_TOKEN, no on-disk credentials, no ANTHROPIC_API_KEY)",
    };
  }

  return { ok: true };
}

// ============================================================================
// CONFIG PRE-LOADING
// ============================================================================

/**
 * Pre-load Claude Code CLI configuration to prevent first-run interactive dialogs.
 * Writes credentials and settings files so Claude starts without prompting.
 *
 * Safe to call multiple times — merges into existing settings and only
 * writes credentials if the env var is set and file doesn't exist.
 */
export function preloadClaudeConfig(): void {
  const home = process.env.HOME;
  if (!home) {
    log("warn", "HOME not set, skipping Claude config pre-load");
    return;
  }

  const claudeDir = join(home, ".claude");

  // Ensure ~/.claude/ exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // 1. Write credentials + account info from env vars
  const credentialsPath = join(claudeDir, ".credentials.json");
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  if (oauthToken) {
    let existingCreds: Record<string, unknown> = {};
    if (existsSync(credentialsPath)) {
      try {
        existingCreds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
      } catch {
        // Corrupted file, overwrite
      }
    }

    // If real OAuth credentials exist (claudeAiOauth format from TUI login),
    // don't overwrite — the real credentials have refresh token and expiry info.
    // Just sync the ephemeral config from the existing credentials.
    if (existingCreds.claudeAiOauth) {
      log("info", "Real OAuth credentials present, skipping env-var overwrite", {
        path: credentialsPath,
      });
      syncConfigFromCredentials();
    } else {
      // Write claudeAiOauth format (required by Claude Code 2.1.45+ TUI).
      // The old `oauthToken` top-level field only works in --print (headless) mode.
      // For new pods without real credentials yet, write the minimal structure so
      // the TUI can start. expiresAt = now + 8h (typical access token lifetime).
      const eightHoursMs = 8 * 60 * 60 * 1000;
      const newCreds: Record<string, unknown> = {
        claudeAiOauth: {
          accessToken: oauthToken,
          expiresAt: Date.now() + eightHoursMs,
        },
      };

      // Set oauthAccount from env vars (prevents account selection dialog)
      const accountUuid = process.env.CLAUDE_OAUTH_ACCOUNT_UUID;
      if (accountUuid) {
        newCreds.oauthAccount = {
          accountUuid,
          emailAddress: process.env.CLAUDE_OAUTH_EMAIL || "",
          organizationUuid: process.env.CLAUDE_OAUTH_ORG_UUID || "",
          hasExtraUsageEnabled: process.env.CLAUDE_OAUTH_EXTRA_USAGE !== "false",
          billingType: process.env.CLAUDE_OAUTH_BILLING_TYPE || "stripe_subscription",
          displayName: process.env.CLAUDE_OAUTH_DISPLAY_NAME || "GWA",
        };
      }

      writeFileSync(
        credentialsPath,
        JSON.stringify(newCreds, null, 2),
        { mode: 0o600 }
      );
      log("info", "Wrote claudeAiOauth credentials file for new pod", { path: credentialsPath });

      // Sync ephemeral ~/.config/claude/config.json from the credentials we just wrote
      syncConfigFromCredentials();
    }
  }

  // 2. Merge headless settings into settings.json
  const settingsPath = join(claudeDir, "settings.json");
  const headlessSettings: Record<string, unknown> = {
    // Skip the "Bypass Permissions" confirmation dialog
    skipDangerousModePermissionPrompt: true,
    // Set default theme to avoid theme selection prompt
    theme: "dark",
    // Disable auto-updates to avoid update prompts
    hasCompletedOnboarding: true,
  };

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      log("warn", "Failed to parse existing settings.json, overwriting");
    }
  }

  // Only write if any key is missing
  let needsWrite = false;
  for (const [key, value] of Object.entries(headlessSettings)) {
    if (!(key in existing)) {
      existing[key] = value;
      needsWrite = true;
    }
  }

  if (needsWrite) {
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2), {
      mode: 0o600,
    });
    log("info", "Updated Claude settings.json with headless defaults", {
      path: settingsPath,
    });
  }
}

// ============================================================================
// CLAUDE OPTIONS & RESULT
// ============================================================================

export interface ClaudeOptions {
  prompt: string;
  workingDir: string;
  continueSession?: boolean;
  timeout?: number;
}

export interface ClaudeResult {
  success: boolean;
  output: string;
  askedQuestion?: string;
  error?: string;
}

/**
 * Run Claude Code CLI and stream JSON events.
 * Returns when Claude completes or asks a question.
 */
export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, workingDir, continueSession = false, timeout = 3600000 } = options;
  const startTime = Date.now();

  return withSpan(
    "claude.run",
    async (span) => {
      // Set span attributes
      span.setAttribute("claude.prompt_length", prompt.length);
      span.setAttribute("claude.working_dir", workingDir);
      span.setAttribute("claude.continue_session", continueSession);
      span.setAttribute("claude.timeout_ms", timeout);
      span.setAttribute("claude.model", "opus");
      span.setAttribute("claude.fallback_model", "sonnet");

      log("info", "Starting Claude invocation", {
        prompt_length: prompt.length,
        continue_session: continueSession,
        working_dir: workingDir,
      });

      const result = await runClaudeInternal(options);

      // Calculate duration and record metrics
      const durationMs = Date.now() - startTime;
      const outcome = result.askedQuestion
        ? "question"
        : result.success
          ? "success"
          : result.error?.includes("timeout")
            ? "timeout"
            : "error";

      span.setAttribute("claude.outcome", outcome);
      span.setAttribute("claude.duration_ms", durationMs);
      span.setAttribute("claude.output_length", result.output.length);
      if (result.askedQuestion) {
        span.setAttribute("claude.asked_question", true);
      }
      if (result.error) {
        span.setAttribute("claude.error", result.error);
      }

      // Record metrics
      Metrics.recordClaudeInvocation(outcome, continueSession);
      Metrics.recordClaudeDuration(durationMs, outcome);

      log("info", "Claude invocation completed", {
        outcome,
        duration_ms: durationMs,
        output_length: result.output.length,
        asked_question: !!result.askedQuestion,
      });

      return result;
    },
    {
      attributes: {
        "claude.prompt_preview": prompt.substring(0, 100),
      },
    }
  );
}

/**
 * Internal implementation of runClaude without instrumentation.
 */
async function runClaudeInternal(options: ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, workingDir, continueSession = false, timeout = 3600000 } = options;

  // Ensure config is pre-loaded before spawning Claude
  preloadClaudeConfig();

  const args: string[] = [];

  // Prompt is a positional argument (must come first or after flags)
  args.push(prompt);

  // Add output flags (stream-json requires --verbose with --print)
  args.push("--print", "--verbose", "--output-format", "stream-json");

  // Model selection: prefer Opus, fall back to Sonnet
  args.push("--model", "opus", "--fallback-model", "sonnet");

  // Skip permission prompts in headless mode
  args.push("--dangerously-skip-permissions");

  if (continueSession) {
    args.push("--continue");
  }

  // SECURITY: Whitelist only required environment variables instead of passing all
  // This prevents accidental leakage of sensitive env vars to subprocess
  const safeEnv: Record<string, string | undefined> = {
    // Required for Claude operation
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    TERM: process.env.TERM || "xterm-256color",
    // Claude authentication (required)
    // Read token from disk at spawn time — env var may be stale after credential refresh
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: getAccessToken(),
    // Git operations
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
    // Node/Bun runtime
    NODE_ENV: process.env.NODE_ENV,
    // Telemetry (if configured)
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // Headless mode indicator
    CI: "true",
  };

  const proc = Bun.spawn(["claude", ...args], {
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
    env: safeEnv,
  });

  const outputChunks: string[] = [];
  let askedQuestion: string | undefined;
  let lastError: string | undefined;

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Claude timeout")), timeout);
  });

  try {
    await Promise.race([
      (async () => {
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete JSON lines
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const event = JSON.parse(line) as ClaudeStreamEvent;
              const processed = processEvent(event, outputChunks);

              if (processed.question) {
                askedQuestion = processed.question;
              }
              if (processed.error) {
                lastError = processed.error;
              }
            } catch {
              // Not valid JSON, might be partial line
              outputChunks.push(line);
            }
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "Claude timeout") {
      proc.kill();
      return {
        success: false,
        output: outputChunks.join("\n"),
        error: "Claude timed out after " + (timeout / 1000) + " seconds",
      };
    }
    throw error;
  }

  const exitCode = await proc.exited;

  // Read any stderr
  const stderrReader = proc.stderr.getReader();
  const stderrChunks: string[] = [];
  while (true) {
    const { done, value } = await stderrReader.read();
    if (done) break;
    stderrChunks.push(decoder.decode(value));
  }
  const stderr = stderrChunks.join("");

  // Check for auth failure in output or stderr
  const combinedForAuthCheck = outputChunks.join("\n") + "\n" + stderr;
  if (detectAuthFailure(combinedForAuthCheck)) {
    return {
      success: false,
      output: outputChunks.join("\n"),
      error: `Claude authentication failed — pod is stuck on login screen. CLAUDE_CODE_OAUTH_TOKEN may be expired or invalid. Details: ${(lastError || stderr).slice(0, 500)}`,
    };
  }

  if (exitCode !== 0 && !askedQuestion) {
    return {
      success: false,
      output: outputChunks.join("\n"),
      error: lastError || stderr || `Claude exited with code ${exitCode}`,
    };
  }

  return {
    success: !askedQuestion,
    output: outputChunks.join("\n"),
    askedQuestion,
  };
}

function processEvent(
  event: ClaudeStreamEvent,
  outputChunks: string[]
): { question?: string; error?: string } {
  switch (event.type) {
    case "assistant":
      if (event.subtype === "text" && event.content) {
        outputChunks.push(event.content);
      }
      break;

    case "result":
      if (event.subtype === "success") {
        outputChunks.push("[Completed]");
      } else if (event.subtype === "error") {
        return { error: event.error || "Unknown error" };
      }
      break;

    case "tool_use":
      if (event.tool_name === "ask_user" && event.tool_input) {
        const input = event.tool_input as { question?: string };
        if (input.question) {
          return { question: input.question };
        }
      }
      outputChunks.push(`[Tool: ${event.tool_name}]`);
      break;

    case "tool_result":
      // Tool completed
      break;

    default:
      // Unknown event type, ignore
      break;
  }

  return {};
}

/**
 * Continue a Claude session with user-provided input.
 */
export async function continueWithAnswer(
  workingDir: string,
  answer: string
): Promise<ClaudeResult> {
  return runClaude({
    prompt: `User answered: ${answer}. Continue working.`,
    workingDir,
    continueSession: true,
  });
}
