package dev.prismo.app

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream

private const val PAGE = "https://appassets.androidplatform.net/assets/renderer.html"

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CodeViewer(
    path: String,
    mode: String,
    source: String,
    preferences: ViewerPreferences,
    modifier: Modifier = Modifier
) {
    val options = JSONObject().apply {
        put("fontSize", preferences.fontSize)
        put("lineHeight", preferences.lineHeight)
        put("padding", preferences.padding)
        put("wrap", preferences.wrap)
        put("numbers", preferences.numbers)
        put("split", preferences.split)
        put("dark", preferences.dark)
    }
    val payload = JSONObject().apply {
        put("path", path)
        put("mode", mode)
        put("content", source)
        put("options", options)
    }.toString()
    val currentPayload = rememberUpdatedState(payload)
    fun update(webView: WebView) {
        // Keep the WebView completion callback bound to the latest Compose payload.
        val argument = JSONObject.quote(currentPayload.value)
        webView.evaluateJavascript("window.Prismo && window.Prismo.render($argument);", null)
    }
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { context ->
            val loader = WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
                .build()
            WebView(context).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                settings.allowFileAccess = false
                settings.allowContentAccess = false
                settings.domStorageEnabled = false
                settings.setSupportZoom(false)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(
                        view: WebView, request: WebResourceRequest
                    ) = request.url.toString() != PAGE
                    override fun shouldInterceptRequest(
                        view: WebView, request: WebResourceRequest
                    ): WebResourceResponse? {
                        val uri = request.url
                        if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net") {
                            return loader.shouldInterceptRequest(uri) ?: WebResourceResponse(
                                "text/plain", "utf-8", 404, "Not Found", emptyMap(),
                                ByteArrayInputStream(ByteArray(0))
                            )
                        }
                        return WebResourceResponse("text/plain", "utf-8", 403,
                            "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                    }
                    override fun onPageFinished(view: WebView, url: String) {
                        if (url == PAGE) update(view)
                    }
                }
                loadUrl(PAGE)
            }
        },
        onRelease = { webView ->
            webView.stopLoading()
            webView.destroy()
        },
        update = { update(it) }
    )
}
