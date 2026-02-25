# GitHub Workflow Agents: Claude CLI Authentication Architecture

## Executive Summary

**github-workflow-agents** (GWA) implements a comprehensive Claude Code CLI authentication and credential provisioning system designed to run in long-lived Kubernetes pods. The system handles:

1. **Credential Generation & Storage** — OAuth tokens pushed via REST API
2. **Automated Provisioning** — Pre-seeding of auth files before Claude startup
3. **Interactive Dialog Handling** — Haiku-powered auto-dismissal of permission prompts
4. **Token Refresh** — Automatic OAuth refresh on expiry with fallback recovery
5. **Headless Execution** — Stdin handling for non-interactive REPL environments

The solution is production-ready and currently deployed on K3s with automated pod credential sync.

---

## Architecture Overview

### High-Level Flow

```
┌────────────────────────────────────────────────────────────────────┐
│ 1. Orchestrator Service (REST API)                                 │
│    - Receives credentials: POST /projects/:id/credentials           │
│    - Generates bundles: POST /projects/:id/provision                │
│    - Refreshes OAuth: POST /projects/:id/refresh                    │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ tar.gz bundle (MinIO S3)
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ 2. MinIO Storage Layer                                              │
│    - claude-auth/pods/<pod-name>/credentials.tar.gz (pod backup)   │
│    - claude-auth/credentials.tar.gz (legacy fallback)              │
│    - env-bundles/<project>/<bundle-id>.tar.gz (versioned)          │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ 3. K8s StatefulSet Pod Startup                                      │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │ entrypoint.sh (ConfigMap)                                   │  │
│    │ - Validates REPO, POD_NAME (security)                      │  │
│    │ - Clones/updates git repo                                  │  │
│    │ - Runs gwa-provision CLI (orchestrator sync)               │  │
│    │ - Syncs Claude config from credentials                     │  │
│    │ - Initializes tmux session                                 │  │
│    └────────────────────────────────────────────────────────────┘  │
│                           │                                          │
│                           ▼                                          │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │ ~/.claude/.credentials.json (persistent PVC)              │  │
│    │ - claudeAiOauth { accessToken, refreshToken, expiresAt }  │  │
│    └────────────────────────────────────────────────────────────┘  │
│                                                                      │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │ ~/.config/claude/config.json (ephemeral, recreated)       │  │
│    │ - { oauthToken: <accessToken> }                           │  │
│    └────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│ 4. Claude Code CLI Startup                                          │
│    - Reads ~/.config/claude/config.json OR CLAUDE_CODE_OAUTH_TOKEN │
│    - May show permission dialogs                                    │
│                           │                                          │
│                           ▼                                          │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │ Dialog Handler (Haiku-powered)                             │  │
│    │ - Captures tmux pane output                                │  │
│    │ - Detects known dialogs (known_dialogs[])                 │  │
│    │ - Queries Haiku for complex dialogs                        │  │
│    │ - Auto-sends key sequences (Enter, y, Tab, etc.)          │  │
│    │ - Max 3 attempts with 1s wait between                      │  │
│    └────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           ▼
                    Claude REPL Ready
```

---

## Key Components & File Locations

### 1. Orchestrator Service (`src/orchestrator/`)

The orchestrator is a standalone Bun HTTP service that manages credential lifecycle.

#### **environment-provisioner.ts** (503 lines)
**Role:** Core credential and bundle management engine

**Key Classes:**
- `EnvironmentProvisioner` — Main service class with lifecycle (start/stop)

**Key Methods:**
- `createProject(id, displayName, config)` — Register new project
- `pushCredential(projectId, req, pushedBy)` — Receive OAuth token from `gwa-push-credentials`
- `provision(projectId, req)` — Generate and serve tar.gz bundle to pods
- `getActiveCredential(projectId)` — Fetch current valid token
- `tryRefreshCredential(projectId)` — Auto-refresh using refresh_token via Claude OAuth endpoint
- `generateBundle(project, credential)` — Create tar.gz with `.credentials.json` + `config.json`
- `refreshAllCredentials()` — Background timer (30min interval) to proactively refresh expiring tokens

