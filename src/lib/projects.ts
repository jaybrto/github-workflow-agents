/**
 * GitHub Projects v2 Integration
 *
 * GraphQL API for managing GitHub Projects v2 - status updates, custom fields,
 * and column-based workflow triggers.
 *
 * Supports both organization and personal (user) projects via GWA_PROJECT_OWNER_TYPE.
 */

import { getOctokit } from "./github.js";
import { withSpan, Metrics, log } from "./telemetry.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Project owner type - determines which GraphQL queries to use.
 * Set via GWA_PROJECT_OWNER_TYPE env var.
 * - "organization": Project is owned by a GitHub organization (default)
 * - "user": Project is owned by a personal GitHub account
 */
export type ProjectOwnerType = "organization" | "user";

export function getProjectOwnerType(): ProjectOwnerType {
  const envValue = process.env.GWA_PROJECT_OWNER_TYPE?.toLowerCase();
  if (envValue === "user") {
    return "user";
  }
  return "organization"; // default
}

// ============================================================================
// Types
// ============================================================================

export interface ProjectItem {
  id: string;
  content: {
    type: "Issue" | "PullRequest" | "DraftIssue";
    number: number;
    title: string;
    url: string;
  };
  fieldValues: FieldValue[];
}

export interface FieldValue {
  fieldId: string;
  fieldName: string;
  value: string | number | Date | null;
}

export interface ProjectColumn {
  id: string;
  name: string;
  optionId: string; // For single select status field
}

export interface ProjectField {
  id: string;
  name: string;
  dataType: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT" | "ITERATION";
  options?: Array<{ id: string; name: string }>;
}

export interface Project {
  id: string;
  number: number;
  title: string;
  url: string;
  fields: ProjectField[];
  statusField: ProjectField;
}

// Column name constants - must match GitHub Project configuration
export const COLUMNS = {
  TODO: "Todo",
  PLANNING: "Planning",
  IN_PROGRESS: "In Progress",
  QA: "QA",
  BLOCKED: "Blocked",
  REVIEW: "Review",
  DONE: "Done",
} as const;

export type ColumnName = (typeof COLUMNS)[keyof typeof COLUMNS];

// Custom field names
export const CUSTOM_FIELDS = {
  ESTIMATED_HOURS: "Estimated Hours",
  COMPLEXITY: "Complexity",
  RISK_LEVEL: "Risk Level",
  ASSIGNED_AGENT: "Assigned Agent",
  SESSION_ID: "Session ID",
  PLAN_VERSION: "Plan Version",
  PLAN_STATUS: "Plan Status",
  TASKS_COUNT: "Tasks Count",
  TASKS_COMPLETED: "Tasks Completed",
  BLOCKED_REASON: "Blocked Reason",
  QA_STATUS: "QA Status",
  QA_RUN_ID: "QA Run ID",
  BRANCH_NAME: "Branch Name",
  PR_NUMBER: "PR Number",
  CREATED_BY: "Created By",
  STARTED_AT: "Started At",
  COMPLETED_AT: "Completed At",
  DURATION_HOURS: "Duration Hours",
  // Phase 15 (v3.4) - Enhanced session fields
  POD_NAME: "Pod Name",
  TMUX_WINDOW: "Tmux Window",
  KUBECTL_COMMAND: "Kubectl Command",
  WORKTREE_PATH: "Worktree Path",
  SUB_AGENTS_USED: "Sub Agents Used",
} as const;

// ============================================================================
// GraphQL Queries
// ============================================================================

/**
 * Build the GET_PROJECT query for the appropriate owner type.
 */
function buildGetProjectQuery(ownerType: ProjectOwnerType): string {
  const ownerField = ownerType === "user" ? "user" : "organization";
  return `
    query GetProject($owner: String!, $number: Int!) {
      ${ownerField}(login: $owner) {
        projectV2(number: $number) {
          id
          number
          title
          url
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
              }
              ... on ProjectV2IterationField {
                id
                name
                dataType
              }
            }
          }
        }
      }
    }
  `;
}

