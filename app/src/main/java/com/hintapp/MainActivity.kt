package com.hintapp

import android.annotation.SuppressLint
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "HintApp"
        private const val KEY_URL = "site_url"
        private const val KEY_HOST = "site_host"
        private const val ENGINE_HOST = "appassets.androidplatform.net"
        private val ALLOWED_HOSTS = listOf("chess.com", "lichess.org")
        private val ASSET_NAME = Regex("[A-Za-z0-9._-]{1,64}")

        // Страница-хозяин для воркера. Живёт в отдельном скрытом WebView,
        // правила CSP сайтов на неё не действуют.
        // stockfish lite-single — ES module, но добавляем fallback на classic
        // (обе сборки встречаются в природе).
        private const val ENGINE_PAGE = """<!doctype html><html><body><script>
var w = null;
function hintStop() { if (w) { try { w.terminate(); } catch (e) {} w = null; } }
function hintStart(file) {
  hintStop();
  var url = 'https://appassets.androidplatform.net/' + file;
  function wire(worker) {
    worker.onmessage = function (e) {
      if (w === worker && typeof e.data === 'string') AndroidEngine.onLine(e.data);
    };
    worker.onerror = function (e) {
      if (w !== worker) return;
      AndroidEngine.onError(String((e && e.message) || 'worker error'));
    };
  }
  try {
    var mw = new Worker(url, { type: 'module' });
    w = mw;
    wire(mw);
    return;
  } catch (e1) {}
  try {
    var cw = new Worker(url);
    w = cw;
    wire(cw);
  } catch (e2) {
    AndroidEngine.onError('worker: ' + String(e2));
  }
}
function hintSend(m) { if (w) w.postMessage(m); }
</script></body></html>"""
    }

    private lateinit var rootLayout: LinearLayout
    private var webView: WebView? = null
    private var siteHost: String? = null

    private var engineView: WebView? = null
    private var engineLoaded = false
    private val enginePending = ArrayList<String>()

    private var cachedHintJs: String? = null

    @Volatile private var currentHost: String? = null

    private val backCallback = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            val wv = webView ?: return
            if (wv.canGoBack()) wv.goBack()
            else { destroyWebView(); showMenu() }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (isDebuggable()) WebView.setWebContentsDebuggingEnabled(true)

        onBackPressedDispatcher.addCallback(this, backCallback)

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
            setOnClickListener { openSite("https://www.chess.com/play/online", "chess.com") }
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
        destroyEngineView()
    }

    private fun destroyEngineView() {
        engineView?.let { ev ->
            try { ev.stopLoading() } catch (e: Exception) {}
            (ev.parent as? ViewGroup)?.removeView(ev)
            try { ev.destroy() } catch (e: Exception) {}
        }
        engineView = null
        engineLoaded = false
        enginePending.clear()
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun createEngineView(): WebView {
        engineLoaded = false
        enginePending.clear()
        return WebView(this).apply {
            alpha = 0.01f
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.cacheMode = WebSettings.LOAD_NO_CACHE

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val uri = request?.url ?: return null
                    if (uri.host == ENGINE_HOST) {
                        val name = (uri.path ?: "").removePrefix("/")
                        if (name == "index.html") {
                            return WebResourceResponse(
                                "text/html", "utf-8", 200, "OK",
                                mapOf("Cache-Control" to "no-cache"),
                                ByteArrayInputStream(ENGINE_PAGE.toByteArray(Charsets.UTF_8))
                            )
                        }
                        return serveAsset(name)
                    }
                    return notFound(emptyMap())
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    engineLoaded = true
                    val ev = engineView ?: return
                    for (js in enginePending) ev.evaluateJavascript(js, null)
                    enginePending.clear()
                }

                @SuppressLint("NewApi")
                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    Log.e(TAG, "engine render gone, didCrash=${detail?.didCrash()}")
                    engineLoaded = false
                    enginePending.clear()
                    engineView = null
                    // hint.js мгновенно переключится на следующий источник,
                    // не дожидаясь 10-секундного таймаута.
                    pushToPage("__hintEngineError", "engine renderer died (didCrash=${detail?.didCrash()})")
                    return true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    Log.d("HintEngine", "${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                    return true
                }
            }

            addJavascriptInterface(EngineSink(), "AndroidEngine")
            loadUrl("https://$ENGINE_HOST/index.html")
        }
    }

    private fun runEngineJs(js: String) {
        runOnUiThread {
            val ev = engineView ?: return@runOnUiThread
            if (engineLoaded) {
                try { ev.evaluateJavascript(js, null) }
                catch (e: Exception) {
                    Log.e(TAG, "runEngineJs failed", e)
                    engineLoaded = false
                }
            } else {
                enginePending.add(js)
            }
        }
    }

    private fun pushToPage(fn: String, arg: String) {
        val js = "window." + fn + " && window." + fn + "(" + JSONObject.quote(arg) + ")"
        runOnUiThread {
            try { webView?.evaluateJavascript(js, null) } catch (e: Exception) { /* ignore */ }
        }
    }

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

                override fun onPageStarted(view: WebView?, pageUrl: String?, favicon: android.graphics.Bitmap?) {
                    super.onPageStarted(view, pageUrl, favicon)
                    currentHost = pageUrl?.let { Uri.parse(it).host }
                }

                override fun onPageCommitVisible(view: WebView?, url: String?) {
                    super.onPageCommitVisible(view, url)
                    val h = url?.let { Uri.parse(it).host }
                    if (view != null && hostMatches(h, host)) injectScript(view)
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                    Log.e(TAG, "webview error: ${error?.description} url=${request?.url}")
                }

                override fun onReceivedHttpError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    errorResponse: WebResourceResponse?
                ) {
                    super.onReceivedHttpError(view, request, errorResponse)
                    Log.w(TAG, "http ${errorResponse?.statusCode} ${request?.url}")
                }

                override fun onPageFinished(view: WebView?, currentUrl: String?) {
                    super.onPageFinished(view, currentUrl)
                    val h = currentUrl?.let { Uri.parse(it).host }
                    currentHost = h
                    if (view != null && hostMatches(h, host)) injectScript(view)
                }

                @SuppressLint("NewApi")
                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    Log.e(TAG, "site render gone, didCrash=${detail?.didCrash()}")
                    destroyWebView()
                    showMenu()
                    return true
                }
            }

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

        val ev = createEngineView()
        engineView = ev
        val container = FrameLayout(this)
        container.addView(ev, FrameLayout.LayoutParams(1, 1))
        container.addView(
            wv,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(container)
        backCallback.isEnabled = true
    }

    private fun injectScript(view: WebView) {
        try {
            if (cachedHintJs == null) {
                cachedHintJs = assets.open("hint.js").bufferedReader().use { it.readText() }
            }
            val js = cachedHintJs!!
            view.evaluateJavascript(js) { result ->
                Log.i(TAG, "inject result=$result (${js.length} chars)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "inject failed", e)
        }
    }

    inner class NativeBridge {
        @JavascriptInterface fun ping(): String = "pong"

        @JavascriptInterface
        fun engineStart(kind: String): Boolean {
            if (!isAllowedHost(currentHost)) return false
            // если скрытый WebView умер — сообщаем hint.js сразу,
            // чтобы он ушёл на следующий источник без 10-секундного таймаута
            if (engineView == null) return false
            val file = if (kind == "asm") "engine-asm.js" else "engine.js"
            runEngineJs("hintStart(" + JSONObject.quote(file) + ")")
            return true
        }

        @JavascriptInterface
        fun engineSend(msg: String) {
            if (!isAllowedHost(currentHost)) return
            if (msg.length > 4096) return
            runEngineJs("hintSend(" + JSONObject.quote(msg) + ")")
        }

        @JavascriptInterface
        fun engineStop() {
            if (!isAllowedHost(currentHost)) return
            // убираем из очереди зависшие hintStart — они уже не нужны,
            // а при flush создали бы «сиротский» воркер
            enginePending.removeAll { it.contains("hintStart") }
            runEngineJs("hintStop()")
        }
    }

    inner class EngineSink {
        @JavascriptInterface fun onLine(line: String) { pushToPage("__hintEngineLine", line) }
        @JavascriptInterface fun onError(msg: String) {
            Log.e(TAG, "engine error: $msg")
            pushToPage("__hintEngineError", msg)
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        // намеренно не вызываем webView.onPause():
        // он останавливает JS, и __hintEngineLine не доставляются до страницы
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }
}
