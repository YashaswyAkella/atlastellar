// How much of the sky have you photographed?
//
// Footprints are painted onto an equal-area grid (RA x sin Dec), so overlapping frames are only counted once
// and every cell is worth the same solid angle wherever it sits on the sphere.

import { catalog } from './catalog.js';
import { D2R, R2D, SKY_SQDEG, EQ2GAL, frameOf, inFrame, fovDeg, clamp, dot } from './math.js';

const W = 4096, H = 2048;
const CELL = SKY_SQDEG / (W * H); // square degrees per cell (about 4 arcminutes across)
const BAND_LAT = 10;              // "Milky Way band": within 10 degrees of the galactic plane

const grid = new Uint8Array(W * H);
const cosA = new Float32Array(W), sinA = new Float32Array(W);
for (let i = 0; i < W; i++) {
  const a = ((i + 0.5) / W) * Math.PI * 2;
  cosA[i] = Math.cos(a); sinA[i] = Math.sin(a);
}

/** Gear field of view in degrees, or null when gear is not set. */
export function gearFov(gear) {
  if (!gear?.focal || !gear.sensorW || !gear.sensorH) return null;
  return { w: fovDeg(gear.focal, gear.sensorW), h: fovDeg(gear.focal, gear.sensorH) };
}

/** The footprints that count toward coverage. */
export function footprints(state) {
  const out = [];
  const withPhoto = new Set();
  for (const p of state.photos) {
    if (p.ra == null || !p.fovW) continue;
    out.push({ kind: 'photo', id: p.id, frame: frameOf(p) });
    if (p.objectId) withPhoto.add(p.objectId);
  }
  const fov = gearFov(state.gear);
  for (const id of Object.keys(state.marks)) {
    if (withPhoto.has(id)) continue;
    const o = catalog.byId.get(id);
    if (!o) continue;
    if (fov) out.push({ kind: 'gear', id, frame: frameOf({ ra: o.ra, dec: o.dec, rot: 0, fovW: fov.w, aspect: fov.w / fov.h }) });
    else if (o.a) out.push({ kind: 'object', id, c: o.v, radius: (Math.sqrt(o.a * (o.b || o.a)) / 2 / 60) * D2R, dec: o.dec, ra: o.ra });
  }
  return out;
}

function paint(fp, acc) {
  let c, rho, test;
  if (fp.frame) {
    const f = fp.frame;
    c = f.c; rho = Math.atan(Math.hypot(f.halfW, f.halfH));
    test = (v) => inFrame(f, v);
  } else {
    c = fp.c; rho = fp.radius;
    const cr = Math.cos(rho);
    test = (v) => dot(v, c) >= cr;
  }
  const dec0 = Math.asin(clamp(c[2], -1, 1)), ra0 = Math.atan2(c[1], c[0]);
  const zTop = dec0 + rho >= Math.PI / 2 ? 1 : Math.sin(dec0 + rho);
  const zBot = dec0 - rho <= -Math.PI / 2 ? -1 : Math.sin(dec0 - rho);
  const r0 = clamp(Math.floor(((1 - zTop) / 2) * H), 0, H - 1), r1 = clamp(Math.ceil(((1 - zBot) / 2) * H), 0, H - 1);
  const cosRho = Math.cos(rho), sd0 = Math.sin(dec0), cd0 = Math.cos(dec0);
  const v = [0, 0, 0];
  for (let r = r0; r <= r1; r++) {
    const z = 1 - ((r + 0.5) * 2) / H, cd = Math.sqrt(1 - z * z);
    // RA half-width of the bounding cap on this row.
    let span = Math.PI;
    const den = cd * cd0;
    if (den > 1e-9) {
      const q = (cosRho - z * sd0) / den;
      if (q >= 1) span = (2 * Math.PI) / W; else if (q > -1) span = Math.acos(q);
    }
    const n = Math.min(W, Math.ceil((span / Math.PI) * W / 2) * 2 + 2);
    let col = Math.floor(((ra0 - span) / (2 * Math.PI)) * W) - 1;
    for (let k = 0; k < n; k++, col++) {
      const cc = ((col % W) + W) % W, i = r * W + cc;
      if (grid[i]) continue;
      v[0] = cd * cosA[cc]; v[1] = cd * sinA[cc]; v[2] = z;
      if (!test(v)) continue;
      grid[i] = 1;
      acc.cells++;
      if (z >= 0) acc.north++; else acc.south++;
      if (Math.abs(EQ2GAL[6] * v[0] + EQ2GAL[7] * v[1] + EQ2GAL[8] * v[2]) < acc.sinBand) acc.band++;
      const g = catalog.conGrid;
      const row = Math.min(g.h - 1, Math.floor(((90 - Math.asin(z) * R2D) / 180) * g.h));
      acc.con[g.cells[row * g.w + Math.floor(((cc + 0.5) / W) * g.w)]]++;
    }
  }
}

/** Everything the Stats tab and the HUD show. */
export function computeStats(state) {
  grid.fill(0);
  const fps = footprints(state);
  const acc = { cells: 0, north: 0, south: 0, band: 0, con: new Float64Array(catalog.conGrid.ids.length), sinBand: Math.sin(BAND_LAT * D2R) };
  for (const fp of fps) paint(fp, acc);

  // What counts as captured: marked by hand, attached to a photo, or simply sitting inside one of your frames.
  const captured = new Map();
  for (const id of Object.keys(state.marks)) if (catalog.byId.has(id)) captured.set(id, 'mark');
  const frames = fps.filter((f) => f.kind === 'photo');
  for (const p of state.photos) if (p.objectId && catalog.byId.has(p.objectId)) captured.set(p.objectId, 'photo');
  if (frames.length) {
    for (const o of catalog.objects) {
      if (captured.has(o.id)) continue;
      for (const f of frames) if (inFrame(f.frame, o.v)) { captured.set(o.id, 'frame'); break; }
    }
  }

  const lists = catalog.lists.map((l) => ({
    id: l.id, name: l.name, total: l.items.length, done: l.items.filter((it) => captured.has(it.o)).length,
  }));
  const byType = {};
  const conHasObject = new Set();
  for (const id of captured.keys()) {
    const o = catalog.byId.get(id);
    byType[o.t] = (byType[o.t] || 0) + 1;
    conHasObject.add(o.con);
  }
  const g = catalog.conGrid;
  const con = g.ids.map((id, i) => ({
    id, name: catalog.conName.get(id) || id, sqdeg: acc.con[i] * CELL, pct: (100 * acc.con[i] * CELL) / g.areas[i],
    visited: acc.con[i] > 0 || conHasObject.has(id),
  }));
  const sqdeg = acc.cells * CELL;
  return {
    sqdeg, pct: (100 * sqdeg) / SKY_SQDEG,
    northPct: (100 * acc.north * CELL) / (SKY_SQDEG / 2), southPct: (100 * acc.south * CELL) / (SKY_SQDEG / 2),
    bandPct: (100 * acc.band * CELL) / (SKY_SQDEG * Math.sin(BAND_LAT * D2R)),
    moons: sqdeg / 0.2,
    captured, lists, byType, con,
    conVisited: con.filter((c) => c.visited).length,
    photos: frames.length,
    usesGear: fps.some((f) => f.kind === 'gear'),
    marksWithoutArea: Object.keys(state.marks).length > 0 && !gearFov(state.gear),
  };
}
