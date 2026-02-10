# Planning Templates

These templates are used during the **Planning** column phase to create a complete orchestration blueprint for issue implementation.

## Template Structure

```
.plans/issue-{N}/
├── plan.md          # Full implementation spec (REQUIRED)
├── prompt.md        # Injection prompt for agents (REQUIRED)
├── checklist.md     # Progress tracking (REQUIRED)
├── decisions.md     # Q&A and design decisions (REQUIRED)
└── snippets.md      # Code context for workers (OPTIONAL)
```

## Template Descriptions

| Template | Purpose | When Created | Updated By |
|----------|---------|--------------|------------|
| `plan.md` | Technical design, file changes, agent orchestration | Planning phase | Planning agent |
| `prompt.md` | Prompt injected into REPL when work begins | Planning phase | Planning agent |
| `checklist.md` | Validation steps, progress tracking, quick commands | Planning → Implementation | All agents |
| `decisions.md` | Q&A log, design decisions, assumptions | Planning phase | Planning agent |
| `snippets.md` | Relevant code excerpts for worker context | Planning phase | Planning agent |

## Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│  TODO Column                                                         │
│  ├─ Issue created by human                                          │
│  └─ Triggers: Planning agent spawned                                │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PLANNING Column                                                     │
│  ├─ Planning agent reads issue, explores codebase                   │
│  ├─ Creates: plan.md, prompt.md, checklist.md, decisions.md         │
│  ├─ Asks clarifying questions (logged in decisions.md)              │
│  ├─ Gathers code context (snippets.md)                              │
│  └─ Moves item to REVIEW when complete                              │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  REVIEW Column (Human Gate)                                          │
│  ├─ Human reviews plan.md                                           │
│  ├─ Approves or requests changes                                    │
│  └─ Sets plan_approved = 1, moves to IN PROGRESS                    │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  IN PROGRESS Column                                                  │
│  ├─ Architect agent spawned                                         │
│  ├─ prompt.md (architect version) injected into REPL               │
│  ├─ Architect reads plan.md, spawns workers per task breakdown      │
│  ├─ Workers get prompt.md (worker version) with their task scope    │
│  ├─ Workers read snippets.md for code context                       │
│  ├─ All agents update checklist.md as they progress                │
│  └─ Architect moves item to QA when all tasks complete              │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  QA Column                                                           │
│  ├─ Playwright E2E tests triggered automatically                    │
│  ├─ Results logged in checklist.md                                  │
│  ├─ PASS → Move to REVIEW (PR review)                               │
│  └─ FAIL → Move to BLOCKED, log failures                            │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent Orchestration

The `plan.md` template includes a complete agent orchestration section:

```yaml
architect:
  skills: ["/setup-safety", "/handoff"]
  max_workers: 5
  coordination_strategy: dependency_graph

tasks:
  - task_id: task-001
    agent_type: worker
    skills: ["/parallel-tdd"]
    scope:
      files: ["src/lib/auth.ts", "src/lib/auth.test.ts"]
    dependencies:
      blocked_by: []
      blocks: ["task-002", "task-003"]
```

## Prompt Injection

When an item moves to **In Progress**, the system:

1. Reads `.plans/issue-{N}/prompt.md`
2. Generates architect prompt (if orchestrating) or worker prompt (if single task)
3. Injects into tmux REPL:

```typescript
const prompt = await Bun.file(`.plans/issue-${n}/prompt.md`).text();
const plan = await Bun.file(`.plans/issue-${n}/plan.md`).text();

// For architect
const architectPrompt = renderTemplate(prompt, {
  ROLE: 'architect',
  ISSUE_NUMBER: n,
  TASK_SUMMARY_TABLE: generateTaskTable(plan),
});

tmux.sendKeys('claude', Enter);
await sleep(2000);
tmux.sendKeys(architectPrompt, Enter);
```

## Skills Reference

Available skills that can be assigned to agents:

| Skill | Command | Best For |
|-------|---------|----------|
| Git Safety | `/setup-safety` | Always use before git ops |
| Deep Research | `/deep-research` | Complex questions, web search |
| Parallel TDD | `/parallel-tdd` | Test-driven development |
| Code Navigation | `/setup-code-navigation` | LSP setup for unfamiliar code |
| Update Docs | `/update-docs` | README, CHANGELOG updates |
| Handoff | `/handoff` | Context for next session |

## Usage

### Creating Plans (Manual)

```bash
# Copy templates to issue directory
mkdir -p .plans/issue-42
cp templates/plans/*.md .plans/issue-42/

# Edit templates with issue-specific content
$EDITOR .plans/issue-42/plan.md
```

### Creating Plans (Automated)

When an item enters the **Planning** column:

```typescript
// Planning agent is spawned with this prompt
const planningPrompt = `
You are a planning agent for Issue #${issueNumber}.

Create a complete implementation plan in .plans/issue-${issueNumber}/ using templates from templates/plans/.

Required outputs:
- plan.md - Full technical design with agent orchestration
- prompt.md - Injection prompts for architect and workers
- checklist.md - Validation steps and progress tracking
- decisions.md - Log all questions and design decisions

Ask clarifying questions as needed. Move to REVIEW when plan is complete.
`;
```

## Validation

Before moving from **Planning** to **Review**, verify:

- [ ] `plan.md` has all required sections filled
- [ ] `plan.md` agent orchestration is complete
- [ ] All tasks have clear scope, inputs, outputs
- [ ] Dependencies form valid DAG (no cycles)
- [ ] `prompt.md` templates render correctly
- [ ] `checklist.md` has issue-specific validation steps
- [ ] `decisions.md` logs any questions asked
- [ ] `snippets.md` has relevant code context (if complex issue)

---

**Template Version:** 1.0
**Last Updated:** February 9, 2026
