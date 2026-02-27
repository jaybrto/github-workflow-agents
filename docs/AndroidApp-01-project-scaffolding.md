# Feature 01: Project Scaffolding & Build System

**Complexity:** Medium
**Dependencies:** None (foundation feature)
**Blocks:** All other features

---

## Overview

Set up the Android project structure, Gradle build system, dependency management, and CI configuration. This creates the foundation that all other features build on.

---

## Scope

### Files to Create

```
android/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── kotlin/bar/bto/gwa/
│   │   │   │   ├── GWAApp.kt                    # Application class (Koin init)
│   │   │   │   ├── MainActivity.kt               # Single-activity host
│   │   │   │   └── navigation/
│   │   │   │       └── GWANavGraph.kt             # Compose Navigation graph
│   │   │   ├── res/
│   │   │   │   ├── values/
│   │   │   │   │   ├── strings.xml
│   │   │   │   │   └── themes.xml
│   │   │   │   ├── drawable/
│   │   │   │   │   └── ic_launcher_foreground.xml
│   │   │   │   └── mipmap-anydpi-v26/
│   │   │   │       └── ic_launcher.xml
│   │   │   └── AndroidManifest.xml
│   │   └── test/
│   │       └── kotlin/bar/bto/gwa/
│   │           └── ExampleUnitTest.kt
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── build.gradle.kts                               # Root build file
├── settings.gradle.kts                            # Module + plugin management
├── gradle.properties                              # JVM args, Compose flags
├── gradle/
│   └── libs.versions.toml                         # Version catalog
├── .gitignore
└── local.properties.example                       # Template (not committed)
```

---

## Tasks

### Task 1: Root Gradle Setup

```yaml
task_id: "f01-001"
complexity: low
scope:
  files:
    - android/build.gradle.kts
    - android/settings.gradle.kts
    - android/gradle.properties
    - android/gradle/libs.versions.toml
  description: |
    Create the root Gradle build files with Version Catalog for all dependencies.

    Version catalog must include:
    - Kotlin 2.1.10
    - AGP 8.8.2
    - Compose BOM (2025.x latest stable)
    - Material 3 (1.4.0)
    - Material 3 Adaptive Navigation Suite (1.4.0) — NavigationSuiteScaffold
    - Material 3 Adaptive Layout (1.2.0) — AnimatedPane, ListDetailPaneScaffoldRole
    - Material 3 Adaptive Navigation (1.2.0) — NavigableListDetailPaneScaffold
    - Compose Navigation
    - Activity Compose (edge-to-edge, enableEdgeToEdge)
    - Ktor Client (CIO engine)
    - OkHttp (WebSocket)
    - Paho MQTT Android (hannesa2 fork v3.6.4)
    - Termux terminal-view + terminal-emulator (v0.118.0)
    - Koin (DI)
    - Room (local DB)
    - Kotlinx Serialization
    - Kotlinx Coroutines
    - Coil (image loading for SVG snapshots)
    - Timber (logging)

    NOTE: WindowSizeClass is superseded by the Material 3 Adaptive libraries.
    NavigationSuiteScaffold automatically reads window size to choose
    BottomNavigationBar vs NavigationRail vs NavigationDrawer.
    NavigableListDetailPaneScaffold automatically manages single-pane
    vs split-pane based on window size — zero manual breakpoint math.

    gradle.properties:
    - org.gradle.jvmargs=-Xmx4g (for M3 builds)
    - android.useAndroidX=true
    - kotlin.code.style=official
    - android.nonTransitiveRClass=true

dependencies:
  blocked_by: []
  blocks: ["f01-002"]

validation:
  - `./gradlew tasks` completes without errors
```

### Task 2: App Module Setup

