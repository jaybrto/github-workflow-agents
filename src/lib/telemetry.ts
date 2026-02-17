/**
 * OpenTelemetry instrumentation for GitHub Workflow Agents.
 * MUST be imported FIRST before any other modules in entry points.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  trace,
  metrics,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Meter,
} from "@opentelemetry/api";

// Auto-instrumentation for libraries
// NOTE: Only ioredis works with Bun. HTTP/fetch instrumentation doesn't work because:
// - @opentelemetry/instrumentation-http: Patches Node's http module (Bun doesn't use it)
// - @opentelemetry/instrumentation-fetch: Browser only
// - @opentelemetry/instrumentation-undici: Node's undici (Bun has native fetch)
// For HTTP clients (octokit, k8s), use manual withSpan() wrappers in those modules.
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";

// Service identity from env vars
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "github-workflow-agents";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "1.0.0";
const DEPLOYMENT_ENV = process.env.DEPLOYMENT_ENVIRONMENT || "production";

// Resource attributes
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  "deployment.environment": DEPLOYMENT_ENV,
  "service.namespace": "gwa",
  "team": "platform",
  "pod.name": process.env.POD_NAME || "unknown",
});

// OTLP endpoints from environment
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
// HTTP endpoint for logs (use 4318 for HTTP OTLP)
const OTLP_HTTP_ENDPOINT = OTLP_ENDPOINT.replace(":4317", ":4318");

// Create exporters with explicit endpoint configuration
const traceExporter = new OTLPTraceExporter({ url: OTLP_ENDPOINT });
const metricExporter = new OTLPMetricExporter({ url: OTLP_ENDPOINT });
// Use HTTP exporter for logs (more reliable for short-lived CLI processes)
// The exporter automatically appends /v1/logs to the endpoint
const logExporter = new OTLPLogExporter({ url: OTLP_HTTP_ENDPOINT });

// Configure LoggerProvider for OTLP log export
// Using SimpleLogRecordProcessor for immediate export (critical for CLI processes)
const logRecordProcessor = new SimpleLogRecordProcessor(logExporter);

// Configure SDK with fast export for CLI processes (including logs)
const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 5000, // Fast export for short-lived CLI
  }),
  logRecordProcessors: [logRecordProcessor],
  // Auto-instrumentation (only ioredis works with Bun)
  instrumentations: [
    new IORedisInstrumentation({
      dbStatementSerializer: (cmdName, cmdArgs) => {
        // Include command name and key (first arg) but not values for security
        return cmdArgs.length > 0 ? `${cmdName} ${cmdArgs[0]}` : cmdName;
      },
    }),
  ],
});

// Start SDK - this initializes tracing, metrics, and logs providers
sdk.start();

// Get the logger from the SDK's global logger provider
const logger = logs.getLogger(SERVICE_NAME, SERVICE_VERSION);

// Get providers
const tracer: Tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const meter: Meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

// ============================================================================
// CUSTOM METRICS
// ============================================================================

// Counters
const prOrchestrationCounter = meter.createCounter("gwa_pr_orchestrations_total", {
  description: "Total PR orchestration runs",
  unit: "1",
});

const prResponseCounter = meter.createCounter("gwa_pr_responses_total", {
  description: "Total PR response handling runs",
  unit: "1",
});

const prCleanupCounter = meter.createCounter("gwa_pr_cleanups_total", {
  description: "Total PRs cleaned up",
  unit: "1",
});

const claudeInvocationCounter = meter.createCounter("gwa_claude_invocations_total", {
  description: "Total Claude CLI invocations",
  unit: "1",
});

const githubApiCallCounter = meter.createCounter("gwa_github_api_calls_total", {
  description: "Total GitHub API calls",
  unit: "1",
});

const redisOperationCounter = meter.createCounter("gwa_redis_operations_total", {
  description: "Total Redis operations",
  unit: "1",
});

const dbOperationCounter = meter.createCounter("gwa_db_operations_total", {
  description: "Total SQLite database operations",
  unit: "1",
});

// Histograms
const claudeDurationHistogram = meter.createHistogram("gwa_claude_duration_seconds", {
  description: "Claude invocation duration",
  unit: "s",
});

const orchestrationDurationHistogram = meter.createHistogram(
  "gwa_orchestration_duration_seconds",
  {
    description: "Full orchestration duration",
    unit: "s",
  }
);

// Gauges via UpDownCounter
const activeSessionsGauge = meter.createUpDownCounter("gwa_sessions_active", {
  description: "Currently active Claude sessions",
  unit: "1",
});

// Session metrics (Issue #5)
const sessionsCompletedCounter = meter.createCounter("gwa_sessions_completed_total", {
  description: "Total completed sessions by outcome",
  unit: "1",
});

const sessionDurationHistogram = meter.createHistogram("gwa_session_duration_seconds", {
  description: "Session execution time distribution",
  unit: "s",
});

const toolCallsCounter = meter.createCounter("gwa_tool_calls_total", {
  description: "Total tool calls by tool name",
  unit: "1",
});

const questionsAskedCounter = meter.createCounter("gwa_questions_asked_total", {
  description: "Total questions asked by Claude",
  unit: "1",
});

const questionsAnsweredCounter = meter.createCounter("gwa_questions_answered_total", {
  description: "Total questions answered by users",
  unit: "1",
});

const questionResponseHistogram = meter.createHistogram("gwa_question_response_seconds", {
  description: "Question response time distribution",
  unit: "s",
});

const commitsCreatedCounter = meter.createCounter("gwa_commits_created_total", {
  description: "Total commits created by sessions",
  unit: "1",
});

const agentTasksCounter = meter.createCounter("gwa_agent_tasks_total", {
  description: "Total agent tasks completed",
  unit: "1",
});

// ============================================================================
// SPAN HELPERS
// ============================================================================

export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Start an active span and run async work within it.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: SpanOptions
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (options?.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        span.setAttribute(key, value);
      }
    }

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Map log level to OpenTelemetry SeverityNumber.
 */
