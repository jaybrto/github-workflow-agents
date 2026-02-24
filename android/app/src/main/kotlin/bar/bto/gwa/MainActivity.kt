package bar.bto.gwa

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import bar.bto.gwa.ui.navigation.MainScaffold
import bar.bto.gwa.ui.theme.GWATheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            GWATheme {
                MainScaffold()
            }
        }
    }
}
