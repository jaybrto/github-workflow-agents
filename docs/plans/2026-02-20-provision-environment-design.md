# Provision Environment Design

## Problem

After pod restarts or credential expiry, Claude Code TUI may get stuck on the OAuth browser flow. Currently this requires manual debugging. We need a streamlined workflow where:

1. An operator triggers provisioning
2. If auth is needed, the OAuth URL is pushed to ntfy.sh
3. The operator completes auth in their browser
4. The operator signals completion via REST API
5. The environment is bundled and uploaded to MinIO
6. Running pods with stuck auth are refreshed automatically

## Three-Phase Architecture

### Phase 1: Start (`--phase start`)

Creates a Claude TUI session for authentication.

**Triggers:**
- `POST /provision-environment/start` on the orchestrator
- `gh workflow run project-sync.yml -f handler=provision-environment`

**Flow:**
1. Create tmux window `provision-auth` on the target pod
2. Export `CLAUDE_CODE_OAUTH_TOKEN` from disk/env
3. Launch `claude --dangerously-skip-permissions`
4. Wait 5s for initialization
5. Capture pane, check `detectAuthFailure()`
6. If auth screen detected:
   - Extract OAuth URL from pane text (regex for `https://claude.ai/oauth/authorize...`)
   - Send ntfy.sh notification (priority: high) with:
     - OAuth URL (clickable)
     - `kubectl exec -it <pod> -- tmux attach -t gwa-work:<window>` command
   - Store provisioning session in SQLite (`provision_sessions` table)
   - Set status to `waiting_for_auth`
7. If no auth screen (Claude started fine):
   - Proceed directly to bundling (skip waiting for human)
   - Exit Claude, bundle, upload

**Binary:** `gwa-provision-environment --phase start [--pod gwa-runner-0]`

### Phase 2: Complete (`--phase complete`)

Called by the operator after authenticating in the browser.

**Trigger:** `POST /provision-environment/complete` on the orchestrator

**Flow:**
1. Load provision session from SQLite
2. Verify tmux window still exists
3. Capture pane — confirm Claude is authenticated (no auth failure patterns)
4. Exit Claude gracefully (Escape + `/exit`)
5. Wait for Claude to exit
6. Tar environment files:
   - `~/.claude/.credentials.json`
   - `~/.claude.json`
   - `~/.config/claude/config.json`
7. Upload tar.gz to MinIO: `claude-auth/bundles/<timestamp>/env-bundle.tar.gz`
8. Also update pod-specific backup: `claude-auth/pods/<pod>/credentials.tar.gz`
9. Update orchestrator project credentials via `POST /projects/:id/credentials`
10. Kill the provisioning tmux window
11. Clean up provision session record
12. Send ntfy.sh notification: "Environment bundle ready"
13. Return list of runner pods for optional refresh

**Binary:** `gwa-provision-environment --phase complete`

### Phase 3: Refresh (`--phase refresh`)

Pushes fresh credentials to a running pod and restarts any stuck Claude sessions.

**Trigger:** `POST /provision-environment/refresh` on the orchestrator (called per pod)

**Flow:**
1. Call `provisionFromOrchestrator()` to pull the fresh bundle to disk
2. Call `preloadClaudeConfig()` + `syncConfigFromCredentials()`
3. Update tmux session-level env: `tmux.setEnvironment("CLAUDE_CODE_OAUTH_TOKEN", freshToken)`
4. List all tmux windows via `tmux list-windows`
5. For each window (skip window 0 "status"):
   - Capture pane text
   - Run `detectAuthFailure(paneText)`
   - If stuck on auth:
     - Log: "Refreshing stuck window N"
     - Send Ctrl-C twice to kill Claude
     - Wait 1s
     - Export fresh token to window
     - Relaunch `claude --dangerously-skip-permissions`
     - Wait 3s, run `handleDialogIfPresent()`
   - If not stuck: skip (zero disruption)
6. Send ntfy.sh notification: "Pod <name> refreshed, N windows restarted"

**Binary:** `gwa-provision-environment --phase refresh [--pod gwa-runner-0]`

## Orchestrator REST Endpoints

```
POST /provision-environment/start
  Body: { podName?: string }
  Response: { sessionId, status, tmuxWindow, kubectlCommand }

POST /provision-environment/complete
  Body: { sessionId }
  Response: { bundleId, s3Key, runnerPods: string[] }

POST /provision-environment/refresh
  Body: { podName: string }
  Response: { refreshed: boolean, windowsRestarted: number }

GET /provision-environment/status
  Response: { status: 'idle' | 'waiting_for_auth' | 'bundling' | 'complete', oauthUrl?, kubectlCommand? }
```

## GitHub Workflow Handler

Added to `project-sync.yml`:

```yaml
- name: "Handler: provision-environment"
  if: github.event.inputs.handler == 'provision-environment'
  run: |
    kubectl exec "$POD" -- "$GWA_BIN/gwa-provision-environment" \
      --phase start \
      --pod "$POD"
```

## SQLite Schema

```sql
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
```

## ntfy.sh Notifications

**Auth needed (priority: high):**
```
Title: Claude Auth Required
Tags: lock, warning
Body:
Claude needs re-authentication on pod gwa-runner-0.

OAuth URL: https://claude.ai/oauth/authorize?...

Attach: kubectl exec -it gwa-runner-0 -- tmux attach -t gwa-work:6

After authenticating, call:
POST /provision-environment/complete
```

**Bundle ready (priority: default):**
```
Title: Environment Bundle Ready
Tags: package, white_check_mark
Body:
Fresh credentials bundled and uploaded to MinIO.
Bundle: claude-auth/bundles/2026-02-20T19:00:00Z/env-bundle.tar.gz

To refresh running pods:
POST /provision-environment/refresh { podName: "gwa-runner-0" }
```

## Bundle Contents

```
env-bundle.tar.gz
  .claude/.credentials.json    # OAuth tokens (access + refresh)
  .claude.json                 # TUI settings/preferences
  .config/claude/config.json   # Headless mode config
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/transitions/provision-environment.ts` | New — CLI binary with 3 phases |
| `src/orchestrator/rest-api.ts` | Modify — add 4 REST endpoints |
| `.github/workflows/project-sync.yml` | Modify — add handler step |
| `src/shared/types.ts` | Modify — add ProvisionSession type |
| `package.json` | Modify — add build script, bump version |
| `CHANGELOG.md` | Modify — document feature |
