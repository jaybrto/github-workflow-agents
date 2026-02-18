# GitHub Workflow Agents (GWA)

Automated Claude Code integration for GitHub PRs with persistent sessions.

## Project Context

- **Purpose:** Production Claude Code automation with long-lived K3s pods
- **Tech Stack:** Bun, TypeScript (NO Python)
- **Infrastructure:** K3s cluster with Longhorn storage, RabbitMQ, MinIO
- **Organization:** jaybrto

## Repository Structure

```
├── .claude/              # Claude configuration
│   └── CLAUDE.md         # This file
├── .github/workflows/    # GitHub Actions (thin triggers)
├── k8s/                  # Kubernetes manifests
├── scripts/              # Shell scripts (orchestration only)
├── src/                  # Bun TypeScript source
│   ├── orchestrate.ts    # Main PR work lifecycle
│   ├── respond.ts        # Handle @claude-answer responses
│   ├── cleanup.ts        # Stale PR cleanup
│   ├── shared/           # Canonical shared types (SessionState, AmqpMessage, etc.)
│   ├── orchestrator/     # Orchestrator service (REST API, push bridge, aggregator)
│   └── lib/              # Shared libraries
│       ├── claude.ts     # Claude Code subprocess
│       ├── tmux.ts       # node-tmux wrapper
│       ├── amqp.ts       # RabbitMQ AMQP client
│       ├── state-machine.ts # XState v5 session lifecycle
│       ├── terminal-relay.ts # WebSocket streaming, snapshots, recordings
│       ├── github.ts     # @octokit/rest client
│       ├── db.ts         # SQLite database (WAL mode)
│       └── k8s.ts        # @kubernetes/client-node
├── Dockerfile            # Multi-stage Bun build
└── package.json          # Dependencies
```

## SDK Stack

All external interactions use proper SDKs — no CLI output parsing:

| Concern     | Package                   | Usage                       |
| ----------- | ------------------------- | --------------------------- |
| Claude Code | subprocess                | `stream-json` output format |
| Tmux        | `node-tmux`               | Session/window management   |
| Kubernetes  | `@kubernetes/client-node` | Pod exec, status            |
| GitHub      | `@octokit/rest`           | PRs, comments, status       |
| XState      | `xstate`                  | State machine lifecycle     |
| AMQP        | `amqplib`                 | RabbitMQ messaging          |
| ntfy.sh     | HTTP POST (fetch)         | Push notifications          |
| MinIO       | `@aws-sdk/client-s3`      | Recording storage           |

## Git Workflow

### Branch Naming
- **Feature:** `feature/issue-{NUMBER}-{description}`
- **Bug Fix:** `fix/issue-{NUMBER}-{description}`
- **Refactor:** `refactor/{description}`

### Commit Messages
Follow Conventional Commits:
```
<type>(<scope>): <description>
```
Types: `feat`, `fix`, `refactor`, `docs`, `test`, `infra`, `chore`

## Operational Notes

### When Running Inside the GWA Pod

You are running in `/home/runner/worktrees/pr-{NUMBER}/` — an isolated git worktree for this PR.

Key paths:
- Worktree: `/home/runner/worktrees/pr-{NUMBER}/`
- Main repo: `/home/runner/repo/`
- Claude session: `/home/runner/.claude/`

### When You Need Input

If you need clarification:
1. Use the `ask-question` tool to post a PR comment
2. The user will respond with `@claude-answer: their answer`
3. You'll receive the answer and continue

### Session Persistence

- Session data persists on Longhorn across pod restarts
- SQLite stores all session state, XState snapshots, and activity logs
- RabbitMQ distributes events between runner pods and the orchestrator
- Use `--continue` flag to resume previous conversations

### Orchestrator Service

The orchestrator (`src/orchestrator/`) runs as a separate service:

- **Webhook Handler**: Receives GitHub webhooks, verifies HMAC signatures (timing-safe), deduplicates deliveries, publishes AMQP commands
- **Session Aggregator**: Subscribes to `gwa.events.#`, maintains cross-pod session state in its own SQLite DB
- **Push Bridge**: Subscribes to events, sends ntfy.sh notifications for blocked/error/complete with rate limiting
- **REST API**: Exposes `/sessions`, `/sessions/:id/answer`, `/sessions/:id/snapshots`, `/sessions/:id/recordings`

### Terminal Streaming

The terminal relay (`src/lib/terminal-relay.ts`) provides:

- **WebSocket server** on port 8080 at `/ws/{sessionId}` for live terminal output
- **Asciicast v2 recordings** uploaded to MinIO on session completion
- **SVG snapshots** via ansi-to-svg stored in SQLite

---

## Pre-Commit Checklist (IMPORTANT)

**Before every commit, run these checks:**

```bash
bun run typecheck  # REQUIRED - catches TypeScript errors before CI
```

This prevents build failures in CI. TypeScript errors caught locally are much faster to fix than waiting for CI to fail.

## Version Bumps (IMPORTANT)

**Always bump package.json versions when modifying source files.**

The CI pipeline enforces version bumps via `.github/workflows/version-check.yml`. When you change source files in any package, you MUST:

1. Run `bun run typecheck` to verify no TypeScript errors
2. Bump the `version` in that package's `package.json` (use semver: patch for fixes, minor for features)
3. Update `CHANGELOG.md` with a description of changes

Skip markers (add to PR title if truly not needed):
- `[skip-version-check]` - Skip version bump requirement
- `[skip-changelog]` - Skip changelog requirement

---

## Workflow: Processing an Issue

When asked to work on or implement an issue, follow this workflow:

