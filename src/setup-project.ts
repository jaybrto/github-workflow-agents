#!/usr/bin/env bun
/**
 * Setup Project
 *
 * Creates a GitHub Project v2 for a repository with all the columns
 * and custom fields needed for GWA workflow automation.
 *
 * Usage:
 *   gwa-setup-project --org <organization> --repo <repo-name> [--project-number <number>]
 *
 * Called by ArgoCD PostSync hook when onboarding a new repository.
 */

import { parseArgs } from "util";
import { readFileSync } from "fs";
import { resolve, normalize } from "path";
import { withSpan, Metrics, shutdown as shutdownTelemetry, log } from "./lib/telemetry.js";
import { getOctokit } from "./lib/github.js";
import { logActivity } from "./lib/db.js";
import { getProjectOwnerType, type ProjectOwnerType } from "./lib/projects.js";

// SECURITY: Allowed directories for template files
const ALLOWED_TEMPLATE_DIRS = [
  "/home/runner/.claude/templates",
  "/home/runner/repo/templates",
];

/**
 * Validate template path to prevent path traversal attacks.
 * Only allows templates from approved directories.
 */
function validateTemplatePath(templatePath: string): string {
  const resolved = resolve(normalize(templatePath));

  // Check if the resolved path starts with any allowed directory
  const isAllowed = ALLOWED_TEMPLATE_DIRS.some((allowedDir) =>
    resolved.startsWith(resolve(allowedDir))
  );

  if (!isAllowed) {
    throw new Error(
      `Invalid template path: ${templatePath}. Templates must be in: ${ALLOWED_TEMPLATE_DIRS.join(" or ")}`
    );
  }

  return resolved;
}

interface SetupArgs {
  org: string;
  repo: string;
  projectNumber?: number;
  templatePath?: string;
}

interface ProjectTemplate {
  project: {
    title: string;
    description: string;
    public: boolean;
  };
  columns: Array<{
    name: string;
    description: string;
    color: string;
  }>;
  customFields: Array<{
    name: string;
    dataType: string;
    description: string;
    options?: string[];
  }>;
}

// GraphQL mutations for project setup
const CREATE_PROJECT_MUTATION = `
  mutation CreateProject($ownerId: ID!, $title: String!) {
    createProjectV2(input: {
      ownerId: $ownerId
      title: $title
    }) {
      projectV2 {
        id
        number
        url
      }
    }
  }
`;

const UPDATE_PROJECT_MUTATION = `
  mutation UpdateProject($projectId: ID!, $title: String!, $shortDescription: String!, $public: Boolean!) {
    updateProjectV2(input: {
      projectId: $projectId
      title: $title
      shortDescription: $shortDescription
      public: $public
    }) {
      projectV2 {
        id
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

/**
 * Build query to get owner ID (works for both org and user).
 */
function buildGetOwnerIdQuery(ownerType: ProjectOwnerType): string {
  const ownerField = ownerType === "user" ? "user" : "organization";
  return `
    query GetOwnerId($login: String!) {
      ${ownerField}(login: $login) {
        id
        name
      }
    }
  `;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      org: { type: "string" },
      repo: { type: "string" },
      "project-number": { type: "string" },
      template: { type: "string" },
    },
  });

  const args: SetupArgs = {
    org: values.org || "",
    repo: values.repo || "",
    projectNumber: values["project-number"] ? parseInt(values["project-number"], 10) : undefined,
    templatePath: values.template || "/home/runner/.claude/templates/github-project.json",
  };

  if (!args.org || !args.repo) {
    console.error("Usage: gwa-setup-project --org <organization> --repo <repo-name>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan(
      "setup-project",
      async (span) => {
        span.setAttribute("setup.org", args.org);
        span.setAttribute("setup.repo", args.repo);

        log("info", `Setting up project for ${args.org}/${args.repo}`, {
          org: args.org,
          repo: args.repo,
        });

        const result = await setupProject(args);
        success = true;

        log("info", "Project setup complete", {
          org: args.org,
          repo: args.repo,
          projectNumber: result.number,
          projectUrl: result.url,
        });

        console.log(`
