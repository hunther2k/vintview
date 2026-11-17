package io.github.hunther2k.vintview

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Updates über GitHub-Releases: fragt das neueste Release ab, lädt die APK
 * herunter und übergibt sie dem System-Installer.
 */
class Updater(private val act: MainActivity) {

    private class Release(val version: String, val notes: String, val apkUrl: String, val size: Long, val page: String)

    @Volatile private var latest: Release? = null
    @Volatile private var busy = false
    private var waitingForPermission = false

    fun check(manual: Boolean) {
        if (busy) return
        thread {
            try {
                val rel = fetchLatest()
                latest = rel
                if (rel != null && isNewer(rel.version, BuildConfig.VERSION_NAME)) {
                    act.send(JSONObject()
                        .put("type", "update")
                        .put("version", rel.version)
                        .put("notes", rel.notes)
                        .put("size", rel.size)
                        .put("page", rel.page)
                        .put("manual", manual))
                } else if (manual) {
                    act.send(JSONObject().put("type", "updateState").put("state", "current"))
                }
            } catch (e: Exception) {
                if (manual) act.send(JSONObject().put("type", "updateState").put("state", "error").put("message", e.message ?: ""))
            }
        }
    }

    private fun fetchLatest(): Release? {
        val c = URL("https://api.github.com/repos/${BuildConfig.UPDATE_REPO}/releases/latest").openConnection() as HttpURLConnection
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Vintview/${BuildConfig.VERSION_NAME}")
        c.connectTimeout = 10000
        c.readTimeout = 15000
        try {
            if (c.responseCode == 404) return null
            if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
            val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
            val assets = j.optJSONArray("assets") ?: return null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                if (a.optString("name").endsWith(".apk")) {
                    return Release(
                        version = j.optString("tag_name").removePrefix("v"),
                        notes = j.optString("body"),
                        apkUrl = a.getString("browser_download_url"),
                        size = a.optLong("size", -1),
                        page = j.optString("html_url"),
                    )
                }
            }
            return null
        } finally {
            c.disconnect()
        }
    }

    fun install() {
        val rel = latest ?: return
        if (busy) return
        if (!act.canInstallPackages()) {
            waitingForPermission = true
            act.send(JSONObject().put("type", "updateState").put("state", "permission"))
            act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}")))
            return
        }
        busy = true
        thread {
            try {
                val dir = File(act.cacheDir, "updates").apply { deleteRecursively(); mkdirs() }
                val file = File(dir, "vintview-${rel.version}.apk")
                download(rel.apkUrl, file)
                val info = act.archiveInfo(file)
                if (info == null || info.packageName != act.packageName) throw IllegalStateException("APK ungültig")
                act.send(JSONObject().put("type", "updateState").put("state", "installing"))
                val uri = FileProvider.getUriForFile(act, "${act.packageName}.files", file)
                val i = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                act.runOnUiThread { act.startActivity(i) }
            } catch (e: Exception) {
                act.send(JSONObject().put("type", "updateState").put("state", "error").put("message", e.message ?: ""))
            } finally {
                busy = false
            }
        }
    }

    private fun download(url: String, out: File) {
        var u = URL(url)
        var redirects = 0
        while (true) {
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.setRequestProperty("User-Agent", "Vintview/${BuildConfig.VERSION_NAME}")
            c.connectTimeout = 15000
            c.readTimeout = 30000
            val code = c.responseCode
            if (code in 300..399 && redirects < 5) {
                u = URL(u, c.getHeaderField("Location"))
                redirects++
                c.disconnect()
                continue
            }
            if (code != 200) throw IllegalStateException("HTTP $code")
            val total = c.contentLengthLong
            var done = 0L
            var lastPct = -1
            c.inputStream.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        done += n
                        if (total > 0) {
                            val pct = (done * 100 / total).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                act.send(JSONObject().put("type", "updateState").put("state", "downloading").put("progress", pct))
                            }
                        }
                    }
                }
            }
            c.disconnect()
            return
        }
    }

    /** Nach Rückkehr aus den Einstellungen automatisch weitermachen. */
    fun onResume() {
        if (waitingForPermission && act.canInstallPackages()) {
            waitingForPermission = false
            install()
        } else if (waitingForPermission) {
            waitingForPermission = false
            act.send(JSONObject().put("type", "updateState").put("state", "idle"))
        }
    }

    companion object {
        fun isNewer(a: String, b: String): Boolean {
            val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
            val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val x = pa.getOrElse(i) { 0 }
                val y = pb.getOrElse(i) { 0 }
                if (x != y) return x > y
            }
            return false
        }
    }
}
