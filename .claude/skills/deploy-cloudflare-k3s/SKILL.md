---
name: deploy-cloudflare-k3s
description: Deploy an app behind Cloudflare Tunnel + K3s + Google Auth on OPNsense/Caddy. Use for setting up production web apps with secure authentication.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task, AskUserQuestion
argument-hint: <app-name> <domain>
---

# Deploy Application with Cloudflare Tunnel, K3s, and Google Auth

**App Name:** $0
**Domain:** $1

Deploy a web application behind Cloudflare Tunnel on a K3s cluster with Google OAuth authentication via Caddy on OPNsense. This skill guides you through the complete setup based on the proven bto-campaigns deployment pattern.

If arguments are not provided, ask the user using AskUserQuestion for:
- **APP_NAME** (`$0`): The application name (e.g., `bto-campaigns`, `my-dashboard`)
- **DOMAIN** (`$1`): The public-facing domain (e.g., `campaigns.diversecarenow.com`)

---

## Infrastructure Overview

```
User Request
     |
     v
Public Domain (e.g., app.example.com)
     |
     v [DNS CNAME or A record]
Edge Layer (one of):
  Option A: Azure Front Door (for custom domain SSL with BYOC)
  Option B: Cloudflare Proxy (if domain DNS is on Cloudflare)
  Option C: OPNsense/Caddy direct (A record to OPNsense IP)
     |
     v
Cloudflare Tunnel (*.bto.bar)
  - Public routes: Bypass Cloudflare Access
  - Protected routes: Google Auth via Cloudflare Access
     |
     v
K3s Cluster (namespace: <app>-prod)
  - cloudflared pods (2 replicas)
  - Application pods
  - Services (ClusterIP + NodePort)
```

---

## Complete Setup Phases

### PHASE 1: Cloudflare Tunnel Setup

#### 1.1 Create Tunnel in Cloudflare Dashboard

1. Go to Cloudflare Zero Trust: https://one.dash.cloudflare.com
2. Navigate to: **Networks -> Connectors**
3. Click **Create a connector**
4. Name the tunnel: `$0-prod`
5. Select **Cloudflared** as the connector type
6. **Copy the tunnel token** - you'll need this for K8s

#### 1.2 Add Hostname Route to Tunnel

In the tunnel configuration, add a public hostname:
- **Subdomain**: `<subdomain>` (e.g., `campaigns`)
- **Domain**: `bto.bar` (or whichever Cloudflare-managed domain)
- **Service type**: HTTP
- **URL**: `http://$0-api.$0-prod.svc.cluster.local:3000`

#### 1.3 Configure Cloudflare Access Applications

Create TWO Access applications in the correct order:

**Application 1: Public Routes (Bypass)**
- **Name**: `$0 Public Routes`
- **Type**: Self-Hosted
- **Hostnames** (add each public route as a separate hostname entry):
  - `<subdomain>.bto.bar` / `health`
  - `<subdomain>.bto.bar` / `p/*`
  - `<subdomain>.bto.bar` / `c/*`
  - (Add any other public routes needed)
- **Policy**: Create policy with **Action: Bypass**, Include: Everyone

**Application 2: Dashboard (Protected)**
- **Name**: `$0 Dashboard`
- **Type**: Self-Hosted
- **Domain**: `<subdomain>.bto.bar` (all paths)
- **Policy**: Create policy requiring Google authentication
  - Action: Allow
  - Include: Emails ending in specific domain OR specific email list

**IMPORTANT**: Bypass policies are evaluated FIRST.

#### 1.4 Disable Bot Fight Mode (if using CDN/proxy in front)

If Azure Front Door or another CDN needs to reach the origin:
1. Go to Cloudflare Dashboard -> bto.bar -> Security -> Settings
2. Filter by "Bot traffic"
3. **Disable Bot fight mode** (toggle OFF)

---

### PHASE 2: K3s Deployment

#### 2.1 Create Namespace

