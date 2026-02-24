# Feature 02: Design System & Theme

**Complexity:** Medium
**Dependencies:** F01 (Project Scaffolding)
**Blocks:** F06 (Dashboard), F07 (Sessions), F09 (Infra), F11 (LLM Events)

---

## Overview

Create a cohesive Material 3 design system with a dark-first admin portal aesthetic. The theme should feel like a terminal/ops dashboard — think Grafana meets Material You. This is a single-user admin tool, so prioritize information density and readability over consumer-app aesthetics.

---

## Design Philosophy

- **Dark-first:** Default dark theme, optional light theme
- **Information-dense:** Maximize data visibility, minimize decorative whitespace
- **Monospace where it matters:** Code, logs, terminal content use monospace
- **Color-coded states:** Session states have distinct, consistent colors
- **Responsive:** Layouts adapt to phone vs tablet without losing functionality

---

## Tasks

### Task 1: Color Scheme & Theme

```yaml
task_id: "f02-001"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/theme/Color.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/theme/Theme.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/theme/Type.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/theme/Shape.kt
  description: |
    Color palette (dark theme primary):
    - Background: Near-black (#0D1117, like GitHub dark)
    - Surface: Dark gray (#161B22)
    - Surface variant: Slightly lighter (#21262D)
    - Primary: Teal/Cyan (#58A6FF — readable on dark)
    - Secondary: Purple (#BC8CFF)
    - Error: Red (#F85149)
    - On-surface: Light gray (#C9D1D9)

    Session state colors (critical for dashboard):
    - Idle: Gray (#8B949E)
    - Planning: Blue (#58A6FF)
    - In Progress: Green (#3FB950)
    - QA: Orange (#D29922)
    - Blocked: Red (#F85149) — animated pulse
    - Review: Purple (#BC8CFF)
    - Done: Muted green (#238636)

    Typography:
    - Display/Headlines: Inter or system default
    - Body: System default
    - Code/Terminal: JetBrains Mono (bundled) or Fira Code
    - Monospace: Used for session IDs, routing keys, JSON

    Shapes:
    - Cards: 8dp rounded corners
    - Chips: 16dp rounded (pill shape)
    - Terminal: 0dp (sharp corners for terminal feel)

dependencies:
  blocked_by: ["f01-002"]
  blocks: ["f02-002"]

validation:
  - Dark theme renders correctly on OLED (Pixel 10 Pro XL)
  - All 7 session state colors are visually distinct
  - Monospace font renders properly for code content
```

### Task 2: Core UI Components

```yaml
task_id: "f02-002"
complexity: medium
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/SessionStateChip.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/SessionCard.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/PodHealthIndicator.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/ConnectionStatusBar.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/EventTimeline.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/MetricCard.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/CodeBlock.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/LoadingState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/ErrorState.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/components/EmptyState.kt
  description: |
    Reusable Compose components:

    SessionStateChip:
    - Colored chip showing session state (idle/planning/etc)
    - Animated pulse for "blocked" state
    - Icon + text label

    SessionCard:
    - Shows: repo name, issue #, state chip, pod name, last activity time
    - Tap to navigate to detail
    - Swipe actions (future)

    PodHealthIndicator:
    - Green/red dot with pod name
    - Tooltip showing last heartbeat time

    ConnectionStatusBar:
    - Thin bar at top showing: LAN / WARP / WSS / Disconnected
    - Color-coded (green/yellow/orange/red)
    - Tap to see connection details

    EventTimeline:
    - Vertical timeline of events
    - Each entry: timestamp, event type icon, description
    - Supports different event types (state change, tool call, error)

    MetricCard:
    - Label, large number, trend indicator (optional)
    - Used on dashboard for counts/stats

    CodeBlock:
    - Monospace text with syntax highlighting
    - Copy button
    - Horizontal scroll for long lines

    LoadingState / ErrorState / EmptyState:
    - Standard placeholder screens
    - Consistent across all features

dependencies:
  blocked_by: ["f02-001"]
  blocks: []

validation:
  - Components render correctly in Compose Preview
  - SessionStateChip shows all 7 states with correct colors
  - ConnectionStatusBar displays all 4 connection states
  - Components adapt to WindowSizeClass (larger on tablet)
```

### Task 3: Responsive Scaffolds (Material 3 Adaptive — No Custom Code)

```yaml
task_id: "f02-003"
complexity: low  # Reduced — library handles all the heavy lifting
scope:
  files: []  # No custom scaffold files needed!
  description: |
    REPLACED BY Material 3 Adaptive Library components.
    No custom AdaptiveScaffold, MasterDetailLayout, or WindowSizeUtils needed.

    The following library components replace all custom responsive code:

    NavigationSuiteScaffold (material3-adaptive-navigation-suite:1.4.0):
    - Replaces custom AdaptiveScaffold
    - Automatically renders BottomNavigationBar / NavigationRail / NavigationDrawer
    - Reads currentWindowAdaptiveInfo() internally — zero manual breakpoint math
    - See: ui/navigation/MainScaffold.kt

    NavigableListDetailPaneScaffold (adaptive-navigation:1.2.0):
    - Replaces custom MasterDetailLayout
    - Phone: Single pane with predictive back gesture support
    - Tablet: Persistent split-pane (list left, detail right)
    - Built-in AnimatedPane transitions between panes
    - Built-in back stack management with ThreePaneScaffoldNavigator
    - See: ui/users/UsersScreen.kt (and future session screens)

    LazyVerticalGrid with GridCells.Adaptive:
    - Used for dashboard metric cards
    - Maximizes 2.5K display real estate on tablet
    - Gracefully stacks on phone
    - No custom code needed — standard Compose Foundation

    WindowSizeUtils:
    - NOT NEEDED. Material 3 Adaptive components read window size internally.
    - If edge cases arise, use currentWindowAdaptiveInfo() directly.

dependencies:
  blocked_by: ["f02-001"]
  blocks: []

validation:
  - NavigationSuiteScaffold shows BottomNav on phone, Rail on tablet
  - NavigableListDetailPaneScaffold splits correctly on tablet
  - Smooth animated transitions between panes
  - Zero manual WindowSizeClass branching in codebase
```

---

## Acceptance Criteria

- [ ] Dark theme is the default and looks good on OLED screens
- [ ] All session states have visually distinct colors
- [ ] Monospace font renders for code/terminal content
- [ ] Components are preview-able in Compose Preview
- [ ] Layouts adapt between phone and tablet form factors
- [ ] ConnectionStatusBar correctly shows connectivity state
