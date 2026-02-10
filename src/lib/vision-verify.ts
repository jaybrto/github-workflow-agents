/**
 * Vision verification module for conditional anomaly detection.
 * Uses Claude SDK (Sonnet model) to verify screenshots when text heuristics detect issues.
 *
 * Vision API calls are expensive (~$0.003 each). Only calls when:
 * 1. Text heuristics detect an anomaly
 * 2. Screenshot was successfully captured
 * 3. The event is important (question/completion/error)
 */
import Anthropic from "@anthropic-ai/sdk";
import { withSpan, log, Metrics, meter } from "./telemetry.js";

// ============================================================================
// TYPES
// ============================================================================

export interface VerificationOptions {
  /** Plain text from tmux capture */
  textCapture: string;
  /** Expected state to verify against */
  expectedState: "question" | "thinking" | "complete" | "error";
  /** Screenshot buffer (only needed if verification triggers) */
  screenshot?: Buffer;
}

export interface VerificationResult {
  /** Whether the state was verified as expected */
  verified: boolean;
  /** Confidence level 0-100 */
  confidence: number;
  /** List of detected issues */
  issues?: string[];
  /** Whether the Vision API was called */
  usedVision: boolean;
}

// ============================================================================
// METRICS
// ============================================================================

const visionApiCallCounter = meter.createCounter("gwa_vision_api_calls_total", {
  description: "Total Vision API calls for verification",
  unit: "1",
});

const visionApiDurationHistogram = meter.createHistogram("gwa_vision_api_duration_seconds", {
  description: "Vision API call duration",
  unit: "s",
});

const anomalyDetectionCounter = meter.createCounter("gwa_anomaly_detections_total", {
  description: "Total anomaly detections by heuristics",
  unit: "1",
});

// ============================================================================
// HEURISTICS
// ============================================================================

/**
 * Quick text-based heuristics to detect anomalies.
 * Returns array of detected issues (empty if none).
 */
export function detectAnomalies(text: string, expectedState: string): string[] {
  const issues: string[] = [];
  const lowerText = text.toLowerCase();

  // Check for empty or too short output
  if (!text || text.trim().length < 10) {
    issues.push("Output is empty or too short");
    return issues; // Skip other checks if output is minimal
  }

  // Expected 'question' but no question mark found
  if (expectedState === "question" && !text.includes("?")) {
    issues.push("Expected question state but no '?' found in output");
  }

  // Expected 'complete' but found error indicators
  if (expectedState === "complete") {
    const errorPatterns = ["error", "failed", "failure", "exception", "traceback"];
    for (const pattern of errorPatterns) {
      if (lowerText.includes(pattern)) {
        issues.push(`Expected complete state but found '${pattern}' in output`);
        break;
      }
    }
  }

  // Expected 'error' but found success indicators
  if (expectedState === "error") {
    const successPatterns = ["success", "completed successfully", "done", "finished"];
    for (const pattern of successPatterns) {
      if (lowerText.includes(pattern)) {
        issues.push(`Expected error state but found '${pattern}' in output`);
        break;
      }
    }
  }

  // Unexpected critical patterns regardless of expected state
  const criticalPatterns = [
    { pattern: "panic", message: "Found 'panic' in output" },
    { pattern: "fatal", message: "Found 'fatal' in output" },
    { pattern: "sigkill", message: "Found 'SIGKILL' in output" },
    { pattern: "segmentation fault", message: "Found segmentation fault in output" },
    { pattern: "out of memory", message: "Found out of memory error" },
    { pattern: "killed", message: "Process may have been killed" },
  ];

  for (const { pattern, message } of criticalPatterns) {
    if (lowerText.includes(pattern)) {
      issues.push(message);
    }
  }

  return issues;
}

// ============================================================================
// VISION VERIFICATION
// ============================================================================

/**
 * Verify terminal state using Vision API.
 * Only called when anomalies are detected and screenshot is available.
 */
