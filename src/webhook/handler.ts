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
  organization: {
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
  const orgLogin = event.organization.login;
  const itemNodeId = event.projects_v2_item.node_id;
  const contentNodeId = event.projects_v2_item.content_node_id;
  const contentType = event.projects_v2_item.content_type;

  console.log(`[Webhook] Column transition: ${fromColumn} -> ${toColumn}`);
  console.log(`[Webhook] Organization: ${orgLogin}`);
  console.log(`[Webhook] Content: ${contentType} (${contentNodeId})`);

  // Determine which transition handler to trigger
  const transitionKey = `${fromColumn}:${toColumn}`;

  const transitionHandlers: Record<string, string> = {
    "Todo:Planning": "start-planning",
    "Planning:In Progress": "inject-prompt",
    "In Progress:QA": "run-playwright",
    "QA:In Progress": "resume-with-failures",
    "QA:Review": "status-update",
    "Review:Done": "deploy-and-cleanup",
    "Blocked:Planning": "send-answer",
    "Blocked:In Progress": "send-answer",
  };

  const handler = transitionHandlers[transitionKey];

  if (!handler) {
    console.log(`[Webhook] No handler for transition: ${transitionKey}`);
    return;
  }

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
      org: orgLogin,
      handler: handler,
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
