# Feature 07: Session Management

**Complexity:** High
**Dependencies:** F02 (Design), F03 (Networking), F04 (MQTT), F06 (Dashboard)
**Blocks:** F08 (Terminal), F11 (LLM Events)

---

## Overview

The session management screens provide detailed views of individual GWA sessions, including state visualization, activity feeds, the ability to answer blocked sessions, terminal snapshot viewing, and session recording playback. This is the core workflow screen — where you go to understand what Claude is doing and interact with blocked sessions.

---

## Screen Designs

### Session List Screen (Phone)
```
┌─────────────────────────────────┐
│ ← Sessions          Filter ▼   │
├─────────────────────────────────┤
│ ┌─────────────────────────────┐ │
│ │ jaybrto/gwa #42             │ │
│ │ 🔴 Blocked  gwa-runner-0   │ │
│ │ "What auth method for..."   │ │
│ │ 3 min ago                   │ │
│ ├─────────────────────────────┤ │
│ │ jaybrto/gwa #15             │ │
│ │ 🟢 In Progress gwa-runner-1│ │
│ │ Tool: Bash (bun test)       │ │
│ │ 1 min ago                   │ │
│ ├─────────────────────────────┤ │
│ │ jaybrto/gwa #23             │ │
│ │ 🔵 Planning  gwa-runner-0  │ │
│ │ Reading issue #23...        │ │
│ │ 5 min ago                   │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ [Dashboard] [Sessions] [Infra] │
└─────────────────────────────────┘
```

### Session Detail Screen (Phone)
```
┌─────────────────────────────────┐
│ ← jaybrto/gwa #42    🔴 Blocked│
├─────────────────────────────────┤
│ ┌─ State Flow ────────────────┐ │
│ │ idle → planning → blocked   │ │
│ │  ○       ○          ●       │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ ⚠ Needs your input:            │
│ "What authentication method    │
│  should I use for the API?"    │
│ ┌─────────────────────────────┐ │
│ │ Type your answer...         │ │
│ │                             │ │
│ └─────────────────────────────┘ │
│ [Send Answer]                   │
├─────────────────────────────────┤
│ [Activity] [Terminal] [LLM]     │  ← Tab row
├─────────────────────────────────┤
│ Activity Feed                   │
│ 12:34 state_change → blocked   │
│ 12:33 tool: Read package.json  │
│ 12:32 tool: Grep "auth"       │
│ 12:31 state_change → in_prog  │
│ 12:30 state_change → planning  │
│ ...                             │
├─────────────────────────────────┤
│ Snapshots (3)                   │
│ [📸 planning] [📸 work] [📸 blocked]│
├─────────────────────────────────┤
│ Recordings (1)                  │
│ [▶ session-42.cast  12:30-now] │
└─────────────────────────────────┘
```

### Session Detail (Tablet — Side Panel)
On tablet, this renders in the detail pane of MasterDetailLayout, with the session list visible in the left pane.

---

## Tasks

### Task 1: Session List Screen

```yaml
task_id: "f07-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/SessionListScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/SessionListViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/SessionListUiState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/SessionFilter.kt
  description: |
    SessionListUiState:
    ```kotlin
    data class SessionListUiState(
        val sessions: List<SessionListItem> = emptyList(),
        val filter: SessionFilter = SessionFilter.Active,
        val isLoading: Boolean = true,
        val error: String? = null
    )

    data class SessionListItem(
        val session: AggregatedSession,
        val latestActivity: String?,    // Last tool call or event description
        val lastHookEvent: HookEvent?,  // Last Claude Code hook event
        val isNew: Boolean = false      // Animated entrance for new sessions
    )

    enum class SessionFilter {
        All, Active, Blocked, Done
    }
    ```

    SessionListViewModel:
    - Collects from SessionRepository
    - Applies filter
    - Enriches with latest hook event info from HookEventRepository
    - Sort: Blocked first, then by lastEventAt descending

    SessionListScreen:
    - LazyColumn with SessionCard components
    - Filter chips at top (All / Active / Blocked / Done)
    - Pull-to-refresh
    - Empty state when no sessions match filter
    - On tablet: part of MasterDetailLayout (left pane)

dependencies:
  blocked_by: ["f03-004", "f02-002"]
  blocks: ["f07-002"]

validation:
  - Shows all sessions from orchestrator
  - Filter correctly shows only matching sessions
  - Blocked sessions sort to top
  - New sessions animate in
```

### Task 2: Session Detail Screen