**Database Schema:**
```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  claude_account_uuid TEXT,
  claude_org_uuid TEXT,
  claude_email TEXT,
  settings_json TEXT,          -- ~/.claude.json (TUI settings)
  claude_json TEXT,
  mcp_json TEXT,
  claude_md TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE project_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  access_token TEXT,           -- OAuth access token
  refresh_token TEXT,          -- OAuth refresh token
  expires_at INTEGER,          -- Millisecond timestamp
  account_uuid TEXT,
  email_address TEXT,
  organization_uuid TEXT,
  billing_type TEXT DEFAULT 'stripe_subscription',
  display_name TEXT DEFAULT 'GWA',
  source TEXT,                 -- 'push' | 'refresh' | 'import'
  pushed_by TEXT,              -- Username that pushed it
  created_at INTEGER,
  invalidated_at INTEGER       -- NULL = active
);

CREATE TABLE environment_bundles (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  credential_id TEXT,
  version INTEGER,             -- Incremented per bundle
  s3_key TEXT,                 -- MinIO path
  s3_bucket TEXT,
  size_bytes INTEGER,
  config_hash TEXT,
  credential_expires_at INTEGER,
  created_at INTEGER,
  expired_at INTEGER,          -- NULL = active
  cleaned_up_at INTEGER
);
```

**Credential Refresh Flow:**
```typescript
// OAuth client
const CLAUDE_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e535-45a4-8c43-53e1cee47cde";

// In tryRefreshCredential():
fetch(CLAUDE_OAUTH_TOKEN_URL, {
  method: "POST",
  body: JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oldCredential.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID
  })
});
```

#### **rest-api.ts** (243 lines)
**Role:** HTTP endpoint handler for pod provisioning and CLI management

**Endpoints:**
```
GET  /health                              Health check + pod count
GET  /sessions                            List all active sessions
GET  /sessions/:id                        Session details
POST /sessions/:id/answer                 Send answer to blocked session
GET  /sessions/:id/snapshots              Terminal snapshots
GET  /sessions/:id/recordings             Session recordings

POST /projects                            Create project (API key required)
GET  /projects                            List projects with health (API key required)
GET  /projects/:id                        Get project config (API key required)
PUT  /projects/:id                        Update config (API key required)
POST /projects/:id/credentials            Push credentials (API key required)
POST /projects/:id/provision              Pod provisioning (API key required)  **← MAIN**
POST /projects/:id/refresh                Force OAuth refresh (API key required)
GET  /projects/:id/health                 Credential health status (API key required)
```

**Key Implementation:**
```typescript
// Main provisioning endpoint (lines 198-205)
if (method === "POST" && segments[2] === "provision") {
  if (!checkApiKey(request)) return json({ error: "Unauthorized" }, 401);
  const body = await request.json() as ProvisionRequest;
  const result = await provisioner.provision(projectId, body);
  return json(result);
}
```

---

### 2. Credential Manager (`src/lib/credentials-manager.ts`) (468 lines)

**Role:** Pod-side credential provisioning, restoration, and backup

This is the **critical bridge** between orchestrator and pod filesystem.

**Key Functions:**

```typescript
// Called on every Claude invocation to check expiry
export function isCredentialExpired(): boolean
  → Reads ~/.claude/.credentials.json
  → Checks expiresAt vs Date.now() + 5 minutes
  → Returns true if missing, unparseable, or expiring soon

// Pod startup: fetch bundle from orchestrator via REST
export async function provisionFromOrchestrator(): Promise<boolean>
  → POST /projects/:id/provision with podName
  → Downloads tar.gz from MinIO (s3Key in response)
  → Extracts to $HOME, syncs config
  → Updates process.env.CLAUDE_CODE_OAUTH_TOKEN

// Pod startup: restore from MinIO if orchestrator unavailable
export async function restoreCredentialsIfMissing(): Promise<boolean>
  → Tries pod's own backup first (claude-auth/pods/<POD_NAME>/...)
  → Falls back to other pods' backups (any pod works — refresh_token is valid for all)
  → Falls back to legacy single-copy (claude-auth/credentials.tar.gz)

// Periodic: backup fresh credentials to MinIO for pod disaster recovery
export async function backupCredentials(): Promise<boolean>
  → Checks credentials not expired
  → Tars: ~/.claude/.credentials.json + ~/.claude.json
  → Uploads to MinIO with pod-specific + legacy paths
  → Guards against backing up expired tokens

// Sync config from persistent credentials to ephemeral ~/.config/claude/
export function syncConfigFromCredentials(): void
  → Reads ~/.claude/.credentials.json
  → Extracts accessToken
  → Writes ~/.config/claude/config.json with { oauthToken: ... }
  → Called on every pod start since ~/.config/ is ephemeral
```

