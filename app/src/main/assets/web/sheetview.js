import { t, lang } from './i18n.js';
import { attachZoom } from './zoom.js';

const CHUNK = 400;   // Zeilen je Nachlade-Schritt
const MAX_COLS = 400;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
async function lib() {
  if (!window.XLSX) await loadScript(new URL('./lib/xlsx/xlsx.full.min.js', import.meta.url).href);
  return window.XLSX;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function decodeText(u8) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { return new TextDecoder('windows-1252').decode(u8); }
}

export class SheetView {
  constructor(section, ui) {
    this.sec = section;
    this.ui = ui;
    this.scroller = section.querySelector('.scroller');
    this.table = section.querySelector('.grid');
    this.tabs = section.querySelector('.tabs');
    this.bar = section.querySelector('.cellbar');
    this.wb = null;
    this.zoom = 1;
    this.sel = null;
    this.scrollPos = {};

    attachZoom(this.scroller, this.table, {
      get: () => this.zoom,
      apply: z => { this.zoom = z; this.table.style.setProperty('--z', z); },
      min: 0.4, max: 3, dbl: 1.8,
    });

    this.table.addEventListener('click', e => {
      const td = e.target.closest('td[data-r]');
      if (td) this.select(td);
      else if (e.target.closest('tr.more')) this.renderMore();
    });
    this.scroller.addEventListener('scroll', () => {
      const s = this.scroller;
      if (this.cur && this.cur.next < this.cur.rowsVis.length && s.scrollTop + s.clientHeight > s.scrollHeight - 600) this.renderMore();
    }, { passive: true });
    this.tabs.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]');
      if (b) this.show(+b.dataset.i);
    });
  }

  async open(buf, name, mime) {
    const X = await lib();
    const u8 = new Uint8Array(buf);
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
    const isOle = u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0;
    const textLike = !isZip && !isOle && (['csv', 'tsv', 'txt'].includes(ext) || /^text\//.test(mime || ''));
    let wb;
    if (textLike) {
      wb = X.read(decodeText(u8), { type: 'string', raw: true, dense: true });
      this.isText = true;
    } else {
      // cellStyles: nötig für Spaltenbreiten, ausgeblendete Zeilen/Spalten und Zahlenformate
      wb = X.read(u8, { type: 'array', dense: true, cellFormula: true, cellHTML: false, cellStyles: true, cellNF: true });
      this.isText = false;
    }
    this.X = X;
    this.wb = wb;
    const meta = wb.Workbook?.Sheets || [];
    let list = wb.SheetNames.map((n, i) => ({ i, name: n, hidden: !!meta[i]?.Hidden }));
    if (list.every(s => s.hidden)) list.forEach(s => (s.hidden = false));
    this.list = list.filter(s => !s.hidden);
    this.scrollPos = {};
    this.zoom = 1;
    this.table.style.setProperty('--z', 1);
    this.tabs.innerHTML = this.list.map((s, k) => `<button data-i="${k}">${esc(s.name)}</button>`).join('');
    const active = Math.max(0, this.list.findIndex(s => s.i === (wb.Workbook?.WBView?.[0]?.activeTab ?? 0)));
    this.show(active);
    return { sheets: this.list.length };
  }

  show(k) {
    if (this.cur) this.scrollPos[this.cur.k] = [this.scroller.scrollLeft, this.scroller.scrollTop];
    const X = this.X;
    const s = this.list[k];
    const ws = this.wb.Sheets[s.name];
    [...this.tabs.children].forEach((b, j) => b.classList.toggle('on', j === k));
    this.tabs.children[k]?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.bar.hidden = true;
    this.sel = null;

    const data = ws?.['!data'] || [];
    let maxR = data.length, maxC = 0;
    for (const row of data) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        const cell = row[c];
        if (cell && (cell.v !== undefined && cell.v !== '' || cell.f)) { if (c + 1 > maxC) maxC = c + 1; break; }
      }
    }
    // leere Zeilen am Ende abschneiden
    while (maxR > 0 && !(data[maxR - 1] || []).some(c => c && (c.v !== undefined && c.v !== '' || c.f))) maxR--;
    const merges = ws?.['!merges'] || [];
    for (const m of merges) {
      if (m.e.r + 1 > maxR && m.s.r < maxR) maxR = Math.min(m.e.r + 1, maxR + 50);
      if (m.e.c + 1 > maxC && m.s.c < maxC) maxC = m.e.c + 1;
    }
    const cut = maxC > MAX_COLS;
    maxC = Math.min(maxC, MAX_COLS);

    if (maxR === 0 || maxC === 0) {
      this.table.innerHTML = `<tbody><tr><td class="empty-cell">${esc(t('emptySheet'))}</td></tr></tbody>`;
      this.cur = null;
      return;
    }

    const rowsMeta = ws['!rows'] || [], colsMeta = ws['!cols'] || [];
    const colsVis = [], rowsVis = [];
    for (let c = 0; c < maxC; c++) if (!colsMeta[c]?.hidden) colsVis.push(c);
    for (let r = 0; r < maxR; r++) if (!rowsMeta[r]?.hidden) rowsVis.push(r);

    // Verbundene Zellen
    const mStart = new Map(), covered = new Set();
    for (const m of merges) {
      let rs = 0, cs = 0;
      for (let r = m.s.r; r <= m.e.r; r++) if (!rowsMeta[r]?.hidden) rs++;
      for (let c = m.s.c; c <= m.e.c; c++) if (!colsMeta[c]?.hidden) cs++;
      mStart.set(m.s.r * 16384 + m.s.c, [rs, cs]);
      for (let r = m.s.r; r <= m.e.r; r++)
        for (let c = m.s.c; c <= m.e.c; c++)
          if (r !== m.s.r || c !== m.s.c) covered.add(r * 16384 + c);
    }

    // Spaltenbreiten: aus der Datei, sonst nach Inhalt (erste 200 Zeilen, ohne verbundene Zellen)
    const widths = colsVis.map(c => {
      const m = colsMeta[c];
      if (!this.isText && m && (m.wpx || m.wch || m.width)) {
        // Excel-Breite (Zeichen) in Pixel wie bei Calibri 11 / 100 %
        const px = m.width ? m.width * 7 + 5 : m.wpx || m.wch * 7 + 5;
        return Math.max(24, Math.min(600, Math.round(px)));
      }
      let len = 0;
      for (let r = 0; r < Math.min(maxR, 200); r++) {
        const cell = data[r]?.[c];
        if (!cell || mStart.has(r * 16384 + c) && mStart.get(r * 16384 + c)[1] > 1) continue;
        len = Math.max(len, this.text(cell).length);
      }
      return Math.max(48, Math.min(320, Math.round(len * 7.6 + 22)));
    });

    const rhW = Math.max(36, String(maxR).length * 9 + 18);
    let head = `<colgroup><col style="width:calc(${rhW}px * var(--z))">` +
      widths.map(w => `<col style="width:calc(${w}px * var(--z))">`).join('') + '</colgroup>';
    head += '<thead><tr><th class="corner"></th>' + colsVis.map(c => `<th>${X.utils.encode_col(c)}</th>`).join('') + '</tr></thead>';
    this.table.style.tableLayout = 'fixed';
    this.table.style.width = 'calc(' + (rhW + widths.reduce((a, b) => a + b, 0)) + 'px * var(--z))';
    this.table.innerHTML = head + '<tbody></tbody>';
    this.cur = { k, ws, data, colsVis, rowsVis, mStart, covered, next: 0, tbody: this.table.tBodies[0], cut };
    this.renderMore();
    const pos = this.scrollPos[k] || [0, 0];
    this.scroller.scrollLeft = pos[0];
    this.scroller.scrollTop = pos[1];
    if (cut) this.ui.toast(t('colsCut', { n: MAX_COLS }));
  }

  renderMore() {
    const C = this.cur;
    if (!C) return;
    C.tbody.querySelector('tr.more')?.remove();
    const end = Math.min(C.rowsVis.length, C.next + CHUNK);
    let html = '';
    for (let k = C.next; k < end; k++) {
      const r = C.rowsVis[k];
      const row = C.data[r] || [];
      html += `<tr><th>${r + 1}</th>`;
      for (const c of C.colsVis) {
        const key = r * 16384 + c;
        if (C.covered.has(key)) continue;
        const cell = row[c];
        const span = C.mStart.get(key);
        let attr = ` data-r="${r}" data-c="${c}"`;
        if (span) {
          const rs = Math.min(span[0], end - k);
          if (rs > 1) attr += ` rowspan="${rs}"`;
          if (span[1] > 1) attr += ` colspan="${span[1]}"`;
        }
        if (!cell) { html += `<td${attr}></td>`; continue; }
        const numText = this.isText && typeof cell.v === 'string' && /^[-+]?(\d{1,3}([.,]\d{3})*|\d+)([.,]\d+)?\s?(%|€|EUR)?$/.test(cell.v.trim());
        const cls = cell.t === 'n' || cell.t === 'd' || numText ? 'n' : cell.t === 'b' ? 'b' : cell.t === 'e' ? 'e' : '';
        html += `<td${attr}${cls ? ` class="${cls}"` : ''}>${esc(this.text(cell))}</td>`;
      }
      html += '</tr>';
    }
    C.tbody.insertAdjacentHTML('beforeend', html);
    C.next = end;
    if (C.next < C.rowsVis.length) {
      C.tbody.insertAdjacentHTML('beforeend',
        `<tr class="more"><th></th><td colspan="${C.colsVis.length}">${esc(t('moreRows', { n: (C.rowsVis.length - C.next).toLocaleString(lang) }))}</td></tr>`);
    }
  }

  /** Anzeige-Text einer Zelle, an deutsche Schreibweise angepasst. */
  text(cell) {
    // Formel ohne gespeichertes Ergebnis (z. B. von Skripten erzeugt) → Formel zeigen
    if (cell.t === 'z' || cell.v === undefined || cell.v === null) return cell.f ? '=' + cell.f : '';
    const X = this.X;
    if (cell.t === 'b') return cell.v ? (lang === 'de' ? 'WAHR' : 'TRUE') : (lang === 'de' ? 'FALSCH' : 'FALSE');
    if (cell.t === 'n' && !this.isText) {
      const z = String(cell.z || '');
      const zl = z.toLowerCase();
      let isDate = false;
      try { isDate = !!z && X.SSF.is_date(z); } catch {}
      if (isDate) {
        // Standard-Datumsformate (Nr. 14/22) sind in Excel länderabhängig
        if (['m/d/yy', 'm/d/yyyy', 'mm/dd/yyyy', 'm/d/yy h:mm', 'm/d/yyyy h:mm'].includes(zl)) {
          const d = X.SSF.parse_date_code(cell.v);
          if (d) {
            const date = new Date(d.y, d.m - 1, d.d, d.H, d.M);
            let s = date.toLocaleDateString(lang, { day: '2-digit', month: '2-digit', year: 'numeric' });
            if (zl.includes('h')) s += ' ' + date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
            return s;
          }
        }
        if (cell.w != null) return cell.w;
        // SheetJS scheitert an Punkten in Datumsformaten (dd.mm.yyyy) → Punkt als Literal
        try { return X.SSF.format(z.replace(/\.(?=(?:[^"]*"[^"]*")*[^"]*$)/g, '"."'), cell.v); } catch {}
        return String(cell.v);
      }
      const w = cell.w ?? String(cell.v);
      if (lang === 'de' && /\d/.test(w) && !/[\/:]/.test(w) && !/[a-df-z]/i.test(w.replace(/€|EUR/g, ''))) {
        // 1,234.56 → 1.234,56
        return w.replace(/[.,]/g, ch => (ch === '.' ? ',' : '.'));
      }
      return w;
    }
    return cell.w ?? String(cell.v);
  }

  select(td) {
    this.sel?.classList.remove('sel');
    if (this.sel === td) { this.sel = null; this.bar.hidden = true; return; }
    this.sel = td;
    td.classList.add('sel');
    const r = +td.dataset.r, c = +td.dataset.c;
    const cell = this.cur.data[r]?.[c];
    this.bar.querySelector('.addr').textContent = this.X.utils.encode_cell({ r, c });
    const val = this.bar.querySelector('.val');
    const txt = cell ? this.text(cell) : '';
    val.innerHTML = esc(txt) + (cell?.f && txt !== '=' + cell.f ? `<span class="f">=${esc(cell.f)}</span>` : '');
    this.bar.hidden = false;
  }

  info() {
    const p = this.wb?.Props || {};
    return {
      title: p.Title || '', author: p.Author || p.LastAuthor || '',
      created: p.CreatedDate ? new Date(p.CreatedDate).getTime() : null,
      modified: p.ModifiedDate ? new Date(p.ModifiedDate).getTime() : null,
      producer: p.Application || '',
    };
  }

  close() {
    this.wb = null;
    this.cur = null;
    this.table.innerHTML = '';
    this.tabs.innerHTML = '';
    this.bar.hidden = true;
  }
}
