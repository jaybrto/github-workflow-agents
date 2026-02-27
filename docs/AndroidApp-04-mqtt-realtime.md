# Feature 04: MQTT & Real-time Events

**Complexity:** High
**Dependencies:** F01 (Scaffolding), F03 (Networking)
**Blocks:** F05 (Hooks Stream), F06 (Dashboard), F07 (Sessions), F10 (Notifications), F11 (LLM Events)

---

## Overview

Implement the MQTT client that connects to RabbitMQ's MQTT plugin for real-time event streaming. This replaces REST polling for live data and is the backbone of the app's real-time capabilities. The GWA backend publishes all session events, state changes, heartbeats, and Claude Code hook events via AMQP topic exchanges — RabbitMQ's MQTT plugin bridges these to MQTT topics.

---

## AMQP → MQTT Topic Mapping

RabbitMQ's MQTT plugin maps AMQP routing keys to MQTT topics by replacing `.` with `/`:

| AMQP Routing Key | MQTT Topic |
|-------------------|------------|
| `gwa.events.jaybrto.repo.session123.state_change` | `gwa/events/jaybrto/repo/session123/state_change` |
| `gwa.heartbeat.jaybrto.repo` | `gwa/heartbeat/jaybrto/repo` |
| `gwa.commands.jaybrto.repo.#` | `gwa/commands/jaybrto/repo/#` |

### Topics the App Subscribes To

| Topic Pattern | QoS | Description |
|---------------|-----|-------------|
| `gwa/events/#` | 1 | All session events (state changes, tool calls, etc.) |
| `gwa/heartbeat/#` | 0 | Pod heartbeats (30s interval) |
| `gwa/hooks/#` | 1 | Claude Code hook events (new — see F05) |

**Important:** RabbitMQ does NOT support MQTT QoS 2. Use QoS 1 everywhere.

---

## Tasks

### Task 1: MQTT Connection Manager

```yaml
task_id: "f04-001"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/MqttConnectionManager.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/MqttConfig.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/ConnectionStrategy.kt
  description: |
    MqttConfig:
    ```kotlin
    data class MqttConfig(
        val host: String,
        val port: Int,
        val useSsl: Boolean = false,
        val useWebSocket: Boolean = false,
        val wsPath: String? = null,
        val keepAliveSeconds: Int = 60,
        val cleanSession: Boolean = true,
        val clientId: String = "gwa-android-${UUID.randomUUID().toString().take(8)}"
    )
    ```

    ConnectionStrategy — Ordered connection attempts:
    ```kotlin
    sealed class ConnectionStrategy {
        data class Tcp(val host: String, val port: Int) : ConnectionStrategy()
        data class WebSocket(val url: String) : ConnectionStrategy()
    }
    ```

    Strategy resolution from ConnectivityManager:
    1. LAN_DIRECT → TCP to 10.43.x.x:1883
    2. WARP_VPN → TCP to 10.43.x.x:1883
    3. PUBLIC_HTTPS → WSS to wss://mqtt.bto.bar/ws
    4. DISCONNECTED → no connection, queue messages

    MqttConnectionManager:
    - Uses hannesa2/paho.mqtt.android library
    - Manages singleton MqttAsyncClient
    - Auto-reconnect with exponential backoff (2s, 4s, 8s, 16s, max 60s)
    - Switches strategy when ConnectivityManager path changes
    - Exposes StateFlow<MqttConnectionState>:
      - Connected(strategy), Connecting, Disconnected(reason), Reconnecting(attempt)
    - Clean session = true (RabbitMQ retained messages are node-local anyway)
    - MQTT keepalive = 60s (balanced for Doze mode)
    - Will message: publish to gwa/client/disconnect/{clientId}

dependencies:
  blocked_by: ["f03-002"]
  blocks: ["f04-002"]

validation:
  - Connects via TCP on LAN
  - Connects via WSS when on public network
  - Auto-reconnects after network drop
  - StateFlow correctly reflects connection state
```

### Task 2: MQTT Event Dispatcher

