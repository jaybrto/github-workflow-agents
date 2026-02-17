# Design Document - Session Metrics Dashboard

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    GWA Applications                          │
│  (orchestrate.ts, respond.ts, cleanup.ts, repl-session.ts) │
└────────────┬──────────────────────────┬─────────────────────┘
             │                          │
             ├─ New Metrics ────────────┤
             │  Emitted                 │  Database
             ↓                          ↓  Queries
┌────────────────────────┐    ┌─────────────────────┐
│  OTEL SDK (telemetry.ts)│    │  SQLite (db.ts)     │
│  - SessionMetrics class │    │  - sessions         │
│  - New counters/histos  │    │  - tool_calls       │
└────────────┬─────────────┘    │  - activity_log     │
             │                  │  - commits          │
             ↓                  └─────────────────────┘
┌────────────────────────┐
│  Alloy Collector       │
│  (OTLP gRPC :4317)     │
└────────────┬─────────────┘
             │
             ↓
┌────────────────────────┐
│  Mimir (Time-Series)   │
│  - 30-day retention    │
│  - PromQL queries      │
└────────────┬─────────────┘
             │
             ↓
┌────────────────────────┐
│  Grafana Dashboard     │
│  - session-metrics.json│
│  - ConfigMap provision │
└──────────────────────────┘
```

## Component Design

### 1. Metrics Instrumentation (`src/lib/telemetry.ts`)

**New Class: `SessionMetrics`**

Extends existing `Metrics` class with session-specific methods:

```typescript
class SessionMetrics {
  // Counters
  private sessionsCompletedCounter: Counter;
  private toolCallsCounter: Counter;
  private questionsAskedCounter: Counter;
  private questionsAnsweredCounter: Counter;
  private commitsCreatedCounter: Counter;
  private agentTasksCounter: Counter;

  // Histograms
  private sessionDurationHistogram: Histogram;
  private questionLatencyHistogram: Histogram;

  // Methods
  recordSessionComplete(repo: string, status: string, type: string, durationSeconds: number): void
  recordToolCall(toolName: string, sessionId: string, success: boolean): void
  recordQuestionAsked(repo: string): void
  recordQuestionAnswered(repo: string, latencySeconds: number): void
  recordCommitCreated(repo: string, sessionId: string): void
  recordAgentTaskComplete(status: string, agentType: string): void
}
```

**Integration Points:**
- `src/orchestrate.ts` - Record session completion
- `src/lib/repl-session.ts` - Record tool calls, commits
- `src/lib/db.ts` - Export question metrics on answer
- `src/respond.ts` - Record question answered
- `src/cleanup.ts` - Record interrupted sessions
- Swarm handlers - Record agent task outcomes

### 2. Database Query Layer (`src/lib/metrics-exporter.ts`) - NEW FILE

Periodically export DB metrics to OTEL (avoid hot path queries):

```typescript
// Background job that runs every 60 seconds
export async function exportDatabaseMetrics() {
  // Query sessions table for completed sessions since last export
  const completedSessions = await db.query(`
    SELECT
      repo,
      status,
      type,
      (completed_at - started_at) as duration_seconds
    FROM sessions
    WHERE completed_at > ?
  `, [lastExportTimestamp]);

  // Emit metrics
  for (const session of completedSessions) {
    SessionMetrics.recordSessionComplete(
      session.repo,
      session.status,
      session.type,
      session.duration_seconds
    );
  }

  // Similar queries for tool_calls, commits, questions
  // ...
}

