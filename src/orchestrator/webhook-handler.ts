/**
 * Orchestrator Webhook Handler
 *
 * Accepts the same webhook events as the thin webhook proxy but forwards
 * commands to runner pods via AMQP instead of triggering workflow_dispatch.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { ColumnTransition } from "../shared/types.js";

// Deduplication map: delivery ID -> timestamp (ms)
const seenDeliveries = new Map<string, number>();
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEDUP_CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function getWebhookSecret(): string {
  return process.env.GITHUB_APP_SECRET || "";
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

export function cleanupExpiredDeliveries(): void {
  const now = Date.now();
  for (const [id, timestamp] of seenDeliveries) {
    if (now - timestamp > DEDUP_TTL_MS) {
      seenDeliveries.delete(id);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredDeliveries, DEDUP_CLEANUP_INTERVAL_MS);
if (typeof cleanupInterval === "object" && "unref" in cleanupInterval) {
  cleanupInterval.unref();
}

export function verifySignature(payload: string, signature: string, secret?: string): boolean {
  const webhookSecret = secret ?? getWebhookSecret();
  if (!webhookSecret) return false;

  const expectedSignature = `sha256=${createHmac("sha256", webhookSecret)
    .update(payload)
    .digest("hex")}`;

  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  const receivedBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

interface ProjectV2ItemEvent {
  action: "created" | "edited" | "deleted" | "archived" | "restored" | "reordered";
  projects_v2_item: {
    node_id: string;
    project_node_id: string;
    content_node_id: string;
    content_type: "Issue" | "PullRequest" | "DraftIssue";
    creator: { login: string };
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  };
  changes?: {
    field_value?: {
      field_node_id: string;
      field_type: string;
      field_name: string;
      from?: { name?: string; id?: string };
      to?: { name?: string; id?: string };
    };
  };
  organization?: { login: string; id: number };
  sender: { login: string; id: number };
}

interface ContentDetails {
  number: number;
  title: string;
  repo: string;
}

async function fetchContentDetails(contentNodeId: string): Promise<ContentDetails | null> {
  const query = `
    query($id: ID!) {
      node(id: $id) {
        ... on Issue { number title repository { nameWithOwner } }
        ... on PullRequest { number title repository { nameWithOwner } }
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
      body: JSON.stringify({ query, variables: { id: contentNodeId } }),
    });

    if (!response.ok) {
      console.error(`[OrchestratorWebhook] GraphQL request failed: ${response.status}`);
      return null;
    }

    const result = await response.json() as {
      data?: { node?: { number?: number; title?: string; repository?: { nameWithOwner?: string } } };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      console.error(`[OrchestratorWebhook] GraphQL errors:`, result.errors);
      return null;
    }

    const node = result.data?.node;
    if (!node?.number || !node?.repository?.nameWithOwner) return null;

    return { number: node.number, title: node.title || "", repo: node.repository.nameWithOwner };
  } catch (error) {
    console.error(`[OrchestratorWebhook] Error fetching content details:`, error);
    return null;
  }
}

// Transition handler map (same as webhook/handler.ts)
const transitionHandlers: Record<string, string> = {
  "Todo:Planning": "start-planning",
  "Planning:In Progress": "inject-prompt",
  "In Progress:QA": "run-playwright",
  "QA:Review": "status-update",
  "Review:Done": "deploy-and-cleanup",
  "Planning:Blocked": "pause-for-question",
  "In Progress:Blocked": "pause-for-question",
  "QA:Blocked": "pause-for-question",
  "Review:Blocked": "pause-for-question",
  "Blocked:Planning": "send-answer",
  "Blocked:In Progress": "send-answer",
  "Blocked:QA": "send-answer",
  "Blocked:Review": "send-answer",
  "QA:In Progress": "resume-with-failures",
  "Review:QA": "request-retest",
  "In Progress:Planning": "request-replanning",
  "QA:Planning": "request-replanning",
  "Review:Planning": "request-replanning",
  "Review:In Progress": "resume-implementation",
  "Planning:Todo": "cancel-session",
  "In Progress:Todo": "cancel-session",
  "QA:Todo": "cancel-session",
  "Review:Todo": "cancel-session",
  "Blocked:Todo": "cancel-session",
  "Done:Todo": "reopen-issue",
  "Done:Planning": "reopen-issue",
  "Done:In Progress": "reopen-issue",
  "Done:QA": "reopen-issue",
  "Done:Review": "reopen-issue",
  "Done:Blocked": "reopen-issue",
  "Todo:In Progress": "quick-start",
  "Todo:Done": "close-without-work",
  "Planning:Done": "close-without-work",
  "In Progress:Done": "close-without-work",
  "QA:Done": "close-without-work",
  "In Progress:Review": "skip-qa",
  "Planning:QA": "skip-implementation",
  "Todo:Blocked": "pause-for-question",
};

/** Callback type for AMQP publish */
export type AmqpPublishFn = (routingKey: string, payload: unknown) => Promise<void>;

