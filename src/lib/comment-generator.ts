/**
 * Smart GitHub comment generation for PR updates.
 * Uses Claude Haiku for summarizing headless completions.
 */
import Anthropic from "@anthropic-ai/sdk";
import { withSpan, log } from "./telemetry.js";

// ============================================================================
// TYPES
// ============================================================================

export interface REPLStartInput {
  type: "repl_start";
  sessionId: string;
  kubectlAttachCommand: string;
  tmuxAttachCommand: string;
  prNumber?: number; // Optional for issue planning (before PR created)
  trigger: string;
}

export interface HeadlessCompleteInput {
  type: "headless_complete";
  output: string;
  prNumber: number;
  trigger: string;
}

export interface ErrorInput {
  type: "error";
  error: string;
  context?: string;
  prNumber: number;
}

export interface QuestionInput {
  type: "question";
  question: string;
  prNumber: number;
}

// Phase 15 (v3.4) - Progress comment type
export interface ProgressInput {
  type: "progress";
  sessionId: string;
  message: string;
  subAgents?: string[];
  currentTask?: string;
  tasksCompleted?: number;
  tasksTotal?: number;
}

export type CommentInput =
  | REPLStartInput
  | HeadlessCompleteInput
  | ErrorInput
  | QuestionInput
  | ProgressInput;

export interface GeneratedComment {
  body: string;
  usedAI: boolean;
}

// ============================================================================
// ANTHROPIC CLIENT
// ============================================================================

// Lazy initialization to avoid issues when ANTHROPIC_API_KEY isn't set
let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ============================================================================
// TEMPLATES
// ============================================================================

function generateREPLStartComment(input: REPLStartInput): string {
  return `🤖 **Claude is working on this PR**

| Detail | Value |
|--------|-------|
| Session ID | \`${input.sessionId}\` |
| Mode | Interactive REPL |

**To attach and watch Claude work:**
\`\`\`bash
${input.kubectlAttachCommand}
\`\`\`

Claude will post updates as it works. If it needs input, it will ask here.`;
}

function generateErrorComment(input: ErrorInput): string {
  let comment = `❌ **Claude encountered an error**

**Error:** ${input.error}`;

  if (input.context) {
    comment += `

${input.context}`;
  }

  comment += `

You can try:
- Re-triggering the workflow
- Commenting \`@claude\` to start a new session`;

  return comment;
}

function generateQuestionComment(input: QuestionInput): string {
  return `❓ **Claude has a question**

${input.question}

Reply with \`@claude-answer: your answer here\` to continue.`;
}

// Phase 15 (v3.4) - Progress comment generation
function generateProgressComment(input: ProgressInput): string {
  let comment = `🔄 **Progress Update**\n\n${input.message}\n`;

  if (input.subAgents?.length) {
    comment += `\n**Active Agents:** ${input.subAgents.join(", ")}\n`;
  }

  if (input.currentTask) {
    comment += `\n**Current Task:** ${input.currentTask}\n`;
  }

  if (input.tasksTotal !== undefined && input.tasksTotal > 0) {
    const completed = input.tasksCompleted || 0;
    const pct = Math.round((completed / input.tasksTotal) * 100);
    const progressBar = "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));
    comment += `\n**Progress:** ${progressBar} ${completed}/${input.tasksTotal} tasks (${pct}%)\n`;
  }

  return comment;
}

function truncateOutput(output: string, maxLength: number = 1000): string {
  if (output.length <= maxLength) {
    return output;
  }
  return output.substring(0, maxLength) + "... (truncated)";
}

function generateFallbackCompleteComment(input: HeadlessCompleteInput): string {
  return `✅ **Claude completed work on this PR**

<details>
<summary>Output</summary>

\`\`\`
${truncateOutput(input.output, 2000)}
\`\`\`

</details>`;
}

// ============================================================================
// AI SUMMARIZATION
// ============================================================================

