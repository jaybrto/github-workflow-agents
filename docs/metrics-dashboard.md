# GWA Session Metrics Dashboard

Comprehensive monitoring and analytics for GitHub Workflow Agents sessions.

## Overview

The GWA Session Metrics Dashboard provides real-time and historical visibility into:
- Session lifecycle and outcomes (success/error/interrupted)
- Execution time distributions and percentiles
- Tool usage patterns and resource consumption
- Interactive session responsiveness (questions asked/answered)
- Agent task success rates (swarm effectiveness)
- Repository activity trends

## Accessing the Dashboard

1. Navigate to your Grafana instance
2. Search for **"GWA Session Metrics"** in the dashboard list
3. Or use the direct URL: `https://your-grafana-domain/d/gwa-sessions/gwa-session-metrics`

The dashboard auto-refreshes every 30 seconds and defaults to showing the last 24 hours of data.

## Template Variables

### Repository Filter (`$repo`)
- **Multi-select dropdown** of all repositories with session activity
- Select "All" to view aggregate metrics across all repositories
- Select specific repositories to filter the entire dashboard
- Example: Filter to just `jaybrto/github-workflow-agents`

### Time Range Selector
- Quick ranges: 5m, 15m, 1h, 6h, 12h, 24h, 7d, 30d
- Custom ranges supported via the time picker
- All panels respect the selected time range

## Dashboard Panels

### Row 1: Overview Metrics

#### Panel 1: Active Sessions (Stat)
- **What it shows**: Number of currently running Claude sessions
- **Thresholds**:
  - Green: 0-4 active sessions
  - Yellow: 5-9 active sessions (moderate load)
  - Red: 10+ active sessions (high load)
- **Alert if**: Value stays red for >10 minutes (potential capacity issue)

#### Panel 2: Success Rate (24h) (Gauge)
- **What it shows**: Percentage of sessions that completed successfully in last 24h
- **Formula**: `complete / (complete + error + interrupted) * 100`
- **Thresholds**:
  - Green: 80-100% (healthy)
  - Yellow: 50-79% (degraded)
  - Red: 0-49% (critical)
- **Alert if**: Below 70% for sustained period

#### Panel 3: Total Sessions Today (Stat)
- **What it shows**: Count of all completed sessions in last 24h
- **Use case**: Understand overall activity level and usage trends
- **Compare with**: Historical daily averages to detect anomalies

#### Panel 4: Avg Session Duration (Stat)
- **What it shows**: Median (p50) session execution time
- **Thresholds**:
  - Green: 0-10 minutes (fast)
  - Yellow: 10-30 minutes (normal)
  - Red: 30+ minutes (slow)
- **Alert if**: Sustained increase indicates performance degradation

### Row 2: Session Outcomes

#### Panel 5: Session Status Distribution (Pie Chart)
- **What it shows**: Breakdown of session outcomes over selected time range
- **Colors**:
  - Green: `complete` - successful sessions
  - Red: `error` - failed sessions
  - Yellow: `interrupted` - crashed or killed sessions
- **Use case**: Quick visual health check of system reliability

#### Panel 6: Sessions Over Time (Stacked Graph)
- **What it shows**: Rate of session completions per second, stacked by status
- **Use case**: Identify time-based patterns (e.g., high error rates during deploys)
- **Tip**: Hover over graph to see exact rates at any point in time

#### Panel 7: Error Rate Trend (Graph)
- **What it shows**: Percentage of sessions ending in error over 5-minute windows
- **Formula**: `errors / total_sessions * 100`
- **Use case**: Early detection of systemic issues
- **Alert if**: Sustained error rate >15%

### Row 3: Performance Metrics

#### Panel 8: Session Duration p95 (Graph)
- **What it shows**: 95th percentile of session duration by repository
- **Interpretation**: 95% of sessions complete faster than this time
- **Use case**: SLA tracking and performance regression detection
- **Alert if**: p95 exceeds 45 minutes for critical repositories

