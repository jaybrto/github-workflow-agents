# BTO Campaigns Deployment Example

This is a complete working example of deploying an app using the Cloudflare Tunnel + K3s + Google Auth pattern.

## Configuration Values

| Component | Value |
|-----------|-------|
| App Name | bto-campaigns |
| Public Domain | campaigns.diversecarenow.com |
| Tunnel Domain | campaigns.bto.bar |
| Tunnel Name | bto-campaigns-prod |
| K8s Namespace | bto-campaigns-prod |
| NodePort | 30080 |
| Edge Layer | Azure Front Door |
| Auth Method | Cloudflare Access (Google OAuth) |
| Public Routes | /health, /p/*, /c/*, /unsubscribe/* |
| Protected Routes | /api/*, /dashboard/*, /* (catch-all) |

---

## OPNsense / Caddy Configuration

This section is only needed if using Caddy/OPNsense path (Option C).

### oauth2-proxy Configuration

Create `/usr/local/etc/oauth2-proxy/oauth2-proxy.cfg`:

```ini
provider = "google"
client_id = "<GOOGLE_CLIENT_ID>"
client_secret = "<GOOGLE_CLIENT_SECRET>"
cookie_secret = "<GENERATE_WITH: openssl rand -base64 32>"
cookie_secure = true
cookie_domains = "campaigns.diversecarenow.com"
cookie_name = "_oauth2_proxy"
authenticated_emails_file = "/usr/local/etc/oauth2-proxy/allowed-emails.txt"
email_domains = "*"
http_address = "127.0.0.1:4180"
reverse_proxy = true
set_xauthrequest = true
upstreams = "static://200"
whitelist_domains = "campaigns.diversecarenow.com"
```

### Caddy Configuration

```caddyfile
campaigns.diversecarenow.com {
    # ── PUBLIC: No auth required ──
    handle /health {
        reverse_proxy http://<K3S_NODE_IP>:30080
    }
    handle /p/* {
        reverse_proxy http://<K3S_NODE_IP>:30080 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host {host}
            header_up X-Real-IP {remote_host}
        }
    }
    handle /c/* {
        reverse_proxy http://<K3S_NODE_IP>:30080 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host {host}
            header_up X-Real-IP {remote_host}
        }
    }
    handle /unsubscribe/* {
        reverse_proxy http://<K3S_NODE_IP>:30080 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host {host}
            header_up X-Real-IP {remote_host}
        }
    }

    # ── OAUTH2-PROXY: Callback (must not be protected) ──
    handle /oauth2/* {
        reverse_proxy localhost:4180
    }

    # ── PROTECTED: API endpoints ──
    handle /api/* {
        forward_auth localhost:4180 {
            uri /oauth2/auth
            header_up X-Real-IP {remote_host}
            copy_headers X-Auth-Request-User X-Auth-Request-Email
        }
        reverse_proxy http://<K3S_NODE_IP>:30080 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-Host {host}
        }
    }

    # ── PROTECTED: Dashboard catch-all ──
    handle {
        forward_auth localhost:4180 {
            uri /oauth2/auth
            header_up X-Real-IP {remote_host}
            copy_headers X-Auth-Request-User X-Auth-Request-Email
        }
        root * /var/www/bto-campaigns/dashboard
        try_files {path} /index.html
        file_server
    }

    # ── Security headers ──
    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }

    log {
        output file /var/log/caddy/bto-campaigns.log
        format json
    }
}
```

### OPNsense Firewall Rules

Required rules:
- **WAN -> This Firewall**: Allow TCP 80, 443 for Caddy
- **LAN/VLAN -> K3s nodes**: Allow TCP 30080 from OPNsense LAN IP
- **Outbound**: Allow Cloudflare tunnel outbound (TCP 443)

---

## Troubleshooting

### Cloudflare returning "Just a moment..." JavaScript challenge
- **Cause**: Bot Fight Mode is enabled on the Cloudflare zone
- **Fix**: Disable Bot Fight Mode in Security -> Settings -> Bot traffic
- **Alternative**: Create WAF custom rule to Skip bot checks for the hostname

### Cloudflare Access blocking public routes
- Verify the "Public Routes" app is listed and has BYPASS policy
- Bypass policies are evaluated before Allow policies
- Check exact path patterns match (e.g., `/p/*` not `/p/`)

### SSL handshake failure on custom domain
- If using Azure Front Door, ensure custom domain has certificate associated
- If using Caddy, check ACME certificate provisioning logs
- If CNAME to bto.bar, the cert only covers *.bto.bar not your domain

### Cloudflared pods not connecting
- Check the tunnel token is correct in the K8s secret
- Verify the tunnel exists and is not deleted in Cloudflare dashboard
- Check pod logs: `kubectl logs -n bto-campaigns-prod -l app=cloudflared`

### oauth2-proxy returning 500 errors
- Verify Google OAuth credentials are correct
- Check cookie_secret is exactly 32 bytes base64
- Ensure redirect URI in Google Console matches exactly
- Check allowed-emails.txt has the correct email addresses

---

## Configuration Files Location

In a typical deployment:
- `deploy/k3s/prod/` - Kubernetes manifests
- `deploy/caddy/` - Caddy configuration (if using OPNsense)
- `deploy/SETUP_GUIDE.md` - Project-specific deployment guide
