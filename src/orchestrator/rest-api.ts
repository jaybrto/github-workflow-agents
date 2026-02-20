/**
 * Orchestrator REST API
 *
 * Provides HTTP endpoints for querying aggregated session state,
 * answering blocked sessions, fetching terminal snapshots/recordings,
 * and managing environment provisioning for projects.
 */

import type { SessionAggregator } from "./session-aggregator.js";
import type { EnvironmentProvisioner } from "./environment-provisioner.js";
import type { AmqpPublishFn } from "./webhook-handler.js";
import type { Database } from "bun:sqlite";
import type {
  CredentialPushRequest,
  ProjectConfig,
  ProvisionRequest,
} from "../shared/types.js";

const GWA_API_KEY = process.env.GWA_API_KEY || "";

export interface RestApiDeps {
  aggregator: SessionAggregator;
  publishToAmqp: AmqpPublishFn;
  db: Database;
  provisioner: EnvironmentProvisioner;
}

/** Parse a URL path into segments */
function parsePath(url: string): string[] {
  const { pathname } = new URL(url);
  return pathname.split("/").filter(Boolean);
}

/** Check API key auth for credential-sensitive routes */
function checkApiKey(request: Request): boolean {
  if (!GWA_API_KEY) return false;
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  return token === GWA_API_KEY;
}

