import type { ClaudeStreamEvent } from "./types.js";

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

  const args: string[] = [];

  // Prompt is a positional argument (must come first or after flags)
  args.push(prompt);

  // Add output flags
  args.push("--print", "--output-format", "stream-json");

  if (continueSession) {
    args.push("--continue");
  }

  const proc = Bun.spawn(["claude", ...args], {
    cwd: workingDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Ensure Claude doesn't try to use interactive features
      CI: "true",
    },
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
