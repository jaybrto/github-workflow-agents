import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { $ } from "bun";

const MINIO_ENDPOINT =
  process.env.MINIO_ENDPOINT || "minio.bto.bar:9000";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "gwa-recordings";
const CREDENTIALS_S3_KEY = "claude-auth/credentials.tar.gz";

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
 * Back up Claude credentials to MinIO.
 * Tars: ~/.claude/.credentials.json + ~/.claude.json
 */
export async function backupCredentials(): Promise<void> {
  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn(
      "[CredentialsManager] MinIO credentials not set, skipping backup"
    );
    return;
  }

  if (!existsSync(CREDENTIALS_PATH)) {
    console.warn(
      "[CredentialsManager] No credentials file found, skipping backup"
    );
    return;
  }

  const tarPath = "/tmp/claude-credentials.tar.gz";
  try {
    // Include .claude.json only if it exists (settings file)
    const filesToTar = [".claude/.credentials.json"];
    if (existsSync(SETTINGS_PATH)) {
      filesToTar.push(".claude.json");
    }

    await $`tar czf ${tarPath} -C ${HOME} ${filesToTar} 2>/dev/null`.quiet();

    const data = readFileSync(tarPath);
    const client = getS3Client();

    await client.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: CREDENTIALS_S3_KEY,
        Body: data,
        ContentType: "application/gzip",
        Metadata: { "backed-up-at": new Date().toISOString() },
      })
    );

    console.log(
      "[CredentialsManager] Credentials backed up to MinIO successfully"
    );
  } catch (e) {
    console.warn("[CredentialsManager] Backup failed:", e);
  } finally {
    try {
      await $`rm -f ${tarPath}`.quiet();
    } catch {}
  }
}

/**
 * Restore Claude credentials from MinIO if ~/.claude/.credentials.json is missing.
 * Called on pod startup for new pods.
 */
export async function restoreCredentialsIfMissing(): Promise<boolean> {
  if (existsSync(CREDENTIALS_PATH)) {
    console.log(
      "[CredentialsManager] Credentials already present, skipping restore"
    );
    syncConfigFromCredentials();
    return true;
  }

  if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    console.warn(
      "[CredentialsManager] MinIO credentials not set, cannot restore"
    );
    return false;
  }

  const tarPath = "/tmp/claude-credentials-restore.tar.gz";
  try {
    const client = getS3Client();
    const response = await client.send(
      new GetObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: CREDENTIALS_S3_KEY,
      })
    );

    const body = response.Body;
    if (!body) throw new Error("Empty response body");

    // Stream to file
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    writeFileSync(tarPath, Buffer.concat(chunks));

    // Ensure target directory exists
    mkdirSync(CLAUDE_DIR, { recursive: true });

    // Extract to home directory
    await $`tar xzf ${tarPath} -C ${HOME} 2>/dev/null`.quiet();

    console.log("[CredentialsManager] Credentials restored from MinIO");
    syncConfigFromCredentials();
    return true;
  } catch (e) {
    console.warn(
      "[CredentialsManager] Restore failed (may be first pod):",
      e
    );
    return false;
  } finally {
    try {
      await $`rm -f ${tarPath}`.quiet();
    } catch {}
  }
}