**File Paths (read at call time, not module load):**
```typescript
function getHome(): string { return process.env.HOME || "/home/runner"; }
function getClaudeDir(): string { return join(getHome(), ".claude"); }
function getCredentialsPath(): string { return join(getClaudeDir(), ".credentials.json"); }
function getSettingsPath(): string { return join(getHome(), ".claude.json"); }
function getConfigDir(): string { return join(getHome(), ".config", "claude"); }
function getConfigPath(): string { return join(getConfigDir(), "config.json"); }
```

**MinIO Storage Layout:**
```
gwa-recordings bucket (default: MINIO_BUCKET env var)
├── claude-auth/
│   ├── pods/
│   │   ├── gwa-runner-0/
│   │   │   └── credentials.tar.gz (pod's own backup, latest metadata)
│   │   ├── gwa-runner-1/
│   │   │   └── credentials.tar.gz
│   │   └── ...
│   └── credentials.tar.gz (legacy single-copy for backwards compat)
└── env-bundles/
    └── <project-id>/
        └── <bundle-uuid>.tar.gz (versioned, immutable once generated)
```

---

### 3. CLI Tools for Credential Management

#### **push-credentials.ts** (140 lines)
**Role:** Manual credential push from developer machine to orchestrator

**Usage:**
```bash
gwa-push-credentials --project gwa --orchestrator http://gwa-orchestrator:3001 --api-key <API_KEY>
```

**Flow:**
1. Reads `~/.claude/.credentials.json` (from `claude auth login`)
2. Extracts OAuth fields: accessToken, refreshToken, expiresAt, accountUuid, emailAddress, organizationUuid, billingType, displayName
3. POST to `/projects/<id>/credentials` with Bearer token auth
4. Orchestrator stores in DB, invalidates old credentials, generates new bundle
5. Shows credential ID and time remaining

**Key Code:**
```typescript
const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
if (!oauth?.accessToken) {
  console.error("Error: No accessToken found in credentials file");
  process.exit(1);
}

const pushUrl = `${orchestratorUrl}/projects/${projectId}/credentials`;
const response = await fetch(pushUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
    "X-Pushed-By": process.env.USER || "unknown",
  },
  body: JSON.stringify({
    accessToken: oauth.accessToken as string,
    refreshToken: (oauth.refreshToken as string) || undefined,
    expiresAt: expiresAt,
    accountUuid: (oauth.accountUuid as string) || undefined,
    emailAddress: (oauth.emailAddress as string) || undefined,
    organizationUuid: (oauth.organizationUuid as string) || undefined,
    billingType: (oauth.billingType as string) || undefined,
    displayName: (oauth.displayName as string) || undefined,
  }),
});
```

#### **provision.ts** (157 lines)
**Role:** Pod-side CLI to request provisioning from orchestrator at startup

**Usage:**
```bash
gwa-provision --project gwa --orchestrator http://gwa-orchestrator:3001 --api-key <API_KEY>
```

**Flow:**
1. POST to `/projects/:id/provision` with podName, currentBundleId
2. Parses response: status = "current" | "provisioned" | "no_credentials"
3. If "provisioned": downloads tar.gz from MinIO, extracts to ~/.claude and ~/.config/claude
4. Gracefully exits (0) on all failures — never blocks pod startup
5. Called from entrypoint.sh at pod initialization

---

### 4. Dialog Handling (`src/lib/dialog-handler.ts`) (330 lines)

**Role:** Auto-dismiss interactive permission dialogs preventing Claude headless startup

**Problem:** Claude Code CLI may show permission prompts like "Trust this project?" even when pre-authenticated, blocking REPL from starting.

**Solution:** Haiku-powered dialog detection and auto-dismiss

**Key Components:**

```typescript
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_ATTEMPTS = 3;
const MAX_KEYS = 10;

// Fast path: patterns that can be dismissed without API call
const KNOWN_DIALOGS: Array<{
  pattern: RegExp;
  keys: string[];
  reason: string;
}> = [
  {
    pattern: /bypass permissions/i,
    keys: ["Enter"],
    reason: "Accepting bypass permissions dialog",
  },
  {
    pattern: /trust this project/i,
    keys: ["Enter"],
    reason: "Trusting project directory",
  },
  {
    pattern: /Choose the text style|text style that looks best|Dark mode.*Light mode/i,
    keys: ["Enter"],
    reason: "Selecting default theme (dark mode)",
  },
];

// Main entry point
export async function handleDialogIfPresent(windowIndex: number): Promise<void>
  1. Capture tmux pane (up to 30 lines)
  2. Check if output "looks normal" (empty, shows ">" REPL prompt, or spinner)
  3. If normal → return immediately (no API call)
  4. If not normal → check KNOWN_DIALOGS patterns (fast path)
  5. If known → send keys, sleep 1s, loop
  6. If unknown → call Haiku to analyze (slower path)
  7. Haiku responds with JSON: { blocked: true/false, keys: [...], reason: "..." }
  8. Send keys, sleep, retry up to MAX_ATTEMPTS
  9. If still blocked after max attempts → throw ClaudeDialogError

// System prompt for Haiku
const SYSTEM_PROMPT = `You are monitoring a terminal where Claude Code CLI is starting up.
Check if there is an interactive dialog, prompt, or permission request
blocking Claude from running.

