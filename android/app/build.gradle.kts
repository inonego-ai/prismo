import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("com.google.android.gms.oss-licenses-plugin")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
val androidKeyStore = providers.environmentVariable("PRISMO_ANDROID_KEYSTORE").orNull
val androidKeyStorePassword = providers.environmentVariable("PRISMO_ANDROID_STORE_PASSWORD").orNull
val androidKeyAlias = providers.environmentVariable("PRISMO_ANDROID_KEY_ALIAS").orNull
val androidKeyPassword = providers.environmentVariable("PRISMO_ANDROID_KEY_PASSWORD").orNull
val hasReleaseSigning = listOf(androidKeyStore, androidKeyStorePassword,
    androidKeyAlias, androidKeyPassword).all { !it.isNullOrBlank() }

android {
    namespace = "dev.prismo.app"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.prismo.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 10
        versionName = "0.2.0"
    }
    if (hasReleaseSigning) {
        signingConfigs {
            create("prismoRelease") {
                storeFile = file(requireNotNull(androidKeyStore))
                storePassword = requireNotNull(androidKeyStorePassword)
                keyAlias = requireNotNull(androidKeyAlias)
                keyPassword = requireNotNull(androidKeyPassword)
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("prismoRelease")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    packaging {
        resources {
            // Iroh's JVM artifacts carry desktop natives that Android cannot load.
            excludes += setOf("win32-x86-64/**", "darwin-aarch64/**")
        }
    }
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
val bundleRenderer by tasks.registering(Exec::class) {
    workingDir = file("../../renderer")
    commandLine(if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm", "run", "build")
}
val copyAndroidLicenseNotices by tasks.registering(Copy::class) {
    from(file("../../docs/ANDROID_LIBRARY_NOTICES.txt"))
    into(file("src/main/assets"))
    rename { "android-library-notices.txt" }
}
tasks.named("preBuild") { dependsOn(bundleRenderer, copyAndroidLicenseNotices) }
// Only an assembled, signed release APK is eligible for in-app updates.
val generateReleaseMetadata by tasks.registering {
    val releaseDir = layout.buildDirectory.dir("outputs/apk/release")
    doLast {
        val folder = releaseDir.get().asFile
        val apk = folder.resolve("app-release.apk")
        val gradleMetadata = folder.resolve("output-metadata.json")
        require(apk.isFile && gradleMetadata.isFile) {
            "Signed release APK and Gradle output metadata are required."
        }
        val metadata = gradleMetadata.readText()
        require(metadata.contains("\"variantName\": \"release\"") &&
            metadata.contains("\"outputFile\": \"app-release.apk\"")) {
            "Unexpected Android release artifact metadata."
        }

        val digest = MessageDigest.getInstance("SHA-256")
        apk.inputStream().use { source ->
            val buffer = ByteArray(65536)
            while (true) {
                val count = source.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        val code = requireNotNull(android.defaultConfig.versionCode)
        val version = requireNotNull(android.defaultConfig.versionName)
        folder.resolve("prismo-update.json").writeText(
            """{"packageName":"dev.prismo.app","versionCode":$code,"versionName":"$version","apk":"app-release.apk","size":${apk.length()},"sha256":"$hash"}""" + "\n"
        )
    }
}
tasks.matching { it.name == "assembleRelease" }.configureEach {
    doFirst {
        require(hasReleaseSigning) {
            "Android release signing environment variables are required."
        }
    }
    finalizedBy(generateReleaseMetadata)
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.squareup.retrofit2:retrofit:2.11.0")
    implementation("com.squareup.retrofit2:converter-gson:2.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("computer.iroh:iroh-android:1.2.0") {
        exclude(group = "net.java.dev.jna", module = "jna")
    }
    implementation("net.java.dev.jna:jna:5.15.0@aar")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
