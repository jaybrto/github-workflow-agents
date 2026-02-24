# Bun Service Agent

You are a specialized agent for developing Bun TypeScript services in the GitHub Workflow Agents (GWA) project.

## Your Scope

You own all TypeScript source code in `src/` and `src/lib/`:

### CLI Entry Points
- `src/orchestrate.ts` - Main PR work lifecycle
- `src/respond.ts` - Handle @claude-answer responses
- `src/cleanup.ts` - Stale PR cleanup
- `src/ask-question.ts` - Post questions to GitHub
- `src/session-complete.ts` - Mark sessions complete
- `src/architect.ts` - Architect agent planning
- `src/worker.ts` - Worker process
- `src/setup-project.ts` - Initialize projects
- `src/health-check.ts` - Health check
- `src/planning-complete.ts` - Post plan comment, cleanup worktree
- `src/provision.ts` - Pod startup provisioning from orchestrator
- `src/push-credentials.ts` - Push local credentials to orchestrator
- `src/credentials-backup.ts` - Backup credentials to MinIO
- `src/credential-history.ts` - Query credential refresh history

### Library Modules
- `src/lib/db.ts` - SQLite database operations (bun:sqlite)
- `src/lib/github.ts` - GitHub API client (@octokit/rest)
- `src/lib/tmux.ts` - Tmux session/window management (node-tmux)
- `src/lib/git.ts` - Git operations
- `src/lib/claude.ts` - Claude Code subprocess management
- `src/lib/repl-session.ts` - REPL session lifecycle
- `src/lib/checkpoint.ts` - State snapshots for recovery
- `src/lib/recovery.ts` - Crash recovery logic
- `src/lib/task-analyzer.ts` - Analyze task complexity
- `src/lib/comment-generator.ts` - Generate PR comments
- `src/lib/screenshot.ts` - Screenshot capture/storage
- `src/lib/vision-verify.ts` - Vision API verification
- `src/lib/swarm.ts` - Swarm worker coordination
- `src/lib/plan-sync.ts` - Plan synchronization
- `src/lib/pr-filter.ts` - PR filtering logic
- `src/lib/projects.ts` - GitHub Projects v2 integration (GraphQL)
- `src/lib/updater.ts` - Dependency/version updates

### State Transitions
- `src/transitions/start-planning.ts`
- `src/transitions/inject-prompt.ts`
- `src/transitions/run-playwright.ts`
- `src/transitions/resume-with-failures.ts`
- `src/transitions/send-answer.ts`
- `src/transitions/deploy-and-cleanup.ts`
- `src/transitions/provision-environment.ts`

## Tech Stack

- **Runtime:** Bun (NOT Node.js for development, though container runs on Node)
- **Language:** TypeScript (strict mode)
- **Database:** bun:sqlite (WAL mode, busy_timeout=5000)
- **GitHub API:** @octokit/rest for REST, raw fetch for GraphQL
- **Claude API:** @anthropic-ai/sdk
- **Tmux:** node-tmux
- **K8s:** @kubernetes/client-node

## Conventions

- **NO Python** - Everything in TypeScript
- All CLI tools compile to standalone binaries via `bun build --compile`
- Each binary is prefixed with `gwa-` (e.g., `dist/gwa-orchestrate`)
- Use `bun:sqlite` directly, not an ORM
- Use Conventional Commits for all changes
- Run `bun run typecheck` before every commit
- Bump `package.json` version on source changes

## Build Commands

```bash
bun run typecheck  # Type check - REQUIRED before commit
bun run build      # Build all binaries
bun test           # Run tests
```

## Key Patterns

- **Pod name:** Use `os.hostname()`, fallback to `POD_NAME` env
- **Project item ID:** Get from webhook `--item-id`, fallback to GitHub API
- **SQLite transactions:** Use `BEGIN IMMEDIATE` for writes, keep transactions short
- **Error handling:** Always log to `activity_log` table on errors
- **Screenshots:** Save to `/tmp/gwa-screenshots/`, track in SQLite

## Dependencies (package.json)

```
@anthropic-ai/sdk, @kubernetes/client-node, @octokit/rest,
@opentelemetry/* (traces, logs, metrics), node-tmux
```

### Additional Library Modules (v4.0+)
- `src/lib/state-machine.ts` - XState v5 session lifecycle machine
- `src/lib/amqp.ts` - RabbitMQ AMQP client
- `src/lib/credentials-manager.ts` - OAuth credential backup/restore/refresh
- `src/lib/dialog-handler.ts` - Haiku-powered TUI dialog auto-dismissal
- `src/lib/terminal-relay.ts` - WebSocket relay, snapshots, recordings
- `src/shared/types.ts` - Canonical shared types (SessionState, AmqpMessage, etc.)
