package dev.prismo.app

import android.content.Context

// A client-owned credential survives a lost pairing acknowledgment or app restart.
internal object PairingAttempt {
    private const val PREFS = "prismo-pending-pairing"
    private const val PC = "pc"
    private const val TOKEN = "token"

    fun save(context: Context, pcID: String, token: String) {
        val protected = IrohIdentity.protectToken(token)
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PC, pcID).putString(TOKEN, protected).commit()) {
            "Unable to retain pairing credential"
        }
    }

    fun read(context: Context): Pair<String, String>? {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val pcID = preferences.getString(PC, null) ?: return null
        val token = IrohIdentity.revealToken(preferences.getString(TOKEN, null) ?: "")
        return if (Regex("[0-9a-f]{64}").matches(pcID) &&
            Regex("[A-Za-z0-9_-]{43}").matches(token)) pcID to token else null
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().clear().apply()
    }
}