// Start background export on app init
setInterval(exportDatabaseMetrics, 60000);
```

**Why this approach?**
- No performance impact on session hot path
- Leverages existing rich database tracking
- Handles process crashes (export on next run)
- Can backfill metrics if needed

### 3. Grafana Dashboard (`k8s/grafana/dashboards/session-metrics.json`)

**Dashboard Structure:**

```json
{
  "dashboard": {
    "title": "GWA Session Metrics",
    "uid": "gwa-sessions",
    "tags": ["gwa", "sessions", "claude"],
    "timezone": "browser",
    "templating": {
      "list": [
        {
          "name": "repo",
          "type": "query",
          "query": "label_values(gwa_sessions_completed_total, repo)",
          "multi": true,
          "includeAll": true
        },
        {
          "name": "time_range",
          "type": "interval",
          "options": ["5m", "15m", "1h", "6h", "24h", "7d", "30d"]
        }
      ]
    },
    "panels": [...]
  }
}
```

**Panel Breakdown:**

| Panel | Type | PromQL Query | Purpose |
|-------|------|--------------|---------|
| Active Sessions | Stat | `gwa_sessions_active` | Real-time active count |
| Success Rate (24h) | Gauge | `rate(gwa_sessions_completed_total{status="complete"}[24h]) / rate(gwa_sessions_completed_total[24h])` | Success percentage |
| Session Status Distribution | Pie Chart | `sum by (status) (gwa_sessions_completed_total)` | Outcome breakdown |
| Session Duration p95 | Graph | `histogram_quantile(0.95, gwa_session_duration_seconds)` | Duration trends |
| Duration Histogram | Heatmap | `sum by (le) (gwa_session_duration_seconds_bucket)` | Distribution view |
| Tool Usage Frequency | Bar Chart | `topk(10, sum by (tool_name) (gwa_tool_calls_total))` | Most used tools |
| Questions Asked/Answered | Graph | `rate(gwa_questions_asked_total[5m])` + `rate(gwa_questions_answered_total[5m])` | Interactive sessions |
| Question Response Time | Graph | `histogram_quantile(0.95, gwa_question_response_seconds)` | User responsiveness |
| Commits Per Session | Stat | `avg(rate(gwa_commits_created_total[1h]))` | Productivity metric |
| Top Active Repositories | Table | `sum by (repo) (rate(gwa_sessions_completed_total[24h]))` | Repo usage |
| Agent Task Success Rate | Gauge | `rate(gwa_agent_tasks_total{status="completed"}[24h])` | Swarm effectiveness |
| Long-Running Sessions | Table | `sessions WHERE duration > 3600s` | Identify stuck sessions |

### 4. Kubernetes Provisioning (`k8s/grafana/configmap-dashboards.yaml`)

Create ConfigMap to auto-provision dashboard:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-dashboard-gwa-sessions
  namespace: grafana
  labels:
    grafana_dashboard: "1"
data:
  session-metrics.json: |
    {{ .Files.Get "dashboards/session-metrics.json" | indent 4 }}
```

Grafana sidecar watches for ConfigMaps with label `grafana_dashboard: "1"`.

### 5. Documentation (`docs/metrics-dashboard.md`) - NEW FILE

User-facing documentation:

```markdown
# Session Metrics Dashboard

## Accessing the Dashboard
1. Navigate to Grafana: https://grafana.your-domain.com
2. Search for "GWA Session Metrics" in dashboards
3. Use template variables to filter by repo/time range

## Panels Explained
- **Active Sessions**: Current running sessions count
- **Success Rate**: Percentage of sessions that complete successfully
- ...

## Custom PromQL Queries
To analyze specific patterns:
- Find sessions >1 hour: `gwa_session_duration_seconds > 3600`
- Tool usage by session: `sum by (session_id) (gwa_tool_calls_total)`
...

## Troubleshooting
- No data showing: Check Alloy collector status
- Stale metrics: Verify OTLP endpoint in pod env vars
...
```

## Implementation Patterns

### Pattern 1: Lazy Metric Initialization
```typescript
// Only create meter/instruments once
let sessionMetrics: SessionMetrics | null = null;

export function getSessionMetrics(): SessionMetrics {
  if (!sessionMetrics) {
    sessionMetrics = new SessionMetrics();
  }
  return sessionMetrics;
}
```

