import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { $ } from "bun";
import type { ProvisionResponse } from "../shared/types.js";

const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT || "minio.bto.bar:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "gwa-recordings";

// Orchestrator provisioning config — read at call time (not module load)
// so tests and runtime changes to env vars take effect
const ORCHESTRATOR_TIMEOUT_MS = 10_000; // 10 seconds

// Pod name from env (set by K8s downward API); falls back to hostname
const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "unknown-pod";

/** Tracks the current active bundle ID (set after successful provision) */
let currentBundleId: string | undefined;

/**
 * S3 key for this pod's credentials backup.
 * Each pod stores its own so any pod can serve as a fallback for another.
 * Format: claude-auth/pods/<pod-name>/credentials.tar.gz
 */
function podCredentialsKey(podName: string): string {
  return `claude-auth/pods/${podName}/credentials.tar.gz`;
}

/** Legacy single-copy key — kept for backwards compat during transition */
const LEGACY_CREDENTIALS_S3_KEY = "claude-auth/credentials.tar.gz";

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: `http://${MINIO_ENDPOINT}`,
    region: "us-east-1",
    credentials: {
      accessKeyId: MINIO_ACCESS_KEY,
      secretAccessKey: MINIO_SECRET_KEY,
    },
    forcePathStyle: true,
  });
}

// Path helpers — read HOME at call time so tests can override process.env.HOME
function getHome(): string { return process.env.HOME || "/home/runner"; }
function getClaudeDir(): string { return join(getHome(), ".claude"); }
function getCredentialsPath(): string { return join(getClaudeDir(), ".credentials.json"); }
function getSettingsPath(): string { return join(getHome(), ".claude.json"); }
function getConfigDir(): string { return join(getHome(), ".config", "claude"); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }

/**
 * Sync ~/.config/claude/config.json from ~/.claude/.credentials.json.
 * The headless mode needs config.json; TUI needs .credentials.json.
 * Must be called on every pod start since ~/.config/claude/ is ephemeral.
 */
export function syncConfigFromCredentials(): void {
  if (!existsSync(getCredentialsPath())) return;

  try {
    const creds = JSON.parse(readFileSync(getCredentialsPath(), "utf-8"));
    const accessToken =
      creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (!accessToken) return;

    mkdirSync(getConfigDir(), { recursive: true });
    writeFileSync(
      getConfigPath(),
      JSON.stringify({ oauthToken: accessToken }, null, 2)
    );
    console.log(
      "[CredentialsManager] Synced ~/.config/claude/config.json from credentials"
    );
  } catch (e) {
    console.warn("[CredentialsManager] Failed to sync config:", e);
  }
}

/**
 * Check whether the stored Claude OAuth credentials are expired or near expiry.
 * Returns true if the file is missing, unparseable, or will expire within 5 minutes.
 * Safe to call before every Claude invocation — only reads a local file.
 */
export function isCredentialExpired(): boolean {
  if (!existsSync(getCredentialsPath())) return true;
  try {
    const raw = readFileSync(getCredentialsPath(), "utf-8");
    const creds = JSON.parse(raw);
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    if (!expiresAt || typeof expiresAt !== "number") return true;
    const FIVE_MIN_MS = 5 * 60 * 1000;
    return expiresAt < Date.now() + FIVE_MIN_MS;
  } catch {
    return true; // unparseable → treat as expired
  }
}

/**
 * Provision environment from the orchestrator service.
 *
 * Calls POST /projects/:id/provision, then downloads and extracts the
 * tar.gz bundle from MinIO. Returns true if valid credentials were provisioned.
 *
 * Falls back gracefully: returns false on any error or timeout (10s).
 */
export async function provisionFromOrchestrator(): Promise<boolean> {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || "";
  const projectId = process.env.GWA_PROJECT_ID || "";
  const apiKey = process.env.GWA_API_KEY || "";

  if (!orchestratorUrl || !projectId || !apiKey) {
    console.log("[CredentialsManager] Orchestrator not configured, skipping orchestrator provision");
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ORCHESTRATOR_TIMEOUT_MS);

    const provisionUrl = `${orchestratorUrl}/projects/${projectId}/provision`;
    const response = await fetch(provisionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        podName: POD_NAME,
        currentBundleId,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`[CredentialsManager] Orchestrator provision failed: ${response.status}`);
      return false;
    }

    const result = (await response.json()) as ProvisionResponse;

    if (result.status === "current") {
      console.log("[CredentialsManager] Orchestrator says current bundle is still valid");
      // Bundle is current — credentials should still be on disk
      if (!isCredentialExpired()) return true;
      // Credentials on disk are expired even though bundle is "current" — re-provision
      console.warn("[CredentialsManager] Bundle marked current but local credentials expired, will re-download");
    }

    if (result.status === "no_credentials") {
      console.warn(`[CredentialsManager] Orchestrator has no credentials: ${result.message}`);
      return false;
    }

    if (result.status === "provisioned" && result.s3Key) {
      // Download bundle from MinIO and extract
      const extracted = await downloadAndExtractBundle(result.s3Key, result.s3Bucket);
      if (!extracted) return false;

      currentBundleId = result.bundleId;
      syncConfigFromCredentials();

      // Validate the extracted credentials
      if (isCredentialExpired()) {
        console.warn("[CredentialsManager] Provisioned credentials are expired");
        return false;
      }

      // Update process.env
      updateEnvFromCredentials();

      console.log(`[CredentialsManager] Provisioned from orchestrator (bundle ${result.bundleId})`);
      return true;
    }

    console.warn(`[CredentialsManager] Unexpected provision status: ${result.status}`);
    return false;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.warn("[CredentialsManager] Orchestrator provision timed out");
    } else {
      console.warn("[CredentialsManager] Orchestrator provision error:", error);
    }
    return false;
  }
}

