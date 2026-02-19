# Changelog

## [4.4.0] - 2026-02-19

### Added
- `isCredentialExpired()` in `credentials-manager.ts` — checks if stored OAuth token is expired or within 5 minutes of expiry
- `tryRecoverCredentials()` in `credentials-manager.ts` — force-deletes expired credentials file, restores from MinIO, updates `CLAUDE_CODE_OAUTH_TOKEN` env var
- Proactive token expiry check in `orchestrate.ts`, `start-planning.ts`, and `resume-with-failures.ts` before Claude starts
- Reactive auth retry loop (max 2 retries) in `orchestrate.ts` and `start-planning.ts` on `ClaudeAuthError`
- Auth failure GitHub notifications in `start-planning.ts` and `resume-with-failures.ts`

### Fixed
- `restoreCredentialsIfMissing()` was skipping MinIO restore when expired credentials file existed — `tryRecoverCredentials()` fixes this by deleting first
- `executeHeadlessMode` was not throwing `ClaudeAuthError` — auth failure now propagates to the retry loop
- Backup CronJob no longer backs up expired credentials to MinIO (prevents restore loops)
- `CLAUDE_CODE_OAUTH_TOKEN` env var is now updated after MinIO restore so headless subprocess gets the fresh token

## [4.3.2] - 2026-02-19

### Added

- `src/transitions/resume-with-failures.ts`: proactive OAuth token expiry check before Claude REPL start with MinIO credential recovery; `capturePane` + `detectAuthFailure` check after REPL initialization to detect auth screen; `ClaudeAuthError` handling in `main()` catch block with best-effort GitHub issue comment; `ClaudeAuthError` and `detectAuthFailure` imports from `../lib/claude.js`; `isCredentialExpired` and `tryRecoverCredentials` imports from `../lib/credentials-manager.js`; `getOctokit` import from `../lib/github.js`

## [4.3.1] - 2026-02-19

### Fixed

- `k8s/gwa-runner-statefulset.yaml`: init container now chowns PVC volumes to `runner:runner` (uid/gid 1001) instead of `node:node` (1000). The previous setup made credentials unreadable to the main container on every pod restart, causing Claude to show the OAuth login screen even with valid credentials on the PVC. Also updated `fsGroup` to 1001.
- `src/lib/claude.ts`: removed unused `chmodSync` import

### Infrastructure

- `gitea-registry-push` Kubernetes secret updated with fresh Docker Hub token to prevent Kaniko build failures from Docker Hub rate limiting (unauthenticated pull limit was being hit)

## [4.3.0] - 2026-02-19

### Added

- Multi-pod credential backup/restore system (`src/lib/credentials-manager.ts`) that tars `~/.claude/.credentials.json` + `~/.claude.json` and uploads to MinIO
  - Per-pod backup path: `s3://gwa-recordings/claude-auth/pods/<POD_NAME>/credentials.tar.gz`
  - Legacy fallback path: `s3://gwa-recordings/claude-auth/credentials.tar.gz`
  - `restoreCredentialsIfMissing()`: on new pod startup, cascades through own pod → other pods → legacy path
  - `syncConfigFromCredentials()`: recreates ephemeral `~/.config/claude/config.json` from PVC-backed credentials on every pod start
- `src/credentials-backup.ts` — standalone binary entry point for the backup CronJob
- `k8s/gwa-credentials-backup-cronjob.yaml` — runs every 6 hours, mounts `claude-session-gwa-runner-0` PVC, backs up Claude credentials to MinIO
- `k8s/gwa-runner-configmap.yaml` — entrypoint now calls `syncConfigFromCredentials` on every pod start to reconstruct ephemeral config from PVC-backed credentials
- `dialog-handler.ts`: added `Choose text style` (theme selection) dialog to `KNOWN_DIALOGS` fast-path

### Fixed

- `preloadClaudeConfig()` in `claude.ts`: now writes `claudeAiOauth` format (`{ claudeAiOauth: { accessToken, expiresAt } }`) for new pods instead of legacy `oauthToken` top-level field — required by Claude Code 2.1.45+ TUI mode. Does not overwrite existing `claudeAiOauth` credentials.
- `preloadClaudeConfig()`: removed unused `chmodSync` import

