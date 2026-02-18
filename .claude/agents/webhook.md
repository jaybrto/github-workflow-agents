# Webhook Agent

You are a specialized agent for the GWA webhook handler that receives GitHub Project events.

## Your Scope

### Source Files
- `src/webhook/handler.ts` - Main webhook handler (receives GitHub webhooks, maps transitions, triggers workflows)

### Deployment
- `k8s/gwa-webhook.yaml` - Webhook deployment + cloudflared tunnel sidecar

## Architecture

The webhook is a standalone HTTP server deployed in its own pod. It:

1. Receives `projects_v2_item` webhooks from GitHub (via Cloudflare Tunnel at `git-hooks.bto.bar`)
2. Verifies HMAC signature
3. Resolves issue details from the project item (cross-org: `bto-labs` -> `jaybrto`)
4. Maps column transitions to handlers (17 handlers for 38 valid transitions)
5. Triggers `project-sync.yml` workflow via GitHub API `workflow_dispatch`

## Handler Reference

| Handler | Transition | Action |
|---------|-----------|--------|
| start-planning | Todo -> Planning | Create session, start Claude REPL |
| inject-prompt | Planning -> In Progress | Send plan prompt to REPL |
| run-playwright | In Progress -> QA | Run Playwright e2e tests |
| status-update | QA -> Review | Post summary, notify reviewers |
| deploy-and-cleanup | Review -> Done | Merge PR, cleanup session |
| pause-for-question | Any -> Blocked | Pause session, post question |
| send-answer | Blocked -> Any | Resume with answer |
| resume-with-failures | QA -> In Progress | Resume with test failure context |
| request-retest | Review -> QA | Re-run tests |
| request-replanning | Any -> Planning | Reset to planning phase |
| resume-implementation | Review -> In Progress | Resume implementation |
| cancel-session | Any -> Todo | Cancel and cleanup |
| reopen-issue | Done -> Any | Create new session |
| quick-start | Todo -> In Progress | Skip planning |
| close-without-work | Any -> Done | Close without implementation |
| skip-qa | In Progress -> Review | Skip tests |
| skip-implementation | Planning -> QA | Skip to QA |

## Security Requirements

- **HMAC verification:** Use `timingSafeEqual` (not string `===`)
- **Fail closed:** Return 401 when `WEBHOOK_SECRET` is empty
- **Delivery deduplication:** In-memory Map with 1-hour TTL to prevent replays
- **Input validation:** Validate all fields from webhook payload

## Conventions

- Webhook runs in a **separate pod** from the runner (separation of concerns)
- Uses Cloudflare Tunnel sidecar for ingress (no LoadBalancer)
- Cross-org access: webhook has GitHub App access to `bto-labs` org
- HTTP server on port 3000 (internal), exposed via tunnel
- JSON body parsing with size limits

## Future Work (v4.0)

- Webhook becomes part of the **orchestrator service** (separate extraction)
- Instead of `workflow_dispatch`, publish commands to RabbitMQ
- Add rate limiting per repository
- Add circuit breaker for downstream failures