If blocked, respond with the tmux key sequence to accept/proceed.
Always accept permissions, agree to terms, and choose options that
let Claude Code start. Use tmux key names: Down, Up, Enter, Tab,
Space, Escape, y, n, or digits 0-9.

Respond ONLY with JSON (no markdown):
{"blocked": true, "keys": ["Down", "Enter"], "reason": "..."}
or
{"blocked": false}`
```

**Key Functions:**

```typescript
export async function handleDialogIfPresent(windowIndex: number): Promise<void>
  → Main entry point, called after Claude starts in tmux

export function parseDialogResponse(raw: string): DialogResponse
  → Parses and validates Haiku JSON
  → Filters keys to whitelist: Down, Up, Enter, Tab, Space, Escape, y, n, 0-9
  → Enforces MAX_KEYS (10) limit
  → Returns: { blocked, keys, reason }

function matchKnownDialog(paneText: string): {...} | null
  → Fast path regex matching against KNOWN_DIALOGS

function looksNormal(paneText: string): boolean
  → Heuristic to skip Haiku call
  → Checks for: empty pane, ">" REPL prompt, "Thinking" or spinner chars

async function askHaiku(paneText: string): Promise<DialogResponse>
  → Calls Claude API with SYSTEM_PROMPT + paneText
  → Returns parsed DialogResponse or { blocked: false }
```

**Error Class:**
```typescript
export class ClaudeDialogError extends Error {
  public readonly capturedOutput: string;
  constructor(message: string, capturedOutput: string)
}
```

---

### 5. Claude Subprocess (`src/lib/claude.ts`) (150+ lines shown)

**Role:** Launch Claude Code CLI in tmux and detect auth/dialog failures

**Key Features:**

```typescript
// Auth failure detection (17 patterns)
const AUTH_FAILURE_PATTERNS = [
  "choose how to authenticate",
  "sign in at",
  "/oauth/authorize",
  "enter api key",
  "login required",
  "not authenticated",
  "authentication required",
  "authenticate with",
  "sign in to",
  "oauth.anthropic.com",
  "anthropic login",
  "max plan",
  "usage limit",
  "you need to login",
  "please authenticate",
  "token revoked",
  "please run /login",
];

export function detectAuthFailure(output: string): boolean
  → Checks if any pattern present in lowercase output

export function checkAuthEnvironment(): { ok: boolean; error?: string }
  → Pre-flight check that CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY exists
  → Does NOT make API calls, only checks env vars

export class ClaudeAuthError extends Error {
  constructor(message: string)
}

export function preloadClaudeConfig(): void
  → Pre-seed ~/.claude/.credentials.json and ~/.config/claude/config.json
  → Prevents first-run interactive dialogs
  → Safe to call multiple times
  → Reads environment variables:
    - CLAUDE_CODE_OAUTH_TOKEN (for .credentials.json)
    - CLAUDE_OAUTH_ACCOUNT_UUID (optional, for .credentials.json metadata)
    - CLAUDE_OAUTH_EMAIL (optional)
    - CLAUDE_OAUTH_ORG_UUID (optional)

export function syncConfigFromCredentials(): void
  → Called on pod restart
  → Syncs ~/.config/claude/config.json from persistent ~/.claude/.credentials.json
  → Needed because ~/.config/ is ephemeral in K8s pods
```

---

### 6. Kubernetes Configuration

#### **gwa-runner-statefulset.yaml** (243 lines)

