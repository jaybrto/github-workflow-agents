# Setup Claude Auth Skill Design

## Problem

The current `setup-claude-auth` is a slash command (`~/.claude-jay.barreto/commands/setup-claude-auth.md`) written before the provision-environment system existed. It covers config pre-seeding and dialog handling but lacks:

1. **GWA orchestrator integration** — how to call `POST /projects/:id/provision` and `POST /provision-environment/*` to get credentials
2. **Bundle download/extraction** — how to pull tar.gz from MinIO and extract
3. **TUI warmup quirk** — the first Claude TUI after pod restart always triggers OAuth regardless of valid credentials
4. **Native credential format** — Claude Code now uses `claudeAiOauth.accessToken` + `expiresAt` instead of flat `oauthToken`
5. **Cross-workload credential sharing** — how other K3s services can consume GWA-managed credentials

Converting to a full skill with supporting docs addresses all of these.

## Audience

Primary: Jay's own future K3s workloads that need working Claude Code credentials. The integration docs show how to call GWA orchestrator REST API and download credential bundles from MinIO.

## Skill Structure

```
~/.claude-jay.barreto/skills/setup-claude-auth/
  SKILL.md              # Main entry point — checklist-driven, two paths
  reference.md          # Deep reference: credential formats, auth flow, known dialogs,
                        #   TUI warmup quirk, dialog handler architecture
  integration.md        # GWA orchestrator API for credential consumers:
                        #   provision API, provision-environment endpoints, bundle format,
                        #   MinIO direct download, required env vars
  templates/
    preload-claude-config.ts   # Drop-in TypeScript function
    preload-claude-config.sh   # Drop-in shell script
```

## SKILL.md Design

### Frontmatter

```yaml
name: setup-claude-auth
description: Setup Claude Code CLI authentication, dialog handling, and config pre-seeding for headless/automated environments. Apply to any project using Claude SDK or headless CLI. Also covers consuming credentials from GWA orchestrator for K3s workloads.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
```

### Trigger Conditions

- Project needs headless/automated Claude Code CLI
- Setting up K8s pods, Docker containers, or CI that runs Claude
- Debugging "stuck on OAuth" or "auth dialog" issues in Claude TUI
- New K3s workload needs to consume Claude credentials from GWA orchestrator
- Mention of Claude auth, credential provisioning, or environment bundling

### Two Paths

**Path detection:** Check for `ORCHESTRATOR_URL` / `GWA_PROJECT_ID` / `GWA_API_KEY` env vars, or ask user if project has access to GWA orchestrator.

**Path A — GWA-Integrated:**
1. Add env vars: `ORCHESTRATOR_URL`, `GWA_PROJECT_ID`, `GWA_API_KEY`, `MINIO_*`
2. Import and call `provisionFromOrchestrator()` at startup (or copy the pattern)
3. Extract bundle to `$HOME` — contains `.claude/.credentials.json`, `.claude.json`, `.config/claude/config.json`
4. Call `preloadClaudeConfig()` to fill headless settings
5. If using tmux: set session-level `CLAUDE_CODE_OAUTH_TOKEN` and add dialog handler
6. Refer to `integration.md` for full API reference

**Path B — Greenfield (no GWA):**
1. Set `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` as env var
2. Drop in `preload-claude-config.ts` or `.sh` template
3. Pre-seed `~/.claude/settings.json` with headless defaults
4. If using tmux: add dialog handler (pattern matching + Haiku fallback)
5. If using K8s: wire up Vault + External Secrets Operator
6. Verify: start Claude, confirm no interactive prompts

### Verification Checklist

- Claude starts without permission prompt
- No theme selection dialog
- No onboarding wizard
- No "Select login method" dialog
- Token is not expired (`isCredentialExpired()` returns false)

### Troubleshooting Section

- **TUI warmup quirk:** First Claude TUI after pod restart triggers OAuth. Fix: run throwaway warmup instance first.
- **Auth failure patterns:** List of regex patterns from `detectAuthFailure()`.
- **"Browser didn't open" dialog:** Must dismiss with Escape BEFORE checking `detectAuthFailure()`.

## reference.md Design

Contains deep technical details pulled from the current slash command plus new learnings:

