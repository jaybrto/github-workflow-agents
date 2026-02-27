# Handoff: Phase 20/22 Completion + Terminal Relay Service

**Date:** 2026-02-17
**Branch:** `main`
**Version:** `4.0.0`
**Working tree:** Clean, up to date with origin

---

## Session Summary

### What Was Done

1. **Branch merge analysis and merge** — Checked out `claude/review-cli-github-integration-9tvfF`, verified it merges cleanly into main (only 1 un-merged docs commit), merged it. Auth detection code was already on main via PR #7.

2. **HANDOFF_AUTH_FIX.md analysis** — Confirmed all three auth detection layers (prevention, detection, notification) are fully implemented on main. No code work remaining from that handoff.

3. **Phase 20 (Terminal Streaming) completion** — Integrated `takeSnapshot()` into all XState state machine transitions via fire-and-forget async calls. Snapshots now auto-capture on every state change (idle→planning, planning→inProgress, blocked, done, error, etc.). Failures never block transitions.

4. **Phase 22 (Behavioral Tests) completion** — All 7 behavioral test files were already implemented (334 tests, 0 failures). Marked all checklist items as complete.

5. **Terminal relay WebSocket service** — Created a non-headless `ClusterIP` service (`gwa-runner-ws-relay`) on port 8080, separate from the headless StatefulSet service. Supports three connectivity paths: Cloudflare Tunnel (`terminal.bto.bar`), WARP client (direct ClusterIP), and host network. Cloudflare Tunnel route configured on `bto-services-prod`.

### Commits (this session)

| SHA | Message |
|-----|---------|
| `08b8b47` | `feat(phase20): integrate XState snapshot triggers, update checklists` |
| `a25910d` | `Merge branch 'claude/review-cli-github-integration-9tvfF'` |
| `560dc47` | `infra(k8s): add non-headless ClusterIP service for terminal relay WebSocket` |

### Files Modified

| File | Change |
|------|--------|
| `src/lib/state-machine.ts` | Added `captureTransitionSnapshot()` helper + snapshot actions on all state transitions |
| `PLAN_CHECKLIST.md` | Marked Phase 20 (20.1-20.16, 20.18-20.25) and Phase 22 (22.1-22.8) as complete |
| `HANDOFF.md` | Updated current state with completed phases |
| `PLAN.md` | Added auth troubleshooting section to Phase 11 (from branch merge) |
| `HANDOFF_AUTH_FIX.md` | New file — auth fix handoff documentation (from branch merge) |
| `docs/plans/2026-02-17-phase20-22-completion-design.md` | Design doc for Phase 20/22 work |
| `helm/gwa-runner/templates/service-ws-relay.yaml` | New Helm template for non-headless ws-relay service |
| `helm/gwa-runner/values.yaml` | Added `terminalRelay` config section (enabled, port 8080) |
| `k8s/gwa-runner-service.yaml` | Split into headless (SSH) + non-headless (ws-relay) services |

---

## Current State

### What's Working
- XState v5 state machine with snapshot triggers on all transitions
- RabbitMQ AMQP backbone (commands down, events up)
- SQLite per pod (Redis fully removed)
- Orchestrator service (webhook handler, REST API, push bridge, aggregator)
- Terminal relay code (FIFO streaming, WebSocket server, asciicast recording, MinIO upload, SVG snapshots)
- Auth detection (prevention, detection, notification — three-layer fix)
- 334 tests passing, 0 failures
- All behavioral tests (lifecycle, blocked-resume, AMQP transitions, orchestrator aggregation, concurrent sessions, cleanup artifacts, terminal integration)

### What's NOT Working / Not Deployed
- Terminal relay process is not started on the pod (no `import.meta.main` auto-start, not in entrypoint)
- `gwa-runner-ws-relay` K8s service not applied to cluster (committed but not deployed)
- `terminal.bto.bar` tunnel route configured but returns 502 (no backend running)
- Phase 21 (Android app) not started
- Phase 23 (deployment) not started

### Checklist Status
- Phase 20: All items [x] except 20.17 (Cloudflare tunnel route — configured in dashboard, not in code)
- Phase 22: All items [x]
- Phase 23: All items [ ] (next milestone)

---

## What Needs to Happen Next

### Phase 23: Deployment (Priority)

This is the deployment milestone. Key items:

1. **Terminal relay startup** — Add `import.meta.main` auto-start to `src/lib/terminal-relay.ts` and start it from the entrypoint in `helm/gwa-runner/templates/configmap.yaml` (code was written and reverted — see session notes below)

2. **Apply K8s service** — `kubectl apply -f k8s/gwa-runner-service.yaml` to create `gwa-runner-ws-relay` (or let Helm handle it)

3. **Build and push images** — `23.7` runner image, `23.8` orchestrator image

4. **Deploy to K3s** — `23.9` orchestrator, `23.10` runner

5. **End-to-end test** — `23.11` webhook → RabbitMQ → pod → MQTT → mobile + ntfy push

### Terminal Relay Startup (Reverted Code)

During this session, we wrote but reverted these changes (save for Phase 23):

**`src/lib/terminal-relay.ts`** — Add at end of file:
```typescript
if (import.meta.main) {
  const port = getWsPort();
  console.log(`[terminal-relay] Starting standalone WebSocket server...`);
  startWebSocketServer(port);
  const handleShutdown = async () => {
    console.log("[terminal-relay] Shutting down...");
    await shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}
```

**`helm/gwa-runner/templates/configmap.yaml`** — Add before `exec tail -f /dev/null`:
```bash
RELAY_BIN="/opt/gwa/gwa-terminal-relay"
if [ -x "${RELAY_BIN}" ]; then
  echo "[GWA] Starting terminal relay on port 8080..."
  WS_PORT=8080 "${RELAY_BIN}" &
  RELAY_PID=$!
  echo "[GWA] Terminal relay started (PID: ${RELAY_PID})"
fi
```

### Phase 21: Android App (Future)

Not started. 34 items in PLAN_CHECKLIST.md. Independent of other phases.

---

## Key Files

```
src/lib/state-machine.ts          # XState v5 + snapshot triggers (modified this session)
src/lib/terminal-relay.ts         # Terminal streaming (needs import.meta.main for Phase 23)
helm/gwa-runner/templates/
  service-ws-relay.yaml           # New: non-headless ClusterIP service (created this session)
  configmap.yaml                  # Entrypoint (needs relay startup for Phase 23)
  statefulset.yaml                # Pod spec
  service.yaml                    # Headless service for StatefulSet DNS
helm/gwa-runner/values.yaml       # Added terminalRelay config (modified this session)
k8s/gwa-runner-service.yaml       # Raw manifests: headless + ws-relay (modified this session)
PLAN.md                           # Full implementation plan (Phases 1-23)
PLAN_CHECKLIST.md                 # Phase checklists (updated this session)
PLAN_V4.md                        # v4.0 upgrade plan (9 phases, 154 items)
HANDOFF_AUTH_FIX.md               # Auth fix handoff (merged this session)
```

## Constraints

- **Bun + TypeScript only** — no Python
- **No hardcoded secrets** — K8s secrets only
- **SDK-first** — `@octokit/rest`, `@kubernetes/client-node`, `amqplib`, `xstate`
- **Conventional Commits** — `feat`, `fix`, `refactor`, `docs`, `test`, `infra`, `chore`
- **Pre-commit**: Always run `bun run typecheck` before committing
- **Version bumps**: Required when modifying source files
