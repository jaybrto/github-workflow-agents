# Requirements Analysis - Issue #5

## Functional Requirements

### FR1: Session Lifecycle Visualization
Display session state transitions and distribution across statuses:
- `pending` → `starting` → `running` → `complete`
- Error paths: `→ error`, `→ interrupted`
- `blocked` state for waiting on user input

**Acceptance Criteria:**
- Panel showing current distribution of sessions by status
- Time-series graph of session state transitions
- Average time spent in each state

### FR2: Success Rate Metrics
Track and display session outcomes:
- Success rate: `complete / (complete + error + interrupted)`
- Breakdown by repository and trigger type
- Historical trends (24h, 7d, 30d)

**Acceptance Criteria:**
- Gauge showing current success rate percentage
- Graph showing success rate over time
- Table showing per-repository success rates

### FR3: Session Duration Histograms
Visualize session execution time distributions:
- Duration from `started_at` to `completed_at`
- Breakdown by outcome (complete vs error vs interrupted)
- p50, p90, p95, p99 percentiles

**Acceptance Criteria:**
- Histogram panel showing duration distribution
- Table showing percentiles
- Alert threshold for sessions exceeding 30 minutes

### FR4: Agent Resource Usage
Monitor resource consumption per session:
- Tool usage frequency (Read, Edit, Bash, Task, etc.)
- Prompts sent per session
- Commits created per session
- Questions asked (interactive sessions)

**Acceptance Criteria:**
- Bar chart of tool usage frequency
- Average prompts/commits/questions per session
- Identify most resource-intensive sessions

### FR5: Real-Time Active Sessions
Current operational view:
- Active session count (already exists as `gwa_sessions_active`)
- Sessions by repository
- Longest running session duration

**Acceptance Criteria:**
- Single stat panel for active count
- Table of currently running sessions
- Alert for sessions stuck >1 hour

## Non-Functional Requirements

### NFR1: Low Overhead
Metrics collection must not impact session performance:
- Use existing OTLP infrastructure (Alloy → Mimir)
- Emit metrics asynchronously
- No database queries in hot path (batch updates)

### NFR2: Grafana Best Practices
Dashboard follows Grafana design patterns:
- Use templating for repository/time range filters
- Consistent color scheme (green=success, red=error, yellow=interrupted)
- Responsive layout (works on desktop and mobile)
- Include panel descriptions with PromQL queries

### NFR3: Historical Data Retention
Metrics stored with appropriate retention:
- Mimir default retention: 30 days
- Sample interval: 15s (default scrape)
- Aggregation for long-term trends

### NFR4: Extensibility
Dashboard structure supports future enhancements:
- Template variables for filtering
- Reusable panel JSON fragments
- Documented PromQL queries for custom exploration

## Data Sources

### Existing Data (SQLite)
Rich session tracking available in `schema.sql`:
- `sessions` table: 20+ fields including status, timestamps, metadata
- `activity_log` table: Event audit trail
- `tool_calls` table: Every tool invocation
- `prompts` table: All inputs sent to Claude
- `commits` table: Git commits made
- `questions` table: Interactive Q&A tracking
- `agent_tasks` table: Swarm worker task status

### Current OTEL Metrics (Mimir)
From `src/lib/telemetry.ts`:
- `gwa_sessions_active` (UpDownCounter) - Currently active sessions
- `gwa_claude_duration_seconds` (Histogram) - Claude CLI invocation duration
- `gwa_orchestration_duration_seconds` (Histogram) - Full orchestration duration
- `gwa_pr_orchestrations_total` (Counter) - PR processing runs
- `gwa_claude_invocations_total` (Counter) - Claude CLI calls

### Metrics to Add
New metrics needed for dashboard:
1. **Session Outcomes** (Counter)
   - `gwa_sessions_completed_total{repo, status, type}`
   - status: complete | error | interrupted
   - type: feature | pr | review

2. **Session Duration** (Histogram)
   - `gwa_session_duration_seconds{repo, status, type}`
   - Buckets: [30, 60, 120, 300, 600, 1800, 3600]

3. **Tool Usage** (Counter)
   - `gwa_tool_calls_total{tool_name, session_id, success}`
   - Already tracked in DB, need OTEL export

4. **Interactive Sessions** (Counter)
   - `gwa_questions_asked_total{repo}`
   - `gwa_questions_answered_total{repo}`

5. **Question Latency** (Histogram)
   - `gwa_question_response_seconds{repo}`
   - Time from asked_at to answered_at

6. **Commits Created** (Counter)
   - `gwa_commits_created_total{repo, session_id}`

7. **Agent Task Completion** (Counter)
   - `gwa_agent_tasks_total{status, agent_type}`
   - status: completed | failed | blocked

## Out of Scope

The following are explicitly NOT included in this issue:
- Alerting rules configuration (separate issue)
- Grafana datasource provisioning (already configured)
- Real-time log streaming in dashboard
- Trace correlation UI (use Tempo directly)
- Cost analysis metrics
- GitHub API rate limit tracking (separate concern)

## Success Metrics

Dashboard is successful if:
1. ✅ All 5 functional requirements implemented
2. ✅ Dashboard loads in <2s with 30 days of data
3. ✅ Metrics overhead <5% of session runtime
4. ✅ No breaking changes to existing telemetry
5. ✅ Documentation allows team members to customize dashboard
