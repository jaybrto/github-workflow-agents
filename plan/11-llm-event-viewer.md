# Feature 11: Claude LLM Event Viewer

**Complexity:** High
**Dependencies:** F02 (Design), F04 (MQTT), F05 (Hooks Stream), F07 (Session Management)
**Blocks:** None

---

## Overview

The LLM Event Viewer provides a real-time view of Claude Code's internal operations during a session: tool calls with arguments and results, assistant text generation, token usage, and cost tracking. This is the "what is Claude doing right now?" screen — like a debug console for the AI agent.

This feature depends on the Claude Code hooks event stream (F05) being deployed on the backend.

---

## Screen Design

### Phone Layout
```
┌─────────────────────────────────┐
│ ← LLM Events   jaybrto/gwa #15│
├─────────────────────────────────┤
│ Session Metrics                 │
│ ┌───────┐ ┌───────┐ ┌────────┐ │
│ │Tools  │ │Tokens │ │ Cost   │ │
│ │  47   │ │ 125K  │ │ $1.23  │ │
│ └───────┘ └───────┘ └────────┘ │
├─────────────────────────────────┤
│ [All] [Tools] [Text] [Errors]  │  ← Filter tabs
├─────────────────────────────────┤
│ ▼ 12:34:56 Bash                │
│   $ bun test                   │
│   ✓ 3.2s — 0 exit code        │
│ ┌─ Output ───────────────────┐ │
│ │ PASS src/lib/amqp.test.ts  │ │
│ │ PASS src/lib/db.test.ts    │ │
│ │ ...truncated (2.1KB)       │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ ▶ 12:34:52 Read                │
│   src/shared/types.ts          │
├─────────────────────────────────┤
│ ▶ 12:34:50 Edit                │
│   src/lib/amqp.ts:45           │
├─────────────────────────────────┤
│ ▶ 12:34:48 Grep                │
│   pattern: "publishEvent"      │
├─────────────────────────────────┤
│ ▶ 12:34:45 Bash                │
│   $ git status                 │
├─────────────────────────────────┤
│ ■ 12:34:30 Turn Complete       │
│   Tokens: input 12K output 3K │
│   Cost: $0.15                  │
└─────────────────────────────────┘
```

### Tablet Layout
Two-pane: event list on left (40%), event detail on right (60%). Selecting an event shows full input/output in the detail pane.

---

## Tasks

### Task 1: LLM Events ViewModel

```yaml
task_id: "f11-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/LLMEventsViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/LLMEventsUiState.kt
  description: |
    LLMEventsUiState:
    ```kotlin
    data class LLMEventsUiState(
        val sessionId: String,
        val events: List<LLMEventItem> = emptyList(),
        val filter: LLMEventFilter = LLMEventFilter.All,
        val metrics: LLMSessionMetrics = LLMSessionMetrics(),
        val selectedEvent: LLMEventItem? = null,
        val isPaused: Boolean = false,
        val isLoading: Boolean = true,
        val error: String? = null
    )

    sealed class LLMEventItem {
        abstract val timestamp: Long
        abstract val id: String

        data class ToolCall(
            override val id: String,
            override val timestamp: Long,
            val toolName: String,
            val inputSummary: String,
            val outputSummary: String?,
            val durationMs: Long?,
            val success: Boolean,
            val isExpanded: Boolean = false,
            val fullInput: String? = null,    // Loaded on expand
            val fullOutput: String? = null    // Loaded on expand
        ) : LLMEventItem()

        data class Notification(
            override val id: String,
            override val timestamp: Long,
            val message: String
        ) : LLMEventItem()

        data class TurnComplete(
            override val id: String,
            override val timestamp: Long,
            val inputTokens: Long,
            val outputTokens: Long,
            val cost: Double?,
            val stopReason: String?
        ) : LLMEventItem()

        data class Error(
            override val id: String,
            override val timestamp: Long,
            val toolName: String?,
            val errorMessage: String
        ) : LLMEventItem()
    }

    data class LLMSessionMetrics(
        val totalToolCalls: Int = 0,
        val totalInputTokens: Long = 0,
        val totalOutputTokens: Long = 0,
        val estimatedCostUsd: Double = 0.0,
        val toolBreakdown: Map<String, Int> = emptyMap()  // tool name → count
    )

    enum class LLMEventFilter { All, Tools, Text, Errors }
    ```

    LLMEventsViewModel:
    - Collects from HookEventRepository for the given sessionId
    - Transforms HookEvent → LLMEventItem
    - Maps PreToolUse + PostToolUse → single ToolCall item
      (match by tool name + approximate timestamp)
    - Computes running metrics (tool counts, token totals, cost)
    - Filter support: All / Tools only / Notifications / Errors
    - Pause/resume: When paused, new events buffer but list doesn't scroll
    - Event expansion: Load full input/output from Room when expanded

dependencies:
  blocked_by: ["f05-005", "f04-002"]
  blocks: ["f11-002"]

validation:
  - Events stream in real-time from MQTT hooks
  - Pre/Post tool events are merged into single ToolCall items
  - Metrics update as events arrive
  - Filter correctly shows only matching event types
```