```yaml
task_id: "f04-002"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/MqttEventDispatcher.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/GWAEvent.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/mqtt/EventParser.kt
  description: |
    GWAEvent sealed hierarchy (mirrors AmqpMessage):
    ```kotlin
    @Serializable
    data class GWAEventEnvelope(
        val routingKey: String,
        val payload: JsonObject,
        val timestamp: Long,
        val sessionId: String,
        val traceId: String? = null
    )

    sealed class GWAEvent {
        abstract val sessionId: String
        abstract val timestamp: Long

        data class StateChange(
            override val sessionId: String,
            override val timestamp: Long,
            val newState: SessionState,
            val triggerEvent: String,
            val issueNumber: Int,
            val repoOwner: String,
            val repoName: String
        ) : GWAEvent()

        data class Heartbeat(
            override val sessionId: String,
            override val timestamp: Long,
            val podName: String,
            val activeSessionCount: Int
        ) : GWAEvent()

        data class TerminalEvent(
            override val sessionId: String,
            override val timestamp: Long,
            val eventType: String, // pane_stream_started, snapshot_captured, etc
            val details: Map<String, Any?>
        ) : GWAEvent()

        data class SessionBlocked(
            override val sessionId: String,
            override val timestamp: Long,
            val question: String?
        ) : GWAEvent()

        data class SessionComplete(
            override val sessionId: String,
            override val timestamp: Long,
            val summary: String?
        ) : GWAEvent()

        data class HookEvent(
            override val sessionId: String,
            override val timestamp: Long,
            val hookType: String,
            val data: JsonObject
        ) : GWAEvent()

        data class Unknown(
            override val sessionId: String,
            override val timestamp: Long,
            val routingKey: String,
            val rawPayload: String
        ) : GWAEvent()
    }
    ```

    EventParser:
    - Parse MQTT message payload (JSON) into GWAEventEnvelope
    - Map routing key patterns to GWAEvent subtypes
    - Fallback to GWAEvent.Unknown for unrecognized events

    MqttEventDispatcher:
    - Subscribe to topic patterns on connect
    - Parse incoming messages via EventParser
    - Expose SharedFlow<GWAEvent> for all events
    - Expose filtered flows:
      - sessionEvents(sessionId): Flow<GWAEvent>
      - stateChanges(): Flow<GWAEvent.StateChange>
      - heartbeats(): Flow<GWAEvent.Heartbeat>
      - hookEvents(): Flow<GWAEvent.HookEvent>
      - blockedEvents(): Flow<GWAEvent.SessionBlocked>

dependencies:
  blocked_by: ["f04-001"]
  blocks: ["f04-003"]

validation:
  - Correctly parses state_change events from MQTT
  - Correctly parses heartbeat events
  - Unknown events are captured (not dropped)
  - SharedFlow replays last 100 events for late subscribers
```

### Task 3: Repository Integration

```yaml
task_id: "f04-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/SessionRepository.kt  # MODIFY
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/HealthRepository.kt    # MODIFY
  description: |
    Wire MQTT events into the repository layer:

    SessionRepository changes:
    - Merge REST polling + MQTT real-time updates
    - On GWAEvent.StateChange: update session state in-memory + Room
    - On GWAEvent.SessionBlocked: mark session blocked, store question
    - On GWAEvent.SessionComplete: mark session done
    - Reduce REST polling to 60s when MQTT is connected (fallback only)
    - Keep 10s polling when MQTT is disconnected

    HealthRepository changes:
    - On GWAEvent.Heartbeat: update pod health in-memory
    - Track last heartbeat per pod
    - Mark pods unhealthy after 90s without heartbeat
    - Reduce REST health polling to 120s when MQTT is connected

    Event deduplication:
    - Use routingKey + timestamp as dedup key
    - Window of 5 seconds for dedup

dependencies:
  blocked_by: ["f04-002", "f03-004"]
  blocks: []

validation:
  - Session list updates within 1s of MQTT state_change event
  - Pod health updates within 1s of heartbeat
  - No duplicate events when both REST and MQTT deliver same update
  - Graceful degradation when MQTT disconnects (falls back to polling)
```

### Task 4: MQTT Koin Module

```yaml
task_id: "f04-004"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/di/MqttModule.kt
  description: |
    Wire MQTT components into Koin:
    - single { MqttConnectionManager(get(), androidContext()) }
    - single { MqttEventDispatcher(get()) }

    Update GWAApp.kt to include MqttModule.

dependencies:
  blocked_by: ["f04-002"]
  blocks: []

validation:
  - MQTT connects on app launch
  - Events flow through to repositories
```

---

## Critical Gotchas

1. **RabbitMQ QoS 2 unsupported** — Use QoS 1 everywhere, handle potential duplicates
2. **Retained messages are node-local** — Always fetch initial state via REST API, then overlay MQTT updates
3. **Android Doze mode** — MQTT keepalive may not fire during deep sleep. The foreground service (F10) mitigates this
4. **MQTT topic format** — RabbitMQ MQTT uses `/` separators, not `.` like AMQP routing keys
5. **Clean session** — Must be true since RabbitMQ doesn't persist MQTT sessions well across reconnects

---

## Acceptance Criteria

- [ ] MQTT connects via TCP on LAN and WSS on public network
- [ ] State change events appear in UI within 1 second
- [ ] Heartbeat events update pod health indicators
- [ ] Auto-reconnect works after network drop (tested by toggling airplane mode)
- [ ] Event deduplication prevents duplicate UI updates
- [ ] Falls back to REST polling when MQTT is unavailable
