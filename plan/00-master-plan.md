# GWA Android Dashboard — Master Implementation Plan

**Version:** 1.0
**Created:** 2026-02-20
**Target Device:** Google Pixel 10 Pro XL / Large Android Tablets
**Build Environment:** Claude Code CLI on MacBook Pro M3 (2023)
**Architecture:** Kotlin / Jetpack Compose / MVVM

---

## Executive Summary

The GWA Android Dashboard is a personal admin portal for monitoring and interacting with the GitHub Workflow Agents system running on a homelab K3s cluster. It provides real-time session monitoring, terminal streaming, Claude Code hooks event consumption, infrastructure health visibility, and the ability to answer blocked sessions — all from a Pixel 10 Pro XL or large Android tablet.

This is a single-user app (not distributed), purpose-built for the `jaybrto` homelab environment with direct LAN, WARP VPN, and public WSS connectivity paths.

---

## Feature Plan Index

| # | Feature | Plan File | Complexity | Dependencies |
|---|---------|-----------|------------|--------------|
| 01 | [Project Scaffolding & Build System](./01-project-scaffolding.md) | `01-project-scaffolding.md` | Medium | None |
| 02 | [Design System & Theme](./02-design-system.md) | `02-design-system.md` | Medium | F01 |
| 03 | [Networking & API Layer](./03-networking-api.md) | `03-networking-api.md` | High | F01 |
| 04 | [MQTT & Real-time Events](./04-mqtt-realtime.md) | `04-mqtt-realtime.md` | High | F01, F03 |
| 05 | [Claude Code Hooks Event Stream](./05-hooks-event-stream.md) | `05-hooks-event-stream.md` | High | F04, Infra |
| 06 | [Dashboard Home Screen](./06-dashboard-home.md) | `06-dashboard-home.md` | Medium | F02, F03, F04 |
| 07 | [Session Management](./07-session-management.md) | `07-session-management.md` | High | F02, F03, F04, F06 |
| 08 | [Terminal Viewer](./08-terminal-viewer.md) | `08-terminal-viewer.md` | High | F03, F07 |
| 09 | [Infrastructure Monitoring](./09-infra-monitoring.md) | `09-infra-monitoring.md` | Medium | F02, F03, F06 |
| 10 | [Notifications & Background Services](./10-notifications.md) | `10-notifications.md` | High | F03, F04 |
| 11 | [Claude LLM Event Viewer](./11-llm-event-viewer.md) | `11-llm-event-viewer.md` | High | F02, F04, F05, F07 |

---

## Dependency Graph

```
F01 (Scaffolding)
 ├── F02 (Design System)
 │    ├── F06 (Dashboard Home) ◄── F03, F04
 │    │    ├── F07 (Session Mgmt) ◄── F03, F04
 │    │    │    ├── F08 (Terminal) ◄── F03
 │    │    │    └── F11 (LLM Events) ◄── F04, F05
 │    │    └── F09 (Infra Monitor) ◄── F03
 │    └───────────────────────────────────────┐
 ├── F03 (Networking/API)                     │
 │    ├── F04 (MQTT/Realtime)                 │
 │    │    ├── F05 (Hooks Stream) ◄── [Infra] │
 │    │    └── F10 (Notifications)             │
 │    └──────────────────────────────────────── │
 └──────────────────────────────────────────────┘

Parallelism:
  Wave 1: F01
  Wave 2: F02, F03 (parallel)
  Wave 3: F04, F09 (parallel, after F03)
  Wave 4: F05, F06, F10 (parallel, after F02+F03+F04)
  Wave 5: F07, F11 (parallel, after F06)
  Wave 6: F08 (after F07)
```

---

## Infrastructure Context (Homelab)

| Component | Address | Notes |
|-----------|---------|-------|
| Orchestrator REST API | `gwa-orchestrator.default.svc:3001` (LAN) / `gwa.bto.bar` (public) | Session CRUD, provisioning, health |
| RabbitMQ (AMQP) | `rabbitmq.default.svc:5672` (LAN) | Events, commands, heartbeats |
| RabbitMQ (MQTT) | `10.43.x.x:1883` (LAN) / `wss://mqtt.bto.bar/ws` (public) | MQTT plugin on RabbitMQ |
| MinIO (S3) | `minio.bto.bar:9000` | Asciicast recordings |
| Terminal Relay WS | `ws://<pod-ip>:8080/ws/{sessionId}` | Live terminal streams |
| ntfy.sh | `https://ntfy.bto.bar/gwa` | Push notifications |
| Grafana | `grafana.bto.bar` | OpenTelemetry dashboards |
| Cloudflare WARP | WireGuard tunnel | Remote LAN access |

---

## Connectivity Model

The app attempts connections in priority order:

| Priority | Path | Transport | Detection | Timeout |
|----------|------|-----------|-----------|---------|
| 1 | LAN Direct | TCP to `10.43.x.x` | WiFi SSID / IP range check | Unlimited |
| 2 | WARP VPN | TCP to `10.43.x.x` via WireGuard | VPN interface active | 8 hours |
| 3 | Public WSS | WebSocket to `wss://mqtt.bto.bar/ws` | Fallback | 100 seconds |

