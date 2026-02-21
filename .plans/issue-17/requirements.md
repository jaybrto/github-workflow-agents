# Issue #17: Requirements Analysis

**Issue**: E2E Test: Verify provision-environment deployment
**Purpose**: Verify v4.11.0 deployment with provision-environment feature works correctly

---

## Functional Requirements

| # | Requirement | Priority |
|---|-------------|----------|
| FR-1 | Script checks if `gwa-runner-0` pod is Running via `kubectl` | Must Have |
| FR-2 | Script checks orchestrator `/health` endpoint returns HTTP 200 | Must Have |
| FR-3 | Script prints current deployed version from `package.json` | Must Have |
| FR-4 | Script reports pass/fail counts and exits non-zero on failure | Must Have |
| FR-5 | Script accepts `ORCHESTRATOR_URL` env var (default: `http://localhost:3001`) | Should Have |

## Non-Functional Requirements

| # | Requirement |
|---|-------------|
| NFR-1 | Script must be executable (`chmod +x`) |
| NFR-2 | Script must be minimal — no unnecessary dependencies |
| NFR-3 | Script must use `set -euo pipefail` for safety |
| NFR-4 | Script must handle command failures gracefully (pod not found, HTTP timeout) |

## Acceptance Criteria

- [x] Script created at `scripts/e2e-health-check.sh`
- [x] Script is executable
- [x] Script runs without errors