### Task 2: LLM Events Screen

```yaml
task_id: "f11-002"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/LLMEventsScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/LLMMetricsBar.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/ToolCallCard.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/TurnCompleteCard.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/LLMEventDetail.kt
  description: |
    LLMEventsScreen:
    - Accessed as a tab within SessionDetailScreen (F07)
    - Also accessible as a top-level screen from navigation
    - Phone: Scrolling list with expandable items
    - Tablet: Two-pane (list left, detail right)

    LLMMetricsBar:
    - Horizontal row of 3 metric chips at top:
      - Tool calls count
      - Total tokens (input + output)
      - Estimated cost (USD)
    - Updates in real-time as events stream in
    - Tap on "tools" chip: expand to show breakdown by tool type

    ToolCallCard:
    - Collapsed: Icon (per tool type), tool name, input summary, timestamp
    - Tool-specific icons:
      - Bash: terminal icon
      - Read: file icon
      - Write/Edit: pencil icon
      - Glob/Grep: search icon
      - WebFetch/WebSearch: globe icon
      - Task: people icon (sub-agent)
    - Success/failure indicator (green check / red X)
    - Duration badge (e.g., "3.2s")
    - Expanded: Full input + output in CodeBlock components
    - Output truncation indicator ("...truncated, tap to load full")

    TurnCompleteCard:
    - Shows token usage (input/output/cache)
    - Shows cost estimate
    - Stop reason badge
    - Separator line styling (marks end of a Claude turn)

    LLMEventDetail (tablet right pane):
    - Full input JSON in CodeBlock (syntax highlighted)
    - Full output text in CodeBlock
    - Copy buttons for both
    - Metadata: timestamp, duration, tool name

    Event list:
    - LazyColumn with virtual scrolling
    - Auto-scroll to bottom when new events arrive (unless paused)
    - "Pause" FAB to stop auto-scroll
    - New event count badge when paused: "3 new events ↓"

dependencies:
  blocked_by: ["f11-001", "f02-002"]
  blocks: []

validation:
  - Tool calls render with correct icons per tool type
  - Expanded view shows full input/output
  - Metrics update in real-time
  - Auto-scroll works and can be paused
  - Tablet shows two-pane layout
  - Long outputs are truncated with "load more" option
```

### Task 3: Tool Call Analytics

```yaml
task_id: "f11-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/ToolAnalyticsSheet.kt
  description: |
    Bottom sheet showing tool call analytics for the session:

    - Bar chart: Tool call count by type (Bash, Read, Write, Edit, etc.)
    - Pie chart: Token distribution (input vs output vs cache)
    - Timeline: Tool calls over time (sparkline)
    - Top files: Most frequently read/edited files
    - Cost breakdown: Cost per turn

    Uses Compose Canvas for simple charts (no chart library dependency).

    Accessible by tapping the metrics bar or a menu item.

dependencies:
  blocked_by: ["f11-001"]
  blocks: []

validation:
  - Charts render correctly with real data
  - Tool breakdown matches actual tool call counts
  - Sheet opens/closes smoothly
```

### Task 4: Cross-Session LLM Events View

```yaml
task_id: "f11-004"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/AllLLMEventsScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/llm/AllLLMEventsViewModel.kt
  description: |
    Top-level screen (accessible from main navigation) showing LLM events
    across ALL active sessions:

    - Unified event stream from all sessions
    - Each event tagged with session identifier (repo#issue)
    - Color-coded by session
    - Same filter/pause/metrics as single-session view
    - Aggregate metrics across all sessions

    Useful for:
    - Monitoring multiple Claude agents working in parallel
    - Seeing total API cost across all active sessions
    - Spotting errors across any session

dependencies:
  blocked_by: ["f11-002"]
  blocks: []

validation:
  - Events from multiple sessions interleave correctly
  - Session tags are visually distinct
  - Aggregate metrics sum across sessions
```

---

## Performance Notes

- Hook events can be high-volume (every tool call generates 2 events: pre + post)
- Virtual list (LazyColumn) is essential — may have 500+ events per session
- Store only summaries in memory, load full input/output on demand from Room
- Truncate tool output display to 1KB by default, load full on tap
- Consider batching UI updates: collect events for 100ms, then update list

---

## Acceptance Criteria

- [ ] Tool calls appear in real-time as Claude uses tools
- [ ] Tool-specific icons correctly identify each tool type
- [ ] Expanded tool calls show full input and output
- [ ] Token usage and cost metrics update in real-time
- [ ] Filter tabs work (All / Tools / Text / Errors)
- [ ] Auto-scroll with pause/resume works
- [ ] Tablet layout shows list + detail two-pane
- [ ] Tool analytics charts render correctly
- [ ] Cross-session view aggregates events from all sessions
- [ ] Performance is acceptable with 500+ events (no jank)
