# Feature 10: Notifications & Background Services

**Complexity:** High
**Dependencies:** F03 (Networking), F04 (MQTT)
**Blocks:** None

---

## Overview

This feature handles keeping the app informed when it's not in the foreground. Android's background restrictions require a multi-layered approach:

1. **Foreground service** — Maintains MQTT connection, shows persistent notification
2. **ntfy.sh push** — Backup for when Android kills the service (blocked/error/complete only)
3. **Notification channels** — Rich notifications with actions (answer blocked sessions)
4. **Battery optimization** — Guidance for whitelisting

---

## Notification Strategy Matrix

| App State | Mechanism | Events | Latency |
|-----------|-----------|--------|---------|
| **Foreground** | MQTT direct | All events | <1s |
| **Background (FG service)** | MQTT via service | All events → grouped notifications | <5s |
| **Process killed** | ntfy.sh push | Blocked, Error, Complete only | 5-30s |
| **Returning to foreground** | REST API sync | Missed events backfill | On resume |

---

## Tasks

### Task 1: MQTT Foreground Service

```yaml
task_id: "f10-001"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/service/MqttForegroundService.kt
    - android/app/src/main/kotlin/bar/bto/gwa/service/ServiceController.kt
  description: |
    MqttForegroundService:
    - Android Foreground Service (type: DATA_SYNC)
    - Maintains the MQTT connection when app is in background
    - Shows persistent notification: "GWA Monitor — Connected (LAN)"
    - Persistent notification updates with connection state

    Service lifecycle:
    - Started when app enters background (onStop)
    - Stopped when app returns to foreground (onStart) — MQTT moves to app process
    - Auto-start on boot (optional, controlled by setting)
    - Keeps MQTT alive with keepalive pings
    - On MQTT event: creates notification via NotificationManager

    ServiceController:
    - Manages service start/stop
    - Respects user preference (enable/disable background monitoring)
    - Handles Android 14+ foreground service type requirements

    Doze mode considerations:
    - MQTT keepalive may not fire during Doze deep sleep
    - Service uses WAKE_LOCK for critical connection maintenance
    - Accept that connection may drop during extended Doze — ntfy.sh is the backup
    - On Doze exit: reconnect MQTT immediately

dependencies:
  blocked_by: ["f04-001"]
  blocks: ["f10-002"]

validation:
  - Service starts when app backgrounds
  - MQTT stays connected for at least 30 minutes in background
  - Persistent notification shows connection state
  - Service stops when app returns to foreground
```

### Task 2: Notification Channels & Builder

```yaml
task_id: "f10-002"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/notification/NotificationChannels.kt
    - android/app/src/main/kotlin/bar/bto/gwa/notification/GWANotificationBuilder.kt
    - android/app/src/main/kotlin/bar/bto/gwa/notification/NotificationManager.kt
  description: |
    Notification Channels:
    ```kotlin
    object NotificationChannels {
        const val BLOCKED = "gwa_blocked"         // High priority
        const val ERROR = "gwa_error"             // High priority
        const val COMPLETE = "gwa_complete"       // Default priority
        const val STATE_CHANGE = "gwa_state"      // Low priority
        const val SERVICE = "gwa_service"         // Low priority (persistent)
    }
    ```

    Channel configuration:
    - BLOCKED: Heads-up notification, vibrate, LED
    - ERROR: Heads-up notification, vibrate
    - COMPLETE: Standard notification
    - STATE_CHANGE: Silent (no sound/vibrate)
    - SERVICE: Ongoing, minimal (for foreground service)

    GWANotificationBuilder:
    - Builds notifications from GWAEvent
    - SessionBlocked: Shows question text, "Answer" action button
    - SessionComplete: Shows summary
    - Error: Shows error message
    - State change: Grouped summary notification

    NotificationManager:
    - Receives events from MqttForegroundService
    - Applies grouping: multiple state changes → single summary
    - Applies rate limiting: max 1 notification per session per 30 seconds
    - "Answer" action: PendingIntent → opens session detail with answer section focused

    Notification action for "Answer":
    - Deep link: gwa://session/{sessionId}/answer
    - Opens AnswerDialog from F07

dependencies:
  blocked_by: ["f10-001", "f04-002"]
  blocks: []

validation:
  - Blocked session notification appears with "Answer" action
  - Tapping "Answer" opens the answer dialog
  - Notifications are grouped when multiple events fire
  - Rate limiting prevents notification flood
  - Channels are configurable in Android settings
```

### Task 3: ntfy.sh Push Integration

