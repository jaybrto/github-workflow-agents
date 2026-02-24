# GitHub Workflow Agents: Claude CLI Authentication Exploration Results

## Overview

This directory now contains a comprehensive architectural analysis of how GWA handles Claude Code CLI authentication, credential generation, and settings file management for running Claude in action runner pods.

**Location:** `/Users/jay.barreto/dev/util/bto/github-workflow-agents/`

---

## Main Deliverable

### GWA_AUTH_ARCHITECTURE.md (1,014 lines)

Complete architectural reference document covering:

1. **Executive Summary** — Core capabilities and production-readiness statement
2. **Architecture Overview** — Visual flow diagrams (6-stage credential pipeline)
3. **Key Components & File Locations** — Detailed breakdown of:
   - Orchestrator service (environment-provisioner.ts, rest-api.ts)
   - Credential manager (credentials-manager.ts)
   - Dialog handler (dialog-handler.ts)
   - Claude subprocess (claude.ts)
   - CLI tools (provision.ts, push-credentials.ts)
   - Kubernetes configuration (StatefulSet, ConfigMap)
4. **Database Schema** — projects, project_credentials, environment_bundles tables
5. **Credential Flow: End-to-End** — 6-step example from developer to Claude REPL
6. **Security Measures** — 6 layers of protection (credential storage, API auth, backup safety, input validation, dialog handling, OAuth flow)
7. **MinIO S3 Storage Layout** — Bucket structure with pod-specific + legacy fallback paths
8. **Environment Variables Reference** — All K8s secrets and ConfigMap values
9. **API Endpoints Reference** — All 8 credential/provisioning REST endpoints with curl examples
10. **Reusability for mesh-six** — What to adopt directly vs. what needs adaptation
11. **Known Limitations & Future Improvements**
12. **File Manifest** — Complete file listing with line counts and purposes

---

## Quick Navigation

### By Role

**Infrastructure/Kubernetes:**
- `k8s/gwa-runner-statefulset.yaml` — Pod definition with PVCs, env vars, secrets
- `k8s/gwa-runner-configmap.yaml` — Startup entrypoint script (135 lines)
- `Dockerfile` — Multi-stage build: Bun CLI + Node.js + Claude CLI

**API Service (Orchestrator):**
- `src/orchestrator/environment-provisioner.ts` — Credential lifecycle, OAuth refresh, bundle generation (503 lines)
- `src/orchestrator/rest-api.ts` — HTTP endpoints for credential management (243 lines)

**Pod-Side (Credential Provisioning):**
- `src/lib/credentials-manager.ts` — Fetch, restore, backup credentials; sync config (468 lines)
- `src/provision.ts` — CLI tool: request bundle from orchestrator (157 lines)

**Interactive Dialog Handling:**
- `src/lib/dialog-handler.ts` — Haiku-powered auto-dismiss (330 lines)
- `src/lib/claude.ts` — Auth failure detection, config pre-loading (150+ lines)

**Credential Management CLI:**
- `src/push-credentials.ts` — Manual credential push from dev machine (140 lines)

**Shared Types:**
- `src/shared/types.ts` — ProvisionResponse, CredentialPushRequest, etc. (188 lines)

---

## Key Findings Summary

### 1. Orchestrator Service

**What:** Bun-based HTTP service on port 3001 that manages credential lifecycle

**How:** 
- Receives OAuth tokens via `POST /projects/:id/credentials`
- Generates tar.gz bundles containing `.credentials.json` + `.config/claude/config.json`
- Stores bundles in MinIO S3: `env-bundles/<project>/<uuid>.tar.gz`
- Periodically refreshes expiring tokens using refresh_token
- Proactively checks every 30 minutes for expiring credentials (< 60 min window)

**Key Endpoints:**
- `POST /projects/:id/credentials` — Push OAuth token
- `POST /projects/:id/provision` — Request bundle (main pod endpoint)
- `POST /projects/:id/refresh` — Force OAuth refresh
- `GET /projects/:id/health` — Credential health status

### 2. Pod Startup Flow

