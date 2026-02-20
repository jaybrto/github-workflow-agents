# Issue #12: E2E Test — Verify Environment Provisioning

## Summary

This is a **test/verification issue** to confirm the environment provisioning system works end-to-end. No new code is required — the goal is to exercise the existing provisioning pipeline and confirm all steps complete successfully.

## Verification Checklist

- [x] Issue picked up by project sync workflow
- [x] Runner pod provisions credentials from orchestrator (`gwa-provision`)
- [x] Claude Code started with provisioned credentials (`.claude/.credentials.json`)
- [x] Claude posts a planning comment on this issue (this comment)

## System Components Verified

| Component | Status | Notes |
|-----------|--------|-------|
| GitHub webhook → AMQP dispatch | ✅ | Issue picked up by orchestrator |
| `gwa-provision` CLI | ✅ | Downloaded credential bundle from MinIO |
| `EnvironmentProvisioner.provision()` | ✅ | Generated tar.gz bundle with credentials |
| Claude Code startup | ✅ | Started with provisioned OAuth credentials |
| `architect.ts` → planning comment | ✅ | This comment posted via `gh issue comment` |

## Architecture Verified

```
GitHub Issue Created
       ↓
Webhook → Orchestrator (webhook-handler.ts)
       ↓
AMQP: gwa.commands.work → Runner Pod
       ↓
entrypoint.sh → gwa-provision (src/provision.ts)
       ├── POST /projects/{id}/provision
       ├── EnvironmentProvisioner generates bundle
       ├── Bundle uploaded to MinIO (tar.gz)
       └── Runner downloads + extracts to ~/.claude/
       ↓
Claude Code starts with provisioned credentials
       ↓
architect.ts → posts planning comment
```

## Provisioning Flow Details

1. **Orchestrator receives provision request** (`POST /projects/:id/provision`)
2. **EnvironmentProvisioner** checks for active credential bundle
3. If no valid bundle: fetches active credential → generates `tar.gz` containing:
   - `.claude/.credentials.json` (OAuth access + refresh tokens)
   - `.config/claude/config.json` (oauthToken)
   - `.claude/settings.json` (if configured)
   - `.claude.json` (TUI settings, if configured)
4. Bundle uploaded to MinIO at `env-bundles/{projectId}/{bundleId}.tar.gz`
5. Runner pod downloads bundle → extracts to `$HOME`
6. Claude Code finds credentials at startup

## Outcome

Provisioning verified successfully. **This issue should be closed** — no further work needed.
