# GWA Dashboard ProGuard Rules
# Keep Kotlin serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class bar.bto.gwa.**$$serializer { *; }
-keepclassmembers class bar.bto.gwa.** {
    *** Companion;
}
-keepclasseswithmembers class bar.bto.gwa.** {
    kotlinx.serialization.KSerializer serializer(...);
}
