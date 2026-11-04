package dev.prismo.app

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map

val Context.prismoStore by preferencesDataStore(name = "prismo")

private object Keys {
    val url = stringPreferencesKey("pc_url")
    val deviceToken = stringPreferencesKey("device_token")
    val font = intPreferencesKey("font_size")
    val markdownFont = intPreferencesKey("markdown_font_size")
    val height = floatPreferencesKey("line_height")
    val padding = intPreferencesKey("code_padding")
    val wrap = booleanPreferencesKey("wrap_lines")
    val numbers = booleanPreferencesKey("line_numbers")
    val split = booleanPreferencesKey("split_diff")
    val fullDiff = booleanPreferencesKey("full_diff")
    val dark = booleanPreferencesKey("dark_mode")
}

data class ViewerPreferences(
    val pcURL: String = "",
    val deviceToken: String = "",
    val fontSize: Int = 12,
    val markdownFontSize: Int = 18,
    val lineHeight: Float = 1.3f,
    val padding: Int = 4,
    val wrap: Boolean = false,
    val numbers: Boolean = true,
    val split: Boolean = false,
    val fullDiff: Boolean = false,
    val dark: Boolean = true
)

private fun readPreferences(values: Preferences) = ViewerPreferences(
    pcURL = values[Keys.url] ?: "",
    deviceToken = values[Keys.deviceToken] ?: "",
    fontSize = values[Keys.font] ?: 12,
    markdownFontSize = values[Keys.markdownFont] ?: 18,
    lineHeight = values[Keys.height] ?: 1.3f,
    padding = values[Keys.padding] ?: 4,
    wrap = values[Keys.wrap] ?: false,
    numbers = values[Keys.numbers] ?: true,
    split = values[Keys.split] ?: false,
    fullDiff = values[Keys.fullDiff] ?: false,
    dark = values[Keys.dark] ?: true
)

val Context.viewerPreferences get() = prismoStore.data.map(::readPreferences)

/** Apply changes to the latest stored values in one DataStore transaction. */
suspend fun Context.updateViewerPreferences(change: (ViewerPreferences) -> ViewerPreferences) {
    prismoStore.edit { values: MutablePreferences ->
        val updated = change(readPreferences(values))
        values[Keys.url] = updated.pcURL
        values[Keys.deviceToken] = updated.deviceToken
        values[Keys.font] = updated.fontSize
        values[Keys.markdownFont] = updated.markdownFontSize
        values[Keys.height] = updated.lineHeight
        values[Keys.padding] = updated.padding
        values[Keys.wrap] = updated.wrap
        values[Keys.numbers] = updated.numbers
        values[Keys.split] = updated.split
        values[Keys.fullDiff] = updated.fullDiff
        values[Keys.dark] = updated.dark
    }
}
