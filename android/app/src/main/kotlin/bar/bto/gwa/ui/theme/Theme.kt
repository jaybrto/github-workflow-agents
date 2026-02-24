package bar.bto.gwa.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val GwaDarkColorScheme = darkColorScheme(
    primary = GwaDarkPrimary,
    secondary = GwaDarkSecondary,
    background = GwaDarkBackground,
    surface = GwaDarkSurface,
    surfaceVariant = GwaDarkSurfaceVariant,
    error = GwaDarkError,
    onPrimary = GwaDarkOnPrimary,
    onSecondary = GwaDarkOnSecondary,
    onBackground = GwaDarkOnBackground,
    onSurface = GwaDarkOnSurface,
    onError = GwaDarkOnError,
    outline = GwaDarkOutline,
)

@Composable
fun GWATheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = GwaDarkColorScheme,
        typography = GwaTypography,
        content = content,
    )
}