1. **How Claude Code CLI Auth Works** — env var priority, credential file locations
2. **Credential File Formats:**
   - Native format: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt } }`
   - Legacy format: `{ oauthToken, oauthAccount: { ... } }`
   - The CLI reads both; `getAccessToken()` checks native first, falls back to legacy
3. **Config Files:** `~/.claude/.credentials.json`, `~/.claude/settings.json`, `~/.claude.json`, `~/.config/claude/config.json`
4. **Known Interactive Dialogs** — table with trigger, prevention, runtime fallback
5. **Auth Failure Detection Patterns** — full regex list
6. **Dialog Handler Architecture** — 4-layer approach diagram (config pre-seed → pattern matching → Haiku analysis → error notification)
7. **Haiku Dialog Detection Prompt** — the exact system/user prompt
8. **TUI Warmup Quirk** — why it happens, the throwaway-instance fix
9. **Credential Expiry Checking** — `isCredentialExpired()` with 5-minute buffer
10. **Environment Variables Reference** — complete table

## integration.md Design

API reference for K3s workloads that consume GWA-managed credentials:

1. **Overview** — GWA orchestrator manages Claude credentials centrally; other workloads can request fresh credentials via REST API or download bundles directly from MinIO.

2. **Orchestrator Provision API:**
   ```
   POST /projects/:id/provision
   Headers: Authorization: Bearer <GWA_API_KEY>
   Body: { podName: string, currentBundleId?: string }
   Response: { status: "provisioned"|"current"|"no_credentials", s3Key?, bundleId?, s3Bucket? }
   ```

3. **Provision Environment Workflow:**
   ```
   POST /provision-environment/start   { podName?: string }
   POST /provision-environment/complete { sessionId?, podName? }
   POST /provision-environment/refresh  { podName: string }
   GET  /provision-environment/status
   ```
   All require `X-API-Key` header.

4. **Bundle Format:**
   ```
   env-bundle.tar.gz
     .claude/.credentials.json    # OAuth tokens
     .claude.json                 # TUI settings
     .config/claude/config.json   # Headless mode config
   ```

5. **MinIO Direct Download:**
   - Bundle keys: `claude-auth/bundles/<timestamp>/env-bundle.tar.gz`
   - Pod backup keys: `claude-auth/pods/<pod-name>/credentials.tar.gz`
   - Use `@aws-sdk/client-s3` with `forcePathStyle: true`

6. **Required Environment Variables:**
   | Var | Purpose |
   |-----|---------|
   | `ORCHESTRATOR_URL` | GWA orchestrator base URL |
   | `GWA_PROJECT_ID` | Project ID for provision endpoint |
   | `GWA_API_KEY` | API key for orchestrator auth |
   | `MINIO_ENDPOINT` | MinIO host:port |
   | `MINIO_ACCESS_KEY` | MinIO access key |
   | `MINIO_SECRET_KEY` | MinIO secret key |
   | `MINIO_BUCKET` | Bucket name (default: `gwa-recordings`) |

7. **Example: Add Credential Provisioning to a New Workload** — complete TypeScript code block showing how to call the provision API and extract the bundle.

## templates/ Design

### preload-claude-config.ts

The TypeScript function from the current slash command, updated to handle the native credential format (`claudeAiOauth.accessToken`) alongside the legacy format.

### preload-claude-config.sh

The shell script from the current slash command, unchanged.

## Migration

After the skill is created and verified:
1. Delete `~/.claude-jay.barreto/commands/setup-claude-auth.md`
2. The skill auto-triggers based on its description and is also invocable as `/setup-claude-auth`

## Files to Create

| File | Description |
|------|-------------|
| `~/.claude-jay.barreto/skills/setup-claude-auth/SKILL.md` | Main skill entry point |
| `~/.claude-jay.barreto/skills/setup-claude-auth/reference.md` | Auth internals reference |
| `~/.claude-jay.barreto/skills/setup-claude-auth/integration.md` | GWA API reference for consumers |
| `~/.claude-jay.barreto/skills/setup-claude-auth/templates/preload-claude-config.ts` | TypeScript template |
| `~/.claude-jay.barreto/skills/setup-claude-auth/templates/preload-claude-config.sh` | Shell script template |

## File to Delete

| File | Reason |
|------|--------|
| `~/.claude-jay.barreto/commands/setup-claude-auth.md` | Replaced by skill |
