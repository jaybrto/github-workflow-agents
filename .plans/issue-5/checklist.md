# Implementation Checklist - Issue #5

Quick reference for tracking implementation progress.

## 📋 Pre-Implementation

- [ ] Plan reviewed and approved by team
- [ ] Tasks assigned to engineers
- [ ] Dev environment tested (local Grafana + Mimir)
- [ ] Branch created: `feature/issue-5-session-metrics-dashboard`

---

## 🏗️ Phase 1: Foundation (Parallel)

### Task 1: SessionMetrics Class
**File**: `src/lib/telemetry.ts`

- [ ] Create SessionMetrics class
- [ ] Add `gwa_sessions_completed_total` counter
- [ ] Add `gwa_session_duration_seconds` histogram (buckets: 30, 60, 120, 300, 600, 1800, 3600)
- [ ] Add `gwa_tool_calls_total` counter
- [ ] Add `gwa_questions_asked_total` counter
- [ ] Add `gwa_questions_answered_total` counter
- [ ] Add `gwa_question_response_seconds` histogram (buckets: 10, 30, 60, 300, 600, 1800)
- [ ] Add `gwa_commits_created_total` counter
- [ ] Add `gwa_agent_tasks_total` counter
- [ ] Implement `recordSessionComplete()` method
- [ ] Implement `recordToolCall()` method
- [ ] Implement `recordQuestionAsked()` method
- [ ] Implement `recordQuestionAnswered()` method
- [ ] Implement `recordCommitCreated()` method
- [ ] Implement `recordAgentTaskComplete()` method
- [ ] Add try/catch error handling to all methods
- [ ] Export SessionMetrics class and types
- [ ] Verify no breaking changes to existing Metrics

### Task 4: Grafana Dashboard
**File**: `k8s/grafana/dashboards/session-metrics.json`

- [ ] Create dashboard skeleton (title, UID, tags)
- [ ] Add template variables: `$repo`, `$time_range`
- [ ] Panel 1: Active Sessions (Stat)
- [ ] Panel 2: Success Rate 24h (Gauge)
- [ ] Panel 3: Total Sessions Today (Stat)
- [ ] Panel 4: Avg Session Duration (Stat)
- [ ] Panel 5: Session Status Distribution (Pie)
- [ ] Panel 6: Sessions Over Time (Graph - stacked)
- [ ] Panel 7: Error Rate Trend (Graph)
- [ ] Panel 8: Session Duration p95 (Graph)
- [ ] Panel 9: Duration Histogram (Heatmap)
- [ ] Panel 10: Long-Running Sessions (Table)
- [ ] Panel 11: Tool Usage Frequency (Bar Chart)
- [ ] Panel 12: Commits Per Hour (Graph)
- [ ] Panel 13: Questions Asked/Answered (Graph)
- [ ] Panel 14: Top Active Repositories (Table)
- [ ] Panel 15: Question Response Latency p95 (Graph)
- [ ] Panel 16: Agent Task Success Rate (Gauge)
- [ ] Add panel descriptions to all panels
- [ ] Validate JSON against Grafana schema
- [ ] Test dashboard locally

### Task 6: Documentation
**File**: `docs/metrics-dashboard.md`

- [ ] Write overview section
- [ ] Document how to access dashboard
- [ ] Explain each of the 16 panels
- [ ] Document template variable usage
- [ ] Add 5+ custom PromQL query examples
- [ ] Write troubleshooting section
- [ ] Add alert threshold recommendations
- [ ] Link to Grafana/Mimir docs

---

## 🔧 Phase 2: Implementation (After Task 1)

### Task 2: Metrics Exporter
**File**: `src/lib/metrics-exporter.ts` (NEW)

