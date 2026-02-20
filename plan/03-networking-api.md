# Feature 03: Networking & API Layer

**Complexity:** High
**Dependencies:** F01 (Project Scaffolding)
**Blocks:** F04 (MQTT), F06 (Dashboard), F07 (Sessions), F08 (Terminal), F09 (Infra)

---

## Overview

Implement the HTTP client layer that communicates with the GWA Orchestrator REST API. This includes the multi-path connectivity model (LAN → WARP → Public), authentication, response parsing, and a repository pattern for clean data access.

---

## GWA Orchestrator API Surface

The Android app consumes these endpoints (from `src/orchestrator/rest-api.ts`):

### Public Endpoints (No Auth)
| Method | Path | Response |
|--------|------|----------|
| GET | `/health` | `{ status, uptime, pods: PodHealth[], sessionCount }` |
| GET | `/sessions` | `AggregatedSession[]` |
| GET | `/sessions/:id` | `AggregatedSession & { activity: ActivityEntry[] }` |
| POST | `/sessions/:id/answer` | `{ status: "answer_sent" }` — Body: `{ answer: string }` |
| GET | `/sessions/:id/snapshots` | `SnapshotEntry[]` |
| GET | `/sessions/:id/recordings` | `RecordingEntry[]` |

### Authenticated Endpoints (Bearer API Key)
| Method | Path | Response |
|--------|------|----------|
| GET | `/projects` | `ProjectConfig[]` (with health) |
| GET | `/projects/:id` | `ProjectConfig & { credentialHealth }` |
| GET | `/projects/:id/health` | `CredentialHealth` |
| GET | `/projects/:id/credentials/history` | `CredentialHistoryEntry[]` |
| POST | `/projects/:id/credentials` | Push new credentials |
| POST | `/projects/:id/provision` | Provision environment bundle |
| POST | `/projects/:id/refresh` | Trigger OAuth refresh |

---

## Tasks

### Task 1: Data Models (Kotlin)

```yaml
task_id: "f03-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/Session.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/SessionState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/PodHealth.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/SystemHealth.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/ActivityEntry.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/Project.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/CredentialHealth.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/Recording.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/Snapshot.kt
  description: |
    Kotlin data classes mirroring the GWA TypeScript types.
    Use @Serializable (kotlinx.serialization) for JSON parsing.

    SessionState enum:
    ```kotlin
    enum class SessionState(val displayName: String, val apiValue: String) {
        Idle("Idle", "idle"),
        Planning("Planning", "planning"),
        InProgress("In Progress", "in_progress"),
        QA("QA", "qa"),
        Blocked("Blocked", "blocked"),
        Review("Review", "review"),
        Done("Done", "done");

        companion object {
            fun fromApi(value: String): SessionState =
                entries.find { it.apiValue == value } ?: Idle
        }
    }
    ```

    AggregatedSession:
    ```kotlin
    @Serializable
    data class AggregatedSession(
        val sessionId: String,
        val podName: String,
        val state: String,
        val issueNumber: Int,
        val repo: String,
        val lastEventAt: Long,
        val createdAt: Long,
        val activity: List<ActivityEntry>? = null
    )
    ```

    Map all types from src/shared/types.ts:
    - PodHealth
    - SystemHealth (health endpoint response)
    - ActivityEntry (routing_key, payload, created_at)
    - ProjectConfig
    - CredentialHealth
    - RecordingMetadata
    - TerminalSnapshot
    - CredentialHistoryEntry

dependencies:
  blocked_by: ["f01-002"]
  blocks: ["f03-002", "f03-003"]

validation:
  - All data classes parse sample JSON from the orchestrator API
  - SessionState enum covers all 7 states
  - @Serializable annotation works with kotlinx.serialization
```

### Task 2: Connectivity Manager

