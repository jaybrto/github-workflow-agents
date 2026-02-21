#!/bin/bash
# GWA E2E Health Check
# Verifies core GWA components are running and healthy
#
# Usage: bash scripts/e2e-health-check.sh
# Env: ORCHESTRATOR_URL (default: http://localhost:3001)
set -euo pipefail

ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3001}"
PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "ok" ]; then
    echo "[PASS] $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label — $result"
    FAIL=$((FAIL + 1))
  fi
}

# 1. Check gwa-runner-0 pod is running
POD_STATUS=$(kubectl get pod gwa-runner-0 -o jsonpath='{.status.phase}' 2>/dev/null || echo "not found")
if [ "$POD_STATUS" = "Running" ]; then
  check "gwa-runner-0 pod is Running" "ok"
else
  check "gwa-runner-0 pod is Running" "pod status: $POD_STATUS"
fi

# 2. Check orchestrator /health endpoint
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${ORCHESTRATOR_URL}/health" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  check "Orchestrator /health returns 200" "ok"
else
  check "Orchestrator /health returns 200" "HTTP $HTTP_STATUS from ${ORCHESTRATOR_URL}/health"
fi

# 3. Print deployed version from package.json
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(cat "$REPO_ROOT/package.json" | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
echo ""
echo "Deployed version: $VERSION"

# Summary
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
