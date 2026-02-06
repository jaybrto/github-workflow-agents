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
│   └── CLAUDE.md         # This file
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
