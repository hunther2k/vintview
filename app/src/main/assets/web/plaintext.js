// Text aus Formaten ohne Layout-Darstellung: altes Word (.doc) und RTF.

/** Text dekodieren: BOM beachten, sonst UTF-8, ersatzweise Windows-1252. */
export function decodeText(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { return new TextDecoder('windows-1252').decode(u8); }
}

/** Sieht der Anfang nach Text aus (keine Nullbytes, wenig Steuerzeichen)? */
export function looksLikeText(u8) {
  const n = Math.min(u8.length, 4096);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = u8[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n < 0.02;
}

/**
 * Word 97–2003 (.doc): Haupttext über die Piece-Table aus dem WordDocument-Stream.
 * cfb = Compound-File-Leser (XLSX.CFB aus SheetJS).
 */
export function docToText(u8, CFB) {
  const cfb = CFB.read(u8, { type: 'array' });
  const wdE = CFB.find(cfb, 'WordDocument');
  if (!wdE) throw new Error('kein Word-Dokument');
  const wd = Uint8Array.from(wdE.content);
  const dv = new DataView(wd.buffer);
  if (dv.getUint16(0, true) !== 0xa5ec) throw new Error('kein Word-Dokument');
  const flags = dv.getUint16(0x0a, true);
  if (flags & 0x0100) throw Object.assign(new Error('encrypted'), { code: 'encrypted' });
  const tblE = CFB.find(cfb, (flags & 0x0200) ? '1Table' : '0Table');
  if (!tblE) throw new Error('Tabelle fehlt');
  const tbl = Uint8Array.from(tblE.content);
  const tv = new DataView(tbl.buffer);

  // FIB: FibBase (32) → csw/fibRgW → cslw/fibRgLw → cbRgFcLcb/fibRgFcLcb
  let pos = 32;
  const csw = dv.getUint16(pos, true); pos += 2 + csw * 2;
  const cslw = dv.getUint16(pos, true); pos += 2;
  const ccpText = dv.getInt32(pos + 12, true);
  pos += cslw * 4;
  pos += 2; // cbRgFcLcb
  const fcClx = dv.getUint32(pos + 33 * 8, true);
  const lcbClx = dv.getUint32(pos + 33 * 8 + 4, true);
  if (!lcbClx) throw new Error('Clx fehlt');

  // Clx: Prc* gefolgt von Pcdt
  let p = fcClx;
  while (tbl[p] === 0x01) p += 3 + tv.getInt16(p + 1, true);
  if (tbl[p] !== 0x02) throw new Error('Pcdt fehlt');
  const lcb = tv.getUint32(p + 1, true);
  const plc = p + 5;
  const n = (lcb - 4) / 12;
  const cp = i => tv.getUint32(plc + i * 4, true);
  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  let out = '';
  for (let i = 0; i < n; i++) {
    const start = cp(i);
    if (start >= ccpText) break;
    const end = Math.min(cp(i + 1), ccpText);
    const pcd = plc + (n + 1) * 4 + i * 8;
    const raw = tv.getUint32(pcd + 2, true);
    const len = end - start;
    if (raw & 0x40000000) {
      const off = (raw & 0x3fffffff) / 2;
      out += cp1252.decode(wd.subarray(off, off + len));
    } else {
      out += utf16.decode(wd.subarray(raw, raw + len * 2));
    }
  }
  return cleanWordText(out);
}

function cleanWordText(s) {
  // Feldfunktionen: \x13 Code \x14 Ergebnis \x15 → nur Ergebnis
  let r = '', depth = 0, inCode = [];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x13) { depth++; inCode[depth] = true; continue; }
    if (c === 0x14) { if (depth) inCode[depth] = false; continue; }
    if (c === 0x15) { if (depth) depth--; continue; }
    if (depth && inCode[depth]) continue;
    if (c === 0x0d || c === 0x0b) r += '\n';
    else if (c === 0x07) r += '\t';
    else if (c === 0x0c) r += '\n\n';
    else if (c === 0x1e) r += '-';      // geschützter Bindestrich
    else if (c === 0x1f) continue;      // bedingter Trennstrich
    else if (c === 0xa0) r += ' ';
    else if (c < 0x20 && c !== 0x09) continue;
    else r += ch;
  }
  return r.replace(/\t\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

/** RTF → Text (Port des bewährten „striprtf“-Verfahrens). */
export function rtfToText(src) {
  const dest = new Set(['aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'atnauthor', 'atndate', 'atnicn', 'atnid', 'atnparent', 'atnref', 'atntime', 'atrfend', 'atrfstart', 'author', 'background', 'bkmkend', 'bkmkstart', 'blipuid', 'buptim', 'category', 'colorschememapping', 'colortbl', 'comment', 'company', 'creatim', 'datafield', 'datastore', 'defchp', 'defpap', 'do', 'doccomm', 'docvar', 'dptxbxtext', 'ebcend', 'ebcstart', 'factoidname', 'falt', 'fchars', 'ffdeftext', 'ffentrymcr', 'ffexitmcr', 'ffformat', 'ffhelptext', 'ffl', 'ffname', 'ffstattext', 'field', 'file', 'filetbl', 'fldinst', 'fldtype', 'fname', 'fontemb', 'fontfile', 'fonttbl', 'footer', 'footerf', 'footerl', 'footerr', 'footnote', 'formfield', 'ftncn', 'ftnsep', 'ftnsepc', 'g', 'generator', 'gridtbl', 'header', 'headerf', 'headerl', 'headerr', 'hl', 'hlfr', 'hlinkbase', 'hlloc', 'hlsrc', 'hsv', 'htmltag', 'info', 'keycode', 'keywords', 'latentstyles', 'lchars', 'levelnumbers', 'leveltext', 'lfolevel', 'linkval', 'list', 'listlevel', 'listname', 'listoverride', 'listoverridetable', 'listpicture', 'liststylename', 'listtable', 'listtext', 'lsdlockedexcept', 'macc', 'maccPr', 'mailmerge', 'maln', 'malnScr', 'manager', 'margPr', 'mbar', 'mbarPr', 'mbaseJc', 'mbegChr', 'mborderBox', 'mborderBoxPr', 'mbox', 'mboxPr', 'mchr', 'mcount', 'mctrlPr', 'md', 'mdeg', 'mdegHide', 'mden', 'mdiff', 'mdPr', 'me', 'mendChr', 'meqArr', 'meqArrPr', 'mf', 'mfName', 'mfPr', 'mfunc', 'mfuncPr', 'mgroupChr', 'mgroupChrPr', 'mgrow', 'mhideBot', 'mhideLeft', 'mhideRight', 'mhideTop', 'mhtmltag', 'mlim', 'mlimloc', 'mlimlow', 'mlimlowPr', 'mlimupp', 'mlimuppPr', 'mm', 'mmaddfieldname', 'mmath', 'mmathPict', 'mmathPr', 'mmaxdist', 'mmc', 'mmcJc', 'mmconnectstr', 'mmconnectstrdata', 'mmcPr', 'mmcs', 'mmdatasource', 'mmheadersource', 'mmmailsubject', 'mmodso', 'mmodsofilter', 'mmodsofldmpdata', 'mmodsomappedname', 'mmodsoname', 'mmodsorecipdata', 'mmodsosort', 'mmodsosrc', 'mmodsotable', 'mmodsoudl', 'mmodsoudldata', 'mmodsouniquetag', 'mmPr', 'mmquery', 'mmr', 'mnary', 'mnaryPr', 'mnoBreak', 'mnum', 'mobjDist', 'moMath', 'moMathPara', 'moMathParaPr', 'mopEmu', 'mphant', 'mphantPr', 'mplcHide', 'mpos', 'mr', 'mrad', 'mradPr', 'mrPr', 'msepChr', 'mshow', 'mshp', 'msPre', 'msPrePr', 'msSub', 'msSubPr', 'msSubSup', 'msSubSupPr', 'msSup', 'msSupPr', 'mstrikeBLTR', 'mstrikeH', 'mstrikeTLBR', 'mstrikeV', 'msub', 'msubHide', 'msup', 'msupHide', 'mtransp', 'mtype', 'mvertJc', 'mvfmf', 'mvfml', 'mvtof', 'mvtol', 'mzeroAsc', 'mzeroDesc', 'mzeroWid', 'nesttableprops', 'nextfile', 'nonesttables', 'objalias', 'objclass', 'objdata', 'object', 'objname', 'objsect', 'objtime', 'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops', 'oleclsid', 'operator', 'panose', 'password', 'passwordhash', 'pgp', 'pgptbl', 'picprop', 'pict', 'pn', 'pnseclvl', 'pntext', 'pntxta', 'pntxtb', 'printim', 'private', 'propname', 'protend', 'protstart', 'protusertbl', 'pxe', 'result', 'revtbl', 'revtim', 'rsidtbl', 'rxe', 'shp', 'shpgrp', 'shpinst', 'shppict', 'shprslt', 'shptxt', 'sn', 'sp', 'staticval', 'stylesheet', 'subject', 'sv', 'svb', 'tc', 'template', 'themedata', 'title', 'txe', 'ud', 'upr', 'userprops', 'wgrffmtfilter', 'windowcaption', 'writereservation', 'writereservhash', 'xe', 'xform', 'xmlattrname', 'xmlattrvalue', 'xmlclose', 'xmlname', 'xmlnstbl', 'xmlopen']);
  const specials = { par: '\n', sect: '\n\n', page: '\n\n', line: '\n', tab: '\t', emdash: '—', endash: '–', emspace: ' ', enspace: ' ', qmspace: ' ', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', row: '\n', cell: '\t', nestcell: '\t', nestrow: '\n' };
  const re = /\\([a-z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|(.)/gis;
  const cp = new TextDecoder('windows-1252');
  const stack = [];
  let ignorable = false, ucskip = 1, curskip = 0, out = [], m;
  while ((m = re.exec(src))) {
    const [, word, arg, hex, ch, brace, tchar] = m;
    if (brace) {
      curskip = 0;
      if (brace === '{') stack.push([ucskip, ignorable]);
      else if (stack.length) [ucskip, ignorable] = stack.pop();
    } else if (ch) {
      curskip = 0;
      if (ch === '~') { if (!ignorable) out.push(' '); }
      else if ('{}\\'.includes(ch)) { if (!ignorable) out.push(ch); }
      else if (ch === '*') ignorable = true;
    } else if (word) {
      curskip = 0;
      const w = word.toLowerCase();
      if (dest.has(word) || dest.has(w)) ignorable = true;
      else if (ignorable) { /* nichts */ }
      else if (specials[w] !== undefined) out.push(specials[w]);
      else if (w === 'uc') ucskip = +arg;
      else if (w === 'u') {
        let c = +arg; if (c < 0) c += 0x10000;
        out.push(String.fromCharCode(c));
        curskip = ucskip;
      }
    } else if (hex) {
      if (curskip > 0) curskip--;
      else if (!ignorable) out.push(cp.decode(new Uint8Array([parseInt(hex, 16)])));
    } else if (tchar) {
      if (curskip > 0) curskip--;
      else if (!ignorable) out.push(tchar);
    }
  }
  return out.join('').replace(/\n{4,}/g, '\n\n\n').trim();
}
