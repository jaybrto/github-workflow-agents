# Provision Environment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a three-phase provision-environment workflow that launches Claude TUI for re-auth, bundles credentials to MinIO, and refreshes stuck runner pods.

**Architecture:** New CLI binary `gwa-provision-environment` with `--phase start|complete|refresh`. Orchestrator REST endpoints proxy kubectl exec calls to runner pods. ntfy.sh notifications deliver OAuth URLs and status updates.

**Tech Stack:** Bun, TypeScript, tmux (via `src/lib/tmux.ts`), MinIO (via `@aws-sdk/client-s3`), ntfy.sh (HTTP POST), SQLite

---

### Task 1: Add shared types and SQLite schema

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/lib/db.ts`

**Step 1: Add ProvisionSession type to shared types**

In `src/shared/types.ts`, add at the end (before any closing export):

```typescript
/** Provision environment session — tracks interactive auth + bundling flow */
export interface ProvisionSession {
  id: string;
  podName: string;
  tmuxWindow: number | null;
  oauthUrl: string | null;
  kubectlCommand: string | null;
  status: "started" | "waiting_for_auth" | "bundling" | "complete" | "failed";
  bundleId: string | null;
  s3Key: string | null;
  createdAt: number;
  completedAt: number | null;
}
```

**Step 2: Add provision_sessions table to db.ts**

In `src/lib/db.ts`, find the `initializeSchema()` function (or wherever tables are created). Add:

```typescript
export function ensureProvisionSessionsTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS provision_sessions (
      id TEXT PRIMARY KEY,
      pod_name TEXT NOT NULL,
      tmux_window INTEGER,
      oauth_url TEXT,
      kubectl_command TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      bundle_id TEXT,
      s3_key TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER
    );
  `);
}

export function getProvisionSession(id: string): Record<string, unknown> | null {
  const db = getDatabase();
  return db.query("SELECT * FROM provision_sessions WHERE id = ?").get(id) as Record<string, unknown> | null;
}

export function getLatestProvisionSession(): Record<string, unknown> | null {
  const db = getDatabase();
  return db.query("SELECT * FROM provision_sessions ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | null;
}

export function upsertProvisionSession(session: {
  id: string;
  podName: string;
  tmuxWindow?: number;
  oauthUrl?: string;
  kubectlCommand?: string;
  status: string;
  bundleId?: string;
  s3Key?: string;
}): void {
  const db = getDatabase();
  db.run(
    `INSERT OR REPLACE INTO provision_sessions
      (id, pod_name, tmux_window, oauth_url, kubectl_command, status, bundle_id, s3_key, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM provision_sessions WHERE id = ?), unixepoch()), ?)`,
    [
      session.id,
      session.podName,
      session.tmuxWindow ?? null,
      session.oauthUrl ?? null,
      session.kubectlCommand ?? null,
      session.status,
      session.bundleId ?? null,
      session.s3Key ?? null,
      session.id,
      session.status === "complete" || session.status === "failed" ? Math.floor(Date.now() / 1000) : null,
    ]
  );
}
```

**Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 4: Commit**

```bash
git add src/shared/types.ts src/lib/db.ts
git commit -m "feat(provision): add ProvisionSession type and DB schema"
```

---

### Task 2: Create provision-environment CLI binary (start phase)

**Files:**
- Create: `src/transitions/provision-environment.ts`

**Step 1: Create the CLI binary with start phase**

