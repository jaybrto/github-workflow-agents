---
name: setup-vault-eso
description: Setup Vault + External Secrets Operator for GWA secret management. Migrates from manual K8s secrets to Vault-backed auto-rotating secrets.
---

# Setup: Vault + External Secrets Operator for GWA

## Prerequisites

- Vault server running and accessible from K3s cluster
- Vault Kubernetes auth backend already enabled and configured
- `vault` CLI authenticated with sufficient permissions
- `kubectl` configured for the K3s cluster
- `helm` v3 installed

## Step 1: Install External Secrets Operator

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update

helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --set installCRDs=true \
  --wait
```

Verify:
```bash
kubectl -n external-secrets get pods
# All pods should be Running
```

## Step 2: Create Vault Policy

Create a policy that allows reading GWA secrets:

```bash
vault policy write gwa-reader - <<'EOF'
# Read GWA runner secrets (OAuth token, GitHub token, account metadata)
path "secret/data/gwa" {
  capabilities = ["read"]
}

# Read GWA webhook secrets (GitHub app secret)
path "secret/data/gwa-webhook" {
  capabilities = ["read"]
}
EOF
```

## Step 3: Create Vault Kubernetes Auth Role

Map the K8s service account(s) to the Vault policy. The `default` service account in the `default` namespace is used by ESO:

```bash
vault write auth/kubernetes/role/gwa-runner \
  bound_service_account_names=default,gwa-runner \
  bound_service_account_namespaces=default \
  policies=gwa-reader \
  ttl=1h
```

## Step 4: Store Secrets in Vault

**All sensitive values are read from `.env`.** Copy `.env-sample` to `.env` and fill in your values before running these commands.

### GWA runner secrets

```bash
# Source .env to load sensitive values
source .env

# Store all GWA secrets in a single KV path
vault kv put secret/gwa \
  claude-oauth-token="${CLAUDE_CODE_OAUTH_TOKEN}" \
  github-token="${GITHUB_TOKEN}" \
  oauth-account-uuid="${CLAUDE_OAUTH_ACCOUNT_UUID}" \
  oauth-email="${CLAUDE_OAUTH_EMAIL}" \
  oauth-org-uuid="${CLAUDE_OAUTH_ORG_UUID}"
```

### GWA webhook secrets

```bash
source .env

vault kv put secret/gwa-webhook \
  github-app-secret="${GITHUB_APP_SECRET}"
```

Verify:
```bash
vault kv get secret/gwa
vault kv get secret/gwa-webhook
```

## Step 5: Apply K8s Manifests

### Apply the ExternalSecret resources

```bash
kubectl apply -f k8s/vault-external-secrets.yaml
```

### Verify the secrets were created

```bash
# Check ExternalSecret status
kubectl get externalsecrets -n default
# STATUS should be "SecretSynced"

# Verify K8s secrets were created with correct keys
kubectl get secret gwa-secrets -o jsonpath='{.data}' | jq 'keys'
# Should show: claude-oauth-token, github-token, oauth-account-uuid, oauth-email, oauth-org-uuid

kubectl get secret gwa-webhook-secrets -o jsonpath='{.data}' | jq 'keys'
# Should show: github-app-secret
```

### Apply updated StatefulSet (adds new env vars)

```bash
kubectl apply -f k8s/gwa-runner-statefulset.yaml
kubectl rollout restart statefulset gwa-runner
kubectl rollout status statefulset gwa-runner
```

## Step 6: Delete Old Manual Secrets

Only after verifying everything works:

```bash
# The ExternalSecrets now own these secrets — old manual ones are replaced
# Verify pods are running with new secrets:
kubectl exec gwa-runner-0 -- env | grep -E "CLAUDE_|GITHUB_TOKEN"
```

## Step 7: Verify Auto-Rotation

Test that secret rotation works without pod restarts:

```bash
# 1. Update a secret in Vault (use value from .env or paste directly)
vault kv patch secret/gwa claude-oauth-token="${CLAUDE_CODE_OAUTH_TOKEN}"

# 2. Wait for refresh interval (5 minutes) or force sync
kubectl annotate externalsecret gwa-secrets force-sync=$(date +%s) --overwrite

# 3. Verify K8s secret was updated
kubectl get secret gwa-secrets -o jsonpath='{.data.claude-oauth-token}' | base64 -d

# 4. Restart pod to pick up new env vars
# NOTE: K8s env vars are set at pod start — rotation requires restart
kubectl rollout restart statefulset gwa-runner
```

### Important: Env Var Rotation Limitation

K8s injects env vars at pod startup. When ESO updates the K8s Secret, running pods still have the old values. To pick up rotated secrets, either:

1. **Restart the pod** after Vault update: `kubectl rollout restart statefulset gwa-runner`
2. **Use Reloader** (optional): Install [stakater/Reloader](https://github.com/stakater/Reloader) to auto-restart pods when secrets change:
   ```bash
   helm repo add stakater https://stakater.github.io/stakater-charts
   helm install reloader stakater/reloader --namespace default
   ```
   Then add annotation to the StatefulSet:
   ```yaml
   metadata:
     annotations:
       reloader.stakater.com/auto: "true"
   ```

## Troubleshooting

### ExternalSecret stuck in "SecretSyncedError"

```bash
# Check ESO controller logs
kubectl -n external-secrets logs -l app.kubernetes.io/name=external-secrets

# Check ExternalSecret events
kubectl describe externalsecret gwa-secrets
```

Common causes:
- Vault role doesn't match service account: check `bound_service_account_names`
- Vault path wrong: ESO uses `secret/data/gwa` (v2 KV adds `data/` prefix)
- Vault server unreachable: check `vault.server` in ClusterSecretStore

### Verify Vault auth from inside cluster

```bash
kubectl run vault-test --rm -it --image=vault:latest -- sh -c '
  export VAULT_ADDR=http://vault.vault.svc.cluster.local:8200
  vault login -method=kubernetes role=gwa-runner
  vault kv get secret/gwa
'
```

### Check ClusterSecretStore connectivity

```bash
kubectl get clustersecretstore vault-backend -o jsonpath='{.status}'
```

## File Reference

| File | Purpose |
|------|---------|
| `k8s/vault-external-secrets.yaml` | ClusterSecretStore + ExternalSecret CRDs |
| `k8s/gwa-runner-statefulset.yaml` | Updated with `CLAUDE_OAUTH_*` env vars |
| `src/lib/claude.ts` | `preloadClaudeConfig()` reads env vars, writes Claude config files |
