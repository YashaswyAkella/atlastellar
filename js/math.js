// Spherical maths and the two projections Atlastellar draws with.
// Conventions: RA/Dec in degrees (J2000), unit vectors [x, y, z] with z toward the north celestial pole.

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const TAU = Math.PI * 2;
export const SKY_SQDEG = 129600 / Math.PI; // 41 252.96

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const wrap360 = (d) => ((d % 360) + 360) % 360;
export const wrapPi = (r) => r - TAU * Math.floor((r + Math.PI) / TAU);

export function vec(ra, dec) {
  const a = ra * D2R, d = dec * D2R, c = Math.cos(d);
  return [c * Math.cos(a), c * Math.sin(a), Math.sin(d)];
}

export function radec(v) {
  return [wrap360(Math.atan2(v[1], v[0]) * R2D), Math.asin(clamp(v[2], -1, 1)) * R2D];
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Angular separation in degrees between two unit vectors. */
export function sep(a, b) {
  return Math.acos(clamp(dot(a, b), -1, 1)) * R2D;
}

/** Local tangent basis at (ra, dec): c = centre, e = toward east, n = toward north. */
export function tangentBasis(ra, dec) {
  const a = ra * D2R, d = dec * D2R;
  const sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d);
  return { c: [cd * ca, cd * sa, sd], e: [-sa, ca, 0], n: [-sd * ca, -sd * sa, cd] };
}

// Row-major 3x3 helpers.
export const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const mulMTV = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];
export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Equatorial J2000 -> Galactic rotation (IAU 1958 system, Hipparcos values). */
export const EQ2GAL = [
  -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
  0.4941094278755837, -0.4448296299600112, 0.7469822444972189,
  -0.8676661490190047, -0.1980763734312015, 0.4559837761750669,
];

export function galactic(v) {
  const g = mulMV(EQ2GAL, v);
  return [wrap360(Math.atan2(g[1], g[0]) * R2D), Math.asin(clamp(g[2], -1, 1)) * R2D];
}

/**
 * A projection maps equatorial unit vectors to canvas pixels and back.
 *   stereo   — interactive view: stereographic, north up, east left.
 *   equirect — poster view: plate carrée in the galactic or equatorial frame, longitude increasing left.
 */
export class Projection {
  static stereo({ ra, dec, fov, w, h }) {
    const p = new Projection();
    const b = tangentBasis(ra, dec);
    p.mode = 0;
    p.w = w; p.h = h;
    p.mat = [-b.e[0], -b.e[1], -b.e[2], b.n[0], b.n[1], b.n[2], b.c[0], b.c[1], b.c[2]];
    p.scale = (h / 2) / (2 * Math.tan((fov * D2R) / 4));
    p.lon0 = 0; p.lat0 = 0;
    p.pxPerDeg = p.scale * D2R;
    return p;
  }

  static equirect({ frame = 'gal', lon0 = 0, lat0 = 0, span = 360, w, h }) {
    const p = new Projection();
    p.mode = 1;
    p.w = w; p.h = h;
    p.mat = frame === 'gal' ? EQ2GAL : IDENTITY;
    p.scale = w / (span * D2R);
    p.lon0 = lon0 * D2R; p.lat0 = lat0 * D2R;
    p.pxPerDeg = p.scale * D2R;
    return p;
  }

  /** Returns [x, y] in canvas pixels, or null when the point is behind the viewer. */
  project(v) {
    const c = mulMV(this.mat, v);
    if (this.mode === 0) {
      if (c[2] < -0.8) return null;
      const k = (2 / (1 + c[2])) * this.scale;
      return [this.w / 2 + c[0] * k, this.h / 2 - c[1] * k];
    }
    const lon = wrapPi(Math.atan2(c[1], c[0]) - this.lon0);
    const lat = Math.asin(clamp(c[2], -1, 1)) - this.lat0;
    return [this.w / 2 - lon * this.scale, this.h / 2 - lat * this.scale];
  }

