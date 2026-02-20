/**
 * Environment Provisioner
 *
 * Manages per-project Claude Code configuration bundles:
 * - Stores and refreshes OAuth credentials
 * - Generates immutable tar.gz bundles uploaded to MinIO
 * - Proactively refreshes credentials before expiry
 * - Sends ntfy alerts when manual intervention is needed
 *
 * Follows the SessionAggregator pattern: constructor takes DB + deps,
 * start()/stop() lifecycle, timer-based periodic work.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  ProjectConfig,
  ProjectCredential,
  EnvironmentBundle,
  ProvisionRequest,
  ProvisionResponse,
  CredentialPushRequest,
  CredentialHealth,
  CredentialHistoryEntry,
} from "../shared/types.js";
import type { PushBridge } from "./push-bridge.js";

// Claude OAuth endpoints
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Timer intervals
const REFRESH_CHECK_INTERVAL_MS = 30 * 60_000; // 30 minutes
const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
const CREDENTIAL_REFRESH_THRESHOLD_MS = 60 * 60_000; // Refresh if expiring within 60 min
const EXPIRED_BUNDLE_TTL_MS = 24 * 60 * 60_000; // Clean up bundles expired > 24h

export interface EnvironmentProvisionerDeps {
  db: Database;
  s3: S3Client;
  s3Bucket: string;
  pushBridge: PushBridge;
}

export class EnvironmentProvisioner {
  private db: Database;
  private s3: S3Client;
  private s3Bucket: string;
  private pushBridge: PushBridge;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-project mutex to prevent concurrent bundle generation */
  private generationLocks = new Map<string, Promise<ProvisionResponse>>();

  constructor(deps: EnvironmentProvisionerDeps) {
    this.db = deps.db;
    this.s3 = deps.s3;
    this.s3Bucket = deps.s3Bucket;
    this.pushBridge = deps.pushBridge;
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        claude_account_uuid TEXT,
        claude_org_uuid TEXT,
        claude_email TEXT,
        settings_json TEXT,
        claude_json TEXT,
        mcp_json TEXT,
        claude_md TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS project_credentials (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER NOT NULL,
        account_uuid TEXT,
        email_address TEXT,
        organization_uuid TEXT,
        billing_type TEXT DEFAULT 'stripe_subscription',
        display_name TEXT DEFAULT 'GWA',
        scopes TEXT,
        subscription_type TEXT,
        rate_limit_tier TEXT,
        source TEXT NOT NULL,
        pushed_by TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        invalidated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS environment_bundles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        credential_id TEXT NOT NULL REFERENCES project_credentials(id),
        version INTEGER NOT NULL,
        s3_key TEXT NOT NULL,
        s3_bucket TEXT NOT NULL,
        size_bytes INTEGER,
        config_hash TEXT NOT NULL,
        credential_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expired_at INTEGER,
        cleaned_up_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_bundles_active
        ON environment_bundles(project_id, expired_at) WHERE expired_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_creds_project
        ON project_credentials(project_id, expires_at);
    `);

    // Migrate existing DBs: add new columns if missing
    const cols = this.db
      .query("PRAGMA table_info(project_credentials)")
      .all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("scopes")) {
      this.db.run("ALTER TABLE project_credentials ADD COLUMN scopes TEXT");
    }
    if (!colNames.has("subscription_type")) {
      this.db.run("ALTER TABLE project_credentials ADD COLUMN subscription_type TEXT");
    }
    if (!colNames.has("rate_limit_tier")) {
      this.db.run("ALTER TABLE project_credentials ADD COLUMN rate_limit_tier TEXT");
    }

    console.log("[EnvironmentProvisioner] Schema initialized");
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.refreshTimer = setInterval(
      () => this.refreshAllCredentials(),
      REFRESH_CHECK_INTERVAL_MS,
    );
    if (typeof this.refreshTimer === "object" && "unref" in this.refreshTimer) {
      this.refreshTimer.unref();
    }

    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredBundles(),
      CLEANUP_INTERVAL_MS,
    );
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }

    console.log(
      `[EnvironmentProvisioner] Started (refresh every ${REFRESH_CHECK_INTERVAL_MS / 60000}min, cleanup every ${CLEANUP_INTERVAL_MS / 3600000}h)`,
    );
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    console.log("[EnvironmentProvisioner] Stopped");
  }

  // -------------------------------------------------------------------------
  // Project CRUD
  // -------------------------------------------------------------------------

  createProject(id: string, displayName: string, config?: Partial<ProjectConfig>): ProjectConfig {
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO projects (id, display_name, claude_account_uuid, claude_org_uuid, claude_email, settings_json, claude_json, mcp_json, claude_md, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        displayName,
        config?.claudeAccountUuid ?? null,
        config?.claudeOrgUuid ?? null,
        config?.claudeEmail ?? null,
        config?.settingsJson ?? null,
        config?.claudeJson ?? null,
        config?.mcpJson ?? null,
        config?.claudeMd ?? null,
        now,
        now,
      ],
    );

    return this.getProject(id)!;
  }

  getProject(id: string): ProjectConfig | null {
    const row = this.db
      .query(
        `SELECT id, display_name, claude_account_uuid, claude_org_uuid, claude_email,
                settings_json, claude_json, mcp_json, claude_md, created_at, updated_at
         FROM projects WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToProjectConfig(row);
  }

  listProjects(): Array<ProjectConfig & { credentialHealth: CredentialHealth }> {
    const rows = this.db
      .query(
        `SELECT id, display_name, claude_account_uuid, claude_org_uuid, claude_email,
                settings_json, claude_json, mcp_json, claude_md, created_at, updated_at
         FROM projects ORDER BY display_name`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const project = this.rowToProjectConfig(row);
      const health = this.getCredentialHealth(project.id);
      return { ...project, credentialHealth: health };
    });
  }

  updateProject(id: string, updates: Partial<ProjectConfig>): ProjectConfig | null {
    const existing = this.getProject(id);
    if (!existing) return null;

    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `UPDATE projects SET
         display_name = COALESCE(?, display_name),
         claude_account_uuid = COALESCE(?, claude_account_uuid),
         claude_org_uuid = COALESCE(?, claude_org_uuid),
         claude_email = COALESCE(?, claude_email),
         settings_json = COALESCE(?, settings_json),
         claude_json = COALESCE(?, claude_json),
         mcp_json = COALESCE(?, mcp_json),
         claude_md = COALESCE(?, claude_md),
         updated_at = ?
       WHERE id = ?`,
      [
        updates.displayName ?? null,
        updates.claudeAccountUuid ?? null,
        updates.claudeOrgUuid ?? null,
        updates.claudeEmail ?? null,
        updates.settingsJson ?? null,
        updates.claudeJson ?? null,
        updates.mcpJson ?? null,
        updates.claudeMd ?? null,
        now,
        id,
      ],
    );

    // Config changed → invalidate active bundle so next provision generates fresh one
    if (
      updates.settingsJson !== undefined ||
      updates.claudeJson !== undefined ||
      updates.mcpJson !== undefined ||
      updates.claudeMd !== undefined
    ) {
      this.invalidateActiveBundles(id);
    }

    return this.getProject(id);
  }

  // -------------------------------------------------------------------------
  // Credential management
  // -------------------------------------------------------------------------

  pushCredential(projectId: string, req: CredentialPushRequest, pushedBy?: string): ProjectCredential {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // Invalidate existing credentials for this project
    this.db.run(
      `UPDATE project_credentials SET invalidated_at = unixepoch()
       WHERE project_id = ? AND invalidated_at IS NULL`,
      [projectId],
    );

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO project_credentials (id, project_id, access_token, refresh_token, expires_at,
         account_uuid, email_address, organization_uuid, billing_type, display_name,
         scopes, subscription_type, rate_limit_tier, source, pushed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'push', ?, ?)`,
      [
        id,
        projectId,
        req.accessToken,
        req.refreshToken ?? null,
        req.expiresAt,
        req.accountUuid ?? null,
        req.emailAddress ?? null,
        req.organizationUuid ?? null,
        req.billingType ?? "stripe_subscription",
        req.displayName ?? "GWA",
        req.scopes ? JSON.stringify(req.scopes) : null,
        req.subscriptionType ?? null,
        req.rateLimitTier ?? null,
        pushedBy ?? null,
        now,
      ],
    );

    // Update project's account metadata if provided
    if (req.accountUuid || req.emailAddress || req.organizationUuid) {
      this.db.run(
        `UPDATE projects SET
           claude_account_uuid = COALESCE(?, claude_account_uuid),
           claude_org_uuid = COALESCE(?, claude_org_uuid),
           claude_email = COALESCE(?, claude_email),
           updated_at = unixepoch()
         WHERE id = ?`,
        [
          req.accountUuid ?? null,
          req.organizationUuid ?? null,
          req.emailAddress ?? null,
          projectId,
        ],
      );
    }

    // Invalidate active bundles — new credential means new bundle needed
    this.invalidateActiveBundles(projectId);

    console.log(
      `[EnvironmentProvisioner] Credential pushed for project ${projectId} (expires ${new Date(req.expiresAt).toISOString()})`,
    );

    return this.getCredential(id)!;
  }

  getActiveCredential(projectId: string): ProjectCredential | null {
    const row = this.db
      .query(
        `SELECT * FROM project_credentials
         WHERE project_id = ? AND invalidated_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, Date.now()) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToCredential(row);
  }

  private getCredential(id: string): ProjectCredential | null {
    const row = this.db
      .query(`SELECT * FROM project_credentials WHERE id = ?`)
      .get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToCredential(row);
  }

  // -------------------------------------------------------------------------
  // Provision (main endpoint)
  // -------------------------------------------------------------------------

  async provision(projectId: string, req: ProvisionRequest): Promise<ProvisionResponse> {
    const project = this.getProject(projectId);
    if (!project) {
      return { status: "no_credentials", message: `Project not found: ${projectId}` };
    }

    // Per-project mutex: if a generation is already in progress, await it
    const existing = this.generationLocks.get(projectId);
    if (existing) {
      console.log(`[EnvironmentProvisioner] Awaiting in-flight provision for ${projectId}`);
      return existing;
    }

    const promise = this._provision(project, req);
    this.generationLocks.set(projectId, promise);
    try {
      return await promise;
    } finally {
      this.generationLocks.delete(projectId);
    }
  }

  private async _provision(project: ProjectConfig, req: ProvisionRequest): Promise<ProvisionResponse> {
    // 1. Check for active bundle
    const activeBundle = this.getActiveBundle(project.id);
    if (activeBundle && req.currentBundleId === activeBundle.id) {
      // Config hash matches current bundle — still valid
      const configHash = this.computeConfigHash(project, activeBundle.credentialId);
      if (configHash === activeBundle.configHash && activeBundle.credentialExpiresAt > Date.now()) {
        return {
          status: "current",
          bundleId: activeBundle.id,
          credentialExpiresAt: activeBundle.credentialExpiresAt,
        };
      }
    }

    // 2. Get active credential
    let credential = this.getActiveCredential(project.id);

    // 3. If no valid credential, try refresh
    if (!credential) {
      credential = await this.tryRefreshCredential(project.id);
    }

    // 4. Still no credential → alert and fail
    if (!credential) {
      await this.pushBridge.sendDirect({
        type: "auth_expiring",
        title: `GWA: No valid credentials for ${project.displayName}`,
        body: `Project "${project.id}" has no valid credentials. Push fresh credentials: gwa-push-credentials --project ${project.id}`,
        sessionId: `provisioner-${project.id}`,
        priority: 5,
        tags: ["auth", "gwa"],
      });

      return { status: "no_credentials", message: "No valid credentials available" };
    }

    // 5. Generate bundle
    const bundle = await this.generateBundle(project, credential);
    return {
      status: "provisioned",
      bundleId: bundle.id,
      s3Key: bundle.s3Key,
      s3Bucket: bundle.s3Bucket,
      credentialExpiresAt: bundle.credentialExpiresAt,
    };
  }

  // -------------------------------------------------------------------------
  // Bundle generation
  // -------------------------------------------------------------------------

  private async generateBundle(
    project: ProjectConfig,
    credential: ProjectCredential,
  ): Promise<EnvironmentBundle> {
    const bundleId = randomUUID();
    const s3Key = `env-bundles/${project.id}/${bundleId}.tar.gz`;
    const configHash = this.computeConfigHash(project, credential.id);

    // Build tar.gz in-process using tar-stream
    const tarData = await this.buildTarGz(project, credential);

    // Upload to MinIO
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.s3Bucket,
        Key: s3Key,
        Body: tarData,
        ContentType: "application/gzip",
        Metadata: {
          "project-id": project.id,
          "bundle-id": bundleId,
          "credential-id": credential.id,
        },
      }),
    );

    // Get next version number
    const lastVersion = this.db
      .query(
        `SELECT MAX(version) as max_version FROM environment_bundles WHERE project_id = ?`,
      )
      .get(project.id) as { max_version: number | null } | null;
    const version = (lastVersion?.max_version ?? 0) + 1;

    // Invalidate previous active bundles
    this.invalidateActiveBundles(project.id);

    // Insert bundle record
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO environment_bundles (id, project_id, credential_id, version, s3_key, s3_bucket,
         size_bytes, config_hash, credential_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bundleId,
        project.id,
        credential.id,
        version,
        s3Key,
        this.s3Bucket,
        tarData.length,
        configHash,
        credential.expiresAt,
        now,
      ],
    );

    console.log(
      `[EnvironmentProvisioner] Generated bundle v${version} for ${project.id} (${tarData.length} bytes, s3: ${s3Key})`,
    );

    return this.getBundle(bundleId)!;
  }

  private async buildTarGz(
    project: ProjectConfig,
    credential: ProjectCredential,
  ): Promise<Buffer> {
    // Dynamic import of tar-stream (optional dep)
    const { pack } = await import("tar-stream");
    const { createGzip } = await import("zlib");

    const tarPack = pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];

    // Pipe tar → gzip → collect
    const pipeline = tarPack.pipe(gzip);
    pipeline.on("data", (chunk: Buffer) => chunks.push(chunk));

    const done = new Promise<Buffer>((resolve, reject) => {
      pipeline.on("end", () => resolve(Buffer.concat(chunks)));
      pipeline.on("error", reject);
    });

    // .claude/.credentials.json
    const credentialsJson = this.buildCredentialsJson(credential, project);
    tarPack.entry({ name: ".claude/.credentials.json" }, credentialsJson);

    // .config/claude/config.json (ephemeral config with oauthToken)
    const configJson = JSON.stringify({ oauthToken: credential.accessToken }, null, 2);
    tarPack.entry({ name: ".config/claude/config.json" }, configJson);

    // .claude.json (TUI settings) — use stored config or synthesize minimal one
    // This file contains the oauthAccount block that Claude Code uses to display
    // the org/subscription footer and skip account selection dialogs.
    if (project.claudeJson) {
      tarPack.entry({ name: ".claude.json" }, project.claudeJson);
    } else {
      const synthesized = this.buildMinimalClaudeJson(credential, project);
      tarPack.entry({ name: ".claude.json" }, synthesized);
    }

    // .claude/settings.json — use stored config or synthesize minimal headless defaults
    if (project.settingsJson) {
      tarPack.entry({ name: ".claude/settings.json" }, project.settingsJson);
    } else {
      const defaults = JSON.stringify({
        skipDangerousModePermissionPrompt: true,
        theme: "dark",
        hasCompletedOnboarding: true,
      }, null, 2);
      tarPack.entry({ name: ".claude/settings.json" }, defaults);
    }

    tarPack.finalize();
    return done;
  }

  /**
   * Build .credentials.json matching the format Claude Code creates from interactive login.
   * Account metadata (accountUuid, email, org) belongs in .claude.json oauthAccount, not here.
   */
  private buildCredentialsJson(credential: ProjectCredential, _project: ProjectConfig): string {
    const oauth: Record<string, unknown> = {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken ?? undefined,
      expiresAt: credential.expiresAt,
    };

    // Include scopes if available (default to standard set)
    oauth.scopes = credential.scopes ?? [
      "user:inference",
      "user:mcp_servers",
      "user:profile",
      "user:sessions:claude_code",
    ];

    if (credential.subscriptionType) {
      oauth.subscriptionType = credential.subscriptionType;
    }
    if (credential.rateLimitTier) {
      oauth.rateLimitTier = credential.rateLimitTier;
    }

    return JSON.stringify({ claudeAiOauth: oauth }, null, 2);
  }

  /**
   * Synthesize a minimal ~/.claude.json from credential/project metadata.
   * Contains the oauthAccount block that Claude Code uses for org/subscription
   * display and to skip account selection dialogs on startup.
   */
  private buildMinimalClaudeJson(credential: ProjectCredential, project: ProjectConfig): string {
    const accountUuid = credential.accountUuid ?? project.claudeAccountUuid;
    const email = credential.emailAddress ?? project.claudeEmail;
    const orgUuid = credential.organizationUuid ?? project.claudeOrgUuid;

    const minimal: Record<string, unknown> = {
      hasCompletedOnboarding: true,
      theme: "dark-ansi",
      preferredNotifChannel: "notifications_disabled",
      fileCheckpointingEnabled: false,
    };

    // Only include oauthAccount if we have the essential fields
    if (accountUuid && email) {
      minimal.oauthAccount = {
        accountUuid,
        emailAddress: email,
        organizationUuid: orgUuid ?? undefined,
        hasExtraUsageEnabled: true,
        billingType: credential.billingType ?? "stripe_subscription",
        displayName: credential.displayName ?? project.displayName ?? "GWA",
      };
    }

    return JSON.stringify(minimal, null, 2);
  }

  // -------------------------------------------------------------------------
  // OAuth refresh
  // -------------------------------------------------------------------------

  async refreshCredential(projectId: string): Promise<ProjectCredential | null> {
    return this.tryRefreshCredential(projectId);
  }

  private async tryRefreshCredential(projectId: string): Promise<ProjectCredential | null> {
    // Find the most recent credential with a refresh token (even if expired)
    const row = this.db
      .query(
        `SELECT * FROM project_credentials
         WHERE project_id = ? AND refresh_token IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | null;

    if (!row) {
      console.log(`[EnvironmentProvisioner] No refresh token available for ${projectId}`);
      return null;
    }

    const oldCredential = this.rowToCredential(row);
    if (!oldCredential.refreshToken) return null;

    try {
      const response = await fetch(CLAUDE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oldCredential.refreshToken,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(
          `[EnvironmentProvisioner] OAuth refresh failed for ${projectId}: ${response.status} ${body}`,
        );

        await this.pushBridge.sendDirect({
          type: "auth_refresh_failed",
          title: `GWA: Credential refresh failed for ${projectId}`,
          body: `Automated OAuth refresh failed (${response.status}). Push fresh credentials: gwa-push-credentials --project ${projectId}`,
          sessionId: `provisioner-${projectId}`,
          priority: 5,
          tags: ["auth", "gwa"],
        });

        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      // Invalidate old credential
      this.db.run(
        `UPDATE project_credentials SET invalidated_at = unixepoch() WHERE id = ?`,
        [oldCredential.id],
      );

      // Insert new credential
      const newId = randomUUID();
      const expiresAt = Date.now() + data.expires_in * 1000;
      const now = Math.floor(Date.now() / 1000);

      this.db.run(
        `INSERT INTO project_credentials (id, project_id, access_token, refresh_token, expires_at,
           account_uuid, email_address, organization_uuid, billing_type, display_name,
           scopes, subscription_type, rate_limit_tier, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'refresh', ?)`,
        [
          newId,
          projectId,
          data.access_token,
          data.refresh_token ?? oldCredential.refreshToken,
          expiresAt,
          oldCredential.accountUuid ?? null,
          oldCredential.emailAddress ?? null,
          oldCredential.organizationUuid ?? null,
          oldCredential.billingType,
          oldCredential.displayName,
          oldCredential.scopes ? JSON.stringify(oldCredential.scopes) : null,
          oldCredential.subscriptionType ?? null,
          oldCredential.rateLimitTier ?? null,
          now,
        ],
      );

      // Invalidate active bundles — new credential means new bundle
      this.invalidateActiveBundles(projectId);

      console.log(
        `[EnvironmentProvisioner] Refreshed credential for ${projectId} (expires ${new Date(expiresAt).toISOString()})`,
      );

      return this.getCredential(newId);
    } catch (error) {
      console.error(`[EnvironmentProvisioner] OAuth refresh error for ${projectId}:`, error);

      await this.pushBridge.sendDirect({
        type: "auth_refresh_failed",
        title: `GWA: Credential refresh failed for ${projectId}`,
        body: `Automated OAuth refresh failed (network error). Push fresh credentials: gwa-push-credentials --project ${projectId}`,
        sessionId: `provisioner-${projectId}`,
        priority: 5,
        tags: ["auth", "gwa"],
      });

      return null;
    }
  }

  /** Proactive refresh check — called on timer for all projects */
  private async refreshAllCredentials(): Promise<void> {
    const projects = this.db
      .query(`SELECT id FROM projects`)
      .all() as Array<{ id: string }>;

    for (const { id } of projects) {
      const credential = this.getActiveCredential(id);
      if (!credential) {
        // No active credential — try refresh
        await this.tryRefreshCredential(id);
        continue;
      }

      // If credential expires within threshold, proactively refresh
      const timeUntilExpiry = credential.expiresAt - Date.now();
      if (timeUntilExpiry < CREDENTIAL_REFRESH_THRESHOLD_MS) {
        console.log(
          `[EnvironmentProvisioner] Proactive refresh for ${id} (expires in ${Math.round(timeUntilExpiry / 60000)}min)`,
        );
        await this.tryRefreshCredential(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bundle management
  // -------------------------------------------------------------------------

  private getActiveBundle(projectId: string): EnvironmentBundle | null {
    const row = this.db
      .query(
        `SELECT * FROM environment_bundles
         WHERE project_id = ? AND expired_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToBundle(row);
  }

  private getBundle(id: string): EnvironmentBundle | null {
    const row = this.db
      .query(`SELECT * FROM environment_bundles WHERE id = ?`)
      .get(id) as Record<string, unknown> | null;

    if (!row) return null;
    return this.rowToBundle(row);
  }

  private invalidateActiveBundles(projectId: string): void {
    this.db.run(
      `UPDATE environment_bundles SET expired_at = unixepoch()
       WHERE project_id = ? AND expired_at IS NULL`,
      [projectId],
    );
  }

  /** Periodic cleanup: delete S3 objects for long-expired bundles */
  private async cleanupExpiredBundles(): Promise<void> {
    const cutoff = Math.floor((Date.now() - EXPIRED_BUNDLE_TTL_MS) / 1000);
    const rows = this.db
      .query(
        `SELECT id, s3_key, s3_bucket FROM environment_bundles
         WHERE expired_at IS NOT NULL AND expired_at < ? AND cleaned_up_at IS NULL`,
      )
      .all(cutoff) as Array<{ id: string; s3_key: string; s3_bucket: string }>;

    for (const { id, s3_key, s3_bucket } of rows) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: s3_bucket, Key: s3_key }),
        );
        this.db.run(
          `UPDATE environment_bundles SET cleaned_up_at = unixepoch() WHERE id = ?`,
          [id],
        );
        console.log(`[EnvironmentProvisioner] Cleaned up expired bundle ${id}`);
      } catch (error) {
        console.warn(`[EnvironmentProvisioner] Failed to clean up bundle ${id}:`, error);
      }
    }

    if (rows.length > 0) {
      console.log(`[EnvironmentProvisioner] Cleaned up ${rows.length} expired bundles`);
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  getCredentialHealth(projectId: string): CredentialHealth {
    const credential = this.getActiveCredential(projectId);
    const activeBundle = this.getActiveBundle(projectId);

    // Check for refresh token on any credential (even expired)
    const hasRefresh = this.db
      .query(
        `SELECT 1 FROM project_credentials
         WHERE project_id = ? AND refresh_token IS NOT NULL LIMIT 1`,
      )
      .get(projectId) != null;

    const lastRefreshed = this.db
      .query(
        `SELECT MAX(created_at) as last FROM project_credentials
         WHERE project_id = ? AND source = 'refresh'`,
      )
      .get(projectId) as { last: number | null } | null;

    return {
      projectId,
      hasValidCredential: credential != null,
      expiresAt: credential?.expiresAt,
      expiresInMs: credential ? credential.expiresAt - Date.now() : undefined,
      hasRefreshToken: hasRefresh,
      lastRefreshAt: lastRefreshed?.last ? lastRefreshed.last * 1000 : undefined,
      activeBundleId: activeBundle?.id,
    };
  }

  // -------------------------------------------------------------------------
  // Credential history & pruning
  // -------------------------------------------------------------------------

  getCredentialHistory(projectId: string, limit = 10): CredentialHistoryEntry[] {
    const rows = this.db
      .query(
        `SELECT
           c.id AS credential_id,
           c.source,
           c.pushed_by,
           c.created_at,
           c.expires_at,
           c.invalidated_at,
           c.access_token,
           b.id AS bundle_id,
           b.s3_key AS bundle_s3_key,
           b.version AS bundle_version,
           b.created_at AS bundle_created_at,
           b.expired_at AS bundle_expired_at
         FROM project_credentials c
         LEFT JOIN environment_bundles b ON b.credential_id = c.id
         WHERE c.project_id = ?
         ORDER BY c.created_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      credentialId: row.credential_id as string,
      source: row.source as CredentialHistoryEntry["source"],
      pushedBy: (row.pushed_by as string) || undefined,
      createdAt: row.created_at as number,
      expiresAt: row.expires_at as number,
      invalidatedAt: (row.invalidated_at as number) || undefined,
      tokenPrefix: (row.access_token as string).slice(0, 20) + "...",
      bundleId: (row.bundle_id as string) || undefined,
      bundleS3Key: (row.bundle_s3_key as string) || undefined,
      bundleVersion: (row.bundle_version as number) || undefined,
      bundleCreatedAt: (row.bundle_created_at as number) || undefined,
      bundleExpiredAt: (row.bundle_expired_at as number) || undefined,
    }));
  }

  /**
   * Prune credentials and bundles older than maxAge (default 24h).
   * Always keeps the most recent credential (even if older than maxAge).
   * Returns count of pruned credentials and bundles.
   */
  async pruneOldCredentials(
    projectId: string,
    maxAgeMs = 24 * 60 * 60_000,
  ): Promise<{ prunedCredentials: number; prunedBundles: number; deletedS3Objects: number }> {
    const cutoffSec = Math.floor((Date.now() - maxAgeMs) / 1000);

    // Find the most recent credential ID so we never prune it
    const latest = this.db
      .query(
        `SELECT id FROM project_credentials
         WHERE project_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId) as { id: string } | null;

    if (!latest) {
      return { prunedCredentials: 0, prunedBundles: 0, deletedS3Objects: 0 };
    }

    // Find old bundles to delete from S3
    const oldBundles = this.db
      .query(
        `SELECT b.id, b.s3_key, b.s3_bucket
         FROM environment_bundles b
         JOIN project_credentials c ON b.credential_id = c.id
         WHERE c.project_id = ?
           AND c.created_at < ?
           AND c.id != ?
           AND b.cleaned_up_at IS NULL`,
      )
      .all(projectId, cutoffSec, latest.id) as Array<{
      id: string;
      s3_key: string;
      s3_bucket: string;
    }>;

    let deletedS3Objects = 0;
    for (const bundle of oldBundles) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: bundle.s3_bucket, Key: bundle.s3_key }),
        );
        deletedS3Objects++;
      } catch (error) {
        console.warn(`[EnvironmentProvisioner] Failed to delete S3 object ${bundle.s3_key}:`, error);
      }
    }

    // Delete old bundles from DB
    const bundleResult = this.db.run(
      `DELETE FROM environment_bundles
       WHERE credential_id IN (
         SELECT id FROM project_credentials
         WHERE project_id = ? AND created_at < ? AND id != ?
       )`,
      [projectId, cutoffSec, latest.id],
    );

    // Delete old credentials from DB
    const credResult = this.db.run(
      `DELETE FROM project_credentials
       WHERE project_id = ? AND created_at < ? AND id != ?`,
      [projectId, cutoffSec, latest.id],
    );

    const prunedCredentials = credResult.changes;
    const prunedBundles = bundleResult.changes;

    if (prunedCredentials > 0 || prunedBundles > 0) {
      console.log(
        `[EnvironmentProvisioner] Pruned ${prunedCredentials} credentials, ${prunedBundles} bundles, ${deletedS3Objects} S3 objects for ${projectId}`,
      );
    }

    return { prunedCredentials, prunedBundles, deletedS3Objects };
  }

  // -------------------------------------------------------------------------
  // Config hash
  // -------------------------------------------------------------------------

  private computeConfigHash(project: ProjectConfig, credentialId: string): string {
    const inputs = [
      credentialId,
      project.settingsJson ?? "",
      project.claudeJson ?? "",
      project.mcpJson ?? "",
      project.claudeMd ?? "",
    ].join("\x00");

    return createHash("sha256").update(inputs).digest("hex");
  }

  // -------------------------------------------------------------------------
  // Row mappers
  // -------------------------------------------------------------------------

  private rowToProjectConfig(row: Record<string, unknown>): ProjectConfig {
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      claudeAccountUuid: row.claude_account_uuid as string | undefined,
      claudeOrgUuid: row.claude_org_uuid as string | undefined,
      claudeEmail: row.claude_email as string | undefined,
      settingsJson: row.settings_json as string | undefined,
      claudeJson: row.claude_json as string | undefined,
      mcpJson: row.mcp_json as string | undefined,
      claudeMd: row.claude_md as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private rowToCredential(row: Record<string, unknown>): ProjectCredential {
    let scopes: string[] | undefined;
    if (row.scopes) {
      try { scopes = JSON.parse(row.scopes as string); } catch { /* ignore */ }
    }
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      accessToken: row.access_token as string,
      refreshToken: (row.refresh_token as string) || undefined,
      expiresAt: row.expires_at as number,
      accountUuid: (row.account_uuid as string) || undefined,
      emailAddress: (row.email_address as string) || undefined,
      organizationUuid: (row.organization_uuid as string) || undefined,
      billingType: row.billing_type as string,
      displayName: row.display_name as string,
      scopes,
      subscriptionType: (row.subscription_type as string) || undefined,
      rateLimitTier: (row.rate_limit_tier as string) || undefined,
      source: row.source as ProjectCredential["source"],
      pushedBy: (row.pushed_by as string) || undefined,
      createdAt: row.created_at as number,
      invalidatedAt: (row.invalidated_at as number) || undefined,
    };
  }

  private rowToBundle(row: Record<string, unknown>): EnvironmentBundle {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      credentialId: row.credential_id as string,
      version: row.version as number,
      s3Key: row.s3_key as string,
      s3Bucket: row.s3_bucket as string,
      sizeBytes: (row.size_bytes as number) || undefined,
      configHash: row.config_hash as string,
      credentialExpiresAt: row.credential_expires_at as number,
      createdAt: row.created_at as number,
      expiredAt: (row.expired_at as number) || undefined,
      cleanedUpAt: (row.cleaned_up_at as number) || undefined,
    };
  }
}