1. **Fetch issue details** from GitHub using `gh issue view`
2. **Analyze requirements** and plan the implementation
3. **Implement the solution** following project conventions
4. **Run tests** (`bun test`) to verify changes work
5. **Commit changes** with conventional commit messages
6. **Push changes** to the PR branch

### Implementation Checklist
- Code follows project conventions (Bun, TypeScript, no Python)
- No hardcoded secrets or credentials
- Error handling is appropriate
- Tests cover new functionality
- No unnecessary dependencies added

### If Requirements Are Unclear
- Ask for clarification using the question tool
- Break large issues into subtasks if needed
- Always verify assumptions before implementing

---

## Workflow: Reviewing a PR

When asked to review PR changes, follow this workflow:

1. **Fetch PR diff** using `gh pr diff`
2. **Analyze code changes** for:
   - Logic errors or bugs
   - Security vulnerabilities
   - Performance issues
   - Code style consistency
   - Missing tests
3. **Post review comments** on specific lines if issues found
4. **Provide overall summary** of the review

### Review Checklist
- [ ] Code follows project conventions
- [ ] No hardcoded secrets or credentials
- [ ] Error handling is appropriate
- [ ] Tests cover new functionality
- [ ] No unnecessary dependencies added
- [ ] Documentation updated if needed

### Review Guidelines
- Reviews are constructive, not nitpicky
- Suggest specific improvements, not vague feedback
- Approve if changes are good, request changes if not

---

## Testing

```bash
# Type check
bun run typecheck

# Run tests
bun test

# Build binaries
bun run build
```

## Deployment

```bash
# Build and push container
./scripts/build-and-push.sh

# Apply K8s manifests
./scripts/deploy-all.sh

# Restart pod to pick up new image
kubectl rollout restart statefulset gwa-runner
```

---

## Code Navigation - MANDATORY TOOL SELECTION

**CRITICAL: This codebase has LSP available. You MUST use it instead of grep/glob for code navigation tasks.**

### MANDATORY: Use LSP for These Query Types

**Supported Language:** TypeScript (via `typescript-lsp@claude-plugins-official`)

**You MUST use LSP (not grep/glob) when the user asks:**

| User Request Pattern | MUST Use | LSP Operation |
|---------------------|----------|---------------|
| "Find definition of X" | LSP | `goToDefinition` |
| "Where is X defined" | LSP | `goToDefinition` |
| "Find references to X" | LSP | `findReferences` |
| "Who calls X" / "What calls X" | LSP | `incomingCalls` |
| "What does X call" | LSP | `outgoingCalls` |
| "Find implementations of X" | LSP | `goToImplementation` |
| "Show me all usages of X" | LSP | `findReferences` |
| "What implements interface X" | LSP | `goToImplementation` |
| "List symbols in file X" | LSP | `documentSymbol` |
| "What type is X" / "Signature of X" | LSP | `hover` |

**LSP Examples for This Codebase:**
```
User: "Find all references to getOctokit"
WRONG: Grep "getOctokit"
RIGHT: LSP findReferences on src/lib/github.ts line 6

User: "What calls postPRComment"
WRONG: Grep "postPRComment"
RIGHT: LSP incomingCalls on src/lib/github.ts line 81

User: "Find definition of SessionState"
WRONG: Grep "enum SessionState"
RIGHT: LSP goToDefinition on any usage of SessionState
```

### LSP Limitations

LSP is **not available** for `.sh` files (no bash-language-server configured).

**For shell scripts (`scripts/`), use:**
1. Grep/Glob for exact pattern matching

### ONLY Use Grep/Glob for These Cases

**Grep/Glob is the FALLBACK, not the default. Use ONLY when:**

1. LSP fails or returns no results
2. Searching for string literals, comments, or config values
3. Finding files by naming pattern (e.g., `*.test.ts`, `*.sh`)
4. Searching non-code files (JSON, YAML, Markdown, Dockerfile)
5. Searching for exact text that isn't a symbol (error messages, URLs, env vars)
6. Searching shell scripts in `scripts/`

### Decision Matrix - FOLLOW THIS EXACTLY

```
┌─────────────────────────────────────────────────────────────────────────┐
│ BEFORE using Grep or Glob, ask yourself:                                │
│                                                                         │
│ 1. Am I looking for a SYMBOL (function, type, interface, method)?       │
│    YES → MUST use LSP (goToDefinition, findReferences, etc.)            │
│                                                                         │
│ 2. Am I searching for STRING LITERALS, ENV VARS, or CONFIG VALUES?      │
│    YES → OK to use Grep                                                 │
│                                                                         │
│ 3. Am I searching non-TS files (YAML, JSON, Dockerfile, .sh)?          │
│    YES → OK to use Grep/Glob                                            │
│                                                                         │
│ 4. Did LSP FAIL?                                                        │
│    YES → OK to fallback to Grep/Glob                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tool Availability Status

| Tool | Status | Notes |
|------|--------|-------|
| **LSP** | Working | TypeScript via `typescript-lsp` plugin |
| **Semantic Search** | Not Available | No `claude-context` MCP server configured |
| Grep/Glob | Available | Fallback only for TS; primary for non-TS files |

### Common Anti-Patterns to AVOID

```
WRONG: User asks "find references to postPRComment"
       → Using Grep "postPRComment"
RIGHT: → Using LSP findReferences on the postPRComment definition

WRONG: User asks "what implements the SessionManager interface"
       → Using Grep "implements SessionManager"
RIGHT: → Using LSP goToImplementation on the SessionManager definition

WRONG: User asks "who calls getOctokit"
       → Using Grep "getOctokit("
RIGHT: → Using LSP incomingCalls on getOctokit
```
