package bar.bto.gwa.ui.users

import android.os.Parcelable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.NavigableListDetailPaneScaffold
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.parcelize.Parcelize

/**
 * Mock user data. @Parcelize enables saved-state support so the navigator
 * can persist the selected user across configuration changes.
 */
@Parcelize
data class User(
    val id: String,
    val name: String,
    val email: String,
    val role: String,
    val status: String,
) : Parcelable

private val mockUsers = listOf(
    User("1", "Alice Johnson", "alice@bto.bar", "Admin", "Active"),
    User("2", "Bob Smith", "bob@bto.bar", "Editor", "Active"),
    User("3", "Charlie Brown", "charlie@bto.bar", "Viewer", "Inactive"),
    User("4", "Diana Prince", "diana@bto.bar", "Admin", "Active"),
    User("5", "Ethan Hunt", "ethan@bto.bar", "Editor", "Active"),
    User("6", "Fiona Gallagher", "fiona@bto.bar", "Viewer", "Active"),
    User("7", "George Martin", "george@bto.bar", "Admin", "Active"),
    User("8", "Hannah Lee", "hannah@bto.bar", "Editor", "Inactive"),
)

/**
 * Users admin screen using NavigableListDetailPaneScaffold.
 *
 * The scaffold automatically adapts layout based on window size:
 *   - Phone (compact): Stacked single-pane with predictive back navigation
 *   - Tablet (expanded): Side-by-side list + detail panes
 *
 * Zero manual breakpoint math — the library handles everything.
 */
@Composable
fun UsersScreen(modifier: Modifier = Modifier) {
    val navigator = rememberListDetailPaneScaffoldNavigator<User>()
    val scope = rememberCoroutineScope()

    NavigableListDetailPaneScaffold(
        navigator = navigator,
        listPane = {
            AnimatedPane {
                UserListPane(
                    users = mockUsers,
                    onUserClick = { user ->
                        scope.launch {
                            navigator.navigateTo(
                                pane = ListDetailPaneScaffoldRole.Detail,
                                contentKey = user,
                            )
                        }
                    },
                )
            }
        },
        detailPane = {
            AnimatedPane {
                val selectedUser = navigator.currentDestination?.contentKey
                if (selectedUser != null) {
                    UserDetailPane(user = selectedUser)
                } else {
                    UserDetailPlaceholder()
                }
            }
        },
        modifier = modifier,
    )
}

@Composable
private fun UserListPane(
    users: List<User>,
    onUserClick: (User) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Text(
                text = "Users",
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.padding(bottom = 8.dp),
            )
        }
        items(users, key = { it.id }) { user ->
            UserListItem(user = user, onClick = { onUserClick(user) })
        }
    }
}

@Composable
private fun UserListItem(
    user: User,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier
                .padding(16.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = user.name,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = user.email,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            AssistChip(
                onClick = {},
                label = { Text(user.role) },
            )
        }
    }
}

@Composable
private fun UserDetailPane(
    user: User,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = user.name,
            style = MaterialTheme.typography.headlineLarge,
        )
        HorizontalDivider()
        DetailRow(label = "Email", value = user.email)
        DetailRow(label = "Role", value = user.role)
        DetailRow(label = "Status", value = user.status)
        DetailRow(label = "User ID", value = user.id)
    }
}

@Composable
private fun DetailRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

@Composable
private fun UserDetailPlaceholder(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Select a user to view details",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
