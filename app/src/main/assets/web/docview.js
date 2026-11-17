import { t } from './i18n.js';
import { attachZoom } from './zoom.js';
import { jszip, docxPreview, xlsx } from './libs.js';
import { odtToHtml, odtMeta } from './odt.js';
import { decodeText, docToText, rtfToText } from './plaintext.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MAX_TEXT = 8 * 1024 * 1024;

const DOCX_OPTS = {
  className: 'docx',
  ignoreFonts: false,
  ignoreLastRenderedPageBreak: true,
  experimental: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  renderComments: false,
  renderAltChunks: false,   // eingebettetes HTML nicht ausführen
  renderChanges: false,
};

/**
 * Ansicht für Fließtext-Dokumente: Text, Word (.docx/.doc), OpenDocument (.odt), RTF.
 * Lesemodus: Text bricht beim Zoomen neu um. Seitenansicht (nur .docx): Seiten wie in Word.
 */
export class DocView {
  constructor(section, ui) {
    this.sec = section;
    this.ui = ui;
    this.scroller = section.querySelector('.scroller');
    this.body = section.querySelector('.docbody');
    this.zoom = 1;
    this.reflow = true;
    this.zoomer = attachZoom(this.scroller, this.body, {
      get: () => this.zoom,
      apply: z => { this.zoom = z; this.applyZoom(); },
      min: 0.5, max: 4, dbl: 1.8,
      reflow: () => this.reflow,
      cssZoom: () => parseFloat(this.body.style.zoom) || 1,
    });
    new ResizeObserver(() => { if (this.kind) this.applyZoom(); }).observe(this.scroller);
  }

  /** kind: text | docx | odt | doc | rtf */
  async open(buf, kind) {
    this.kind = kind;
    this.u8 = new Uint8Array(buf);
    this.zoom = 1;
    this.meta = {};
    this.plain = null;
    let sub = '';
    if (kind === 'docx') {
      let mode = 'read';
      try { mode = localStorage.getItem('vv.docxMode') || 'read'; } catch {}
      this.reflow = mode !== 'page';
      await this.renderDocx();
      this.meta = await this.officeMeta();
      if (this.meta.pages) sub = this.meta.pages === 1 ? t('page1') : t('pages', { n: this.meta.pages });
    } else if (kind === 'odt') {
      this.reflow = true;
      const JSZip = await jszip();
      const zip = await JSZip.loadAsync(this.u8);
      this.body.className = 'docbody paper reflow odt';
      this.body.innerHTML = await odtToHtml(zip);
      this.meta = await odtMeta(zip);
      if (this.meta.pages) sub = this.meta.pages === 1 ? t('page1') : t('pages', { n: this.meta.pages });
    } else {
      this.reflow = true;
      let text;
      if (kind === 'doc') text = docToText(this.u8, (await xlsx()).CFB);
      else if (kind === 'rtf') text = rtfToText(decodeText(this.u8));
      else text = decodeText(this.u8.length > MAX_TEXT ? this.u8.subarray(0, MAX_TEXT) : this.u8);
      text = text.replace(/\r\n?/g, '\n');
      this.plain = text;
      const pre = document.createElement('pre');
      pre.textContent = text;
      this.body.className = 'docbody reflow ' + (kind === 'text' ? 'text' : 'paper plain');
      this.body.replaceChildren(pre);
      if (kind === 'doc' || kind === 'rtf') {
        const note = document.createElement('div');
        note.className = 'plainnote';
        note.textContent = t('textOnly');
        this.body.prepend(note);
      }
      if (this.u8.length > MAX_TEXT) this.ui.toast(t('textCut'));
      const lines = text.split('\n').length;
      sub = t('lines', { n: lines.toLocaleString() });
    }
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.applyZoom();
    return { sub };
  }

  async renderDocx() {
    const docx = await docxPreview();
    const opts = {
      ...DOCX_OPTS,
      inWrapper: true,
      ignoreWidth: this.reflow,
      ignoreHeight: this.reflow,
      breakPages: !this.reflow,
      useBase64URL: false,
    };
    this.body.className = 'docbody docxhost ' + (this.reflow ? 'reflow' : 'pages');
    this.body.innerHTML = '';
    this.body.style.zoom = '';
    this.body.style.width = '';
    await docx.renderAsync(this.u8.slice().buffer, this.body, this.body, opts);
    fixDocx(this.body);
    this.natW = 0;
    if (!this.reflow) {
      const w = this.body.querySelector('.docx-wrapper');
      this.natW = w ? w.scrollWidth : this.body.scrollWidth;
    }
  }

