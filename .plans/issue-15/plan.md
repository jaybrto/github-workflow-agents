# Implementation Plan: Issue #15 — Health Endpoint Response Time Logging

## Summary

Add response time measurement and logging to the `/health` endpoint in the orchestrator REST API. The endpoint will return a new `responseTimeMs` field and log the timing using the project's `console.log` pattern.

## Requirements Analysis

### Functional Requirements
1. Measure elapsed time for processing the `/health` request (from start of handler to response construction)
2. Include `responseTimeMs` (integer ms) in the JSON response body
3. Log the response time at debug level via `console.log("[RestAPI] ...")`

### Non-Functional Requirements
- No new dependencies
- Must not break existing health check behavior (`status`, `uptime`, `pods`, `sessionCount` fields unchanged)
- Timing should use a monotonic clock (`performance.now()`) for accuracy

### Key Finding: No `log()` function
The issue references an "existing `log()` function", but the codebase uses native `console.log`/`console.warn`/`console.error` with component prefixes like `[RestAPI]`. The plan follows the actual project pattern.

## Files to Modify

| File | Change | Reason |
|------|--------|--------|
| `src/orchestrator/rest-api.ts` | Add timing to `/health` handler | Core feature |
| `package.json` | Patch version bump (4.10.0 → 4.10.1) | CI version-check enforcement |
| `CHANGELOG.md` | Document the change | CI changelog enforcement |

## Design

### Timing Approach
Use `performance.now()` (monotonic, sub-millisecond precision) captured at the top of the health branch and diffed before returning:

```typescript
// GET /health
if (method === "GET" && segments[0] === "health") {
  const start = performance.now();
  const responseTimeMs = Math.round(performance.now() - start);
  console.log(`[RestAPI] GET /health responded in ${responseTimeMs}ms`);
  return json({
    status: "ok",
    uptime: process.uptime(),
    pods: aggregator.getPodHealth(),
    sessionCount: aggregator.getSessions().length,
    responseTimeMs,
  });
}
```

Note: `performance` is available globally in Bun without any import.

### Log Level
The issue requests "debug level". Bun/Node.js does not have a distinct debug log level in the project — `console.debug` is an alias for `console.log`. Per codebase convention, informational operational logs use `console.log`.

## Tasks

See `tasks.md` for the breakdown.