async function summarizeWithHaiku(output: string): Promise<string | null> {
  return withSpan(
    "comment.summarize_with_haiku",
    async (span) => {
      span.setAttribute("comment.output_length", output.length);

      try {
        const client = getAnthropicClient();

        // Truncate very long outputs to avoid context limits
        const truncatedOutput =
          output.length > 10000 ? output.substring(0, 10000) + "..." : output;

        const response = await client.messages.create({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 300,
          messages: [
            {
              role: "user",
              content: `You are summarizing what Claude (an AI coding assistant) did while working on a GitHub PR. Summarize the following output in 2-3 concise sentences. Focus on what actions were taken and the outcome. Be direct and use past tense.

Output to summarize:
${truncatedOutput}`,
            },
          ],
        });

        // Extract text from the response
        const textBlock = response.content.find(
          (block) => block.type === "text"
        );
        if (textBlock && textBlock.type === "text") {
          span.setAttribute("comment.summary_length", textBlock.text.length);
          log("debug", "Haiku summarization successful", {
            output_length: output.length,
            summary_length: textBlock.text.length,
          });
          return textBlock.text;
        }

        log("warn", "Haiku response did not contain text block");
        return null;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        span.setAttribute("comment.summarize_error", errorMessage);
        log("warn", "Failed to summarize with Haiku, using fallback", {
          error: errorMessage,
        });
        return null;
      }
    },
    {
      attributes: {
        "comment.model": "claude-3-5-haiku-20241022",
      },
    }
  );
}

async function generateHeadlessCompleteComment(
  input: HeadlessCompleteInput
): Promise<GeneratedComment> {
  // Try to get an AI summary
  const summary = await summarizeWithHaiku(input.output);

  if (summary) {
    return {
      body: `✅ **Claude completed work on this PR**

${summary}

<details>
<summary>Full output</summary>

\`\`\`
${truncateOutput(input.output, 2000)}
\`\`\`

</details>`,
      usedAI: true,
    };
  }

  // Fallback to simple template
  return {
    body: generateFallbackCompleteComment(input),
    usedAI: false,
  };
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Generate a GitHub comment based on the input type.
 * Uses templates for most cases, AI summarization for headless completions.
 */
export async function generateComment(
  input: CommentInput
): Promise<GeneratedComment> {
  return withSpan(
    "comment.generate",
    async (span) => {
      span.setAttribute("comment.type", input.type);
      if ("prNumber" in input && input.prNumber !== undefined) {
        span.setAttribute("comment.pr_number", input.prNumber);
      }

      log("debug", "Generating comment", {
        type: input.type,
        ...("prNumber" in input && input.prNumber !== undefined
          ? { pr_number: input.prNumber }
          : {}),
      });

      switch (input.type) {
        case "repl_start":
          span.setAttribute("comment.trigger", input.trigger);
          return {
            body: generateREPLStartComment(input),
            usedAI: false,
          };

        case "headless_complete":
          span.setAttribute("comment.trigger", input.trigger);
          span.setAttribute("comment.output_length", input.output.length);
          return generateHeadlessCompleteComment(input);

        case "error":
          span.setAttribute("comment.has_context", !!input.context);
          return {
            body: generateErrorComment(input),
            usedAI: false,
          };

        case "question":
          return {
            body: generateQuestionComment(input),
            usedAI: false,
          };

        case "progress":
          span.setAttribute("comment.session_id", input.sessionId);
          if (input.currentTask) {
            span.setAttribute("comment.current_task", input.currentTask);
          }
          return {
            body: generateProgressComment(input),
            usedAI: false,
          };

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = input;
          throw new Error(`Unknown comment type: ${(_exhaustive as CommentInput).type}`);
        }
      }
    },
    {
      attributes: {
        "comment.type": input.type,
        ...("prNumber" in input && input.prNumber !== undefined
          ? { "comment.pr_number": input.prNumber }
          : {}),
      },
    }
  );
}
