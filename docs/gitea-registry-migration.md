# Migrating from GHCR to Internal Gitea Container Registry

This guide documents the complete migration from GitHub Container Registry (GHCR) to the internal Gitea Docker registry running on K3s. It covers the CI pipeline changes, K8s manifest updates, TLS proxy setup, node-level containerd configuration, and the Traefik ingress required to make the Docker v2 auth flow work end-to-end.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Prerequisites](#prerequisites)
3. [Understanding the Docker v2 Auth Flow](#understanding-the-docker-v2-auth-flow)
4. [Step 1: Create Gitea Registry Credentials](#step-1-create-gitea-registry-credentials)
5. [Step 2: Create K8s Secrets for Push and Pull](#step-2-create-k8s-secrets-for-push-and-pull)
6. [Step 3: Deploy the TLS Auth Proxy](#step-3-deploy-the-tls-auth-proxy)
7. [Step 4: Create Traefik HTTPS Ingress](#step-4-create-traefik-https-ingress)
8. [Step 5: Configure K3s Node Registries](#step-5-configure-k3s-node-registries)
9. [Step 6: Update K8s Manifests](#step-6-update-k8s-manifests)
10. [Step 7: Update the CI Pipeline](#step-7-update-the-ci-pipeline)
11. [Step 8: Update RBAC](#step-8-update-rbac)
12. [Step 9: Verify Everything Works](#step-9-verify-everything-works)
13. [Troubleshooting](#troubleshooting)
14. [Key Gotchas and Lessons Learned](#key-gotchas-and-lessons-learned)

---

## Architecture Overview

```
                        PUSH (CI / Kaniko)
                        ==================
  Kaniko Pod
    |
    |---(push)---> gitea-http.gitea-system.svc.cluster.local:3000 (HTTP, internal)
    |                    ^
    |                    | (--insecure-registry, no TLS needed for push target)
    |
    |---(auth token)--> gitea-auth-proxy ClusterIP:443 (HTTPS, self-signed cert)
                              |
                              +--(proxy_pass)--> gitea-http:3000 (HTTP, internal)
                         (hostAliases maps gitea.k3s.bto.bar -> proxy ClusterIP)
                         (SSL_CERT_FILE trusts the self-signed CA)


                        PULL (K8s kubelet / containerd)
                        ==============================
  K8s Node (containerd)
    |
    |---(pull)---> registry.bto.bar:443 (HTTPS, via Caddy on router)
    |                    |
    |                    +--(proxy_pass)--> gitea-http:3000 (internal)
    |
    |---(auth token)--> gitea.k3s.bto.bar:443 (HTTPS, via Traefik)
                              |
                              +--(ingress)--> gitea-http:3000 (internal)
                         (registries.yaml: insecure_skip_verify=true)
```

**Why two different paths?**

- **Push (Kaniko):** Runs as a K8s pod, can resolve cluster DNS. Pushes to the internal Gitea service over HTTP. The auth token endpoint (`gitea.k3s.bto.bar`) is reached via an in-cluster nginx proxy with a self-signed cert.
- **Pull (containerd):** Runs on the K8s node host, cannot resolve cluster DNS (`*.svc.cluster.local`). Pulls from `registry.bto.bar` (external Caddy proxy). The auth token endpoint goes through Traefik with TLS skip.

---

## Prerequisites

- Gitea instance with Docker container registry enabled
- K3s cluster with Traefik ingress controller
- External reverse proxy (Caddy) serving `registry.bto.bar` and forwarding to Gitea
- `kubectl` access to the cluster
- Gitea user/token with push access to the target organization

### DNS Records

| Hostname | Resolves To | Purpose |
|----------|-------------|---------|
| `registry.bto.bar` | `10.0.0.1` (Caddy/router) | External registry URL for image references |
| `gitea.k3s.bto.bar` | `10.0.0.201` (Traefik LB) | Gitea ROOT_URL, used in auth realm redirects |
| `gitea-http.gitea-system.svc.cluster.local` | ClusterIP | Internal Gitea service (HTTP, port 3000) |

---

## Understanding the Docker v2 Auth Flow

This is the critical piece that makes the entire migration complex. When a Docker client (Kaniko, containerd) interacts with a registry:

```
1. Client --> Registry:  GET /v2/org/repo/manifests/latest
2. Registry --> Client:  401 Unauthorized
                         Www-Authenticate: Bearer realm="https://gitea.k3s.bto.bar/v2/token",
                                                  service="container_registry",
                                                  scope="repository:org/repo:pull"
3. Client --> Token URL:  GET https://gitea.k3s.bto.bar/v2/token?scope=...&service=...
                          Authorization: Basic <base64(user:password)>
4. Token URL --> Client:  200 OK  {"token": "eyJhbG..."}
5. Client --> Registry:   GET /v2/org/repo/manifests/latest
                          Authorization: Bearer eyJhbG...
6. Registry --> Client:   200 OK (manifest data)
```

**The auth realm URL (`gitea.k3s.bto.bar`) is controlled by Gitea's `ROOT_URL` setting and cannot be changed per-request.** This means:

- Even if you push to the internal HTTP service, the token endpoint is always `https://gitea.k3s.bto.bar/v2/token`
- Kaniko's `--skip-tls-verify-registry` and `--insecure-registry` flags do NOT apply to the token endpoint
- The token endpoint must be reachable over HTTPS with a trusted (or skipped) certificate

---

## Step 1: Create Gitea Registry Credentials

In Gitea, create a dedicated user or generate an access token with registry push/pull permissions.

**Values needed:**
```
GITEA_USERNAME=registry-user
GITEA_TOKEN=<gitea-access-token>
```

Verify the token works:
```bash
# Test v2 endpoint
curl -sk -u "$GITEA_USERNAME:$GITEA_TOKEN" "https://registry.bto.bar/v2/"

# Test token endpoint
curl -sk -u "$GITEA_USERNAME:$GITEA_TOKEN" \
  "https://gitea.k3s.bto.bar/v2/token?service=container_registry&scope=*"
# Should return: {"token": "eyJhbG..."}
```

---

## Step 2: Create K8s Secrets for Push and Pull

### Push Secret (used by Kaniko in CI pipeline)

The push secret needs entries for both the internal push target AND the auth realm host:

```bash
# Build the dockerconfigjson with dual entries
AUTH=$(echo -n "$GITEA_USERNAME:$GITEA_TOKEN" | base64)
INTERNAL_HOST="gitea-http.gitea-system.svc.cluster.local:3000"
AUTH_HOST="gitea.k3s.bto.bar"

cat <<EOF > /tmp/push-config.json
{
  "auths": {
    "$INTERNAL_HOST": {
      "username": "$GITEA_USERNAME",
      "password": "$GITEA_TOKEN",
      "auth": "$AUTH"
    },
    "$AUTH_HOST": {
      "username": "$GITEA_USERNAME",
      "password": "$GITEA_TOKEN",
      "auth": "$AUTH"
    }
  }
}
EOF

kubectl create secret generic gitea-registry-push \
  --from-file=.dockerconfigjson=/tmp/push-config.json \
  --type=kubernetes.io/dockerconfigjson \
  --dry-run=client -o yaml | kubectl apply -f -

rm /tmp/push-config.json
```

### Pull Secret (used by K8s pods via imagePullSecrets)

```bash
kubectl create secret docker-registry gitea-registry-secret \
  --docker-server=registry.bto.bar \
  --docker-username="$GITEA_USERNAME" \
  --docker-password="$GITEA_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### (Optional) Store in Vault for ESO

If using External Secrets Operator with Vault:

```bash
vault kv put secret/gitea/registry \
  username="$GITEA_USERNAME" \
  password="$GITEA_TOKEN"
```

---

## Step 3: Deploy the TLS Auth Proxy

Kaniko runs inside K8s pods and needs to reach the auth token endpoint at `gitea.k3s.bto.bar:443`. Since Traefik's auto-generated cert doesn't match this hostname, we deploy an nginx proxy with a self-signed cert that Kaniko explicitly trusts.

### Generate Self-Signed Certificate

```bash
openssl req -x509 -newkey rsa:2048 -keyout /tmp/gitea-proxy-key.pem \
  -out /tmp/gitea-proxy-cert.pem -days 3650 -nodes \
  -subj "/CN=gitea.k3s.bto.bar" \
  -addext "subjectAltName=DNS:gitea.k3s.bto.bar"
```

### Create K8s TLS Secret and CA ConfigMap

```bash
# TLS secret for the nginx proxy
kubectl create secret tls gitea-proxy-tls \
  --cert=/tmp/gitea-proxy-cert.pem \
  --key=/tmp/gitea-proxy-key.pem \
  --dry-run=client -o yaml | kubectl apply -f -

# CA ConfigMap for Kaniko init containers to trust
kubectl create configmap gitea-proxy-ca \
  --from-file=ca.crt=/tmp/gitea-proxy-cert.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Deploy the Proxy

Apply `k8s/gitea-auth-proxy.yaml`:

```yaml
---
# Nginx config: HTTPS:443 -> Gitea HTTP:3000
apiVersion: v1
kind: ConfigMap
metadata:
  name: gitea-auth-proxy-config
  namespace: default
data:
  default.conf: |
    server {
      listen 443 ssl;
      ssl_certificate /etc/nginx/tls/tls.crt;
      ssl_certificate_key /etc/nginx/tls/tls.key;

      # CoreDNS resolver IP (find yours: kubectl get svc -n kube-system kube-dns)
      resolver 10.43.0.10 valid=30s;

      location / {
        # IMPORTANT: Use a variable so nginx resolves at runtime, not startup
        set $upstream http://gitea-http.gitea-system.svc.cluster.local:3000;
        proxy_pass $upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        client_max_body_size 0;
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gitea-auth-proxy
  namespace: default
  labels:
    app: gitea-auth-proxy
spec:
  replicas: 1
  selector:
    matchLabels:
      app: gitea-auth-proxy
  template:
    metadata:
      labels:
        app: gitea-auth-proxy
    spec:
      containers:
        - name: nginx
          image: nginx:alpine
          ports:
            - containerPort: 443
          volumeMounts:
            - name: config
              mountPath: /etc/nginx/conf.d/default.conf
              subPath: default.conf
            - name: tls
              mountPath: /etc/nginx/tls
              readOnly: true
          resources:
            requests:
              memory: 16Mi
              cpu: 10m
            limits:
              memory: 64Mi
              cpu: 50m
      volumes:
        - name: config
          configMap:
            name: gitea-auth-proxy-config
        - name: tls
          secret:
            secretName: gitea-proxy-tls
---
apiVersion: v1
kind: Service
metadata:
  name: gitea-auth-proxy
  namespace: default
  labels:
    app: gitea-auth-proxy
spec:
  type: ClusterIP
  selector:
    app: gitea-auth-proxy
  ports:
    - port: 443
      targetPort: 443
      protocol: TCP
```

```bash
kubectl apply -f k8s/gitea-auth-proxy.yaml
```

Verify:
```bash
PROXY_IP=$(kubectl get svc gitea-auth-proxy -o jsonpath='{.spec.clusterIP}')
kubectl run test-proxy --rm -it --image=alpine -- sh -c \
  "apk add curl && curl -sk https://$PROXY_IP/v2/"
# Should return 401 (means Gitea is reachable through the proxy)
```

---

## Step 4: Create Traefik HTTPS Ingress

K8s nodes (containerd) pull from `registry.bto.bar`, which redirects auth to `gitea.k3s.bto.bar`. The token endpoint must be reachable over HTTPS through Traefik.

Gitea already has an HTTP ingress for `gitea.k3s.bto.bar`. You need a **separate HTTPS ingress** because Traefik requires a `tls` section in the Ingress spec to handle HTTPS:

```bash
kubectl apply -n gitea-system -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: gitea-k3s-alias-tls
  namespace: gitea-system
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: "websecure"
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  tls:
  - hosts:
    - gitea.k3s.bto.bar
  rules:
  - host: gitea.k3s.bto.bar
    http:
      paths:
      - backend:
          service:
            name: gitea-http
            port:
              number: 3000
        path: /
        pathType: Prefix
EOF
```

Verify:
```bash
# Should return 200 (token JSON)
curl -sk "https://gitea.k3s.bto.bar/v2/token?service=container_registry"
```

> **Why not just add `websecure` to the existing HTTP ingress?** Traefik ignores the `websecure` entrypoint on Ingress resources that don't have a `spec.tls` section. You need a separate Ingress with `tls.hosts` defined. Traefik will auto-generate a self-signed cert for it (which is fine because K3s registries.yaml uses `insecure_skip_verify`).

---

## Step 5: Configure K3s Node Registries

containerd on K3s nodes cannot resolve cluster DNS (`*.svc.cluster.local`). It pulls from `registry.bto.bar` and reaches the auth token endpoint at `gitea.k3s.bto.bar`. Both need TLS skip because neither hostname has a valid certificate from the node's perspective.

Create `/etc/rancher/k3s/registries.yaml` on **every K3s node**:

```yaml
configs:
  "registry.bto.bar":
    tls:
      insecure_skip_verify: true
    auth:
      username: registry-user
      password: <GITEA_TOKEN>
  "registry.k3s.bto.bar":
    tls:
      insecure_skip_verify: true
    auth:
      username: registry-user
      password: <GITEA_TOKEN>
  "gitea.k3s.bto.bar":
    tls:
      insecure_skip_verify: true
    auth:
      username: registry-user
      password: <GITEA_TOKEN>
```

> **Why three entries?** `registry.bto.bar` is the image pull address. `gitea.k3s.bto.bar` is the auth token endpoint (from Gitea's ROOT_URL). `registry.k3s.bto.bar` is a legacy hostname that may still be referenced by older manifests.

### Deploying via kubectl (no SSH required)

If you don't have SSH access to nodes, use privileged pods with `nsenter`:

```bash
# For each node:
for NODE in dellmini1 dellmini2 dellmini3 dellmini5 lenovomini; do
  echo "=== Configuring $NODE ==="
  cat <<YAMLEOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: regconfig-$NODE
  namespace: default
spec:
  nodeName: $NODE
  restartPolicy: Never
  hostPID: true
  containers:
    - name: writer
      image: alpine:latest
      securityContext:
        privileged: true
      command:
        - nsenter
        - -t
        - "1"
        - -m
        - -u
        - -i
        - -n
        - --
        - sh
        - -c
        - |
          mkdir -p /etc/rancher/k3s
          cat > /etc/rancher/k3s/registries.yaml << 'EOF'
          configs:
            "registry.bto.bar":
              tls:
                insecure_skip_verify: true
              auth:
                username: registry-user
                password: <GITEA_TOKEN>
            "registry.k3s.bto.bar":
              tls:
                insecure_skip_verify: true
              auth:
                username: registry-user
                password: <GITEA_TOKEN>
            "gitea.k3s.bto.bar":
              tls:
                insecure_skip_verify: true
              auth:
                username: registry-user
                password: <GITEA_TOKEN>
          EOF
          echo "Done on \$(hostname)"
YAMLEOF
done
```

### Restart K3s on Each Node

**K3s reads `registries.yaml` at startup only.** You must restart the K3s service after writing the file. Do this one node at a time to avoid cluster downtime:

```bash
# For server nodes (control-plane):
for NODE in dellmini1 dellmini3 dellmini5; do
  echo "=== Restarting K3s on $NODE ==="
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: restart-$NODE
  namespace: default
spec:
  nodeName: $NODE
  restartPolicy: Never
  hostPID: true
  containers:
    - name: restarter
      image: alpine:latest
      securityContext:
        privileged: true
      command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--",
                "sh", "-c", "systemctl restart k3s && echo done"]
EOF
  echo "Waiting 35s for $NODE to come back..."
  sleep 35
  kubectl get node $NODE
  kubectl delete pod restart-$NODE --ignore-not-found
done

# For agent nodes (workers):
for NODE in dellmini2 lenovomini; do
  echo "=== Restarting K3s agent on $NODE ==="
  cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: restart-$NODE
  namespace: default
spec:
  nodeName: $NODE
  restartPolicy: Never
  hostPID: true
  containers:
    - name: restarter
      image: alpine:latest
      securityContext:
        privileged: true
      command: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--",
                "sh", "-c", "systemctl restart k3s-agent && echo done"]
EOF
  sleep 35
  kubectl get node $NODE
  kubectl delete pod restart-$NODE --ignore-not-found
done
```

---

## Step 6: Update K8s Manifests

### Image References

Change all image references from GHCR to the Gitea registry:

| Before (GHCR) | After (Gitea) |
|----------------|---------------|
| `ghcr.io/jaybrto/github-workflow-agents:latest` | `registry.bto.bar/jaybrto/github-workflow-agents:latest` |
| `ghcr.io/jaybrto/gwa-orchestrator:latest` | `registry.bto.bar/jaybrto/gwa-orchestrator:latest` |
| `ghcr.io/jaybrto/gwa-webhook:latest` | `registry.bto.bar/jaybrto/gwa-webhook:latest` |

### imagePullSecrets

Replace the GHCR pull secret with the Gitea pull secret in all workload manifests:

```yaml
# Before
imagePullSecrets:
  - name: ghcr-secret

# After
imagePullSecrets:
  - name: gitea-registry-secret
```

Files to update:
- `k8s/gwa-runner-statefulset.yaml`
- `k8s/gwa-orchestrator.yaml`
- `k8s/gwa-webhook.yaml`

---

## Step 7: Update the CI Pipeline

The CI pipeline (`.github/workflows/build-image.yml`) changes from using `docker/build-push-action` with GHCR to spawning Kaniko pods that push to the internal Gitea service.

### Key Design Decisions

1. **Push target:** Internal Gitea service (`gitea-http.gitea-system.svc.cluster.local:3000`) over HTTP with `--insecure-registry` flag
2. **Auth token endpoint:** Reached via the nginx TLS proxy (Step 3) using `hostAliases` to override DNS
3. **CA trust:** Init container merges custom CA cert into system cert bundle, Kaniko reads via `SSL_CERT_FILE`

### Pipeline Environment Variables

```yaml
env:
  REGISTRY: gitea-http.gitea-system.svc.cluster.local:3000
  ORG: jaybrto
```

### Build Job Pattern (repeat for each image)

Each build job follows this pattern:

```yaml
build-<name>:
  needs: changes
  if: needs.changes.outputs.<name> == 'true'
  runs-on: self-hosted
  env:
    IMAGE_NAME: <image-name>
  steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Get metadata
      id: meta
      run: |
        echo "sha_short=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
        echo "timestamp=$(date +%Y%m%d-%H%M%S)" >> "$GITHUB_OUTPUT"
        # Get the auth proxy ClusterIP for hostAliases
        PROXY_IP=$(kubectl get svc gitea-auth-proxy -o jsonpath='{.spec.clusterIP}')
        echo "proxy_ip=${PROXY_IP}" >> "$GITHUB_OUTPUT"

    - name: Build image
      run: |
        DEST="${{ env.REGISTRY }}/${{ env.ORG }}/${{ env.IMAGE_NAME }}"
        cat <<EOF | kubectl apply -f -
        apiVersion: v1
        kind: Pod
        metadata:
          name: kaniko-<name>-${{ github.run_id }}
          namespace: default
        spec:
          restartPolicy: Never
          # Override DNS: gitea.k3s.bto.bar -> auth proxy ClusterIP
          hostAliases:
            - ip: "${{ steps.meta.outputs.proxy_ip }}"
              hostnames:
                - gitea.k3s.bto.bar
          # Merge custom CA into system cert bundle
          initContainers:
            - name: setup-certs
              image: alpine:latest
              command: ["sh", "-c",
                "cat /etc/ssl/certs/ca-certificates.crt /custom-ca/ca.crt > /certs/ca-certificates.crt"]
              volumeMounts:
                - name: merged-certs
                  mountPath: /certs
                - name: custom-ca
                  mountPath: /custom-ca
          containers:
            - name: kaniko
              image: gcr.io/kaniko-project/executor:latest
              env:
                - name: SSL_CERT_FILE
                  value: /certs/ca-certificates.crt
              args:
                - "--dockerfile=Dockerfile"
                - "--context=git://github.com/${{ github.repository }}.git#refs/heads/${{ github.ref_name }}"
                - "--destination=${DEST}:latest"
                - "--destination=${DEST}:${{ steps.meta.outputs.sha_short }}"
                - "--destination=${DEST}:${{ steps.meta.outputs.timestamp }}"
                - "--cache=true"
                - "--cache-repo=${DEST}/cache"
                - "--insecure-registry=${{ env.REGISTRY }}"
              volumeMounts:
                - name: docker-config
                  mountPath: /kaniko/.docker
                - name: merged-certs
                  mountPath: /certs
          volumes:
            - name: docker-config
              secret:
                secretName: gitea-registry-push
                items:
                  - key: .dockerconfigjson
                    path: config.json
            - name: custom-ca
              configMap:
                name: gitea-proxy-ca
            - name: merged-certs
              emptyDir: {}
        EOF

    - name: Wait for build
      run: |
        kubectl wait --for=condition=Ready pod/kaniko-<name>-${{ github.run_id }} --timeout=120s 2>/dev/null || true
        while true; do
          STATUS=$(kubectl get pod kaniko-<name>-${{ github.run_id }} -o jsonpath='{.status.phase}')
          echo "Build status: $STATUS"
          if [ "$STATUS" = "Succeeded" ]; then break
          elif [ "$STATUS" = "Failed" ]; then
            kubectl logs kaniko-<name>-${{ github.run_id }}; exit 1
          fi
          sleep 10
        done

    - name: Show build logs
      if: always()
      run: kubectl logs kaniko-<name>-${{ github.run_id }} 2>/dev/null || true

    - name: Cleanup
      if: always()
      run: kubectl delete pod kaniko-<name>-${{ github.run_id }} --ignore-not-found
```

### Deploy Job

After all builds succeed, restart the workloads:

```yaml
deploy:
  needs: [changes, build-runner, build-orchestrator, build-webhook]
  if: always() && !failure() && !cancelled()
  runs-on: self-hosted
  steps:
    - name: Restart updated workloads
      run: |
        if [ "${{ needs.changes.outputs.runner }}" = "true" ] && \
           [ "${{ needs.build-runner.result }}" = "success" ]; then
          kubectl rollout restart statefulset/gwa-runner
          kubectl rollout status statefulset/gwa-runner --timeout=300s
        fi
        # ... repeat for orchestrator and webhook deployments
```

---

## Step 8: Update RBAC

The GitHub Actions runner service account needs additional permissions to:
- Create/delete Kaniko build pods
- Read services (to get the auth proxy ClusterIP)
- Patch deployments/statefulsets (to trigger rollout restarts)

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: gwa-actions-runner
  namespace: default
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  # NEW: needed to look up gitea-auth-proxy ClusterIP
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list"]
  # NEW: needed for rollout restart of statefulsets
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list", "watch", "patch"]
  # NEW: needed for rollout restart of deployments
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch"]
```

---

## Step 9: Verify Everything Works

### Verify Push (trigger a CI build)

```bash
gh workflow run build-image.yml -f images=all
gh run list --limit 1 --watch
```

All three build jobs should succeed. Check logs:
```bash
gh run view <RUN_ID> --log | grep -E "(destination|Pushed)"
```

### Verify Pull (check pod image)

```bash
kubectl rollout restart statefulset/gwa-runner
kubectl rollout status statefulset/gwa-runner --timeout=300s

# Confirm image was pulled from Gitea
kubectl describe pod gwa-runner-0 | grep "Image ID"
# Should show: registry.bto.bar/jaybrto/github-workflow-agents@sha256:...
```

### Verify Auth Flow (end-to-end)

```bash
# 1. Registry responds with auth challenge
curl -sk -I "https://registry.bto.bar/v2/" | grep -i www-authenticate

# 2. Token endpoint is reachable over HTTPS
curl -sk -u "registry-user:$GITEA_TOKEN" \
  "https://gitea.k3s.bto.bar/v2/token?service=container_registry&scope=*"

# 3. Containerd can pull (from any node)
kubectl run pull-test --rm -it \
  --image=registry.bto.bar/jaybrto/github-workflow-agents:latest \
  --overrides='{"spec":{"imagePullSecrets":[{"name":"gitea-registry-secret"}]}}' \
  -- echo "Pull succeeded"
```

---

## Troubleshooting

### ImagePullBackOff with TLS errors

```
tls: failed to verify certificate: x509: certificate is valid for
...traefik.default, not gitea.k3s.bto.bar
```

**Cause:** K3s `registries.yaml` not applied or K3s not restarted.

**Fix:** Verify the file exists on the affected node and restart K3s:
```bash
kubectl debug node/<NODE> -it --image=alpine -- cat /host/etc/rancher/k3s/registries.yaml
# If missing, re-apply Step 5
```

### 404 Not Found on token endpoint

```
unexpected status from GET request to https://gitea.k3s.bto.bar/v2/token: 404 Not Found
```

**Cause:** Missing HTTPS Traefik ingress for `gitea.k3s.bto.bar`.

**Fix:** Apply the TLS ingress from Step 4. Verify:
```bash
curl -sk "https://gitea.k3s.bto.bar/v2/token?service=container_registry"
# Should return JSON, not 404
```

### 401 Unauthorized during push

```
error checking push permissions: 401 Unauthorized
```

**Cause:** Invalid or expired Gitea access token in the push secret.

**Fix:** Regenerate the token in Gitea and update the secret:
```bash
# Test the token first
curl -sk -u "registry-user:$NEW_TOKEN" "https://registry.bto.bar/v2/"
# Should return 200 (not 401)

# Then update the secret (Step 2)
```

### DNS resolution failure in Kaniko

```
lookup gitea-http.gitea-system.svc.cluster.local: Try again
```

**Cause:** Tried using cluster DNS (`*.svc.cluster.local`) from K3s node containerd (which runs on the host, not in the cluster).

**Fix:** Never use cluster DNS in `registries.yaml`. Use external hostnames or ClusterIPs. The registries.yaml is read by containerd on the host, which doesn't have access to K8s CoreDNS.

### nginx proxy: "host not found in upstream"

**Cause:** nginx resolves upstreams at startup and fails if DNS isn't ready.

**Fix:** Use the `resolver` directive with a `set $upstream` variable pattern:
```nginx
resolver 10.43.0.10 valid=30s;
location / {
    set $upstream http://gitea-http.gitea-system.svc.cluster.local:3000;
    proxy_pass $upstream;
}
```

---

## Key Gotchas and Lessons Learned

### Things That Don't Work

| Approach | Why It Fails |
|----------|-------------|
| `--skip-tls-verify-registry=gitea.k3s.bto.bar` on Kaniko | Only applies to push/pull registry operations, NOT the auth token endpoint |
| `--insecure-registry=gitea.k3s.bto.bar` on Kaniko | Only downgrades push/pull to HTTP, does NOT affect the auth token endpoint HTTP client |
| Cluster DNS in `registries.yaml` mirrors | containerd runs on the host, not in K8s; cannot resolve `*.svc.cluster.local` |
| Single Traefik Ingress with `web,websecure` entrypoints | Traefik ignores `websecure` without a `spec.tls` section; need a separate Ingress |
| socat as a proxy | musl libc in `alpine/socat` can't resolve K8s service FQDNs via `getaddrinfo()` |

### Things That Do Work

| Approach | Why It Works |
|----------|-------------|
| `SSL_CERT_FILE` env var in Kaniko | Go programs (including Kaniko) read CA certs from this path; inject custom CA via init container |
| `hostAliases` in Kaniko pod | Overrides `/etc/hosts` to route `gitea.k3s.bto.bar` to the auth proxy ClusterIP |
| `registries.yaml` with `insecure_skip_verify` | containerd skips TLS verification for configured hosts, including auth token endpoints |
| Separate TLS Ingress for auth hostname | Traefik auto-generates a cert (doesn't matter that it's invalid since containerd skips verify) |
| nginx with `resolver` + `set $upstream` variable | Runtime DNS resolution instead of startup-time, prevents boot failures |

### Important Architecture Notes

1. **Two separate TLS trust chains:** Kaniko trusts the self-signed proxy cert via `SSL_CERT_FILE`. K3s containerd skips TLS verify via `registries.yaml`. These are completely independent.

2. **Push and pull use different paths:** Push goes through the internal service (HTTP). Pull goes through the external Caddy proxy (HTTPS). The auth token endpoint is shared but reached differently (proxy vs Traefik).

3. **Gitea's ROOT_URL controls everything:** The auth realm URL in Docker v2 responses comes from Gitea's `ROOT_URL` config. You cannot change it per-request. Every client must be able to reach this URL over HTTPS.

4. **K3s registries.yaml requires restart:** Unlike some documentation suggests, K3s does NOT hot-reload `registries.yaml`. You must restart the `k3s` (server) or `k3s-agent` (worker) systemd service.

---

## File Reference

| File | Purpose |
|------|---------|
| `.github/workflows/build-image.yml` | CI pipeline: builds 3 images with Kaniko, pushes to internal Gitea, deploys |
| `k8s/gitea-auth-proxy.yaml` | nginx TLS proxy: HTTPS:443 -> Gitea HTTP:3000 with self-signed cert |
| `k8s/gwa-actions-runner.yaml` | GitHub Actions runner RBAC (services, deployments access) |
| `k8s/gwa-runner-statefulset.yaml` | Runner StatefulSet (image: `registry.bto.bar/jaybrto/github-workflow-agents`) |
| `k8s/gwa-orchestrator.yaml` | Orchestrator Deployment (image: `registry.bto.bar/jaybrto/gwa-orchestrator`) |
| `k8s/gwa-webhook.yaml` | Webhook Deployment (image: `registry.bto.bar/jaybrto/gwa-webhook`) |
| `k8s/vault-external-secrets.yaml` | ESO config for Vault-backed secrets |

### K8s Secrets (not in repo, created manually or via ESO)

| Secret | Type | Purpose |
|--------|------|---------|
| `gitea-registry-push` | `kubernetes.io/dockerconfigjson` | Kaniko push credentials (dual entries: internal + auth host) |
| `gitea-registry-secret` | `kubernetes.io/dockerconfigjson` | Pod imagePullSecrets (registry.bto.bar) |
| `gitea-proxy-tls` | `kubernetes.io/tls` | Self-signed cert/key for nginx auth proxy |
| `gitea-proxy-ca` | ConfigMap | CA cert for Kaniko init containers |

### K8s Ingresses (gitea-system namespace)

| Ingress | Host | Entrypoints | Purpose |
|---------|------|-------------|---------|
| `gitea-http` | `gitea.bto.bar` | web (HTTP) | Gitea web UI |
| `gitea-registry` | `registry.bto.bar` | web (HTTP) | Docker registry (external via Caddy) |
| `gitea-k3s-alias` | `gitea.k3s.bto.bar` | web (HTTP) | Gitea alias (HTTP only) |
| `gitea-k3s-alias-tls` | `gitea.k3s.bto.bar` | websecure (HTTPS) | Auth token endpoint (containerd pulls) |

### Node-Level Configuration

| File | Nodes | Purpose |
|------|-------|---------|
| `/etc/rancher/k3s/registries.yaml` | All K3s nodes | TLS skip + auth for containerd image pulls |
