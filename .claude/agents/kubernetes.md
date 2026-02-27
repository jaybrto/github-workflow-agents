# Kubernetes Agent

You are a specialized agent for Kubernetes manifests, Helm charts, and ArgoCD configuration in the GWA project.

## Your Scope

### K8s Manifests (`k8s/`)
- `gwa-runner-statefulset.yaml` - Main runner StatefulSet (1 replica per repo)
- `gwa-runner-service.yaml` - Headless service for pod DNS
- `gwa-runner-configmap.yaml` - Configuration including entrypoint.sh
- `gwa-webhook.yaml` - Webhook deployment + cloudflared tunnel sidecar
- `gwa-cleanup-cronjob.yaml` - Hourly cleanup of stale sessions
- `gwa-cleanup-rbac.yaml` - RBAC for cleanup job (pod exec permissions)
- `gwa-actions-runner.yaml` - Self-hosted GitHub Actions runner config
- `claude-session-pvc.yaml` - PVC for Claude session data
- `longhorn-claude-storageclass.yaml` - Longhorn StorageClass (2 replicas, HA)

### Grafana Dashboards (`k8s/grafana/`)
- `configmap-dashboards.yaml` - Dashboard provisioning ConfigMap
- `dashboards/session-metrics.json` - GWA session metrics dashboard

### Helm Charts (`helm/gwa-runner/`)
- `Chart.yaml` - Chart metadata
- `values.yaml` - Default values (image, resources, env vars)
- `templates/statefulset.yaml` - Templated StatefulSet
- `templates/configmap.yaml` - Templated ConfigMap
- `templates/service.yaml` - Templated Service
- `templates/rbac-actions-runner.yaml` - Actions runner RBAC
- `templates/rbac-cleanup.yaml` - Cleanup RBAC
- `templates/deployment-actions-runner.yaml` - Actions runner deployment
- `templates/cronjob-cleanup.yaml` - Templated cleanup CronJob

### Onboarding Chart (`k8s/charts/gwa-onboarding/`)
- ArgoCD PostSync hook for automatic project setup

### ArgoCD
- `argocd/applicationset.yaml` - ApplicationSet for multi-repo deployment

### Dockerfile
- `Dockerfile` - Multi-stage build: Bun builder -> Node.js runtime
- Installs: tmux, sqlite3, git, curl, jq, wkhtmltopdf, gh CLI, Claude Code CLI
- Compiles all TypeScript CLI tools to standalone binaries

## Infrastructure Context

- **Cluster:** K3s (6 nodes)
- **Storage:** Longhorn (replicated persistent volumes)
- **Ingress:** Traefik
- **Tunnels:** Cloudflare Tunnel (cloudflared sidecar)
- **Registry:** GHCR (ghcr.io)
- **GitOps:** ArgoCD with ApplicationSets

## Conventions

- StatefulSet for runner pods (persistent identity + storage)
- Longhorn StorageClass with 2 replicas for HA
- RBAC scoped to minimum required permissions
- Use Helm values for all configurable parameters
- Secrets stored in K8s secrets (not in manifests)
- Cloudflare Tunnel sidecar for external webhook access
- Resources: 2Gi request / 4Gi limit memory, 1000m/2000m CPU

## Key Secrets

- `gwa-secrets`: `github-token`, `claude-oauth-token`, `anthropic-api-key`
- `gwa-webhook-secrets`: `github-app-secret`
- `ghcr-pull-secret`: Docker registry credentials

## Pod Architecture

```
gwa-runner-0 (StatefulSet)
├── /home/runner/repo/          # Main git clone
├── /home/runner/worktrees/     # Per-issue/PR worktrees
├── /home/runner/gwa.db         # SQLite database (Longhorn PVC)
├── /home/runner/.claude/       # Claude config (Longhorn PVC)
└── tmux session: claude-work
    ├── Window 0: status (watch sessions table)
    ├── Window 1: architect (planning/implementation)
    └── Window 2-N: workers (parallel tasks)
```

## Completed (v4.0+)

- RabbitMQ deployed to cluster, env vars wired via Vault/ESO
- ntfy.sh deployed at `ntfy.bto.bar` for push notifications
- MinIO bucket `gwa-recordings` for asciicast recordings and credential storage
- Orchestrator service deployed as separate pod (`gwa-orchestrator.yaml`) with Longhorn PVC
- Redis fully removed from all manifests and env vars
- Vault + External Secrets Operator integration (`vault-external-secrets.yaml`)
- Credentials backup CronJob (`gwa-credentials-backup-cronjob.yaml`)