### Infrastructure

- `gwa-runner-0` pod fully authenticated via PVC-backed credentials (`claudeAiOauth` format with `refreshToken`)
- Credentials backed up to MinIO at session start and via 6-hour CronJob
- Pod startup sequence: restore credentials → sync config → launch runner

## [4.2.0] - 2026-02-18

### Added

- ntfy.sh deployed to K3s cluster (`default` namespace) at `ntfy.bto.bar` for push notifications
- MinIO bucket `gwa-recordings` created for asciicast recording storage
- Vault `secret/data/gwa` updated with `rabbitmq-url`, `minio-access-key`, `minio-secret-key` keys
- ExternalSecret syncs 3 new keys (`rabbitmq-url`, `minio-access-key`, `minio-secret-key`) into runner pod env
- Helm chart: added `RABBITMQ_URL`, `NTFY_URL`, and MinIO env vars to runner StatefulSet template
- Helm test: activated RabbitMQ env var assertion (previously TODO-commented)
- In-repo E2E test harness (`src/tests/e2e/`) with 10 lifecycle tests driving the full XState session lifecycle without requiring a live cluster
- Live test-target repo `jaybrto/gwa-test-target` (Bun counter app, onboarded to ArgoCD) for integration testing
- E2E scripts: `scripts/create-test-target.sh`, `scripts/e2e-live-test.sh`
- `project-sync.yml`: implemented all 7 previously TODO workflow handlers — Playwright, status-update, pause-for-question, request-retest, close-without-work, skip-qa, skip-implementation
- `preflight.test.ts`: added `amqplib` dependency assertion to preflight checks

### Fixed

- gwa-cleanup CronJob: fixed `DeadlineExceeded` by increasing timeout to 600s, disabling OTEL, removing invalid `--pod` arg, and adding `nodeAffinity`
- gwa-webhook: force-deleted stuck `ContainerCreating` pod (lenovomini cgroup issue), added `nodeAffinity` to prevent recurrence
- `ntfy.yaml` and `gwa-cleanup-cronjob.yaml`: added `nodeAffinity` excluding dellmini2/lenovomini nodes with explanatory comments
- Stale artifacts removed: `dist/gwa-debug-redis` binary and extraneous `ioredis` dependency pruned

### Infrastructure

