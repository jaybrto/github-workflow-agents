---
name: setup-otel-lgtm
description: Setup OpenTelemetry instrumentation for applications using Grafana LGTM stack (Loki, Grafana, Tempo, Mimir) with Alloy collector. Use when setting up observability for traces, metrics, and logs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, WebFetch, mcp__claude-in-chrome__*
argument-hint: <service-name> <namespace>
---

# Setup OpenTelemetry with Grafana LGTM Stack

**Service Name:** $0
**Namespace:** $1

This skill sets up complete OpenTelemetry instrumentation for applications using the Grafana LGTM stack (Loki, Grafana, Tempo, Mimir) with Alloy collector.

## Architecture Overview

```
Application (OTLP) → Alloy Collector → Tempo (traces)
                                    → Mimir (metrics)
                                    → Loki (logs)
                                           ↓
                                      Grafana (visualization)
```

### OTLP Endpoints (via Alloy)
- **gRPC**: port 4317 (traces, metrics)
- **HTTP**: port 4318 (logs - more reliable for CLI processes)

## Implementation Checklist

### 1. Install Dependencies (Bun/Node.js)

**Core OTEL packages:**
```bash
bun add @opentelemetry/sdk-node \
  @opentelemetry/api \
  @opentelemetry/api-logs \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/exporter-metrics-otlp-grpc \
  @opentelemetry/exporter-logs-otlp-http \
  @opentelemetry/sdk-metrics \
  @opentelemetry/sdk-logs \
  @grpc/grpc-js
```

**Auto-instrumentation packages (Bun compatibility):**
```bash
# For ioredis (Redis client) - WORKS with Bun
bun add @opentelemetry/instrumentation-ioredis
```

**WARNING: These do NOT work with Bun:**
- `@opentelemetry/instrumentation-http` - Patches Node's http module (Bun doesn't use it)
- `@opentelemetry/instrumentation-fetch` - Browser only
- `@opentelemetry/instrumentation-undici` - Node's undici (Bun has native fetch)

For HTTP clients in Bun (octokit, fetch), use manual `withSpan()` wrappers.

Available auto-instrumentations: https://github.com/open-telemetry/opentelemetry-js-contrib

### 2. Create Telemetry Module

Create `src/lib/telemetry.ts` using the template in `templates/telemetry.ts`.

**CRITICAL**: This module MUST be imported FIRST in entry points before any other modules.

### 3. Add K8s Environment Variables

Add to your StatefulSet/Deployment:

```yaml
env:
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: "http://alloy.alloy.svc.cluster.local:4317"
  - name: OTEL_EXPORTER_OTLP_PROTOCOL
    value: "grpc"
  - name: OTEL_SERVICE_NAME
    value: "$0"
  - name: OTEL_SERVICE_VERSION
    value: "1.0.0"
  - name: DEPLOYMENT_ENVIRONMENT
    value: "production"
  - name: POD_NAME
    valueFrom:
      fieldRef:
        fieldPath: metadata.name
  # Fast flush for CLI processes
  - name: OTEL_BSP_SCHEDULE_DELAY
    value: "1000"
  - name: OTEL_BSP_MAX_QUEUE_SIZE
    value: "512"
```

### 4. Create Test Script

Create `src/test-telemetry.ts`:

```typescript
#!/usr/bin/env bun
import { withSpan, Metrics, shutdown, log } from "./lib/telemetry.js";

async function main() {
  console.log("Starting telemetry test...");

  try {
    await withSpan("test.operation", async (span) => {
      span.setAttribute("test.type", "integration");
      log("info", "Test started", { component: "test" });

      await withSpan("test.nested", async () => {
        log("debug", "Nested operation");
        await sleep(100);
        Metrics.recordOperation("test", true);
      });

      Metrics.recordDuration(500, "test.operation");
      log("info", "Test completed");
    });

    await sleep(2000); // Allow flush
  } finally {
    await shutdown();
  }
  console.log("Done.");
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
main();
```

### 5. Test Locally

```bash
# Port-forward Alloy
kubectl port-forward -n alloy svc/alloy 4317:4317 4318:4318 &

# Run test
OTEL_SERVICE_NAME=$0 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 bun run src/test-telemetry.ts
```

### 6. Verify Alloy Receives Data

```bash
kubectl port-forward -n alloy svc/alloy 12345:12345 &
curl -s "http://localhost:12345/metrics" | grep otelcol_receiver_accepted
# Should show: otelcol_receiver_accepted_metric_points_total, _spans_total, _log_records_total
```

### 7. Create Grafana Dashboard

See `reference.md` for the GrafanaDashboard CRD template.

### 8. Configure Trace-to-Logs Correlation

In Grafana:
1. Go to: Connections → Data sources → Tempo
2. Scroll to "Trace to logs" section
3. Configure:
   - Data source: Loki
   - Filter by trace ID: ON
   - Filter by span ID: ON
   - Tags: Add `service.name` → `service_name`

### 9. Verify with Chrome MCP

After deploying the dashboard:
1. Get tab context: `mcp__claude-in-chrome__tabs_context_mcp`
2. Navigate to dashboard: `mcp__claude-in-chrome__navigate`
3. Wait for load: `mcp__claude-in-chrome__computer` with action "wait"
4. Screenshot: `mcp__claude-in-chrome__computer` with action "screenshot"
5. Verify all panels show data

## Argument Reference

When invoked as `/setup-otel-lgtm my-service my-namespace`:
- `$0` = `my-service` (the service name for OTEL_SERVICE_NAME)
- `$1` = `my-namespace` (the K8s namespace and service.namespace attribute)

## Supporting Files

- `templates/telemetry.ts` - Complete telemetry module template
- `reference.md` - Gotchas, verification queries, dashboard CRD
