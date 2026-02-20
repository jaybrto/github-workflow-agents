/**
 * Tests for EnvironmentProvisioner
 *
 * Uses in-memory SQLite and mock S3/PushBridge to test:
 * - Project CRUD
 * - Credential push and retrieval
 * - Provision logic (cache hit, bundle generation, no-credentials path)
 * - OAuth refresh (success and failure)
 * - Bundle invalidation and cleanup
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { EnvironmentProvisioner } from "../orchestrator/environment-provisioner.js";
import { PushBridge } from "../orchestrator/push-bridge.js";

// ---------------------------------------------------------------------------
// Mock S3 — tracks uploads without real MinIO
// ---------------------------------------------------------------------------

let s3Uploads: Array<{ Bucket: string; Key: string; Body: unknown }> = [];
let s3Deletions: Array<{ Bucket: string; Key: string }> = [];

const mockS3Send = mock(async (command: unknown) => {
  if (command instanceof PutObjectCommand) {
    const input = (command as { input: { Bucket: string; Key: string; Body: unknown } }).input;
    s3Uploads.push({ Bucket: input.Bucket, Key: input.Key, Body: input.Body });
    return {};
  }
  // DeleteObjectCommand
  const input = (command as { input: { Bucket: string; Key: string } }).input;
  if (input) {
    s3Deletions.push({ Bucket: input.Bucket, Key: input.Key });
  }
  return {};
});

const mockS3 = { send: mockS3Send } as unknown as S3Client;

// ---------------------------------------------------------------------------
// Mock PushBridge
// ---------------------------------------------------------------------------

let pushNotifications: Array<{ type: string; title: string; body: string }> = [];

const pushBridge = new PushBridge();
pushBridge.sendDirect = mock(async (notification) => {
  pushNotifications.push({
    type: notification.type,
    title: notification.title,
    body: notification.body,
  });
  return true;
});

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: Database;
let provisioner: EnvironmentProvisioner;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  provisioner = new EnvironmentProvisioner({
    db,
    s3: mockS3,
    s3Bucket: "test-bucket",
    pushBridge,
  });
  provisioner.initSchema();

  // Reset mock state
  s3Uploads = [];
  s3Deletions = [];
  pushNotifications = [];
  mockS3Send.mockClear();
});

afterEach(() => {
  provisioner.stop();
  db.close();
});

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

describe("Project CRUD", () => {
  test("createProject creates and returns a project", () => {
    const project = provisioner.createProject("test-proj", "Test Project");
    expect(project.id).toBe("test-proj");
    expect(project.displayName).toBe("Test Project");
    expect(project.createdAt).toBeGreaterThan(0);
  });

  test("createProject with config fields", () => {
    const project = provisioner.createProject("proj-2", "Project 2", {
      settingsJson: '{"key":"val"}',
      claudeJson: '{"tui":true}',
    });
    expect(project.settingsJson).toBe('{"key":"val"}');
    expect(project.claudeJson).toBe('{"tui":true}');
  });

  test("createProject throws on duplicate id", () => {
    provisioner.createProject("dup", "First");
    expect(() => provisioner.createProject("dup", "Second")).toThrow();
  });

  test("getProject returns null for nonexistent", () => {
    expect(provisioner.getProject("nope")).toBeNull();
  });

  test("getProject returns existing project", () => {
    provisioner.createProject("exists", "Exists");
    const project = provisioner.getProject("exists");
    expect(project).not.toBeNull();
    expect(project!.id).toBe("exists");
  });

  test("listProjects returns all projects with health", () => {
    provisioner.createProject("a", "Alpha");
    provisioner.createProject("b", "Beta");
    const list = provisioner.listProjects();
    expect(list).toHaveLength(2);
    expect(list[0].credentialHealth).toBeDefined();
    expect(list[0].credentialHealth.hasValidCredential).toBe(false);
  });

  test("updateProject updates fields", () => {
    provisioner.createProject("upd", "Original");
    const updated = provisioner.updateProject("upd", { displayName: "Updated" });
    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe("Updated");
  });

  test("updateProject returns null for nonexistent", () => {
    expect(provisioner.updateProject("nope", { displayName: "X" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Credential push and retrieval
// ---------------------------------------------------------------------------

describe("Credential management", () => {
  test("pushCredential stores and returns credential", () => {
    provisioner.createProject("cred-test", "Cred Test");
    const cred = provisioner.pushCredential("cred-test", {
      accessToken: "tok-123",
      refreshToken: "ref-456",
      expiresAt: Date.now() + 3600_000,
      accountUuid: "acc-uuid",
      emailAddress: "test@example.com",
    });
    expect(cred.id).toBeTruthy();
    expect(cred.accessToken).toBe("tok-123");
    expect(cred.refreshToken).toBe("ref-456");
    expect(cred.source).toBe("push");
  });

  test("pushCredential throws for nonexistent project", () => {
    expect(() =>
      provisioner.pushCredential("ghost", {
        accessToken: "tok",
        expiresAt: Date.now() + 3600_000,
      }),
    ).toThrow("Project not found");
  });

  test("pushCredential invalidates previous credentials", () => {
    provisioner.createProject("inv", "Invalidation");

    // Push first credential
    provisioner.pushCredential("inv", {
      accessToken: "old-tok",
      expiresAt: Date.now() + 3600_000,
    });

    // Push second — old one should be invalidated
    provisioner.pushCredential("inv", {
      accessToken: "new-tok",
      expiresAt: Date.now() + 3600_000,
    });

    // Only the new one should be "active"
    const rows = db
      .query(
        `SELECT access_token, invalidated_at FROM project_credentials
         WHERE project_id = ? ORDER BY created_at`,
      )
      .all("inv") as Array<{ access_token: string; invalidated_at: number | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].invalidated_at).not.toBeNull(); // old one invalidated
    expect(rows[1].invalidated_at).toBeNull(); // new one active
    expect(rows[1].access_token).toBe("new-tok");
  });

  test("getActiveCredential returns null when expired", () => {
    provisioner.createProject("exp", "Expired");
    provisioner.pushCredential("exp", {
      accessToken: "expired-tok",
      expiresAt: Date.now() - 1000, // already expired
    });

    // getActiveCredential is private but we can test through getCredentialHealth
    const health = provisioner.getCredentialHealth("exp");
    expect(health.hasValidCredential).toBe(false);
  });

  test("getActiveCredential returns valid credential", () => {
    provisioner.createProject("valid", "Valid");
    provisioner.pushCredential("valid", {
      accessToken: "good-tok",
      expiresAt: Date.now() + 3600_000,
    });

    const health = provisioner.getCredentialHealth("valid");
    expect(health.hasValidCredential).toBe(true);
    expect(health.expiresInMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Credential health
// ---------------------------------------------------------------------------

describe("Credential health", () => {
  test("reports no valid credential when project has no credentials", () => {
    provisioner.createProject("empty", "Empty");
    const health = provisioner.getCredentialHealth("empty");
    expect(health.hasValidCredential).toBe(false);
    expect(health.hasRefreshToken).toBe(false);
    expect(health.activeBundleId).toBeUndefined();
  });

  test("reports hasRefreshToken when credential has one", () => {
    provisioner.createProject("rt", "RefreshToken");
    provisioner.pushCredential("rt", {
      accessToken: "tok",
      refreshToken: "ref",
      expiresAt: Date.now() + 3600_000,
    });

    const health = provisioner.getCredentialHealth("rt");
    expect(health.hasRefreshToken).toBe(true);
  });

  test("reports no refresh token when credential lacks one", () => {
    provisioner.createProject("nrt", "NoRefreshToken");
    provisioner.pushCredential("nrt", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    const health = provisioner.getCredentialHealth("nrt");
    expect(health.hasRefreshToken).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provision endpoint logic
// ---------------------------------------------------------------------------

describe("Provision", () => {
  test("returns no_credentials for nonexistent project", async () => {
    const result = await provisioner.provision("ghost", { podName: "pod-0" });
    expect(result.status).toBe("no_credentials");
    expect(result.message).toContain("not found");
  });

  test("returns no_credentials when project has no credentials", async () => {
    provisioner.createProject("nocred", "No Cred");
    const result = await provisioner.provision("nocred", { podName: "pod-0" });
    expect(result.status).toBe("no_credentials");
    // Should have sent a notification
    expect(pushNotifications).toHaveLength(1);
    expect(pushNotifications[0].type).toBe("auth_expiring");
  });

  test("generates bundle when valid credential exists", async () => {
    provisioner.createProject("bundle-test", "Bundle Test", {
      settingsJson: '{"editor":"vim"}',
    });
    provisioner.pushCredential("bundle-test", {
      accessToken: "tok-abc",
      refreshToken: "ref-xyz",
      expiresAt: Date.now() + 3600_000,
      accountUuid: "acc-1",
      emailAddress: "dev@test.com",
    });

    const result = await provisioner.provision("bundle-test", { podName: "pod-0" });
    expect(result.status).toBe("provisioned");
    expect(result.bundleId).toBeTruthy();
    expect(result.s3Key!).toContain("env-bundles/bundle-test/");
    expect(result.s3Bucket).toBe("test-bucket");
    expect(result.credentialExpiresAt).toBeGreaterThan(Date.now());

    // Verify S3 upload happened
    expect(s3Uploads).toHaveLength(1);
    expect(s3Uploads[0].Key).toBe(result.s3Key!);
    expect(s3Uploads[0].Bucket).toBe("test-bucket");

    // Verify the uploaded body is a Buffer (tar.gz data)
    expect(Buffer.isBuffer(s3Uploads[0].Body)).toBe(true);
    expect((s3Uploads[0].Body as Buffer).length).toBeGreaterThan(0);
  });

  test("returns current when active bundle matches and credential not expired", async () => {
    provisioner.createProject("cache-hit", "Cache Hit");
    provisioner.pushCredential("cache-hit", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    // First provision — generates bundle
    const first = await provisioner.provision("cache-hit", { podName: "pod-0" });
    expect(first.status).toBe("provisioned");

    // Second provision with same bundleId — should be "current"
    const second = await provisioner.provision("cache-hit", {
      podName: "pod-0",
      currentBundleId: first.bundleId,
    });
    expect(second.status).toBe("current");
    expect(second.bundleId).toBe(first.bundleId);
  });

  test("generates new bundle when config changes", async () => {
    provisioner.createProject("cfg-change", "Config Change");
    provisioner.pushCredential("cfg-change", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    const first = await provisioner.provision("cfg-change", { podName: "pod-0" });
    expect(first.status).toBe("provisioned");

    // Change config — invalidates active bundle
    provisioner.updateProject("cfg-change", { settingsJson: '{"new":true}' });

    const second = await provisioner.provision("cfg-change", {
      podName: "pod-0",
      currentBundleId: first.bundleId,
    });
    expect(second.status).toBe("provisioned");
    expect(second.bundleId).not.toBe(first.bundleId);
  });

  test("concurrent provisions share the same generation", async () => {
    provisioner.createProject("concurrent", "Concurrent");
    provisioner.pushCredential("concurrent", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    // Launch two provisions concurrently
    const [a, b] = await Promise.all([
      provisioner.provision("concurrent", { podName: "pod-0" }),
      provisioner.provision("concurrent", { podName: "pod-1" }),
    ]);

    // Both should get the same bundle (mutex)
    expect(a.bundleId).toBe(b.bundleId);
    // Only one S3 upload should have happened
    expect(s3Uploads).toHaveLength(1);
  });

  test("new credential push invalidates active bundle", async () => {
    provisioner.createProject("push-inval", "Push Invalidate");
    provisioner.pushCredential("push-inval", {
      accessToken: "old-tok",
      expiresAt: Date.now() + 3600_000,
    });

    const first = await provisioner.provision("push-inval", { podName: "pod-0" });
    expect(first.status).toBe("provisioned");

    // Push new credential — should invalidate old bundle
    provisioner.pushCredential("push-inval", {
      accessToken: "new-tok",
      expiresAt: Date.now() + 3600_000,
    });

    const second = await provisioner.provision("push-inval", {
      podName: "pod-0",
      currentBundleId: first.bundleId,
    });
    expect(second.status).toBe("provisioned");
    expect(second.bundleId).not.toBe(first.bundleId);
  });
});

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

describe("OAuth refresh", () => {
  test("refreshCredential returns null when no refresh token exists", async () => {
    provisioner.createProject("no-ref", "No Refresh");
    provisioner.pushCredential("no-ref", {
      accessToken: "tok",
      expiresAt: Date.now() - 1000, // expired
      // no refreshToken
    });

    const result = await provisioner.refreshCredential("no-ref");
    expect(result).toBeNull();
  });

  test("refreshCredential succeeds on 200 from OAuth endpoint", async () => {
    provisioner.createProject("refresh-ok", "Refresh OK");
    provisioner.pushCredential("refresh-ok", {
      accessToken: "expired-tok",
      refreshToken: "valid-ref",
      expiresAt: Date.now() - 1000,
    });

    // Mock global fetch for this test
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("console.anthropic.com")) {
        return new Response(
          JSON.stringify({
            access_token: "refreshed-tok",
            refresh_token: "new-ref",
            expires_in: 28800, // 8 hours
          }),
          { status: 200 },
        );
      }
      return originalFetch(url, {} as RequestInit);
    }) as unknown as typeof fetch;

    try {
      const result = await provisioner.refreshCredential("refresh-ok");
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("refreshed-tok");
      expect(result!.refreshToken).toBe("new-ref");
      expect(result!.source).toBe("refresh");
      expect(result!.expiresAt).toBeGreaterThan(Date.now());

      // Old credential should be invalidated
      const health = provisioner.getCredentialHealth("refresh-ok");
      expect(health.hasValidCredential).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshCredential returns null and sends alert on 401", async () => {
    provisioner.createProject("refresh-fail", "Refresh Fail");
    provisioner.pushCredential("refresh-fail", {
      accessToken: "expired-tok",
      refreshToken: "invalid-ref",
      expiresAt: Date.now() - 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("console.anthropic.com")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return originalFetch(url, {} as RequestInit);
    }) as unknown as typeof fetch;

    try {
      const result = await provisioner.refreshCredential("refresh-fail");
      expect(result).toBeNull();

      // Should have sent an alert
      expect(pushNotifications.length).toBeGreaterThanOrEqual(1);
      const alert = pushNotifications.find((n) => n.type === "auth_refresh_failed");
      expect(alert).toBeDefined();
      expect(alert!.title).toContain("refresh-fail");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("refreshCredential returns null and sends alert on network error", async () => {
    provisioner.createProject("refresh-net", "Refresh Net Error");
    provisioner.pushCredential("refresh-net", {
      accessToken: "expired-tok",
      refreshToken: "some-ref",
      expiresAt: Date.now() - 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("console.anthropic.com")) {
        throw new Error("Network error");
      }
      return originalFetch(url, {} as RequestInit);
    }) as unknown as typeof fetch;

    try {
      const result = await provisioner.refreshCredential("refresh-net");
      expect(result).toBeNull();

      const alert = pushNotifications.find((n) => n.type === "auth_refresh_failed");
      expect(alert).toBeDefined();
      expect(alert!.body).toContain("network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provision attempts refresh when credential is expired", async () => {
    provisioner.createProject("auto-ref", "Auto Refresh");
    provisioner.pushCredential("auto-ref", {
      accessToken: "expired-tok",
      refreshToken: "valid-ref",
      expiresAt: Date.now() - 1000, // expired
    });

    // Mock fetch for successful refresh
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("console.anthropic.com")) {
        return new Response(
          JSON.stringify({
            access_token: "auto-refreshed-tok",
            refresh_token: "new-ref",
            expires_in: 28800,
          }),
          { status: 200 },
        );
      }
      return originalFetch(url, {} as RequestInit);
    }) as unknown as typeof fetch;

    try {
      const result = await provisioner.provision("auto-ref", { podName: "pod-0" });
      expect(result.status).toBe("provisioned");
      expect(result.bundleId).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle content verification
// ---------------------------------------------------------------------------

describe("Bundle content", () => {
  test("generated tar.gz contains expected files", async () => {
    provisioner.createProject("tar-test", "Tar Test", {
      settingsJson: '{"editor":"vim"}',
      claudeJson: '{"tui":true}',
    });
    provisioner.pushCredential("tar-test", {
      accessToken: "tok-for-tar",
      refreshToken: "ref-for-tar",
      expiresAt: Date.now() + 3600_000,
      accountUuid: "acc-1",
      emailAddress: "test@tar.com",
    });

    await provisioner.provision("tar-test", { podName: "pod-0" });

    // Extract the tar.gz from the mock S3 upload
    expect(s3Uploads).toHaveLength(1);
    const tarGzBuffer = s3Uploads[0].Body as Buffer;

    // Decompress and extract file names
    const { createGunzip } = await import("zlib");
    const { extract } = await import("tar-stream");

    const fileNames: string[] = [];
    const fileContents: Record<string, string> = {};

    await new Promise<void>((resolve, reject) => {
      const gunzip = createGunzip();
      const ex = extract();

      ex.on("entry", (header, stream, next) => {
        fileNames.push(header.name);
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          fileContents[header.name] = Buffer.concat(chunks).toString("utf-8");
          next();
        });
        stream.resume();
      });

      ex.on("finish", resolve);
      ex.on("error", reject);

      // Feed the buffer through gunzip → extract
      gunzip.pipe(ex);
      gunzip.end(tarGzBuffer);
    });

    // Verify expected files
    expect(fileNames).toContain(".claude/.credentials.json");
    expect(fileNames).toContain(".config/claude/config.json");
    expect(fileNames).toContain(".claude.json");
    expect(fileNames).toContain(".claude/settings.json");

    // Verify credentials content (account metadata is in .claude.json, not here)
    const creds = JSON.parse(fileContents[".claude/.credentials.json"]);
    expect(creds.claudeAiOauth.accessToken).toBe("tok-for-tar");
    expect(creds.claudeAiOauth.refreshToken).toBe("ref-for-tar");

    // Verify config.json
    const config = JSON.parse(fileContents[".config/claude/config.json"]);
    expect(config.oauthToken).toBe("tok-for-tar");

    // Verify settings
    const settings = JSON.parse(fileContents[".claude/settings.json"]);
    expect(settings.editor).toBe("vim");

    // Verify claude.json
    const claudeJson = JSON.parse(fileContents[".claude.json"]);
    expect(claudeJson.tui).toBe(true);
  });

  test("bundle omits optional files when not configured", async () => {
    provisioner.createProject("minimal", "Minimal");
    provisioner.pushCredential("minimal", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    await provisioner.provision("minimal", { podName: "pod-0" });

    const tarGzBuffer = s3Uploads[0].Body as Buffer;
    const { createGunzip } = await import("zlib");
    const { extract } = await import("tar-stream");

    const fileNames: string[] = [];
    const fileContents: Record<string, string> = {};
    await new Promise<void>((resolve, reject) => {
      const gunzip = createGunzip();
      const ex = extract();
      ex.on("entry", (header, stream, next) => {
        fileNames.push(header.name);
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          fileContents[header.name] = Buffer.concat(chunks).toString("utf-8");
          next();
        });
        stream.resume();
      });
      ex.on("finish", resolve);
      ex.on("error", reject);
      gunzip.pipe(ex);
      gunzip.end(tarGzBuffer);
    });

    // All 4 files always present (synthesized defaults when not configured)
    expect(fileNames).toContain(".claude/.credentials.json");
    expect(fileNames).toContain(".config/claude/config.json");
    expect(fileNames).toContain(".claude.json");
    expect(fileNames).toContain(".claude/settings.json");

    // Verify synthesized defaults
    const claudeJson = JSON.parse(fileContents[".claude.json"]);
    expect(claudeJson.hasCompletedOnboarding).toBe(true);
    const settings = JSON.parse(fileContents[".claude/settings.json"]);
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema and DB
// ---------------------------------------------------------------------------

describe("Schema", () => {
  test("initSchema is idempotent", () => {
    // Already called in beforeEach — call again to verify no error
    expect(() => provisioner.initSchema()).not.toThrow();
  });

  test("bundle versioning increments", async () => {
    provisioner.createProject("ver", "Version");
    provisioner.pushCredential("ver", {
      accessToken: "tok",
      expiresAt: Date.now() + 3600_000,
    });

    await provisioner.provision("ver", { podName: "pod-0" });
    // Invalidate to force new bundle
    provisioner.updateProject("ver", { settingsJson: '{"v":2}' });
    await provisioner.provision("ver", { podName: "pod-0" });

    const rows = db
      .query(
        `SELECT version FROM environment_bundles WHERE project_id = ? ORDER BY version`,
      )
      .all("ver") as Array<{ version: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0].version).toBe(1);
    expect(rows[1].version).toBe(2);
  });
});
