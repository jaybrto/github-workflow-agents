# Changelog

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