**Key Settings:**
```yaml
spec:
  serviceName: gwa-runner
  replicas: 1  # Multiple replicas supported (each with own volume)
  
  initContainers:
    - name: fix-permissions
      # Ensure PVC volumes are owned by runner user (1001)
  
  containers:
    - name: gwa-agent
      image: registry.bto.bar/jaybrto/github-workflow-agents:latest
      command: ["/bin/bash", "/scripts/entrypoint.sh"]
      
      env:
        # Orchestrator provisioning
        - name: ORCHESTRATOR_URL
          value: "http://gwa-orchestrator.default.svc:3001"
        - name: GWA_PROJECT_ID
          value: "gwa"
        - name: GWA_API_KEY
          valueFrom: secretKeyRef: gwa-secrets/orchestrator-api-key
        
        # OAuth token (fallback if orchestrator unavailable)
        - name: CLAUDE_CODE_OAUTH_TOKEN
          valueFrom: secretKeyRef: gwa-secrets/claude-oauth-token
        
        # Optional: OAuth account metadata (prevents first-run dialogs)
        - name: CLAUDE_OAUTH_ACCOUNT_UUID
          valueFrom: secretKeyRef: gwa-secrets/oauth-account-uuid (optional)
        - name: CLAUDE_OAUTH_EMAIL
          valueFrom: secretKeyRef: gwa-secrets/oauth-email (optional)
        - name: CLAUDE_OAUTH_ORG_UUID
          valueFrom: secretKeyRef: gwa-secrets/oauth-org-uuid (optional)
        
        # MinIO (for credential backup/restore)
        - name: MINIO_ENDPOINT
          value: "minio.bto.bar:9000"
        - name: MINIO_ACCESS_KEY
          valueFrom: secretKeyRef: gwa-secrets/minio-access-key
        - name: MINIO_SECRET_KEY
          valueFrom: secretKeyRef: gwa-secrets/minio-secret-key
        - name: MINIO_BUCKET
          value: "gwa-recordings"
        
        # Pod name (for credential backup path)
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
      
      volumeMounts:
        - name: claude-session          # ~/.claude (credentials, databases)
          mountPath: /home/runner/.claude
        - name: worktrees               # Git worktrees
          mountPath: /home/runner/worktrees
        - name: repo                    # Cloned repo
          mountPath: /home/runner/repo
        - name: init-script             # entrypoint.sh from ConfigMap
          mountPath: /scripts/entrypoint.sh
  
  volumeClaimTemplates:
    - metadata:
        name: claude-session
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: longhorn-claude
        resources:
          requests:
            storage: 10Gi
    - metadata:
        name: worktrees
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: longhorn-claude
        resources:
          requests:
            storage: 30Gi
```

#### **gwa-runner-configmap.yaml** (entrypoint.sh) (135 lines)

**Startup Sequence:**
```bash
#!/bin/bash
set -e

# 1. Security: Validate REPO format
if [[ ! "${REPO}" =~ ^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$ ]]; then
  echo "[GWA] ERROR: Invalid REPO format"
  exit 1
fi

# 2. Git setup
git config --global --add safe.directory /home/runner/repo
if [ -n "${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git 2>/dev/null || true
fi

# 3. Clone repo (or fetch latest)
if [ ! -d /home/runner/repo/.git ]; then
  git clone "https://github.com/${REPO}.git" /home/runner/repo
else
  git -C /home/runner/repo fetch --all --prune
fi

# 4. Initialize SQLite database
if [ -f "${SCHEMA_PATH}" ] && [ ! -f "${DB_PATH}" ]; then
  sqlite3 "${DB_PATH}" < "${SCHEMA_PATH}"
fi

# 5. MAIN: Provision environment from orchestrator
echo "[GWA] Provisioning environment from orchestrator..."
if command -v gwa-provision &> /dev/null; then
  gwa-provision 2>/dev/null || true  # Graceful fallback
fi

# 6. Sync Claude config from credentials (on every start, ~/ .config is ephemeral)
if [ -f "/home/runner/.claude/.credentials.json" ]; then
  echo "[GWA] Syncing Claude config from credentials..."
  node -e "
  const fs = require('fs'), path = require('path');
  const HOME = '/home/runner';
  try {
    const creds = JSON.parse(fs.readFileSync(HOME + '/.claude/.credentials.json', 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken || creds?.oauthToken;
    if (token) {
      fs.mkdirSync(HOME + '/.config/claude', {recursive:true});
      fs.writeFileSync(HOME + '/.config/claude/config.json', JSON.stringify({oauthToken: token}));
      console.log('[GWA] Synced Claude config from credentials');
    }
  } catch(e) { console.warn('[GWA] Config sync failed:', e.message); }
  " 2>/dev/null || true
fi

# 7. Recovery for interrupted sessions
if command -v gwa-recovery &> /dev/null; then
  gwa-recovery 2>/dev/null || true
fi

# 8. Initialize tmux session
if ! tmux has-session -t gwa-work 2>/dev/null; then
  tmux new-session -d -s gwa-work -x 200 -y 50 -c /home/runner/repo
  tmux rename-window -t gwa-work:0 "status"
  # Show active sessions via watch + sqlite3 query
  tmux send-keys -t gwa-work:status \
    "watch -n 5 'sqlite3 -header -column ${DB_PATH} \"SELECT id, status, github_number, tmux_window FROM sessions\"'" Enter
fi

echo "[GWA] Pod ready. Keeping alive..."
exec tail -f /dev/null
```