```yaml
# deploy/k3s/prod/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: $0-prod
  labels:
    app: $0
    environment: production
```

#### 2.2 Create Cloudflared Secret

```yaml
# deploy/k3s/prod/cloudflared/secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflared-tunnel-token
  namespace: $0-prod
  labels:
    app: cloudflared
    environment: production
type: Opaque
stringData:
  token: <TUNNEL_TOKEN_FROM_STEP_1.1>
```

#### 2.3 Create Cloudflared Deployment

```yaml
# deploy/k3s/prod/cloudflared/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cloudflared
  namespace: $0-prod
  labels:
    app: cloudflared
    environment: production
spec:
  replicas: 2
  selector:
    matchLabels:
      app: cloudflared
  template:
    metadata:
      labels:
        app: cloudflared
        environment: production
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args:
            - tunnel
            - --no-autoupdate
            - --metrics
            - 0.0.0.0:2000
            - run
            - --token
            - $(TUNNEL_TOKEN)
          env:
            - name: TUNNEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: cloudflared-tunnel-token
                  key: token
          ports:
            - name: metrics
              containerPort: 2000
              protocol: TCP
          resources:
            requests:
              memory: "64Mi"
              cpu: "50m"
            limits:
              memory: "128Mi"
              cpu: "200m"
          livenessProbe:
            httpGet:
              path: /ready
              port: 2000
            initialDelaySeconds: 10
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 2000
            initialDelaySeconds: 5
            periodSeconds: 5
      restartPolicy: Always
```

#### 2.4 Deploy to K3s

```bash
kubectl apply -f deploy/k3s/prod/namespace.yaml
kubectl apply -f deploy/k3s/prod/cloudflared/
kubectl apply -f deploy/k3s/prod/services/
kubectl apply -f deploy/k3s/prod/deployments/
```

#### 2.5 Verify Cloudflared is Running

```bash
kubectl get pods -n $0-prod -l app=cloudflared
# Both pods should show Running 1/1

kubectl logs -n $0-prod -l app=cloudflared --tail=20
# Look for: "Connection registered" messages
```

---

### PHASE 3: Google OAuth Setup

#### 3.1 Create Google Cloud OAuth Credentials

1. Go to https://console.cloud.google.com
2. Navigate to **APIs & Services -> Credentials**
3. Click **Create Credentials -> OAuth client ID**
4. Application type: **Web application**
5. Name: `$0 Dashboard`
6. Authorized redirect URIs: `https://$1/oauth2/callback`
7. Save the Client ID and Client Secret

#### 3.2 Configure OAuth Consent Screen

1. Go to **APIs & Services -> OAuth consent screen**
2. User Type: **External** (or Internal for Google Workspace)
3. Scopes: `email`, `profile`, `openid`
4. Test users: Add all authorized email addresses

---

### PHASE 4: DNS Configuration

Choose based on your architecture:

**Option A: Azure Front Door**
```
$1 -> CNAME -> <frontdoor-endpoint>.z02.azurefd.net
```

**Option B: Cloudflare Proxy**
```
$1 -> CNAME -> <subdomain>.bto.bar (proxied, orange cloud)
```

**Option C: Direct to OPNsense**
```
$1 -> A record -> <OPNsense Public IP>
```

---

## Verification Checklist

```bash
# 1. Test Cloudflare tunnel directly
curl -s https://<subdomain>.bto.bar/health

# 2. Test public domain
curl -s https://$1/health

# 3. Test public routes (should NOT redirect)
curl -s -o /dev/null -w "%{http_code}" https://$1/p/test
# Expected: 200 or 404 (NOT 302)

# 4. Test protected routes (should redirect)
curl -s -o /dev/null -w "%{http_code}" https://$1/api/test
# Expected: 302 (redirect to auth)

# 5. Check K8s pods
kubectl get pods -n $0-prod
```

---

## Supporting Files

- `examples/bto-campaigns.md` - Complete working example with real values

## Troubleshooting

See `examples/bto-campaigns.md` for common issues and solutions.