```yaml
task_id: "f03-002"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/network/ConnectivityManager.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/network/ConnectionPath.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/network/NetworkMonitor.kt
  description: |
    ConnectionPath enum:
    ```kotlin
    enum class ConnectionPath {
        LAN_DIRECT,    // On homelab WiFi, direct to ClusterIP
        WARP_VPN,      // Through Cloudflare WARP tunnel
        PUBLIC_HTTPS,  // Public endpoint via Cloudflare
        DISCONNECTED   // No connectivity
    }
    ```

    ConnectivityManager:
    - Determine current ConnectionPath on startup and network changes
    - LAN detection: Check if device IP is in 10.x.x.x or 192.168.x.x range
      AND can reach the orchestrator on the ClusterIP
    - WARP detection: Check for active VPN interface (tun0 or similar)
      AND can reach the orchestrator on the ClusterIP
    - Public fallback: Use public URL (gwa.bto.bar)
    - Expose StateFlow<ConnectionPath> for UI binding

    NetworkMonitor:
    - Register Android ConnectivityManager callback
    - Emit network state changes
    - Debounce rapid changes (e.g., WiFi handoff)

    Base URL resolution:
    ```kotlin
    fun getBaseUrl(path: ConnectionPath): String = when(path) {
        LAN_DIRECT -> "http://gwa-orchestrator.default.svc:3001"
        WARP_VPN -> "http://gwa-orchestrator.default.svc:3001"
        PUBLIC_HTTPS -> "https://gwa.bto.bar"
        DISCONNECTED -> throw NoConnectivityException()
    }
    ```

dependencies:
  blocked_by: ["f03-001"]
  blocks: ["f03-003"]

validation:
  - Correctly detects LAN when on homelab WiFi
  - Falls back to public URL when off-network
  - StateFlow emits changes when network state changes
```

### Task 3: HTTP Client (Ktor)

```yaml
task_id: "f03-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/network/GWAApiClient.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/network/ApiResult.kt
  description: |
    GWAApiClient using Ktor:
    - Configures Ktor HttpClient with:
      - CIO engine
      - ContentNegotiation (kotlinx.serialization JSON)
      - Logging (Timber)
      - Timeout (10s connect, 30s request)
      - Custom interceptor for Bearer auth on /projects/* routes

    - Dynamically selects base URL from ConnectivityManager
    - Retry logic: 1 retry on network errors with 2s delay

    ApiResult sealed class:
    ```kotlin
    sealed class ApiResult<out T> {
        data class Success<T>(val data: T) : ApiResult<T>()
        data class Error(val code: Int?, val message: String) : ApiResult<Nothing>()
        data class NetworkError(val exception: Throwable) : ApiResult<Nothing>()
    }
    ```

    API methods:
    ```kotlin
    suspend fun getHealth(): ApiResult<SystemHealth>
    suspend fun getSessions(): ApiResult<List<AggregatedSession>>
    suspend fun getSession(id: String): ApiResult<AggregatedSession>
    suspend fun sendAnswer(sessionId: String, answer: String): ApiResult<Unit>
    suspend fun getSnapshots(sessionId: String): ApiResult<List<Snapshot>>
    suspend fun getRecordings(sessionId: String): ApiResult<List<Recording>>
    suspend fun getProjects(): ApiResult<List<ProjectConfig>>
    suspend fun getProject(id: String): ApiResult<ProjectConfig>
    suspend fun getProjectHealth(id: String): ApiResult<CredentialHealth>
    suspend fun getCredentialHistory(id: String, limit: Int = 10): ApiResult<List<CredentialHistoryEntry>>
    suspend fun pushCredentials(projectId: String, request: CredentialPushRequest): ApiResult<Unit>
    suspend fun refreshCredential(projectId: String): ApiResult<Unit>
    ```

dependencies:
  blocked_by: ["f03-001", "f03-002"]
  blocks: ["f03-004"]

validation:
  - All API methods successfully parse orchestrator responses
  - Auth header is sent only for /projects/* endpoints
  - Base URL switches when connectivity changes
  - Network errors are wrapped in ApiResult.NetworkError
```

