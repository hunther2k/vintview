// Zwei-Finger-Zoom und Doppeltipp für einen Scroll-Container.
// Während der Geste wird nur per CSS skaliert; danach ruft apply(newZoom)
// das echte Neu-Layout auf und die Scrollposition wird so gesetzt, dass der
// Punkt unter den Fingern an derselben Stelle bleibt.
export function attachZoom(scroller, content, opts) {
  const { get, apply, min, max, dbl } = opts;   // opts.reflow(): true = Inhalt bricht beim Zoomen neu um
  let pinch = null;
  let lastTap = 0, lastX = 0, lastY = 0;

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const rel = (x, y) => {
    const r = scroller.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };

  function zoomAround(newZoom, vx, vy, oldZoom) {
    newZoom = Math.min(max, Math.max(min, newZoom));
    const k = newZoom / oldZoom;
    const cx = scroller.scrollLeft + vx, cy = scroller.scrollTop + vy;
    // Inhalt links/oben vom Container (Ränder) nicht mitskalieren
    const ox = content.offsetLeft, oy = content.offsetTop;
    if (opts.reflow?.()) {
      // Text bricht neu um → Position anteilig halten
      const ratio = cy / Math.max(1, scroller.scrollHeight);
      apply(newZoom);
      scroller.scrollLeft = 0;
      scroller.scrollTop = ratio * scroller.scrollHeight - vy;
      return;
    }
    apply(newZoom);
    scroller.scrollLeft = (cx - ox) * k + ox - vx;
    scroller.scrollTop = (cy - oy) * k + oy - vy;
  }

  scroller.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      const m = rel((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinch = {
        d0: dist(a, b), z0: get(), vx: m.x, vy: m.y, s: 1,
        px: scroller.scrollLeft + m.x - content.offsetLeft,
        py: scroller.scrollTop + m.y - content.offsetTop,
      };
      // Bei CSS-zoom am Inhalt liegen transform-origin-Werte im ungezoomten Maß
      const cz = opts.cssZoom ? opts.cssZoom() : 1;
      content.style.transformOrigin = `${pinch.px / cz}px ${pinch.py / cz}px`;
      content.style.willChange = 'transform';
      e.preventDefault();
    }
  }, { passive: false });

  scroller.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    const s = dist(e.touches[0], e.touches[1]) / pinch.d0;
    const z = Math.min(max, Math.max(min, pinch.z0 * s));
    pinch.s = z / pinch.z0;
    content.style.transform = `scale(${pinch.s})`;
    e.preventDefault();
  }, { passive: false });

  const end = e => {
    if (pinch && e.touches.length < 2) {
      const p = pinch;
      pinch = null;
      content.style.transform = '';
      content.style.willChange = '';
      if (Math.abs(p.s - 1) > 0.01) zoomAround(p.z0 * p.s, p.vx, p.vy, p.z0);
      lastTap = 0;
      return;
    }
    // Doppeltipp
    if (e.changedTouches.length === 1 && e.touches.length === 0) {
      const tch = e.changedTouches[0];
      const now = Date.now();
      if (now - lastTap < 300 && Math.hypot(tch.clientX - lastX, tch.clientY - lastY) < 30) {
        lastTap = 0;
        const v = rel(tch.clientX, tch.clientY);
        const z = get();
        zoomAround(z > 1.05 ? 1 : dbl, v.x, v.y, z);
        e.preventDefault();
      } else {
        lastTap = now; lastX = tch.clientX; lastY = tch.clientY;
      }
    }
  };
  scroller.addEventListener('touchend', end, { passive: false });
  scroller.addEventListener('touchcancel', end, { passive: false });

  // Am PC: Strg + Mausrad
  scroller.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const v = rel(e.clientX, e.clientY);
    const z = get();
    zoomAround(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), v.x, v.y, z);
  }, { passive: false });

  return { zoomAround };
}