/**
 * Handle a projects_v2_item event by publishing an AMQP command
 * instead of triggering a workflow_dispatch.
 */
async function handleProjectItemEvent(
  event: ProjectV2ItemEvent,
  publishToAmqp: AmqpPublishFn,
): Promise<void> {
  if (event.action !== "edited" || !event.changes?.field_value) return;

  const fieldChange = event.changes.field_value;
  if (fieldChange.field_name !== "Status") return;

  const fromColumn = fieldChange.from?.name || "None";
  const toColumn = fieldChange.to?.name || "None";
  const transitionKey = `${fromColumn}:${toColumn}`;
  const handler = transitionHandlers[transitionKey];

  if (!handler) {
    console.log(`[OrchestratorWebhook] No handler for transition: ${transitionKey}`);
    return;
  }

  const ownerLogin = event.organization?.login || event.sender.login;
  const contentNodeId = event.projects_v2_item.content_node_id;
  const contentDetails = await fetchContentDetails(contentNodeId);

  if (!contentDetails) {
    console.error(`[OrchestratorWebhook] Failed to fetch content details, skipping`);
    return;
  }

  const transition: ColumnTransition = {
    from: fromColumn,
    to: toColumn,
    itemId: event.projects_v2_item.node_id,
    projectId: event.projects_v2_item.project_node_id,
    contentId: contentNodeId,
    contentType: event.projects_v2_item.content_type,
  };

  const command = {
    handler,
    transition,
    content: contentDetails,
    owner: ownerLogin,
    timestamp: Date.now(),
  };

  const routingKey = `gwa.commands.${handler.replace(/-/g, "_")}`;
  await publishToAmqp(routingKey, command);
  console.log(`[OrchestratorWebhook] Published ${routingKey} for ${contentDetails.repo}#${contentDetails.number}`);
}

/**
 * Create the webhook request handler with an AMQP publish function.
 */
export function createWebhookHandler(publishToAmqp: AmqpPublishFn) {
  return async function handleRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const eventType = request.headers.get("X-GitHub-Event");
    const signature = request.headers.get("X-Hub-Signature-256") || "";
    const deliveryId = request.headers.get("X-GitHub-Delivery");

    if (deliveryId && seenDeliveries.has(deliveryId)) {
      return new Response(JSON.stringify({ status: "already_processed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.text();

    if (!verifySignature(body, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (deliveryId) {
      seenDeliveries.set(deliveryId, Date.now());
    }

    let payload: ProjectV2ItemEvent;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (eventType === "projects_v2_item") {
      await handleProjectItemEvent(payload, publishToAmqp);
    } else if (eventType === "ping") {
      console.log(`[OrchestratorWebhook] Ping received`);
    }

    return new Response("OK", { status: 200 });
  };
}

export const _testing = { seenDeliveries, DEDUP_TTL_MS };
