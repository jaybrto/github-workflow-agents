#!/bin/bash
# GWA Live End-to-End Test
# Creates a GitHub issue in gwa-test-target and monitors GWA processing it
# Auto-resets test state on completion or failure
#
# Usage: bash scripts/e2e-live-test.sh
# Env: GITHUB_TOKEN (or GITHUB_GWA_ADMIN_PAT_CLASSIC), ORCHESTRATOR_URL (optional)
set -euo pipefail

TARGET_REPO="jaybrto/gwa-test-target"
GITHUB_TOKEN="${GITHUB_GWA_ADMIN_PAT_CLASSIC:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
ORCHESTRATOR_URL="${ORCHESTRATOR_URL:-http://localhost:3001}"
LABEL="gwa-e2e-test"

cleanup() {
  echo ""
  echo "Cleaning up test state..."
  # Close any open test issues/PRs with the e2e label
  GH_TOKEN="$GITHUB_TOKEN" gh issue list \
    --repo "$TARGET_REPO" \
    --label "$LABEL" \
    --json number --jq '.[].number' 2>/dev/null | \
    xargs -I{} GH_TOKEN="$GITHUB_TOKEN" gh issue close {} \
      --repo "$TARGET_REPO" 2>/dev/null || true
  echo "Cleanup complete"
}
trap cleanup EXIT

# Ensure label exists
GH_TOKEN="$GITHUB_TOKEN" gh label create "$LABEL" \
  --repo "$TARGET_REPO" \
  --color "0075ca" \
  --description "GWA automated E2E test issue" \
  2>/dev/null || true

echo "Creating E2E test issue..."
ISSUE_URL=$(GH_TOKEN="$GITHUB_TOKEN" gh issue create \
  --repo "$TARGET_REPO" \
  --title "E2E Test: Add reset confirmation $(date +%s)" \
  --body "Add a \`resetAndLog()\` function to index.ts that resets the counter and logs the reset time. This is an automated GWA E2E test." \
  --label "$LABEL" 2>/dev/null)

ISSUE_NUMBER=$(echo "$ISSUE_URL" | grep -oE '[0-9]+$')
echo "Created issue #${ISSUE_NUMBER}: $ISSUE_URL"

echo ""
echo "Checking orchestrator for session activity..."
SESSION=$(curl -s --max-time 5 "${ORCHESTRATOR_URL}/sessions" 2>/dev/null || echo "[]")
echo "Active sessions: $SESSION"

echo ""
echo "Live E2E test script complete"
echo ""
echo "Next steps:"
echo "  1. Move issue #${ISSUE_NUMBER} to 'Planning' column on GitHub Project board"
echo "  2. Watch GWA process it: kubectl logs -f -n default statefulset/gwa-runner"
echo "  3. Monitor state: curl ${ORCHESTRATOR_URL}/sessions"
echo "  4. Check RabbitMQ events: https://rabbitmq.bto.bar"
echo "  5. Check Grafana traces: https://grafana.bto.bar"
