# Implementation Checklist: {{ISSUE_TITLE}}

**Issue:** #{{ISSUE_NUMBER}}
**Started:** {{STARTED_AT}}
**Last Updated:** {{UPDATED_AT}}

---

## Overall Progress

| Phase | Status | Started | Completed |
|-------|--------|---------|-----------|
| Planning | {{STATUS}} | {{DATE}} | {{DATE}} |
| Review | {{STATUS}} | {{DATE}} | {{DATE}} |
| Implementation | {{STATUS}} | {{DATE}} | {{DATE}} |
| QA | {{STATUS}} | {{DATE}} | {{DATE}} |
| Merge | {{STATUS}} | {{DATE}} | {{DATE}} |

**Current Column:** {{CURRENT_COLUMN}}

---

## Task Progress

<!-- Auto-updated by agents -->

| Task ID | Name | Agent | Status | Progress | Window |
|---------|------|-------|--------|----------|--------|
| task-001 | {{NAME}} | {{AGENT_ID}} | {{STATUS}} | {{PCT}}% | {{WINDOW}} |
| task-002 | {{NAME}} | {{AGENT_ID}} | {{STATUS}} | {{PCT}}% | {{WINDOW}} |
| task-003 | {{NAME}} | {{AGENT_ID}} | {{STATUS}} | {{PCT}}% | {{WINDOW}} |

**Legend:** `pending` → `running` → `completed` | `blocked` | `failed`

---

## Validation Checklist

### Pre-Implementation
- [ ] Plan approved by human
- [ ] All dependencies available
- [ ] Git safety initialized (`/setup-safety`)
- [ ] Working branch created

### During Implementation
- [ ] All files created per plan
- [ ] No files modified outside scope
- [ ] Checkpoints created before commits
- [ ] Progress updated in SQLite

### Pre-QA
- [ ] All tasks marked complete
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] Code follows project conventions
- [ ] No hardcoded secrets
- [ ] No TODO comments left behind

### QA Phase
- [ ] E2E tests triggered
- [ ] All Playwright tests passing
- [ ] Performance benchmarks met (if applicable)
- [ ] Manual testing completed (if required)

### Pre-Merge
- [ ] PR created with proper description
- [ ] All CI checks passing
- [ ] Code review approved
- [ ] No merge conflicts
- [ ] Documentation updated

---

## Quick Commands

### Check Task Status
```bash
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT task_id, task_status, progress_pct, last_status_message
   FROM agent_tasks WHERE session_id = 'issue-{{ISSUE_NUMBER}}'"
```

### View Architect Window
```bash
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work:1
```

### View Worker Window
```bash
# Replace N with worker's tmux_window number
kubectl exec -it claude-runner-0 -- tmux attach-session -t claude-work:N
```

### List All Windows
```bash
kubectl exec claude-runner-0 -- tmux list-windows -t claude-work
```

### Force Task Completion (Emergency)
```bash
kubectl exec claude-runner-0 -- sqlite3 /home/runner/.claude/gwa.db \
  "UPDATE agent_tasks SET task_status = 'completed', progress_pct = 100, completed_at = unixepoch()
   WHERE task_id = 'task-001' AND session_id = 'issue-{{ISSUE_NUMBER}}'"
```

### Move to Next Column (Emergency)
```bash
kubectl exec claude-runner-0 -- bun run /home/runner/src/lib/projects.ts move \
  --item {{PROJECT_ITEM_ID}} --column "QA"
```

### View Last Checkpoint
```bash
kubectl exec claude-runner-0 -- sqlite3 -header -column /home/runner/.claude/gwa.db \
  "SELECT checkpoint_type, summary, datetime(created_at, 'unixepoch')
   FROM checkpoints WHERE session_id = 'issue-{{ISSUE_NUMBER}}' ORDER BY created_at DESC LIMIT 1"
```

---

## Files Changed

<!-- Auto-populated as implementation progresses -->

| File | Action | Task | Verified |
|------|--------|------|----------|
| {{FILE_PATH}} | {{CREATE/MODIFY/DELETE}} | {{TASK_ID}} | [ ] |

---

## Test Results

### Unit Tests
```
{{UNIT_TEST_OUTPUT}}
```
**Result:** {{PASS/FAIL}} ({{PASSED}}/{{TOTAL}})

### Integration Tests
```
{{INTEGRATION_TEST_OUTPUT}}
```
**Result:** {{PASS/FAIL}} ({{PASSED}}/{{TOTAL}})

### E2E Tests (Playwright)
```
{{E2E_TEST_OUTPUT}}
```
**Result:** {{PASS/FAIL}} ({{PASSED}}/{{TOTAL}})

---

## Blockers & Issues

<!-- Log any problems encountered -->

| Timestamp | Task | Issue | Resolution |
|-----------|------|-------|------------|
| {{TIMESTAMP}} | {{TASK_ID}} | {{ISSUE_DESCRIPTION}} | {{RESOLUTION}} |

---

## Timeline

<!-- Auto-updated event log -->

| Time | Event | Actor | Details |
|------|-------|-------|---------|
| {{TIME}} | Plan created | planning-agent | Version 1 |
| {{TIME}} | Plan approved | {{HUMAN}} | Ready for implementation |
| {{TIME}} | Implementation started | architect | Spawned {{N}} workers |
| {{TIME}} | Task completed | worker-001 | task-001 at 100% |
| {{TIME}} | All tasks complete | architect | Moving to QA |
| {{TIME}} | QA passed | qa-runner | 15/15 tests passed |
| {{TIME}} | PR merged | {{HUMAN}} | Issue closed |

---

## Notes

<!-- Free-form notes added during implementation -->

{{NOTES}}

---

**Checklist Version:** 1
**Plan Version:** {{PLAN_VERSION}}
**Last Synced:** {{SYNC_TIME}}
