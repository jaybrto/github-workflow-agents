#!/usr/bin/env bash
#
# GWA Onboarding Script
# Onboards a new repository to the GitHub Workflow Agents system
#
# Usage: ./scripts/onboard-repo.sh owner/repo [--dry-run]
#
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Files
APPLICATIONSET_FILE="$ROOT_DIR/argocd/applicationset.yaml"
WORKFLOW_TEMPLATE="$ROOT_DIR/templates/workflows/claude-code.yml"

# Parse arguments
DRY_RUN=false
REPO=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 owner/repo [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --dry-run    Show what would be done without making changes"
      echo "  -h, --help   Show this help message"
      exit 0
      ;;
    *)
      REPO="$1"
      shift
      ;;
  esac
done

# Validate repo argument
if [[ -z "$REPO" ]]; then
  echo -e "${RED}Error: Repository argument required${NC}"
  echo "Usage: $0 owner/repo [--dry-run]"
  exit 1
fi

# Parse owner and name
REPO_OWNER="${REPO%%/*}"
REPO_NAME="${REPO##*/}"

if [[ "$REPO_OWNER" == "$REPO_NAME" ]] || [[ -z "$REPO_OWNER" ]] || [[ -z "$REPO_NAME" ]]; then
  echo -e "${RED}Error: Invalid repository format. Use 'owner/repo'${NC}"
  exit 1
fi

# Generate derived names
SANITIZED_NAME=$(echo "${REPO_OWNER}-${REPO_NAME}" | tr '[:upper:]' '[:lower:]' | tr '/_' '-' | cut -c1-63)
GWA_NAMESPACE="gwa-${SANITIZED_NAME}"
GWA_POD="${GWA_NAMESPACE}-0"

echo -e "${BLUE}=== GWA Onboarding ===${NC}"
echo ""
echo -e "Repository:  ${GREEN}${REPO}${NC}"
echo -e "Owner:       ${REPO_OWNER}"
echo -e "Name:        ${REPO_NAME}"
echo -e "Namespace:   ${GWA_NAMESPACE}"
echo -e "Pod Name:    ${GWA_POD}"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${YELLOW}DRY RUN MODE - No changes will be made${NC}"
  echo ""
fi

# Check prerequisites
echo -e "${BLUE}Checking prerequisites...${NC}"

if ! command -v gh &> /dev/null; then
  echo -e "${RED}Error: gh CLI not found. Install from https://cli.github.com/${NC}"
  exit 1
fi

# yq is preferred but not required - we'll use grep fallback
USE_YQ=false
if command -v yq &> /dev/null; then
  USE_YQ=true
fi

# Check gh auth
if ! gh auth status &> /dev/null; then
  echo -e "${RED}Error: Not authenticated with gh CLI. Run 'gh auth login'${NC}"
  exit 1
fi

# Check repo access
echo "Checking access to ${REPO}..."
if ! gh repo view "$REPO" &> /dev/null; then
  echo -e "${RED}Error: Cannot access repository ${REPO}${NC}"
  exit 1
fi

echo -e "${GREEN}Prerequisites OK${NC}"
echo ""

# Check if repo already onboarded
echo -e "${BLUE}Checking if already onboarded...${NC}"
if [[ "$USE_YQ" == "true" ]]; then
  EXISTING=$(yq eval ".spec.generators[0].list.elements[] | select(.repoOwner == \"${REPO_OWNER}\" and .repoName == \"${REPO_NAME}\")" "$APPLICATIONSET_FILE")
else
  # Fallback: grep for the repo entry
  if grep -q "repoOwner: ${REPO_OWNER}" "$APPLICATIONSET_FILE" && grep -q "repoName: ${REPO_NAME}" "$APPLICATIONSET_FILE"; then
    EXISTING="found"
  else
    EXISTING=""
  fi
fi
if [[ -n "$EXISTING" ]]; then
  echo -e "${YELLOW}Warning: Repository ${REPO} is already in applicationset.yaml${NC}"
  echo "Continuing to update workflow file..."
else
  echo "Repository not yet onboarded"
fi

echo ""

# Step 1: Add to ApplicationSet
echo -e "${BLUE}Step 1: Adding to ArgoCD ApplicationSet${NC}"

