package com.hintapp

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.io.InputStream

class MainActivity : AppCompatActivity() {

    private lateinit var rootLayout: LinearLayout
    private var webView: WebView? = null

    @Volatile private var cachedStockfishJs: String? = null
    @Volatile private var cachedStockfishWasm: String? = null
    private val stockfishLock = Object()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        preloadStockfish()
        showMenu()
    }

    private fun preloadStockfish() {
        Thread {
            try {
                val js = assets.open("stockfish-19-lite-single.js").bufferedReader().use { it.readText() }
                val wasm = readBytesFromAsset("stockfish-19-lite-single.wasm")
                val wasmBase64 = Base64.encodeToString(wasm, Base64.NO_WRAP)

                synchronized(stockfishLock) {
                    cachedStockfishJs = js
                    cachedStockfishWasm = wasmBase64
                    stockfishLock.notifyAll()
                }
                Log.i("HintApp", "Engine preloaded: JS ${js.length} chars, WASM ${wasmBase64.length} chars")
            } catch (e: Exception) {
                Log.e("HintApp", "preload failed", e)
                synchronized(stockfishLock) {
                    stockfishLock.notifyAll()
                }
            }
        }.start()
    }

    private fun readBytesFromAsset(fileName: String): ByteArray {
        val inputStream: InputStream = assets.open(fileName)
        return inputStream.use { it.readBytes() }
    }

    private fun showMenu() {
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
        webView?.let { old ->
            try { old.stopLoading() } catch (e: Exception) {}
            (old.parent as? ViewGroup)?.removeView(old)
            try { old.destroy() } catch (e: Exception) {}
        }
        webView = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openSite(url: String, host: String) {
        destroyWebView()

        val wv = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false

            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                    if (url == null) return false
                    if (url.startsWith("http://") || url.startsWith("https://")) return false
                    return true 
                }

                override fun onPageFinished(view: WebView?, currentUrl: String?) {
                    super.onPageFinished(view, currentUrl)
                    if (currentUrl?.contains(host) == true && view != null) {
                        injectScript(view)
                    }
                }
            }

            addJavascriptInterface(NativeBridge(), "NativeHint")
            loadUrl(url)
        }
        webView = wv
        setContentView(wv)
    }

    private fun injectScript(view: WebView) {
        try {
            val js = assets.open("hint.js").bufferedReader().use { it.readText() }
            view.evaluateJavascript(js, null)
            Log.i("HintApp", "hint.js injected")
        } catch (e: Exception) {
            Log.e("HintApp", "inject failed", e)
        }
    }

    inner class NativeBridge {
        @JavascriptInterface
        fun getStockfishJs(): String {
            synchronized(stockfishLock) {
                var waited = 0L
                while (cachedStockfishJs == null && waited < 5000) {
                    try {
                        stockfishLock.wait(5000 - waited)
                        waited = 5000
                    } catch (e: InterruptedException) {
                        break
                    }
                }
                return cachedStockfishJs ?: throw IllegalStateException("JS not loaded")
            }
        }

        @JavascriptInterface
        fun getStockfishWasmBase64(): String {
            synchronized(stockfishLock) {
                var waited = 0L
                while (cachedStockfishWasm == null && waited < 5000) {
                    try {
                        stockfishLock.wait(5000 - waited)
                        waited = 5000
                    } catch (e: InterruptedException) {
                        break
                    }
                }
                return cachedStockfishWasm ?: throw IllegalStateException("WASM not loaded")
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        val wv = webView
        if (wv != null) {
            if (wv.canGoBack()) {
                wv.goBack()
            } else {
                destroyWebView()
                showMenu()
            }
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        destroyWebView()
        super.onDestroy()
    }
}
