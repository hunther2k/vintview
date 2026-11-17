import { t, setLang, applyI18n, fmtSize, fmtDate, lang } from './i18n.js';
import { PdfView } from './pdfview.js';
import { SheetView } from './sheetview.js';

const A = window.Android || null;   // Brücke zur Android-App (fehlt im Browser)
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REPO = 'https://github.com/hunther2k/vintview';

setLang(A ? A.lang() : navigator.language);
applyI18n();
const VERSION = A ? A.version() : 'dev';
$('#verLabel').textContent = 'Version ' + VERSION;

const ICON = {
  open: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  openWith: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  page: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M10 13h5M12.5 10.5v5"/></svg>',
  update: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  about: '<svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const state = { doc: null, kind: null, meta: null, update: null, updState: 'idle' };
const pdf = new PdfView($('#pdf'), { toast, goToPage });
const sheet = new SheetView($('#sheet'), { toast });

// ---------------- Hilfen ----------------

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

function loading(on, msg) {
  $('#loading').hidden = !on;
  $('#loading .msg').textContent = msg || t('loading');
}

function closeOverlays() {
  const open = !$('#menu').hidden || !$('#dialog').hidden;
  $('#menu').hidden = true;
  if (!$('#dialog').hidden) { $('#dialog').hidden = true; dialog.resolve?.(null); }
  $('#scrim').hidden = true;
  return open;
}
$('#scrim').addEventListener('click', closeOverlays);

/** Einfacher Dialog. actions: [{label, value, primary, danger}] → Promise<value|null> */
function dialog({ title, html = '', input = null, actions }) {
  closeOverlays();
  const d = $('#dialog');
  d.innerHTML = `<h3>${esc(title)}</h3>${html}` +
    (input ? `<input type="${input.type || 'text'}" placeholder="${esc(input.placeholder || '')}" inputmode="${input.mode || 'text'}" autocomplete="off">` : '') +
    `<div class="actions">${actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  d.hidden = false;
  $('#scrim').hidden = false;
  const inp = d.querySelector('input');
  if (inp) setTimeout(() => inp.focus(), 50);
  return new Promise(res => {
    dialog.resolve = res;
    const finish = v => { dialog.resolve = null; d.hidden = true; $('#scrim').hidden = true; res(v); };
    d.querySelectorAll('.actions button').forEach(b => b.addEventListener('click', () => {
      const a = actions[+b.dataset.i];
      finish(a.value === '$input' ? inp.value : a.value);
    }));
    inp?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const p = actions.find(a => a.primary); finish(p?.value === '$input' ? inp.value : p?.value ?? null); }
    });
    d.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', e => {
      if (A) { e.preventDefault(); A.openUrl(a.href); }
    }));
  });
}

function menu(items) {
  closeOverlays();
  const m = $('#menu');
  m.innerHTML = items.map((it, i) => `<button data-i="${i}">${it.icon}<span>${esc(it.label)}</span>${it.badge ? `<span class="new">${esc(it.badge)}</span>` : ''}</button>`).join('');
  m.hidden = false;
  $('#scrim').hidden = false;
  m.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    closeOverlays();
    items[+b.dataset.i].run();
  }));
}

// ---------------- Zuletzt geöffnet ----------------

function getRecent() {
  try { return JSON.parse(localStorage.getItem('vv.recent') || '[]'); } catch { return []; }
}
function setRecent(list) {
  try { localStorage.setItem('vv.recent', JSON.stringify(list.slice(0, 20))); } catch {}
  renderRecent();
}
function addRecent(doc, kind) {
  if (!doc.persist || !doc.uri) return;
  const list = getRecent().filter(r => r.uri !== doc.uri);
  list.unshift({ uri: doc.uri, name: doc.name, size: doc.size, kind, ts: Date.now() });
  setRecent(list);
}
function removeRecent(uri, forget = true) {
  if (forget && A) A.forgetRecent(uri);
  setRecent(getRecent().filter(r => r.uri !== uri));
}
function renderRecent() {
  const list = getRecent();
  $('#recentWrap').hidden = !list.length;
  $('#recent').innerHTML = list.map((r, i) => `
    <li data-i="${i}">
      <span class="badge ${r.kind === 'pdf' ? 'pdf' : 'xls'}">${r.kind === 'pdf' ? 'PDF' : esc((r.name.split('.').pop() || 'XLS').slice(0, 4).toUpperCase())}</span>
      <div class="meta"><div class="fname">${esc(r.name)}</div><div class="info">${esc(fmtDate(r.ts))}${r.size > 0 ? ' · ' + esc(fmtSize(r.size)) : ''}</div></div>
      <button class="rm" data-rm="${i}" aria-label="x">${ICON.x}</button>
    </li>`).join('');
}
$('#recent').addEventListener('click', e => {
  const list = getRecent();
  const rm = e.target.closest('[data-rm]');
  if (rm) { removeRecent(list[+rm.dataset.rm].uri); return; }
  const li = e.target.closest('li');
  if (li && A) { loading(true); A.openRecent(list[+li.dataset.i].uri); }
});
$('#btnClearRecent').addEventListener('click', () => {
  getRecent().forEach(r => A && A.forgetRecent(r.uri));
  setRecent([]);
});

// ---------------- Dokument öffnen ----------------

function kindOf(u8, name, mime) {
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if ((mime || '').includes('pdf')) return 'pdf';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (['xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb', 'xls', 'ods', 'fods', 'csv', 'tsv', 'txt'].includes(ext)) return 'sheet';
  if (u8[0] === 0x50 && u8[1] === 0x4b) return 'sheet';
  if (u8[0] === 0xd0 && u8[1] === 0xcf) return 'sheet';
  if (/sheet|excel|csv|spreadsheet|tab-separated/.test(mime || '')) return 'sheet';
  return null;
}

async function openDoc(doc) {
  closeOverlays();
  loading(true);
  try {
    const res = await fetch(doc.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const kind = kindOf(u8, doc.name, doc.mime);
    if (!kind) throw Object.assign(new Error('format'), { code: 'format' });
    closeDoc();
    let sub;
    if (kind === 'pdf') {
      $('#pdf').hidden = false;
      const r = await pdf.open(u8, askPassword);
      sub = r.pages === 1 ? t('page1') : t('pages', { n: r.pages });
    } else {
      $('#sheet').hidden = false;
      const r = await sheet.open(buf, doc.name, doc.mime);
      sub = r.sheets === 1 ? t('sheet1') : t('sheets', { n: r.sheets });
    }
    state.doc = doc;
    state.kind = kind;
    $('#home').hidden = true;
    $('#title .name').textContent = doc.name;
    $('#title .sub').textContent = [kind === 'pdf' ? 'PDF' : (doc.name.split('.').pop() || '').toUpperCase(), sub, doc.size > 0 ? fmtSize(doc.size) : ''].filter(Boolean).join(' · ');
    $('#btnBack').hidden = false;
    $('#btnShare').hidden = !A || !doc.id;
    addRecent(doc, kind);
  } catch (e) {
    console.error(e);
    closeDoc();
    goHome();
    if (e?.name === 'PasswordException') return;
    toast(e?.code === 'format' ? t('errFormat') : /password|encrypt/i.test(e?.message || '') ? t('passwordTitle') + ' – ' + t('errOpen') : t('errOpen'));
  } finally {
    loading(false);
    if (doc.url.startsWith('blob:')) URL.revokeObjectURL(doc.url);
  }
}

async function askPassword(wrong) {
  loading(false);
  const pw = await dialog({
    title: t('passwordTitle'),
    html: `<p>${esc(wrong ? t('passwordWrong') : t('passwordText'))}</p>`,
    input: { type: 'password', placeholder: t('password') },
    actions: [{ label: t('cancel'), value: null }, { label: t('open'), value: '$input', primary: true }],
  });
  if (pw != null) loading(true);
  return pw;
}

function closeDoc() {
  pdf.close();
  sheet.close();
  $('#pdf').hidden = true;
  $('#sheet').hidden = true;
  state.doc = null;
  state.kind = null;
}

function goHome() {
  closeDoc();
  $('#home').hidden = false;
  $('#title .name').textContent = 'Vintview';
  $('#title .sub').textContent = '';
  $('#btnBack').hidden = true;
  $('#btnShare').hidden = true;
  renderRecent();
}

function pickFile() {
  if (A) A.pickFile();
  else $('#fileInput').click();
}
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) openDoc({ name: f.name, size: f.size, mime: f.type, url: URL.createObjectURL(f), persist: false });
});

async function goToPage() {
  if (state.kind !== 'pdf') return;
  const n = pdf.pages.length;
  const v = await dialog({
    title: t('goToPage').replace(' …', ''),
    input: { type: 'number', mode: 'numeric', placeholder: t('pageGo', { n }) },
    actions: [{ label: t('cancel'), value: null }, { label: t('ok'), value: '$input', primary: true }],
  });
  const p = parseInt(v, 10);
  if (p > 0) pdf.goTo(p);
}

async function showInfo() {
  const d = state.doc;
  if (!d) return;
  const m = state.kind === 'pdf' ? await pdf.info() : sheet.info();
  const rows = [
    [t('name'), d.name],
    [t('type'), $('#title .sub').textContent],
    [t('size'), d.size > 0 ? fmtSize(d.size) + ` (${d.size.toLocaleString(lang)} B)` : ''],
    [t('titleLbl'), m.title],
    [t('author'), m.author],
    [t('created'), m.created ? new Date(m.created).toLocaleString(lang) : ''],
    [t('modified'), m.modified ? new Date(m.modified).toLocaleString(lang) : ''],
    [t('producer'), m.producer],
  ].filter(r => r[1]);
  dialog({
    title: t('fileInfo'),
    html: `<dl>${rows.map(r => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>`,
    actions: [{ label: t('close'), value: null, primary: true }],
  });
}

function showDefaultHelp() {
  dialog({
    title: t('setDefault'),
    html: t('setDefaultHtml'),
    actions: [{ label: t('ok'), value: null, primary: true }],
  });
}

function showAbout() {
  dialog({
    title: 'Vintview ' + VERSION,
    html: `<p>${esc(t('aboutText'))}</p><p class="small">${esc(t('aboutLibs'))}</p>
      <p class="small"><a href="${REPO}">${esc(t('source'))}</a> · <a href="${REPO}/blob/main/THIRD_PARTY.md">${esc(t('licenses'))}</a></p>
      <p class="small">© 2026 Hunther2K · MIT</p>`,
    actions: [{ label: t('close'), value: null, primary: true }],
  });
}

// ---------------- Updates ----------------

function checkUpdates() {
  if (!A) { toast('Nur in der App'); return; }
  if (state.update) { showUpdate(); return; }
  toast(t('checkUpdates') + ' …', 1500);
  A.checkUpdate();
}

async function showUpdate() {
  const u = state.update;
  if (!u) return;
  const ok = await dialog({
    title: t('updateTitle', { v: u.version }),
    html: (u.notes?.trim() ? `<div class="notes">${esc(u.notes.trim())}</div>` : '') + (u.size > 0 ? `<p class="small" style="margin-top:10px">${esc(fmtSize(u.size))}</p>` : ''),
    actions: [{ label: t('updateLater'), value: false }, { label: t('updateInstall'), value: true, primary: true }],
  });
  if (ok) startUpdate();
}

function startUpdate() {
  if (!A || state.updState === 'downloading') return;
  A.installUpdate();
}

function updateCard() {
  const u = state.update;
  $('#updateCard').hidden = !u;
  $('#btnMenu .dot').hidden = !u;
  if (!u) return;
  $('#updateCard .u-ver').textContent = VERSION + ' → ' + u.version;
  const prog = $('#updateCard .progress');
  const btn = $('#btnUpdate');
  if (state.updState === 'downloading') {
    prog.hidden = false;
    btn.disabled = true;
    btn.textContent = (state.updProgress ?? 0) + ' %';
    prog.firstElementChild.style.width = (state.updProgress ?? 0) + '%';
  } else {
    prog.hidden = true;
    btn.disabled = false;
    btn.textContent = t('updateNow');
  }
}
$('#btnUpdate').addEventListener('click', showUpdate);
$('#btnCheck').addEventListener('click', checkUpdates);

// ---------------- Kopfleiste & Menü ----------------

$('#btnBack').addEventListener('click', () => goHome());
$('#btnOpen').addEventListener('click', pickFile);
$('#btnShare').addEventListener('click', () => state.doc?.id && A.share(state.doc.id));
$('#btnMenu').addEventListener('click', () => {
  const items = [];
  if (state.doc) {
    if (A && state.doc.id) items.push({ icon: ICON.openWith, label: t('openWith'), run: () => A.openWith(state.doc.id) });
    if (state.kind === 'pdf' && pdf.pages.length > 1) items.push({ icon: ICON.page, label: t('goToPage'), run: goToPage });
    items.push({ icon: ICON.info, label: t('fileInfo'), run: showInfo });
  }
  items.push({ icon: ICON.open, label: t('openFile'), run: pickFile });
  items.push({ icon: ICON.star, label: t('setDefault'), run: showDefaultHelp });
  items.push({ icon: ICON.update, label: t('checkUpdates'), badge: state.update ? state.update.version : '', run: checkUpdates });
  items.push({ icon: ICON.about, label: t('about'), run: showAbout });
  menu(items);
});

// ---------------- Schnittstelle für die App ----------------

window.vv = {
  native(msg) {
    switch (msg.type) {
      case 'open':
        openDoc(msg);
        break;
      case 'openError':
        loading(false);
        if (getRecent().some(r => r.uri === msg.uri)) { removeRecent(msg.uri, true); toast(t('errGone')); }
        else toast(t('errOpen'));
        break;
      case 'pickCancel':
        break;
      case 'update':
        state.update = msg;
        updateCard();
        if (msg.manual) showUpdate();
        break;
      case 'updateState':
        state.updState = msg.state;
        if (msg.state === 'current') toast(t('updateCurrent'));
        else if (msg.state === 'error') toast(t('updateError') + (msg.message ? ' (' + msg.message + ')' : ''), 4000);
        else if (msg.state === 'permission') toast(t('updatePermission'), 5000);
        else if (msg.state === 'downloading') state.updProgress = msg.progress;
        else if (msg.state === 'installing') toast(t('updateInstalling'));
        updateCard();
        break;
    }
  },
  /** Zurück-Taste: true = in der App behandelt */
  back() {
    if (closeOverlays()) return true;
    if (state.doc) {
      if (state.doc.external) return false;   // „Öffnen mit“ → zurück zur aufrufenden App
      goHome();
      return true;
    }
    return false;
  },
};

renderRecent();
if (A) A.ready();