**entrypoint.sh sequence:**
1. Security validation (REPO format, POD_NAME format)
2. Git setup (clone repo, GitHub CLI auth)
3. SQLite database initialization
4. **Provision from orchestrator** (calls `gwa-provision`)
5. Sync Claude config from credentials (Node.js script)
6. Session recovery for interrupted sessions
7. tmux session initialization

### 3. Credential Provisioning (Pod-Side)

**gwa-provision** requests bundle from orchestrator:
1. `POST /projects/:id/provision` with podName
2. Orchestrator checks: is bundle current? → returns S3 key
3. `gwa-provision` downloads tar.gz from MinIO
4. Extracts to `~/.claude/` + `~/.config/claude/`
5. Graceful fallback if orchestrator unreachable (10s timeout)

**Fallback path** (orchestrator unavailable):
- Try restore from MinIO: `restoreCredentialsIfMissing()`
- Order: own pod backup → other pods → legacy backup
- Pod continues with restored credentials

### 4. Interactive Dialog Handling

**Problem:** Claude Code may show permission dialogs despite auth, blocking REPL

**Solution:** Haiku-powered dialog detection + auto-dismiss
- Fast path: 3 known patterns (bypass permissions, trust project, theme)
- Slow path: Haiku API for unknown dialogs
- Key whitelist: Enter, Tab, Space, Up/Down, y, n, 0-9
- Max 3 retry attempts with 1s wait between

### 5. Security Layers

| Layer | Implementation |
|-------|-----------------|
| **Credential Storage** | Persistent PVC (readable by user 1001 only) + expiry check (5-min buffer) |
| **API Auth** | Bearer token required on all orchestrator endpoints |
| **Backup Safety** | Never backup if expired; post-restore expiry validation |
| **Input Validation** | REPO + POD_NAME regex; parameterized SQL queries |
| **Dialog Handling** | Whitelist of 10 tmux keys; JSON parsing + field validation |
| **OAuth Flow** | Refresh token via HTTPS; expired credentials never used |

---

## For mesh-six Integration

### What to Adopt Directly

1. **EnvironmentProvisioner pattern** (src/orchestrator/environment-provisioner.ts)
   - Credential lifecycle management
   - Proactive OAuth refresh with background timer
   - Versioned bundle generation
   - Health status endpoints

2. **Credential Backup/Restore** (src/lib/credentials-manager.ts)
   - Pod-specific S3 paths + legacy fallback
   - Expiry checking (5-minute buffer)
   - Automatic sync to ephemeral config

3. **Dialog Handler** (src/lib/dialog-handler.ts)
   - Haiku-powered analysis
   - Fast path for known patterns
   - Whitelist of safe key sequences
   - Retry logic (3 attempts, 1s wait)

4. **Pre-seeding** (src/lib/claude.ts)
   - Environment variables for auth metadata
   - Config file generation on every pod start
   - Prevents first-run dialogs

### What Needs Adaptation

1. **Storage Backend**
   - GWA: SQLite in orchestrator
   - mesh-six: Use PostgreSQL (already exists)
   - MinIO bucket can be shared (use different prefix)

2. **API Service Design**
   - GWA: REST + Bearer token auth
   - mesh-six: Could use K8s RBAC or mTLS
   - Or adapt as sidecar vs. central service

3. **Event Publishing**
   - GWA: RabbitMQ AMQP direct
   - mesh-six: Dapr pub/sub for credential refresh events

4. **Model Selection**
   - GWA: Haiku (cheap API calls)
   - mesh-six: Could use Sonnet/Opus or cache results

---

## Credential Flow: Key Points

```
Developer
  ↓ (gwa-push-credentials)
Orchestrator (REST API)
  ↓ (stores in DB, generates bundle)
MinIO S3
  ↓ (tar.gz download on pod startup)
Pod (~/.claude + ~/.config/claude)
  ↓ (tmux + Claude CLI)
Claude REPL
  ↓ (periodic backup on session complete)
MinIO S3 (pod-specific fallback)
```

**Key Properties:**
- Credentials backed up with pod-specific paths (pod disaster recovery)
- Refresh token valid across all pods (any pod can restore from any backup)
- Expiry checked before every Claude invocation (5-min buffer)
- Config synced on every pod start (handles ephemeral mount)

