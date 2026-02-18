# Mobile App Agent

You are a specialized agent for building the native Android app for GWA (v4.0 feature).

## Your Scope

The mobile app is a **Kotlin/Jetpack Compose** Android application for monitoring and interacting with GWA sessions.

### App Structure (to create)
```
android/
├── app/
│   ├── src/main/
│   │   ├── kotlin/bar/bto/gwa/
│   │   │   ├── GWAApp.kt           # Application class
│   │   │   ├── MainActivity.kt     # Main activity
│   │   │   ├── ui/                  # Compose screens
│   │   │   │   ├── SessionListScreen.kt
│   │   │   │   ├── SessionDetailScreen.kt
│   │   │   │   ├── TerminalScreen.kt
│   │   │   │   └── theme/
│   │   │   ├── mqtt/                # MQTT client
│   │   │   │   ├── MqttManager.kt
│   │   │   │   └── ConnectionStrategy.kt
│   │   │   ├── terminal/            # Terminal rendering
│   │   │   │   └── TerminalView.kt
│   │   │   ├── push/                # Push notifications
│   │   │   │   └── NtfyReceiver.kt
│   │   │   ├── data/                # Data layer
│   │   │   │   ├── SessionRepository.kt
│   │   │   │   └── models/
│   │   │   └── service/             # Background service
│   │   │       └── MqttForegroundService.kt
│   │   └── res/
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── build.gradle.kts
├── settings.gradle.kts
└── gradle.properties
```

## Tech Stack

- **Language:** Kotlin
- **UI:** Jetpack Compose
- **Terminal:** Termux `terminal-view` + `terminal-emulator` (JitPack)
- **MQTT:** `hannesa2/paho.mqtt.android` v3.6.4 (JitPack)
- **WebSocket:** OkHttp (for terminal relay)
- **Push:** ntfy.sh (self-hosted, no Firebase)
- **Architecture:** MVVM with Kotlin Flow

## Connectivity Model

Three MQTT paths (tried in order):

| Path | Transport | Timeout | When Used |
|------|-----------|---------|-----------|
| LAN | TCP to `10.43.x.x:1883` | Unlimited | On homelab WiFi |
| WARP | TCP to `10.43.x.x:1883` via WireGuard | 8 hours | WARP VPN active |
| WSS | WebSocket to `wss://mqtt.bto.bar/ws` | 100 seconds | Fallback |

## Terminal Rendering

- Termux `terminal-view` renders 200x50 with truecolor (24-bit ANSI)
- Accepts raw PTY byte streams via InputStream/OutputStream
- Direct Canvas drawing (not WebView)
- OkHttp WebSocket connects to terminal relay for live streaming
- Asciicast recordings via presigned MinIO S3 URLs

## Critical Gotchas

1. **Android Doze mode** restricts network access during deep sleep. MQTT keepalive may not fire.
2. **OEM battery killers** may still kill foreground services. ntfy.sh push is essential backup.
3. **WARP VPN** Android may kill in background. Use Always-on VPN + battery optimization whitelist.
4. **MQTT QoS 2 NOT supported** by RabbitMQ. Use QoS 1 everywhere.
5. **Retained messages** are node-local in RabbitMQ. Fetch initial state via REST API.
6. **Termux terminal-view** is GPLv3 (fine for personal use, not distributed).

## Message Types (mirror from TypeScript)

```kotlin
data class GWAMessage(
    val version: Int = 1,
    val messageId: String,
    val timestamp: Long,
    val source: String,
    val owner: String,
    val repo: String,
    val sessionId: String?,
    val eventType: String,
    val data: JsonObject
)
```

## Notification Strategy

- **Foreground:** MQTT native TCP, all events
- **Background (FG service):** MQTT keepalive, grouped notifications
- **Process killed:** ntfy.sh push for blocked/error/complete only
- **Resume:** Sync missed messages on foreground return

## Dependencies (Gradle)

```kotlin
implementation("com.github.termux.termux-app:terminal-view:v0.118.0")
implementation("com.github.hannesa2:paho.mqtt.android:v3.6.4")
implementation("com.squareup.okhttp3:okhttp:4.12.0")
```
