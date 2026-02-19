#!/usr/bin/env bun
/**
 * Provision CLI
 *
 * Requests an environment bundle from the orchestrator and extracts it
 * to the current user's home directory. Called from entrypoint.sh at
 * pod startup or manually for testing.
 *
 * Usage:
 *   gwa-provision --project gwa --orchestrator http://gwa-orchestrator:3001
 */

import { parseArgs } from "util";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { ProvisionResponse } from "./shared/types.js";

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
  console.log(`Usage: gwa-provision [options]

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
const podName = process.env.POD_NAME || process.env.HOSTNAME || "unknown-pod";

const HOME = process.env.HOME || "/home/runner";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio.bto.bar:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "gwa-recordings";

if (!projectId || !orchestratorUrl || !apiKey) {
  console.log("[Provision] Missing config (project/orchestrator/api-key), skipping orchestrator provision");
  process.exit(0); // Graceful exit — not an error
}

async function main() {
  console.log(`[Provision] Requesting environment for project "${projectId}" from ${orchestratorUrl}`);

  try {
    const response = await fetch(`${orchestratorUrl}/projects/${projectId}/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ podName }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[Provision] Orchestrator returned ${response.status}, skipping`);
      process.exit(0);
    }

    const result = (await response.json()) as ProvisionResponse;

    if (result.status === "current") {
      console.log("[Provision] Current environment is still valid");
      process.exit(0);
    }

    if (result.status === "no_credentials") {
      console.warn(`[Provision] No credentials available: ${result.message}`);
      process.exit(0);
    }

    if (result.status === "provisioned" && result.s3Key) {
      console.log(`[Provision] Downloading bundle: ${result.s3Key}`);

      const s3 = new S3Client({
        endpoint: `http://${MINIO_ENDPOINT}`,
        region: "us-east-1",
        credentials: {
          accessKeyId: MINIO_ACCESS_KEY,
          secretAccessKey: MINIO_SECRET_KEY,
        },
        forcePathStyle: true,
      });

      const getResp = await s3.send(
        new GetObjectCommand({
          Bucket: result.s3Bucket || MINIO_BUCKET,
          Key: result.s3Key,
        }),
      );

      const body = getResp.Body;
      if (!body) {
        console.warn("[Provision] Empty response body from MinIO");
        process.exit(0);
      }

      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }

      const tarPath = `/tmp/env-provision-${Date.now()}.tar.gz`;
      writeFileSync(tarPath, Buffer.concat(chunks));

      // Ensure target directories exist
      mkdirSync(join(HOME, ".claude"), { recursive: true });
      mkdirSync(join(HOME, ".config", "claude"), { recursive: true });

      // Extract
      await $`tar xzf ${tarPath} -C ${HOME} 2>/dev/null`.quiet();
      await $`rm -f ${tarPath}`.quiet();

      console.log(`[Provision] Environment provisioned (bundle ${result.bundleId})`);

      // Verify credentials exist
      const credsPath = join(HOME, ".claude", ".credentials.json");
      if (existsSync(credsPath)) {
        console.log("[Provision] Credentials file verified");
      } else {
        console.warn("[Provision] Warning: credentials file not found after extraction");
      }

      process.exit(0);
    }

    console.warn(`[Provision] Unexpected status: ${result.status}`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.warn("[Provision] Orchestrator timed out, skipping");
    } else {
      console.warn("[Provision] Error:", error);
    }
  }

  process.exit(0); // Always exit cleanly — provision failure shouldn't block pod startup
}

main();
