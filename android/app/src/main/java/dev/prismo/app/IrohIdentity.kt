package dev.prismo.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import computer.iroh.SecretKey as IrohSecretKey
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object IrohIdentity {
    private const val ALIAS = "prismo-endpoint"
    private const val PREFS = "prismo-identity"
    private const val SECRET = "secret"
    private const val TOKEN_PREFIX = "v1:"

    @Synchronized
    fun load(context: Context): ByteArray {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = masterKey()
        val saved = preferences.getString(SECRET, null)
        if (saved != null) {
            val encrypted = Base64.decode(saved, Base64.NO_WRAP)
            require(encrypted.size > 12) { "Invalid device identity" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key,
                GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
            val secret = cipher.doFinal(encrypted.copyOfRange(12, encrypted.size))
            require(secret.size == 32) { "Invalid device identity" }
            return secret
        }
        val secret = IrohSecretKey.generate().toBytes()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val encrypted = cipher.iv + cipher.doFinal(secret)
        require(preferences.edit().putString(SECRET,
            Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
        return secret
    }

    fun protectToken(token: String): String {
        if (token.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, masterKey())
        val encrypted = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        return TOKEN_PREFIX + Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    fun revealToken(stored: String): String {
        if (!stored.startsWith(TOKEN_PREFIX)) return ""
        return try {
            val encrypted = Base64.decode(stored.removePrefix(TOKEN_PREFIX), Base64.NO_WRAP)
            require(encrypted.size > 12)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, masterKey(),
                GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
            String(cipher.doFinal(encrypted.copyOfRange(12, encrypted.size)), Charsets.UTF_8)
        } catch (_: Exception) {
            ""
        }
    }

    private fun masterKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }
}
