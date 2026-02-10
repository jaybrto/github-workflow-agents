/**
 * Plan Sync - Links plan files to GitHub issues and posts summaries
 *
 * Keeps `.plans/issue-{N}/` files in sync with GitHub issue UI so humans
 * can review plans without leaving GitHub.
 */

import { Octokit } from '@octokit/rest';

interface PlanSyncConfig {
  owner: string;
  repo: string;
  issueNumber: number;
  octokit: Octokit;
}

interface PlanStatus {
  status: 'draft' | 'pending_review' | 'approved' | 'in_progress' | 'completed';
  version: number;
  tasksCount: number;
  filesCount: number;
}

// ============================================================================
// Issue Description Linking
// ============================================================================

/**
 * Add or update plan links in the issue description.
 * Uses HTML comments as markers to find and replace the section.
 */
export async function linkPlanToIssue(
  config: PlanSyncConfig,
  planStatus: PlanStatus
): Promise<void> {
  const { owner, repo, issueNumber, octokit } = config;

  // Get current issue body
  const { data: issue } = await octokit.issues.get({
    owner,
    repo,
    issue_number: issueNumber,
  });

  const planSection = generatePlanLinkSection(issueNumber, planStatus);

  let updatedBody: string;

  if (issue.body?.includes('<!-- GWA-PLAN-LINK -->')) {
    // Update existing link section
    updatedBody = issue.body.replace(
      /<!-- GWA-PLAN-LINK -->[\s\S]*?<!-- \/GWA-PLAN-LINK -->/,
      planSection
    );
  } else {
    // Append plan link section to end of body
    updatedBody = (issue.body || '') + '\n\n' + planSection;
  }

  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    body: updatedBody,
  });
}

/**
 * Generate the plan link section with status indicators.
 */
function generatePlanLinkSection(
  issueNumber: number,
  planStatus: PlanStatus
): string {
  const statusEmoji = getStatusEmoji(planStatus.status);
  const statusText = getStatusText(planStatus.status);

  return `<!-- GWA-PLAN-LINK -->
---
### 🤖 Claude Implementation Plan

| Resource | Link |
|----------|------|
| 📋 Full Plan | [\`.plans/issue-${issueNumber}/plan.md\`](.plans/issue-${issueNumber}/plan.md) |
| ✅ Checklist | [\`.plans/issue-${issueNumber}/checklist.md\`](.plans/issue-${issueNumber}/checklist.md) |
| 📝 Decisions | [\`.plans/issue-${issueNumber}/decisions.md\`](.plans/issue-${issueNumber}/decisions.md) |
| 💻 Code Context | [\`.plans/issue-${issueNumber}/snippets.md\`](.plans/issue-${issueNumber}/snippets.md) |

| Metric | Value |
|--------|-------|
| **Status** | ${statusEmoji} ${statusText} |
| **Version** | v${planStatus.version} |
| **Tasks** | ${planStatus.tasksCount} |
| **Files Changed** | ${planStatus.filesCount} |

<!-- /GWA-PLAN-LINK -->`;
}

function getStatusEmoji(status: PlanStatus['status']): string {
  const emojis: Record<PlanStatus['status'], string> = {
    draft: '📝',
    pending_review: '👀',
    approved: '✅',
    in_progress: '🔄',
    completed: '🎉',
  };
  return emojis[status];
}

function getStatusText(status: PlanStatus['status']): string {
  const texts: Record<PlanStatus['status'], string> = {
    draft: 'Draft - Planning in progress',
    pending_review: 'Pending Review - Awaiting human approval',
    approved: 'Approved - Ready for implementation',
    in_progress: 'In Progress - Implementation underway',
    completed: 'Completed - All tasks done',
  };
  return texts[status];
}

// ============================================================================
// Plan Summary Comments
// ============================================================================

/**
 * Post a collapsible plan summary as an issue comment.
 * Called when planning phase completes.
 */
export async function postPlanSummary(
  config: PlanSyncConfig,
  planContent: string
): Promise<void> {
  const { owner, repo, issueNumber, octokit } = config;

  const summary = extractExecutiveSummary(planContent);
  const taskTable = extractTaskTable(planContent);
  const fileChanges = extractFileChanges(planContent);
  const taskCount = countTasks(planContent);
  const riskAssessment = extractRiskAssessment(planContent);

  const comment = `## 📋 Implementation Plan Complete

${summary}

<details>
<summary><strong>📊 Task Breakdown (${taskCount} tasks)</strong></summary>

${taskTable}

</details>

<details>
<summary><strong>📁 Files to Change</strong></summary>

${fileChanges}

</details>

<details>
<summary><strong>⚠️ Risk Assessment</strong></summary>

${riskAssessment}

</details>

---
### Next Steps

1. **Review** the [full plan](.plans/issue-${issueNumber}/plan.md)
2. **Check** the [design decisions](.plans/issue-${issueNumber}/decisions.md) for Q&A log
3. **Approve** by moving the project item to "In Progress"

> 💡 The plan includes ${taskCount} parallelizable tasks. Estimated implementation time will depend on task dependencies.`;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: comment,
  });
}

/**
 * Post a planning question as an issue comment.
 * Used during planning phase when Claude needs clarification.
 */
export async function postPlanningQuestion(
  config: PlanSyncConfig,
  question: string,
  context: string,
  questionNumber: number
): Promise<void> {
  const { owner, repo, issueNumber, octokit } = config;

  const comment = `## 🤔 Planning Question #${questionNumber}

${context}

---

**Question:**
> ${question}

---

Please reply with your answer. Use \`@claude-answer:\` prefix for structured responses, or just reply normally.`;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: comment,
  });
}

/**
 * Post progress update during implementation.
 */