---

## Credential Flow: End-to-End Example

### Developer Pushes Credentials

1. Developer has authenticated locally: `claude auth login`
2. Credentials stored in `~/.claude/.credentials.json`:
   ```json
   {
     "claudeAiOauth": {
       "accessToken": "sk-ant-...",
       "refreshToken": "sk-ant-refresh-...",
       "expiresAt": 1745000000000,
       "accountUuid": "...",
       "emailAddress": "user@example.com",
       "organizationUuid": "...",
       "billingType": "stripe_subscription"
     }
   }
   ```

3. Developer runs: `gwa-push-credentials --project gwa --orchestrator http://gwa-orchestrator:3001 --api-key <key>`
   - Reads local `~/.claude/.credentials.json`
   - Extracts OAuth fields
   - POST to `http://gwa-orchestrator:3001/projects/gwa/credentials`
   - Orchestrator stores in `project_credentials` table, invalidates old tokens

### Orchestrator Generates Bundle

1. Background timer checks every 30 min for expiring credentials (< 60 min)
2. If credential expiring: `tryRefreshCredential()` calls Claude OAuth endpoint with refresh_token
3. New bundle generated:
   - tar.gz containing:
     - `.claude/.credentials.json` (all OAuth fields)
     - `.config/claude/config.json` ({ oauthToken: accessToken })
     - `.claude.json` (optional TUI settings)
     - `.claude/settings.json` (optional)
   - Uploaded to MinIO: `env-bundles/gwa/<uuid>.tar.gz`
   - Metadata stored in `environment_bundles` table

### Pod Starts

1. K8s creates StatefulSet pod, mounts PVCs for `~/.claude/`, `/worktrees/`, `/repo/`
2. entrypoint.sh runs:
   - Clones repo
   - **Calls `gwa-provision`**: POST to orchestrator `/projects/gwa/provision` with podName
   - Orchestrator checks: is bundle current? → returns S3 key
   - **`gwa-provision` downloads** tar.gz from MinIO → extracts to `~/.claude/` + `~/.config/claude/`
   - Config sync node script reads `~/.claude/.credentials.json` → writes `~/.config/claude/config.json`
   - Initializes tmux session
3. **Pod ready**

### Claude Session Starts

1. Orchestrator dispatches task: `gwa-start-planning --issue 42 --pod-name gwa-runner-0`
2. Command runs inside pod, launches Claude in tmux window:
   - Sets env: `CLAUDE_CODE_OAUTH_TOKEN=<token>` via `tmux set-environment`
   - Starts Claude REPL: `claude` in new tmux window
3. Claude reads auth from:
   - `CLAUDE_CODE_OAUTH_TOKEN` env var (set in tmux) OR
   - `~/.config/claude/config.json` ({ oauthToken: ... })
4. **Dialog handler** monitors tmux pane:
   - Waits 3 seconds
   - Captures pane output
   - Checks for permission dialogs
   - Auto-dismisses with key sequences
5. **Claude REPL ready** → waiting for input
6. Session completes → credentials backed up to MinIO: `claude-auth/pods/gwa-runner-0/credentials.tar.gz`

### Pod Dies and Restarts

1. Pod is rescheduled (rolling update, crash, etc.)
2. New entrypoint.sh runs, orchestrator unreachable
3. **`gwa-provision` falls back** (10s timeout):
   - Tries `restoreCredentialsIfMissing()` from MinIO
   - Looks for own pod backup first, then other pods, then legacy backup
   - Restores `~/.claude/.credentials.json`
4. Config sync recreates `~/.config/claude/config.json` from persistent file
5. Pod continues operating with restored credentials

---

## Security Measures

### 1. Credential Storage

