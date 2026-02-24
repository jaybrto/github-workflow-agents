package bar.bto.gwa

import android.app.Application
import timber.log.Timber

class GWAApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            Timber.plant(Timber.DebugTree())
        }
    }
}
