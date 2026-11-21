// 2D overlay drawn above the WebGL sky: grid, constellation figures, labels, object markers, photo frames.
// Shared by the live view and the poster export — `k` scales strokes and type to the target resolution.

import { catalog, label, desig } from './catalog.js';
import { vec, frameOf, framePoint } from './math.js';

export const ACCENT = '#ffc857';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif';

function polyline(ctx, proj, pts) {
  let prev = null;
  for (const v of pts) {
    const p = proj.project(v);
    if (!p) { prev = null; continue; }
    if (!prev || proj.jumps(prev, p)) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    prev = p;
  }
}

let gridCache = null;
function gridLines(step) {
  if (gridCache?.step === step) return gridCache.lines;
  const lines = [];
  for (let dec = -90 + step; dec < 90; dec += step) {
    const pts = [];
    for (let ra = 0; ra <= 360; ra += 3) pts.push(vec(ra, dec));
    lines.push({ pts, main: dec === 0 });
  }
  for (let ra = 0; ra < 360; ra += step) {
    const pts = [];
    for (let dec = -90 + step / 2; dec <= 90 - step / 2; dec += 3) pts.push(vec(ra, dec));
    lines.push({ pts, main: false });
  }
  gridCache = { step, lines };
  return lines;
}

class Labels {
  constructor(ctx, k) { this.ctx = ctx; this.k = k; this.boxes = []; }
  /** Draw text unless it would collide with one already placed (force = always draw). */
  put(text, x, y, { size = 11, color = '#fff', align = 'left', weight = 500, force = false, spacing = 0 } = {}) {
    const { ctx, k } = this;
    ctx.font = `${weight} ${size * k}px ${FONT}`;
    ctx.letterSpacing = `${spacing * k}px`;
    const w = ctx.measureText(text).width, h = size * k * 1.25;
    const x0 = align === 'center' ? x - w / 2 : x, pad = 3 * k;
    const box = [x0 - pad, y - h / 2 - pad, x0 + w + pad, y + h / 2 + pad];
    if (!force && this.boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) return false;
    this.boxes.push(box);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(3,4,8,0.8)'; ctx.lineJoin = 'round';
    ctx.strokeText(text, x0, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x0, y);
    return true;
  }
}

/**
 * @param o { k, fov, settings, captured: Map, listIds: Set, photos, selection: {objectId, photoId}, adjusting, poster }
 * @returns hit targets for picking: [{ x, y, r, id }]
 */