/** Create the REST API request handler */
export function createRestApi(deps: RestApiDeps) {
  const { aggregator, publishToAmqp, db, provisioner } = deps;

  return async function handleRequest(request: Request): Promise<Response> {
    const segments = parsePath(request.url);
    const method = request.method;

    try {
      // GET /health
      if (method === "GET" && segments[0] === "health") {
        return json({
          status: "ok",
          uptime: process.uptime(),
          pods: aggregator.getPodHealth(),
          sessionCount: aggregator.getSessions().length,
        });
      }

      // -----------------------------------------------------------------------
      // Session endpoints (existing)
      // -----------------------------------------------------------------------

      // GET /sessions
      if (method === "GET" && segments[0] === "sessions" && segments.length === 1) {
        const sessions = aggregator.getSessions();
        return json(sessions);
      }

      // GET /sessions/:id
      if (method === "GET" && segments[0] === "sessions" && segments.length === 2) {
        const sessionId = segments[1];
        const session = aggregator.getSession(sessionId);
        if (!session) {
          return json({ error: "Session not found" }, 404);
        }
        const activity = aggregator.getActivityFeed(sessionId);
        return json({ ...session, activity });
      }

      // POST /sessions/:id/answer
      if (method === "POST" && segments[0] === "sessions" && segments[2] === "answer") {
        const sessionId = segments[1];
        const session = aggregator.getSession(sessionId);
        if (!session) {
          return json({ error: "Session not found" }, 404);
        }

        const body = (await request.json()) as { answer: string };
        if (!body.answer) {
          return json({ error: "Missing answer field" }, 400);
        }

        await publishToAmqp(`gwa.commands.send_answer`, {
          sessionId,
          answer: body.answer,
          timestamp: Date.now(),
        });

        return json({ status: "answer_sent", sessionId });
      }

      // GET /sessions/:id/snapshots
      if (method === "GET" && segments[0] === "sessions" && segments[2] === "snapshots") {
        const sessionId = segments[1];
        const snapshots = db
          .query(
            `SELECT session_id, event_type, created_at FROM activity_feed
             WHERE session_id = ? AND routing_key LIKE '%snapshot%'
             ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sessionId);
        return json(snapshots);
      }

      // GET /sessions/:id/recordings
      if (method === "GET" && segments[0] === "sessions" && segments[2] === "recordings") {
        const sessionId = segments[1];
        const recordings = db
          .query(
            `SELECT session_id, payload, created_at FROM activity_feed
             WHERE session_id = ? AND routing_key LIKE '%recording%'
             ORDER BY created_at DESC LIMIT 20`,
          )
          .all(sessionId);
        return json(recordings);
      }

      // -----------------------------------------------------------------------
      // Project / provisioning endpoints (new)
      // -----------------------------------------------------------------------

      if (segments[0] === "projects") {
        // GET /projects — list projects with credential health
        if (method === "GET" && segments.length === 1) {
          if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
          const projects = provisioner.listProjects();
          return json(projects);
        }

        // POST /projects — create a project
        if (method === "POST" && segments.length === 1) {
          if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
          const body = (await request.json()) as {
            id: string;
            displayName: string;
          } & Partial<ProjectConfig>;
          if (!body.id || !body.displayName) {
            return json({ error: "Missing id or displayName" }, 400);
          }
          try {
            const project = provisioner.createProject(body.id, body.displayName, body);
            return json(project, 201);
          } catch (error) {
            if (String(error).includes("UNIQUE constraint")) {
              return json({ error: "Project already exists" }, 409);
            }
            throw error;
          }
        }

        // Routes that require a project ID: /projects/:id/*
        if (segments.length >= 2) {
          const projectId = segments[1];

          // GET /projects/:id
          if (method === "GET" && segments.length === 2) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const project = provisioner.getProject(projectId);
            if (!project) return json({ error: "Project not found" }, 404);
            const health = provisioner.getCredentialHealth(projectId);
            return json({ ...project, credentialHealth: health });
          }

          // PUT /projects/:id — update project config
          if (method === "PUT" && segments.length === 2) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const body = (await request.json()) as Partial<ProjectConfig>;
            const updated = provisioner.updateProject(projectId, body);
            if (!updated) return json({ error: "Project not found" }, 404);
            return json(updated);
          }

          // POST /projects/:id/credentials — push fresh credentials
          if (method === "POST" && segments[2] === "credentials" && segments.length === 3) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const body = (await request.json()) as CredentialPushRequest;
            if (!body.accessToken || !body.expiresAt) {
              return json({ error: "Missing accessToken or expiresAt" }, 400);
            }
            const pushedBy = request.headers.get("X-Pushed-By") || undefined;
            const credential = provisioner.pushCredential(projectId, body, pushedBy);
            return json(credential, 201);
          }

          // POST /projects/:id/provision — main endpoint for pods
          if (method === "POST" && segments[2] === "provision" && segments.length === 3) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const body = (await request.json()) as ProvisionRequest;
            if (!body.podName) {
              return json({ error: "Missing podName" }, 400);
            }
            const result = await provisioner.provision(projectId, body);
            return json(result);
          }

          // POST /projects/:id/refresh — manually trigger OAuth refresh
          if (method === "POST" && segments[2] === "refresh" && segments.length === 3) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const credential = await provisioner.refreshCredential(projectId);
            if (!credential) {
              return json({ error: "Refresh failed — no refresh token or OAuth error" }, 400);
            }
            return json(credential);
          }

          // GET /projects/:id/health — credential health status
          if (method === "GET" && segments[2] === "health" && segments.length === 3) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const project = provisioner.getProject(projectId);
            if (!project) return json({ error: "Project not found" }, 404);
            const health = provisioner.getCredentialHealth(projectId);
            return json(health);
          }

          // GET /projects/:id/credentials/history — credential history with bundles
          if (method === "GET" && segments[2] === "credentials" && segments[3] === "history" && segments.length === 4) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const project = provisioner.getProject(projectId);
            if (!project) return json({ error: "Project not found" }, 404);
            const url = new URL(request.url);
            const limit = parseInt(url.searchParams.get("limit") || "10", 10);
            const history = provisioner.getCredentialHistory(projectId, limit);
            return json(history);
          }

          // POST /projects/:id/credentials/prune — prune old credentials and bundles
          if (method === "POST" && segments[2] === "credentials" && segments[3] === "prune" && segments.length === 4) {
            if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
            const project = provisioner.getProject(projectId);
            if (!project) return json({ error: "Project not found" }, 404);
            const body = (await request.json().catch(() => ({}))) as { maxAgeMs?: number };
            const result = await provisioner.pruneOldCredentials(projectId, body.maxAgeMs);
            return json(result);
          }
        }
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(`[RestAPI] Error handling ${method} /${segments.join("/")}:`, error);
      return json({ error: "Internal server error" }, 500);
    }
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