---

## GWA System Data Model (from TypeScript source)

### Session States (XState)

```
idle → planning → inProgress → qa → review → done
         ↑            ↑          ↑       ↑
         └── blocked ──┘──────────┘───────┘
```

States: `idle`, `planning`, `in_progress`, `qa`, `blocked`, `review`, `done`

### REST API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | None | System health + pod count |
| GET | `/sessions` | None | All aggregated sessions |
| GET | `/sessions/:id` | None | Session detail + activity feed |
| POST | `/sessions/:id/answer` | None | Send answer to blocked session |
| GET | `/sessions/:id/snapshots` | None | Terminal snapshots |
| GET | `/sessions/:id/recordings` | None | Asciicast recordings |
| GET | `/projects` | API Key | List projects with health |
| GET | `/projects/:id` | API Key | Project detail + credential health |
| POST | `/projects/:id/credentials` | API Key | Push credentials |
| POST | `/projects/:id/provision` | API Key | Provision environment |
| GET | `/projects/:id/health` | API Key | Credential health status |
| GET | `/projects/:id/credentials/history` | API Key | Credential history |

### AMQP Exchanges & Routing

| Exchange | Type | Pattern | Description |
|----------|------|---------|-------------|
| `gwa.events` | topic | `gwa.events.{owner}.{repo}.{session}.{event}` | All session events |
| `gwa.commands` | topic | `gwa.commands.{owner}.{repo}.#` | Commands to runners |
| `gwa.heartbeat` | topic | `gwa.heartbeat.{owner}.{repo}` | Pod heartbeats (30s) |

### Key Event Types

- `state_change` — Session state transition (includes `newState`, `triggerEvent`)
- `pane_stream_started` / `pane_stream_stopped` — Terminal stream lifecycle
- `terminal_snapshot_captured` — SVG/ANSI snapshot taken
- `recording_uploaded` — Asciicast uploaded to MinIO
- `session_blocked` / `session_resumed` — Human input needed/provided
- `session_complete` — Work finished

---

## Technology Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | Kotlin | Android-native, Compose interop |
| UI | Jetpack Compose + Material 3 | Modern declarative UI, responsive |
| Terminal | Termux `terminal-view` + `terminal-emulator` | Native Canvas rendering, no WebView |
| MQTT | `hannesa2/paho.mqtt.android` v3.6.4 | Maintained fork with Android lifecycle |
| HTTP | Ktor Client | Kotlin-native, coroutines |
| WebSocket | OkHttp | Terminal relay live streams |
| State | Kotlin Flow + ViewModel | Reactive, lifecycle-aware |
| DI | Koin | Lightweight, Compose-friendly |
| Local DB | Room | Offline cache, event history |
| Push | ntfy.sh (self-hosted) | No Firebase dependency |
| Responsive | Compose WindowSizeClass | Phone vs tablet adaptive layout |
| Build | Gradle KTS + Version Catalog | Modern Gradle, reproducible |

---

## Responsive Layout Strategy

### Phone (Pixel 10 Pro XL — ~430dp width)
- Single-column layout
- Bottom navigation bar
- Full-screen session detail
- Swipe gestures for navigation

### Tablet (>840dp width)
- Two-pane master-detail layout
- Navigation rail (left side)
- Session list + detail side-by-side
- Terminal viewer gets more vertical space

### WindowSizeClass Breakpoints
- **Compact** (<600dp): Phone layout
- **Medium** (600-840dp): Small tablet / landscape phone
- **Expanded** (>840dp): Large tablet layout

---

## Build & Development Notes

- **Build machine:** MacBook Pro M3 (2023) using Claude Code CLI
- **Android Studio** for final testing/emulation only
- **Gradle wrapper** committed to repo
- **Min SDK:** 28 (Android 9.0) — covers Pixel 10 Pro XL
- **Target SDK:** 35 (Android 15)
- **Compose BOM:** Latest stable (2025.x)

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Android Doze kills MQTT | High | Foreground service + ntfy.sh backup |
| OEM battery optimization | High | Battery whitelist guide + ntfy fallback |
| WARP VPN drops in background | Medium | Always-on VPN setting + graceful reconnect |
| RabbitMQ MQTT QoS 2 unsupported | Medium | Use QoS 1 everywhere |
| Termux terminal-view GPLv3 | Low | Personal use only, not distributed |
| Large event volume overwhelms UI | Medium | Event batching, virtual lists, retention limits |

---

## Claude Code Hooks Integration (New)

Claude Code emits structured events via its hooks system. The GWA orchestrator will publish these as AMQP events that the Android app consumes for real-time visibility into Claude's tool usage, thinking process, and code generation.

See [Feature 05: Claude Code Hooks Event Stream](./05-hooks-event-stream.md) for full details.

### Hook Event Categories
- **Tool calls** — Bash, Read, Write, Edit, Glob, Grep invocations with arguments/results
- **Assistant responses** — Streamed text chunks from Claude
- **Conversation turns** — User prompt → assistant response cycles
- **Cost tracking** — Token usage, API costs per session
- **Error events** — Tool failures, permission denials, timeout errors
