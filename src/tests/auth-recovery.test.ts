/**
 * Tests for isCredentialExpired() and tryRecoverCredentials()
 * from src/lib/credentials-manager.ts
 *
 * Uses a temp HOME dir so tests never touch real ~/.claude/
 */
import { describe, test, expect, afterEach } from "bun:test";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// Temp HOME dir — set BEFORE importing credentials-manager so the module
// captures the right CREDENTIALS_PATH at load time.
const TEMP_HOME = os.tmpdir() + "/gwa-auth-test-" + process.pid;
const CLAUDE_DIR = path.join(TEMP_HOME, ".claude");
const CREDENTIALS_PATH = path.join(CLAUDE_DIR, ".credentials.json");

// Ensure the temp .claude directory exists before any test writes to it
fs.mkdirSync(CLAUDE_DIR, { recursive: true });

// Override HOME so credentials-manager picks up the temp dir
process.env.HOME = TEMP_HOME;

// Dynamic import ensures the module reads our overridden HOME
const { isCredentialExpired, tryRecoverCredentials } = await import(
  "../lib/credentials-manager.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeCredentials(payload: unknown): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(payload), "utf-8");
}

function deleteCredentials(): void {
  if (fs.existsSync(CREDENTIALS_PATH)) {
    fs.unlinkSync(CREDENTIALS_PATH);
  }
}

function futureMs(ms: number): number {
  return Date.now() + ms;
}

// ---------------------------------------------------------------------------
// Cleanup after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  deleteCredentials();
});

// ---------------------------------------------------------------------------
// isCredentialExpired()
// ---------------------------------------------------------------------------

describe("isCredentialExpired()", () => {
  test("returns true when credentials file is missing", () => {
    // Ensure the file does not exist
    deleteCredentials();
    expect(isCredentialExpired()).toBe(true);
  });

  test("returns true when file contains invalid JSON", () => {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, "not valid json {{ }", "utf-8");
    expect(isCredentialExpired()).toBe(true);
  });

  test("returns true when claudeAiOauth.expiresAt is missing", () => {
    writeCredentials({ claudeAiOauth: { accessToken: "tok" } });
    expect(isCredentialExpired()).toBe(true);
  });

  test("returns true when token is already expired (expiresAt in the past)", () => {
    const pastTimestamp = Date.now() - 60_000; // 1 minute ago
    writeCredentials({ claudeAiOauth: { accessToken: "tok", expiresAt: pastTimestamp } });
    expect(isCredentialExpired()).toBe(true);
  });

  test("returns true when token expires within 5 minutes (4 min from now)", () => {
    const fourMinFromNow = futureMs(4 * 60 * 1000); // 4 minutes = within the 5-min window
    writeCredentials({ claudeAiOauth: { accessToken: "tok", expiresAt: fourMinFromNow } });
    expect(isCredentialExpired()).toBe(true);
  });

  test("returns false when token has more than 5 minutes remaining (10 min from now)", () => {
    const tenMinFromNow = futureMs(10 * 60 * 1000); // 10 minutes = safely outside the window
    writeCredentials({ claudeAiOauth: { accessToken: "tok", expiresAt: tenMinFromNow } });
    expect(isCredentialExpired()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryRecoverCredentials()
// ---------------------------------------------------------------------------

describe("tryRecoverCredentials()", () => {
  test("returns false immediately when MINIO_ACCESS_KEY is not set and does NOT delete the credentials file", async () => {
    // Write a credentials file so we can verify it is NOT deleted
    writeCredentials({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() - 1000 } });

    // Ensure MinIO is not configured (captured at module load time as empty string)
    // In the test environment MINIO_ACCESS_KEY defaults to "" so this is the common case.
    // We verify the guard by confirming the file still exists after the call.
    const result = await tryRecoverCredentials();

    expect(result).toBe(false);
    // The credentials file must NOT have been deleted — MinIO guard prevented it
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(true);
  });

  test("returns false when MinIO is not configured (common test environment case)", async () => {
    // No credentials file — this exercises the early return in restoreCredentialsIfMissing
    // when MinIO credentials are absent
    deleteCredentials();

    const result = await tryRecoverCredentials();

    expect(result).toBe(false);
  });

  test("MinIO guard: credentials file survives when MINIO_ACCESS_KEY is absent", async () => {
    // Write valid-looking credentials
    const futureTimestamp = futureMs(60 * 60 * 1000); // 1 hour from now
    writeCredentials({ claudeAiOauth: { accessToken: "valid-token", expiresAt: futureTimestamp } });

    const result = await tryRecoverCredentials();

    // Since MinIO is not configured in tests, must return false
    expect(result).toBe(false);
    // And the file must still be present — no destructive side effects
    expect(fs.existsSync(CREDENTIALS_PATH)).toBe(true);
  });
});