const GET_PROJECT_ITEM_QUERY = `
  query GetProjectItem($projectId: ID!, $issueNumber: Int!, $owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        projectItems(first: 10) {
          nodes {
            id
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldTextValue {
                  field { ... on ProjectV2Field { id name } }
                  text
                }
                ... on ProjectV2ItemFieldNumberValue {
                  field { ... on ProjectV2Field { id name } }
                  number
                }
                ... on ProjectV2ItemFieldDateValue {
                  field { ... on ProjectV2Field { id name } }
                  date
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  field { ... on ProjectV2SingleSelectField { id name } }
                  name
                  optionId
                }
              }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_ITEM_FIELD_MUTATION = `
  mutation UpdateProjectItemField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: $value
    }) {
      projectV2Item {
        id
      }
    }
  }
`;

const ADD_ITEM_TO_PROJECT_MUTATION = `
  mutation AddItemToProject($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {
      projectId: $projectId
      contentId: $contentId
    }) {
      item {
        id
      }
    }
  }
`;

const CREATE_FIELD_MUTATION = `
  mutation CreateField($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!) {
    createProjectV2Field(input: {
      projectId: $projectId
      dataType: $dataType
      name: $name
    }) {
      projectV2Field {
        ... on ProjectV2Field {
          id
          name
          dataType
        }
      }
    }
  }
`;

const CREATE_SINGLE_SELECT_FIELD_MUTATION = `
  mutation CreateSingleSelectField($projectId: ID!, $name: String!) {
    createProjectV2Field(input: {
      projectId: $projectId
      dataType: SINGLE_SELECT
      name: $name
    }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
          name
        }
      }
    }
  }
`;

const UPDATE_SINGLE_SELECT_FIELD_MUTATION = `
  mutation UpdateSingleSelectField($projectId: ID!, $fieldId: ID!, $singleSelectOptions: [ProjectV2SingleSelectFieldOptionInput!]!) {
    updateProjectV2Field(input: {
      projectId: $projectId
      fieldId: $fieldId
      singleSelectOptions: $singleSelectOptions
    }) {
      projectV2Field {
        ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
          }
        }
      }
    }
  }
