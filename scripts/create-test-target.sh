#!/bin/bash
# Creates and initializes the gwa-test-target repository
# Usage: bash scripts/create-test-target.sh
set -euo pipefail

GITHUB_TOKEN="${GITHUB_GWA_ADMIN_PAT_CLASSIC:-${GH_TOKEN:-${GITHUB_TOKEN}}}"
REPO_OWNER="jaybrto"
REPO_NAME="gwa-test-target"

echo "Ensuring ${REPO_OWNER}/${REPO_NAME} exists..."
GH_TOKEN="$GITHUB_TOKEN" gh repo create "${REPO_OWNER}/${REPO_NAME}" \
  --public \
  --description "GWA E2E test target — simple Bun counter app" \
  2>/dev/null || echo "Repo already exists"

echo "Onboarding with GitHub Project..."
GITHUB_TOKEN="$GITHUB_TOKEN" \
  bash "$(dirname "$0")/onboard-repo.sh" "$REPO_OWNER/$REPO_NAME" 2>/dev/null || \
  echo "Note: Onboarding may require manual steps"

echo ""
echo "Done: ${REPO_OWNER}/${REPO_NAME} ready"
echo "   https://github.com/${REPO_OWNER}/${REPO_NAME}"