if [[ -z "$EXISTING" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "Would add entry to $APPLICATIONSET_FILE:"
    echo "  - repoOwner: ${REPO_OWNER}"
    echo "    repoName: ${REPO_NAME}"
  else
    if [[ "$USE_YQ" == "true" ]]; then
      # Use yq to add the new entry
      yq eval -i ".spec.generators[0].list.elements += [{\"repoOwner\": \"${REPO_OWNER}\", \"repoName\": \"${REPO_NAME}\"}]" "$APPLICATIONSET_FILE"
    else
      # Fallback: use sed to insert before the comment line
      # Find the line with "# Add more repos here:" and insert before it
      ENTRY="          - repoOwner: ${REPO_OWNER}\n            repoName: ${REPO_NAME}"
      sed -i.bak "/# Add more repos here:/i\\
${ENTRY}
" "$APPLICATIONSET_FILE"
      rm -f "${APPLICATIONSET_FILE}.bak"
    fi
    echo -e "${GREEN}Added to applicationset.yaml${NC}"
  fi
else
  echo "Skipping (already exists)"
fi

echo ""

# Step 2: Create workflow file for target repo
echo -e "${BLUE}Step 2: Creating workflow file for target repo${NC}"

WORKFLOW_CONTENT=$(cat "$WORKFLOW_TEMPLATE" | \
  sed "s/__GWA_POD__/${GWA_POD}/g" | \
  sed "s/__GWA_NAMESPACE__/${GWA_NAMESPACE}/g")

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Would create .github/workflows/claude-code.yml in ${REPO} with:"
  echo "---"
  echo "$WORKFLOW_CONTENT" | head -20
  echo "..."
else
  # Create a temporary file
  TEMP_FILE=$(mktemp)
  echo "$WORKFLOW_CONTENT" > "$TEMP_FILE"

  # Push to target repo using gh
  # First check if workflows dir exists
  if gh api "repos/${REPO}/contents/.github/workflows" &> /dev/null; then
    echo "Workflows directory exists"
  else
    echo "Creating .github/workflows directory..."
  fi

  # Check if file already exists
  if gh api "repos/${REPO}/contents/.github/workflows/claude-code.yml" &> /dev/null; then
    echo -e "${YELLOW}Workflow file already exists, updating...${NC}"
    # Get the SHA for update
    SHA=$(gh api "repos/${REPO}/contents/.github/workflows/claude-code.yml" --jq '.sha')
    gh api -X PUT "repos/${REPO}/contents/.github/workflows/claude-code.yml" \
      -f message="feat(ci): update GWA workflow for multi-repo support" \
      -f content="$(base64 -i "$TEMP_FILE")" \
      -f sha="$SHA" > /dev/null
  else
    gh api -X PUT "repos/${REPO}/contents/.github/workflows/claude-code.yml" \
      -f message="feat(ci): add GWA workflow for Claude Code automation" \
      -f content="$(base64 -i "$TEMP_FILE")" > /dev/null
  fi

  rm "$TEMP_FILE"
  echo -e "${GREEN}Workflow file created/updated in ${REPO}${NC}"
fi

echo ""

# Step 3: Remind about secrets
echo -e "${BLUE}Step 3: Configure secrets${NC}"
echo ""
echo "You need to set the following secret in ${REPO}:"
echo ""
echo -e "  ${YELLOW}GWA_KUBECONFIG${NC} - Base64-encoded kubeconfig for cluster access"
echo ""
echo "Set it via GitHub UI or:"
echo "  gh secret set GWA_KUBECONFIG -R ${REPO} < <(base64 ~/.kube/config)"
echo ""

# Summary
echo -e "${GREEN}=== Onboarding Complete ===${NC}"
echo ""
echo "Next steps:"
echo "1. Commit and push the applicationset.yaml changes to this repo"
echo "2. Wait for ArgoCD to sync (creates namespace and deploys pods)"
echo "3. Create the gwa-secrets secret in namespace ${GWA_NAMESPACE}:"
echo ""
echo "   kubectl create secret generic gwa-secrets \\"
echo "     --namespace ${GWA_NAMESPACE} \\"
echo "     --from-literal=claude-oauth-token=<your-claude-token> \\"
echo "     --from-literal=github-token=<your-github-token>"
echo ""
echo "4. Set GWA_KUBECONFIG secret in ${REPO}"
echo ""
echo "Then PRs in ${REPO} will trigger Claude Code automation!"
