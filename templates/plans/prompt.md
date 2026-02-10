# Implementation Prompt: {{ISSUE_TITLE}}

**Issue:** #{{ISSUE_NUMBER}}
**Role:** {{ROLE}} <!-- architect | worker -->
**Task ID:** {{TASK_ID}} <!-- For workers: task-001, task-002, etc. For architect: "orchestrator" -->

---

## Context

You are implementing Issue #{{ISSUE_NUMBER}}: **{{ISSUE_TITLE}}**

{{#if ROLE === "architect"}}
You are the **Architect** agent responsible for orchestrating this implementation. You will:
1. Spawn worker agents for each task in the plan
2. Monitor their progress via the `agent_tasks` SQLite table
3. Aggregate results and handle failures
4. Update the project item status as work progresses
{{/if}}

{{#if ROLE === "worker"}}
You are a **Worker** agent assigned to: **{{TASK_NAME}}**

Your scope is LIMITED to:
{{SCOPE_FILES}}

Do NOT modify files outside your scope. Report blockers to the Architect.
{{/if}}

---

## Implementation Plan

The complete implementation plan is available at:
```
.plans/issue-{{ISSUE_NUMBER}}/plan.md
```

Read it now to understand the full context.

### Your Specific Task

{{#if ROLE === "architect"}}
Orchestrate the following tasks:

{{TASK_SUMMARY_TABLE}}

Spawn workers in order respecting dependencies. Use `/setup-safety` before any git operations.
{{/if}}

{{#if ROLE === "worker"}}
**Task:** {{TASK_ID}} - {{TASK_NAME}}
**Complexity:** {{COMPLEXITY}}
**Estimated Hours:** {{ESTIMATED_HOURS}}

**Description:**
{{TASK_DESCRIPTION}}

**Files to modify:**
{{SCOPE_FILES}}

**Inputs (from other tasks or existing code):**
{{INPUTS}}

**Expected outputs:**
{{OUTPUTS}}

**Validation criteria:**
{{VALIDATION_STEPS}}
{{/if}}

---

## Skills to Use

{{#if SKILLS}}
You have access to these skills for this task:

{{#each SKILLS}}
- `{{this.command}}` - {{this.description}}
{{/each}}

Invoke skills when appropriate. Example: `/setup-safety` before commits.
{{/if}}

---

## Constraints

### MUST DO
- [ ] Read the full plan before starting
- [ ] Follow the technical design exactly
- [ ] Run validation steps before marking complete
- [ ] Update progress in SQLite (`agent_tasks` table)
- [ ] Create checkpoint before major actions (commits, PRs)

### MUST NOT
- [ ] Modify files outside your assigned scope
- [ ] Skip tests or validation
- [ ] Push to remote without explicit approval
- [ ] Install dependencies not listed in plan
- [ ] Deviate from approved architecture

### IF BLOCKED
1. Update your task status to "blocked" in SQLite
2. Post a comment on the issue explaining the blocker
3. Wait for human response or Architect intervention

---

## Progress Reporting

{{#if ROLE === "worker"}}
Update your progress regularly:

```sql
UPDATE agent_tasks
SET progress_pct = {{PROGRESS}},
    last_status_message = '{{STATUS_MESSAGE}}',
    task_status = '{{running | blocked | completed | failed}}'
WHERE task_id = '{{TASK_ID}}' AND session_id = 'issue-{{ISSUE_NUMBER}}';
```

Progress milestones:
- 0% - Task started
- 25% - Files created/identified
- 50% - Core implementation done
- 75% - Tests written
- 90% - Validation passing
- 100% - Complete, ready for review
{{/if}}

{{#if ROLE === "architect"}}
Monitor worker progress:

```sql
SELECT task_id, agent_id, task_status, progress_pct, last_status_message
FROM agent_tasks
WHERE session_id = 'issue-{{ISSUE_NUMBER}}'
ORDER BY task_id;
```

Update project item as milestones complete:
- All tasks started → Update custom field "Progress" to 25%
- Half tasks complete → Update "Progress" to 50%
- All tasks complete → Move to "QA" column
{{/if}}

---

## Quick Reference

For commands and debugging, see:
```
.plans/issue-{{ISSUE_NUMBER}}/checklist.md
```

---

## Begin

{{#if ROLE === "architect"}}
1. Read `.plans/issue-{{ISSUE_NUMBER}}/plan.md`
2. Verify all dependencies are satisfied
3. Run `/setup-safety` to initialize git safety
4. Spawn first batch of workers (those with no blockers)
5. Monitor progress and spawn dependent tasks as blockers clear
{{/if}}

{{#if ROLE === "worker"}}
1. Read `.plans/issue-{{ISSUE_NUMBER}}/plan.md` (full context)
2. Read your task section in the plan
3. Set your task status to "running"
4. Implement according to the design
5. Run validation steps
6. Set your task status to "completed" with 100% progress
{{/if}}

**Start now.**
