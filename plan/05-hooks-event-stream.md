# Feature 05: Claude Code Hooks Event Stream

**Complexity:** High
**Dependencies:** F04 (MQTT), Infrastructure (GWA backend changes)
**Blocks:** F11 (LLM Event Viewer)

---

## Overview

Claude Code CLI has a hooks system that fires shell commands on specific lifecycle events (tool calls, assistant responses, conversation turns, etc.). This feature defines the infrastructure changes needed to capture these hook events from the GWA runner pods and publish them via AMQP/MQTT so the Android app can consume them in real time.

This is a **two-part feature**:
1. **Backend (GWA Runner):** Configure Claude Code hooks to publish events to AMQP
2. **Android (Client):** Parse and store hook events from MQTT

---

## Claude Code Hooks Architecture

Claude Code supports hooks configured in `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hook": "/path/to/hook-script.sh pre-tool"
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hook": "/path/to/hook-script.sh post-tool"
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hook": "/path/to/hook-script.sh notification"
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hook": "/path/to/hook-script.sh stop"
      }
    ]
  }
}
```

### Hook Event Types from Claude Code

| Hook | Trigger | Data Available (via stdin JSON) |
|------|---------|-------------------------------|
| `PreToolUse` | Before a tool executes | `{ tool_name, tool_input }` |
| `PostToolUse` | After a tool executes | `{ tool_name, tool_input, tool_output }` |
| `Notification` | Claude wants to notify user | `{ message }` |
| `Stop` | Session/turn ends | `{ stop_reason, session_cost, token_usage }` |

### What Each Hook Provides

**PreToolUse / PostToolUse** (most valuable for the dashboard):
- `tool_name`: "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", etc.
- `tool_input`: The arguments passed to the tool (file paths, commands, search queries)
- `tool_output` (PostToolUse only): The result of the tool execution

**Notification:**
- `message`: Text notification from Claude (usually questions or status updates)

**Stop:**
- `stop_reason`: "end_turn", "stop_sequence", "max_tokens", "tool_use"
- Session cost and token usage data (when available)

---

## Part 1: Backend Infrastructure Changes

### Task 1: Hook Event Publisher Script

```yaml
task_id: "f05-001"
complexity: medium
scope:
  files:
    - scripts/claude-hook-publisher.sh
  description: |
    Shell script that Claude Code hooks invoke. Reads JSON from stdin,
    enriches with session context, and publishes to AMQP.

    The script:
    1. Reads hook event JSON from stdin
    2. Extracts session ID from environment (GWA_SESSION_ID)
    3. Extracts repo context from environment (GWA_REPO_OWNER, GWA_REPO_NAME)
    4. Wraps in AmqpMessage envelope
    5. Publishes to RabbitMQ via `rabbitmqadmin` or a lightweight AMQP publisher

    Since we want low overhead, use a pre-compiled Bun binary:
    - `dist/gwa-hook-publisher` — reads stdin, publishes to AMQP, exits

    Routing key format:
    `gwa.hooks.{owner}.{repo}.{sessionId}.{hookType}`

    Example:
    `gwa.hooks.jaybrto.github-workflow-agents.sess-123.post_tool_use`

    Environment variables available in runner pod:
    - GWA_SESSION_ID
    - GWA_REPO_OWNER
    - GWA_REPO_NAME
    - RABBITMQ_URL

dependencies:
  blocked_by: []
  blocks: ["f05-002"]

validation:
  - Script publishes valid AMQP messages
  - Execution time < 100ms (must not slow down Claude Code)
  - Handles missing env vars gracefully
```

### Task 2: Hook Publisher Binary (Bun)

```yaml
task_id: "f05-002"
complexity: medium
scope:
  files:
    - src/hook-publisher.ts
  description: |
    Lightweight Bun TypeScript binary that reads hook event JSON from stdin
    and publishes to AMQP.

    ```typescript
    // src/hook-publisher.ts
    // Reads JSON from stdin, publishes to gwa.hooks exchange

    interface HookEvent {
      hookType: string;       // PreToolUse, PostToolUse, Notification, Stop
      toolName?: string;      // For tool hooks
      toolInput?: unknown;    // Tool arguments
      toolOutput?: unknown;   // Tool result (PostToolUse only)
      message?: string;       // Notification message
      stopReason?: string;    // Stop reason
      sessionCost?: unknown;  // Cost data
      tokenUsage?: unknown;   // Token usage
    }
    ```

    Published message format:
    ```json
    {
      "routingKey": "gwa.hooks.jaybrto.repo.sess-123.post_tool_use",
      "payload": {
        "hookType": "PostToolUse",
        "toolName": "Bash",
        "toolInput": { "command": "bun test" },
        "toolOutput": "... truncated ...",
        "sessionId": "sess-123",
        "timestamp": 1708905600000
      },
      "timestamp": 1708905600000,
      "sessionId": "sess-123"
    }
    ```

    Important: Truncate tool_output to 10KB max to avoid flooding AMQP.

dependencies:
  blocked_by: ["f05-001"]
  blocks: ["f05-003"]

validation:
  - Builds to single binary via `bun build --compile`
  - Publishes valid AMQP messages
  - Truncates large outputs
  - < 100ms execution time
```