```typescript
#!/usr/bin/env bun
/**
 * Provision Environment
 *
 * Three-phase workflow for re-provisioning Claude Code credentials:
 * - start: Launch Claude TUI, detect auth screen, send ntfy.sh notification
 * - complete: Bundle credentials and upload to MinIO
 * - refresh: Push fresh creds to running pod, restart stuck sessions
 *
 * Usage:
 *   gwa-provision-environment --phase <start|complete|refresh> [--pod <name>] [--session-id <id>]
 */
import { parseArgs } from "util";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { $ } from "bun";
import { withSpan, shutdown as shutdownTelemetry, log } from "../lib/telemetry.js";
import * as tmux from "../lib/tmux.js";
import * as db from "../lib/db.js";
import {
  getAccessToken,
  isCredentialExpired,
  provisionFromOrchestrator,
  tryRecoverCredentials,
  backupCredentials,
  syncConfigFromCredentials,
} from "../lib/credentials-manager.js";
import { preloadClaudeConfig, detectAuthFailure } from "../lib/claude.js";
import { handleDialogIfPresent } from "../lib/dialog-handler.js";

const POD_NAME = process.env.POD_NAME || process.env.HOSTNAME || "unknown-pod";
const NTFY_URL = process.env.NTFY_URL || "https://ntfy.bto.bar/gwa";

interface Args {
  phase: "start" | "complete" | "refresh";
  pod: string;
  sessionId?: string;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      phase: { type: "string" },
      pod: { type: "string" },
      "session-id": { type: "string" },
    },
  });

  const args: Args = {
    phase: (values.phase as Args["phase"]) || "start",
    pod: values.pod || POD_NAME,
    sessionId: values["session-id"],
  };

  if (!["start", "complete", "refresh"].includes(args.phase)) {
    console.error("Usage: gwa-provision-environment --phase <start|complete|refresh>");
    await shutdownTelemetry();
    process.exit(1);
  }

  let success = false;

  try {
    await withSpan(`provision.${args.phase}`, async (span) => {
      span.setAttribute("provision.phase", args.phase);
      span.setAttribute("provision.pod", args.pod);

      db.ensureProvisionSessionsTable();

      switch (args.phase) {
        case "start":
          await runStartPhase(args);
          break;
        case "complete":
          await runCompletePhase(args);
          break;
        case "refresh":
          await runRefreshPhase(args);
          break;
      }

      success = true;
    });
  } catch (error) {
    log("error", `Provision ${args.phase} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await shutdownTelemetry();
  }

  process.exit(success ? 0 : 1);
}

// ============================================================================
// Phase 1: Start
// ============================================================================

async function runStartPhase(args: Args): Promise<void> {
  const sessionId = randomUUID();
  log("info", "Starting provision environment", { sessionId, pod: args.pod });

  // Ensure tmux session exists
  await tmux.ensureSession();

  // Pre-load config
  preloadClaudeConfig();

  // Create tmux window for auth
  const windowNum = await tmux.createWindow("provision-auth", "/home/runner");
  const kubectlCmd = `kubectl exec -it ${args.pod} -- tmux attach -t gwa-work:${windowNum}`;

  // Store initial session
  db.upsertProvisionSession({
    id: sessionId,
    podName: args.pod,
    tmuxWindow: windowNum,
    kubectlCommand: kubectlCmd,
    status: "started",
  });

  // Export token if available
  const token = getAccessToken();
  if (token) {
    await tmux.sendKeys(windowNum, `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`);
    await Bun.sleep(200);
  }

  // Launch Claude TUI
  await tmux.sendCommand(windowNum, "claude --dangerously-skip-permissions");
  await Bun.sleep(5000);

  // Try to dismiss any dialogs first
  await handleDialogIfPresent(windowNum);
  await Bun.sleep(2000);

  // Capture pane and check for auth screen
  const paneText = await tmux.capturePane(windowNum, 50);

  if (detectAuthFailure(paneText)) {
    // Extract OAuth URL from pane
    const urlMatch = paneText.match(/(https:\/\/claude\.ai\/oauth\/authorize[^\s]+)/);
    const oauthUrl = urlMatch?.[1] || null;

    log("info", "Auth screen detected, sending notification", { oauthUrl: !!oauthUrl });

    // Update session
    db.upsertProvisionSession({
      id: sessionId,
      podName: args.pod,
      tmuxWindow: windowNum,
      kubectlCommand: kubectlCmd,
      oauthUrl: oauthUrl || undefined,
      status: "waiting_for_auth",
    });

    // Send ntfy notification
    await sendNtfy(
      "Claude Auth Required",
      [
        `Claude needs re-authentication on pod ${args.pod}.`,
        "",
        oauthUrl ? `OAuth URL: ${oauthUrl}` : "No OAuth URL captured — attach to terminal.",
        "",
        `Attach: ${kubectlCmd}`,
        "",
        `Session: ${sessionId}`,
        "",
        "After authenticating, call:",
        `POST /provision-environment/complete { "sessionId": "${sessionId}" }`,
      ].join("\n"),
      5, // urgent
      ["lock", "warning"],
    );

    console.log(`\nProvisioning session started: ${sessionId}`);
    console.log(`Status: waiting_for_auth`);
    console.log(`Window: ${windowNum}`);
    console.log(`Attach: ${kubectlCmd}`);
    if (oauthUrl) console.log(`OAuth URL: ${oauthUrl}`);
  } else {
    // Claude started fine — no auth needed
    log("info", "Claude authenticated successfully, no manual auth needed");

    // Bundle immediately
    await exitClaude(windowNum);
    const bundleResult = await createBundle(sessionId, args.pod);

    db.upsertProvisionSession({
      id: sessionId,
      podName: args.pod,
      tmuxWindow: windowNum,
      status: "complete",
      bundleId: bundleResult?.bundleId,
      s3Key: bundleResult?.s3Key,
    });

    await tmux.killWindow(windowNum);

    await sendNtfy(
      "Environment Bundle Ready",
      `Claude authenticated automatically. Bundle created: ${bundleResult?.s3Key || "none"}`,
      3,
      ["package", "white_check_mark"],
    );

    console.log("Claude authenticated automatically — bundle created.");
  }
}