### Task 4: Repository Layer

```yaml
task_id: "f03-004"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/SessionRepository.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/ProjectRepository.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/HealthRepository.kt
  description: |
    Repository pattern wrapping API + local cache (Room):

    SessionRepository:
    - getSessions(): Flow<List<AggregatedSession>> — polls API every 10s,
      caches in Room for offline access
    - getSession(id): Flow<AggregatedSession> — single session with activity
    - sendAnswer(sessionId, answer): suspend
    - getSnapshots(sessionId): suspend
    - getRecordings(sessionId): suspend

    ProjectRepository:
    - getProjects(): Flow<List<ProjectConfig>>
    - getProjectHealth(id): Flow<CredentialHealth>
    - getCredentialHistory(id): suspend

    HealthRepository:
    - getSystemHealth(): Flow<SystemHealth> — polls every 30s
    - getPodHealth(): Flow<List<PodHealth>>

    All repositories:
    - Use coroutine scope tied to Application lifecycle
    - Emit loading/error/success states
    - Merge REST polling data with MQTT real-time updates (F04 will wire this)

dependencies:
  blocked_by: ["f03-003"]
  blocks: []

validation:
  - Repositories emit data via Flow
  - Offline cached data is returned when network is down
  - Polling intervals are correct (10s sessions, 30s health)
```

### Task 5: Room Database (Local Cache)

```yaml
task_id: "f03-005"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/GWADatabase.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/dao/SessionDao.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/dao/EventDao.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/entity/SessionEntity.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/entity/EventEntity.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/Converters.kt
  description: |
    Room database for offline caching:

    Tables:
    - sessions: Mirror of AggregatedSession for offline access
    - events: Cached activity feed + MQTT events
    - pod_health: Last known pod health status

    SessionDao:
    - Insert/upsert sessions
    - Query all sessions as Flow
    - Query by ID
    - Delete stale sessions (older than 7 days)

    EventDao:
    - Insert events (with dedup by routing_key + timestamp)
    - Query events for a session
    - Retention: Auto-delete events older than 48 hours

    Converters:
    - Long ↔ Instant/Date converters
    - JSON string ↔ Map converters for payload

dependencies:
  blocked_by: ["f03-001"]
  blocks: []

validation:
  - Room compiles with KSP
  - DAO queries return Flow
  - Retention cleanup runs on app start
```

### Task 6: Koin DI Module

```yaml
task_id: "f03-006"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/di/NetworkModule.kt
    - android/app/src/main/kotlin/bar/bto/gwa/di/DatabaseModule.kt
    - android/app/src/main/kotlin/bar/bto/gwa/di/RepositoryModule.kt
  description: |
    Wire up all networking/data components with Koin:

    NetworkModule:
    - single { ConnectivityManager(androidContext()) }
    - single { GWAApiClient(get()) }

    DatabaseModule:
    - single { Room.databaseBuilder(...).build() }
    - factory { get<GWADatabase>().sessionDao() }
    - factory { get<GWADatabase>().eventDao() }

    RepositoryModule:
    - single { SessionRepository(get(), get()) }
    - single { ProjectRepository(get()) }
    - single { HealthRepository(get()) }

dependencies:
  blocked_by: ["f03-003", "f03-004", "f03-005"]
  blocks: []

validation:
  - Koin module resolves all dependencies without cycle errors
  - Injection works in ViewModel via koinInject()
```

---

## Acceptance Criteria

- [ ] HTTP client connects to orchestrator on LAN and public paths
- [ ] All 12+ API endpoints are callable with typed responses
- [ ] Connectivity manager detects LAN vs WARP vs public
- [ ] Offline cached data renders when network is unavailable
- [ ] API key is stored securely (local.properties → BuildConfig)
- [ ] Room database schema compiles and migrates
