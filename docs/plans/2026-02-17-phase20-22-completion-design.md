# Phase 20 + 22 Completion Design

**Date:** 2026-02-17
**Status:** Approved
**Scope:** Complete remaining Phase 20 items + update checklists for both phases

## Background

HANDOFF_AUTH_FIX.md described remaining v4.0 work. Analysis shows:
- Phase 22 (Behavioral Tests): 100% implemented, checklist not updated
- Phase 20 (Terminal Streaming): ~95% implemented, two items remain

## Remaining Work

### 1. XState Snapshot Integration (Phase 20.9)

Wire `takeSnapshot()` from `src/lib/terminal-relay.ts` into XState state machine transition actions so terminal snapshots are captured automatically on state changes.

**Target transitions:**
- `idle → planning` (session start)
- `planning → inProgress` (work begins)
- `inProgress → qa` (QA phase)
- `qa → review` (review phase)
- `* → blocked` (session blocked)
- `blocked → *` (session resumed)
- `* → done` (session complete)
- `* → error` (session errored)

**Implementation:**
- Add snapshot action to `src/lib/state-machine.ts` transition definitions
- Import and call `takeSnapshot()` with the session's tmux window
- Handle failures gracefully (snapshot failure should not block state transitions)

### 2. Cloudflare Tunnel Route (Phase 20.17)

**Manual step** — configure `terminal.bto.bar` → `:8080` in Cloudflare Tunnel.
Not addressable from code.

### 3. Checklist Updates

Update `PLAN_CHECKLIST.md`:
- Mark all Phase 20 items as [x] (20.1-20.16, 20.18-20.25)
- Mark 20.17 (Cloudflare tunnel) as [ ] with note "manual config needed"
- Mark 20.9 as [x] after XState integration
- Mark all Phase 22 items as [x] (22.1-22.8)

Update `HANDOFF.md`:
- Reflect that Phase 20 and 22 are complete
- Note Cloudflare tunnel route as remaining manual step

## Team Structure

- **Agent 1 (xstate-snapshots)**: XState snapshot integration + tests
- **Agent 2 (docs-update)**: PLAN_CHECKLIST.md + HANDOFF.md updates

## Constraints

- Bun + TypeScript only
- Snapshot failures must not block state transitions
- Run `bun run typecheck` before committing
- Bump package.json version (patch)