/**
 * Download a tar.gz bundle from MinIO and extract to $HOME.
 */
async function downloadAndExtractBundle(s3Key: string, s3Bucket?: string): Promise<boolean> {
  const tarPath = `/tmp/env-bundle-${Date.now()}.tar.gz`;
  try {
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: s3Bucket || MINIO_BUCKET,
        Key: s3Key,
      }),
    );
    const body = response.Body;
    if (!body) return false;

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));
    mkdirSync(getClaudeDir(), { recursive: true });
    mkdirSync(getConfigDir(), { recursive: true });
    await $`tar xzf ${tarPath} -C ${getHome()} 2>/dev/null`.quiet();
    console.log(`[CredentialsManager] Extracted bundle from ${s3Key}`);
    return true;
  } catch (e) {
    console.warn(`[CredentialsManager] Failed to download/extract bundle:`, e);
    return false;
  } finally {
    try { await $`rm -f ${tarPath}`.quiet(); } catch {}
  }
}

/**
 * Read the current access token from on-disk credentials, falling back to env var.
 * Use this at Claude subprocess spawn time to get the freshest token —
 * the env var may be stale if credentials were refreshed after pod startup.
 */
export function getAccessToken(): string | undefined {
  try {
    if (existsSync(getCredentialsPath())) {
      const raw = readFileSync(getCredentialsPath(), "utf-8");
      const creds = JSON.parse(raw);
      const diskToken = creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
      if (diskToken) return diskToken;
    }
  } catch {
    // Fall through to env var
  }
  return process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

/** Update process.env.CLAUDE_CODE_OAUTH_TOKEN from on-disk credentials */
function updateEnvFromCredentials(): void {
  try {
    const raw = readFileSync(getCredentialsPath(), "utf-8");
    const creds = JSON.parse(raw);
    const accessToken = creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (accessToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
      console.log("[CredentialsManager] Updated CLAUDE_CODE_OAUTH_TOKEN from credentials");
    }
  } catch (e) {
    console.warn("[CredentialsManager] Failed to read credentials for env update:", e);
  }
}

/**
 * Attempt to recover Claude credentials from MinIO.
 *
 * Deletes the local (expired) credentials file first so that
 * `restoreCredentialsIfMissing` is not fooled into skipping MinIO.
 *
 * Note: callers should try `provisionFromOrchestrator()` first — this function
 * is the MinIO-only fallback path. The orchestrator call lives at the call site
 * (orchestrate.ts, start-planning.ts, resume-with-failures.ts) to avoid
 * double-calling the orchestrator.
 *
 * Returns true if valid credentials were restored, false if MinIO had nothing.
 */
export async function tryRecoverCredentials(): Promise<boolean> {
  // Guard: if MinIO is not configured, don't destroy the local credentials file
  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn("[CredentialsManager] MinIO not configured, skipping credential recovery");
    return false;
  }

  if (existsSync(getCredentialsPath())) {
    try {
      unlinkSync(getCredentialsPath());
      console.log("[CredentialsManager] Deleted expired credentials to force MinIO restore");
    } catch (e) {
      console.warn("[CredentialsManager] Failed to delete expired credentials:", e);
      return false; // Cannot safely proceed — expired file still present
    }
  }

  const restored = await restoreCredentialsIfMissing();
  if (!restored) return false;

  // Validate the restored credentials are not themselves expired
  if (isCredentialExpired()) {
    console.warn("[CredentialsManager] Restored credentials from MinIO are still expired");
    return false;
  }

  // Update process.env so headless Claude subprocess receives the fresh token
  updateEnvFromCredentials();

  return true;
}

/**
 * Back up Claude credentials to MinIO.
 * Tars: ~/.claude/.credentials.json + ~/.claude.json
 */
