// Poster export: the whole sky (or the Milky Way band, or the current view) with your photos in place,
// plus a footer that summarises what you have captured.

import { Projection } from './math.js';
import { drawOverlay, ACCENT } from './overlay.js';
import { store } from './store.js';
import { gearFov } from './coverage.js';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';

export const REGIONS = {
  sky: { name: 'Whole sky', hint: 'Galactic coordinates, 360° × 180°' },
  band: { name: 'Milky Way band', hint: 'Galactic plane ±35°' },
  view: { name: 'Current view', hint: 'Exactly what you see now' },
};

/**
 * @returns {Promise<Blob>}
 */
export async function makePoster({ region = 'sky', width = 4096, title = 'My night sky', format = 'image/jpeg', footer = true }, view, stats) {
  const renderer = view.renderer, gl = renderer.canvas, st = store.state;
  const w = Math.min(width, renderer.maxTex);
  let proj, h, fov;
  if (region === 'view') {
    h = Math.round((w * view.cssH) / view.cssW);
    proj = Projection.stereo({ ...view.cam, w, h });
    fov = view.cam.fov;
  } else {
    const latSpan = region === 'band' ? 70 : 180;
    h = Math.round((w * latSpan) / 360);
    proj = Projection.equirect({ frame: 'gal', lon0: 0, lat0: 0, span: 360, w, h });
    fov = 150;
  }
  const k = w / 1700;
  const footH = footer ? Math.round(w * 0.085) : 0;

  // Render the sky at poster size on the live GL canvas, copy it out, then put the canvas back.
  const keep = [gl.width, gl.height];
  gl.width = w; gl.height = h;
  renderer.render(proj, {
    photos: st.photos, gain: 1, starPx: Math.max(1, k * (region === 'view' ? 1.1 : 0.7)),
    limMag: region === 'view' ? view.limMag() : 5.6,
  });
  const out = document.createElement('canvas');
  out.width = w; out.height = h + footH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(gl, 0, 0);
  gl.width = keep[0]; gl.height = keep[1];
  view.draw();

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  drawOverlay(ctx, proj, {
    k, fov, settings: { ...st.settings, grid: false, remaining: false }, captured: stats.captured, listIds: new Set(),
    photos: st.photos, selection: { objectId: null, photoId: null }, adjusting: false,
    poster: region !== 'view', posterRank: 1, gearFov: gearFov(st.gear),
  });
  ctx.restore();

  if (footer) {
    const pad = Math.round(w * 0.022), y0 = h, mid = y0 + footH / 2;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#eef0f6'; ctx.font = `650 ${footH * 0.26}px ${FONT}`;
    ctx.fillText(title || 'My night sky', pad, mid - footH * 0.14);
    ctx.fillStyle = '#8f96a8'; ctx.font = `400 ${footH * 0.13}px ${FONT}`;
    const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    ctx.fillText(`${date} · made with Atlastellar`, pad, mid + footH * 0.2);

    // Stat blocks, right aligned.
    const blocks = [[`${stats.pct < 10 ? stats.pct.toFixed(2) : stats.pct.toFixed(1)}%`, 'of the sky']];
    for (const l of stats.lists) blocks.push([`${l.done}/${l.total}`, l.name]);
    blocks.push([`${stats.conVisited}/88`, 'constellations']);
    let x = w - pad;
    ctx.textAlign = 'right';
    for (const [big, small] of blocks.reverse()) {
      ctx.font = `700 ${footH * 0.28}px ${FONT}`; ctx.fillStyle = ACCENT;
      const bw = ctx.measureText(big).width;
      ctx.fillText(big, x, mid - footH * 0.13);
      ctx.font = `400 ${footH * 0.125}px ${FONT}`; ctx.fillStyle = '#8f96a8';
      const sw = ctx.measureText(small).width;
      ctx.fillText(small, x, mid + footH * 0.2);
      x -= Math.max(bw, sw) + footH * 0.5;
    }
    // Credits, tucked into the bottom edge of the map.
    ctx.textAlign = 'right'; ctx.font = `400 ${Math.max(9, 8.5 * k)}px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillText('Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio · Stars and figures: d3-celestial · Objects: OpenNGC', w - pad, h - 12 * k);
  }

  return new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('The poster is too large for this browser. Try a smaller size.'))), format, 0.93));
}

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
