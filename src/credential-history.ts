#!/usr/bin/env bun
/**
 * Credential History CLI
 *
 * Queries the orchestrator for credential refresh history and associated bundles.
 * Optionally prunes entries older than 24 hours.
 *
 * Usage:
 *   gwa-credential-history --project gwa --orchestrator http://localhost:3001
 *   gwa-credential-history --project gwa --prune
 */

import { parseArgs } from "util";
import type { CredentialHistoryEntry } from "./shared/types.js";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    project: { type: "string", short: "p" },
    orchestrator: { type: "string", short: "o" },
    "api-key": { type: "string", short: "k" },
    limit: { type: "string", short: "n" },
    prune: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: gwa-credential-history [options]

Options:
  -p, --project <id>          Project ID (default: GWA_PROJECT_ID env var)
  -o, --orchestrator <url>    Orchestrator URL (default: ORCHESTRATOR_URL env var)
  -k, --api-key <key>         API key (default: GWA_API_KEY env var)
  -n, --limit <count>         Number of entries to show (default: 10)
      --prune                 Prune credentials older than 24 hours
  -h, --help                  Show this help
`);
  process.exit(0);
}

const projectId = values.project || process.env.GWA_PROJECT_ID;
const orchestratorUrl = values.orchestrator || process.env.ORCHESTRATOR_URL;
const apiKey = values["api-key"] || process.env.GWA_API_KEY;
const limit = parseInt(values.limit || "10", 10);

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

const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

// Prune if requested
if (values.prune) {
  const pruneResp = await fetch(
    `${orchestratorUrl}/projects/${projectId}/credentials/prune`,
    { method: "POST", headers, body: JSON.stringify({}) },
  );
  if (!pruneResp.ok) {
    console.error(`Error: Prune failed: ${pruneResp.status} ${await pruneResp.text()}`);
    process.exit(1);
  }
  const result = (await pruneResp.json()) as {
    prunedCredentials: number;
    prunedBundles: number;
    deletedS3Objects: number;
  };
  console.log(
    `Pruned: ${result.prunedCredentials} credentials, ${result.prunedBundles} bundles, ${result.deletedS3Objects} S3 objects`,
  );
  console.log();
}

// Fetch history
const historyResp = await fetch(
  `${orchestratorUrl}/projects/${projectId}/credentials/history?limit=${limit}`,
  { headers },
);
if (!historyResp.ok) {
  console.error(`Error: ${historyResp.status} ${await historyResp.text()}`);
  process.exit(1);
}

const entries = (await historyResp.json()) as CredentialHistoryEntry[];

if (entries.length === 0) {
  console.log("No credential history found.");
  process.exit(0);
}

// Format and display table
const now = Date.now();

function fmtTime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function fmtExpiry(epochMs: number): string {
  const ts = new Date(epochMs).toISOString().replace("T", " ").slice(0, 19) + "Z";
  const remaining = epochMs - now;
  if (remaining <= 0) return `${ts} (EXPIRED)`;
  const hours = (remaining / 3600000).toFixed(1);
  return `${ts} (${hours}h left)`;
}

function fmtStatus(entry: CredentialHistoryEntry): string {
  if (entry.invalidatedAt) return "invalidated";
  if (entry.expiresAt < now) return "expired";
  return "active";
}

// Print header
console.log(`Credential history for project: ${projectId}`);
console.log(`${"─".repeat(120)}`);
console.log(
  padRight("#", 3) +
    padRight("Source", 9) +
    padRight("Status", 13) +
    padRight("Created", 22) +
    padRight("Expires", 36) +
    padRight("Bundle", 40),
);
console.log(`${"─".repeat(120)}`);

for (let i = 0; i < entries.length; i++) {
  const e = entries[i];
  const idx = String(i + 1);
  const source = e.source + (e.pushedBy ? ` (${e.pushedBy})` : "");
  const status = fmtStatus(e);
  const created = fmtTime(e.createdAt);
  const expires = fmtExpiry(e.expiresAt);
  const bundle = e.bundleId
    ? `v${e.bundleVersion} ${e.bundleId.slice(0, 8)}...`
    : "(no bundle)";

  console.log(
    padRight(idx, 3) +
      padRight(source, 9) +
      padRight(status, 13) +
      padRight(created, 22) +
      padRight(expires, 36) +
      padRight(bundle, 40),
  );

  // Second line: token prefix and S3 key
  const tokenLine = `   token: ${e.tokenPrefix}`;
  const s3Line = e.bundleS3Key ? `  s3: ${e.bundleS3Key}` : "";
  console.log(tokenLine + s3Line);
}

console.log(`${"─".repeat(120)}`);

function padRight(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}