```yaml
task_id: "f01-002"
complexity: low
scope:
  files:
    - android/app/build.gradle.kts
    - android/app/src/main/AndroidManifest.xml
    - android/app/src/main/kotlin/bar/bto/gwa/GWAApp.kt
    - android/app/src/main/kotlin/bar/bto/gwa/MainActivity.kt
    - android/app/proguard-rules.pro
  description: |
    Configure the app module with:
    - applicationId: bar.bto.gwa
    - minSdk: 28
    - targetSdk: 35
    - compileSdk: 35
    - Compose enabled with BOM
    - Kotlin serialization plugin
    - Room KSP annotation processor

    AndroidManifest.xml permissions:
    - INTERNET
    - ACCESS_NETWORK_STATE
    - ACCESS_WIFI_STATE
    - FOREGROUND_SERVICE
    - FOREGROUND_SERVICE_DATA_SYNC
    - POST_NOTIFICATIONS
    - WAKE_LOCK
    - REQUEST_IGNORE_BATTERY_OPTIMIZATIONS

    GWAApp.kt:
    - Extend Application
    - Initialize Koin with empty module list (filled by later features)
    - Initialize Timber in debug mode

    MainActivity.kt:
    - Single-activity Compose host
    - setContent with GWATheme wrapper
    - Placeholder "Hello GWA" text

dependencies:
  blocked_by: ["f01-001"]
  blocks: ["f01-003"]

validation:
  - App builds and installs on Pixel 10 Pro XL emulator
  - Shows "Hello GWA" text
```

### Task 3: Navigation Shell (Material 3 Adaptive)

```yaml
task_id: "f01-003"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/ui/navigation/MainScaffold.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/dashboard/DashboardScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/users/UsersScreen.kt
    - android/app/src/main/kotlin/bar/bto/gwa/ui/settings/SettingsScreen.kt
  description: |
    Use Compose Material 3 Adaptive library for ALL responsive layout logic.
    Zero manual WindowSizeClass branching or breakpoint math.

    MainScaffold.kt — Root navigation using NavigationSuiteScaffold:
    - NavigationSuiteScaffold automatically renders:
      - Phone (Compact): BottomNavigationBar
      - Small tablet (Medium): NavigationRail
      - Large tablet (Expanded): Persistent NavigationDrawer
    - Admin destinations enum: Dashboard, Users, Settings
    - Each destination item provides icon + label
    - Content switches based on selected destination

    UsersScreen.kt — List-detail using NavigableListDetailPaneScaffold:
    - rememberListDetailPaneScaffoldNavigator<User>() for navigation state
    - NavigableListDetailPaneScaffold automatically renders:
      - Phone: Single pane, stacked navigation with predictive back
      - Tablet: Side-by-side list (1/3) + detail (2/3)
    - AnimatedPane wraps both list and detail panes
    - User data class with @Parcelize for saved state support
    - Mock user list with UserListPane and UserDetailPane

    DashboardScreen.kt / SettingsScreen.kt — Stub placeholder screens

    NOTE: This replaces the previous approach of manual WindowSizeClass
    checks with BottomNavigation/NavigationRail switching. The Material 3
    Adaptive library handles all of this automatically.

dependencies:
  blocked_by: ["f01-002"]
  blocks: []

validation:
  - NavigationSuiteScaffold shows BottomNav on Pixel 10 Pro XL, Rail on tablet
  - NavigableListDetailPaneScaffold shows split-pane on tablet, stacked on phone
  - Predictive back gesture works on phone for list-detail navigation
  - No manual breakpoint math anywhere in the code
```

### Task 4: Git & CI Setup

```yaml
task_id: "f01-004"
complexity: low
scope:
  files:
    - android/.gitignore
    - android/local.properties.example
  description: |
    .gitignore for Android project:
    - *.iml, .idea/, .gradle/, build/
    - local.properties (secrets)
    - *.apk, *.aab
    - .DS_Store

    local.properties.example:
    - GWA_API_URL=http://10.43.x.x:3001
    - GWA_API_KEY=your-api-key
    - GWA_MQTT_HOST=10.43.x.x
    - GWA_MQTT_PORT=1883
    - GWA_MQTT_WSS_URL=wss://mqtt.bto.bar/ws
    - GWA_NTFY_URL=https://ntfy.bto.bar/gwa
    - GWA_MINIO_ENDPOINT=minio.bto.bar:9000

dependencies:
  blocked_by: []
  blocks: []

validation:
  - local.properties is git-ignored
  - Example file documents all required config
```

---

## Acceptance Criteria

- [ ] `./gradlew assembleDebug` completes successfully
- [ ] App installs and shows navigation shell on Pixel 10 Pro XL
- [ ] Adaptive layout switches between phone/tablet navigation
- [ ] All dependencies resolve from Maven Central / JitPack
- [ ] Version catalog used consistently (no hardcoded versions in build files)
