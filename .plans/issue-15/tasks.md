# Tasks: Issue #15 — Health Endpoint Response Time Logging

## Task Graph

```
Task 1: Modify health endpoint
    ↓
Task 2: Bump package version  ←─ (parallel with Task 3)
Task 3: Update CHANGELOG.md   ←─ (parallel with Task 2)
    ↓
Task 4: Type-check & verify
```

---

## Task 1 — Modify `/health` handler (CORE)

**File:** `src/orchestrator/rest-api.ts`

**What to do:**
1. At the top of the `GET /health` branch (line ~52), record `const start = performance.now()`
2. Before calling `json(...)`, compute `const responseTimeMs = Math.round(performance.now() - start)`
3. Log: `console.log(\`[RestAPI] GET /health responded in ${responseTimeMs}ms\`)`
4. Add `responseTimeMs` field to the returned JSON object

**Expected diff (conceptual):**
```typescript
// GET /health
if (method === "GET" && segments[0] === "health") {
+ const start = performance.now();
+ const responseTimeMs = Math.round(performance.now() - start);
+ console.log(`[RestAPI] GET /health responded in ${responseTimeMs}ms`);
  return json({
    status: "ok",
    uptime: process.uptime(),
    pods: aggregator.getPodHealth(),
    sessionCount: aggregator.getSessions().length,
+   responseTimeMs,
  });
}
```

**Acceptance criteria:**
- [ ] `GET /health` response body includes `responseTimeMs` as an integer
- [ ] A `console.log` line is emitted with the timing
- [ ] All existing fields (`status`, `uptime`, `pods`, `sessionCount`) remain present

---

## Task 2 — Version bump (can run in parallel with Task 3)

**File:** `package.json`

**What to do:**
- Change `"version": "4.10.0"` → `"version": "4.10.1"` (patch bump — no API change, small additive feature)

**Acceptance criteria:**
- [ ] Version field updated to `4.10.1`

---

## Task 3 — CHANGELOG update (can run in parallel with Task 2)

**File:** `CHANGELOG.md`

**What to do:**
- Add an entry under the `[Unreleased]` section (or create a new version section for 4.10.1) describing the change:

```markdown
## [4.10.1] - 2026-02-20

### Added
- Health endpoint (`GET /health`) now returns `responseTimeMs` field with request processing time in milliseconds and logs it at info level
```

**Acceptance criteria:**
- [ ] CHANGELOG.md updated with entry for version 4.10.1

---

## Task 4 — Type-check & verify (MUST run after Task 1)

**Command:**
```bash
bun run typecheck
```

**Acceptance criteria:**
- [ ] `bun run typecheck` exits with code 0
- [ ] No new TypeScript errors introduced