export async function backupCredentials(): Promise<boolean> {
  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn(
      "[CredentialsManager] MinIO credentials not set, skipping backup"
    );
    return false;
  }

  // Guard: do not back up expired credentials.
  // Restoring an expired backup is worse than having no backup —
  // it causes tryRecoverCredentials to fail the post-restore expiry check.
  if (isCredentialExpired()) {
    console.warn("[CredentialsManager] Skipping backup: credentials are expired or near expiry");
    return false;
  }

  if (!existsSync(getCredentialsPath())) {
    console.warn(
      "[CredentialsManager] No credentials file found, skipping backup"
    );
    return false;
  }

  const tarPath = "/tmp/claude-credentials.tar.gz";
  let success = false;
  try {
    // Include .claude.json only if it exists (settings file)
    const filesToTar = [".claude/.credentials.json"];
    if (existsSync(getSettingsPath())) {
      filesToTar.push(".claude.json");
    }

    await $`tar czf ${tarPath} -C ${getHome()} ${filesToTar} 2>/dev/null`.quiet();

    const data = readFileSync(tarPath);
    const client = getS3Client();
    const backedUpAt = new Date().toISOString();

    // Write to pod-specific path (primary)
    const podKey = podCredentialsKey(POD_NAME);
    await client.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: podKey,
        Body: data,
        ContentType: "application/gzip",
        Metadata: { "backed-up-at": backedUpAt, "pod-name": POD_NAME },
      })
    );

    // Also write to legacy single-copy path for backwards compat
    await client.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: LEGACY_CREDENTIALS_S3_KEY,
        Body: data,
        ContentType: "application/gzip",
        Metadata: { "backed-up-at": backedUpAt, "source-pod": POD_NAME },
      })
    );

    console.log(
      `[CredentialsManager] Credentials backed up to MinIO: ${podKey} + legacy key`
    );
    success = true;
  } catch (e) {
    console.warn("[CredentialsManager] Backup failed:", e);
  } finally {
    try {
      await $`rm -f ${tarPath}`.quiet();
    } catch {}
  }
  return success;
}

/**
 * Try to restore credentials from a specific S3 key.
 * Returns true on success.
 */
async function tryRestoreFromKey(
  client: S3Client,
  key: string,
  label: string
): Promise<boolean> {
  const tarPath = `/tmp/claude-credentials-restore-${Date.now()}.tar.gz`;
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key })
    );
    const body = response.Body;
    if (!body) return false;

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));
    mkdirSync(getClaudeDir(), { recursive: true });
    await $`tar xzf ${tarPath} -C ${getHome()} 2>/dev/null`.quiet();
    console.log(`[CredentialsManager] Restored from ${label} (${key})`);
    return true;
  } catch {
    return false;
  } finally {
    try { await $`rm -f ${tarPath}`.quiet(); } catch {}
  }
}

/**
 * Restore Claude credentials from MinIO if ~/.claude/.credentials.json is missing.
 *
 * Restore priority:
 *   1. This pod's own backup: claude-auth/pods/<POD_NAME>/credentials.tar.gz
 *   2. Any other pod backup: claude-auth/pods/<other-pod>/credentials.tar.gz
 *      (any pod's valid refresh token works — Claude will auto-refresh access token)
 *   3. Legacy single-copy: claude-auth/credentials.tar.gz
 */
export async function restoreCredentialsIfMissing(): Promise<boolean> {
  if (existsSync(getCredentialsPath())) {
    console.log("[CredentialsManager] Credentials already present, syncing config");
    syncConfigFromCredentials();
    return true;
  }

  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn("[CredentialsManager] MinIO credentials not set, cannot restore");
    return false;
  }

  const client = getS3Client();

  // 1. Try own pod's backup first
  const ownKey = podCredentialsKey(POD_NAME);
  if (await tryRestoreFromKey(client, ownKey, `own pod ${POD_NAME}`)) {
    syncConfigFromCredentials();
    return true;
  }

  // 2. Try other pods' backups — list all under claude-auth/pods/
  try {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: MINIO_BUCKET,
        Prefix: "claude-auth/pods/",
      })
    );

    const otherKeys = (list.Contents ?? [])
      .map((obj) => obj.Key ?? "")
      .filter((k) => k.endsWith("credentials.tar.gz") && k !== ownKey)
      // Sort by LastModified descending (most recent first) if available
      .sort();

    for (const key of otherKeys) {
      const podLabel = key.split("/")[2] ?? "unknown";
      console.log(`[CredentialsManager] Trying fallback from pod: ${podLabel}`);
      if (await tryRestoreFromKey(client, key, `fallback pod ${podLabel}`)) {
        syncConfigFromCredentials();
        return true;
      }
    }
  } catch (e) {
    console.warn("[CredentialsManager] Failed to list pod backups:", e);
  }

  // 3. Try legacy single-copy as last resort
  if (await tryRestoreFromKey(client, LEGACY_CREDENTIALS_S3_KEY, "legacy backup")) {
    syncConfigFromCredentials();
    return true;
  }

  console.warn("[CredentialsManager] No credentials found in MinIO (first pod deployment)");
  return false;
}
