package io.github.hunther2k.vintview

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import java.io.FileOutputStream

/** Reicht eine PDF-Datei 1:1 an den Android-Druckdienst weiter. */
class PdfPrintAdapter(
    private val ctx: Context,
    private val uri: Uri,
    private val name: String,
) : PrintDocumentAdapter() {

    override fun onLayout(
        oldAttributes: PrintAttributes?,
        newAttributes: PrintAttributes,
        cancellationSignal: CancellationSignal,
        callback: LayoutResultCallback,
        extras: Bundle?,
    ) {
        if (cancellationSignal.isCanceled) {
            callback.onLayoutCancelled()
            return
        }
        val fileName = if (name.endsWith(".pdf", ignoreCase = true)) name else "$name.pdf"
        val info = PrintDocumentInfo.Builder(fileName)
            .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
            .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
            .build()
        callback.onLayoutFinished(info, oldAttributes == null)
    }

    override fun onWrite(
        pages: Array<out PageRange>,
        destination: ParcelFileDescriptor,
        cancellationSignal: CancellationSignal,
        callback: WriteResultCallback,
    ) {
        try {
            ctx.contentResolver.openInputStream(uri).use { input ->
                FileOutputStream(destination.fileDescriptor).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (cancellationSignal.isCanceled) {
                            callback.onWriteCancelled()
                            return
                        }
                        val n = input?.read(buf) ?: -1
                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }
            callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
        } catch (e: Exception) {
            callback.onWriteFailed(e.message)
        }
    }
}