### Pattern 2: Graceful Degradation
```typescript
try {
  SessionMetrics.recordSessionComplete(...);
} catch (err) {
  // Log but don't crash session on metrics failure
  console.error('Failed to record session metric:', err);
}
```

### Pattern 3: Batch Database Exports
```typescript
// Query in batches to avoid memory issues
const BATCH_SIZE = 100;
let offset = 0;
while (true) {
  const batch = await db.query('SELECT ... LIMIT ? OFFSET ?', [BATCH_SIZE, offset]);
  if (batch.length === 0) break;

  for (const row of batch) {
    emitMetric(row);
  }
  offset += BATCH_SIZE;
}
```

## File Changes

### New Files
1. `src/lib/metrics-exporter.ts` - Background DB→OTEL exporter
2. `k8s/grafana/dashboards/session-metrics.json` - Dashboard definition
3. `k8s/grafana/configmap-dashboards.yaml` - K8s provisioning
4. `docs/metrics-dashboard.md` - User documentation

### Modified Files
1. `src/lib/telemetry.ts` - Add SessionMetrics class
2. `src/orchestrate.ts` - Call recordSessionComplete()
3. `src/lib/repl-session.ts` - Call recordToolCall(), recordCommitCreated()
4. `src/respond.ts` - Call recordQuestionAnswered()
5. `src/cleanup.ts` - Record interrupted sessions
6. `src/lib/db.ts` - Export helper functions for metrics queries
7. `package.json` - Add any missing dependencies (likely none)
8. `helm/gwa-runner/templates/statefulset.yaml` - Mount ConfigMap if needed

### No Changes Required
- Alloy configuration (already routing to Mimir)
- Mimir configuration (already accepting metrics)
- Grafana datasource (already configured)

## Testing Strategy

### Unit Tests
- Mock OTEL SDK and verify metric calls
- Test SessionMetrics methods with sample data
- Verify database query correctness

### Integration Tests
- Start local Mimir/Grafana with docker-compose
- Run sample sessions and verify metrics appear
- Validate PromQL queries return expected results

### Manual Validation
1. Deploy to dev cluster
2. Trigger 10 test sessions (5 success, 3 error, 2 interrupted)
3. Verify dashboard shows correct counts/distributions
4. Check metric cardinality (ensure not creating infinite series)

## Rollout Plan

### Phase 1: Metrics Collection (Non-Breaking)
- Deploy SessionMetrics class
- Add instrumentation calls
- Verify metrics appear in Mimir
- No user-facing changes yet

### Phase 2: Dashboard Creation
- Create dashboard JSON
- Test locally with existing metrics
- Refine panel layouts and queries

### Phase 3: Provisioning & Documentation
- Create ConfigMap
- Deploy to cluster
- Write docs
- Announce to team

### Rollback Strategy
- Metrics emit is try/catch wrapped (no functional impact)
- Can disable background exporter via env var
- Dashboard removal is non-destructive (delete ConfigMap)

## Security Considerations

- **No Sensitive Data**: Metrics only contain repo names, tool names, status codes
- **No User Content**: Never emit prompt text, commit messages, or file contents
- **Label Cardinality**: Limit repo names to avoid unbounded series
  - Use `relabel_configs` in Alloy if needed to cap at top 50 repos

## Performance Impact

### Estimated Overhead
- Metric emit: ~1ms per call (async OTLP)
- Background export: ~500ms every 60s (batch queries)
- Storage: ~10KB/day in Mimir (assuming 100 sessions/day)

### Optimization Opportunities
- Use sampling for high-frequency tool calls (emit 1 in 10)
- Aggregate before export (e.g., sum tool calls per session)
- Compress histogram buckets for long-tail distributions

## Future Enhancements (Not in Scope)

- Alerting rules (e.g., success rate <80%)
- Real-time session log streaming panel
- Cost analysis (Claude API usage correlation)
- GitHub PR merge correlation (session → PR → deploy)
- Multi-cluster aggregation (if GWA deployed to multiple clusters)
