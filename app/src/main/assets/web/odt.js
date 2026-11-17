// OpenDocument Text (.odt/.ott) → HTML.
// Liest content.xml + styles.xml aus dem ZIP und baut daraus schlichtes,
// semantisches HTML (Überschriften, Absätze, Listen, Tabellen, Bilder, Fußnoten).

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const attr = (el, ns, name) => el.getAttributeNS(NS[ns], name) ?? el.getAttribute(ns + ':' + name);

function parseXml(s) {
  const d = new DOMParser().parseFromString(s, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('XML');
  return d;
}

/** Stil-Tabelle: Name → { css, parent, family, list } */
function readStyles(docs) {
  const map = new Map();
  const lists = new Map();
  for (const d of docs) {
    if (!d) continue;
    for (const st of d.getElementsByTagNameNS(NS.style, 'style')) {
      const name = attr(st, 'style', 'name');
      const css = [];
      for (const p of st.children) {
        const ln = p.localName;
        if (ln === 'text-properties') {
          const fw = attr(p, 'fo', 'font-weight'); if (fw && fw !== 'normal') css.push('font-weight:' + fw);
          const fs = attr(p, 'fo', 'font-style'); if (fs && fs !== 'normal') css.push('font-style:' + fs);
          const ul = attr(p, 'style', 'text-underline-style'); if (ul && ul !== 'none') css.push('text-decoration:underline');
          const lt = attr(p, 'style', 'text-line-through-style'); if (lt && lt !== 'none') css.push('text-decoration:line-through');
          const col = attr(p, 'fo', 'color'); if (col) css.push('color:' + col);
          const bg = attr(p, 'fo', 'background-color'); if (bg && bg !== 'transparent') css.push('background-color:' + bg);
          const sz = attr(p, 'fo', 'font-size'); if (sz && !sz.endsWith('%')) css.push('font-size:' + sz);
          const pos = attr(p, 'style', 'text-position'); if (pos) css.push(pos.startsWith('super') ? 'vertical-align:super;font-size:.75em' : pos.startsWith('sub') ? 'vertical-align:sub;font-size:.75em' : '');
        } else if (ln === 'paragraph-properties') {
          const ta = attr(p, 'fo', 'text-align');
          if (ta) css.push('text-align:' + ({ start: 'left', end: 'right' }[ta] || ta));
          const ml = attr(p, 'fo', 'margin-left'); if (ml && parseFloat(ml) > 0) css.push('margin-left:' + ml);
          const ti = attr(p, 'fo', 'text-indent'); if (ti && parseFloat(ti) !== 0) css.push('text-indent:' + ti);
          const bg = attr(p, 'fo', 'background-color'); if (bg && bg !== 'transparent') css.push('background-color:' + bg);
          const bk = attr(p, 'fo', 'break-before'); if (bk === 'page') css.push('break-before:page');
        } else if (ln === 'table-cell-properties') {
          const bg = attr(p, 'fo', 'background-color'); if (bg && bg !== 'transparent') css.push('background-color:' + bg);
          const va = attr(p, 'style', 'vertical-align'); if (va) css.push('vertical-align:' + va);
          for (const side of ['border', 'border-top', 'border-bottom', 'border-left', 'border-right']) {
            const b = attr(p, 'fo', side); if (b) css.push(side + ':' + (b === 'none' ? 'none' : b.replace(/(\d+(\.\d+)?)(pt|cm|mm|in)/, (m, n, _, u) => Math.max(0.5, parseFloat(n)) + u)));
          }
        } else if (ln === 'table-column-properties') {
          const w = attr(p, 'style', 'column-width'); if (w) css.push('width:' + w);
        } else if (ln === 'table-properties') {
          const w = attr(p, 'style', 'width'); if (w) css.push('max-width:100%');
        }
      }
      map.set(name, {
        // Werte aus fremden Dateien: nichts, was nachlädt oder weitere Regeln einschleust
        css: css.filter(s => s && !/url\s*\(|expression|@import|[;{}<>"\\]/i.test(s)).join(';'),
        parent: attr(st, 'style', 'parent-style-name'),
        family: attr(st, 'style', 'family'),
        list: attr(st, 'style', 'list-style-name'),
      });
    }
    for (const ls of d.getElementsByTagNameNS(NS.text, 'list-style')) {
      const levels = [];
      for (const lv of ls.children) {
        const n = +attr(lv, 'text', 'level') || 1;
        levels[n] = lv.localName === 'list-level-style-number' ? (attr(lv, 'style', 'num-format') || '1') : '';
      }
      lists.set(attr(ls, 'style', 'name'), levels);
    }
  }
  return { map, lists };
}

export async function odtToHtml(zip) {
  const content = parseXml(await zip.file('content.xml').async('string'));
  const stylesF = zip.file('styles.xml');
  const styles = stylesF ? parseXml(await stylesF.async('string')) : null;
  const { map, lists } = readStyles([styles, content]);
  const imgCache = new Map();
  const notes = [];

  const cssOf = name => {
    const parts = [];
    let n = name, guard = 0;
    while (n && map.has(n) && guard++ < 20) { const s = map.get(n); if (s.css) parts.unshift(s.css); n = s.parent; }
    return parts.join(';');
  };
  const styleAttr = name => { const c = cssOf(name); return c ? ` style="${esc(c)}"` : ''; };

  async function image(href) {
    if (!href || /^https?:/.test(href)) return '';
    if (imgCache.has(href)) return imgCache.get(href);
    const f = zip.file(href.replace(/^\.\//, ''));
    if (!f) return '';
    const b64 = await f.async('base64');
    const ext = href.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', webp: 'image/webp' }[ext];
    const url = mime ? `data:${mime};base64,${b64}` : '';
    imgCache.set(href, url);
    return url;
  }

  async function kids(el, ctx) {
    let h = '';
    for (const n of el.childNodes) h += await node(n, ctx);
    return h;
  }

  async function node(n, ctx) {
    if (n.nodeType === 3) return esc(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const ns = n.namespaceURI, ln = n.localName;
    if (ns === NS.text) {
      switch (ln) {
        case 'p': {
          const inner = await kids(n, ctx);
          return `<p${styleAttr(attr(n, 'text', 'style-name'))}>${inner || '<br>'}</p>`;
        }
        case 'h': {
          const lvl = Math.min(6, Math.max(1, +attr(n, 'text', 'outline-level') || 1));
          return `<h${lvl}${styleAttr(attr(n, 'text', 'style-name'))}>${await kids(n, ctx)}</h${lvl}>`;
        }
        case 'span': return `<span${styleAttr(attr(n, 'text', 'style-name'))}>${await kids(n, ctx)}</span>`;
        case 'a': {
          const href = attr(n, 'xlink', 'href') || '';
          const safe = /^(https?:|mailto:|tel:)/i.test(href) ? href : '';
          return safe ? `<a href="${esc(safe)}">${await kids(n, ctx)}</a>` : await kids(n, ctx);
        }
        case 'line-break': return '<br>';
        case 'tab': return '<span class="tab"></span>';
        case 's': return '&nbsp;'.repeat(Math.min(200, +attr(n, 'text', 'c') || 1));
        case 'list': {
          const sname = attr(n, 'text', 'style-name') || ctx.list;
          const level = (ctx.level || 0) + 1;
          const fmt = lists.get(sname)?.[level];
          const tag = fmt ? 'ol' : 'ul';
          const type = fmt && fmt !== '1' ? ` type="${esc(fmt)}"` : '';
          let h = '';
          for (const it of n.children) {
            if (it.localName === 'list-item' || it.localName === 'list-header') {
              h += `<li${it.localName === 'list-header' ? ' class="lh"' : ''}>${await kids(it, { ...ctx, list: sname, level })}</li>`;
            }
          }
          return `<${tag}${type}>${h}</${tag}>`;
        }
        case 'note': {
          const cit = n.getElementsByTagNameNS(NS.text, 'note-citation')[0]?.textContent || String(notes.length + 1);
          const body = n.getElementsByTagNameNS(NS.text, 'note-body')[0];
          notes.push({ cit, html: body ? await kids(body, ctx) : '' });
          return `<sup class="fn">${esc(cit)}</sup>`;
        }
        case 'table-of-content': case 'alphabetical-index': case 'illustration-index': case 'table-index': case 'bibliography': case 'user-index': {
          const body = n.getElementsByTagNameNS(NS.text, 'index-body')[0];
          return body ? `<div class="toc">${await kids(body, ctx)}</div>` : '';
        }
        case 'index-title': case 'section': return `<div>${await kids(n, ctx)}</div>`;
        case 'sequence-decls': case 'variable-decls': case 'user-field-decls': case 'tracked-changes':
        case 'bookmark': case 'bookmark-start': case 'bookmark-end': case 'soft-page-break':
        case 'reference-mark-start': case 'reference-mark-end': case 'alphabetical-index-mark':
          return '';
        default: return await kids(n, ctx);
      }
    }
    if (ns === NS.table) {
      switch (ln) {
        case 'table': {
          let cols = '', rows = '';
          for (const c of n.children) {
            if (c.localName === 'table-columns' || c.localName === 'table-column-group') {
              for (const col of c.children) if (col.localName === 'table-column') cols += colTag(col);
            } else if (c.localName === 'table-column') cols += colTag(c);
            else if (c.localName === 'table-header-rows' || c.localName === 'table-rows' || c.localName === 'table-row-group') {
              for (const r of c.children) if (r.localName === 'table-row') rows += await row(r, ctx);
            } else if (c.localName === 'table-row') rows += await row(c, ctx);
          }
          return `<table${styleAttr(attr(n, 'table', 'style-name'))}>${cols ? `<colgroup>${cols}</colgroup>` : ''}${rows}</table>`;
        }
        default: return await kids(n, ctx);
      }
    }
    if (ns === NS.draw) {
      switch (ln) {
        case 'frame': {
          const img = n.getElementsByTagNameNS(NS.draw, 'image')[0];
          const box = n.getElementsByTagNameNS(NS.draw, 'text-box')[0];
          if (box) return `<div class="tbox">${await kids(box, ctx)}</div>`;
          if (img) {
            const url = await image(attr(img, 'xlink', 'href'));
            const w = attr(n, 'svg', 'width');
            return url ? `<img src="${url}" style="${w ? 'width:' + esc(w) + ';' : ''}max-width:100%;height:auto">` : '';
          }
          return '';
        }
        default: return '';
      }
    }
    if (ns === NS.office && (ln === 'annotation' || ln === 'annotation-end')) return '';
    return await kids(n, ctx);
  }

  function colTag(col) {
    const rep = Math.min(100, +attr(col, 'table', 'number-columns-repeated') || 1);
    const s = styleAttr(attr(col, 'table', 'style-name'));
    return `<col${s}>`.repeat(rep);
  }

  async function row(r, ctx) {
    const rep = Math.min(50, +attr(r, 'table', 'number-rows-repeated') || 1);
    let h = '';
    for (const c of r.children) {
      if (c.localName === 'covered-table-cell') continue;
      if (c.localName !== 'table-cell') continue;
      const crep = Math.min(50, +attr(c, 'table', 'number-columns-repeated') || 1);
      const cs = +attr(c, 'table', 'number-columns-spanned') || 1;
      const rs = +attr(c, 'table', 'number-rows-spanned') || 1;
      const span = (cs > 1 ? ` colspan="${cs}"` : '') + (rs > 1 ? ` rowspan="${rs}"` : '');
      const inner = await kids(c, ctx);
      h += `<td${span}${styleAttr(attr(c, 'table', 'style-name'))}>${inner}</td>`.repeat(crep);
    }
    return `<tr>${h}</tr>`.repeat(rep);
  }

  const body = content.getElementsByTagNameNS(NS.office, 'text')[0];
  if (!body) throw new Error('ODT ohne Text');
  let html = await kids(body, {});
  if (notes.length) {
    html += '<hr class="fnsep"><ol class="fnlist">' + notes.map(n => `<li value="${parseInt(n.cit) || ''}">${n.html}</li>`).join('') + '</ol>';
  }
  return html;
}

/** Metadaten aus meta.xml */
export async function odtMeta(zip) {
  const f = zip.file('meta.xml');
  if (!f) return {};
  const d = parseXml(await f.async('string'));
  const get = (ns, n) => d.getElementsByTagNameNS(NS[ns], n)[0]?.textContent || '';
  const stat = d.getElementsByTagNameNS(NS.meta, 'document-statistic')[0];
  const ts = s => (s ? Date.parse(s) || null : null);
  return {
    title: get('dc', 'title'),
    author: get('meta', 'initial-creator') || get('dc', 'creator'),
    created: ts(get('meta', 'creation-date')),
    modified: ts(get('dc', 'date')),
    producer: get('meta', 'generator').split('/')[0],
    pages: stat ? +attr(stat, 'meta', 'page-count') || 0 : 0,
  };
}
