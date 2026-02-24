package bar.bto.gwa.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import bar.bto.gwa.ui.dashboard.DashboardScreen
import bar.bto.gwa.ui.settings.SettingsScreen
import bar.bto.gwa.ui.users.UsersScreen

/**
 * Top-level admin destinations for the GWA Dashboard.
 *
 * NavigationSuiteScaffold reads the current window adaptive info and
 * automatically renders the appropriate navigation chrome:
 *   - Compact (phone):   BottomNavigationBar
 *   - Medium  (tablet):  NavigationRail
 *   - Expanded (large):  Persistent NavigationDrawer
 */
enum class AdminDestination(
    val label: String,
    val icon: ImageVector,
) {
    Dashboard("Dashboard", Icons.Default.Dashboard),
    Users("Users", Icons.Default.People),
    Settings("Settings", Icons.Default.Settings),
}

@Composable
fun MainScaffold(modifier: Modifier = Modifier) {
    var currentDestination by rememberSaveable { mutableStateOf(AdminDestination.Dashboard) }

    NavigationSuiteScaffold(
        navigationSuiteItems = {
            AdminDestination.entries.forEach { destination ->
                item(
                    icon = {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = destination.label,
                        )
                    },
                    label = { Text(destination.label) },
                    selected = currentDestination == destination,
                    onClick = { currentDestination = destination },
                )
            }
        },
        modifier = modifier,
    ) {
        when (currentDestination) {
            AdminDestination.Dashboard -> DashboardScreen()
            AdminDestination.Users -> UsersScreen()
            AdminDestination.Settings -> SettingsScreen()
        }
    }
}