function getSeverityNumber(level: string): SeverityNumber {
  switch (level) {
    case "debug":
      return SeverityNumber.DEBUG;
    case "info":
      return SeverityNumber.INFO;
    case "warn":
      return SeverityNumber.WARN;
    case "error":
      return SeverityNumber.ERROR;
    default:
      return SeverityNumber.INFO;
  }
}

/**
 * Log a message via OTLP to Loki with trace correlation.
 * Also outputs to console for local debugging.
 */
export function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  attributes?: Record<string, string | number | boolean>
) {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();

  // Emit to OTLP logger
  logger.emit({
    severityNumber: getSeverityNumber(level),
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      "log.level": level,
      "service.name": SERVICE_NAME,
      ...(spanContext && {
        "trace_id": spanContext.traceId,
        "span_id": spanContext.spanId,
      }),
      ...attributes,
    },
  });

  // Also output to console for local debugging
  const logEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    ...(spanContext && {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    }),
    ...attributes,
  };
  const logFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  logFn(JSON.stringify(logEntry));
}

// ============================================================================
// METRIC RECORDING HELPERS
// ============================================================================

export const Metrics = {
  // PR Orchestration
  recordOrchestration(repo: string, pr: number, trigger: string, success: boolean) {
    prOrchestrationCounter.add(1, {
      repo,
      pr: pr.toString(),
      trigger,
      success: success.toString(),
    });
  },

  recordOrchestrationDuration(durationMs: number, repo: string, trigger: string) {
    orchestrationDurationHistogram.record(durationMs / 1000, { repo, trigger });
  },

  // PR Response
  recordResponse(repo: string, pr: number, success: boolean) {
    prResponseCounter.add(1, {
      repo,
      pr: pr.toString(),
      success: success.toString(),
    });
  },

  // Cleanup
  recordCleanup(repo: string, prsCleanedUp: number) {
    prCleanupCounter.add(prsCleanedUp, { repo });
  },

  // Claude invocations
  recordClaudeInvocation(
    outcome: "success" | "error" | "question" | "timeout",
    continueSession: boolean
  ) {
    claudeInvocationCounter.add(1, {
      outcome,
      continue_session: continueSession.toString(),
    });
  },

  recordClaudeDuration(durationMs: number, outcome: string) {
    claudeDurationHistogram.record(durationMs / 1000, { outcome });
  },

  // GitHub API
  recordGitHubApiCall(operation: string, success: boolean) {
    githubApiCallCounter.add(1, { operation, success: success.toString() });
  },

  // Redis
  recordRedisOperation(operation: string, success: boolean) {
    redisOperationCounter.add(1, { operation, success: success.toString() });
  },

  // SQLite Database
  recordDbOperation(operation: string, success: boolean) {
    dbOperationCounter.add(1, { operation, success: success.toString() });
  },

  // Sessions
  sessionStarted() {
    activeSessionsGauge.add(1);
  },

  sessionEnded() {
    activeSessionsGauge.add(-1);
  },

  // Swarm
  recordSwarmWorker(status: "spawned" | "completed" | "failed") {
    // Reuse existing counter for swarm worker events
    prOrchestrationCounter.add(1, { operation: "swarm_worker", status });
  },

  recordSwarmCleanup() {
    prCleanupCounter.add(1, { operation: "swarm" });
  },
};