export function drawOverlay(ctx, proj, o) {
  const { k, fov, settings: st } = o;
  const W = proj.w, H = proj.h, hits = [];
  const labels = new Labels(ctx, k);
  const onScreen = (p, m = 40 * k) => p && p[0] > -m && p[0] < W + m && p[1] > -m && p[1] < H + m;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  if (st.grid) {
    for (const g of gridLines(fov < 50 ? 10 : 30)) {
      ctx.beginPath(); polyline(ctx, proj, g.pts);
      ctx.strokeStyle = g.main ? 'rgba(140,170,230,0.32)' : 'rgba(140,170,230,0.13)';
      ctx.lineWidth = k; ctx.stroke();
    }
  }

  if (st.lines) {
    ctx.beginPath();
    for (const c of catalog.constellations) for (const seg of c.segs) polyline(ctx, proj, seg);
    ctx.strokeStyle = 'rgba(150,180,240,0.26)'; ctx.lineWidth = 1.1 * k; ctx.stroke();
  }

  // Object markers. Captured ones first so their labels win.
  if (st.markers) {
    const sel = o.selection.objectId;
    const deepMag = fov < 5 ? 99 : fov < 14 ? 11 : -99;
    const drawn = [];
    for (const obj of catalog.objects) {
      const how = o.captured.get(obj.id);
      const inList = o.listIds.has(obj.id);
      const deep = (obj.mag ?? 99) <= deepMag || (deepMag > 50);
      // Objects already inside a photo are shown by the photo itself.
      if ((how === 'photo' || how === 'frame') && obj.id !== sel) continue;
      if (!(how || obj.id === sel || (inList && st.remaining) || deep)) continue;
      const p = proj.project(obj.v);
      if (!onScreen(p)) continue;
      const sizePx = obj.a ? (Math.sqrt(obj.a * (obj.b || obj.a)) / 60) * proj.pxPerDeg / 2 : 0;
      drawn.push({ obj, p, how, inList, r: Math.max((how ? 5.5 : 4.5) * k, Math.min(sizePx, 400 * k)) });
    }
    const rank = (d) => (d.obj.id === sel ? 0 : d.how ? 1 : d.inList ? 2 : 3);
    drawn.sort((a, b) => rank(a) - rank(b) || (a.obj.mag ?? 99) - (b.obj.mag ?? 99));
    for (const d of drawn) {
      const { obj, p, how, r } = d, isSel = obj.id === sel;
      ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      if (how) {
        ctx.strokeStyle = ACCENT; ctx.lineWidth = (isSel ? 2.2 : 1.5) * k; ctx.stroke();
        if (r < 9 * k) { ctx.fillStyle = 'rgba(255,200,87,0.35)'; ctx.fill(); }
      } else {
        ctx.strokeStyle = isSel ? '#fff' : d.inList ? 'rgba(235,240,255,0.5)' : 'rgba(200,215,255,0.3)';
        ctx.lineWidth = (isSel ? 2 : 1) * k; ctx.stroke();
      }
      if (isSel) {
        ctx.beginPath(); ctx.arc(p[0], p[1], r + 5 * k, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = k; ctx.stroke();
      }
      // A ticked object counts one frame of your gear: show that frame so the coverage is visible.
      if (how === 'mark' && o.gearFov && o.gearFov.w * proj.pxPerDeg > 18 * k) {
        const gf = frameOf({ ra: obj.ra, dec: obj.dec, rot: 0, fovW: o.gearFov.w, aspect: o.gearFov.w / o.gearFov.h });
        const c = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5], [0, 0]].map(([u, v]) => framePoint(gf, u, v));
        ctx.beginPath(); polyline(ctx, proj, c);
        ctx.strokeStyle = 'rgba(255,200,87,0.4)'; ctx.lineWidth = k; ctx.stroke();
        ctx.fillStyle = 'rgba(255,200,87,0.05)'; ctx.fill();
      }
      hits.push({ x: p[0], y: p[1], r, id: obj.id });
      // Labels: always for the selection, for captured objects when there is room, for the rest once zoomed in.
      const want = isSel || how || fov < 75 || o.poster;
      if (want) {
        const text = fov > 40 && !isSel ? desig(obj) : (obj.m || obj.n ? `${desig(obj)}${obj.n && fov < 25 ? ' · ' + obj.n : ''}` : desig(obj));
        labels.put(text, p[0] + r + 5 * k, p[1], {
          size: isSel ? 12.5 : 11, weight: how || isSel ? 600 : 500, force: isSel,
          color: how ? ACCENT : isSel ? '#fff' : 'rgba(225,232,250,0.72)',
        });
      }
    }
  }

  // Photo frames and captions.
  for (const ph of o.photos) {
    if (ph.ra == null || ph.visible === false) continue;
    const f = frameOf(ph), isSel = ph.id === o.selection.photoId;
    const centre = proj.project(f.c);
    if (!centre) continue;
    if (isSel) {
      const ring = [];
      const N = 10;
      for (let i = 0; i <= N; i++) ring.push(framePoint(f, i / N, 0));
      for (let i = 1; i <= N; i++) ring.push(framePoint(f, 1, i / N));
      for (let i = 1; i <= N; i++) ring.push(framePoint(f, 1 - i / N, 1));
      for (let i = 1; i <= N; i++) ring.push(framePoint(f, 0, 1 - i / N));
      ctx.beginPath(); polyline(ctx, proj, ring);
      ctx.strokeStyle = o.adjusting ? ACCENT : 'rgba(255,255,255,0.7)';
      ctx.setLineDash(o.adjusting ? [6 * k, 5 * k] : []);
      ctx.lineWidth = 1.4 * k; ctx.stroke(); ctx.setLineDash([]);
      // North tick on the frame's "up" edge helps when rotating by hand.
      const top = proj.project(framePoint(f, 0.5, 0)), out = proj.project(framePoint(f, 0.5, -0.06));
      if (top && out && o.adjusting) { ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(out[0], out[1]); ctx.strokeStyle = ACCENT; ctx.stroke(); }
      // Alignment aid: ring every catalogue star in the frame so the photo's stars can be dropped into them.
      if (o.adjusting && o.stars && f.halfW * 2 * proj.scale > 220 * k) {
        const cosR = Math.cos(Math.atan(Math.hypot(f.halfW, f.halfH)) * 1.15), s = o.stars;
        ctx.beginPath();
        for (let i = 0, n = 0; i < s.length && n < 400; i += 3) {
          if (s[i] * f.c[0] + s[i + 1] * f.c[1] + s[i + 2] * f.c[2] < cosR) continue;
          const q = proj.project([s[i], s[i + 1], s[i + 2]]);
          if (!onScreen(q, 0)) continue;
          const r = Math.max(4, 9 - n * 0.02) * k;
          ctx.moveTo(q[0] + r, q[1]); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); n++;
        }
        ctx.strokeStyle = 'rgba(120,230,255,0.75)'; ctx.lineWidth = k; ctx.stroke();
      }
    }
    if (st.photoLabels || isSel) {
      const obj = catalog.byId.get(ph.objectId);
      const text = ph.label || (obj ? label(obj) : ph.name);
      const bottom = proj.project(framePoint(f, 0.5, 1));
      if (text && bottom && onScreen(bottom)) {
        const below = bottom[1] > centre[1] ? bottom[1] : centre[1] + Math.abs(bottom[1] - centre[1]);
        labels.put(text, centre[0], below + 12 * k, { size: 11.5, weight: 600, align: 'center', force: isSel, color: '#fff' });
      }
    }
  }

  if (st.names) {
    const maxRank = fov > 95 ? 1 : fov > 50 ? 2 : 3;
    for (const c of catalog.constellations) {
      if (c.rank > maxRank && !o.poster) continue;
      if (o.poster && c.rank > o.posterRank) continue;
      const p = proj.project(c.v);
      if (!onScreen(p, 0)) continue;
      labels.put(c.name.toUpperCase(), p[0], p[1], { size: 10, weight: 500, align: 'center', color: 'rgba(160,188,245,0.6)', spacing: 1.6 });
    }
    ctx.letterSpacing = '0px';
    const magLim = o.poster ? 1.3 : fov > 70 ? 1.6 : fov > 35 ? 2.6 : 3.6;
    for (const s of catalog.namedStars) {
      if (s.mag > magLim) break;
      const p = proj.project(s.v);
      if (onScreen(p, 0)) labels.put(s.name, p[0] + 7 * k, p[1] - 6 * k, { size: 10.5, weight: 400, color: 'rgba(238,238,230,0.62)' });
    }
  }
  ctx.letterSpacing = '0px';
  return hits;
}
