# Changelog

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
