package com.hintapp

import android.annotation.SuppressLint
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.io.ByteArrayInputStream
import java.io.IOException

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HintApp"
        private const val KEY_URL = "site_url"
        private const val KEY_HOST = "site_host"
        private val ALLOWED_HOSTS = listOf("chess.com", "lichess.org")
        private val ASSET_NAME = Regex("[A-Za-z0-9._-]{1,64}")
    }

    private lateinit var rootLayout: LinearLayout
    private var webView: WebView? = null
    private var siteHost: String? = null

    // Хост страницы, которая сейчас открыта (нужен, чтобы мост отвечал только своим сайтам)
    @Volatile private var currentHost: String? = null

    // engine.js для запасного варианта через мост; читается лениво, один раз
    @Volatile private var engineJs: String? = null
    @Volatile private var engineJsError: String? = null
    private val engineLock = Any()

    // Кнопка «Назад» через диспетчер (работает и на Android 13+)
    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            val wv = webView ?: return
            if (wv.canGoBack()) wv.goBack()
            else {
                destroyWebView()
                showMenu()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // chrome://inspect работает только в debug-сборке
        if (isDebuggable()) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        onBackPressedDispatcher.addCallback(this, backCallback)

        // Если Activity пересоздали (поворот и т.п.) — возвращаемся на тот же сайт
        val savedUrl = savedInstanceState?.getString(KEY_URL)
        val savedHost = savedInstanceState?.getString(KEY_HOST)
        if (savedUrl != null && savedHost != null) openSite(savedUrl, savedHost) else showMenu()
    }

    private fun isDebuggable(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        val url = webView?.url
        val host = siteHost
        if (url != null && host != null) {
            outState.putString(KEY_URL, url)
            outState.putString(KEY_HOST, host)
        }
    }

    private fun hostMatches(h: String?, base: String): Boolean =
        h != null && (h == base || h.endsWith(".$base"))

    private fun isAllowedHost(h: String?): Boolean = ALLOWED_HOSTS.any { hostMatches(h, it) }

    private fun showMenu() {
        siteHost = null
        currentHost = null
        backCallback.isEnabled = false

        rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF1A1A1A.toInt())
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val title = TextView(this).apply {
            text = "Chess Hint"
            textSize = 28f
            setTextColor(0xFFFFFFFF.toInt())
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 60)
        }

        val btnChessCom = Button(this).apply {
            text = "Chess.com"
            textSize = 18f
            setOnClickListener { openSite("https://www.chess.com/play/computer", "chess.com") }
        }

        val btnLichess = Button(this).apply {
            text = "Lichess"
            textSize = 18f
            setOnClickListener { openSite("https://lichess.org/", "lichess.org") }
        }

        val padding = (32 * resources.displayMetrics.density).toInt()
        val marginBottom = (24 * resources.displayMetrics.density).toInt()

        rootLayout.setPadding(padding, padding, padding, padding)
        rootLayout.addView(title)
        rootLayout.addView(btnChessCom, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, 0, 0, marginBottom) })
        rootLayout.addView(btnLichess, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        setContentView(rootLayout)
    }

    private fun destroyWebView() {
        backCallback.isEnabled = false
        webView?.let { old ->
            try { old.stopLoading() } catch (e: Exception) {}
            (old.parent as? ViewGroup)?.removeView(old)
            try { old.destroy() } catch (e: Exception) {}
        }
        webView = null
    }

    // Файлы движка из assets отдаём как обычные страницы сайта:
    //   https://<сайт>/__hint/engine.js   -> assets/engine.js
    //   https://<сайт>/__hint/engine.wasm -> assets/engine.wasm (если есть)
    // Воркер получает свой .wasm рядом со скриптом — без base64 и без моста.
    private fun serveAsset(name: String): WebResourceResponse {
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Cache-Control" to "no-cache"
        )
        if (!ASSET_NAME.matches(name)) return notFound(headers)
        return try {
            val mime = when {
                name.endsWith(".wasm") -> "application/wasm"
                name.endsWith(".js") -> "application/javascript"
                else -> "application/octet-stream"
            }
            val enc = if (name.endsWith(".js")) "utf-8" else null
            WebResourceResponse(mime, enc, 200, "OK", headers, assets.open(name))
        } catch (e: IOException) {
            Log.w(TAG, "asset not found: $name")
            notFound(headers)
        }
    }

    private fun notFound(headers: Map<String, String>) = WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0))
    )

    @SuppressLint("SetJavaScriptEnabled")
    private fun openSite(url: String, host: String) {
        destroyWebView()
        siteHost = host

        // Дефолтный UA без маркера "; wv" — по нему Google блокирует вход в WebView
        val ua = WebSettings.getDefaultUserAgent(this).replace("; wv", "")

        val wv = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.userAgentString = ua

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {

                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    val path = uri.path ?: return null
                    if (!path.startsWith("/__hint/") || !isAllowedHost(uri.host)) return null
                    return serveAsset(path.removePrefix("/__hint/"))
                }

                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val u = request?.url?.toString() ?: return false
                    return !(u.startsWith("http://") || u.startsWith("https://"))
                }

                @Deprecated("Deprecated in API 24")
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    if (url == null) return false
                    return !(url.startsWith("http://") || url.startsWith("https://"))
                }

                override fun onPageStarted(view: WebView?, pageUrl: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, pageUrl, favicon)
                    currentHost = pageUrl?.let { Uri.parse(it).host }
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    Log.e(TAG, "webview error: ${error?.description} url=${request?.url}")
                }

                override fun onPageFinished(view: WebView?, currentUrl: String?) {
                    super.onPageFinished(view, currentUrl)
                    val h = currentUrl?.let { Uri.parse(it).host }
                    currentHost = h
                    if (view != null && hostMatches(h, host)) {
                        injectScript(view)
                    }
                }
            }

            // console.* страницы -> Logcat с правильным уровнем
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    val text = "${msg.message()}  (${msg.sourceId()}:${msg.lineNumber()})"
                    when (msg.messageLevel()) {
                        ConsoleMessage.MessageLevel.ERROR -> Log.e("HintConsole", text)
                        ConsoleMessage.MessageLevel.WARNING -> Log.w("HintConsole", text)
                        else -> Log.d("HintConsole", text)
                    }
                    return true
                }
            }

            addJavascriptInterface(NativeBridge(), "NativeHint")
            loadUrl(url)
        }
        webView = wv
        setContentView(wv)
        backCallback.isEnabled = true
    }

    private fun injectScript(view: WebView) {
        try {
            val js = assets.open("hint.js").bufferedReader().use { it.readText() }
            view.evaluateJavascript(js) { result ->
                Log.i(TAG, "inject result=$result (${js.length} chars)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "inject failed", e)
        }
    }

    private fun loadEngineJs(): String {
        engineJs?.let { return it }
        synchronized(engineLock) {
            engineJs?.let { return it }
            return try {
                val js = assets.open("engine.js").bufferedReader().use { it.readText() }
                engineJs = js
                engineJsError = null
                Log.i(TAG, "engine.js loaded: ${js.length} chars")
                js
            } catch (e: Exception) {
                Log.e(TAG, "engine.js load failed", e)
                engineJsError = e.message ?: "unknown"
                ""
            }
        }
    }

    // Запасной путь: если воркер по адресу /__hint/engine.js не запустился.
    // Мост отвечает только страницам chess.com / lichess.org.
    inner class NativeBridge {

        @JavascriptInterface
        fun ping(): String = "pong"

        @JavascriptInterface
        fun getStockfishError(): String {
            if (!isAllowedHost(currentHost)) return ""
            return engineJsError ?: ""
        }

        @JavascriptInterface
        fun getStockfishJs(): String {
            if (!isAllowedHost(currentHost)) return ""
            return loadEngineJs()
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        webView?.onPause()
        webView?.pauseTimers()
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        webView?.resumeTimers()
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }
}
