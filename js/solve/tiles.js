// Star catalogues for the solver: Tycho-2 sky tiles for narrow fields, the bright-star file for wide ones.
// Both return the stars inside a cap on the sky, sorted bright to faint, as unit vectors.

const DATA = new URL('../../data/', import.meta.url);
const D2R = Math.PI / 180;

let indexPromise, brightPromise;
const tileCache = new Map();

const getIndex = () => (indexPromise ??= fetch(new URL('tycho/index.json', DATA)).then((r) => {
  if (!r.ok) throw new Error('The star catalogue (data/tycho) is missing.');
  return r.json();
}));

/** Tiles [band, cell] that touch a cap of `radius` degrees around (ra, dec). */
export function tilesFor(index, ra, dec, radius) {
  const B = index.band, nb = index.cells.length, out = [];
  const lo = dec - radius, hi = dec + radius;
  const b0 = Math.max(0, Math.floor((lo + 90) / B)), b1 = Math.min(nb - 1, Math.floor((hi + 90) / B));
  for (let b = b0; b <= b1; b++) {
    const nc = index.cells[b], cw = 360 / nc;
    const bandLo = Math.max(lo, -90 + b * B), bandHi = Math.min(hi, -90 + (b + 1) * B);
    const polar = Math.max(Math.abs(bandLo), Math.abs(bandHi));
    const s = Math.sin(radius * D2R) / Math.max(1e-9, Math.cos(Math.min(89.999, polar) * D2R));
    if (hi >= 90 || lo <= -90 || s >= 1 || radius >= 90) { for (let c = 0; c < nc; c++) out.push([b, c]); continue; }
    const half = Math.asin(s) / D2R;
    if (2 * half + cw >= 360) { for (let c = 0; c < nc; c++) out.push([b, c]); continue; }
    const c0 = Math.floor((ra - half) / cw), c1 = Math.floor((ra + half) / cw);
    for (let c = c0; c <= c1; c++) out.push([b, ((c % nc) + nc) % nc]);
  }
  return out;
}

function loadTile(index, b, c) {
  const key = `${b}-${c}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, fetch(new URL(`tycho/${key}.bin`, DATA)).then((r) => r.arrayBuffer()).then((buf) => {
      const n = Math.floor(buf.byteLength / 5), cw = 360 / index.cells[b];
      const fx = new Uint16Array(buf, 0, n), fy = new Uint16Array(buf, 2 * n, n), fm = new Uint8Array(buf, 4 * n, n);
      const ra = new Float64Array(n), dec = new Float64Array(n), mag = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        ra[i] = (c + fx[i] / 65535) * cw;
        dec[i] = -90 + (b + fy[i] / 65535) * index.band;
        mag[i] = fm[i] / 20;
      }
      return { n, ra, dec, mag };
    }));
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
  }
  return tileCache.get(key);
}

function gather(parts, centre, radius, limit) {
  const cosR = Math.cos(Math.min(180, radius) * D2R), rows = [];
  for (const t of parts) {
    for (let i = 0; i < t.n; i++) {
      const a = t.ra[i] * D2R, d = t.dec[i] * D2R, cd = Math.cos(d);
      const x = cd * Math.cos(a), y = cd * Math.sin(a), z = Math.sin(d);
      if (x * centre[0] + y * centre[1] + z * centre[2] >= cosR) rows.push([t.mag[i], x, y, z]);
    }
  }
  rows.sort((p, q) => p[0] - q[0]);
  const n = Math.min(rows.length, limit), v = new Float64Array(n * 3), mag = new Float32Array(n);
  for (let i = 0; i < n; i++) { mag[i] = rows[i][0]; v[i * 3] = rows[i][1]; v[i * 3 + 1] = rows[i][2]; v[i * 3 + 2] = rows[i][3]; }
  return { n, v, mag };
}

/** Tycho-2 stars within `radius` degrees of the unit vector `centre`. */
export async function loadDeep(centre, radius, limit = 8000) {
  const index = await getIndex();
  const ra = Math.atan2(centre[1], centre[0]) / D2R, dec = Math.asin(Math.max(-1, Math.min(1, centre[2]))) / D2R;
  const tiles = tilesFor(index, ((ra % 360) + 360) % 360, dec, radius);
  const parts = await Promise.all(tiles.map(([b, c]) => loadTile(index, b, c)));
  return gather(parts, centre, radius, limit);
}

/** Bright stars (to magnitude 8, the same file the sky view draws) within `radius` degrees. */
export async function loadBright(centre, radius, limit = 8000) {
  brightPromise ??= fetch(new URL('stars.bin', DATA)).then((r) => r.arrayBuffer()).then((buf) => {
    const d = new Float32Array(buf), n = d.length / 4;
    const ra = new Float64Array(n), dec = new Float64Array(n), mag = new Float32Array(n);
    for (let i = 0; i < n; i++) { ra[i] = d[i * 4]; dec[i] = d[i * 4 + 1]; mag[i] = d[i * 4 + 2]; }
    return { n, ra, dec, mag };
  });
  return gather([await brightPromise], centre, radius, limit);
}