```yaml
task_id: "f10-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/notification/NtfyReceiver.kt
    - android/app/src/main/kotlin/bar/bto/gwa/notification/NtfyConfig.kt
  description: |
    ntfy.sh is the backup push mechanism for when Android kills the foreground service.
    The GWA PushBridge (src/orchestrator/push-bridge.ts) sends notifications to
    ntfy.sh for blocked/error/complete events.

    NtfyConfig:
    ```kotlin
    data class NtfyConfig(
        val serverUrl: String = "https://ntfy.bto.bar",
        val topic: String = "gwa",
        val enabled: Boolean = true
    )
    ```

    NtfyReceiver options (pick one):

    Option A: ntfy.sh Android app installed (preferred)
    - ntfy.sh app handles push delivery
    - Register broadcast receiver for ntfy intents
    - Parse notification data and create GWA-formatted notification

    Option B: Direct SSE/WebSocket polling (if ntfy app not installed)
    - Connect to ntfy.sh SSE endpoint: GET /gwa/sse
    - Parse server-sent events
    - Create notifications from event data
    - Run in foreground service alongside MQTT

    For v1, assume the ntfy.sh Android app is installed (personal device).

    Integration:
    - When ntfy notification arrives with tag "gwa":
      1. Check if the event is already known (dedup with Room events table)
      2. If new: create notification via GWANotificationBuilder
      3. If already shown (MQTT delivered it first): suppress duplicate

dependencies:
  blocked_by: []
  blocks: []

validation:
  - ntfy.sh notifications create GWA-formatted Android notifications
  - Duplicate suppression works (MQTT + ntfy don't double-notify)
  - Deep link from ntfy notification opens correct session
```

### Task 4: Settings Screen

```yaml
task_id: "f10-004"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/settings/SettingsScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/settings/SettingsViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/preferences/GWAPreferences.kt
  description: |
    GWAPreferences (DataStore):
    ```kotlin
    data class GWAPreferences(
        val backgroundMonitoring: Boolean = true,
        val ntfyEnabled: Boolean = true,
        val notifyBlocked: Boolean = true,
        val notifyErrors: Boolean = true,
        val notifyComplete: Boolean = true,
        val notifyStateChanges: Boolean = false,
        val terminalFontSize: Float = 12f,
        val apiBaseUrl: String = "",
        val apiKey: String = "",
        val mqttHost: String = "",
        val mqttPort: Int = 1883,
        val mqttWssUrl: String = "",
        val ntfyServerUrl: String = "https://ntfy.bto.bar",
        val ntfyTopic: String = "gwa",
        val eventRetentionDays: Int = 7,
        val darkMode: DarkMode = DarkMode.System
    )

    enum class DarkMode { Light, Dark, System }
    ```

    SettingsScreen sections:
    1. Connection: API URL, API Key, MQTT host/port, WSS URL
    2. Notifications: Enable/disable per type, background monitoring toggle
    3. ntfy.sh: Server URL, topic, enable/disable
    4. Display: Dark mode, terminal font size
    5. Data: Event retention period, clear cache button
    6. About: App version, GWA version, connection status

    Battery optimization guidance:
    - If not battery-optimized: show banner with "Optimize" button
    - Opens Android battery optimization settings for the app

dependencies:
  blocked_by: ["f01-002"]
  blocks: []

validation:
  - All settings persist across app restarts
  - API URL/key changes take effect immediately
  - Battery optimization intent opens correct settings page
  - Settings screen renders on phone and tablet
```

---

## Battery & Background Considerations

### Android Doze Mode
- App in Doze: Network access restricted, alarms deferred
- MQTT keepalive may not fire → connection drops
- Mitigation: Accept connection loss in Doze, rely on ntfy.sh
- On Doze exit (user interacts with phone): immediate MQTT reconnect + REST sync

### OEM Battery Killers
- Samsung, Xiaomi, Huawei, etc. may kill foreground services
- Mitigation: Guide user to whitelist app (dontkillmyapp.com)
- Pixel 10 (stock Android) is less aggressive — primary target
- ntfy.sh is the ultimate backup

### Android 14+ Restrictions
- Foreground service type must be declared: `FOREGROUND_SERVICE_DATA_SYNC`
- Must have `FOREGROUND_SERVICE_DATA_SYNC` permission
- Service must show a notification within 10 seconds of starting

---

## Acceptance Criteria

- [ ] MQTT stays connected in background via foreground service
- [ ] Blocked session notification appears with "Answer" action
- [ ] ntfy.sh fallback works when MQTT is disconnected
- [ ] Duplicate notifications are suppressed (MQTT + ntfy dedup)
- [ ] Settings screen allows full configuration
- [ ] Battery optimization guidance is shown
- [ ] Notification channels are configurable in Android settings