async function verifyWithVision(
  screenshot: Buffer,
  expectedState: string
): Promise<{ verified: boolean; confidence: number; explanation?: string }> {
  const client = new Anthropic();
  const startTime = Date.now();

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshot.toString("base64"),
              },
            },
            {
              type: "text",
              text: `Does this terminal screenshot show a '${expectedState}' state? Answer YES or NO, then briefly explain any issues.`,
            },
          ],
        },
      ],
    });

    const durationMs = Date.now() - startTime;
    visionApiDurationHistogram.record(durationMs / 1000, { expected_state: expectedState });

    // Parse response
    const textBlock = response.content.find((block) => block.type === "text");
    const responseText = textBlock && textBlock.type === "text" ? textBlock.text : "";

    const upperResponse = responseText.toUpperCase();
    const verified = upperResponse.startsWith("YES");

    // Estimate confidence based on response clarity
    let confidence = 70; // Base confidence for API response
    if (upperResponse.startsWith("YES") || upperResponse.startsWith("NO")) {
      confidence = 85; // Clear yes/no answer
    }
    if (responseText.length > 50) {
      confidence += 10; // Detailed explanation suggests careful analysis
    }

    log("info", "Vision verification completed", {
      expected_state: expectedState,
      verified,
      confidence,
      duration_ms: durationMs,
    });

    return {
      verified,
      confidence: Math.min(confidence, 100),
      explanation: responseText,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    visionApiDurationHistogram.record(durationMs / 1000, {
      expected_state: expectedState,
      error: "true",
    });

    log("error", "Vision API call failed", {
      error: error instanceof Error ? error.message : String(error),
      expected_state: expectedState,
    });

    // Return unverified with low confidence on API error
    return {
      verified: false,
      confidence: 20,
      explanation: `Vision API error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// MAIN VERIFICATION FUNCTION
// ============================================================================

/**
 * Verify terminal state, using Vision API only when text heuristics detect anomalies.
 * This is the main entry point for verification.
 */
export async function verifyIfNeeded(options: VerificationOptions): Promise<VerificationResult> {
  const { textCapture, expectedState, screenshot } = options;

  return withSpan(
    "vision.verify",
    async (span) => {
      span.setAttribute("vision.expected_state", expectedState);
      span.setAttribute("vision.text_length", textCapture.length);
      span.setAttribute("vision.has_screenshot", !!screenshot);

      // Run text heuristics first
      const anomalies = detectAnomalies(textCapture, expectedState);
      span.setAttribute("vision.anomaly_count", anomalies.length);

      if (anomalies.length > 0) {
        anomalyDetectionCounter.add(1, { expected_state: expectedState });

        log("info", "Anomalies detected by heuristics", {
          expected_state: expectedState,
          anomaly_count: anomalies.length,
          anomalies: anomalies.join("; "),
        });
      }

      // If no anomalies, return immediately without API call
      if (anomalies.length === 0) {
        log("debug", "No anomalies detected, skipping vision verification", {
          expected_state: expectedState,
        });

        return {
          verified: true,
          confidence: 90, // High confidence when heuristics pass
          usedVision: false,
        };
      }

      // Anomalies detected but no screenshot available
      if (!screenshot) {
        log("warn", "Anomalies detected but no screenshot available", {
          expected_state: expectedState,
          anomalies: anomalies.join("; "),
        });

        return {
          verified: false,
          confidence: 40, // Lower confidence without visual confirmation
          issues: anomalies,
          usedVision: false,
        };
      }

      // Use Vision API to verify
      visionApiCallCounter.add(1, { expected_state: expectedState });
      span.setAttribute("vision.api_called", true);

      const visionResult = await verifyWithVision(screenshot, expectedState);

      span.setAttribute("vision.verified", visionResult.verified);
      span.setAttribute("vision.confidence", visionResult.confidence);

      // Combine heuristic anomalies with vision explanation
      const allIssues = [...anomalies];
      if (visionResult.explanation && !visionResult.verified) {
        allIssues.push(`Vision: ${visionResult.explanation}`);
      }

      return {
        verified: visionResult.verified,
        confidence: visionResult.confidence,
        issues: allIssues.length > 0 ? allIssues : undefined,
        usedVision: true,
      };
    },
    {
      attributes: {
        "vision.text_preview": textCapture.substring(0, 100),
      },
    }
  );
}
