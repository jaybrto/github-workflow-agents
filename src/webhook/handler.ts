/**
 * GitHub App Webhook Handler
 *
 * Receives webhook events from the WorkflowAgents-BTO GitHub App
 * and triggers appropriate workflows based on project column changes.
 */

import { createHmac } from "crypto";

// Environment configuration
const WEBHOOK_SECRET = process.env.GITHUB_APP_SECRET || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

interface ProjectV2ItemEvent {
  action: "created" | "edited" | "deleted" | "archived" | "restored" | "reordered";
  projects_v2_item: {
    node_id: string;
    project_node_id: string;
    content_node_id: string;
    content_type: "Issue" | "PullRequest" | "DraftIssue";
    creator: {
      login: string;
    };
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  };
  changes?: {
    field_value?: {
      field_node_id: string;
      field_type: string;
      field_name: string;
      from?: {
        name?: string;
        id?: string;
      };
      to?: {
        name?: string;
        id?: string;
      };
    };
  };
  // Organization is present for org projects, absent for user projects
  organization?: {
    login: string;
    id: number;
  };
  sender: {
    login: string;
    id: number;
  };
}

// WebhookPayload interface for future use with typed handlers
// interface WebhookPayload {
//   event: string;
//   signature: string;
//   body: string;
//   parsed: ProjectV2ItemEvent;
// }

/**
 * Verify the webhook signature using HMAC-SHA256
 */
function verifySignature(payload: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn("[Webhook] No secret configured, skipping verification");
    return true;
  }

  const expectedSignature = `sha256=${createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;

  return signature === expectedSignature;
}

interface ContentDetails {
  number: number;
  title: string;
  repo: string;
}

/**
 * Fetch issue/PR details from content node ID using GraphQL
 */
async function fetchContentDetails(contentNodeId: string): Promise<ContentDetails | null> {
  const query = `
    query($id: ID!) {
      node(id: $id) {
        ... on Issue {
          number
          title
          repository { nameWithOwner }
        }
        ... on PullRequest {
          number
          title
          repository { nameWithOwner }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { id: contentNodeId },
      }),
    });

    if (!response.ok) {
      console.error(`[Webhook] GraphQL request failed: ${response.status}`);
      return null;
    }

    const result = await response.json() as {
      data?: {
        node?: {
          number?: number;
          title?: string;
          repository?: { nameWithOwner?: string };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      console.error(`[Webhook] GraphQL errors:`, result.errors);
      return null;
    }

    const node = result.data?.node;
    if (!node?.number || !node?.repository?.nameWithOwner) {
      console.error(`[Webhook] Could not resolve content details for ${contentNodeId}`);
      return null;
    }

    return {
      number: node.number,
      title: node.title || "",
      repo: node.repository.nameWithOwner,
    };
  } catch (error) {
    console.error(`[Webhook] Error fetching content details:`, error);
    return null;
  }
}

/**
 * Trigger a workflow via workflow_dispatch
 */
async function triggerWorkflow(
  owner: string,
  repo: string,
  workflowId: string,
  inputs: Record<string, string>
): Promise<boolean> {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: "main",
        inputs,
      }),
    });

    if (response.status === 204) {
      console.log(`[Webhook] Triggered workflow ${workflowId} in ${owner}/${repo}`);
      return true;
    } else {
      const error = await response.text();
      console.error(`[Webhook] Failed to trigger workflow: ${response.status} ${error}`);
      return false;
    }
  } catch (error) {
    console.error(`[Webhook] Error triggering workflow:`, error);
    return false;
  }
}

/**
 * Handle projects_v2_item webhook event
 */