  /** Canvas pixel -> equatorial unit vector (null outside the map in equirect mode). */
  unproject(x, y) {
    const px = (x - this.w / 2) / this.scale, py = (this.h / 2 - y) / this.scale;
    let c;
    if (this.mode === 0) {
      const r2 = px * px + py * py, z = (4 - r2) / (4 + r2);
      c = [(px * (1 + z)) / 2, (py * (1 + z)) / 2, z];
    } else {
      const lon = -px + this.lon0, lat = py + this.lat0;
      if (Math.abs(lat) > Math.PI / 2 || Math.abs(px) > Math.PI) return null;
      const cl = Math.cos(lat);
      c = [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
    }
    return mulMTV(this.mat, c);
  }

  /** True when a line between two projected points would jump across the map seam. */
  jumps(a, b) {
    return this.mode === 1 && Math.abs(a[0] - b[0]) > Math.PI * this.scale;
  }
}

// ---------------------------------------------------------------------------- frames on the sky

/**
 * Tangent-plane frame of a rectangular image: centre, the sky directions of image-right and image-up,
 * and half extents in tangent units. `rot` is the position angle of image-up, north through east.
 */
export function frameOf({ ra, dec, rot = 0, fovW, aspect = 1.5, flip = false }) {
  const b = tangentBasis(ra, dec);
  const t = rot * D2R, ct = Math.cos(t), st = Math.sin(t);
  const up = [b.n[0] * ct + b.e[0] * st, b.n[1] * ct + b.e[1] * st, b.n[2] * ct + b.e[2] * st];
  const s = flip ? 1 : -1; // unflipped sky images have east on the left
  const right = [s * (b.e[0] * ct - b.n[0] * st), s * (b.e[1] * ct - b.n[1] * st), s * (b.e[2] * ct - b.n[2] * st)];
  const halfW = Math.tan((Math.min(fovW, 170) * D2R) / 2);
  return { c: b.c, right, up, halfW, halfH: halfW / aspect };
}

/** Sky direction of a point in a frame; u, v in [0, 1] from the image's top-left corner. */
export function framePoint(f, u, v) {
  const x = (u - 0.5) * 2 * f.halfW, y = (0.5 - v) * 2 * f.halfH;
  return normalize([
    f.c[0] + f.right[0] * x + f.up[0] * y,
    f.c[1] + f.right[1] * x + f.up[1] * y,
    f.c[2] + f.right[2] * x + f.up[2] * y,
  ]);
}

/** Is the unit vector inside the frame? */
export function inFrame(f, v) {
  const t = dot(v, f.c);
  if (t <= 1e-6) return false;
  return Math.abs(dot(v, f.right) / t) <= f.halfW && Math.abs(dot(v, f.up) / t) <= f.halfH;
}

/** Solid angle of a tangent-plane rectangle, in square degrees (exact). */
export function frameArea(f) {
  const a = f.halfW, b = f.halfH;
  return 4 * Math.atan((a * b) / Math.sqrt(1 + a * a + b * b)) * R2D * R2D;
}

/** Field of view in degrees for a focal length (mm) and sensor side (mm). */
export const fovDeg = (focal, side) => 2 * Math.atan(side / (2 * focal)) * R2D;

// ---------------------------------------------------------------------------- formatting

export function fmtRA(ra) {
  const h = wrap360(ra) / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m);
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${String(Math.round((m - mm) * 60) % 60).padStart(2, '0')}s`;
}

export function fmtDec(dec) {
  const s = dec < 0 ? '−' : '+', a = Math.abs(dec), d = Math.floor(a), m = Math.round((a - d) * 60);
  return `${s}${String(m === 60 ? d + 1 : d).padStart(2, '0')}° ${String(m === 60 ? 0 : m).padStart(2, '0')}′`;
}

export function fmtAngle(deg) {
  if (deg >= 1) return `${deg.toFixed(deg >= 10 ? 0 : 1)}°`;
  return `${(deg * 60).toFixed(deg * 60 >= 10 ? 0 : 1)}′`;
}

/** Rough star colour from a B−V index. */
export function bvColor(bv) {
  const t = clamp((bv + 0.3) / 2.1, 0, 1);
  const stops = [[0.62, 0.72, 1.0], [0.85, 0.9, 1.0], [1.0, 0.97, 0.9], [1.0, 0.84, 0.62], [1.0, 0.68, 0.45]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, k) => c + (stops[i + 1][k] - c) * f);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Month in which an object at this RA is highest around local midnight. */
export function bestMonth(ra) {
  // RA 0h culminates at midnight near 21 September.
  const idx = Math.floor(8.67 + wrap360(ra) / 30) % 12;
  return MONTHS[idx];
}
