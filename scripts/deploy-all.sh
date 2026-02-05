#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
K8S_DIR="${PROJECT_DIR}/k8s"

echo "[GWA Deploy] Deploying GitHub Workflow Agents to K3s"
echo "[GWA Deploy] Project: ${PROJECT_DIR}"
echo "[GWA Deploy] K8s manifests: ${K8S_DIR}"
echo

# Check kubectl access
if ! kubectl cluster-info &>/dev/null; then
    echo "[GWA Deploy] ERROR: Cannot connect to Kubernetes cluster"
    exit 1
fi

echo "[GWA Deploy] Cluster connection OK"
echo

# Deploy in order (dependencies first)
echo "[GWA Deploy] Step 1: StorageClass"
kubectl apply -f "${K8S_DIR}/longhorn-claude-storageclass.yaml"

echo "[GWA Deploy] Step 2: ConfigMap"
kubectl apply -f "${K8S_DIR}/gwa-runner-configmap.yaml"

echo "[GWA Deploy] Step 3: Service"
kubectl apply -f "${K8S_DIR}/gwa-runner-service.yaml"

echo "[GWA Deploy] Step 4: StatefulSet"
kubectl apply -f "${K8S_DIR}/gwa-runner-statefulset.yaml"

echo "[GWA Deploy] Step 5: Cleanup RBAC"
kubectl apply -f "${K8S_DIR}/gwa-cleanup-rbac.yaml"

echo "[GWA Deploy] Step 6: Cleanup CronJob"
kubectl apply -f "${K8S_DIR}/gwa-cleanup-cronjob.yaml"

echo
echo "[GWA Deploy] All manifests applied."
echo "[GWA Deploy] Checking pod status..."
echo

# Wait for pod to be created
sleep 2
kubectl get pods -l app=github-workflow-agents

echo
echo "[GWA Deploy] To watch pod startup:"
echo "  kubectl logs -f gwa-runner-0"
echo
echo "[GWA Deploy] To restart with new image:"
echo "  kubectl rollout restart statefulset gwa-runner"