// ============================================================================
// SESSION METRICS (Issue #5)
// ============================================================================

/**
 * Session-specific metrics for dashboard visualization.
 * Tracks session outcomes, duration, tool usage, and interactivity.
 */
export const SessionMetrics = {
  /**
   * Record a completed session with its outcome and duration.
   */
  recordSessionComplete(
    repo: string,
    status: "complete" | "error" | "interrupted",
    type: string,
    durationSeconds: number
  ) {
    try {
      sessionsCompletedCounter.add(1, { repo, status, type });
      sessionDurationHistogram.record(durationSeconds, { repo, type });
    } catch (error) {
      console.error("[Metrics] Failed to record session completion:", error);
    }
  },

  /**
   * Record a tool call execution.
   */
  recordToolCall(toolName: string, sessionId: string, success: boolean) {
    try {
      toolCallsCounter.add(1, {
        tool_name: toolName,
        session_id: sessionId,
        success: success.toString(),
      });
    } catch (error) {
      console.error("[Metrics] Failed to record tool call:", error);
    }
  },

  /**
   * Record a question asked by Claude.
   */
  recordQuestionAsked(repo: string) {
    try {
      questionsAskedCounter.add(1, { repo });
    } catch (error) {
      console.error("[Metrics] Failed to record question asked:", error);
    }
  },

  /**
   * Record a question answered by a user.
   */
  recordQuestionAnswered(repo: string, latencySeconds: number) {
    try {
      questionsAnsweredCounter.add(1, { repo });
      questionResponseHistogram.record(latencySeconds, { repo });
    } catch (error) {
      console.error("[Metrics] Failed to record question answered:", error);
    }
  },

  /**
   * Record a commit created during a session.
   */
  recordCommitCreated(repo: string, sessionId: string) {
    try {
      commitsCreatedCounter.add(1, { repo, session_id: sessionId });
    } catch (error) {
      console.error("[Metrics] Failed to record commit created:", error);
    }
  },

  /**
   * Record an agent task completion.
   */
  recordAgentTaskComplete(status: "completed" | "failed", agentType: string) {
    try {
      agentTasksCounter.add(1, { status, agent_type: agentType });
    } catch (error) {
      console.error("[Metrics] Failed to record agent task:", error);
    }
  },
};

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let isShuttingDown = false;

export async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Log before shutting down the logger
  console.log(JSON.stringify({
    level: "info",
    message: "Shutting down telemetry",
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
  }));

  try {
    // SDK shutdown handles all providers (traces, metrics, logs)
    await sdk.shutdown();
    console.log(JSON.stringify({
      level: "info",
      message: "Telemetry shutdown complete",
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
    }));
  } catch (error) {
    console.error("[OTEL] Error during shutdown:", error);
  }
}

// Register shutdown handlers
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});

// Export tracer and meter for direct use if needed
export { tracer, meter };
