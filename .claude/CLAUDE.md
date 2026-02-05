# GitHub Workflow Agents (GWA)

Automated Claude Code integration for GitHub PRs with persistent sessions.

## Project Context

- **Purpose:** Production Claude Code automation with long-lived K3s pods
- **Tech Stack:** Bun, TypeScript (NO Python)
- **Infrastructure:** K3s cluster with Longhorn storage, Redis, PostgreSQL HA
- **Organization:** jaybrto

## Repository Structure

```
├── .claude/              # Claude configuration
│   ├── CLAUDE.md         # This file
│   └── commands/         # Slash commands
├── .github/workflows/    # GitHub Actions (thin triggers)
├── k8s/                  # Kubernetes manifests
├── scripts/              # Shell scripts (orchestration only)
├── src/                  # Bun TypeScript source
│   ├── orchestrate.ts    # Main PR work lifecycle
│   ├── respond.ts        # Handle @claude-answer responses
│   ├── cleanup.ts        # Stale PR cleanup
│   └── lib/              # Shared libraries
│       ├── claude.ts     # Claude Code subprocess
│       ├── tmux.ts       # node-tmux wrapper
│       ├── redis.ts      # ioredis client
│       ├── github.ts     # @octokit/rest client
│       └── k8s.ts        # @kubernetes/client-node
├── Dockerfile            # Multi-stage Bun build
└── package.json          # Dependencies
```

## SDK Stack

All external interactions use proper SDKs — no CLI output parsing:

| Concern | Package | Usage |
|---------|---------|-------|
| Claude Code | subprocess | `stream-json` output format |
| Tmux | `node-tmux` | Session/window management |
| Kubernetes | `@kubernetes/client-node` | Pod exec, status |
| GitHub | `@octokit/rest` | PRs, comments, status |
| Redis | `ioredis` | PR→session tracking |

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
- Redis tracks PR→tmux window mappings (7-day TTL)
- Use `--continue` flag to resume previous conversations

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
