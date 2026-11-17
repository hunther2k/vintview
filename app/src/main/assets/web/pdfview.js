import { t } from './i18n.js';
import { attachZoom } from './zoom.js';

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import('./lib/pdfjs/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return pdfjs;
}

const GAP = 8;            // Rand links/rechts in CSS-Pixeln
const MAX_BASE = 1000;    // maximale Seitenbreite bei Zoom 1 (Tablet/PC)
const MAX_PIXELS = 12e6;  // Obergrenze Canvas-Pixel je Seite

export class PdfView {
  constructor(section, ui) {
    this.sec = section;
    this.ui = ui;
    this.scroller = section.querySelector('.scroller');
    this.wrap = section.querySelector('.pages');
    this.ind = section.querySelector('.pageind');
    this.doc = null;
    this.zoom = 1;
    this.pages = [];
    this.queue = new Set();
    this.rendering = false;
    this.gen = 0;

    this.zoomer = attachZoom(this.scroller, this.wrap, {
      get: () => this.zoom,
      apply: z => this.setZoom(z),
      min: 0.5, max: 6, dbl: 2.5,
    });

    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const p = this.pages[+e.target.dataset.i];
        if (!p) continue;
        p.visible = e.isIntersecting;
        if (e.isIntersecting) this.queue.add(p.i);
        else { this.queue.delete(p.i); this.freePage(p); }
      }
      this.pump();
    }, { root: this.scroller, rootMargin: '120% 0px' });

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.ind.addEventListener('click', () => this.ui.goToPage());
    new ResizeObserver(() => { if (this.doc) this.layout(); }).observe(this.scroller);
  }

  async open(data, askPassword) {
    const lib_ = await lib();
    const task = lib_.getDocument({
      data,
      cMapUrl: new URL('./lib/pdfjs/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('./lib/pdfjs/standard_fonts/', import.meta.url).href,
      isEvalSupported: false,
      enableXfa: false,
    });
    task.onPassword = async (update, reason) => {
      const pw = await askPassword(reason === lib_.PasswordResponses.INCORRECT_PASSWORD);
      if (pw == null) task.destroy(); else update(pw);
    };
    const doc = await task.promise;
    this.doc = doc;
    this.gen++;
    this.zoom = 1;
    const first = await doc.getPage(1);
    const v = first.getViewport({ scale: 1 });
    const ratio = v.height / v.width;
    this.wrap.innerHTML = '';
    this.pages = [];
    for (let i = 0; i < doc.numPages; i++) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.i = i;
      el.innerHTML = `<span class="num">${i + 1}</span>`;
      this.wrap.appendChild(el);
      this.pages.push({ i, el, ratio, canvas: null, zoom: 0, visible: false, task: null });
    }
    this.pages[0].ratio = ratio;
    this.layout();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
    this.pages.forEach(p => this.io.observe(p.el));
    this.loadRatios(this.gen);
    return { pages: doc.numPages };
  }

  /** Seitenformate im Hintergrund nachladen (Querformat, gemischte Größen). */
  async loadRatios(gen) {
    let changed = false;
    for (let i = 1; i < this.pages.length && gen === this.gen; i++) {
      try {
        const pg = await this.doc.getPage(i + 1);
        const v = pg.getViewport({ scale: 1 });
        const r = v.height / v.width;
        if (Math.abs(r - this.pages[i].ratio) > 0.001) { this.pages[i].ratio = r; changed = true; }
      } catch { /* Seite defekt – Platzhalter bleibt */ }
      if (changed && (i % 20 === 0 || i === this.pages.length - 1)) { this.layout(true); changed = false; }
    }
    if (changed && gen === this.gen) this.layout(true);
  }

  base() {
    return Math.min(MAX_BASE, Math.max(100, this.scroller.clientWidth - 2 * GAP));
  }

  /** Seitengrößen setzen. keepAnchor: Leseposition beim Nachladen der Formate halten. */
  layout(keepAnchor = false) {
    const cur = keepAnchor ? this.currentPage() : -1;
    const off = cur >= 0 ? this.scroller.scrollTop - this.pages[cur].el.offsetTop : 0;
    const w = Math.round(this.base() * this.zoom);
    this.wrap.style.padding = `${GAP}px ${GAP}px 24px`;
    for (const p of this.pages) {
      p.el.style.width = w + 'px';
      p.el.style.height = Math.round(w * p.ratio) + 'px';
    }
    if (cur >= 0) this.scroller.scrollTop = this.pages[cur].el.offsetTop + off;
    for (const p of this.pages) if (p.visible && p.zoom !== this.zoom) this.queue.add(p.i);
    this.pump();
  }

  setZoom(z) {
    this.zoom = z;
    this.layout();
  }

  async pump() {
    if (this.rendering || !this.doc) return;
    this.rendering = true;
    const gen = this.gen;
    try {
      while (this.queue.size && gen === this.gen) {
        // Seite nahe der Bildschirmmitte zuerst
        const mid = this.scroller.scrollTop + this.scroller.clientHeight / 2;
        let best = null, bd = Infinity;
        for (const i of this.queue) {
          const el = this.pages[i].el;
          const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid);
          if (d < bd) { bd = d; best = i; }
        }
        this.queue.delete(best);
        const p = this.pages[best];
        if (p.visible && p.zoom !== this.zoom) await this.renderPage(p, gen);
      }
    } finally {
      this.rendering = false;
    }
  }

  async renderPage(p, gen) {
    const zoom = this.zoom;
    try {
      const page = await this.doc.getPage(p.i + 1);
      if (gen !== this.gen) return;
      const v1 = page.getViewport({ scale: 1 });
      const cssW = this.base() * zoom;
      const dpr = window.devicePixelRatio || 1;
      let scale = (cssW / v1.width) * dpr;
      if (v1.width * v1.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (v1.width * v1.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d', { alpha: false });
      p.task = page.render({ canvasContext: ctx, viewport: vp });
      await p.task.promise;
      p.task = null;
      if (gen !== this.gen) return;
      if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
      p.canvas = c;
      p.el.appendChild(c);
      p.zoom = zoom;
      if (Math.abs(vp.height / vp.width - p.ratio) > 0.001) { p.ratio = vp.height / vp.width; this.layout(true); }
      if (zoom !== this.zoom && p.visible) this.queue.add(p.i);
    } catch (e) {
      p.task = null;
      if (e?.name !== 'RenderingCancelledException') console.warn('Seite', p.i + 1, e);
    }
  }

  freePage(p) {
    if (p.task) { try { p.task.cancel(); } catch {} p.task = null; }
    if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); p.canvas = null; }
    p.zoom = 0;
  }

  currentPage() {
    const y = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let lo = 0, hi = this.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.pages[m].el.offsetTop <= y) lo = m; else hi = m - 1;
    }
    return lo;
  }

  onScroll() {
    if (!this.doc || this.pages.length < 2) return;
    this.ind.hidden = false;
    this.ind.classList.remove('fade');
    this.ind.textContent = t('pageOf', { a: this.currentPage() + 1, b: this.pages.length });
    clearTimeout(this.fadeT);
    this.fadeT = setTimeout(() => this.ind.classList.add('fade'), 1600);
  }

  goTo(n) {
    const p = this.pages[Math.min(this.pages.length, Math.max(1, n)) - 1];
    if (p) this.scroller.scrollTop = p.el.offsetTop - GAP;
  }

  async info() {
    if (!this.doc) return {};
    try {
      const m = await this.doc.getMetadata();
      const i = m.info || {};
      const d = s => { try { return lib_date(s); } catch { return null; } };
      return {
        title: i.Title || '', author: i.Author || '', producer: i.Producer || i.Creator || '',
        created: d(i.CreationDate), modified: d(i.ModDate),
      };
    } catch { return {}; }
  }

  close() {
    this.gen++;
    this.queue.clear();
    this.pages.forEach(p => { this.io.unobserve(p.el); this.freePage(p); });
    this.pages = [];
    this.wrap.innerHTML = '';
    this.ind.hidden = true;
    if (this.doc) { this.doc.destroy(); this.doc = null; }
  }
}

function lib_date(s) {
  if (!s || !pdfjs) return null;
  const d = pdfjs.PDFDateString.toDateObject(s);
  return d ? d.getTime() : null;
}