- [ ] Create `exportDatabaseMetrics()` function
- [ ] Track last export timestamp (memory or config table)
- [ ] Query completed sessions since last export
- [ ] Query tool_calls since last export
- [ ] Query questions answered since last export
- [ ] Query commits created since last export
- [ ] Query agent_tasks completed since last export
- [ ] Implement batch queries (100 rows max)
- [ ] Emit metrics via SessionMetrics class
- [ ] Add error logging (don't crash on failures)
- [ ] Create `startMetricsExporter()` function
- [ ] Create `stopMetricsExporter()` function
- [ ] Support `DISABLE_METRICS_EXPORT` env var
- [ ] Set 60-second interval
- [ ] Handle graceful shutdown (SIGTERM)

### Task 3: Application Instrumentation
**Files**: Multiple

#### `src/orchestrate.ts`
- [ ] Import SessionMetrics
- [ ] Calculate session duration on completion
- [ ] Call `recordSessionComplete()` with repo, status, type, duration
- [ ] Add try/catch around metric call
- [ ] Call `startMetricsExporter()` on app init

#### `src/lib/repl-session.ts`
- [ ] Hook into Claude CLI JSON stream
- [ ] Parse tool_use messages
- [ ] Call `recordToolCall()` for each tool invocation
- [ ] Detect commit events
- [ ] Call `recordCommitCreated()` on commits
- [ ] Add try/catch around metric calls

#### `src/respond.ts`
- [ ] Import SessionMetrics
- [ ] Calculate question latency (answered_at - asked_at)
- [ ] Call `recordQuestionAnswered()` with repo and latency
- [ ] Add try/catch around metric call

#### `src/cleanup.ts`
- [ ] Import SessionMetrics
- [ ] Call `recordSessionComplete()` for interrupted sessions
- [ ] Add try/catch around metric call

#### Swarm handlers (if applicable)
- [ ] Import SessionMetrics
- [ ] Call `recordAgentTaskComplete()` on task completion
- [ ] Add try/catch around metric call

---

## 🚀 Phase 3: Deployment (After Task 4)

### Task 5: K8s ConfigMap Provisioning
**File**: `k8s/grafana/configmap-dashboards.yaml` (NEW)

- [ ] Create ConfigMap YAML
- [ ] Set namespace to `grafana`
- [ ] Add label `grafana_dashboard: "1"`
- [ ] Embed `session-metrics.json` as data key
- [ ] Update `scripts/deploy-all.sh` to apply ConfigMap
- [ ] Test ConfigMap application to dev cluster
- [ ] Verify Grafana picks up dashboard (60s)
- [ ] Document deployment in `docs/deployment.md`

---

## ✅ Phase 4: Validation (After All)

### Task 7: Testing & Validation

#### Unit Tests
- [ ] Create `src/lib/telemetry.test.ts`
- [ ] Mock OTEL SDK
- [ ] Test all SessionMetrics methods
- [ ] Verify correct metric types and attributes
- [ ] Create `src/lib/metrics-exporter.test.ts`
- [ ] Mock database
- [ ] Test batch queries
- [ ] Test timestamp tracking
- [ ] Run `bun test` - all tests pass

#### Integration Tests
- [ ] Start local Mimir with docker-compose
- [ ] Start local Grafana
- [ ] Run `bun run orchestrate` with test PR
- [ ] Verify metrics appear in Mimir
- [ ] Import dashboard to local Grafana
- [ ] Run 10 test sessions (5 success, 3 error, 2 interrupted)
- [ ] Verify all dashboard panels show data
- [ ] Test template variable filtering
- [ ] Validate PromQL queries return correct results

#### Performance Tests
- [ ] Measure orchestration runtime before instrumentation
- [ ] Measure orchestration runtime after instrumentation
- [ ] Verify overhead <5%
- [ ] Monitor background exporter memory usage
- [ ] Check Alloy collector for backpressure
- [ ] Verify no blocking in session hot path

#### Production Validation
- [ ] Deploy to dev cluster
- [ ] Run 20 mixed test sessions
- [ ] Verify dashboard accuracy
- [ ] Check metric cardinality (<1000 series)
- [ ] Monitor Alloy logs for errors
- [ ] Monitor Mimir logs for errors
- [ ] Verify dashboard loads in <2s
- [ ] Test on mobile/tablet layout

---

## 📦 Final Steps

- [ ] All tests passing
- [ ] Code review completed
- [ ] Documentation reviewed
- [ ] Merge to main branch
- [ ] Deploy to production
- [ ] Verify dashboard live in production Grafana
- [ ] Team demo scheduled
- [ ] Issue #5 closed

---

## 🔄 Rollback Checklist (If Needed)

- [ ] Set `DISABLE_METRICS_EXPORT=true` env var
- [ ] Restart GWA pods
- [ ] Delete ConfigMap: `kubectl delete cm grafana-dashboard-gwa-sessions -n grafana`
- [ ] Revert code changes if needed
- [ ] Document rollback reason
- [ ] Create follow-up issue for fixes

---

## 📊 Metrics to Monitor During Rollout

| Metric | Threshold | Action if Exceeded |
|--------|-----------|-------------------|
| Orchestration runtime | +5% | Disable metrics export |
| Metric cardinality | 1000 series | Add Alloy relabeling |
| Dashboard load time | 2 seconds | Optimize PromQL queries |
| Alloy errors | >1/min | Check OTLP endpoint |
| Memory usage | +50MB | Investigate exporter |

---

## 🎯 Success Criteria Verification

- [ ] ✅ All 5 functional requirements met (see requirements.md)
- [ ] ✅ Dashboard loads in <2 seconds with 30 days of data
- [ ] ✅ Metrics overhead <5% of session runtime
- [ ] ✅ No breaking changes to existing telemetry
- [ ] ✅ Dashboard follows Grafana best practices
- [ ] ✅ Documentation enables team self-service
- [ ] ✅ No production incidents during rollout
- [ ] ✅ Metric cardinality <1000 unique series

---

**Status**: Planning Complete ✅
**Next**: Begin Phase 1 Implementation
**Estimated Timeline**: 3-4 days with parallelization