- `RABBITMQ_URL`, `NTFY_URL`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` wired into runner StatefulSet via Vault/ESO
- Orchestrator: confirmed connected to live RabbitMQ (not stub)
- RabbitMQ: `gwa.topic` exchange created by runner on startup
- 353 tests pass, 0 fail across full test suite

## [4.1.2] - 2026-02-18

### Added
- In-repo E2E test harness (`src/tests/e2e/`) that drives the XState session lifecycle through all 7 states without requiring a live cluster
- `src/tests/e2e/helpers.ts`: `createTestDb()` (in-memory SQLite with full schema), `createTestActor()` (fresh idle actor), `actorInState()` (actor pre-positioned in any state), `sendAndExpect()` (event dispatch + state assertion)
- `src/tests/e2e/full-lifecycle.test.ts`: 10 tests covering the complete happy path (idle→planning→inProgress→qa→review→done), blocked/resume with guard verification, actor isolation via `beforeEach`, and schema loading validation

## [4.1.1] - 2026-02-18

### Fixed
- `createSession`, `createQuestion`, and `answerQuestion` now wrap their multi-step write operations in `db.transaction()` to ensure atomicity — if the activity_log insert fails, the parent insert is rolled back, preventing partial writes under concurrent load

### Added
- `sequential writes maintain data integrity` test: verifies 10 sequential session inserts all land correctly
- `transaction rolls back on error, leaving no partial writes` test: verifies that a failing transaction leaves no rows behind

## [4.1.0] - 2026-02-17

### Added
- Haiku-powered dialog handler (`src/lib/dialog-handler.ts`) that auto-detects and dismisses interactive TUI dialogs blocking Claude Code CLI startup in tmux windows
- `ClaudeDialogError` for unrecoverable dialog failures with captured terminal output
- `parseDialogResponse` helper for validating Haiku JSON responses with key whitelisting
- Dialog check integrated into all 3 tmux callsites: `repl-session.ts`, `start-planning.ts`, `resume-with-failures.ts`
- `postDialogStuckComment` in orchestrator for GitHub PR notification on dialog failures
- Known-pattern fast path for common dialogs (bypass permissions, trust project) — no API call needed
- `preloadClaudeConfig()` in `claude.ts` — writes credentials, account metadata, and settings files before Claude starts to prevent first-run dialogs (theme, auth method, onboarding, account selection)
- OAuth account metadata support via env vars (`CLAUDE_OAUTH_ACCOUNT_UUID`, `CLAUDE_OAUTH_EMAIL`, `CLAUDE_OAUTH_ORG_UUID`)
- Vault + External Secrets Operator integration (`k8s/vault-external-secrets.yaml`) for auto-rotating secrets
- Setup guide for Vault + ESO (`.claude/commands/setup-vault-eso.md`)
- 16 unit tests for dialog handler (`src/tests/dialog-handler.test.ts`)

## [4.0.0] - 2026-02-17

### Added
- XState v5 state machine with 7 states (idle, planning, inProgress, qa, blocked, review, done) and 38 transitions
- RabbitMQ AMQP backbone replacing workflow_dispatch chain (topic exchanges: gwa.events, gwa.commands, gwa.heartbeat)
- Orchestrator service with REST API (port 3001) and cross-pod session aggregation
- Push notifications via ntfy.sh for blocked, error, and complete events with per-session debounce and global rate limiting
- Live terminal streaming via WebSocket relay (port 8080) with mid-stream join support
- Terminal snapshots via ansi-to-svg stored in SQLite
- Session recordings in asciicast v2 format with MinIO storage and presigned URL generation
- Canonical shared types in src/shared/types.ts (SessionState, SessionEvent, AmqpMessage, PushNotification, etc.)
- Behavioral test suite for full lifecycle validation
- Timing-safe HMAC webhook signature verification (crypto.timingSafeEqual)
- Webhook delivery deduplication with 1-hour TTL
- XState snapshot persistence in SQLite with automatic AMQP state change publishing
- AMQP heartbeat publishing (30s interval) with pod health monitoring in orchestrator
- Orchestrator webhook handler that publishes AMQP commands instead of triggering workflow_dispatch

### Changed
- Complete Redis removal: all persistence migrated to SQLite + RabbitMQ
- State transitions managed by XState v5 (previously ad-hoc handler logic)
- Health check uses SQLite integrity check (previously Redis PING)
- Telemetry: removed IORedis instrumentation

### Removed
- ioredis dependency
- @opentelemetry/instrumentation-ioredis
- src/lib/redis.ts
- src/debug-redis.ts
- All Redis environment variables from K8s manifests

### Security
- Webhook HMAC comparison uses crypto.timingSafeEqual to prevent timing attacks
- Empty webhook secret fails closed (rejects all requests)
- Webhook delivery deduplication prevents replay attacks

## [1.1.0] - 2026-02-17

### Added
- Claude Code auth failure detection: detects when pods are stuck on the login/authentication screen
- Pre-flight auth environment check in orchestrator (validates `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` before launching Claude)
- Auth-specific GitHub PR comment when authentication fails, with remediation steps
- `tmux set-environment` propagation of auth tokens to tmux session so new windows inherit them
- Entrypoint startup validation that auth env vars are present

### Fixed
- REPL mode: auth tokens now explicitly pushed to tmux session environment before creating windows
- REPL mode: pane output captured after Claude launch to detect auth screen (3s check)
- Headless mode: stderr/stdout checked for auth failure patterns before returning generic errors
- Entrypoint: auth tokens refreshed in existing tmux sessions on pod restart

## [1.0.0] - Initial Release

### Added
- PR orchestration with REPL and headless modes
- Claude Code subprocess management with stream-json output
- tmux session/window management via node-tmux
- Redis session tracking with TTL
- GitHub PR comment posting (questions, errors, completions)
- SQLite database for local persistence
- OpenTelemetry instrumentation (traces, metrics, logs)
- Health check binary
- Helm chart for K8s deployment
