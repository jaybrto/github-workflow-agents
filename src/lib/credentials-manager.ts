import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT || "minio.bto.bar:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "gwa-recordings";

// Pod name from env (set by K8s downward API); falls back to hostname
const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "unknown-pod";

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

const HOME = process.env.HOME || "/home/runner";
const CLAUDE_DIR = join(HOME, ".claude");
const CREDENTIALS_PATH = join(CLAUDE_DIR, ".credentials.json");
const SETTINGS_PATH = join(HOME, ".claude.json");
const CONFIG_DIR = join(HOME, ".config", "claude");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Sync ~/.config/claude/config.json from ~/.claude/.credentials.json.
 * The headless mode needs config.json; TUI needs .credentials.json.
 * Must be called on every pod start since ~/.config/claude/ is ephemeral.
 */
export function syncConfigFromCredentials(): void {
  if (!existsSync(CREDENTIALS_PATH)) return;

  try {
    const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
    const accessToken =
      creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (!accessToken) return;

    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
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
  if (!existsSync(CREDENTIALS_PATH)) return true;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
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
 * Attempt to recover Claude credentials from MinIO.
 *
 * Deletes the local (expired) credentials file first so that
 * `restoreCredentialsIfMissing` is not fooled into skipping MinIO.
 *
 * Returns true if valid credentials were restored, false if MinIO had nothing.
 */
export async function tryRecoverCredentials(): Promise<boolean> {
  // Guard: if MinIO is not configured, don't destroy the local credentials file
  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn("[CredentialsManager] MinIO not configured, skipping credential recovery");
    return false;
  }

  if (existsSync(CREDENTIALS_PATH)) {
    try {
      unlinkSync(CREDENTIALS_PATH);
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
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    const creds = JSON.parse(raw);
    const accessToken = creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (accessToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
      console.log("[CredentialsManager] Updated CLAUDE_CODE_OAUTH_TOKEN from restored credentials");
    }
  } catch (e) {
    console.warn("[CredentialsManager] Failed to read restored credentials for env update:", e);
    // Non-fatal: the credentials file is valid (passed isCredentialExpired), continue
  }

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

  if (!existsSync(CREDENTIALS_PATH)) {
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
    if (existsSync(SETTINGS_PATH)) {
      filesToTar.push(".claude.json");
    }

    await $`tar czf ${tarPath} -C ${HOME} ${filesToTar} 2>/dev/null`.quiet();

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
    mkdirSync(CLAUDE_DIR, { recursive: true });
    await $`tar xzf ${tarPath} -C ${HOME} 2>/dev/null`.quiet();
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
  if (existsSync(CREDENTIALS_PATH)) {
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