```yaml
task_id: "f07-002"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/SessionDetailScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/SessionDetailViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/SessionDetailUiState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/StateFlowDiagram.kt
  description: |
    SessionDetailUiState:
    ```kotlin
    data class SessionDetailUiState(
        val session: AggregatedSession? = null,
        val activityFeed: List<ActivityEntry> = emptyList(),
        val hookEvents: List<HookEvent> = emptyList(),
        val snapshots: List<TerminalSnapshot> = emptyList(),
        val recordings: List<RecordingMetadata> = emptyList(),
        val isBlocked: Boolean = false,
        val blockedQuestion: String? = null,
        val answerText: String = "",
        val isSendingAnswer: Boolean = false,
        val isLoading: Boolean = true,
        val error: String? = null,
        val selectedTab: DetailTab = DetailTab.Activity
    )

    enum class DetailTab { Activity, Terminal, LLMEvents }
    ```

    SessionDetailScreen:
    - Header: Repo name, issue number, state chip, pod name
    - StateFlowDiagram: Horizontal state progression visualization
      Shows: idle → planning → inProgress → qa → review → done
      Highlights current state, shows completed states dimmed
      Animated transitions when state changes via MQTT
    - Answer section: Only visible when state == blocked
    - Tab row: Activity / Terminal / LLM Events
    - Content based on selected tab

    StateFlowDiagram:
    - Canvas-based Compose component
    - Horizontal line with circles for each state
    - Current state: filled, pulsing
    - Past states: filled, dimmed
    - Future states: outline only
    - Animated transition when state changes

dependencies:
  blocked_by: ["f07-001", "f03-004", "f04-002"]
  blocks: ["f07-003"]

validation:
  - Shows session detail with all data
  - State flow diagram correctly reflects current state
  - State changes animate in real-time from MQTT
  - Tab navigation works
```

### Task 3: Answer Blocked Session

```yaml
task_id: "f07-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/AnswerSection.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/AnswerDialog.kt
  description: |
    AnswerSection (inline on detail screen):
    - Shows when session state == blocked
    - Displays the question text (from blocked event payload)
    - Multi-line text input for answer
    - Send button (with loading state)
    - Calls SessionRepository.sendAnswer()
    - On success: optimistically update UI to show "Answer sent"
    - On error: show error message, keep text input

    AnswerDialog (for quick action from dashboard):
    - Full-screen dialog or bottom sheet
    - Shows session context (repo, issue, state history)
    - Same answer input + send functionality
    - Can be launched from dashboard blocked alert

    The answer is sent via POST /sessions/:id/answer which publishes
    to gwa.commands.send_answer AMQP routing key.

dependencies:
  blocked_by: ["f07-002", "f03-003"]
  blocks: []

validation:
  - Answer is sent to orchestrator API
  - Session state updates after answer (via MQTT event)
  - UI shows loading state while sending
  - Error state shows if API call fails
```

### Task 4: Activity Feed Tab

```yaml
task_id: "f07-004"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/ActivityFeedTab.kt
  description: |
    Activity feed for a specific session:
    - Uses EventTimeline component from F02
    - Shows events from REST API activity feed + live MQTT events
    - Merged and deduplicated
    - Each entry shows:
      - Timestamp (relative: "2m ago")
      - Event type icon (state_change, tool_call, snapshot, etc.)
      - Description (human-readable event summary)
      - Expandable detail (raw JSON in CodeBlock)
    - Auto-scrolls to newest (toggle with "pin to bottom" button)
    - Virtual list for performance (could have 1000s of events)

dependencies:
  blocked_by: ["f07-002"]
  blocks: []

validation:
  - Shows activity feed from REST + MQTT
  - Events are chronologically ordered
  - Virtual list handles 1000+ events without jank
  - Expanding event shows raw JSON detail
```

### Task 5: Snapshots & Recordings Tab

```yaml
task_id: "f07-005"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/SnapshotsSection.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/RecordingsSection.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/sessions/detail/SnapshotViewer.kt
  description: |
    SnapshotsSection:
    - Horizontal LazyRow of snapshot thumbnails
    - Each shows: event type label, timestamp
    - Tap opens SnapshotViewer

    SnapshotViewer:
    - Full-screen modal
    - SVG rendering (via Coil SVG decoder) or ANSI text rendering
    - Pinch-to-zoom
    - Swipe between snapshots

    RecordingsSection:
    - List of recording entries
    - Each shows: filename, duration, size
    - "Play" button generates presigned URL and opens in external player
      OR uses a simple asciicast player (WebView with asciinema-player.js)
    - Download option

    Note: SVG snapshots are stored in the orchestrator SQLite DB and served
    via the activity feed. Recordings are in MinIO with presigned URLs.

dependencies:
  blocked_by: ["f07-002", "f03-003"]
  blocks: []

validation:
  - Snapshots render (SVG or raw ANSI)
  - Recordings can be played back
  - Presigned URLs work from phone on LAN
```

---

## Acceptance Criteria

- [ ] Session list shows all sessions with correct state indicators
- [ ] Filter works for All / Active / Blocked / Done
- [ ] Session detail shows state flow diagram
- [ ] Blocked session answer flow works end-to-end
- [ ] Activity feed shows real-time events from MQTT
- [ ] Snapshots render and are zoomable
- [ ] Recordings play back
- [ ] Tablet layout shows master-detail side-by-side