`;

// ============================================================================
// Required Custom Fields Definition
// ============================================================================

interface RequiredField {
  name: string;
  dataType: "TEXT" | "NUMBER" | "DATE" | "SINGLE_SELECT";
  options?: string[];
}

/**
 * All custom fields required by GWA, with their data types.
 * This is the source of truth - fields will be created if missing.
 */
const REQUIRED_FIELDS: RequiredField[] = [
  { name: CUSTOM_FIELDS.ESTIMATED_HOURS, dataType: "NUMBER" },
  { name: CUSTOM_FIELDS.COMPLEXITY, dataType: "SINGLE_SELECT", options: ["Low", "Medium", "High", "Critical"] },
  { name: CUSTOM_FIELDS.RISK_LEVEL, dataType: "SINGLE_SELECT", options: ["Low", "Medium", "High"] },
  { name: CUSTOM_FIELDS.ASSIGNED_AGENT, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.SESSION_ID, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.PLAN_VERSION, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.PLAN_STATUS, dataType: "SINGLE_SELECT", options: ["Draft", "Pending Review", "Approved", "In Progress", "Completed"] },
  { name: CUSTOM_FIELDS.TASKS_COUNT, dataType: "NUMBER" },
  { name: CUSTOM_FIELDS.TASKS_COMPLETED, dataType: "NUMBER" },
  { name: CUSTOM_FIELDS.BLOCKED_REASON, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.QA_STATUS, dataType: "SINGLE_SELECT", options: ["Not Started", "Running", "Passed", "Failed"] },
  { name: CUSTOM_FIELDS.QA_RUN_ID, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.BRANCH_NAME, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.PR_NUMBER, dataType: "NUMBER" },
  { name: CUSTOM_FIELDS.CREATED_BY, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.STARTED_AT, dataType: "DATE" },
  { name: CUSTOM_FIELDS.COMPLETED_AT, dataType: "DATE" },
  { name: CUSTOM_FIELDS.DURATION_HOURS, dataType: "NUMBER" },
  // Phase 15 (v3.4) - Enhanced session fields
  { name: CUSTOM_FIELDS.POD_NAME, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.TMUX_WINDOW, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.KUBECTL_COMMAND, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.WORKTREE_PATH, dataType: "TEXT" },
  { name: CUSTOM_FIELDS.SUB_AGENTS_USED, dataType: "TEXT" },
];

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Get a GitHub Project by number.
 * Supports both organization and personal (user) projects.
 */
export async function getProject(owner: string, projectNumber: number): Promise<Project> {
  return withSpan("projects.getProject", async (span) => {
    const ownerType = getProjectOwnerType();
    span.setAttribute("projects.owner", owner);
    span.setAttribute("projects.number", projectNumber);
    span.setAttribute("projects.owner_type", ownerType);

    const client = getOctokit();
    const query = buildGetProjectQuery(ownerType);

    // Response shape varies based on owner type
    type ProjectData = {
      id: string;
      number: number;
      title: string;
      url: string;
      fields: { nodes: ProjectField[] };
    };

    const result = await client.graphql<{
      organization?: { projectV2: ProjectData };
      user?: { projectV2: ProjectData };
    }>(query, { owner, number: projectNumber });

    // Extract project from either organization or user response
    const projectData = ownerType === "user"
      ? result.user?.projectV2
      : result.organization?.projectV2;

    if (!projectData) {
      throw new Error(`Project #${projectNumber} not found for ${ownerType} "${owner}"`);
    }

    const statusField = projectData.fields.nodes.find(
      (f) => f.name === "Status" && f.dataType === "SINGLE_SELECT"
    );

    if (!statusField) {
      throw new Error("Project does not have a Status field");
    }

    Metrics.recordGitHubApiCall("graphql.getProject", true);

    return {
      id: projectData.id,
      number: projectData.number,
      title: projectData.title,
      url: projectData.url,
      fields: projectData.fields.nodes,
      statusField,
    };
  });
}

/**
 * Get a project item by issue number.
 */
export async function getProjectItem(
  owner: string,
  repo: string,
  issueNumber: number,
  projectId: string
): Promise<ProjectItem | null> {
  return withSpan("projects.getProjectItem", async (span) => {
    span.setAttribute("projects.owner", owner);
    span.setAttribute("projects.repo", repo);
    span.setAttribute("projects.issue", issueNumber);

    const client = getOctokit();
    const result = await client.graphql<{
      repository: {
        issue: {
          projectItems: {
            nodes: Array<{
              id: string;
              project: { id: string };
              fieldValues: { nodes: Array<{
                field?: { id: string; name: string };
                text?: string;
                number?: number;
                date?: string;
                name?: string;
                optionId?: string;
              }> };
            }>;
          };
        };
      };
    }>(GET_PROJECT_ITEM_QUERY, { projectId, issueNumber, owner, repo });

    const items = result.repository.issue?.projectItems?.nodes || [];
    const item = items.find((i) => i.project.id === projectId);

    if (!item) {
      return null;
    }

    const fieldValues: FieldValue[] = item.fieldValues.nodes
      .filter((fv) => fv.field)
      .map((fv) => ({
        fieldId: fv.field!.id,
        fieldName: fv.field!.name,
        value: fv.text ?? fv.number ?? fv.date ?? fv.name ?? null,
      }));

    Metrics.recordGitHubApiCall("graphql.getProjectItem", true);

    return {
      id: item.id,
      content: {
        type: "Issue",
        number: issueNumber,
        title: "", // Would need additional query to get title
        url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
      },
      fieldValues,
    };
  });
}

/**
 * Update the status (column) of a project item.
 */
