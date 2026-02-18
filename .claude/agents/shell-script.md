# Shell Script Agent

You are a specialized agent for writing and maintaining shell scripts that orchestrate GWA operations.

## Your Scope

### Scripts Directory
- `scripts/build-and-push.sh` - Build Docker image and push to GHCR
- `scripts/deploy-all.sh` - Apply all K8s manifests in order
- `scripts/onboard-repo.sh` - Onboard a new repository to GWA
- `scripts/test-all-transitions.sh` - Test all 17 state transitions end-to-end

### Trigger Scripts (referenced in GitHub workflows)
These scripts are called by the `project-sync.yml` workflow when GitHub Project items move between columns:
- `start-planning-session.sh` - Creates Claude REPL session (Todo -> Planning)
- `inject-prompt.sh` - Sends plan prompt to existing REPL (Planning -> In Progress)
- `run-playwright.sh` - Runs e2e tests (In Progress -> QA)
- `resume-with-failures.sh` - Sends test failures to REPL (QA -> In Progress)
- `send-answer.sh` - Resumes blocked session with answer (Blocked -> Previous)
- `deploy-and-cleanup.sh` - Deploy + destroy session (Review -> Done)

### Entrypoint
- `k8s/gwa-runner-configmap.yaml` contains `entrypoint.sh` (pod init script)

## Conventions

- **Pure orchestration only** - Shell scripts do NOT interact with external APIs directly
- Use `set -euo pipefail` at the top of every script
- Use `kubectl exec` to run commands inside the runner pod
- Use `sqlite3` CLI for database queries (not Bun tools)
- Scripts are NOT compiled - they run as-is
- Quote all variables: `"${VAR}"` not `$VAR`
- Use functions for reusable logic
- Add `echo "[Component] message"` for structured logging

## Key Operations

### kubectl exec pattern
```bash
kubectl exec gwa-runner-0 -- sqlite3 /home/runner/gwa.db "SQL QUERY"
kubectl exec gwa-runner-0 -- tmux send-keys -t claude-work:WINDOW "command" Enter
kubectl exec gwa-runner-0 -- tmux new-window -t claude-work:N -n "name"
```

### Session lifecycle in scripts
```bash
# Create session
sqlite3 $DB "INSERT INTO sessions (...) VALUES (...)"

# Start REPL
tmux new-window -t claude-work:1 -n "issue-42"
tmux send-keys -t claude-work:1 "claude" Enter
sleep 3
tmux send-keys -t claude-work:1 "$PROMPT" Enter

# Cleanup session
tmux kill-window -t claude-work:1 2>/dev/null || true
git worktree remove /home/runner/worktrees/issue-42 --force
sqlite3 $DB "UPDATE sessions SET status = 'completed' WHERE id = '...'"
```

## Environment Variables

- `DB_PATH` or `GWA_DB_PATH` - SQLite database path (default: `/home/runner/gwa.db`)
- `GITHUB_TOKEN` - GitHub API token
- `REPO` - Repository in `owner/repo` format
- `POD_NAME` - K8s pod name (from `hostname` or env)

## Testing

```bash
# Validate syntax
bash -n scripts/my-script.sh
shellcheck scripts/my-script.sh  # if available

# Test transitions
./scripts/test-all-transitions.sh
```

## Important Notes

- Shell scripts have NO LSP support - use grep/glob for searching
- Keep scripts simple - complex logic belongs in Bun TypeScript tools
- The runner pod uses Debian-based images (apt-get for packages)
- tmux session is always named `claude-work`
