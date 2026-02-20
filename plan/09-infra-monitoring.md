# Feature 09: Infrastructure Monitoring

**Complexity:** Medium
**Dependencies:** F02 (Design), F03 (Networking), F06 (Dashboard)
**Blocks:** None

---

## Overview

The infrastructure monitoring screen provides visibility into the homelab K3s cluster components that support GWA: pod health, orchestrator status, RabbitMQ connectivity, MinIO storage, credential health, and Grafana dashboard deep links. This is the "is everything working?" screen.

---

## Screen Design

### Phone Layout
```
┌─────────────────────────────────┐
│ ← Infrastructure       🟢 LAN  │
├─────────────────────────────────┤
│ System Health                   │
│ ┌─────────────────────────────┐ │
│ │ Orchestrator   🟢 UP       │ │
│ │ Uptime: 3d 14h  Sessions: 5│ │
│ ├─────────────────────────────┤ │
│ │ RabbitMQ       🟢 Connected│ │
│ │ MQTT: TCP :1883            │ │
│ ├─────────────────────────────┤ │
│ │ MinIO          🟢 Reachable│ │
│ │ Bucket: gwa-recordings     │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Pod Health                      │
│ ┌─────────────────────────────┐ │
│ │ gwa-runner-0   🟢 Healthy  │ │
│ │ Last heartbeat: 15s ago    │ │
│ │ Sessions: 2                │ │
│ ├─────────────────────────────┤ │
│ │ gwa-runner-1   🟢 Healthy  │ │
│ │ Last heartbeat: 22s ago    │ │
│ │ Sessions: 1                │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Projects & Credentials          │
│ ┌─────────────────────────────┐ │
│ │ gwa-main       🟢 Valid    │ │
│ │ Expires: 2h 15m            │ │
│ │ Has refresh token: Yes     │ │
│ ├─────────────────────────────┤ │
│ │ gwa-secondary  🟡 Expiring │ │
│ │ Expires: 45m               │ │
│ │ [Refresh] [Push New]       │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Quick Links                     │
│ [Grafana] [RabbitMQ] [MinIO]   │
├─────────────────────────────────┤
│ [Dashboard] [Sessions] [Infra] │
└─────────────────────────────────┘
```

---

## Tasks

### Task 1: Infrastructure ViewModel

```yaml
task_id: "f09-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/InfraViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/InfraUiState.kt
  description: |
    InfraUiState:
    ```kotlin
    data class InfraUiState(
        val systemHealth: SystemHealthState = SystemHealthState(),
        val pods: List<PodHealthItem> = emptyList(),
        val projects: List<ProjectHealthItem> = emptyList(),
        val connectionPath: ConnectionPath = ConnectionPath.DISCONNECTED,
        val mqttState: MqttConnectionState = MqttConnectionState.Disconnected,
        val isLoading: Boolean = true,
        val error: String? = null
    )

    data class SystemHealthState(
        val orchestratorUp: Boolean = false,
        val orchestratorUptime: Long = 0,
        val orchestratorSessionCount: Int = 0,
        val rabbitmqConnected: Boolean = false,
        val rabbitmqProtocol: String = "disconnected",  // "TCP :1883" or "WSS"
        val minioReachable: Boolean = false
    )

    data class PodHealthItem(
        val podName: String,
        val healthy: Boolean,
        val lastHeartbeat: Long,
        val timeSinceHeartbeat: Long,  // Computed, updated every second
        val sessionCount: Int
    )

    data class ProjectHealthItem(
        val project: ProjectConfig,
        val health: CredentialHealth,
        val expiryStatus: ExpiryStatus  // Valid, Expiring, Expired
    )

    enum class ExpiryStatus { Valid, Expiring, Expired, Unknown }
    ```

    InfraViewModel:
    - Collects from HealthRepository.getSystemHealth()
    - Collects from HealthRepository.getPodHealth()
    - Collects from ProjectRepository.getProjects()
    - Collects ConnectivityManager and MqttConnectionManager state
    - Updates "time since heartbeat" every second via ticker flow
    - Computes ExpiryStatus: <1h = Expiring, expired = Expired

dependencies:
  blocked_by: ["f03-004"]
  blocks: ["f09-002"]

validation:
  - Shows live system health from /health endpoint
  - Pod health updates from MQTT heartbeats
  - Credential expiry status computed correctly
```

### Task 2: Infrastructure Screen

```yaml
task_id: "f09-002"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/InfraScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/SystemHealthCard.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/PodHealthSection.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/ProjectHealthSection.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/QuickLinksSection.kt
  description: |
    InfraScreen:
    - Scrollable column of infrastructure sections
    - Pull-to-refresh
    - On tablet: two-column layout (system + pods left, projects + links right)

    SystemHealthCard:
    - Orchestrator status with uptime and session count
    - RabbitMQ status with connection protocol
    - MinIO reachability check
    - Each row: service name, status indicator (colored dot), detail text

    PodHealthSection:
    - Card for each pod
    - Green/red health indicator
    - Live "last heartbeat: Xs ago" counter (updates every second)
    - Session count per pod
    - Tap to expand: show recent events from that pod

    ProjectHealthSection:
    - Card for each project
    - Credential health: valid/expiring/expired
    - Expires in: countdown
    - Has refresh token: yes/no
    - Actions: "Refresh" button (calls POST /projects/:id/refresh)
    - Tap to expand: credential history

    QuickLinksSection:
    - Links that open in external browser:
      - Grafana: grafana.bto.bar
      - RabbitMQ Management: rabbitmq.bto.bar
      - MinIO Console: minio.bto.bar
    - Only shown when on LAN or WARP (services not publicly accessible)

dependencies:
  blocked_by: ["f09-001", "f02-002"]
  blocks: []

validation:
  - All infrastructure components show their health status
  - Pod heartbeat counters tick in real-time
  - Credential refresh action works
  - Quick links open in browser
  - Tablet layout uses two columns
```

### Task 3: Credential Management Actions

```yaml
task_id: "f09-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/CredentialActions.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/infra/CredentialHistorySheet.kt
  description: |
    CredentialActions:
    - "Refresh" button: Calls POST /projects/:id/refresh
      Shows loading state, success/error result
    - "Push New" button: Opens dialog to manually push credentials
      (Advanced — may not need for v1, but include the UI skeleton)
    - "View History" button: Opens bottom sheet

    CredentialHistorySheet:
    - Bottom sheet showing credential history
    - Calls GET /projects/:id/credentials/history
    - Shows: source (push/refresh), timestamp, expiry, token prefix
    - Color-coded: valid (green), invalidated (gray), expired (red)

dependencies:
  blocked_by: ["f09-002", "f03-003"]
  blocks: []

validation:
  - Credential refresh sends API call and shows result
  - Credential history loads and displays correctly
  - Error states handled gracefully
```

---

## Acceptance Criteria

- [ ] Orchestrator health status reflects reality
- [ ] Pod health indicators update in real-time from heartbeats
- [ ] Credential expiry warnings show when < 1 hour remaining
- [ ] Credential refresh action works
- [ ] Quick links open correct URLs in browser
- [ ] Infrastructure screen is responsive (phone vs tablet)
- [ ] Pull-to-refresh triggers fresh data fetch