- **Access Token** stored in `~/.claude/.credentials.json` (persistent PVC, readable by runner user only)
- **Refresh Token** stored alongside access token (allows auto-refresh without human login)
- **Expiry Check** before every Claude invocation (5-minute buffer before actual expiry)
- **Env Vars** whitelisted: only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` passed to subprocess

### 2. Credential Backup

- Credentials backed up to MinIO only if **not expired**
- Pod-specific paths prevent overwriting with stale backups
- Legacy fallback ensures backwards compatibility

### 3. API Authentication

- All orchestrator endpoints require `Authorization: Bearer <GWA_API_KEY>`
- Timing-safe HMAC comparison in webhook verification
- API key stored in K8s Secret, injected as env var

### 4. Input Validation

- REPO format validated: `^[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+$`
- POD_NAME validated: `^[a-zA-Z0-9-]+$`
- SQL injection prevented: parameterized queries throughout
- Shell injection prevented: temp file approach for user content

### 5. Dialog Handling

- Whitelist of allowed tmux keys (no arbitrary shell commands)
- Max key sequences enforced (10 keys max)
- Haiku response parsed as JSON, fields validated
- Unknown key names filtered out

### 6. OAuth Flow

- Claude OAuth client ID public (non-sensitive)
- Refresh token exchange via HTTPS only
- Expired credentials never backed up to MinIO
- Old credentials invalidated when new ones pushed

---

## Environment Variables (Pod)

### From K8s Secrets

```bash
CLAUDE_CODE_OAUTH_TOKEN          # OAuth access token (fallback if orchestrator unavailable)
GWA_API_KEY                      # Orchestrator API key
GITHUB_TOKEN                     # GitHub API token
MINIO_ACCESS_KEY                 # MinIO S3 credentials
MINIO_SECRET_KEY
CLAUDE_OAUTH_ACCOUNT_UUID        # Optional: prevents first-run dialogs
CLAUDE_OAUTH_EMAIL               # Optional
CLAUDE_OAUTH_ORG_UUID            # Optional
RABBITMQ_URL                     # RabbitMQ AMQP connection string (optional)
```

### From StatefulSet Config

```bash
ORCHESTRATOR_URL=http://gwa-orchestrator.default.svc:3001
GWA_PROJECT_ID=gwa
MINIO_ENDPOINT=minio.bto.bar:9000
MINIO_BUCKET=gwa-recordings
POD_NAME=gwa-runner-0              # From metadata.name downward API
REPO=jaybrto/github-workflow-agents
DB_PATH=/home/runner/.claude/gwa.db
SCHEMA_PATH=/home/runner/.claude/schema.sql
```

---

## API Endpoints Reference

### Credential Management (Orchestrator)

#### `POST /projects`
Create a new project
```bash
curl -X POST http://gwa-orchestrator:3001/projects \
  -H "Authorization: Bearer $GWA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-project",
    "displayName": "My Project",
    "claudeAccountUuid": "...",
    "claudeEmail": "user@example.com"
  }'
```

#### `POST /projects/:id/credentials`
Push OAuth credentials
```bash
curl -X POST http://gwa-orchestrator:3001/projects/gwa/credentials \
  -H "Authorization: Bearer $GWA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Pushed-By: jay.barreto" \
  -d '{
    "accessToken": "sk-ant-...",
    "refreshToken": "sk-ant-refresh-...",
    "expiresAt": 1745000000000,
    "accountUuid": "...",
    "emailAddress": "user@example.com",
    "organizationUuid": "...",
    "billingType": "stripe_subscription"
  }'
```

#### `POST /projects/:id/provision` (Pod-side)
Request environment bundle
```bash
curl -X POST http://gwa-orchestrator:3001/projects/gwa/provision \
  -H "Authorization: Bearer $GWA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "podName": "gwa-runner-0",
    "currentBundleId": "previous-bundle-uuid"
  }'

# Response
{
  "status": "provisioned",
  "bundleId": "new-bundle-uuid",
  "s3Key": "env-bundles/gwa/new-bundle-uuid.tar.gz",
  "s3Bucket": "gwa-recordings",
  "credentialExpiresAt": 1745000000000
}
```

#### `POST /projects/:id/refresh`
Force OAuth refresh
```bash
curl -X POST http://gwa-orchestrator:3001/projects/gwa/refresh \
  -H "Authorization: Bearer $GWA_API_KEY"
```

#### `GET /projects/:id/health`
Check credential health
```bash
curl http://gwa-orchestrator:3001/projects/gwa/health \
  -H "Authorization: Bearer $GWA_API_KEY"