async function handleProjectItemEvent(event: ProjectV2ItemEvent): Promise<void> {
  console.log(`[Webhook] Received projects_v2_item event: ${event.action}`);

  // Only process 'edited' events with status field changes
  if (event.action !== "edited" || !event.changes?.field_value) {
    console.log(`[Webhook] Skipping - not a field value change`);
    return;
  }

  const fieldChange = event.changes.field_value;

  // Only process Status field changes
  if (fieldChange.field_name !== "Status") {
    console.log(`[Webhook] Skipping - not a Status field change (was: ${fieldChange.field_name})`);
    return;
  }

  const fromColumn = fieldChange.from?.name || "None";
  const toColumn = fieldChange.to?.name || "None";
  // For org projects, use organization.login; for user projects, use sender.login
  const ownerLogin = event.organization?.login || event.sender.login;
  const itemNodeId = event.projects_v2_item.node_id;
  const contentNodeId = event.projects_v2_item.content_node_id;
  const contentType = event.projects_v2_item.content_type;

  console.log(`[Webhook] Column transition: ${fromColumn} -> ${toColumn}`);
  console.log(`[Webhook] Owner: ${ownerLogin} (${event.organization ? "org" : "user"})`);
  console.log(`[Webhook] Content: ${contentType} (${contentNodeId})`);

  // Determine which transition handler to trigger
  const transitionKey = `${fromColumn}:${toColumn}`;

  // Comprehensive state transition handlers
  // Format: "FromColumn:ToColumn": "handler-name"
  const transitionHandlers: Record<string, string> = {
    // ═══════════════════════════════════════════════════════════════════
    // FORWARD FLOW (happy path)
    // ═══════════════════════════════════════════════════════════════════
    "Todo:Planning": "start-planning",           // Begin planning phase
    "Planning:In Progress": "inject-prompt",     // Plan approved, start implementation
    "In Progress:QA": "run-playwright",          // Implementation done, run tests
    "QA:Review": "status-update",                // Tests passed, ready for review
    "Review:Done": "deploy-and-cleanup",         // Approved, deploy and close

    // ═══════════════════════════════════════════════════════════════════
    // BLOCKED STATE HANDLING
    // ═══════════════════════════════════════════════════════════════════
    // Going TO Blocked (pause session, await human input)
    "Planning:Blocked": "pause-for-question",
    "In Progress:Blocked": "pause-for-question",
    "QA:Blocked": "pause-for-question",
    "Review:Blocked": "pause-for-question",

    // Coming FROM Blocked (resume with answer)
    "Blocked:Planning": "send-answer",
    "Blocked:In Progress": "send-answer",
    "Blocked:QA": "send-answer",
    "Blocked:Review": "send-answer",

    // ═══════════════════════════════════════════════════════════════════
    // QA ITERATION
    // ═══════════════════════════════════════════════════════════════════
    "QA:In Progress": "resume-with-failures",    // Tests failed, fix and retry
    "Review:QA": "request-retest",               // Review found issues, retest

    // ═══════════════════════════════════════════════════════════════════
    // BACKWARD TRANSITIONS (reverting progress)
    // ═══════════════════════════════════════════════════════════════════
    // Back to Planning (requires re-planning)
    "In Progress:Planning": "request-replanning",
    "QA:Planning": "request-replanning",
    "Review:Planning": "request-replanning",

    // Back to In Progress (resume implementation)
    "Review:In Progress": "resume-implementation",

    // Back to Todo (cancel current work)
    "Planning:Todo": "cancel-session",
    "In Progress:Todo": "cancel-session",
    "QA:Todo": "cancel-session",
    "Review:Todo": "cancel-session",
    "Blocked:Todo": "cancel-session",

    // ═══════════════════════════════════════════════════════════════════
    // REOPENING (from Done)
    // ═══════════════════════════════════════════════════════════════════
    "Done:Todo": "reopen-issue",
    "Done:Planning": "reopen-issue",
    "Done:In Progress": "reopen-issue",
    "Done:QA": "reopen-issue",
    "Done:Review": "reopen-issue",
    "Done:Blocked": "reopen-issue",

    // ═══════════════════════════════════════════════════════════════════
    // DIRECT JUMPS (skipping states)
    // ═══════════════════════════════════════════════════════════════════
    "Todo:In Progress": "quick-start",           // Skip planning, start immediately
    "Todo:Done": "close-without-work",           // Close as won't-fix or duplicate
    "Planning:Done": "close-without-work",       // Close during planning
    "In Progress:Done": "close-without-work",    // Close during implementation
    "QA:Done": "close-without-work",             // Close during QA
    "In Progress:Review": "skip-qa",             // Skip QA, go straight to review
    "Planning:QA": "skip-implementation",        // Skip implementation (pre-built)
    "Todo:Blocked": "pause-for-question",        // Blocked before starting
  };

  const handler = transitionHandlers[transitionKey];

  if (!handler) {
    console.log(`[Webhook] No handler for transition: ${transitionKey}`);
    return;
  }

  // Fetch issue/PR details before triggering workflow
  const contentDetails = await fetchContentDetails(contentNodeId);
  if (!contentDetails) {
    console.error(`[Webhook] Failed to fetch content details, skipping workflow trigger`);
    return;
  }

  console.log(`[Webhook] Resolved: ${contentDetails.repo}#${contentDetails.number} - ${contentDetails.title}`);
  console.log(`[Webhook] Triggering handler: ${handler}`);

  // Trigger the project-sync workflow with the transition info
  const triggered = await triggerWorkflow(
    "jaybrto",
    "github-workflow-agents",
    "project-sync.yml",
    {
      item_id: itemNodeId,
      from_column: fromColumn,
      to_column: toColumn,
      content_type: contentType,
      content_id: contentNodeId,
      owner: ownerLogin,
      handler: handler,
      issue_number: String(contentDetails.number),
      issue_title: contentDetails.title,
      issue_repo: contentDetails.repo,
    }
  );

  if (triggered) {
    console.log(`[Webhook] Successfully triggered ${handler} for ${transitionKey}`);
  }
}

/**
 * Main HTTP request handler
 */
async function handleRequest(request: Request): Promise<Response> {
  // Only accept POST requests
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Get the webhook event type
  const eventType = request.headers.get("X-GitHub-Event");
  const signature = request.headers.get("X-Hub-Signature-256") || "";
  const deliveryId = request.headers.get("X-GitHub-Delivery");

  console.log(`[Webhook] Received ${eventType} event (delivery: ${deliveryId})`);

  // Read the body
  const body = await request.text();

  // Verify signature
  if (!verifySignature(body, signature)) {
    console.error(`[Webhook] Invalid signature`);
    return new Response("Invalid signature", { status: 401 });
  }

  // Parse the payload
  let payload: ProjectV2ItemEvent;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    console.error(`[Webhook] Invalid JSON payload`);
    return new Response("Invalid JSON", { status: 400 });
  }

  // Handle the event based on type
  if (eventType === "projects_v2_item") {
    await handleProjectItemEvent(payload);
  } else if (eventType === "ping") {
    console.log(`[Webhook] Ping received - webhook is configured correctly`);
  } else {
    console.log(`[Webhook] Ignoring event type: ${eventType}`);
  }

  return new Response("OK", { status: 200 });
}

// Start the server
const port = parseInt(process.env.PORT || "3000");

console.log(`[Webhook] Starting server on port ${port}`);

Bun.serve({
  port,
  fetch: handleRequest,
});

console.log(`[Webhook] Server running at http://localhost:${port}`);