#### Panel 9: Duration Histogram (Heatmap)
- **What it shows**: Visual distribution of session durations over time
- **Colors**: Blue (few sessions) to red (many sessions) at that duration
- **Use case**: Identify bimodal distributions or duration shifts

#### Panel 10: Long-Running Sessions (>1 hour) (Table)
- **What it shows**: Repositories with most sessions exceeding 1 hour
- **Use case**: Identify repositories with complex PRs or stuck sessions
- **Action**: Investigate high-count repositories for optimization opportunities

### Row 4: Resource Usage

#### Panel 11: Tool Usage Frequency (Bar Chart)
- **What it shows**: Top 10 most frequently called tools across all sessions
- **Use case**: Understand Claude's behavior patterns and common operations
- **Examples**: High `Read` count normal; unusually high `Bash` might indicate issues

#### Panel 12: Commits Per Hour (Graph)
- **What it shows**: Rate of commits created per hour by repository
- **Formula**: `rate(commits)[1h] * 3600`
- **Use case**: Measure productivity and development velocity
- **Note**: Spike in commits may indicate batch operations or refactoring

#### Panel 13: Questions Asked vs Answered (Graph)
- **What it shows**: Rate of interactive questions asked and answered
- **Use case**: Monitor user responsiveness and engagement
- **Ideal state**: Lines closely track each other (fast response time)
- **Alert if**: Large gap indicates many unanswered questions

### Row 5: Deep Dive

#### Panel 14: Top Active Repositories (Table)
- **What it shows**: Repositories ranked by session count in last 24h
- **Use case**: Identify most active projects and resource allocation
- **Sort by**: Click column headers to sort by different metrics

#### Panel 15: Question Response Latency (p95) (Graph)
- **What it shows**: 95th percentile time from question asked to answered
- **Unit**: Seconds
- **Thresholds**:
  - Green: 0-5 minutes (excellent responsiveness)
  - Yellow: 5-10 minutes (acceptable)
  - Red: 10+ minutes (slow response)
- **Use case**: Monitor user engagement and support SLAs

#### Panel 16: Agent Task Success Rate (Gauge)
- **What it shows**: Percentage of swarm agent tasks that completed successfully
- **Formula**: `completed / (completed + failed) * 100`
- **Use case**: Measure swarm system effectiveness
- **Alert if**: Below 85% success rate

## Custom PromQL Queries

### Find sessions using specific tools
```promql
# Sessions that used the "Task" tool
sum(gwa_tool_calls_total{tool_name="Task"}) by (session_id)
```

### Calculate average tools per session
```promql
# Average tool calls per session
sum(rate(gwa_tool_calls_total[1h])) / sum(rate(gwa_sessions_completed_total[1h]))
```

### Identify repositories with high error rates
```promql
# Error rate by repository (last 6h)
(
  sum by (repo) (rate(gwa_sessions_completed_total{status="error"}[6h]))
  /
  sum by (repo) (rate(gwa_sessions_completed_total[6h]))
) * 100
```

### Track question response SLA (95% under 10 minutes)
```promql
# % of questions answered within 600 seconds
(
  sum(rate(gwa_question_response_seconds_bucket{le="600"}[1h]))
  /
  sum(rate(gwa_question_response_seconds_count[1h]))
) * 100
```

### Monitor session duration by session type
```promql
# p95 duration by session type
histogram_quantile(0.95,
  sum by (le, type) (rate(gwa_session_duration_seconds_bucket[1h]))
)
```

## Troubleshooting

### No Data Showing

**Symptoms**: Dashboard loads but all panels are empty

**Possible Causes**:
1. **Metrics not reaching Mimir**
   - Check Alloy collector status: `kubectl logs -n monitoring -l app=alloy`
   - Verify OTLP endpoint in GWA pod: `kubectl exec gwa-runner-0 -- env | grep OTEL`