# Response
{
  "projectId": "gwa",
  "hasValidCredential": true,
  "expiresAt": 1745000000000,
  "expiresInMs": 86400000,
  "hasRefreshToken": true,
  "lastRefreshAt": 1744000000000,
  "activeBundleId": "current-uuid"
}
```

---

## Reusability for mesh-six

### What mesh-six Can Adopt

1. **EnvironmentProvisioner pattern** — Same credential management for mesh-six agents
   - Store project configs + credentials in orchestrator DB
   - Generate versioned bundles for each agent type
   - Proactive OAuth refresh with timer
   - Push notifications on auth failures

2. **Credential Backup/Restore** — Pod disaster recovery
   - MinIO-based backup with pod-specific fallback
   - Automatic sync from persistent to ephemeral config
   - Works across pod restarts and rescheduling

3. **Dialog Handler** — Interactive dialog auto-dismissal
   - Haiku-powered analysis (or swap for any Claude model)
   - Known patterns fast path
   - Whitelist of allowed keys
   - Max retry logic

4. **Pre-seeding** — Prevent first-run dialogs
   - Environment variables for account metadata
   - ~/.config/claude/config.json generation
   - Run on every pod start (ephemeral mount handling)

### What mesh-six Would Need to Adapt

1. **API Service Design**
   - mesh-six might use different auth mechanism (K8s RBAC, mTLS, etc.)
   - Could adapt environment-provisioner as a standalone service or sidecar

2. **Storage**
   - mesh-six has PostgreSQL + pgvector (not SQLite)
   - Could move project/credential/bundle tables to PostgreSQL
   - MinIO S3 storage can be shared (different bucket prefix)

3. **Dapr Integration**
   - GWA uses RabbitMQ AMQP directly
   - mesh-six could emit events via Dapr pub/sub for credential changes
   - Alert agents when new credentials provisioned

4. **Claude Authentication**
   - GWA uses OAuth access token + refresh token
   - mesh-six could use same pattern or adopt Anthropic API key flow
   - Dialog handler is LLM-agnostic (just needs tmux + Claude)

---

## File Manifest

### Core Credential/Auth Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/orchestrator/environment-provisioner.ts` | 503 | Credential lifecycle, OAuth refresh, bundle generation |
| `src/orchestrator/rest-api.ts` | 243 | HTTP endpoints for provisioning and management |
| `src/lib/credentials-manager.ts` | 468 | Pod-side credential provisioning, restoration, backup |
| `src/lib/dialog-handler.ts` | 330 | Haiku-powered interactive dialog detection & dismissal |
| `src/lib/claude.ts` | 150+ | Auth failure detection, config pre-loading |
| `src/provision.ts` | 157 | CLI tool: request bundle from orchestrator |
| `src/push-credentials.ts` | 140 | CLI tool: push credentials to orchestrator |
| `k8s/gwa-runner-statefulset.yaml` | 243 | K8s pod config, env vars, secrets, storage |
| `k8s/gwa-runner-configmap.yaml` | 135 | Entrypoint script with provisioning flow |
| `src/shared/types.ts` | 188 | ProvisionResponse, CredentialHealth, etc. |

### Supporting Infrastructure

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage: build CLI tools in Bun, runtime with Node.js + Claude CLI |
| `.github/workflows/` | CI/CD: builds container, tests auth flow |
| `schema.sql` | SQLite schema for projects, credentials, bundles, sessions |

---

## Known Limitations & Future Improvements

### Current

- **Single orchestrator instance** — no HA yet
- **Redis removal planned** — moving to pure PostgreSQL + RabbitMQ
- **Manual credential push** — developers must run `gwa-push-credentials`
- **Dialog handler Haiku calls** — costs API credits on every complex dialog

### Potential Enhancements

1. **Orchestrator HA** — Multi-instance with shared DB
2. **OAuth Consent Screen** — Automated first-time Claude auth via browser
3. **Credential Expiry Dashboard** — Monitor all projects' token expiry
4. **Cost Optimization** — Cache Haiku dialog detection results
5. **Multi-Account Support** — One orchestrator for multiple Claude accounts
6. **OIDC/SAML** — Centralized identity provider for credentials

---

## Conclusion

GWA's Claude CLI authentication system is **production-ready** and handles:

- **Secure credential storage** in K8s Secrets and persistent PVCs
- **Automated provisioning** via REST API with MinIO backup
- **Resilience** with graceful fallbacks and disaster recovery
- **User experience** with dialog auto-dismissal and pre-seeding
- **Observability** with auth failure detection and push notifications

The architecture is **reusable** for mesh-six with minimal adaptation:

1. Adopt environment-provisioner for credential management
2. Move credential storage to PostgreSQL (vs. SQLite)
3. Extend dialog handler for other LLM tools
4. Integrate with Dapr for event publishing

**Key Files to Review:**
- `src/orchestrator/environment-provisioner.ts` — core logic
- `src/lib/credentials-manager.ts` — pod-side provisioning
- `k8s/gwa-runner-configmap.yaml` — startup sequence
- `src/lib/dialog-handler.ts` — interactive handling

