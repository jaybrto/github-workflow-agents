# Feature 08: Terminal Viewer

**Complexity:** High
**Dependencies:** F03 (Networking), F07 (Session Management)
**Blocks:** None

---

## Overview

The terminal viewer provides live terminal output streaming from GWA runner pods. It uses Termux's `terminal-view` and `terminal-emulator` libraries for native Canvas-based terminal rendering (no WebView), with OkHttp WebSocket connecting to the terminal relay server running on each pod.

This is read-only — the user observes Claude Code's terminal output in real time, like watching over its shoulder.

---

## Architecture

```
┌──────────────┐    WebSocket     ┌──────────────┐    pipe-pane    ┌──────────┐
│  Android App │ ◄──────────────► │ Terminal Relay│ ◄──────────────►│ tmux pane│
│  (OkHttp WS) │    /ws/{sessId}  │ (Bun :8080)  │    FIFO pipe   │ (Claude) │
└──────────────┘                  └──────────────┘                 └──────────┘
       │
       ▼
┌──────────────┐
│ Termux       │
│ terminal-view│  ← Native Canvas rendering
│ (200x50)     │     24-bit truecolor ANSI
└──────────────┘
```

**Data flow:**
1. GWA runner's tmux `pipe-pane` sends raw PTY output to a FIFO
2. Terminal relay reads FIFO and broadcasts via WebSocket + writes asciicast
3. Android app connects to WebSocket at `ws://<pod-ip>:8080/ws/{sessionId}`
4. Raw ANSI byte stream flows into Termux `terminal-emulator`
5. `terminal-view` renders to Android Canvas

---

## Tasks

### Task 1: WebSocket Terminal Client

```yaml
task_id: "f08-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/terminal/TerminalWebSocketClient.kt
  description: |
    OkHttp WebSocket client for terminal relay:

    ```kotlin
    class TerminalWebSocketClient(
        private val okHttpClient: OkHttpClient,
        private val connectivityManager: ConnectivityManager
    ) {
        // Connection state
        val connectionState: StateFlow<TerminalConnectionState>

        // Raw byte stream for terminal emulator
        val terminalOutput: SharedFlow<ByteArray>

        // Connect to a session's terminal stream
        suspend fun connect(sessionId: String, podIp: String)

        // Disconnect
        fun disconnect()
    }

    sealed class TerminalConnectionState {
        object Disconnected : TerminalConnectionState()
        object Connecting : TerminalConnectionState()
        data class Connected(val sessionId: String) : TerminalConnectionState()
        data class Error(val message: String) : TerminalConnectionState()
    }
    ```

    WebSocket URL resolution:
    - LAN/WARP: `ws://{podIp}:8080/ws/{sessionId}`
    - Public: Need a proxy route (may not be exposed publicly)
      Fallback: show "Terminal streaming requires LAN or WARP connection"

    On connect, the terminal relay sends current pane content as first message
    (mid-stream join support). Then continuous stream of raw ANSI data.

    Auto-reconnect on connection drop (3 attempts, then show error).

dependencies:
  blocked_by: ["f03-002"]
  blocks: ["f08-002"]

validation:
  - Connects to terminal relay WebSocket on LAN
  - Receives byte stream from relay
  - Auto-reconnects after brief network drop
  - Shows error for public network (no relay access)
```

### Task 2: Termux Terminal Integration

```yaml
task_id: "f08-002"
complexity: high
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/terminal/GWATerminalView.kt
    - android/app/src/main/kotlin/bar/bto/gwa/terminal/TerminalEmulatorBridge.kt
  description: |
    Integrate Termux terminal libraries:

    TerminalEmulatorBridge:
    - Creates a Termux TerminalEmulator instance (200 columns x 50 rows)
    - Feeds WebSocket byte stream into the emulator's InputStream
    - The emulator processes ANSI escape codes, maintains screen buffer
    - Truecolor (24-bit ANSI) support built into Termux

    GWATerminalView:
    - Compose wrapper around Termux's TerminalView (Android View)
    - Uses AndroidView composable to embed the native View
    - Configures:
      - Font: JetBrains Mono (from F02 design system)
      - Font size: Adjustable (pinch-to-zoom or settings)
      - Color scheme: Match GWA dark theme
      - Text selection: enabled (long-press to select, copy)
    - Read-only mode: disable keyboard input
    - Performance: TerminalView uses direct Canvas drawing, no WebView

    Termux library integration notes:
    - Libraries come from JitPack: com.github.termux.termux-app:terminal-view:v0.118.0
    - Also need: com.github.termux.termux-app:terminal-emulator:v0.118.0
    - GPLv3 licensed — fine for personal use, not for distribution
    - TerminalSession needs to be created with a custom process
      (we pipe WebSocket data instead of a real shell process)

