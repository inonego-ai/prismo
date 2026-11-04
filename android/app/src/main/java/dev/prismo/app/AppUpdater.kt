package dev.prismo.app

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

object AppUpdater {
    private const val MAX_APK_BYTES = 150L * 1024 * 1024
    private const val APK_MIME = "application/vnd.android.package-archive"

    @Suppress("DEPRECATION")
    fun installedVersionCode(context: Context): Long =
        context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode

    fun canInstall(context: Context): Boolean =
        context.packageManager.canRequestPackageInstalls()

    fun requestInstallPermission(context: Context) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + context.packageName))
        context.startActivity(intent)
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(context: Context, archive: File, info: AppUpdate) {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val candidate = requireNotNull(context.packageManager.getPackageArchiveInfo(archive.path, flags)) {
            "APK를 열 수 없습니다."
        }
        require(candidate.packageName == context.packageName &&
            candidate.packageName == info.packageName) { "앱이 일치하지 않습니다." }
        val code = candidate.longVersionCode
        require(code == info.versionCode && code > installedVersionCode(context)) {
            "새로운 버전이 아닙니다."
        }

        val installed = context.packageManager.getPackageInfo(context.packageName, flags)
        val currentSignatures = requireNotNull(installed.signingInfo).apkContentsSigners
        val candidateSignatures = requireNotNull(candidate.signingInfo).apkContentsSigners
        require(currentSignatures.isNotEmpty() &&
            currentSignatures.size == candidateSignatures.size &&
            currentSignatures.all { current ->
                candidateSignatures.any { next ->
                    MessageDigest.isEqual(current.toByteArray(), next.toByteArray())
                }
            }) { "앱 서명이 일치하지 않습니다." }
    }

    suspend fun downloadAndVerify(
        context: Context, api: PrismoAPI, info: AppUpdate
    ): File = withContext(Dispatchers.IO) {
        require(info.packageName == context.packageName &&
            info.versionCode > installedVersionCode(context) &&
            info.size in 1..MAX_APK_BYTES &&
            Regex("[a-f0-9]{64}").matches(info.sha256)) {
            "업데이트 파일 정보가 올바르지 않습니다."
        }
        val folder = File(context.cacheDir, "updates")
        folder.mkdirs()
        val file = File(folder, "prismo-update.apk")
        val temporary = File(folder, "prismo-update.partial")
        temporary.delete()
        try {
            val call = api.downloadUpdate()
            val cancellationWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                try { awaitCancellation() } finally { call.cancel() }
            }
            try {
                val response = call.execute()
                if (!response.isSuccessful) response.errorBody()?.close()
                require(response.isSuccessful) { "파일을 받을 수 없습니다." }
                val body = requireNotNull(response.body()) { "파일이 비어 있습니다." }
                val digest = MessageDigest.getInstance("SHA-256")
                val ioContext = currentCoroutineContext()
                var bytes = 0L
                body.use {
                    it.byteStream().use { source ->
                        temporary.outputStream().use { destination ->
                            val buffer = ByteArray(65536)
                            while (true) {
                                ioContext.ensureActive()
                                val read = source.read(buffer)
                                ioContext.ensureActive()
                                if (read < 0) break
                                bytes += read
                                require(bytes <= info.size) { "파일 크기가 올바르지 않습니다." }
                                destination.write(buffer, 0, read)
                                digest.update(buffer, 0, read)
                            }
                        }
                    }
                }
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                require(bytes == info.size && sha == info.sha256) {
                    "파일 검증에 실패했습니다."
                }
                ioContext.ensureActive()
                require(temporary.renameTo(file)) { "파일을 저장할 수 없습니다." }
                verifyPackage(context, file, info)
                ioContext.ensureActive()
                file
            } finally {
                cancellationWatcher.cancel()
            }
        } catch (e: Exception) {
            temporary.delete()
            file.delete()
            throw e
        }
    }

    fun install(context: Context, apk: File) {
        check(canInstall(context)) { "설치 권한이 필요합니다." }
        val uri = FileProvider.getUriForFile(context,
            context.packageName + ".updateprovider", apk)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_MIME)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(intent)
    }
}