export async function postProgressUpdate(
  config: PlanSyncConfig,
  completedTasks: string[],
  inProgressTasks: string[],
  blockedTasks: string[],
  overallProgress: number
): Promise<void> {
  const { owner, repo, issueNumber, octokit } = config;

  const progressBar = generateProgressBar(overallProgress);

  const comment = `## 📊 Implementation Progress Update

${progressBar} **${overallProgress}%**

### ✅ Completed (${completedTasks.length})
${completedTasks.map(t => `- [x] ${t}`).join('\n') || '_None yet_'}

### 🔄 In Progress (${inProgressTasks.length})
${inProgressTasks.map(t => `- [ ] ${t}`).join('\n') || '_None_'}

### 🚫 Blocked (${blockedTasks.length})
${blockedTasks.map(t => `- ⚠️ ${t}`).join('\n') || '_None_'}

---
_Auto-updated by Claude. See [checklist](.plans/issue-${issueNumber}/checklist.md) for details._`;

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: comment,
  });
}

function generateProgressBar(percent: number): string {
  const filled = Math.round(percent / 5);
  const empty = 20 - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

// ============================================================================
// Plan Content Extraction
// ============================================================================

function extractExecutiveSummary(planContent: string): string {
  const match = planContent.match(
    /## Executive Summary\s*\n\s*(?:<!--.*?-->\s*)?\n?([\s\S]*?)(?=\n---|\n##)/
  );
  return match?.[1]?.trim() || '_No summary available_';
}

function extractTaskTable(planContent: string): string {
  // Extract task definitions from Agent Orchestration section
  const taskMatches = planContent.matchAll(
    /#### Task \d+: (.+?)\n\n```yaml\n([\s\S]*?)```/g
  );

  const tasks: Array<{ id: string; name: string; complexity: string; deps: string }> = [];

  for (const match of taskMatches) {
    const name = match[1];
    const yaml = match[2];

    const idMatch = yaml.match(/task_id: "(.+?)"/);
    const complexityMatch = yaml.match(/complexity: (.+)/);
    const depsMatch = yaml.match(/blocked_by: \[(.*?)\]/);

    tasks.push({
      id: idMatch?.[1] || 'unknown',
      name,
      complexity: complexityMatch?.[1] || 'unknown',
      deps: depsMatch?.[1] || 'none',
    });
  }

  if (tasks.length === 0) {
    return '_No tasks defined_';
  }

  const header = '| Task ID | Name | Complexity | Dependencies |\n|---------|------|------------|--------------|';
  const rows = tasks.map(
    t => `| ${t.id} | ${t.name} | ${t.complexity} | ${t.deps || 'none'} |`
  );

  return `${header}\n${rows.join('\n')}`;
}

function extractFileChanges(planContent: string): string {
  const match = planContent.match(
    /### File Changes\s*\n\s*(?:<!--.*?-->\s*)?\n?([\s\S]*?)(?=\n###|\n##|\n---)/
  );
  return match?.[1]?.trim() || '_No file changes listed_';
}

function extractRiskAssessment(planContent: string): string {
  const match = planContent.match(
    /## Risk Assessment\s*\n([\s\S]*?)(?=\n---|\n##)/
  );
  return match?.[1]?.trim() || '_No risks identified_';
}

function countTasks(planContent: string): number {
  const matches = planContent.match(/#### Task \d+:/g);
  return matches?.length || 0;
}

// ============================================================================
// Project Item Custom Field Sync
// ============================================================================

/**
 * Update GitHub Project item custom fields with plan metadata.
 */
export async function syncPlanToProjectItem(
  config: PlanSyncConfig,
  projectItemId: string,
  planContent: string,
  planStatus: PlanStatus
): Promise<void> {
  const summary = extractExecutiveSummary(planContent).slice(0, 100);

  // Note: Actual implementation would need to:
  // 1. Get project ID and field IDs via GraphQL query
  // 2. Update each field with updateProjectV2ItemFieldValue mutation
  // 3. Use config.octokit.graphql() for the mutation
  // This is a simplified example showing the pattern

  console.log(`[plan-sync] Would update project item ${projectItemId}:`, {
    planFile: `.plans/issue-${config.issueNumber}/plan.md`,
    planStatus: planStatus.status,
    planVersion: planStatus.version,
    planSummary: summary,
    tasksCount: planStatus.tasksCount,
    filesCount: planStatus.filesCount,
  });

  // TODO: Implement GraphQL mutation when projects.ts is complete
  // await config.octokit.graphql(updateProjectItemMutation, { ... });
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Full sync: Update issue description, post summary, update project item.
 * Called when planning phase completes.
 */
export async function fullPlanSync(
  config: PlanSyncConfig,
  planContent: string,
  projectItemId: string
): Promise<void> {
  const planStatus: PlanStatus = {
    status: 'pending_review',
    version: extractPlanVersion(planContent),
    tasksCount: countTasks(planContent),
    filesCount: countFileChanges(planContent),
  };

  // Update issue description with plan links
  await linkPlanToIssue(config, planStatus);

  // Post plan summary as comment
  await postPlanSummary(config, planContent);

  // Update project item custom fields
  await syncPlanToProjectItem(config, projectItemId, planContent, planStatus);
}

function extractPlanVersion(planContent: string): number {
  const match = planContent.match(/\*\*Version:\*\* (\d+)/);
  return parseInt(match?.[1] || '1', 10);
}

function countFileChanges(planContent: string): number {
  const matches = planContent.match(/\| (CREATE|MODIFY|DELETE) \|/g);
  return matches?.length || 0;
}

export default {
  linkPlanToIssue,
  postPlanSummary,
  postPlanningQuestion,
  postProgressUpdate,
  syncPlanToProjectItem,
  fullPlanSync,
};
