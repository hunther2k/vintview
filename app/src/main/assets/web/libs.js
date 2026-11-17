// Bibliotheken erst laden, wenn sie gebraucht werden (schneller Start).
const loaded = new Map();

function loadScript(rel) {
  if (!loaded.has(rel)) {
    loaded.set(rel, new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = new URL(rel, import.meta.url).href;
      s.onload = res;
      s.onerror = () => { loaded.delete(rel); rej(new Error('load ' + rel)); };
      document.head.appendChild(s);
    }));
  }
  return loaded.get(rel);
}

export async function xlsx() { await loadScript('./lib/xlsx/xlsx.full.min.js'); return window.XLSX; }
export async function jszip() { await loadScript('./lib/jszip/jszip.min.js'); return window.JSZip; }
export async function docxPreview() { await jszip(); await loadScript('./lib/docx/docx-preview.min.js'); return window.docx; }
