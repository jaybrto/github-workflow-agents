#!/usr/bin/env bun
/**
 * Push Credentials CLI
 *
 * Reads local ~/.claude/.credentials.json and pushes it to the
 * orchestrator's environment provisioning system.
 *
 * Usage:
 *   gwa-push-credentials --project gwa --orchestrator http://localhost:3001
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string", short: "p" },
    orchestrator: { type: "string", short: "o" },
    "api-key": { type: "string", short: "k" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: gwa-push-credentials [options]

Options:
  -p, --project <id>          Project ID (default: GWA_PROJECT_ID env var)
  -o, --orchestrator <url>    Orchestrator URL (default: ORCHESTRATOR_URL env var)
  -k, --api-key <key>         API key (default: GWA_API_KEY env var)
  -h, --help                  Show this help
`);
  process.exit(0);
}

const projectId = values.project || process.env.GWA_PROJECT_ID;
const orchestratorUrl = values.orchestrator || process.env.ORCHESTRATOR_URL;
const apiKey = values["api-key"] || process.env.GWA_API_KEY;

if (!projectId) {
  console.error("Error: --project or GWA_PROJECT_ID required");
  process.exit(1);
}
if (!orchestratorUrl) {
  console.error("Error: --orchestrator or ORCHESTRATOR_URL required");
  process.exit(1);
}
if (!apiKey) {
  console.error("Error: --api-key or GWA_API_KEY required");
  process.exit(1);
}

const HOME = process.env.HOME || "";
const credentialsPath = join(HOME, ".claude", ".credentials.json");

if (!existsSync(credentialsPath)) {
  console.error(`Error: No credentials file found at ${credentialsPath}`);
  console.error("Run 'claude auth login' first to authenticate.");
  process.exit(1);
}

let creds: Record<string, unknown>;
try {
  creds = JSON.parse(readFileSync(credentialsPath, "utf-8"));
} catch (e) {
  console.error(`Error: Failed to parse ${credentialsPath}:`, e);
  process.exit(1);
}

const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
if (!oauth?.accessToken) {
  console.error("Error: No accessToken found in credentials file");
  process.exit(1);
}

// Check expiry
const expiresAt = oauth.expiresAt as number;
if (expiresAt && expiresAt < Date.now()) {
  console.warn("Warning: These credentials are already expired. Push anyway? (The orchestrator may be able to refresh them.)");
}

// Ensure the project exists (create if needed)
const projectUrl = `${orchestratorUrl}/projects/${projectId}`;
const checkResp = await fetch(projectUrl, {
  headers: { "Authorization": `Bearer ${apiKey}` },
});
if (checkResp.status === 404) {
  console.log(`Project "${projectId}" not found, creating...`);
  const createResp = await fetch(`${orchestratorUrl}/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ id: projectId, displayName: projectId }),
  });
  if (!createResp.ok) {
    console.error(`Error: Failed to create project: ${createResp.status} ${await createResp.text()}`);
    process.exit(1);
  }
  console.log(`Project "${projectId}" created.`);
}

// Push credentials
const pushUrl = `${orchestratorUrl}/projects/${projectId}/credentials`;
const response = await fetch(pushUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Pushed-By": process.env.USER || "unknown",
  },
  body: JSON.stringify({
    accessToken: oauth.accessToken as string,
    refreshToken: (oauth.refreshToken as string) || undefined,
    expiresAt: expiresAt,
    accountUuid: (oauth.accountUuid as string) || undefined,
    emailAddress: (oauth.emailAddress as string) || undefined,
    organizationUuid: (oauth.organizationUuid as string) || undefined,
    billingType: (oauth.billingType as string) || undefined,
    displayName: (oauth.displayName as string) || undefined,
  }),
});

if (!response.ok) {
  console.error(`Error: Push failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const result = await response.json();
console.log("Credentials pushed successfully.");
console.log(`  Credential ID: ${(result as Record<string, unknown>).id}`);
console.log(`  Expires at: ${new Date(expiresAt).toISOString()}`);
if (expiresAt > Date.now()) {
  const hoursLeft = ((expiresAt - Date.now()) / 3600000).toFixed(1);
  console.log(`  Time remaining: ${hoursLeft}h`);
}