=== Project Setup Complete ===
Organization: ${args.org}
Repository: ${args.repo}
Project Number: ${result.number}
Project URL: ${result.url}

Next steps:
1. Add the 'claude' label to issues you want Claude to work on
2. Issues with that label will be automatically added to the project
3. Move items between columns to trigger Claude workflows
`);
      },
      {
        attributes: {
          "gwa.operation": "setup-project",
          "setup.org": args.org,
          "setup.repo": args.repo,
        },
      }
    );
  } catch (error) {
    log("error", "Project setup failed", {
      org: args.org,
      repo: args.repo,
      error: error instanceof Error ? error.message : String(error),
    });

    console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

/**
 * Setup a GitHub Project with all required configuration.
 */
async function setupProject(args: SetupArgs): Promise<{ id: string; number: number; url: string }> {
  return withSpan("setup-project.execute", async (span) => {
    const octokit = getOctokit();

    // Load template with path validation
    let template: ProjectTemplate;
    try {
      // SECURITY: Validate template path to prevent path traversal
      const validatedPath = validateTemplatePath(args.templatePath!);
      const templateContent = readFileSync(validatedPath, "utf-8");
      template = JSON.parse(templateContent);
    } catch (error) {
      // Use default template if file not found or path invalid
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes("Invalid template path")) {
        log("error", "Template path validation failed", { error: errorMsg });
        throw error; // Re-throw security errors
      }
      log("warn", "Template file not found, using defaults");
      template = getDefaultTemplate(args.repo);
    }

    // Get owner ID (supports both org and user)
    const ownerType = getProjectOwnerType();
    const ownerIdQuery = buildGetOwnerIdQuery(ownerType);

    const ownerResult = await octokit.graphql<{
      organization?: { id: string; name: string };
      user?: { id: string; name: string };
    }>(ownerIdQuery, { login: args.org });

    const ownerData = ownerType === "user" ? ownerResult.user : ownerResult.organization;
    if (!ownerData) {
      throw new Error(`${ownerType} "${args.org}" not found`);
    }

    const ownerId = ownerData.id;
    span.setAttribute("setup.owner_id", ownerId);
    span.setAttribute("setup.owner_type", ownerType);

    // Create project
    const projectTitle = template.project.title.replace("{{REPO_NAME}}", args.repo);

    log("info", "Creating project", { title: projectTitle });

    const createResult = await octokit.graphql<{
      createProjectV2: {
        projectV2: { id: string; number: number; url: string };
      };
    }>(CREATE_PROJECT_MUTATION, {
      ownerId,
      title: projectTitle,
    });

    const project = createResult.createProjectV2.projectV2;
    span.setAttribute("setup.project_id", project.id);
    span.setAttribute("setup.project_number", project.number);

    // Update project with description
    await octokit.graphql(UPDATE_PROJECT_MUTATION, {
      projectId: project.id,
      title: projectTitle,
      shortDescription: template.project.description,
      public: template.project.public,
    });

    // Get the Status field (created by default)
    // We need to update its options to match our columns
    const projectFields = await getProjectFields(octokit, args.org, project.number);
    const statusField = projectFields.find(
      (f) => f.name === "Status" && f.dataType === "SINGLE_SELECT"
    );

    if (statusField) {
      // Update Status field with our column options
      const columnOptions = template.columns.map((col) => ({
        name: col.name,
        description: col.description,
        color: mapColor(col.color),
      }));

      await octokit.graphql(UPDATE_SINGLE_SELECT_FIELD_MUTATION, {
        projectId: project.id,
        fieldId: statusField.id,
        singleSelectOptions: columnOptions,
      });

      log("info", "Updated Status field with columns", {
        columns: template.columns.map((c) => c.name).join(","),
      });
    }

    // Create custom fields
    for (const field of template.customFields) {
      try {
        await createCustomField(octokit, project.id, field);
        log("debug", "Created custom field", { name: field.name });
      } catch (error) {
        log("warn", "Failed to create custom field", {
          name: field.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logActivity(null, "project_created", {
      org: args.org,
      repo: args.repo,
      projectNumber: project.number,
    }, "workflow");

    Metrics.recordGitHubApiCall("graphql.createProject", true);

    return {
      id: project.id,
      number: project.number,
      url: project.url,
    };
  });
}

/**
 * Get existing project fields.
 * Supports both organization and personal (user) projects.
 */
async function getProjectFields(
  octokit: ReturnType<typeof getOctokit>,
  org: string,
  projectNumber: number
): Promise<Array<{ id: string; name: string; dataType: string }>> {
  const ownerType = getProjectOwnerType();
  const ownerField = ownerType === "user" ? "user" : "organization";

  const query = `
    query GetProjectFields($owner: String!, $number: Int!) {
      ${ownerField}(login: $owner) {
        projectV2(number: $number) {
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

  type FieldsData = {
    projectV2: {
      fields: {
        nodes: Array<{ id: string; name: string; dataType: string }>;
      };
    };
  };

  const result = await octokit.graphql<{
    organization?: FieldsData;
    user?: FieldsData;
  }>(query, { owner: org, number: projectNumber });

  const data = ownerType === "user" ? result.user : result.organization;
  if (!data) {
    throw new Error(`Project #${projectNumber} not found for ${ownerType} "${org}"`);
  }

  return data.projectV2.fields.nodes;
}

/**
 * Create a custom field on the project.
 */
async function createCustomField(
  octokit: ReturnType<typeof getOctokit>,
  projectId: string,
  field: ProjectTemplate["customFields"][0]
): Promise<void> {
  if (field.dataType === "SINGLE_SELECT") {
    // Create single select field
    const createResult = await octokit.graphql<{
      createProjectV2Field: {
        projectV2Field: { id: string; name: string };
      };
    }>(CREATE_SINGLE_SELECT_FIELD_MUTATION, {
      projectId,
      name: field.name,
    });

    // Update with options if provided
    if (field.options && field.options.length > 0) {
      const fieldId = createResult.createProjectV2Field.projectV2Field.id;
      const options = field.options.map((opt) => ({
        name: opt,
        description: "",
        color: "GRAY",
      }));

      await octokit.graphql(UPDATE_SINGLE_SELECT_FIELD_MUTATION, {
        projectId,
        fieldId,
        singleSelectOptions: options,
      });
    }
  } else {
    // Create other field types
    await octokit.graphql(CREATE_FIELD_MUTATION, {
      projectId,
      name: field.name,
      dataType: field.dataType,
    });
  }
}

/**
 * Map color names to GitHub's expected format.
 */
function mapColor(color: string): string {
  const colorMap: Record<string, string> = {
    gray: "GRAY",
    purple: "PURPLE",
    blue: "BLUE",
    yellow: "YELLOW",
    red: "RED",
    orange: "ORANGE",
    green: "GREEN",
    pink: "PINK",
  };
  return colorMap[color.toLowerCase()] || "GRAY";
}

/**
 * Get default template if file not found.
 */
function getDefaultTemplate(repoName: string): ProjectTemplate {
  return {
    project: {
      title: `${repoName} - Claude Workflow`,
      description: "Automated issue processing powered by Claude Code",
      public: false,
    },
    columns: [
      { name: "Todo", description: "Issues waiting to be processed", color: "gray" },
      { name: "Planning", description: "Creating implementation plan", color: "purple" },
      { name: "In Progress", description: "Implementation underway", color: "blue" },
      { name: "QA", description: "Automated testing", color: "yellow" },
      { name: "Blocked", description: "Waiting for input", color: "red" },
      { name: "Review", description: "Ready for code review", color: "orange" },
      { name: "Done", description: "Completed and merged", color: "green" },
    ],
    customFields: [
      { name: "Estimated Hours", dataType: "NUMBER", description: "Estimated time in hours" },
      { name: "Session ID", dataType: "TEXT", description: "GWA session identifier" },
      { name: "Plan Status", dataType: "SINGLE_SELECT", description: "Plan status", options: ["Draft", "Approved", "In Progress", "Completed"] },
      { name: "Tasks Count", dataType: "NUMBER", description: "Total tasks" },
      { name: "Tasks Completed", dataType: "NUMBER", description: "Completed tasks" },
      { name: "PR Number", dataType: "NUMBER", description: "Pull request number" },
    ],
  };
}

main();
