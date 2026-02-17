# Issue #5: Session Metrics Dashboard - Implementation Plan

**Status**: ✅ Planning Complete - Ready for Implementation
**Issue**: [#5 - Add session metrics dashboard with Grafana integration](https://github.com/jaybrto/github-workflow-agents/issues/5)
**Created**: 2026-02-11
**Estimated Effort**: 3-4 phases (parallelizable)

---

## 📚 Plan Documents

This directory contains the complete implementation plan:

| Document | Purpose | Key Content |
|----------|---------|-------------|
| **[summary.md](summary.md)** | Executive overview | Key decisions, phases, rollout strategy |
| **[requirements.md](requirements.md)** | Requirements analysis | 5 functional requirements, 4 non-functional requirements |
| **[design.md](design.md)** | Technical design | Architecture, component design, file changes |
| **[tasks.md](tasks.md)** | Task breakdown | 7 tasks with dependencies and parallelization |
| **[checklist.md](checklist.md)** | Implementation tracker | Step-by-step checklist for execution |

---

## 🎯 Quick Summary

### What We're Building
A comprehensive Grafana dashboard that visualizes GWA session metrics:
- **Session lifecycle** - Status distribution and transitions
- **Success rates** - Percentage of sessions that complete successfully
- **Duration metrics** - Execution time distributions and percentiles
- **Resource usage** - Tool calls, commits, questions per session
- **Real-time monitoring** - Active sessions and current operational view

### How We're Building It
1. **Add 7 new OTEL metrics** to track session outcomes, duration, tool usage, and interactivity
2. **Create background exporter** to push SQLite database metrics to Mimir via OTLP
3. **Design 16-panel Grafana dashboard** with filtering and drill-down capabilities
4. **Auto-provision via ConfigMap** for GitOps-based dashboard management

### Key Constraints
- ✅ **Zero new dependencies** - Uses existing OTEL → Alloy → Mimir → Grafana stack
- ✅ **Low overhead** - Metrics emit asynchronously, <5% performance impact
- ✅ **Non-breaking** - No changes to existing telemetry, only additions
- ✅ **Extensible** - Template variables and reusable PromQL patterns

---

## 🏗️ Implementation Phases

### Phase 1: Foundation (Parallel) - Day 1
**Tasks**: 1, 4, 6 (can start simultaneously)

- Create SessionMetrics class in telemetry.ts
- Design Grafana dashboard JSON
- Write user documentation

**Deliverable**: Metrics instrumentation ready, dashboard design complete

### Phase 2: Integration - Day 2
**Tasks**: 2, 3 (after Task 1)

- Build background metrics exporter
- Instrument application code (orchestrate, repl-session, respond, cleanup)

**Deliverable**: Metrics flowing to Mimir

### Phase 3: Deployment - Day 2-3
**Tasks**: 5 (after Task 4)

- Create Kubernetes ConfigMap for dashboard provisioning
- Deploy to dev cluster

**Deliverable**: Dashboard live in Grafana

### Phase 4: Validation - Day 3-4
**Tasks**: 7 (after all others)

- Run unit and integration tests
- Generate test sessions and validate accuracy
- Performance testing

**Deliverable**: Production-ready metrics dashboard

---

## 📊 New Metrics Being Added

| Metric | Type | Purpose |
|--------|------|---------|
| `gwa_sessions_completed_total` | Counter | Track session outcomes by status |
| `gwa_session_duration_seconds` | Histogram | Session execution time distribution |
| `gwa_tool_calls_total` | Counter | Tool usage frequency tracking |
| `gwa_questions_asked_total` | Counter | Interactive session count |
| `gwa_questions_answered_total` | Counter | User responsiveness tracking |
| `gwa_question_response_seconds` | Histogram | Question latency distribution |
| `gwa_commits_created_total` | Counter | Productivity metric |
| `gwa_agent_tasks_total` | Counter | Swarm effectiveness tracking |

---

## 📁 Files to Create/Modify

### New Files (6)
- `src/lib/metrics-exporter.ts` - Background DB→OTEL exporter
- `k8s/grafana/dashboards/session-metrics.json` - Dashboard definition
- `k8s/grafana/configmap-dashboards.yaml` - K8s provisioning
- `docs/metrics-dashboard.md` - User documentation
- `src/lib/telemetry.test.ts` - Unit tests for SessionMetrics
- `src/lib/metrics-exporter.test.ts` - Unit tests for exporter

### Modified Files (7)
- `src/lib/telemetry.ts` - Add SessionMetrics class (+100-150 LOC)
- `src/orchestrate.ts` - Call recordSessionComplete() (+10-15 LOC)
- `src/lib/repl-session.ts` - Record tool/commit metrics (+20-30 LOC)
- `src/respond.ts` - Record question answered (+10-15 LOC)
- `src/cleanup.ts` - Record interrupted sessions (+10-15 LOC)
- `src/lib/db.ts` - Export query helpers (+20-30 LOC)
- `scripts/deploy-all.sh` - Deploy ConfigMap (+5 LOC)

**Total New Code**: ~1,275-1,910 LOC

---

## 🚀 Getting Started

### For Implementers
1. Read **[summary.md](summary.md)** for context and key decisions
2. Review **[tasks.md](tasks.md)** for your assigned task details
3. Use **[checklist.md](checklist.md)** to track progress
4. Reference **[design.md](design.md)** for technical details

### For Reviewers
1. Start with **[requirements.md](requirements.md)** to understand the goals
2. Review **[design.md](design.md)** for architectural decisions
3. Check **[tasks.md](tasks.md)** for scope and acceptance criteria
4. Verify **[summary.md](summary.md)** for rollout strategy

### For Project Managers
1. **[summary.md](summary.md)** - Timeline and phases
2. **[tasks.md](tasks.md)** - Task dependencies and parallelization
3. **[checklist.md](checklist.md)** - Progress tracking

---

## ✅ Success Criteria

The implementation is complete when:

1. ✅ All 16 dashboard panels display accurate data
2. ✅ Dashboard loads in <2 seconds with 30 days of data
3. ✅ Metrics overhead <5% of session runtime
4. ✅ No breaking changes to existing telemetry
5. ✅ Documentation enables team self-service
6. ✅ Metric cardinality <1,000 unique series
7. ✅ All tests passing (unit + integration)
8. ✅ Production deployment successful with no incidents

---

## 🔗 Related Resources

- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [PromQL Query Examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)
- [OpenTelemetry Metrics API](https://opentelemetry.io/docs/specs/otel/metrics/api/)
- [Mimir Architecture](https://grafana.com/docs/mimir/latest/)
- [GWA Existing Telemetry](../../.claude/skills/setup-otel-lgtm/)

---

## 📝 Notes

### Design Decisions
- **Database-driven export**: Metrics exported from SQLite every 60s to avoid hot path performance impact
- **ConfigMap provisioning**: Dashboard auto-deploys via Grafana sidecar watching for labeled ConfigMaps
- **Lean instrumentation**: Only 7 new metrics to avoid cardinality explosion

### Risk Mitigation
- All metric calls wrapped in try/catch (won't crash sessions)
- Background exporter can be disabled via `DISABLE_METRICS_EXPORT=true`
- Dashboard uses time-range filters to limit query scope
- Batch queries capped at 100 rows to prevent memory issues

### Out of Scope
- Alerting rules configuration (separate issue)
- Real-time log streaming in dashboard
- Cost analysis metrics
- Multi-cluster aggregation

---

**Plan Created By**: Claude Code Architecture Agent
**Plan Version**: 1.0
**Last Updated**: 2026-02-11

**Next Action**: Begin Phase 1 implementation (Tasks 1, 4, 6 in parallel)