export async function updateItemStatus(
  projectId: string,
  itemId: string,
  statusFieldId: string,
  optionId: string
): Promise<void> {
  return withSpan("projects.updateItemStatus", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.optionId", optionId);

    const client = getOctokit();
    await client.graphql(UPDATE_ITEM_FIELD_MUTATION, {
      projectId,
      itemId,
      fieldId: statusFieldId,
      value: { singleSelectOptionId: optionId },
    });

    Metrics.recordGitHubApiCall("graphql.updateItemStatus", true);
    log("info", "Project item status updated", { itemId, optionId });
  });
}

/**
 * Update a text field on a project item.
 */
export async function updateTextField(
  projectId: string,
  itemId: string,
  fieldId: string,
  text: string
): Promise<void> {
  return withSpan("projects.updateTextField", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.fieldId", fieldId);

    const client = getOctokit();
    await client.graphql(UPDATE_ITEM_FIELD_MUTATION, {
      projectId,
      itemId,
      fieldId,
      value: { text },
    });

    Metrics.recordGitHubApiCall("graphql.updateTextField", true);
  });
}

/**
 * Update a number field on a project item.
 */
export async function updateNumberField(
  projectId: string,
  itemId: string,
  fieldId: string,
  number: number
): Promise<void> {
  return withSpan("projects.updateNumberField", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.fieldId", fieldId);

    const client = getOctokit();
    await client.graphql(UPDATE_ITEM_FIELD_MUTATION, {
      projectId,
      itemId,
      fieldId,
      value: { number },
    });

    Metrics.recordGitHubApiCall("graphql.updateNumberField", true);
  });
}

/**
 * Update a date field on a project item.
 */
export async function updateDateField(
  projectId: string,
  itemId: string,
  fieldId: string,
  date: Date
): Promise<void> {
  return withSpan("projects.updateDateField", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.fieldId", fieldId);

    const client = getOctokit();
    await client.graphql(UPDATE_ITEM_FIELD_MUTATION, {
      projectId,
      itemId,
      fieldId,
      value: { date: date.toISOString().split("T")[0] },
    });

    Metrics.recordGitHubApiCall("graphql.updateDateField", true);
  });
}

/**
 * Add an issue to a project.
 */
export async function addItemToProject(
  projectId: string,
  contentId: string // The node ID of the issue
): Promise<string> {
  return withSpan("projects.addItemToProject", async (span) => {
    span.setAttribute("projects.projectId", projectId);
    span.setAttribute("projects.contentId", contentId);

    const client = getOctokit();
    const result = await client.graphql<{
      addProjectV2ItemById: { item: { id: string } };
    }>(ADD_ITEM_TO_PROJECT_MUTATION, { projectId, contentId });

    Metrics.recordGitHubApiCall("graphql.addItemToProject", true);

    return result.addProjectV2ItemById.item.id;
  });
}

// ============================================================================
// Field Provisioning
// ============================================================================

/**
 * Ensure all required custom fields exist on a project.
 * Creates any missing fields. Should be called during session start.
 *
 * @returns Object with counts of existing and created fields
 */
