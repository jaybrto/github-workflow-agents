import Anthropic from "@anthropic-ai/sdk";
import { withSpan, log } from "./telemetry.js";

// ============================================================================
// TYPES
// ============================================================================

export interface AnalysisInput {
  trigger: "pr_event" | "comment" | "manual";
  prTitle?: string;
  prBody?: string;
  commentBody?: string;
  diffStats?: { additions: number; deletions: number; changedFiles: number };
}

export interface AnalysisResult {
  mode: "repl" | "headless";
  reasoning: string;
  confidence: number; // 0-100
}

// ============================================================================
// HEURISTICS
// ============================================================================

/**
 * Quick heuristic checks to avoid API calls for obvious cases.
 * Returns null if inconclusive (needs Claude analysis).
 */
export function quickHeuristics(input: AnalysisInput): AnalysisResult | null {
  const { trigger, prTitle, commentBody, diffStats } = input;

  // Manual triggers are deliberate human choice -> REPL
  if (trigger === "manual") {
    return {
      mode: "repl",
      reasoning: "Manual trigger indicates deliberate human choice for interactive session",
      confidence: 95,
    };
  }

  // Large diffs are complex -> REPL
  if (diffStats) {
    const totalChanges = diffStats.additions + diffStats.deletions;
    if (totalChanges > 500 || diffStats.changedFiles > 10) {
      return {
        mode: "repl",
        reasoning: `Large diff (${totalChanges} lines, ${diffStats.changedFiles} files) requires interactive session`,
        confidence: 90,
      };
    }
  }

  // Simple PR title patterns -> Headless
  const titleLower = prTitle?.toLowerCase() || "";
  const simplePatterns = [
    "fix typo",
    "typo fix",
    "update readme",
    "readme update",
    "docs:",
    "chore:",
    "bump version",
    "version bump",
    "fix lint",
    "lint fix",
    "formatting",
    "whitespace",
  ];

  for (const pattern of simplePatterns) {
    if (titleLower.includes(pattern)) {
      return {
        mode: "headless",
        reasoning: `PR title "${prTitle}" matches simple task pattern`,
        confidence: 85,
      };
    }
  }

  // Comment with specific instructions -> Headless
  if (commentBody) {
    const commentLower = commentBody.toLowerCase();

    // Patterns like "change X to Y", "rename X to Y", "replace X with Y"
    const specificInstructionPatterns = [
      /change\s+["']?[\w.-]+["']?\s+to\s+["']?[\w.-]+["']?/i,
      /rename\s+["']?[\w.-]+["']?\s+to\s+["']?[\w.-]+["']?/i,
      /replace\s+["']?[\w.-]+["']?\s+with\s+["']?[\w.-]+["']?/i,
      /update\s+["']?[\w.-]+["']?\s+to\s+["']?[\w.-]+["']?/i,
      /set\s+["']?[\w.-]+["']?\s+to\s+["']?[\w.-]+["']?/i,
    ];

    for (const pattern of specificInstructionPatterns) {
      if (pattern.test(commentBody)) {
        return {
          mode: "headless",
          reasoning: "Comment contains specific, targeted instructions",
          confidence: 80,
        };
      }
    }

    // Explicit mode requests in comments
    if (
      commentLower.includes("quick fix") ||
      commentLower.includes("simple change") ||
      commentLower.includes("just update")
    ) {
      return {
        mode: "headless",
        reasoning: "Comment indicates a simple, quick task",
        confidence: 75,
      };
    }

    // Complex task indicators -> REPL
    const complexIndicators = [
      "refactor",
      "implement",
      "feature",
      "review",
      "investigate",
      "debug",
      "analyze",
      "redesign",
      "architect",
      "migrate",
    ];

    for (const indicator of complexIndicators) {
      if (commentLower.includes(indicator)) {
        return {
          mode: "repl",
          reasoning: `Comment contains complex task indicator: "${indicator}"`,
          confidence: 80,
        };
      }
    }
  }

  // Inconclusive - needs Claude analysis
  return null;
}

// ============================================================================
// CLAUDE ANALYSIS
// ============================================================================

let anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    // Uses ANTHROPIC_API_KEY env var by default
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

const ANALYSIS_PROMPT = `You are a task complexity analyzer for a GitHub automation system.
Analyze the following task and determine whether it should be handled in:
- "repl" mode: Interactive session for complex tasks (new features, PR reviews, refactoring, unclear requirements)
- "headless" mode: Quick automated execution for simple tasks (docs updates, single-file fixes, clear instructions)

Respond with ONLY a JSON object (no markdown, no explanation):
{"mode": "repl" or "headless", "reasoning": "brief explanation", "confidence": 0-100}`;

/**
 * Use Claude to analyze task complexity when heuristics are inconclusive.
 */
async function analyzeWithClaude(input: AnalysisInput): Promise<AnalysisResult> {
  const client = getAnthropicClient();

  // Build context for analysis
  const contextParts: string[] = [];

  if (input.prTitle) {
    contextParts.push(`PR Title: ${input.prTitle}`);
  }
  if (input.prBody) {
    // Truncate long PR bodies
    const bodyPreview = input.prBody.length > 500 ? input.prBody.slice(0, 500) + "..." : input.prBody;
    contextParts.push(`PR Description: ${bodyPreview}`);
  }
  if (input.commentBody) {
    contextParts.push(`User Comment: ${input.commentBody}`);
  }
  if (input.diffStats) {
    contextParts.push(
      `Diff Stats: ${input.diffStats.additions} additions, ${input.diffStats.deletions} deletions, ${input.diffStats.changedFiles} files changed`
    );
  }
  contextParts.push(`Trigger: ${input.trigger}`);

  const userMessage = contextParts.join("\n\n");

  log("debug", "Calling Claude for task analysis", {
    input_length: userMessage.length,
    trigger: input.trigger,
  });

  const response = await client.messages.create({
    model: "claude-3-5-haiku-20241022",
    max_tokens: 150,
    messages: [
      {
        role: "user",
        content: `${ANALYSIS_PROMPT}\n\nTask to analyze:\n${userMessage}`,
      },
    ],
  });

  // Extract text from response
  const textContent = response.content.find((block) => block.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude");
  }

  // Parse JSON response
  const result = JSON.parse(textContent.text) as AnalysisResult;

  // Validate response
  if (!["repl", "headless"].includes(result.mode)) {
    throw new Error(`Invalid mode in response: ${result.mode}`);
  }
  if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 100) {
    throw new Error(`Invalid confidence in response: ${result.confidence}`);
  }

  return result;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Analyze task complexity to determine execution mode.
 * Uses quick heuristics first, falls back to Claude API if inconclusive.
 * Defaults to REPL mode on errors (safer for complex tasks).
 */
export async function analyzeTaskComplexity(input: AnalysisInput): Promise<AnalysisResult> {
  return withSpan(
    "task-analyzer.analyze",
    async (span) => {
      span.setAttribute("task.trigger", input.trigger);
      if (input.prTitle) {
        span.setAttribute("task.pr_title", input.prTitle);
      }
      if (input.diffStats) {
        span.setAttribute("task.diff_additions", input.diffStats.additions);
        span.setAttribute("task.diff_deletions", input.diffStats.deletions);
        span.setAttribute("task.diff_files", input.diffStats.changedFiles);
      }

      // Try heuristics first
      const heuristicResult = quickHeuristics(input);

      if (heuristicResult) {
        log("info", "Task complexity determined by heuristics", {
          mode: heuristicResult.mode,
          reasoning: heuristicResult.reasoning,
          confidence: heuristicResult.confidence,
        });

        span.setAttribute("task.analysis_method", "heuristics");
        span.setAttribute("task.mode", heuristicResult.mode);
        span.setAttribute("task.confidence", heuristicResult.confidence);

        return heuristicResult;
      }

      // Heuristics inconclusive, use Claude
      try {
        const claudeResult = await analyzeWithClaude(input);

        log("info", "Task complexity determined by Claude analysis", {
          mode: claudeResult.mode,
          reasoning: claudeResult.reasoning,
          confidence: claudeResult.confidence,
        });

        span.setAttribute("task.analysis_method", "claude");
        span.setAttribute("task.mode", claudeResult.mode);
        span.setAttribute("task.confidence", claudeResult.confidence);

        return claudeResult;
      } catch (error) {
        // Default to REPL on error (safer for complex tasks)
        log("warn", "Claude analysis failed, defaulting to REPL mode", {
          error: error instanceof Error ? error.message : String(error),
        });

        span.setAttribute("task.analysis_method", "default");
        span.setAttribute("task.analysis_error", error instanceof Error ? error.message : String(error));
        span.setAttribute("task.mode", "repl");
        span.setAttribute("task.confidence", 50);

        return {
          mode: "repl",
          reasoning: "Analysis failed, defaulting to interactive mode for safety",
          confidence: 50,
        };
      }
    },
    {
      attributes: {
        "task.has_pr_title": !!input.prTitle,
        "task.has_pr_body": !!input.prBody,
        "task.has_comment": !!input.commentBody,
        "task.has_diff_stats": !!input.diffStats,
      },
    }
  );
}