dependencies:
  blocked_by: ["f08-001"]
  blocks: ["f08-003"]

validation:
  - Terminal renders with correct colors (24-bit truecolor)
  - ANSI escape codes processed correctly (cursor movement, clear, etc.)
  - Font is readable at default size
  - Text selection works for copying
  - No input is sent (read-only)
```

### Task 3: Terminal Screen

```yaml
task_id: "f08-003"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/terminal/TerminalScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/terminal/TerminalViewModel.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/terminal/TerminalUiState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/terminal/TerminalToolbar.kt
  description: |
    TerminalUiState:
    ```kotlin
    data class TerminalUiState(
        val sessionId: String,
        val connectionState: TerminalConnectionState = TerminalConnectionState.Disconnected,
        val fontSize: Float = 12f,
        val showToolbar: Boolean = true,
        val isFullScreen: Boolean = false,
        val error: String? = null
    )
    ```

    TerminalScreen:
    - Full-screen or embedded (in session detail tab)
    - GWATerminalView fills available space
    - Toolbar overlay at top (auto-hide after 3s, tap to show)
    - Landscape support: hides system bars, maximizes terminal

    TerminalToolbar:
    - Session info (repo, issue, state)
    - Font size controls (A- / A+)
    - Full-screen toggle
    - Connection indicator (green dot)
    - Disconnect/reconnect button
    - Share/copy button (captures current screen text)

    TerminalViewModel:
    - Manages TerminalWebSocketClient lifecycle
    - Connects on screen entry, disconnects on exit
    - Handles font size changes (persist to preferences)
    - Tracks connection state for UI

    Navigation:
    - Accessible from session detail "Terminal" tab
    - Also from dashboard quick action
    - Deep link support: gwa://terminal/{sessionId}

dependencies:
  blocked_by: ["f08-002", "f07-002"]
  blocks: []

validation:
  - Terminal stream connects and renders live output
  - Toolbar shows/hides correctly
  - Font size adjustments persist
  - Landscape mode maximizes terminal space
  - Navigation from session detail works
```

### Task 4: Recording Playback

```yaml
task_id: "f08-004"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/terminal/RecordingPlayer.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/terminal/RecordingPlayerScreen.kt
  description: |
    Playback of asciicast v2 recordings stored in MinIO:

    RecordingPlayer:
    - Fetches asciicast file via presigned S3 URL
    - Parses asciicast v2 format (header line + [time, type, data] events)
    - Feeds events to TerminalEmulatorBridge at recorded timing
    - Playback controls: play/pause, speed (0.5x, 1x, 2x, 4x), seek bar
    - Current position tracking

    RecordingPlayerScreen:
    - Same terminal view as live streaming
    - Additional playback controls at bottom:
      - Play/Pause button
      - Progress bar (seekable)
      - Speed selector
      - Current time / total duration
    - "Jump to end" button for completed recordings

    Asciicast v2 format:
    ```json
    {"version":2,"width":200,"height":50,"timestamp":1708905600}
    [0.5, "o", "$ bun test\r\n"]
    [1.2, "o", "PASS src/lib/amqp.test.ts\r\n"]
    ```

dependencies:
  blocked_by: ["f08-002", "f03-003"]
  blocks: []

validation:
  - Recording plays back with correct timing
  - Speed controls work (0.5x through 4x)
  - Seek bar allows jumping to any position
  - Terminal renders correctly during playback
```

---

## Performance Notes

- Termux `terminal-view` renders directly to Canvas — much faster than WebView
- 200x50 terminal at 12pt font fits well on Pixel 10 Pro XL (6.7" display)
- Byte stream from WebSocket is raw PTY data — minimal parsing overhead
- Recording playback parses events lazily (stream, not load-all-at-once)

---

## Acceptance Criteria

- [ ] Live terminal stream renders with correct colors and formatting
- [ ] Mid-stream join shows current terminal content immediately
- [ ] Connection indicator shows connected/disconnected state
- [ ] Font size is adjustable and persisted
- [ ] Landscape mode maximizes terminal space
- [ ] Text selection works for copying content
- [ ] Recording playback works with speed controls
- [ ] Read-only: no keyboard input sent to terminal
- [ ] Graceful degradation when terminal relay is unreachable