export async function ensureCustomFields(
  owner: string,
  projectNumber: number
): Promise<{ existing: number; created: number; failed: string[] }> {
  return withSpan("projects.ensureCustomFields", async (span) => {
    span.setAttribute("projects.owner", owner);
    span.setAttribute("projects.number", projectNumber);

    const client = getOctokit();

    // Get current project with all fields
    const project = await getProject(owner, projectNumber);
    const existingFieldNames = new Set(project.fields.map((f) => f.name));

    let existing = 0;
    let created = 0;
    const failed: string[] = [];

    for (const requiredField of REQUIRED_FIELDS) {
      if (existingFieldNames.has(requiredField.name)) {
        existing++;
        continue;
      }

      // Field doesn't exist, create it
      try {
        if (requiredField.dataType === "SINGLE_SELECT") {
          // Create single select field
          const createResult = await client.graphql<{
            createProjectV2Field: {
              projectV2Field: { id: string; name: string };
            };
          }>(CREATE_SINGLE_SELECT_FIELD_MUTATION, {
            projectId: project.id,
            name: requiredField.name,
          });

          // Update with options if provided
          if (requiredField.options && requiredField.options.length > 0) {
            const fieldId = createResult.createProjectV2Field.projectV2Field.id;
            const options = requiredField.options.map((opt) => ({
              name: opt,
              description: "",
              color: "GRAY",
            }));

            await client.graphql(UPDATE_SINGLE_SELECT_FIELD_MUTATION, {
              projectId: project.id,
              fieldId,
              singleSelectOptions: options,
            });
          }
        } else {
          // Create other field types (TEXT, NUMBER, DATE)
          await client.graphql(CREATE_FIELD_MUTATION, {
            projectId: project.id,
            name: requiredField.name,
            dataType: requiredField.dataType,
          });
        }

        created++;
        log("info", `Created missing field: ${requiredField.name}`, {
          projectNumber,
          dataType: requiredField.dataType,
        });
      } catch (error) {
        failed.push(requiredField.name);
        log("warn", `Failed to create field: ${requiredField.name}`, {
          projectNumber,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    span.setAttribute("projects.fields.existing", existing);
    span.setAttribute("projects.fields.created", created);
    span.setAttribute("projects.fields.failed", failed.length);

    if (created > 0) {
      log("info", `Field provisioning complete`, {
        projectNumber,
        existing,
        created,
        failed: failed.length,
      });
    }

    Metrics.recordGitHubApiCall("graphql.ensureCustomFields", true);

    return { existing, created, failed };
  });
}

// ============================================================================
// High-Level Workflow Functions
// ============================================================================

/**
 * Move an item to a specific column and update related fields.
 */
export async function moveToColumn(
  project: Project,
  itemId: string,
  column: ColumnName,
  additionalFields?: Record<string, string | number | Date>
): Promise<void> {
  return withSpan("projects.moveToColumn", async (span) => {
    span.setAttribute("projects.column", column);
    span.setAttribute("projects.itemId", itemId);

    const option = project.statusField.options?.find((o) => o.name === column);
    if (!option) {
      throw new Error(`Column "${column}" not found in project`);
    }

    // Update status
    await updateItemStatus(project.id, itemId, project.statusField.id, option.id);

    // Update additional fields if provided
    if (additionalFields) {
      for (const [fieldName, value] of Object.entries(additionalFields)) {
        const field = project.fields.find((f) => f.name === fieldName);
        if (!field) {
          log("warn", `Field "${fieldName}" not found in project`);
          continue;
        }

        if (typeof value === "string") {
          await updateTextField(project.id, itemId, field.id, value);
        } else if (typeof value === "number") {
          await updateNumberField(project.id, itemId, field.id, value);
        } else if (value instanceof Date) {
          await updateDateField(project.id, itemId, field.id, value);
        }
      }
    }

    log("info", `Moved item to column: ${column}`, { itemId });
  });
}

/**
 * Update plan-related fields on a project item.
 */
export async function updatePlanFields(
  project: Project,
  itemId: string,
  planData: {
    version?: number;
    status?: string;
    tasksCount?: number;
    tasksCompleted?: number;
    estimatedHours?: number;
  }
): Promise<void> {
  return withSpan("projects.updatePlanFields", async (span) => {
    span.setAttribute("projects.itemId", itemId);

    const updates: Record<string, string | number> = {};

    if (planData.version !== undefined) {
      updates[CUSTOM_FIELDS.PLAN_VERSION] = String(planData.version);
    }
    if (planData.status !== undefined) {
      updates[CUSTOM_FIELDS.PLAN_STATUS] = planData.status;
    }
    if (planData.tasksCount !== undefined) {
      updates[CUSTOM_FIELDS.TASKS_COUNT] = planData.tasksCount;
    }
    if (planData.tasksCompleted !== undefined) {
      updates[CUSTOM_FIELDS.TASKS_COMPLETED] = planData.tasksCompleted;
    }
    if (planData.estimatedHours !== undefined) {
      updates[CUSTOM_FIELDS.ESTIMATED_HOURS] = planData.estimatedHours;
    }

    for (const [fieldName, value] of Object.entries(updates)) {
      const field = project.fields.find((f) => f.name === fieldName);
      if (!field) continue;

      if (typeof value === "string") {
        await updateTextField(project.id, itemId, field.id, value);
      } else {
        await updateNumberField(project.id, itemId, field.id, value);
      }
    }
  });
}

/**
 * Update session-related fields on a project item.
 */
export async function updateSessionFields(
  project: Project,
  itemId: string,
  sessionData: {
    sessionId?: string;
    assignedAgent?: string;
    branchName?: string;
    prNumber?: number;
    startedAt?: Date;
    completedAt?: Date;
    // Phase 15 (v3.4) - Enhanced session fields
    podName?: string;
    tmuxWindow?: string;
    kubectlCommand?: string;
    worktreePath?: string;
    subAgentsUsed?: string;
  }
): Promise<void> {
  return withSpan("projects.updateSessionFields", async (span) => {
    span.setAttribute("projects.itemId", itemId);

    if (sessionData.sessionId) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.SESSION_ID);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.sessionId);
    }

    if (sessionData.assignedAgent) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.ASSIGNED_AGENT);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.assignedAgent);
    }

    if (sessionData.branchName) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.BRANCH_NAME);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.branchName);
    }

    if (sessionData.prNumber) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.PR_NUMBER);
      if (field) await updateNumberField(project.id, itemId, field.id, sessionData.prNumber);
    }

    if (sessionData.startedAt) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.STARTED_AT);
      if (field) await updateDateField(project.id, itemId, field.id, sessionData.startedAt);
    }

    if (sessionData.completedAt) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.COMPLETED_AT);
      if (field) await updateDateField(project.id, itemId, field.id, sessionData.completedAt);
    }

    // Phase 15 (v3.4) - Enhanced session fields
    if (sessionData.podName) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.POD_NAME);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.podName);
    }

    if (sessionData.tmuxWindow) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.TMUX_WINDOW);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.tmuxWindow);
    }

    if (sessionData.kubectlCommand) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.KUBECTL_COMMAND);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.kubectlCommand);
    }

    if (sessionData.worktreePath) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.WORKTREE_PATH);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.worktreePath);
    }

    if (sessionData.subAgentsUsed) {
      const field = project.fields.find((f) => f.name === CUSTOM_FIELDS.SUB_AGENTS_USED);
      if (field) await updateTextField(project.id, itemId, field.id, sessionData.subAgentsUsed);
    }
  });
}

