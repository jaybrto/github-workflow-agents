/**
 * Tests for provisionFromOrchestrator()
 * from src/lib/credentials-manager.ts
 *
 * Tests the orchestrator client logic: success, timeout, invalid response,
 * no config scenarios. Uses mock fetch — does NOT override HOME to avoid
 * cross-test contamination with other test files that import the same module.
 *
 * The credentials-manager module caches HOME at import time. If another test
 * file (e.g. auth-recovery.test.ts) already imported the module, its TEMP_HOME
 * is baked in. We derive our paths from the current HOME so we write credentials
 * to the same location the module reads from.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";

// Derive paths from whatever HOME the module captured (do NOT override HOME)
const ACTIVE_HOME = process.env.HOME || "/home/runner";
const CLAUDE_DIR = path.join(ACTIVE_HOME, ".claude");
const CONFIG_DIR = path.join(ACTIVE_HOME, ".config", "claude");
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, ".credentials.json");

fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Store original env vars to restore later
const origOrchUrl = process.env.ORCHESTRATOR_URL;
const origProjectId = process.env.GWA_PROJECT_ID;
const origApiKey = process.env.GWA_API_KEY;
const origMinioAccess = process.env.MINIO_ACCESS_KEY;
const origMinioSecret = process.env.MINIO_SECRET_KEY;

// Ensure MinIO is not configured (so tryRecoverCredentials MinIO path doesn't interfere)
process.env.MINIO_ACCESS_KEY = "";
process.env.MINIO_SECRET_KEY = "";

// Store original fetch
const originalFetch = globalThis.fetch;

// Dynamic import — may return cached module if another test file imported first
const { provisionFromOrchestrator } = await import("../lib/credentials-manager.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeCredentials(payload: unknown): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(payload), "utf-8");
}

function deleteCredentials(): void {
  if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH);
}

function setOrchestratorEnv(): void {
  process.env.ORCHESTRATOR_URL = "http://test-orchestrator:3001";
  process.env.GWA_PROJECT_ID = "test-project";
  process.env.GWA_API_KEY = "test-key-123";
}

function clearOrchestratorEnv(): void {
  process.env.ORCHESTRATOR_URL = "";
  process.env.GWA_PROJECT_ID = "";
  process.env.GWA_API_KEY = "";
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  deleteCredentials();
  clearOrchestratorEnv();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  deleteCredentials();
  globalThis.fetch = originalFetch;
  // Restore original env
  process.env.ORCHESTRATOR_URL = origOrchUrl;
  process.env.GWA_PROJECT_ID = origProjectId;
  process.env.GWA_API_KEY = origApiKey;
  process.env.MINIO_ACCESS_KEY = origMinioAccess;
  process.env.MINIO_SECRET_KEY = origMinioSecret;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("provisionFromOrchestrator()", () => {
  test("returns false when orchestrator env vars are not configured", async () => {
    clearOrchestratorEnv();
    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when ORCHESTRATOR_URL is empty", async () => {
    process.env.ORCHESTRATOR_URL = "";
    process.env.GWA_PROJECT_ID = "test";
    process.env.GWA_API_KEY = "key";
    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when GWA_PROJECT_ID is empty", async () => {
    process.env.ORCHESTRATOR_URL = "http://test:3001";
    process.env.GWA_PROJECT_ID = "";
    process.env.GWA_API_KEY = "key";
    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when GWA_API_KEY is empty", async () => {
    process.env.ORCHESTRATOR_URL = "http://test:3001";
    process.env.GWA_PROJECT_ID = "test";
    process.env.GWA_API_KEY = "";
    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when orchestrator returns non-200", async () => {
    setOrchestratorEnv();

    globalThis.fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when orchestrator returns no_credentials", async () => {
    setOrchestratorEnv();

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ status: "no_credentials", message: "No credentials" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when fetch throws (network error)", async () => {
    setOrchestratorEnv();

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false when fetch aborts (timeout)", async () => {
    setOrchestratorEnv();

    globalThis.fetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns false on unexpected status", async () => {
    setOrchestratorEnv();

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ status: "something_weird" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("returns true when status is current and local credentials are valid", async () => {
    setOrchestratorEnv();

    // Write valid credentials on disk
    writeCredentials({
      claudeAiOauth: {
        accessToken: "valid-tok",
        expiresAt: Date.now() + 3600_000,
      },
    });

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ status: "current", bundleId: "bundle-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(true);
  });

  test("returns false when status is current but local credentials are expired", async () => {
    setOrchestratorEnv();

    // Write expired credentials on disk
    writeCredentials({
      claudeAiOauth: {
        accessToken: "expired-tok",
        expiresAt: Date.now() - 1000,
      },
    });

    // First call returns "current", but since local creds are expired,
    // provisionFromOrchestrator should log a warning and fall through.
    // The second codepath (provisioned) won't match either since there's
    // no s3Key, so it returns false for unexpected status.
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ status: "current", bundleId: "bundle-123" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await provisionFromOrchestrator();
    expect(result).toBe(false);
  });

  test("sends correct request headers and body", async () => {
    setOrchestratorEnv();
    process.env.POD_NAME = "test-pod-42";

    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const headers = init?.headers as Record<string, string> | undefined;
      capturedHeaders = headers || {};
      capturedBody = (init?.body as string) || "";

      return new Response(
        JSON.stringify({ status: "no_credentials", message: "none" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await provisionFromOrchestrator();

    expect(capturedUrl).toContain("/projects/test-project/provision");
    expect(capturedHeaders["Authorization"]).toBe("Bearer test-key-123");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedBody);
    expect(body.podName).toBeTruthy();
  });
});