// ============================================================================
// Phase 2: Complete
// ============================================================================

async function runCompletePhase(args: Args): Promise<void> {
  // Find the session
  const sessionId = args.sessionId;
  let session: Record<string, unknown> | null = null;

  if (sessionId) {
    session = db.getProvisionSession(sessionId);
  } else {
    session = db.getLatestProvisionSession();
  }

  if (!session) {
    throw new Error("No provision session found. Run --phase start first.");
  }

  if (session.status !== "waiting_for_auth" && session.status !== "started") {
    throw new Error(`Session ${session.id} is in state '${session.status}', expected 'waiting_for_auth'.`);
  }

  const sid = session.id as string;
  const windowNum = session.tmux_window as number;

  log("info", "Running complete phase", { sessionId: sid, window: windowNum });

  // Verify window exists
  const exists = await tmux.windowExists(windowNum);
  if (!exists) {
    throw new Error(`Tmux window ${windowNum} no longer exists.`);
  }

  // Capture pane and verify auth succeeded
  const paneText = await tmux.capturePane(windowNum, 50);
  if (detectAuthFailure(paneText)) {
    throw new Error("Claude is still on the auth screen. Please complete authentication first.");
  }

  // Update status to bundling
  db.upsertProvisionSession({
    id: sid,
    podName: session.pod_name as string,
    tmuxWindow: windowNum,
    status: "bundling",
  });

  // Exit Claude
  await exitClaude(windowNum);
  await Bun.sleep(2000);

  // Sync config files
  syncConfigFromCredentials();

  // Create and upload bundle
  const bundleResult = await createBundle(sid, session.pod_name as string);

  // Also back up via the standard credentials backup
  await backupCredentials();

  // Update session
  db.upsertProvisionSession({
    id: sid,
    podName: session.pod_name as string,
    status: "complete",
    bundleId: bundleResult?.bundleId,
    s3Key: bundleResult?.s3Key,
  });

  // Kill the provisioning window
  await tmux.killWindow(windowNum);

  // Send notification
  await sendNtfy(
    "Environment Bundle Ready",
    [
      `Fresh credentials bundled and uploaded to MinIO.`,
      `Bundle: ${bundleResult?.s3Key || "none"}`,
      "",
      "To refresh running pods:",
      `POST /provision-environment/refresh { "podName": "${session.pod_name}" }`,
    ].join("\n"),
    3,
    ["package", "white_check_mark"],
  );

  console.log(`\nBundle created: ${bundleResult?.s3Key}`);
  console.log(`Session ${sid} complete.`);
}

