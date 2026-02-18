#!/bin/bash
set -euo pipefail

REGISTRY="registry.bto.bar"
ORG="jaybrto"
IMAGE="github-workflow-agents"
FULL_IMAGE="${REGISTRY}/${ORG}/${IMAGE}"

# Get git SHA for tagging
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "[GWA Build] Building ${FULL_IMAGE}"
echo "[GWA Build] Tags: latest, ${GIT_SHA}, ${TIMESTAMP}"

# Ensure logged in to registry
if ! docker login "${REGISTRY}" --username "${ORG}" 2>/dev/null; then
    echo "[GWA Build] Not logged in to ${REGISTRY}"
    echo "[GWA Build] Run: echo \$GITHUB_TOKEN | docker login ${REGISTRY} -u ${ORG} --password-stdin"
    exit 1
fi

# Build with multi-platform support for K3s (amd64)
docker build \
    --platform linux/amd64 \
    --tag "${FULL_IMAGE}:latest" \
    --tag "${FULL_IMAGE}:${GIT_SHA}" \
    --tag "${FULL_IMAGE}:${TIMESTAMP}" \
    --file Dockerfile \
    .

echo "[GWA Build] Build complete. Pushing..."

docker push "${FULL_IMAGE}:latest"
docker push "${FULL_IMAGE}:${GIT_SHA}"
docker push "${FULL_IMAGE}:${TIMESTAMP}"

echo "[GWA Build] Push complete."
echo "[GWA Build] Restart StatefulSet pod to pick up new image:"
echo "  kubectl rollout restart statefulset gwa-runner"
