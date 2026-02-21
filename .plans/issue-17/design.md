# Issue #17: Technical Design

---

## Overview

A minimal shell script that verifies the three core health signals for a GWA deployment:
1. **Pod liveness** — `kubectl get pod gwa-runner-0`
2. **API health** — HTTP GET `$ORCHESTRATOR_URL/health`
3. **Version report** — read from `package.json` in repo root

## File: `scripts/e2e-health-check.sh`

```
scripts/
└── e2e-health-check.sh   # New script (52 lines)
```

## Design Decisions

### Check Helper Function
A shared `check(label, result)` helper normalizes output to `[PASS]` / `[FAIL]` lines and increments counters. This makes the summary section trivial.

### kubectl for Pod Status
Use `kubectl get pod gwa-runner-0 -o jsonpath='{.status.phase}'` to get raw status without parsing tabular output. Falls back to "not found" on command failure.

### curl for HTTP Health
Use `curl -s -o /dev/null -w "%{http_code}" --max-time 5` to get just the HTTP status code with a 5-second timeout. Falls back to "000" on connection failure.

### Version from package.json
Use `grep + sed` on `package.json` — no `jq` dependency required. Path derived relative to script location via `BASH_SOURCE[0]`.

### Exit Code
Exit 1 if any check failed; exit 0 on full pass. This makes the script usable in CI pipelines.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_URL` | `http://localhost:3001` | Base URL for orchestrator service |

## Dependencies

- `kubectl` — must be in PATH and configured with cluster access
- `curl` — standard system tool
- `grep`, `sed`, `cat` — standard POSIX tools