// ============================================================================
// Phase 3: Refresh
// ============================================================================

async function runRefreshPhase(args: Args): Promise<void> {
  log("info", "Running refresh phase", { pod: args.pod });

  // Pull fresh credentials from orchestrator
  const provisioned = await provisionFromOrchestrator();
  if (!provisioned) {
    // Fallback to MinIO
    const recovered = await tryRecoverCredentials();
    if (!recovered) {
      log("warn", "No fresh credentials available from orchestrator or MinIO");
    }
  }

  preloadClaudeConfig();
  syncConfigFromCredentials();

  // Update tmux session-level env
  const freshToken = getAccessToken();
  if (freshToken) {
    await tmux.setEnvironment("CLAUDE_CODE_OAUTH_TOKEN", freshToken);
  }

  // Scan all tmux windows for stuck auth
  let windowsRestarted = 0;
  const windowList = await tmux.capturePane(0, 1); // Just need to verify session exists

  try {
    const listResult = Bun.spawnSync(["tmux", "list-windows", "-t", "gwa-work", "-F", "#{window_index} #{window_name}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(listResult.stdout);
    const windows = output.trim().split("\n").filter(Boolean);

    for (const line of windows) {
      const [indexStr, name] = line.split(" ", 2);
      const windowIndex = parseInt(indexStr, 10);

      // Skip status window and provision windows
      if (name === "status" || name?.startsWith("provision-") || name?.startsWith("auth-warmup")) {
        continue;
      }

      const paneText = await tmux.capturePane(windowIndex, 30);
      if (!detectAuthFailure(paneText)) {
        continue; // Window is fine, skip
      }

      log("info", "Found stuck auth window, refreshing", { window: windowIndex, name });

      // Kill stuck Claude
      await tmux.sendKeys(windowIndex, "C-c");
      await Bun.sleep(500);
      await tmux.sendKeys(windowIndex, "C-c");
      await Bun.sleep(1000);

      // Export fresh token
      if (freshToken) {
        await tmux.sendKeys(windowIndex, `export CLAUDE_CODE_OAUTH_TOKEN='${freshToken}'\n`);
        await Bun.sleep(200);
      }

      // Relaunch Claude
      await tmux.sendCommand(windowIndex, "claude --dangerously-skip-permissions");
      await Bun.sleep(3000);

      // Handle any dialogs
      await handleDialogIfPresent(windowIndex);

      windowsRestarted++;
    }
  } catch (e) {
    log("warn", "Failed to list tmux windows", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Notify
  if (windowsRestarted > 0) {
    await sendNtfy(
      `Pod ${args.pod} Refreshed`,
      `Credentials updated. ${windowsRestarted} stuck window(s) restarted.`,
      3,
      ["arrows_counterclockwise"],
    );
  }

  console.log(`\nRefresh complete: ${windowsRestarted} window(s) restarted.`);
}

// ============================================================================
// Helpers
// ============================================================================

async function exitClaude(windowNum: number): Promise<void> {
  await tmux.sendKeys(windowNum, "Escape");
  await Bun.sleep(300);
  await tmux.sendCommand(windowNum, "/exit");
  await Bun.sleep(1000);
}

async function createBundle(
  sessionId: string,
  podName: string
): Promise<{ bundleId: string; s3Key: string } | null> {
  const home = process.env.HOME || "/home/runner";
  const tarPath = `/tmp/env-bundle-${Date.now()}.tar.gz`;
  const bundleId = `bundle-${Date.now()}`;
  const s3Key = `claude-auth/bundles/${new Date().toISOString()}/env-bundle.tar.gz`;

  try {
    // Collect files to tar
    const filesToTar: string[] = [];
    if (existsSync(`${home}/.claude/.credentials.json`)) filesToTar.push(".claude/.credentials.json");
    if (existsSync(`${home}/.claude.json`)) filesToTar.push(".claude.json");
    if (existsSync(`${home}/.config/claude/config.json`)) filesToTar.push(".config/claude/config.json");

    if (filesToTar.length === 0) {
      log("warn", "No credential files found to bundle");
      return null;
    }

    await $`tar czf ${tarPath} -C ${home} ${filesToTar} 2>/dev/null`.quiet();

    // Upload to MinIO
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      endpoint: `http://${process.env.MINIO_ENDPOINT || "minio.bto.bar:9000"}`,
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY || "",
        secretAccessKey: process.env.MINIO_SECRET_KEY || "",
      },
      forcePathStyle: true,
    });

    const data = readFileSync(tarPath);
    const bucket = process.env.MINIO_BUCKET || "gwa-recordings";

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: data,
      ContentType: "application/gzip",
      Metadata: {
        "session-id": sessionId,
        "pod-name": podName,
        "created-at": new Date().toISOString(),
      },
    }));

    log("info", "Bundle uploaded to MinIO", { s3Key, bundleId });
    return { bundleId, s3Key };
  } catch (e) {
    log("error", "Failed to create bundle", {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    try { await $`rm -f ${tarPath}`.quiet(); } catch {}
  }
}

async function sendNtfy(
  title: string,
  body: string,
  priority: number,
  tags: string[],
): Promise<void> {
  try {
    const resp = await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        Title: title,
        Priority: String(priority),
        Tags: tags.join(","),
      },
      body,
    });
    if (!resp.ok) {
      log("warn", "ntfy notification failed", { status: resp.status });
    }
  } catch (e) {
    log("warn", "ntfy notification error", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

await main();
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/transitions/provision-environment.ts
git commit -m "feat(provision): add provision-environment CLI with start/complete/refresh phases"
```

---

### Task 3: Add orchestrator REST endpoints

**Files:**
- Modify: `src/orchestrator/rest-api.ts`

**Step 1: Add provision-environment endpoints**

Find the end of the route matching in `createRestApi()` (before the `return json({ error: "Not found" }, 404)` fallback). Add:

```typescript
      // -----------------------------------------------------------------------
      // Provision Environment endpoints
      // -----------------------------------------------------------------------

      // POST /provision-environment/start
      if (method === "POST" && segments[0] === "provision-environment" && segments[1] === "start") {
        if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json()) as { podName?: string };
        const podName = body.podName || "gwa-runner-0";

        try {
          const result = Bun.spawnSync(
            ["kubectl", "exec", podName, "--", "/usr/local/bin/gwa-provision-environment", "--phase", "start", "--pod", podName],
            { stdout: "pipe", stderr: "pipe", timeout: 30000 }
          );

          const stdout = new TextDecoder().decode(result.stdout);
          const stderr = new TextDecoder().decode(result.stderr);

          if (result.exitCode !== 0) {
            return json({ error: "Start phase failed", stderr: stderr.slice(0, 500) }, 500);
          }

          return json({ status: "started", output: stdout.slice(0, 1000) });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // POST /provision-environment/complete
      if (method === "POST" && segments[0] === "provision-environment" && segments[1] === "complete") {
        if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json()) as { sessionId?: string; podName?: string };
        const podName = body.podName || "gwa-runner-0";
        const sessionArgs = body.sessionId ? ["--session-id", body.sessionId] : [];

        try {
          const result = Bun.spawnSync(
            ["kubectl", "exec", podName, "--", "/usr/local/bin/gwa-provision-environment", "--phase", "complete", ...sessionArgs],
            { stdout: "pipe", stderr: "pipe", timeout: 30000 }
          );

          const stdout = new TextDecoder().decode(result.stdout);
          const stderr = new TextDecoder().decode(result.stderr);

          if (result.exitCode !== 0) {
            return json({ error: "Complete phase failed", stderr: stderr.slice(0, 500) }, 500);
          }

          return json({ status: "complete", output: stdout.slice(0, 1000) });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // POST /provision-environment/refresh
      if (method === "POST" && segments[0] === "provision-environment" && segments[1] === "refresh") {
        if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json()) as { podName: string };
        if (!body.podName) return json({ error: "podName required" }, 400);

        try {
          const result = Bun.spawnSync(
            ["kubectl", "exec", body.podName, "--", "/usr/local/bin/gwa-provision-environment", "--phase", "refresh", "--pod", body.podName],
            { stdout: "pipe", stderr: "pipe", timeout: 60000 }
          );

          const stdout = new TextDecoder().decode(result.stdout);
          const stderr = new TextDecoder().decode(result.stderr);

          if (result.exitCode !== 0) {
            return json({ error: "Refresh phase failed", stderr: stderr.slice(0, 500) }, 500);
          }

          return json({ status: "refreshed", output: stdout.slice(0, 1000) });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }

      // GET /provision-environment/status
      if (method === "GET" && segments[0] === "provision-environment" && segments[1] === "status") {
        if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);

        // Query the runner pod's DB for latest provision session
        try {
          const result = Bun.spawnSync(
            ["kubectl", "exec", "gwa-runner-0", "--", "sqlite3", "-json", "/home/runner/.claude/gwa.db",
             "SELECT * FROM provision_sessions ORDER BY created_at DESC LIMIT 1"],
            { stdout: "pipe", stderr: "pipe", timeout: 10000 }
          );
          const stdout = new TextDecoder().decode(result.stdout).trim();
          const sessions = stdout ? JSON.parse(stdout) : [];
          return json(sessions[0] || { status: "idle" });
        } catch {
          return json({ status: "idle" });
        }
      }
```

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/orchestrator/rest-api.ts
git commit -m "feat(provision): add REST endpoints for provision-environment"
```

---

### Task 4: Add workflow handler and build script

**Files:**
- Modify: `.github/workflows/project-sync.yml`
- Modify: `package.json`
- Modify: `CHANGELOG.md`

**Step 1: Add handler to project-sync.yml**

Find the last handler block (before the `detect-changes` job). Add a new step:

```yaml
      - name: "Handler: provision-environment"
        if: |
          github.event_name == 'workflow_dispatch' &&
          github.event.inputs.handler == 'provision-environment'
        run: |
          echo "Starting environment provisioning on $POD"
          kubectl exec "$POD" -- "$GWA_BIN/gwa-provision-environment" \
            --phase start \
            --pod "$POD"
```

**Step 2: Add build script to package.json**

Add to the `scripts` section:

```json
"build:provision-environment": "bun build src/transitions/provision-environment.ts --compile --outfile dist/gwa-provision-environment"
```

Also append `&& bun run build:provision-environment` to the end of the `build` script.

Bump version: `4.10.2` -> `4.11.0` (new feature).

**Step 3: Update CHANGELOG.md**

Add at the top (after heading):

```markdown
## [4.11.0] - 2026-02-20

### Added
- `gwa-provision-environment` CLI binary with three phases (start, complete, refresh) for on-demand credential re-provisioning
- Orchestrator REST endpoints: `POST /provision-environment/start`, `/complete`, `/refresh` and `GET /provision-environment/status`
- `provision-environment` handler in project-sync.yml workflow
- ntfy.sh notifications with OAuth URL when manual authentication is needed
- Automatic refresh of stuck auth windows on running pods without disrupting healthy sessions
```

**Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add .github/workflows/project-sync.yml package.json CHANGELOG.md
git commit -m "feat(provision): add workflow handler, build script, version bump to 4.11.0"
```

---

### Task 5: Verify build and run tests

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

**Step 2: Build the binary**

Run: `bun run build:provision-environment`
Expected: Creates `dist/gwa-provision-environment`

**Step 3: Run typecheck one final time**

Run: `bun run typecheck`
Expected: PASS