### Task 3: AMQP Exchange Setup

```yaml
task_id: "f05-003"
complexity: low
scope:
  files:
    - src/lib/amqp.ts                    # MODIFY — add gwa.hooks exchange
    - src/orchestrator/index.ts          # MODIFY — subscribe to hooks
    - src/orchestrator/session-aggregator.ts  # MODIFY — handle hook events
  description: |
    Add a new AMQP exchange for hook events:

    In amqp.ts:
    - Add EXCHANGE_HOOKS = "gwa.hooks"
    - Assert exchange in ensureExchanges()
    - Add publishHookEvent() helper

    In orchestrator/index.ts:
    - Subscribe to "gwa.hooks.#" for aggregation

    In session-aggregator.ts:
    - Handle hook events: store in activity_feed with routing_key prefix "gwa.hooks."
    - Count tool calls per session for dashboard metrics

    RabbitMQ MQTT plugin will automatically bridge gwa.hooks.* to MQTT topic gwa/hooks/*

dependencies:
  blocked_by: ["f05-002"]
  blocks: []

validation:
  - gwa.hooks exchange exists in RabbitMQ
  - Hook events appear in session activity feed
  - MQTT subscribers on gwa/hooks/# receive events
```

---

## Part 2: Android Client Changes

### Task 4: Hook Event Models

```yaml
task_id: "f05-004"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/HookEvent.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/ToolCall.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/model/TokenUsage.kt
  description: |
    Kotlin data classes for hook events:

    ```kotlin
    @Serializable
    data class HookEvent(
        val hookType: HookType,
        val toolName: String? = null,
        val toolInput: JsonObject? = null,
        val toolOutput: String? = null,   // Truncated to 10KB
        val message: String? = null,
        val stopReason: String? = null,
        val sessionCost: SessionCost? = null,
        val tokenUsage: TokenUsage? = null,
        val sessionId: String,
        val timestamp: Long
    )

    enum class HookType {
        PreToolUse,
        PostToolUse,
        Notification,
        Stop
    }

    @Serializable
    data class ToolCall(
        val toolName: String,
        val input: JsonObject,
        val output: String?,
        val startedAt: Long,
        val completedAt: Long?,
        val durationMs: Long?,
        val success: Boolean
    )

    @Serializable
    data class TokenUsage(
        val inputTokens: Long,
        val outputTokens: Long,
        val cacheReadTokens: Long? = null,
        val cacheWriteTokens: Long? = null,
        val totalCost: Double? = null
    )

    @Serializable
    data class SessionCost(
        val totalInputTokens: Long,
        val totalOutputTokens: Long,
        val estimatedCostUsd: Double? = null
    )
    ```

dependencies:
  blocked_by: ["f03-001"]
  blocks: ["f05-005"]

validation:
  - Models deserialize from published hook event JSON
  - HookType enum covers all Claude Code hook types
```

### Task 5: Hook Event Repository

```yaml
task_id: "f05-005"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/data/repository/HookEventRepository.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/dao/HookEventDao.kt
    - android/app/src/main/kotlin/bar/bto/gwa/data/local/entity/HookEventEntity.kt
  description: |
    Store and query hook events locally:

    HookEventEntity (Room):
    - id: Long (auto-increment)
    - sessionId: String
    - hookType: String
    - toolName: String?
    - inputSummary: String (first 500 chars of tool input)
    - outputSummary: String? (first 500 chars of tool output)
    - message: String?
    - timestamp: Long
    - rawJson: String (full event for detail view)

    HookEventDao:
    - Insert event
    - Query by session: Flow<List<HookEventEntity>>
    - Query tool calls by session: Flow<List<HookEventEntity>> (where hookType = PostToolUse)
    - Count tool calls by session
    - Aggregate: tool call counts by tool name
    - Retention: delete events older than 7 days

    HookEventRepository:
    - Listens to MqttEventDispatcher.hookEvents()
    - Persists to Room
    - Exposes Flow<List<HookEvent>> per session
    - Exposes aggregate stats (tool call counts, token usage)

dependencies:
  blocked_by: ["f05-004", "f04-002"]
  blocks: []

validation:
  - Hook events persist to Room as they arrive via MQTT
  - Queries return correct results grouped by session
  - Retention cleanup works
```

---

## Infrastructure Dependency

This feature requires changes to the GWA backend (Tasks 1-3) that must be deployed before the Android client can receive hook events. The backend changes should be implemented as a separate PR to the GWA repository.

**Deployment order:**
1. Build and deploy `gwa-hook-publisher` binary to runner pods
2. Update Claude Code `.claude/settings.json` in runner pods to invoke hooks
3. Deploy orchestrator update with gwa.hooks exchange
4. Android app can then subscribe to `gwa/hooks/#` via MQTT

---

## Acceptance Criteria

- [ ] Claude Code tool calls appear in Android app within 2 seconds
- [ ] Tool call details show tool name, input summary, and output summary
- [ ] Token usage / cost data flows through when available
- [ ] Hook events persist locally for 7-day history
- [ ] Large tool outputs are truncated (no OOM from huge grep results)
- [ ] Backend hook publisher executes in < 100ms (doesn't slow Claude Code)