---

## Files Mentioned in Architecture

**Orchestrator Service**
- `src/orchestrator/environment-provisioner.ts` (503 lines)
- `src/orchestrator/rest-api.ts` (243 lines)
- `src/orchestrator/index.ts` (main service entry)

**Pod-Side Credential Management**
- `src/lib/credentials-manager.ts` (468 lines)
- `src/provision.ts` (157 lines, CLI tool)
- `src/push-credentials.ts` (140 lines, CLI tool)

**Interactive Dialog Handling**
- `src/lib/dialog-handler.ts` (330 lines)
- `src/lib/claude.ts` (150+ lines)

**Kubernetes Configuration**
- `k8s/gwa-runner-statefulset.yaml` (243 lines)
- `k8s/gwa-runner-configmap.yaml` (135 lines)
- `Dockerfile` (98 lines, multi-stage build)

**Supporting Files**
- `src/shared/types.ts` (188 lines)
- `schema.sql` (SQLite schema)

---

## Environment Variables (Quick Reference)

### From K8s Secrets
```bash
CLAUDE_CODE_OAUTH_TOKEN          # Fallback if orchestrator unavailable
GWA_API_KEY                      # Orchestrator API key (Bearer token)
GITHUB_TOKEN                     # GitHub API token
MINIO_ACCESS_KEY                 # S3 credentials
MINIO_SECRET_KEY
CLAUDE_OAUTH_ACCOUNT_UUID        # Optional: prevents first-run dialogs
CLAUDE_OAUTH_EMAIL               # Optional
CLAUDE_OAUTH_ORG_UUID            # Optional
```

### From ConfigMap
```bash
ORCHESTRATOR_URL=http://gwa-orchestrator.default.svc:3001
GWA_PROJECT_ID=gwa
MINIO_ENDPOINT=minio.bto.bar:9000
MINIO_BUCKET=gwa-recordings
POD_NAME=gwa-runner-0            # From metadata.name downward API
REPO=jaybrto/github-workflow-agents
DB_PATH=/home/runner/.claude/gwa.db
SCHEMA_PATH=/home/runner/.claude/schema.sql
```

---

## Verification Commands

```bash
# Check pod provisioning
kubectl logs gwa-runner-0 | grep -E "Provisioning|Synced|ready"

# Check orchestrator health
curl http://gwa-orchestrator:3001/health

# Check credential health
curl http://gwa-orchestrator:3001/projects/gwa/health \
  -H "Authorization: Bearer $GWA_API_KEY"

# Manually refresh credentials
curl -X POST http://gwa-orchestrator:3001/projects/gwa/refresh \
  -H "Authorization: Bearer $GWA_API_KEY"

# List MinIO backups
aws s3 ls s3://gwa-recordings/claude-auth/pods/ \
  --endpoint-url http://minio:9000 --recursive
```

---

## Next Steps for mesh-six

1. **Review** `GWA_AUTH_ARCHITECTURE.md` (1,014 lines, sections 1-12)
2. **Study** `src/orchestrator/environment-provisioner.ts` (credential lifecycle)
3. **Study** `src/lib/credentials-manager.ts` (pod-side provisioning)
4. **Review** `k8s/gwa-runner-configmap.yaml` (startup sequence)
5. **Adapt** for mesh-six storage backend (PostgreSQL instead of SQLite)
6. **Extend** dialog handler if needed for other agent types
7. **Integrate** with Dapr pub/sub for credential refresh events

---

## References

- **Main Report:** `GWA_AUTH_ARCHITECTURE.md` (this directory)
- **Repository:** https://github.com/jaybrto/github-workflow-agents
- **Claude CLI Docs:** https://github.com/anthropics/anthropic-sdk-python/tree/main/src/anthropic_cli
- **MinIO S3 SDK:** https://docs.min.io/docs/javascript-client-quickstart-guide.html
- **Kubernetes Secrets:** https://kubernetes.io/docs/concepts/configuration/secret/

---

**Exploration completed:** 2026-02-19
**Document generated:** 1,014 lines of detailed architectural analysis
**Ready for:** mesh-six integration planning and implementation
