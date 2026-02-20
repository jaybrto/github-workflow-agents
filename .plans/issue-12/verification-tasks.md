# Verification Tasks

Since this is a test issue, all tasks are verification steps (not implementation). They can be run in parallel except where noted.

## Task 1: Confirm Webhook Dispatch (no dependencies)

**Goal:** Verify the orchestrator received and processed the GitHub issue creation event.

**Steps:**
1. Check orchestrator logs for `[WebhookHandler]` entries for issue #12
2. Confirm AMQP message published to `gwa.commands.work`
3. Verify no deduplication collision

**Pass criteria:** Log entry shows issue #12 dispatched to runner queue.

---

## Task 2: Confirm Provisioning Succeeded (no dependencies)

**Goal:** Verify `gwa-provision` ran successfully at pod startup.

**Steps:**
1. Check runner pod logs for `[Provision]` entries
2. Confirm `status: provisioned` response from orchestrator
3. Verify `.claude/.credentials.json` exists on the runner

**Pass criteria:**
- Log shows `[Provision] Environment provisioned (bundle <uuid>)`
- Log shows `[Provision] Credentials file verified`

---

## Task 3: Confirm Claude Started with Credentials (depends on Task 2)

**Goal:** Verify Claude Code used the provisioned credentials.

**Steps:**
1. Check Claude session logs for successful authentication
2. Confirm no `401 Unauthorized` errors from Anthropic API
3. Verify session state machine reached `Planning` state

**Pass criteria:** Claude Code session active, no auth errors.

---

## Task 4: Confirm Planning Comment Posted (depends on Task 3)

**Goal:** Verify this planning comment was posted to issue #12.

**Steps:**
1. Check GitHub issue #12 for comment from `github-actions[bot]` or runner user
2. Confirm comment contains plan summary

**Pass criteria:** Comment visible on issue #12 with plan content.

---

## Task 5: Close Issue (depends on Tasks 1-4)

**Goal:** Mark issue as verified and close it.

**Steps:**
```bash
gh issue close 12 --repo jaybrto/github-workflow-agents \
  --comment "E2E provisioning verified successfully. Closing."
```

**Pass criteria:** Issue closed with verification note.

---

## Dependency Graph

```
Task 1 ──────────────────────────────────┐
Task 2 ──→ Task 3 ──→ Task 4 ──→ Task 5 ─┘
```

Tasks 1 and 2 run in parallel. Task 3 waits for Task 2. Task 5 waits for all.
