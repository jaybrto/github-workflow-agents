# Handoff Prompt: Claude Code Auth Detection & Recovery (v1.1.0)

**Copy this entire file into a new Claude Code session to continue work.**

---

## Context

You are working on **GitHub Workflow Agents (GWA)** — a production Claude Code automation system with long-lived K8s pods on a homelab K3s cluster.

- **Repo:** `jaybrto/github-workflow-agents`
- **Tech Stack:** Bun, TypeScript (NO Python)
- **Infrastructure:** K3s cluster with Longhorn storage, Redis (being removed), SQLite, RabbitMQ
- **Branch:** `claude/review-cli-github-integration-9tvfF`

## What Was Done

### Problem

Pods were getting stuck on the Claude Code v2.1.38 login/authentication screen despite `CLAUDE_CODE_OAUTH_TOKEN` being set as a Kubernetes secret. This silently prevented pods from receiving commands with no error raised and no notification posted.

**Root causes:**
1. tmux sessions may not propagate env vars to new windows created later
2. The OAuth token can expire without any detection
3. No code existed to detect or report the auth screen

### Three-Layer Fix (Implemented)

**1. Prevention** — Explicitly push auth env vars into tmux session:
- `helm/gwa-runner/templates/configmap.yaml`: Entrypoint validates auth env vars on startup. Uses `tmux set-environment` to push `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` into the tmux session on creation. Also refreshes them in existing sessions on pod restart.
- `src/lib/tmux.ts`: New `setEnvironment(name, value)` function wraps `tmux set-environment -t gwa-work`
- `src/lib/repl-session.ts`: `startREPL()` calls `setEnvironment()` for both auth tokens before creating new REPL windows

**2. Detection** — Check for auth screen patterns after Claude launch:
- `src/lib/claude.ts`:
  - `AUTH_FAILURE_PATTERNS` — 15 lowercase patterns (e.g. "choose how to authenticate", "sign in at", "oauth.anthropic.com")
  - `detectAuthFailure(output: string): boolean` — checks output against all patterns
  - `ClaudeAuthError` class — thrown when auth failure detected
  - `checkAuthEnvironment(): { ok: boolean; error?: string }` — pre-flight check that env vars exist
  - Headless path: combined stdout+stderr checked for auth patterns before returning generic errors
- `src/lib/repl-session.ts`: After launching `claude` in tmux, waits 3 seconds (was 2s), captures pane output, checks for auth patterns. If stuck, kills window, cleans up Redis session, throws `ClaudeAuthError`

**3. Notification** — Post GitHub PR comment with remediation steps:
- `src/orchestrate.ts`:
  - `postAuthStuckComment(ctx, details)` — posts a detailed PR comment including pod name, timestamp, and remediation steps (refresh token, restart pod)
  - Pre-flight `checkAuthEnvironment()` at start of orchestration — fails fast with comment if no auth env vars
  - Headless mode: checks Claude result for auth failure patterns, posts auth-specific comment instead of generic error
  - Main catch block: handles `ClaudeAuthError` separately from other errors

### Files Changed

| File | Changes |
|------|---------|
| `src/lib/claude.ts` | Added `AUTH_FAILURE_PATTERNS`, `ClaudeAuthError`, `detectAuthFailure()`, `checkAuthEnvironment()`. Headless path checks for auth failure before generic error return |
| `src/lib/tmux.ts` | Added `setEnvironment(name, value)` using `tmux set-environment` |
| `src/lib/repl-session.ts` | Added auth token propagation via `setEnvironment()`, pane capture after 3s wait, auth pattern detection, cleanup on failure |
| `src/orchestrate.ts` | Added pre-flight auth check, `ClaudeAuthError` handling in catch block, auth-specific headless error detection, `postAuthStuckComment()` helper |
| `helm/gwa-runner/templates/configmap.yaml` | Added startup auth validation log, `tmux set-environment` for both auth tokens on new and existing sessions |
| `package.json` | Version bumped from `1.0.0` to `1.1.0` |
| `CHANGELOG.md` | Created with v1.1.0 and v1.0.0 entries |
| `PLAN.md` | Added auth detection troubleshooting section to Phase 11, added checklist item |

### Commits

1. `7c34cea` — `docs(plan): rewrite PLAN_V4.md incorporating gap analysis and user feedback`
2. `910ec81` — `fix(auth): detect and report Claude Code auth screen stuck in pods`