2. **Mimir not receiving metrics**
   - Check Mimir ingester logs: `kubectl logs -n monitoring -l app=mimir-ingester`
   - Verify metrics exist: `curl -s http://mimir-query-frontend:8080/prometheus/api/v1/series?match[]=gwa_sessions_completed_total`

3. **Time range issue**
   - Expand time range to 7 days to check for any historical data
   - Verify system time sync on GWA pod: `date`

### Stale Metrics (Not Updating)

**Symptoms**: Dashboard shows old data, not refreshing

**Possible Causes**:
1. **Metrics exporter not running**
   - Check GWA pod logs: `kubectl logs gwa-runner-0 | grep MetricsExporter`
   - Should see `[MetricsExporter] Starting` message

2. **Database export disabled**
   - Check environment variable: `kubectl exec gwa-runner-0 -- env | grep DISABLE_METRICS_EXPORT`
   - If set to `true`, metrics export is disabled

3. **Database connection issues**
   - Check for SQLite errors in pod logs: `kubectl logs gwa-runner-0 | grep "DB Error"`

### High Cardinality Warning

**Symptoms**: Grafana slow, Mimir logs show cardinality warnings

**Solution**: Limit repository label values in Alloy config:
```yaml
# In Alloy configuration
relabel_configs:
  - source_labels: [repo]
    regex: '(top-repo-1|top-repo-2|...|top-repo-50)'
    action: keep
```

### Dashboard Performance Issues

**Symptoms**: Slow loading, query timeouts

**Solutions**:
1. Reduce time range (e.g., 24h instead of 30d)
2. Filter to specific repositories using `$repo` variable
3. Increase Grafana query timeout in datasource settings
4. Check Mimir query-frontend logs for slow queries

## Alert Thresholds (Recommended)

Configure Grafana alerts for these metrics:

| Metric | Condition | Threshold | Severity |
|--------|-----------|-----------|----------|
| Success Rate | Below | 70% for 15m | Warning |
| Success Rate | Below | 50% for 5m | Critical |
| Active Sessions | Above | 10 for 30m | Warning |
| Error Rate | Above | 20% for 10m | Critical |
| Session Duration p95 | Above | 45 minutes | Warning |
| Question Response p95 | Above | 600 seconds | Warning |
| Agent Task Success | Below | 85% for 1h | Warning |

## Metric Cardinality

Current metric series count (approximate):

| Metric | Labels | Cardinality |
|--------|--------|-------------|
| `gwa_sessions_completed_total` | repo, status, type | ~150 |
| `gwa_session_duration_seconds` | repo, type | ~50 |
| `gwa_tool_calls_total` | tool_name, session_id, success | ~1000 |
| `gwa_commits_created_total` | repo, session_id | ~500 |
| `gwa_questions_*` | repo | ~50 |
| `gwa_question_response_seconds` | repo | ~50 |
| `gwa_agent_tasks_total` | status, agent_type | ~10 |

**Total**: ~1,810 series (well within Mimir limits)

**Note**: `session_id` labels are high-cardinality but short-lived (sessions are ephemeral)

## Data Retention

- **Raw metrics**: 30 days (Mimir default retention)
- **Aggregated metrics**: Configure downsampling for longer retention if needed
- **Database records**: Configurable via cleanup job (default: 7 days for completed sessions)

## Related Resources

- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [PromQL Query Examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [OpenTelemetry Metrics Specification](https://opentelemetry.io/docs/specs/otel/metrics/api/)
- [Mimir Query Performance](https://grafana.com/docs/mimir/latest/operators-guide/running-production-environment/planning-capacity/)

## Support

For issues or feature requests:
- GitHub Issues: [github.com/jaybrto/github-workflow-agents/issues](https://github.com/jaybrto/github-workflow-agents/issues)
- Label: `observability` or `dashboard`

---

**Dashboard Version**: 1.0
**Last Updated**: 2026-02-11
**Maintained By**: Platform Team