/**
 * Mark an item as blocked with a reason.
 */
export async function markBlocked(
  project: Project,
  itemId: string,
  reason: string
): Promise<void> {
  return withSpan("projects.markBlocked", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.blocked_reason", reason);

    await moveToColumn(project, itemId, COLUMNS.BLOCKED, {
      [CUSTOM_FIELDS.BLOCKED_REASON]: reason,
    });
  });
}

/**
 * Update QA status fields.
 */
export async function updateQAFields(
  project: Project,
  itemId: string,
  qaData: {
    status: "running" | "passed" | "failed";
    runId?: string;
  }
): Promise<void> {
  return withSpan("projects.updateQAFields", async (span) => {
    span.setAttribute("projects.itemId", itemId);
    span.setAttribute("projects.qa_status", qaData.status);

    const statusField = project.fields.find((f) => f.name === CUSTOM_FIELDS.QA_STATUS);
    if (statusField) {
      await updateTextField(project.id, itemId, statusField.id, qaData.status);
    }

    if (qaData.runId) {
      const runIdField = project.fields.find((f) => f.name === CUSTOM_FIELDS.QA_RUN_ID);
      if (runIdField) {
        await updateTextField(project.id, itemId, runIdField.id, qaData.runId);
      }
    }
  });
}

export default {
  getProject,
  getProjectItem,
  updateItemStatus,
  updateTextField,
  updateNumberField,
  updateDateField,
  addItemToProject,
  ensureCustomFields,
  moveToColumn,
  updatePlanFields,
  updateSessionFields,
  markBlocked,
  updateQAFields,
  COLUMNS,
  CUSTOM_FIELDS,
};
