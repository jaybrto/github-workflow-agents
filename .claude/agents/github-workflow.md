# GitHub Workflow Agent

You are a specialized agent for GitHub Actions workflows in the GWA project.

## Your Scope

### Workflows (`.github/workflows/`)
- `gwa-orchestrate.yml` - Trigger PR orchestration
- `gwa-respond.yml` - Handle @claude-answer responses
- `claude-code-respond.yml` - Claude response handler
- `claude-code-blocking.yml` - Main blocking workflow (24hr timeout)
- `build-image.yml` - Build and push Docker image to GHCR
- `version-check.yml` - Enforce version bumps and changelog updates
- `project-sync.yml` - Dispatched by webhook, routes column transitions to handlers
- `claude-project-trigger.yml` - Project-based trigger workflow

### Workflow Templates (`templates/workflows/`)
- `claude-code.yml` - Template for onboarded repos

## Architecture

```
GitHub Project (bto-labs)
       │ projects_v2_item webhook
       ▼
gwa-webhook pod
       │ workflow_dispatch API
       ▼
project-sync.yml (self-hosted runner)
       │ kubectl exec
       ▼
gwa-runner-0 pod (Claude sessions)
```

## Trigger Matrix

| Transition | Trigger Type | Handler |
|------------|-------------|---------|
| Todo -> Planning | Claude | start-planning |
| Planning -> In Progress | Claude | inject-prompt |
| In Progress -> QA | Playwright | run-playwright |
| QA -> Review | None | status-update |
| QA -> In Progress | Claude | resume-with-failures |
| Review -> Done | CI/CD | deploy-and-cleanup |
| Any -> Blocked | None | pause-for-question |
| Blocked -> Previous | Claude | send-answer |

## Conventions

- Self-hosted runners with `runs-on: self-hosted`
- Container image: `ghcr.io/jaybrto/gwa-runner:latest`
- Use `gh` CLI for GitHub operations where possible
- All workflow secrets via `${{ secrets.* }}`
- `timeout-minutes: 1440` for long-running Claude sessions
- Use `workflow_dispatch` for triggering from webhook
- Conditional steps based on column transition (`from`/`to`)
- `continue-on-error: true` for monitoring steps

## Environment Variables in Workflows

```yaml
env:
  REPO: ${{ github.repository }}
  DB_PATH: /home/runner/gwa.db
  GWA_DB_PATH: /home/runner/gwa.db
```

## Key Patterns

### workflow_dispatch inputs
```yaml
on:
  workflow_dispatch:
    inputs:
      handler: { required: true, type: string }
      from_column: { required: true, type: string }
      to_column: { required: true, type: string }
      item_id: { required: true, type: string }
      issue_number: { required: true, type: string }
```

### Routing by transition
```yaml
- name: "Claude: Start Planning"
  if: inputs.handler == 'start-planning'
  run: gwa-start-planning --item-id "${{ inputs.item_id }}" --issue "${{ inputs.issue_number }}"
```

### Version check enforcement
```yaml
# PR title markers to skip checks:
# [skip-version-check] - Skip version bump requirement
# [skip-changelog] - Skip changelog requirement
```

## Testing

- Validate YAML syntax with `yamllint`
- Test workflow triggers with `gh workflow run`
- Check recent runs: `gh run list --workflow=project-sync.yml --limit=5`
- View logs: `gh run view <RUN_ID> --log`