  applyZoom() {
    const W = this.scroller.clientWidth;
    if (this.reflow) {
      this.body.style.zoom = this.zoom;
      this.body.style.width = (W / this.zoom) + 'px';
    } else {
      const fit = this.natW ? Math.min(1, W / this.natW) : 1;
      this.body.style.zoom = fit * this.zoom;
      this.body.style.width = '';
    }
  }

  canToggleMode() { return this.kind === 'docx'; }

  async toggleMode() {
    this.reflow = !this.reflow;
    try { localStorage.setItem('vv.docxMode', this.reflow ? 'read' : 'page'); } catch {}
    this.zoom = 1;
    await this.renderDocx();
    this.scroller.scrollTop = 0;
    this.applyZoom();
  }

  async officeMeta() {
    try {
      const JSZip = await jszip();
      const zip = await JSZip.loadAsync(this.u8);
      const read = async n => { const f = zip.file(n); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
      const core = await read('docProps/core.xml');
      const app = await read('docProps/app.xml');
      const g = (d, tag) => d?.getElementsByTagNameNS('*', tag)[0]?.textContent || '';
      const ts = s => (s ? Date.parse(s) || null : null);
      return {
        title: g(core, 'title'), author: g(core, 'creator') || g(core, 'lastModifiedBy'),
        created: ts(g(core, 'created')), modified: ts(g(core, 'modified')),
        producer: g(app, 'Application'), pages: +g(app, 'Pages') || 0,
      };
    } catch { return {}; }
  }

  info() { return this.meta || {}; }

  /** Eigenständiges HTML für den Druck (schwarz auf weiß, ohne App-Oberfläche). */
  async printHtml(title) {
    let body, css = '';
    if (this.kind === 'docx') {
      const docx = await docxPreview();
      const host = document.createElement('div');
      await docx.renderAsync(this.u8.slice().buffer, host, host, {
        ...DOCX_OPTS, inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: true, useBase64URL: true,
      });
      fixDocx(host);
      body = host.innerHTML;
      css = 'section.docx{padding:0!important;width:auto!important;min-height:0!important;box-shadow:none!important;margin:0!important}' +
        'section.docx+section.docx{break-before:page}';
    } else if (this.kind === 'odt') {
      body = this.body.innerHTML;
      css = ODT_PRINT_CSS;
    } else {
      body = `<pre>${esc(this.plain || '')}</pre>`;
      css = this.kind === 'text'
        ? 'pre{white-space:pre-wrap;word-break:break-word;font:9.5pt/1.4 monospace;margin:0}'
        : 'pre{white-space:pre-wrap;word-break:break-word;font:11pt/1.5 sans-serif;margin:0}';
    }
    return printPage(title, css, body);
  }

  close() {
    this.kind = null;
    this.u8 = null;
    this.plain = null;
    this.body.innerHTML = '';
    this.body.style.zoom = '';
    this.body.style.width = '';
  }
}

// Word-Aufzählungszeichen aus „Symbol“/„Wingdings“ (Private-Use-Bereich) → echte Unicode-Zeichen,
// denn diese Schriften gibt es auf Android nicht.
const PUA = { '': '•', '': '▪', '': '▫', '': '➢', '': '❖', '': '✔', '': '→', '': '○', '': '■', '': '❑', '': '○', '': '◆' };
function fixDocx(root) {
  for (const st of root.querySelectorAll('style')) {
    const s = st.textContent;
    if (/[-]/.test(s)) st.textContent = s.replace(/[-]/g, c => PUA[c] || '•');
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/[-]/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/[-]/g, c => PUA[c] || '•');
  }
  // Nur verlinkte (nicht eingebettete) Bilder lassen sich nicht laden → ausblenden
  // (docx-preview setzt src teils erst nach dem Rendern → per Fehler-Ereignis entfernen)
  for (const img of root.querySelectorAll('img')) {
    img.addEventListener('error', () => img.remove(), { once: true });
    if (img.complete && img.getAttribute('src') && img.naturalWidth === 0) img.remove();
  }
}

const ODT_PRINT_CSS =
  'table{border-collapse:collapse;max-width:100%}td{padding:2pt 4pt;vertical-align:top}' +
  'img{max-width:100%;height:auto}.tab{display:inline-block;width:2em}.fnsep{margin-top:2em}' +
  '.fnlist{font-size:.85em}h1,h2,h3{break-after:avoid}p{margin:0 0 .5em}';

export function printPage(title, css, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>` +
    '@page{margin:14mm 12mm}html,body{margin:0;padding:0;background:#fff;color:#000}' +
    'body{font:11pt/1.45 sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    css + `</style></head><body>${body}</body></html>`;
}
