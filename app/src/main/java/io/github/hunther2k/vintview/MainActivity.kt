package io.github.hunther2k.vintview

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.print.PrintAttributes
import android.print.PrintManager
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

class MainActivity : Activity() {

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$HOST/assets/web/index.html"
        private const val REQ_PICK = 1
        val MIME_TYPES = arrayOf(
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
            "application/vnd.ms-excel",
            "application/vnd.ms-excel.sheet.macroEnabled.12",
            "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
            "application/vnd.oasis.opendocument.spreadsheet",
            "text/csv",
            "text/comma-separated-values",
            "text/tab-separated-values",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
            "application/vnd.ms-word.document.macroEnabled.12",
            "application/msword",
            "application/vnd.oasis.opendocument.text",
            "application/vnd.oasis.opendocument.text-template",
            "application/rtf",
            "text/rtf",
            "text/plain",
            "text/markdown",
        )
    }

    private class Doc(val uri: Uri, val name: String, val mime: String)

    private lateinit var web: WebView
    private val docs = ConcurrentHashMap<String, Doc>()
    private val nextId = AtomicInteger(1)
    private var pageReady = false
    private var printWeb: WebView? = null
    private val pending = ArrayList<String>()
    lateinit var updater: Updater

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        web = WebView(this)
        web.setBackgroundColor(0xFF111317.toInt())
        // WebView ignoriert eigenes Padding → Rahmen drumherum trägt die Systemleisten-Abstände
        val frame = FrameLayout(this)
        frame.setBackgroundColor(0xFF1A1D23.toInt())
        frame.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(frame)
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }

        updater = Updater(this)
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        val loader = WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/doc/") { path -> serveDoc(path) }
            .build()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            minimumFontSize = 1          // sonst schneidet der Tabellen-Zoom Text ab
            minimumLogicalFontSize = 1
            mediaPlaybackRequiresUserGesture = true
        }
        web.addJavascriptInterface(Bridge(), "Android")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                // Externe Links (z. B. GitHub, Lizenzen) im Browser öffnen
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) {}
                return true
            }
        }
        web.loadUrl(START_URL)

        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        updater.onResume()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!pageReady) { @Suppress("DEPRECATION") super.onBackPressed(); return }
        web.evaluateJavascript("window.vv ? vv.back() : false") { r ->
            if (r != "true") finish()
        }
    }

    // ---------- Dateien öffnen ----------

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val uri: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> if (Build.VERSION.SDK_INT >= 33)
                intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri != null) {
            openUri(uri, persist = false, external = true)
            // Nicht beim Drehen erneut öffnen
            intent.action = Intent.ACTION_MAIN
            intent.data = null
        }
    }

    private fun openUri(uri: Uri, persist: Boolean, external: Boolean) {
        thread {
            try {
                if (persist) {
                    try {
                        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (_: SecurityException) {}
                }
                var name: String? = null
                var size = -1L
                try {
                    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                        if (c.moveToFirst()) {
                            val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            val si = c.getColumnIndex(OpenableColumns.SIZE)
                            if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                            if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                        }
                    }
                } catch (_: Exception) {}
                if (name == null) name = uri.lastPathSegment?.substringAfterLast('/') ?: "Dokument"
                var mime = contentResolver.getType(uri)
                if (mime == null || mime == "application/octet-stream") {
                    val ext = name!!.substringAfterLast('.', "").lowercase()
                    mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                }
                // Lesbarkeit prüfen, bevor die Oberfläche umschaltet
                contentResolver.openInputStream(uri)?.close() ?: throw IllegalStateException("no stream")

                val id = nextId.getAndIncrement().toString()
                docs[id] = Doc(uri, name!!, mime!!)
                send(JSONObject()
                    .put("type", "open")
                    .put("id", id)
                    .put("url", "/doc/$id")
                    .put("name", name)
                    .put("size", size)
                    .put("mime", mime)
                    .put("uri", uri.toString())
                    .put("persist", persist || hasPersisted(uri))
                    .put("external", external))
            } catch (e: Exception) {
                send(JSONObject().put("type", "openError").put("uri", uri.toString()).put("message", e.message ?: e.javaClass.simpleName))
            }
        }
    }

    private fun hasPersisted(uri: Uri) = contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }

    private fun serveDoc(path: String): WebResourceResponse? {
        val doc = docs[path.trim('/')] ?: return null
        return try {
            val input = contentResolver.openInputStream(doc.uri) ?: return null
            WebResourceResponse(doc.mime, null, input).apply {
                responseHeaders = mapOf("Cache-Control" to "no-store")
            }
        } catch (e: Exception) {
            null
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_PICK) {
            val uri = data?.data
            if (resultCode == RESULT_OK && uri != null) openUri(uri, persist = true, external = false)
            else send(JSONObject().put("type", "pickCancel"))
        }
    }

    /** Kopie im Cache, damit andere Apps sie sicher lesen dürfen. */
    private fun shareCopy(doc: Doc): Uri {
        val dir = File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
        val safe = doc.name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val out = File(dir, safe)
        contentResolver.openInputStream(doc.uri)!!.use { i -> out.outputStream().use { o -> i.copyTo(o) } }
        return FileProvider.getUriForFile(this, "$packageName.files", out)
    }

    // ---------- Brücke zur Oberfläche ----------

    fun send(obj: JSONObject) {
        val js = "window.vv && vv.native(" + obj.toString() + ")"
        runOnUiThread {
            if (pageReady) web.evaluateJavascript(js, null) else pending.add(js)
        }
    }

    fun toast(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

    inner class Bridge {
        @JavascriptInterface
        fun ready() = runOnUiThread {
            pageReady = true
            pending.forEach { web.evaluateJavascript(it, null) }
            pending.clear()
            updater.check(manual = false)
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface
        fun lang(): String = resources.configuration.locales[0].language

        @JavascriptInterface
        fun pickFile() = runOnUiThread {
            val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, MIME_TYPES)
            }
            try {
                @Suppress("DEPRECATION")
                startActivityForResult(i, REQ_PICK)
            } catch (e: ActivityNotFoundException) {
                toast(getString(R.string.no_app))
            }
        }

        @JavascriptInterface
        fun openRecent(uri: String) = openUri(Uri.parse(uri), persist = false, external = false)

        /** Liste „Zuletzt geöffnet“ dauerhaft in den App-Einstellungen (robuster als WebView-Speicher). */
        @JavascriptInterface
        fun loadRecent(): String = getSharedPreferences("vintview", MODE_PRIVATE).getString("recent", "") ?: ""

        @JavascriptInterface
        fun saveRecent(json: String) {
            getSharedPreferences("vintview", MODE_PRIVATE).edit().putString("recent", json).commit()
        }

        @JavascriptInterface
        fun forgetRecent(uri: String) {
            try {
                contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {}
        }

        @JavascriptInterface
        fun share(id: String) {
            val doc = docs[id] ?: return
            thread {
                try {
                    val u = shareCopy(doc)
                    val i = Intent(Intent.ACTION_SEND).apply {
                        type = doc.mime
                        putExtra(Intent.EXTRA_STREAM, u)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    runOnUiThread { startActivity(Intent.createChooser(i, getString(R.string.share_title))) }
                } catch (e: Exception) {
                    toast(e.message ?: "Fehler")
                }
            }
        }

        @JavascriptInterface
        fun openWith(id: String) {
            val doc = docs[id] ?: return
            thread {
                try {
                    val u = shareCopy(doc)
                    val i = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(u, doc.mime)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    val chooser = Intent.createChooser(i, getString(R.string.open_with_title)).apply {
                        putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(this@MainActivity, MainActivity::class.java)))
                    }
                    runOnUiThread {
                        try { startActivity(chooser) } catch (_: ActivityNotFoundException) { toast(getString(R.string.no_app)) }
                    }
                } catch (e: Exception) {
                    toast(e.message ?: "Fehler")
                }
            }
        }

        /** PDF unverändert an den Android-Druckdienst geben. */
        @JavascriptInterface
        fun printPdf(id: String, title: String) {
            val doc = docs[id] ?: return
            runOnUiThread {
                try {
                    val pm = getSystemService(PRINT_SERVICE) as PrintManager
                    pm.print(title, PdfPrintAdapter(this@MainActivity, doc.uri, title), PrintAttributes.Builder().build())
                } catch (e: Exception) {
                    toast(e.message ?: "Fehler")
                }
            }
        }

        /** Druckfertiges HTML in einer unsichtbaren WebView setzen und drucken. */
        @JavascriptInterface
        fun printHtml(title: String, html: String) = runOnUiThread {
            val w = WebView(this@MainActivity)
            w.settings.javaScriptEnabled = false
            w.settings.allowFileAccess = false
            w.settings.allowContentAccess = false
            w.settings.blockNetworkLoads = true
            w.webViewClient = object : WebViewClient() {
                private var done = false
                override fun onPageFinished(view: WebView, url: String?) {
                    if (done) return
                    done = true
                    try {
                        val pm = getSystemService(PRINT_SERVICE) as PrintManager
                        pm.print(title, view.createPrintDocumentAdapter(title), PrintAttributes.Builder().build())
                    } catch (e: Exception) {
                        toast(e.message ?: "Fehler")
                    }
                }
            }
            printWeb?.destroy()
            printWeb = w   // Referenz halten, bis der nächste Druck kommt
            w.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        }

        @JavascriptInterface
        fun checkUpdate() = updater.check(manual = true)

        @JavascriptInterface
        fun installUpdate() = runOnUiThread { updater.install() }

        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread {
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: ActivityNotFoundException) {}
        }
    }

    fun canInstallPackages(): Boolean = packageManager.canRequestPackageInstalls()

    fun archiveInfo(file: File) = if (Build.VERSION.SDK_INT >= 33)
        packageManager.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(0))
    else @Suppress("DEPRECATION") packageManager.getPackageArchiveInfo(file.path, 0)
}
