/**
 * Dependency Updater Module
 *
 * Checks for updates to Claude CLI and SDKs.
 * Queues updates if sessions are active, applies them on pod startup.
 */

import { getDatabase, logActivity, getActiveSessionCount } from "./db.js";
import { execSync, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type UpdateType = "image" | "npm" | "cli" | "all";

export interface UpdateInfo {
  package: string;
  installedVersion: string | null;
  latestVersion: string | null;
  needsUpdate: boolean;
}

export interface QueuedUpdate {
  id: number;
  updateType: UpdateType;
  targetVersion: string | null;
  reason: string | null;
  queuedAt: number;
  status: string;
}

/**
 * Check for updates to Claude CLI and SDKs.
 */
export async function checkForUpdates(): Promise<UpdateInfo[]> {
  const db = getDatabase();
  const updates: UpdateInfo[] = [];

  // Check Claude CLI version
  try {
    const claudeInfo = await checkPackageVersion("@anthropic-ai/claude-code");
    updates.push(claudeInfo);

    // Update database with version info
    db.run(
      `INSERT OR REPLACE INTO dependency_versions (package, installed_version, latest_known_version, last_checked_at)
       VALUES (?, ?, ?, unixepoch())`,
      [claudeInfo.package, claudeInfo.installedVersion, claudeInfo.latestVersion]
    );
  } catch (error) {
    console.error("[Updater] Failed to check Claude CLI version:", error);
  }

  // Check Anthropic SDK version
  try {
    const sdkInfo = await checkPackageVersion("@anthropic-ai/sdk");
    updates.push(sdkInfo);

    db.run(
      `INSERT OR REPLACE INTO dependency_versions (package, installed_version, latest_known_version, last_checked_at)
       VALUES (?, ?, ?, unixepoch())`,
      [sdkInfo.package, sdkInfo.installedVersion, sdkInfo.latestVersion]
    );
  } catch (error) {
    console.error("[Updater] Failed to check SDK version:", error);
  }

  return updates;
}

/**
 * Check version info for a specific npm package.
 */
async function checkPackageVersion(packageName: string): Promise<UpdateInfo> {
  let installedVersion: string | null = null;
  let latestVersion: string | null = null;

  // Get installed version
  try {
    if (packageName === "@anthropic-ai/claude-code") {
      // Check global installation
      const { stdout } = await execAsync("npm list -g @anthropic-ai/claude-code --json 2>/dev/null");
      const data = JSON.parse(stdout);
      installedVersion = data.dependencies?.["@anthropic-ai/claude-code"]?.version || null;
    } else {
      // Check local installation
      const { stdout } = await execAsync(`npm list ${packageName} --json 2>/dev/null`);
      const data = JSON.parse(stdout);
      installedVersion = data.dependencies?.[packageName]?.version || null;
    }
  } catch {
    // Package might not be installed
  }

  // Get latest version from npm registry
  try {
    const { stdout } = await execAsync(`npm view ${packageName} version 2>/dev/null`);
    latestVersion = stdout.trim();
  } catch {
    // Failed to check registry
  }

  const needsUpdate = !!(
    installedVersion &&
    latestVersion &&
    installedVersion !== latestVersion &&
    compareVersions(latestVersion, installedVersion) > 0
  );

  return {
    package: packageName,
    installedVersion,
    latestVersion,
    needsUpdate,
  };
}

/**
 * Compare semantic versions. Returns positive if a > b, negative if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;
    if (partA > partB) return 1;
    if (partA < partB) return -1;
  }

  return 0;
}

/**
 * Queue an update to be applied later.
 */
export function queueUpdate(
  updateType: UpdateType,
  reason: string,
  targetVersion?: string
): number {
  const db = getDatabase();

  // Check if there's already a pending update of this type
  const existing = db
    .query(`SELECT id FROM update_queue WHERE update_type = ? AND status = 'pending'`)
    .get(updateType);

  if (existing) {
    console.log(`[Updater] Update already queued for ${updateType}`);
    return (existing as { id: number }).id;
  }

  const result = db.run(
    `INSERT INTO update_queue (update_type, target_version, reason) VALUES (?, ?, ?)`,
    [updateType, targetVersion || null, reason]
  );

  logActivity(null, "update_queued", { updateType, reason, targetVersion }, "system");
  console.log(`[Updater] Queued ${updateType} update: ${reason}`);

  return Number(result.lastInsertRowid);
}

/**
 * Get pending updates.
 */
export function getPendingUpdates(): QueuedUpdate[] {
  const db = getDatabase();

  return db.query(`SELECT * FROM update_queue WHERE status = 'pending' ORDER BY queued_at ASC`).all() as QueuedUpdate[];
}

/**
 * Apply pending updates if no sessions are active.
 * Called during pod startup.
 */
export async function applyPendingUpdates(): Promise<{
  applied: number;
  skipped: number;
  failed: number;
}> {
  const db = getDatabase();
  const results = { applied: 0, skipped: 0, failed: 0 };

  // Check for active sessions
  const activeSessions = getActiveSessionCount();
  if (activeSessions > 0) {
    console.log(`[Updater] ${activeSessions} active sessions, skipping updates`);
    return results;
  }

  const pendingUpdates = getPendingUpdates();
  if (pendingUpdates.length === 0) {
    console.log("[Updater] No pending updates");
    return results;
  }

  console.log(`[Updater] Applying ${pendingUpdates.length} pending updates...`);

  for (const update of pendingUpdates) {
    try {
      await applyUpdate(update);

      db.run(`UPDATE update_queue SET status = 'applied', applied_at = unixepoch() WHERE id = ?`, [
        update.id,
      ]);

      logActivity(null, "update_applied", { updateType: update.updateType }, "system");
      results.applied++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      db.run(`UPDATE update_queue SET status = 'failed', error_message = ? WHERE id = ?`, [
        errorMessage,
        update.id,
      ]);

      logActivity(null, "update_failed", { updateType: update.updateType, error: errorMessage }, "system");
      console.error(`[Updater] Failed to apply ${update.updateType} update:`, errorMessage);
      results.failed++;
    }
  }

  return results;
}

/**
 * Apply a specific update.
 */
async function applyUpdate(update: QueuedUpdate): Promise<void> {
  console.log(`[Updater] Applying ${update.updateType} update...`);

  switch (update.updateType) {
    case "cli":
      await updateClaudeCLI(update.targetVersion || undefined);
      break;

    case "npm":
      await updateNpmPackages();
      break;

    case "all":
      await updateClaudeCLI(update.targetVersion || undefined);
      await updateNpmPackages();
      break;

    case "image":
      // Image updates are handled by Kubernetes, just log
      console.log("[Updater] Image update detected, container will be restarted by Kubernetes");
      break;

    default:
      throw new Error(`Unknown update type: ${update.updateType}`);
  }
}

/**
 * Update Claude CLI to specified version or latest.
 */
async function updateClaudeCLI(version?: string): Promise<void> {
  const packageSpec = version ? `@anthropic-ai/claude-code@${version}` : "@anthropic-ai/claude-code@latest";

  console.log(`[Updater] Updating Claude CLI: npm install -g ${packageSpec}`);

  const { stdout, stderr } = await execAsync(`npm install -g ${packageSpec}`);

  if (stderr && !stderr.includes("npm WARN")) {
    console.warn("[Updater] CLI update warnings:", stderr);
  }

  console.log("[Updater] Claude CLI updated:", stdout.trim().split("\n").pop());

  // Update version tracking
  const db = getDatabase();
  try {
    const { stdout: versionOutput } = await execAsync("npm list -g @anthropic-ai/claude-code --json");
    const data = JSON.parse(versionOutput);
    const newVersion = data.dependencies?.["@anthropic-ai/claude-code"]?.version;

    if (newVersion) {
      db.run(
        `UPDATE dependency_versions SET installed_version = ?, last_updated_at = unixepoch() WHERE package = ?`,
        [newVersion, "@anthropic-ai/claude-code"]
      );
    }
  } catch {
    // Version check failed, not critical
  }
}

/**
 * Update local npm packages.
 */
async function updateNpmPackages(): Promise<void> {
  console.log("[Updater] Updating npm packages...");

  // Run npm update for Anthropic packages
  const { stdout, stderr } = await execAsync("npm update @anthropic-ai/sdk");

  if (stderr && !stderr.includes("npm WARN")) {
    console.warn("[Updater] npm update warnings:", stderr);
  }

  console.log("[Updater] npm packages updated");
}

/**
 * Check if updates are available and queue them if needed.
 * Called by weekly CronJob.
 */
export async function checkAndQueueUpdates(): Promise<{
  checked: number;
  queued: number;
}> {
  const results = { checked: 0, queued: 0 };

  const updates = await checkForUpdates();
  results.checked = updates.length;

  for (const update of updates) {
    if (update.needsUpdate) {
      const updateType: UpdateType = update.package === "@anthropic-ai/claude-code" ? "cli" : "npm";

      queueUpdate(updateType, `New version available: ${update.latestVersion}`, update.latestVersion || undefined);

      results.queued++;
    }
  }

  return results;
}

/**
 * Get current version info for all tracked packages.
 */
export function getVersionInfo(): Array<{
  package: string;
  installedVersion: string | null;
  latestKnownVersion: string | null;
  lastCheckedAt: number | null;
  lastUpdatedAt: number | null;
}> {
  const db = getDatabase();

  return db.query(`SELECT * FROM dependency_versions`).all() as Array<{
    package: string;
    installedVersion: string | null;
    latestKnownVersion: string | null;
    lastCheckedAt: number | null;
    lastUpdatedAt: number | null;
  }>;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  (async () => {
    try {
      switch (command) {
        case "--check":
          console.log("Checking for updates...");
          const updates = await checkForUpdates();
          console.table(updates);
          break;

        case "--apply-pending":
          console.log("Applying pending updates...");
          const results = await applyPendingUpdates();
          console.log("Results:", results);
          break;

        case "--queue":
          const updateType = args[1] as UpdateType;
          const reason = args[2] || "Manual queue";
          if (!updateType) {
            console.error("Usage: --queue <cli|npm|all> [reason]");
            process.exit(1);
          }
          const id = queueUpdate(updateType, reason);
          console.log(`Queued update #${id}`);
          break;

        case "--status":
          const pending = getPendingUpdates();
          const versions = getVersionInfo();
          console.log("Pending updates:", pending);
          console.log("Version info:", versions);
          break;

        default:
          console.log("Usage: updater.ts <--check|--apply-pending|--queue|--status>");
          break;
      }
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  })();
}
