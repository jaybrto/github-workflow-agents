/**
 * OpenTelemetry instrumentation - MUST be imported FIRST before any other modules.
 *
 * Template for: $0 (service) in $1 (namespace)
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, metrics, SpanStatusCode, type Span, type Tracer, type Meter } from "@opentelemetry/api";

// Auto-instrumentation for common libraries (install with: bun add @opentelemetry/instrumentation-ioredis @opentelemetry/instrumentation-http)
// Uncomment the ones you need:
// import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
// import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";

// Service identity from env vars
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "my-service";
const SERVICE_VERSION = process.env.OTEL_SERVICE_VERSION || "1.0.0";
const DEPLOYMENT_ENV = process.env.DEPLOYMENT_ENVIRONMENT || "production";

// Resource attributes
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  "deployment.environment": DEPLOYMENT_ENV,
  "service.namespace": "my-namespace",  // Replace with $1
  "team": "platform",
  "pod.name": process.env.POD_NAME || "unknown",
});

// OTLP endpoints from environment
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";
// CRITICAL: Use HTTP endpoint (4318) for logs - gRPC logs often fail for CLI processes
const OTLP_HTTP_ENDPOINT = OTLP_ENDPOINT.replace(":4317", ":4318");

// Create exporters
const traceExporter = new OTLPTraceExporter({ url: OTLP_ENDPOINT });
const metricExporter = new OTLPMetricExporter({ url: OTLP_ENDPOINT });
// CRITICAL: Use HTTP exporter for logs with SimpleLogRecordProcessor for immediate export
const logExporter = new OTLPLogExporter({ url: OTLP_HTTP_ENDPOINT });
const logRecordProcessor = new SimpleLogRecordProcessor(logExporter);

// Configure SDK
const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 5000, // Fast export for CLI processes
  }),
  logRecordProcessors: [logRecordProcessor],
  // Auto-instrumentation - uncomment and customize as needed:
  // instrumentations: [
  //   new IORedisInstrumentation({
  //     dbStatementSerializer: (cmdName, cmdArgs) => {
  //       return cmdArgs.length > 0 ? `${cmdName} ${cmdArgs[0]}` : cmdName;
  //     },
  //   }),
  //   new HttpInstrumentation({
  //     ignoreIncomingRequestHook: (req) => req.url === "/health",
  //   }),
  // ],
});

sdk.start();

// Get providers
const logger = logs.getLogger(SERVICE_NAME, SERVICE_VERSION);
const tracer: Tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const meter: Meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

// ============================================================================
// SPAN HELPERS
// ============================================================================

export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Run async work within a span.
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
 * Log with trace correlation.
 */
export function log(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  attributes?: Record<string, string | number | boolean>
) {
  const severityMap = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR
  };
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();

  logger.emit({
    severityNumber: severityMap[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      "log.level": level,
      "service.name": SERVICE_NAME,
      ...(spanContext && { "trace_id": spanContext.traceId, "span_id": spanContext.spanId }),
      ...attributes,
    },
  });

  // Console output for debugging
  const logEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    service: SERVICE_NAME,
    ...(spanContext && { traceId: spanContext.traceId, spanId: spanContext.spanId }),
    ...attributes
  };
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(JSON.stringify(logEntry));
}

// ============================================================================
// CUSTOM METRICS - Customize these for your application
// ============================================================================

// Counters
const operationCounter = meter.createCounter("app_operations_total", {
  description: "Total operations",
  unit: "1",
});

// Histograms
const durationHistogram = meter.createHistogram("app_duration_seconds", {
  description: "Operation duration",
  unit: "s",
});

// Gauges (via UpDownCounter)
const activeGauge = meter.createUpDownCounter("app_active_sessions", {
  description: "Active sessions",
  unit: "1",
});

export const Metrics = {
  recordOperation(type: string, success: boolean) {
    operationCounter.add(1, { type, success: success.toString() });
  },
  recordDuration(durationMs: number, operation: string) {
    durationHistogram.record(durationMs / 1000, { operation });
  },
  sessionStarted() { activeGauge.add(1); },
  sessionEnded() { activeGauge.add(-1); },
};

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

let isShuttingDown = false;

export async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    await sdk.shutdown();
  } catch (error) {
    console.error("[OTEL] Shutdown error:", error);
  }
}

process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
process.on("SIGINT", async () => { await shutdown(); process.exit(0); });

export { tracer, meter };
