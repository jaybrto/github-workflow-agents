# OpenTelemetry LGTM Reference

## CRITICAL GOTCHAS

### 1. gRPC Logs Don't Work for CLI Processes
**Problem**: `@opentelemetry/exporter-logs-otlp-grpc` fails silently for short-lived CLI processes.
**Solution**: Use `@opentelemetry/exporter-logs-otlp-http` with port 4318 instead.

### 2. BatchLogRecordProcessor Loses Logs
**Problem**: Logs are lost when the process exits before batch flush.
**Solution**: Use `SimpleLogRecordProcessor` for immediate export.

### 3. HTTP Log Endpoint Auto-Appends Path
**Problem**: OTLPLogExporter automatically appends `/v1/logs` to the endpoint.
**Solution**: Just provide base URL like `http://alloy:4318`, NOT `http://alloy:4318/v1/logs`.

### 4. Loki Label vs Attribute Mismatch
**Problem**: Logs indexed by `service_name` but traces use `service.name`.
**Solution**: Configure tag mapping in Tempo datasource: `service.name` → `service_name`.

### 5. Dashboard Metrics Show "No Data"
**Problem**: Stat panels show 0 when using instant queries on OTLP counters.
**Solution**: OTLP counters reset on CLI restart. Use range queries or `increase()` function.

### 6. Trace-to-Logs Links Not Appearing
**Problem**: No "Logs" link in trace span details.
**Solution**: Ensure Tempo datasource has "Filter by trace ID" enabled and tags mapped correctly.

### 7. Wrong Job Label in Mimir
**Problem**: Metrics have different job label than expected.
**Solution**: Check Alloy config for how it labels metrics. Common format: `namespace/service-name`.

---

## Verification Queries

### Mimir (Metrics)
```bash
kubectl port-forward -n monitoring svc/mimir-query-frontend 8080:8080 &
curl -s "http://localhost:8080/prometheus/api/v1/label/__name__/values" | jq '.data | map(select(startswith("app_")))'
```

### Tempo (Traces)
```bash
kubectl port-forward -n monitoring svc/tempo 3200:3200 &
curl -s "http://localhost:3200/api/search?q=%7Bresource.service.name%3D%22my-service%22%7D&limit=10" | jq '.traces'
```

### Loki (Logs)
```bash
kubectl port-forward -n monitoring svc/loki 3100:3100 &
curl -s "http://localhost:3100/loki/api/v1/query?query=%7Bservice_name%3D%22my-service%22%7D&limit=10" | jq '.data.result'
```

### Alloy Receiver Metrics
```bash
kubectl port-forward -n alloy svc/alloy 12345:12345 &
curl -s "http://localhost:12345/metrics" | grep otelcol_receiver_accepted
```

---

## Grafana Dashboard CRD

```yaml
apiVersion: grafana.integreatly.org/v1beta1
kind: GrafanaDashboard
metadata:
  name: my-service-dashboard
  namespace: monitoring
spec:
  instanceSelector:
    matchLabels:
      dashboards: grafana-lgtm
  json: |-
    {
      "title": "My Service",
      "uid": "my-service-dashboard",
      "panels": [
        {
          "title": "Total Operations",
          "type": "stat",
          "datasource": { "type": "prometheus", "uid": "mimir-k3s" },
          "targets": [{ "expr": "sum(app_operations_total{job=\"my-namespace/my-service\"}) or vector(0)" }],
          "gridPos": { "h": 4, "w": 6, "x": 0, "y": 0 }
        },
        {
          "title": "Operations by Type",
          "type": "timeseries",
          "datasource": { "type": "prometheus", "uid": "mimir-k3s" },
          "targets": [{ "expr": "sum(increase(app_operations_total{job=\"my-namespace/my-service\"}[5m])) by (type)", "legendFormat": "{{type}}" }],
          "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 }
        },
        {
          "title": "Recent Traces",
          "type": "traces",
          "datasource": { "type": "tempo", "uid": "tempo-k3s" },
          "targets": [{ "queryType": "traceqlSearch", "query": "{resource.service.name=\"my-service\"}", "limit": 20 }],
          "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 }
        },
        {
          "title": "Application Logs",
          "type": "logs",
          "datasource": { "type": "loki", "uid": "loki-k3s" },
          "targets": [{ "expr": "{service_name=\"my-service\"} | json" }],
          "gridPos": { "h": 10, "w": 24, "x": 0, "y": 12 }
        },
        {
          "title": "Log Volume by Level",
          "type": "timeseries",
          "datasource": { "type": "loki", "uid": "loki-k3s" },
          "targets": [{ "expr": "sum by (level) (count_over_time({service_name=\"my-service\"}[5m]))", "legendFormat": "{{level}}" }],
          "fieldConfig": {
            "overrides": [
              { "matcher": { "id": "byName", "options": "ERROR" }, "properties": [{ "id": "color", "value": { "fixedColor": "red" } }] },
              { "matcher": { "id": "byName", "options": "INFO" }, "properties": [{ "id": "color", "value": { "fixedColor": "green" } }] },
              { "matcher": { "id": "byName", "options": "DEBUG" }, "properties": [{ "id": "color", "value": { "fixedColor": "blue" } }] }
            ]
          },
          "gridPos": { "h": 6, "w": 12, "x": 0, "y": 22 }
        }
      ]
    }
```

---

## Datasource UIDs

These are the standard UIDs used in the k3s cluster:
- **Tempo**: `tempo-k3s`
- **Mimir**: `mimir-k3s`
- **Loki**: `loki-k3s`

---

## LogQL for Trace Correlation

Find logs for a specific trace:
```
{service_name="my-service"} | json | trace_id="<TRACE_ID>"
```

---

## Testing with Chrome MCP

After deploying the dashboard, verify all panels work:

1. Get tab context: `mcp__claude-in-chrome__tabs_context_mcp`
2. Navigate to dashboard: `mcp__claude-in-chrome__navigate`
3. Wait for load: `mcp__claude-in-chrome__computer` with action "wait"
4. Screenshot: `mcp__claude-in-chrome__computer` with action "screenshot"
5. Scroll and verify all sections: stats, traces, logs, time series

Check for:
- Stat panels showing non-zero values (or vector(0) fallback)
- Time series with data points
- Traces list populated
- Logs streaming
- Log volume chart with level colors
