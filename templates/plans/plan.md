# Implementation Plan: {{ISSUE_TITLE}}

**Issue:** #{{ISSUE_NUMBER}}
**Created:** {{CREATED_AT}}
**Version:** {{VERSION}}
**Status:** {{STATUS}} <!-- draft | pending_review | approved | in_progress | completed -->

---

## Executive Summary

<!-- 2-3 sentences describing what this issue accomplishes and why it matters -->

{{SUMMARY}}

---

## Requirements

### Functional Requirements

<!-- What the system must DO - user-facing behavior -->

1. {{REQUIREMENT_1}}
2. {{REQUIREMENT_2}}
3. {{REQUIREMENT_3}}

### Non-Functional Requirements

<!-- Performance, security, scalability, maintainability -->

- [ ] {{NFR_1}}
- [ ] {{NFR_2}}

### Acceptance Criteria

<!-- Specific, testable conditions that must be true when complete -->

- [ ] {{AC_1}}
- [ ] {{AC_2}}
- [ ] {{AC_3}}

---

## Technical Design

### Architecture Overview

<!-- High-level design, diagrams if helpful -->

```
{{ARCHITECTURE_DIAGRAM}}
```

### File Changes

<!-- Every file that will be created, modified, or deleted -->

| Action | File Path | Description |
|--------|-----------|-------------|
| CREATE | `{{FILE_PATH}}` | {{DESCRIPTION}} |
| MODIFY | `{{FILE_PATH}}` | {{DESCRIPTION}} |
| DELETE | `{{FILE_PATH}}` | {{DESCRIPTION}} |

### Database Changes

<!-- New tables, columns, migrations - leave empty if N/A -->

```sql
{{SCHEMA_CHANGES}}
```

### API Changes

<!-- New endpoints, modified signatures - leave empty if N/A -->

| Method | Endpoint | Description |
|--------|----------|-------------|
| {{METHOD}} | `{{ENDPOINT}}` | {{DESCRIPTION}} |

### Dependencies

<!-- New packages, version changes -->

| Package | Version | Reason |
|---------|---------|--------|
| {{PACKAGE}} | {{VERSION}} | {{REASON}} |

---

## Agent Orchestration

### Architect Configuration

```yaml
architect:
  session_id: "issue-{{ISSUE_NUMBER}}"
  tmux_window: 1
  skills:
    - {{SKILL_1}}  # e.g., "setup-safety" - git safety measures
    - {{SKILL_2}}  # e.g., "deep-research" - if more research needed
  capabilities:
    - spawn_workers
    - aggregate_results
    - update_plan
    - move_project_item
  max_workers: {{MAX_WORKERS}}  # Recommended: 3-5
  coordination_strategy: {{STRATEGY}}  # parallel | sequential | dependency_graph
```

### Worker Tasks

<!-- Each discrete unit of work that can be assigned to a sub-agent -->

#### Task 1: {{TASK_1_NAME}}

```yaml
task_id: "task-001"
agent_type: worker
tmux_window: 2  # Architect is 1, workers start at 2
estimated_hours: {{HOURS}}
complexity: {{low | medium | high}}
risk_level: {{low | medium | high}}

skills:
  - {{SKILL}}  # Skills this worker should use

scope:
  files:
    - {{FILE_1}}
    - {{FILE_2}}
  description: |
    {{DETAILED_TASK_DESCRIPTION}}

inputs:
  - {{INPUT_1}}  # What this task needs from other tasks or existing code

outputs:
  - {{OUTPUT_1}}  # What this task produces for other tasks

dependencies:
  blocked_by: []  # Task IDs that must complete first
  blocks: ["task-002"]  # Task IDs waiting on this

validation:
  - {{VALIDATION_STEP_1}}  # How to verify this task is complete
  - {{VALIDATION_STEP_2}}
```

#### Task 2: {{TASK_2_NAME}}

```yaml
task_id: "task-002"
agent_type: worker
tmux_window: 3
estimated_hours: {{HOURS}}
complexity: {{low | medium | high}}
risk_level: {{low | medium | high}}

skills:
  - {{SKILL}}

scope:
  files:
    - {{FILE_1}}
  description: |
    {{DETAILED_TASK_DESCRIPTION}}

inputs:
  - "Output from task-001"

outputs:
  - {{OUTPUT_1}}

dependencies:
  blocked_by: ["task-001"]
  blocks: []

validation:
  - {{VALIDATION_STEP_1}}
```

<!-- Add more tasks as needed -->

### Dependency Graph

```
{{DEPENDENCY_DIAGRAM}}

Example:
task-001 ─┬─► task-002 ───► task-004
          │
          └─► task-003 ───► task-005
                              │
task-006 (independent) ◄──────┘
```

### Skill Reference

<!-- Skills available for assignment to agents -->

| Skill | Command | Use When |
|-------|---------|----------|
| Git Safety | `/setup-safety` | Before any git operations |
| Deep Research | `/deep-research` | Complex questions needing web search |
| Code Navigation | `/setup-code-navigation` | Setting up LSP for new codebase |
| Parallel TDD | `/parallel-tdd` | Test-driven feature development |
| Update Docs | `/update-docs` | After completing features |
| Handoff | `/handoff` | Creating context for next session |

---

## Risk Assessment

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| {{RISK_1}} | {{L/M/H}} | {{L/M/H}} | {{MITIGATION}} |

### Rollback Plan

<!-- How to undo changes if something goes wrong -->

{{ROLLBACK_STEPS}}

---

## Testing Strategy

### Unit Tests

<!-- New test files, coverage targets -->

| Test File | Covers | Priority |
|-----------|--------|----------|
| `{{TEST_FILE}}` | {{COVERAGE}} | {{P1/P2/P3}} |

### Integration Tests

<!-- Cross-component testing -->

{{INTEGRATION_TEST_PLAN}}

### E2E Tests (Playwright)

<!-- User journey tests that run in QA column -->

| Test | User Journey | Critical Path |
|------|-------------|---------------|
| `{{TEST_NAME}}` | {{JOURNEY}} | {{YES/NO}} |

---

## Optional Sections

<!-- Include these sections only if relevant to this issue -->

### Migration Plan

<!-- For breaking changes, data migrations -->

{{MIGRATION_STEPS}}

### Feature Flags

<!-- If gradual rollout needed -->

| Flag | Default | Description |
|------|---------|-------------|
| `{{FLAG_NAME}}` | `{{VALUE}}` | {{DESCRIPTION}} |

### Documentation Updates

<!-- README, API docs, user guides -->

| Document | Changes |
|----------|---------|
| `{{DOC_PATH}}` | {{CHANGES}} |

### Performance Benchmarks

<!-- If performance-sensitive -->

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| {{METRIC}} | {{CURRENT}} | {{TARGET}} | {{METHOD}} |

---

## Approval

- [ ] **Technical Review:** Plan reviewed by human
- [ ] **Scope Confirmed:** All requirements addressed
- [ ] **Risks Accepted:** Mitigation strategies approved
- [ ] **Ready for Implementation:** Move to In Progress

**Approved By:** {{APPROVER}}
**Approved At:** {{APPROVED_AT}}
**Notes:** {{APPROVAL_NOTES}}

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1 | {{DATE}} | Initial plan |