### Version

`package.json` version: **1.1.0**

## Current State of the Codebase

### Architecture (current — pre-v4.0)

- **Dual persistence:** Redis (session tracking, TTL) + SQLite (local state)
- **Orchestrator:** Runs inside repo pods (not yet extracted)
- **Modes:** REPL (interactive tmux) and Headless (`--print` subprocess)
- **GitHub Actions:** Thin triggers that `kubectl exec` into pods
- **No mobile app yet**, no RabbitMQ integration yet, no XState yet

### Key Source Files

```
src/
  orchestrate.ts          # Main PR orchestration (REPL + headless modes)
  respond.ts              # Handle @claude-answer responses
  cleanup.ts              # Stale PR cleanup
  health-check.ts         # Pod health checks (Redis, tmux, worktrees)
  lib/
    claude.ts             # Claude Code subprocess + auth detection (v1.1.0)
    tmux.ts               # tmux session/window management + setEnvironment (v1.1.0)
    repl-session.ts       # REPL lifecycle + auth check (v1.1.0)
    redis.ts              # ioredis client (21 files use this — removal planned in v4.0)
    github.ts             # @octokit/rest PR comments
    db.ts                 # SQLite database
    telemetry.ts          # OpenTelemetry instrumentation
    types.ts              # TypeScript interfaces
    git.ts                # Git worktree management
    task-analyzer.ts      # Mode selection (REPL vs headless)
    comment-generator.ts  # Smart comment generation

helm/gwa-runner/
  values.yaml             # Helm values (redis, secrets, storage config)
  templates/
    statefulset.yaml      # Pod spec with CLAUDE_CODE_OAUTH_TOKEN from secret
    configmap.yaml        # Entrypoint script with auth validation (v1.1.0)
```

### What the Auth Comment Looks Like on GitHub

When auth failure is detected, this comment gets posted:

```
**Claude Code authentication failure**

The pod is stuck on the Claude Code login/authentication screen and cannot process commands.

**Details:** <error details>

**Action required:**
1. Verify the `CLAUDE_CODE_OAUTH_TOKEN` secret is set and not expired
2. Refresh the token if needed:
   ```bash
   kubectl create secret generic gwa-secrets \
     --from-literal=claude-oauth-token=<new-token> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
3. Restart the pod: `kubectl rollout restart statefulset gwa-runner`

*Pod: `gwa-runner-0` | Detected at: 2026-02-17T...*
```

## What Needs to Happen Next

### Immediate (Deploy & Verify)

1. **Build and push new container image** with v1.1.0 changes
2. **Helm upgrade** to pick up new configmap entrypoint
3. **Test auth detection:**
   - Temporarily set an invalid `CLAUDE_CODE_OAUTH_TOKEN` secret
   - Trigger a PR to invoke orchestration
   - Verify the auth-stuck comment appears on the PR
   - Restore valid token and verify normal operation

### v4.0 Plan (PLAN_V4.md)

A comprehensive v4.0 upgrade plan exists at `PLAN_V4.md` (9 phases, 154 items):
- Phase 0: Prerequisites (RabbitMQ plugins, ntfy.sh, MinIO)
- Phase 1: Security hardening (webhook signatures, dedup, auth detection)
- Phase 2: XState v5 state machine at pod level
- Phase 3: Complete Redis removal (21 files)
- Phase 4: RabbitMQ backbone + orchestrator extraction
- Phase 5: Live terminal streaming + MinIO recordings
- Phase 6: Native Android app (Kotlin/Compose)
- Phase 7: Behavioral tests
- Phase 8: Documentation & cleanup

### Pre-Commit Checklist

Before every commit:
```bash
bun run typecheck   # REQUIRED
```

Bump `package.json` version when modifying source files. Commit messages follow Conventional Commits: `<type>(<scope>): <description>`

## Key Constraints

- **Bun + TypeScript only** — no Python
- **No hardcoded secrets** — everything from K8s secrets
- **SDK-first** — `@octokit/rest` for GitHub, `ioredis` for Redis, `@kubernetes/client-node` for K8s
- **No CLI output parsing** — structured JSON (`stream-json`) for Claude subprocess
- **Conventional Commits** — `feat`, `fix`, `refactor`, `docs`, `test`, `infra`, `chore`
