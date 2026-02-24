plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kotlin.parcelize)
    alias(libs.plugins.ksp)
}

android {
    namespace = "bar.bto.gwa"
    compileSdk = 35

    defaultConfig {
        applicationId = "bar.bto.gwa"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // Compose BOM
    val composeBom = platform(libs.compose.bom)
    implementation(composeBom)

    // Compose UI
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.foundation)
    debugImplementation(libs.compose.ui.tooling)

    // Material 3
    implementation(libs.material3)
    implementation(libs.material.icons.extended)

    // Material 3 Adaptive — responsive layouts with zero manual breakpoint math
    implementation(libs.material3.adaptive.navigation.suite)  // NavigationSuiteScaffold
    implementation(libs.adaptive)                              // Core adaptive utilities
    implementation(libs.adaptive.layout)                       // AnimatedPane, ListDetailPaneScaffoldRole
    implementation(libs.adaptive.navigation)                   // NavigableListDetailPaneScaffold

    // AndroidX Core
    implementation(libs.activity.compose)
    implementation(libs.core.ktx)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)

    // Navigation
    implementation(libs.navigation.compose)

    // Koin DI
    implementation(libs.koin.android)
    implementation(libs.koin.compose)

    // Networking (Ktor + OkHttp WebSocket)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.serialization.json)
    implementation(libs.okhttp)

    // Local DB
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    // Serialization
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    // Image loading
    implementation(libs.coil.compose)
    implementation(libs.coil.svg)

    // Logging
    implementation(libs.timber)
}
