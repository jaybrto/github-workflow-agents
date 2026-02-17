# Implementation Plan Summary - Issue #5

## Session Metrics Dashboard with Grafana Integration

**Issue**: [#5](https://github.com/jaybrto/github-workflow-agents/issues/5)
**Plan Version**: 1.0
**Created**: 2026-02-11
**Estimated Effort**: 3-4 phases (see parallelization in tasks.md)

---

## Executive Summary

Create a comprehensive Grafana dashboard that visualizes GWA session metrics by:
1. Adding 7 new OTEL metrics to track session outcomes, duration, tool usage, and interactivity
2. Building a background exporter to push database metrics to Mimir via OTLP
3. Designing a 16-panel Grafana dashboard with filtering and drill-down capabilities
4. Auto-provisioning the dashboard via Kubernetes ConfigMap

The implementation leverages **existing** telemetry infrastructure (OTEL SDK → Alloy → Mimir → Grafana) and adds **no new dependencies**.

---

## Key Design Decisions

### ✅ Database-Driven Metrics Export
**Decision**: Export metrics from SQLite database via background job rather than inline instrumentation.

**Rationale**:
- SQLite already tracks rich session data (20+ fields)
- Avoids performance impact on session hot path
- Handles process crashes gracefully (export on next run)
- Can backfill historical metrics if needed

**Trade-off**: 60-second delay in metric availability (acceptable for dashboard use case)

### ✅ ConfigMap-Based Dashboard Provisioning
**Decision**: Use Kubernetes ConfigMap with Grafana sidecar auto-discovery.

**Rationale**:
- Grafana already configured with sidecar watching for `grafana_dashboard: "1"` label
- Dashboard updates via GitOps (commit → deploy → auto-update)
- No manual Grafana UI configuration needed
- Version-controlled dashboard JSON

**Trade-off**: Requires cluster access to update dashboard (not self-service in Grafana UI)

### ✅ Lean Metric Instrumentation
**Decision**: Emit only 7 new metrics with carefully chosen labels.

**Rationale**:
- Avoid metric cardinality explosion (max ~1000 unique series)
- Each metric serves 2+ dashboard panels (reuse via PromQL)
- Labels limited to low-cardinality values (repo, status, tool_name)

**Trade-off**: Some advanced queries require PromQL computation rather than pre-aggregated metrics

---

## Success Criteria

The implementation is successful if:

1. **Functional Completeness**
   - ✅ All 5 functional requirements met (see requirements.md)
   - ✅ Dashboard loads in <2 seconds with 30 days of data
   - ✅ All 16 panels display accurate data

2. **Non-Functional Requirements**
   - ✅ Metrics overhead <5% of session runtime
   - ✅ No breaking changes to existing telemetry
   - ✅ Dashboard follows Grafana best practices

3. **Operational Readiness**
   - ✅ Documentation enables team self-service
   - ✅ No production incidents during rollout
   - ✅ Metrics cardinality <1000 unique series

---

## Implementation Phases

### Phase 1: Foundation (Parallel)
**Timeline**: Day 1
**Tasks**: 1, 4, 6

- Create SessionMetrics class (critical path)
- Design Grafana dashboard JSON (independent)
- Write documentation (independent)

**Deliverable**: Metrics instrumentation ready, dashboard design complete

### Phase 2: Integration (Sequential after Phase 1)
**Timeline**: Day 2
**Tasks**: 2, 3

- Build metrics exporter background job
- Instrument application code (orchestrate, repl-session, respond, cleanup)

**Deliverable**: Metrics flowing to Mimir

### Phase 3: Deployment (Sequential after Phase 1)
**Timeline**: Day 2-3
**Tasks**: 5

- Create Kubernetes ConfigMap for dashboard provisioning
- Deploy to dev cluster

**Deliverable**: Dashboard live in Grafana

### Phase 4: Validation (Sequential after all)
**Timeline**: Day 3-4
**Tasks**: 7

- Run unit and integration tests
- Generate test sessions and validate dashboard accuracy
- Performance testing

**Deliverable**: Production-ready metrics dashboard

---

## Files to Create

| File | Purpose | Size Estimate |
|------|---------|---------------|
| `src/lib/metrics-exporter.ts` | Background DB→OTEL exporter | 150-200 LOC |
| `k8s/grafana/dashboards/session-metrics.json` | Dashboard definition | 500-800 LOC |
| `k8s/grafana/configmap-dashboards.yaml` | K8s provisioning | 50 LOC |
| `docs/metrics-dashboard.md` | User documentation | 200-300 LOC |
| `src/lib/telemetry.test.ts` | Unit tests for SessionMetrics | 100-150 LOC |
| `src/lib/metrics-exporter.test.ts` | Unit tests for exporter | 100-150 LOC |

**Total New Code**: ~1100-1650 LOC

---

## Files to Modify

| File | Changes | Impact |
|------|---------|--------|
| `src/lib/telemetry.ts` | Add SessionMetrics class | +100-150 LOC |
| `src/orchestrate.ts` | Call recordSessionComplete() | +10-15 LOC |
| `src/lib/repl-session.ts` | Call recordToolCall(), recordCommitCreated() | +20-30 LOC |
| `src/respond.ts` | Call recordQuestionAnswered() | +10-15 LOC |
| `src/cleanup.ts` | Record interrupted sessions | +10-15 LOC |
| `src/lib/db.ts` | Export helper functions for metrics queries | +20-30 LOC |
| `scripts/deploy-all.sh` | Add ConfigMap deployment | +5 LOC |

**Total Modified Code**: ~175-260 LOC

---

## Dependencies

### Existing (No Changes)
- `@opentelemetry/sdk-node` - OTEL SDK
- `@opentelemetry/exporter-metrics-otlp-grpc` - Mimir exporter
- `@opentelemetry/api` - Metrics API
- `ioredis` - Redis client (already instrumented)
- `better-sqlite3` - SQLite database

### Infrastructure (Already Deployed)
- Alloy collector (OTLP endpoint at `alloy.alloy.svc.cluster.local:4317`)
- Mimir (metrics storage with 30-day retention)
- Grafana (visualization with `mimir-k3s` datasource)
- Grafana sidecar (watches for dashboard ConfigMaps)

**Zero new dependencies required** ✅

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| High metric cardinality | Medium | High | Limit labels, use Alloy relabeling to cap series |
| Database query performance | Low | Medium | Use indexed columns, batch queries at 100 rows |
| Dashboard performance | Low | Low | Time range filters in PromQL, limit table rows |
| OTLP export failures | Low | Low | Try/catch wrapping, metrics are optional |
| Breaking existing telemetry | Very Low | High | No changes to existing Metrics class, only additions |

---

## Testing Strategy

### Unit Tests
- Mock OTEL SDK, verify SessionMetrics calls
- Mock database, verify exporter queries
- Coverage target: >80% for new code

### Integration Tests
- Local Mimir/Grafana with docker-compose
- Run 10 test sessions, verify metrics appear
- Validate PromQL queries return expected results

### Performance Tests
- Measure orchestration runtime before/after
- Verify metrics overhead <5%
- Monitor memory usage of background exporter

### Production Validation
- Deploy to dev cluster first
- Run 20 mixed sessions (success/error/interrupted)
- Verify dashboard accuracy
- Check metric cardinality <1000 series

---

## Rollout Plan

### Stage 1: Metrics Collection (Non-Breaking)
- Deploy SessionMetrics class + exporter
- Verify metrics appear in Mimir
- No user-facing changes yet

### Stage 2: Dashboard Preview (Internal)
- Create dashboard JSON and deploy to dev Grafana
- Team review and feedback
- Iterate on panel design

### Stage 3: Production Deployment
- Deploy ConfigMap to production Grafana
- Announce dashboard to team
- Monitor for issues

### Rollback Strategy
- Metrics emit is try/catch wrapped (no functional impact)
- Can disable exporter via env var `DISABLE_METRICS_EXPORT=true`
- Dashboard removal: delete ConfigMap (non-destructive)

---

## Open Questions

1. **Metric Retention**: Should we configure different retention for session metrics vs other GWA metrics?
   - **Recommendation**: Use default 30-day retention initially, can extend later if needed

2. **Alerting**: Should we define alerting rules as part of this issue?
   - **Recommendation**: No, create separate issue for alerting (out of scope for dashboard)

3. **Multi-Cluster**: If GWA deploys to multiple clusters, should dashboard aggregate across clusters?
   - **Recommendation**: Single cluster for now, can add federation later

4. **Historical Backfill**: Should we backfill metrics for existing session data in SQLite?
   - **Recommendation**: No, start fresh to avoid complexity; historical data remains queryable via SQLite

---

## Next Steps

1. **Plan Review**: Team review of this implementation plan
2. **Task Assignment**: Assign tasks to engineers (can parallelize Task 1, 4, 6)
3. **Kickoff**: Start Phase 1 implementation
4. **Daily Standup**: Track progress against task checklist
5. **Demo**: Show dashboard to team once Task 7 completes

---

## References

- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [PromQL Query Examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [OpenTelemetry Metrics API](https://opentelemetry.io/docs/specs/otel/metrics/api/)
- [Mimir Architecture](https://grafana.com/docs/mimir/latest/)
- [GWA Existing Telemetry Setup](/.claude/skills/setup-otel-lgtm/)

---

## Appendix: Metrics Reference

### New Metrics to Add

| Metric Name | Type | Labels | Purpose |
|-------------|------|--------|---------|
| `gwa_sessions_completed_total` | Counter | repo, status, type | Track session outcomes |
| `gwa_session_duration_seconds` | Histogram | repo, status, type | Session execution time |
| `gwa_tool_calls_total` | Counter | tool_name, session_id, success | Tool usage tracking |
| `gwa_questions_asked_total` | Counter | repo | Interactive session count |
| `gwa_questions_answered_total` | Counter | repo | User responsiveness |
| `gwa_question_response_seconds` | Histogram | repo | Question latency |
| `gwa_commits_created_total` | Counter | repo, session_id | Productivity metric |
| `gwa_agent_tasks_total` | Counter | status, agent_type | Swarm effectiveness |

### Existing Metrics (Unchanged)

| Metric Name | Type | Purpose |
|-------------|------|---------|
| `gwa_sessions_active` | UpDownCounter | Currently running sessions |
| `gwa_claude_duration_seconds` | Histogram | Claude CLI invocation time |
| `gwa_orchestration_duration_seconds` | Histogram | Full orchestration time |
| `gwa_pr_orchestrations_total` | Counter | PR processing runs |
| `gwa_claude_invocations_total` | Counter | Claude CLI calls |

---

**Plan Status**: ✅ Ready for Review
**Approver**: Team Lead / Engineering Manager
**Next Action**: Begin Phase 1 implementation upon approval
