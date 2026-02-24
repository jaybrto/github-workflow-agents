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
    - Kotlin 2.0.x
    - Compose BOM (2025.x latest stable)
    - Material 3
    - Compose Navigation
    - Ktor Client (CIO engine)
    - OkHttp (WebSocket)
    - Paho MQTT Android (hannesa2 fork v3.6.4)
    - Termux terminal-view + terminal-emulator (v0.118.0)
    - Koin (DI)
    - Room (local DB)
    - Kotlinx Serialization
    - Kotlinx Coroutines
    - WindowSizeClass (Compose Material 3)
    - Coil (image loading for SVG snapshots)
    - Timber (logging)

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

### Task 3: Navigation Shell

```yaml
task_id: "f01-003"
complexity: low
scope:
  files:
    - android/app/src/main/kotlin/bar/bto/gwa/navigation/GWANavGraph.kt
    - android/app/src/main/kotlin/bar/bto/gwa/navigation/GWANavHost.kt
    - android/app/src/main/kotlin/bar/bto/gwa/navigation/Screen.kt
  description: |
    Set up Compose Navigation with:
    - Sealed class/interface for Screen routes:
      - Screen.Dashboard
      - Screen.Sessions
      - Screen.SessionDetail(id)
      - Screen.Terminal(sessionId)
      - Screen.Infrastructure
      - Screen.LLMEvents
      - Screen.Settings

    - Adaptive navigation:
      - Phone: BottomNavigation (Dashboard, Sessions, Infra, Settings)
      - Tablet: NavigationRail (same items, left side)

    - Use WindowSizeClass to switch between layouts
    - NavHost with placeholder screens (just Text composables)

dependencies:
  blocked_by: ["f01-002"]
  blocks: []

validation:
  - Navigation between placeholder screens works on both phone and tablet layouts
  - WindowSizeClass correctly detects Pixel 10 Pro XL as Compact or Medium
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
