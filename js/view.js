// The interactive sky: camera, pointer/wheel/touch handling, and the draw loop.

import { Projection, clamp, wrap360, radec, frameOf, inFrame, R2D } from './math.js';
import { drawOverlay } from './overlay.js';
import { store } from './store.js';
import { gearFov } from './coverage.js';

const FOV_MIN = 0.4, FOV_MAX = 165;

export class SkyView {
  constructor(stage, renderer, overlay) {
    this.stage = stage;
    this.renderer = renderer;
    this.gl = renderer.canvas;
    this.overlay = overlay;
    this.ctx = overlay.getContext('2d');
    this.cam = { ...store.state.view };
    this.selection = { objectId: null, photoId: null };
    this.adjusting = false;       // dragging inside the selected photo moves it
    this.captured = new Map();
    this.listIds = new Set();
    this.hits = [];
    this.onPick = () => {};
    this.onPhotoEdit = () => {};
    this.onHover = () => {};
    this.onCam = () => {};
    this.dirty = false;
    this.anim = null;

    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.#bind();
  }

  get dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    for (const c of [this.gl, this.overlay]) {
      c.width = Math.round(this.cssW * this.dpr); c.height = Math.round(this.cssH * this.dpr);
    }
    this.draw();
  }

  /** Projection in CSS pixels (for interaction) or device pixels (for drawing). */
  proj(device = false) {
    return Projection.stereo({ ...this.cam, w: device ? this.gl.width : this.cssW, h: device ? this.gl.height : this.cssH });
  }

  limMag() { return clamp(5.0 + 1.25 * Math.log2(120 / this.cam.fov), 4.6, 9.2); }

  requestDraw() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => { this.dirty = false; this.draw(); });
  }

  draw() {
    const proj = this.proj(true), st = store.state;
    this.renderer.render(proj, {
      photos: st.photos, limMag: this.limMag(), gain: 1, blurDeg: 0.25 * clamp((60 - this.cam.fov) / 45, 0, 1),
      starPx: this.dpr * clamp(1 + 0.12 * Math.log2(120 / this.cam.fov), 0.9, 1.6),
    });
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const hits = drawOverlay(ctx, proj, {
      k: this.dpr, fov: this.cam.fov, settings: st.settings, captured: this.captured, listIds: this.listIds,
      photos: st.photos, selection: this.selection, adjusting: this.adjusting, stars: this.renderer.starVecs, gearFov: gearFov(st.gear),
    });
    this.hits = hits.map((h) => ({ ...h, x: h.x / this.dpr, y: h.y / this.dpr, r: h.r / this.dpr }));
  }

  setCam(c, persist = true) {
    this.cam.ra = wrap360(c.ra ?? this.cam.ra);
    this.cam.dec = clamp(c.dec ?? this.cam.dec, -89.5, 89.5);
    this.cam.fov = clamp(c.fov ?? this.cam.fov, FOV_MIN, FOV_MAX);
    if (persist) store.update((s) => { s.view = { ...this.cam }; }, 'view');
    this.onCam();
    this.requestDraw();
  }

  flyTo(ra, dec, fov = this.cam.fov, ms = 700) {
    const from = { ...this.cam }, t0 = performance.now();
    const dra = ((ra - from.ra + 540) % 360) - 180;
    cancelAnimationFrame(this.anim);
    const step = (now) => {
      const t = clamp((now - t0) / ms, 0, 1), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.setCam({ ra: from.ra + dra * e, dec: from.dec + (dec - from.dec) * e, fov: Math.exp(Math.log(from.fov) + (Math.log(fov) - Math.log(from.fov)) * e) }, t === 1);
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  zoomBy(factor, x = this.cssW / 2, y = this.cssH / 2) {
    const before = this.proj().unproject(x, y);
    this.cam.fov = clamp(this.cam.fov * factor, FOV_MIN, FOV_MAX);
    const after = this.proj().unproject(x, y);
    if (before && after) {
      const [ra0, dec0] = radec(before), [ra1, dec1] = radec(after);
      this.setCam({ ra: this.cam.ra + (((ra0 - ra1 + 540) % 360) - 180), dec: this.cam.dec + dec0 - dec1 });
    } else this.setCam({});
  }

  pick(x, y) {
    let best = null, bd = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= Math.max(h.r, 12) && d - Math.min(h.r, 12) < bd) { best = h; bd = d - Math.min(h.r, 12); }
    }
    if (best) return { objectId: best.id };
    const v = this.proj().unproject(x, y);
    if (v) {
      const photos = store.state.photos;
      for (let i = photos.length - 1; i >= 0; i--) {
        const p = photos[i];
        if (p.ra != null && p.visible !== false && inFrame(frameOf(p), v)) return { photoId: p.id };
      }
    }
    return {};
  }

  #photoUnder(x, y) {
    if (!this.adjusting || !this.selection.photoId) return null;
    const p = store.state.photos.find((q) => q.id === this.selection.photoId);
    const v = this.proj().unproject(x, y);
    return p && p.ra != null && v && inFrame(frameOf(p), v) ? p : null;
  }

  #bind() {
    const el = this.overlay, pts = new Map();
    let drag = null, pinch = 0, moved = 0;
    const local = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      cancelAnimationFrame(this.anim);
      const [x, y] = local(e);
      pts.set(e.pointerId, [x, y]);
      moved = 0;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); drag = null; return; }
      const photo = this.#photoUnder(x, y);
      if (photo) {
        const c = this.proj().project(frameOf(photo).c);
        drag = { photo, x, y, ra: photo.ra, dec: photo.dec, rot: photo.rot || 0, rotate: e.shiftKey, a0: Math.atan2(y - c[1], x - c[0]), v0: radec(this.proj().unproject(x, y)) };
      } else drag = { x, y };
      el.classList.add('dragging');
    });

    el.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (!pts.has(e.pointerId)) { this.#hover(x, y); return; }
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, [x, y]);
      moved += Math.abs(x - prev[0]) + Math.abs(y - prev[1]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.zoomBy(pinch / d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch = d;
        return;
      }
      if (!drag) return;
      if (drag.photo) {
        const p = drag.photo, proj = this.proj();
        if (drag.rotate) {
          const c = proj.project(frameOf(p).c), a = Math.atan2(y - c[1], x - c[0]);
          // Screen angles run clockwise while position angle runs counter-clockwise on a north-up, east-left sky.
          p.rot = wrap360(drag.rot - (a - drag.a0) * R2D);
        } else {
          const v = proj.unproject(x, y);
          if (v) {
            const [ra, dec] = radec(v);
            p.ra = wrap360(drag.ra + (((ra - drag.v0[0] + 540) % 360) - 180));
            p.dec = clamp(drag.dec + dec - drag.v0[1], -89.9, 89.9);
          }
        }
        this.onPhotoEdit(p, false);
        this.requestDraw();
        return;
      }
      const ppd = this.proj().pxPerDeg;
      this.setCam({
        ra: this.cam.ra + (x - prev[0]) / (ppd * Math.max(0.12, Math.cos((this.cam.dec * Math.PI) / 180))),
        dec: this.cam.dec + (y - prev[1]) / ppd,
      }, false);
    });

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const [x, y] = local(e);
      pts.delete(e.pointerId);
      pinch = 0;
      el.classList.remove('dragging');
      if (drag?.photo) this.onPhotoEdit(drag.photo, true);
      else if (drag && moved < 5) this.onPick(this.pick(x, y));
      else if (drag) store.update((s) => { s.view = { ...this.cam }; }, 'view');
      drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const photo = e.shiftKey && this.#photoUnder(x, y);
      const dy = e.deltaY || e.deltaX;
      if (photo) {
        photo.fovW = clamp(photo.fovW * Math.exp(dy * 0.0012), 0.05, 170);
        this.onPhotoEdit(photo, true);
        this.requestDraw();
        return;
      }
      this.zoomBy(Math.exp(clamp(dy, -120, 120) * 0.0022), x, y);
    }, { passive: false });

    el.addEventListener('dblclick', (e) => {
      const [x, y] = local(e), v = this.proj().unproject(x, y);
      if (v) { const [ra, dec] = radec(v); this.flyTo(ra, dec, this.cam.fov * 0.45, 450); }
    });
  }

  #hover(x, y) {
    const hit = this.pick(x, y);
    this.overlay.style.cursor = hit.objectId ? 'pointer' : this.#photoUnder(x, y) ? 'move' : '';
    this.onHover(hit, x, y);
  }
}
