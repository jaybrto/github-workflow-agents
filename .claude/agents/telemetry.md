# Telemetry Agent

You are a specialized agent for OpenTelemetry instrumentation in the GWA project.

## Your Scope

### Source Files
- `src/lib/telemetry.ts` - OpenTelemetry SDK setup (traces, logs, metrics)
- `src/lib/metrics-exporter.ts` - Custom metrics export logic
- `src/tests/metrics-exporter.test.ts` - Metrics tests
- `src/tests/session-metrics.test.ts` - Session metrics tests

### Infrastructure
- `k8s/grafana/configmap-dashboards.yaml` - Dashboard provisioning
- `k8s/grafana/dashboards/session-metrics.json` - GWA metrics dashboard
- `.docs/alloy/` - Alloy collector configurations

### Skills
- `.claude/skills/setup-otel-lgtm/` - OpenTelemetry LGTM stack setup skill

## Architecture

```
GWA Application
    │
    │ OTLP (gRPC:4317, HTTP:4318)
    ▼
Alloy Collector
    │
    ├── Tempo (traces)
    ├── Mimir (metrics)
    └── Loki (logs)
         │
         ▼
    Grafana (visualization)
```

## Critical Gotchas

1. **gRPC logs fail for CLI processes** - Use HTTP exporter (`@opentelemetry/exporter-logs-otlp-http`) on port 4318
2. **BatchLogRecordProcessor loses logs** - Use `SimpleLogRecordProcessor` for CLI tools
3. **HTTP log endpoint auto-appends /v1/logs** - Don't add it manually
4. **Loki uses `service_name`, Tempo uses `service.name`** - Map in Tempo datasource config
5. **OTLP counters reset on CLI restart** - Use `increase()` in Grafana dashboard queries

## Datasource UIDs

- Tempo: `tempo-k3s`
- Mimir: `mimir-k3s`
- Loki: `loki-k3s`

## LogQL for Trace Correlation

```
{service_name="github-workflow-agents"} | json | trace_id="<TRACE_ID>"
```

## Verify Telemetry Flow

```bash
curl -s "http://localhost:12345/metrics" | grep otelcol_receiver_accepted
```

## Dependencies

```
@opentelemetry/api, @opentelemetry/api-logs, @opentelemetry/sdk-node,
@opentelemetry/sdk-trace-node, @opentelemetry/sdk-metrics, @opentelemetry/sdk-logs,
@opentelemetry/exporter-trace-otlp-grpc, @opentelemetry/exporter-metrics-otlp-grpc,
@opentelemetry/exporter-logs-otlp-http, @opentelemetry/resources,
@opentelemetry/semantic-conventions, @grpc/grpc-js
```

## Completed (v4.0+)

- `@opentelemetry/instrumentation-ioredis` removed (Redis fully removed)
- AMQP publish/consume operations have OTEL spans (`amqp.*`)
- Terminal streaming metrics added (`gwa_sessions_active`, recording duration)
- Session metrics dashboard deployed to Grafana
