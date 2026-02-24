# Feature 06: Dashboard Home Screen

**Complexity:** Medium
**Dependencies:** F02 (Design System), F03 (Networking), F04 (MQTT)
**Blocks:** F07 (Session Management), F09 (Infra Monitoring)

---

## Overview

The dashboard home screen is the first thing you see when opening the app. It provides a heads-up display of the entire GWA system: active sessions, pod health, connectivity status, recent events, and quick actions. Think Grafana home dashboard meets mobile ops console.

---

## Screen Design

### Phone Layout (Pixel 10 Pro XL)
```
┌─────────────────────────────────┐
│ ▼ GWA Dashboard     🟢 LAN     │  ← Connection status bar
├─────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐      │
│ │ Active: 3│ │ Blocked:1│      │  ← Metric cards row
│ └──────────┘ └──────────┘      │
│ ┌──────────┐ ┌──────────┐      │
│ │ Pods: 2  │ │ Done: 12 │      │  ← Metric cards row
│ └──────────┘ └──────────┘      │
├─────────────────────────────────┤
│ ⚠ BLOCKED: repo#42 needs input │  ← Alert banner (if any blocked)
│   [Answer Now]                  │
├─────────────────────────────────┤
│ Active Sessions                 │
│ ┌─────────────────────────────┐ │
│ │ 🟢 repo#15  In Progress    │ │  ← Session cards
│ │    gwa-runner-0  2m ago    │ │
│ ├─────────────────────────────┤ │
│ │ 🔵 repo#23  Planning       │ │
│ │    gwa-runner-1  5m ago    │ │
│ ├─────────────────────────────┤ │
│ │ 🔴 repo#42  Blocked        │ │
│ │    gwa-runner-0  1m ago    │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ Recent Events                   │
│ 12:34 state_change repo#15     │  ← Event timeline
│ 12:32 tool_call repo#15       │
│ 12:30 snapshot repo#23        │
├─────────────────────────────────┤
│ [Dashboard] [Sessions] [Infra] │  ← Bottom nav
└─────────────────────────────────┘
```

### Tablet Layout (>840dp)
```
┌────────────────────────────────────────────────────────┐
│ 🟢 LAN  │  GWA Dashboard                              │
├──────────┤─────────────────────────────────────────────┤
│          │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐          │
│ Dashboard│  │Act:3│ │Blk:1│ │Pod:2│ │Done │          │
│          │  └─────┘ └─────┘ └─────┘ └─────┘          │
│ Sessions │──────────────────────────────────────────── │
│          │  ⚠ BLOCKED: repo#42 needs input [Answer]   │
│ Infra    │──────────────────┬──────────────────────── │
│          │  Active Sessions │ Recent Events           │
│ LLM      │  ┌─────────────┐│ 12:34 state_change     │
│          │  │ repo#15     ││ 12:32 tool_call        │
│ Settings │  │ In Progress ││ 12:30 snapshot         │
│          │  ├─────────────┤│ 12:28 heartbeat        │
│  [Rail]  │  │ repo#23     ││ 12:25 state_change     │
│          │  │ Planning    ││                         │
│          │  └─────────────┘│                         │
└──────────┴─────────────────┴──────────────────────────┘
```

---

## Tasks

### Task 1: Dashboard ViewModel

```yaml
task_id: "f06-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/DashboardViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/DashboardUiState.kt
  description: |
    DashboardUiState:
    ```kotlin
    data class DashboardUiState(
        val connectionPath: ConnectionPath = ConnectionPath.DISCONNECTED,
        val mqttConnected: Boolean = false,
        val activeSessions: List<AggregatedSession> = emptyList(),
        val blockedSessions: List<AggregatedSession> = emptyList(),
        val podHealth: List<PodHealth> = emptyList(),
        val recentEvents: List<GWAEvent> = emptyList(),
        val metrics: DashboardMetrics = DashboardMetrics(),
        val isLoading: Boolean = true,
        val error: String? = null
    )

    data class DashboardMetrics(
        val activeCount: Int = 0,
        val blockedCount: Int = 0,
        val healthyPodCount: Int = 0,
        val totalPodCount: Int = 0,
        val completedToday: Int = 0
    )
    ```

    DashboardViewModel:
    - Collects from SessionRepository.getSessions()
    - Collects from HealthRepository.getPodHealth()
    - Collects from MqttEventDispatcher for recent events (last 20)
    - Collects from ConnectivityManager for connection path
    - Collects from MqttConnectionManager for MQTT state
    - Computes metrics from session list
    - Filters blocked sessions for alert banner
    - Recent events: last 20 events of any type, newest first

dependencies:
  blocked_by: ["f03-004", "f04-002"]
  blocks: ["f06-002"]

validation:
  - UiState updates within 1s of new MQTT events
  - Metrics are computed correctly from session list
  - Blocked sessions appear in alert banner
```

### Task 2: Dashboard Screen (Compose)

```yaml
task_id: "f06-002"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/DashboardScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/MetricsRow.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/BlockedAlert.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/ActiveSessionsList.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/RecentEventsTimeline.kt
  description: |
    DashboardScreen:
    - Uses AdaptiveScaffold from F02
    - Phone: Vertical scrolling column
    - Tablet: Two-column grid (sessions left, events right)
    - Pull-to-refresh triggers REST API fetch

    MetricsRow:
    - 4 MetricCard components in a 2x2 grid (phone) or 4x1 row (tablet)
    - Active sessions, Blocked count, Pod health, Completed today
    - Blocked count pulses red if > 0

    BlockedAlert:
    - Red/orange banner at top when any session is blocked
    - Shows first blocked session's repo/issue
    - "Answer Now" button navigates to session detail
    - Dismiss temporarily (snooze 5 min)

    ActiveSessionsList:
    - LazyColumn of SessionCard components
    - Sorted: Blocked first, then by lastEventAt desc
    - Tap navigates to SessionDetail screen
    - Shows max 10, with "View all →" link

    RecentEventsTimeline:
    - EventTimeline component from F02
    - Last 20 events from MQTT
    - Auto-scrolls to newest (can be paused)
    - Tap event navigates to relevant session

dependencies:
  blocked_by: ["f06-001", "f02-002", "f02-003"]
  blocks: []

validation:
  - Dashboard renders with real data from orchestrator
  - Blocked alert appears when sessions are blocked
  - Navigation to session detail works
  - Pull-to-refresh updates data
  - Tablet layout shows two-column view
```

### Task 3: Quick Actions

```yaml
task_id: "f06-003"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/QuickActions.kt
  description: |
    Floating action menu or bottom sheet with quick actions:
    - "Answer Blocked" — navigate to first blocked session's answer dialog
    - "View Terminal" — navigate to most active session's terminal
    - "Refresh All" — force REST fetch + MQTT reconnect

    Only shows "Answer Blocked" when there are blocked sessions.

dependencies:
  blocked_by: ["f06-002"]
  blocks: []

validation:
  - Quick actions are contextual (blocked action only shows when relevant)
  - Navigation works correctly
```

---

## Acceptance Criteria

- [ ] Dashboard shows real-time metrics (active, blocked, pods, completed)
- [ ] Blocked session alert is prominent and actionable
- [ ] Active sessions list shows current state with color coding
- [ ] Recent events timeline auto-updates from MQTT
- [ ] Layout is responsive (phone vs tablet)
- [ ] Pull-to-refresh works
- [ ] Connection status bar shows current connectivity path
