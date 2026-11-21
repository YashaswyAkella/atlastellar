// Hinted plate solver.
//
// Given the stars detected in a photo and a rough idea of where it points, find the exact centre, scale,
// rotation and mirror state.
//
//   1. Triangles from the brightest image stars are hashed by shape (two side ratios, which do not change
//      with scale, rotation or mirroring).
//   2. Triangles from the brightest catalogue stars around the hint are looked up in that hash. Every hit
//      implies a scale, a rotation and a parity; real hits pile up in one bin, chance hits scatter.
//   3. The star pairs behind the fullest bins are fitted with a similarity transform on the tangent plane,
//      and the fit is checked against all detected stars and a deeper slice of the catalogue.
//
// Conventions match js/math.js: image positions are q = (x - W/2, H/2 - y) in pixels (y up); `rot` is the
// position angle of image-up, north through east; unmirrored sky images have east on the left.

const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;
const dot3 = (v, i, c) => v[i] * c[0] + v[i + 1] * c[1] + v[i + 2] * c[2];

function basis(c) {
  const r = Math.hypot(c[0], c[1]);
  const e = r > 1e-12 ? [-c[1] / r, c[0] / r, 0] : [0, 1, 0];
  return { c, e, n: [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]] };
}

/**
 * Least-squares similarity fit between image points and catalogue stars.
 * @param pairs [{ qx, qy, v: Float64Array, i: offset into v }]
 * @returns frame { c, right, up, kappa, p, rms } — kappa in tangent units per pixel, p = +1 for a mirrored image
 */
export function fitFrame(pairs, c0, parity = 0) {
  let c = c0, out = null;
  for (let iter = 0; iter < 6; iter++) {
    const B = basis(c), n = pairs.length;
    const tx = new Float64Array(n), ty = new Float64Array(n);
    let mtx = 0, mty = 0, mqx = 0, mqy = 0;
    for (let k = 0; k < n; k++) {
      const { v, i } = pairs[k], d = dot3(v, i, B.c);
      tx[k] = dot3(v, i, B.e) / d; ty[k] = dot3(v, i, B.n) / d;
      mtx += tx[k]; mty += ty[k]; mqx += pairs[k].qx; mqy += pairs[k].qy;
    }
    mtx /= n; mty /= n; mqx /= n; mqy /= n;
    let best = null;
    for (const p of parity ? [parity] : [1, -1]) {
      let S = 0, re = 0, im = 0;
      for (let k = 0; k < n; k++) {
        const zx = p * (pairs[k].qx - mqx), zy = pairs[k].qy - mqy, ax = tx[k] - mtx, ay = ty[k] - mty;
        S += zx * zx + zy * zy; re += ax * zx + ay * zy; im += ay * zx - ax * zy;
      }
      if (S <= 0) continue;
      const mr = re / S, mi = im / S;
      const bx = mtx - (mr * p * mqx - mi * mqy), by = mty - (mi * p * mqx + mr * mqy);
      let res = 0;
      for (let k = 0; k < n; k++) {
        const zx = p * pairs[k].qx, zy = pairs[k].qy;
        res += (tx[k] - (mr * zx - mi * zy + bx)) ** 2 + (ty[k] - (mi * zx + mr * zy + by)) ** 2;
      }
      if (!best || res < best.res) best = { p, mr, mi, bx, by, res };
    }
    if (!best) return null;
    parity = best.p;
    const kappa = Math.hypot(best.mr, best.mi);
    if (!(kappa > 0)) return null;
    const cr = best.mr / kappa, ci = best.mi / kappa;
    out = {
      c, kappa, p: best.p, rms: Math.sqrt(best.res / n) / kappa,
      right: [best.p * (cr * B.e[0] + ci * B.n[0]), best.p * (cr * B.e[1] + ci * B.n[1]), best.p * (cr * B.e[2] + ci * B.n[2])],
      up: [-ci * B.e[0] + cr * B.n[0], -ci * B.e[1] + cr * B.n[1], -ci * B.e[2] + cr * B.n[2]],
      shift: Math.hypot(best.bx, best.by),
    };
    if (out.shift < 1e-10) break;
    // Move the tangent point onto the image centre and fit again, so the angles are exact there.
    const nx = c[0] + B.e[0] * best.bx + B.n[0] * best.by, ny = c[1] + B.e[1] * best.bx + B.n[1] * best.by, nz = c[2] + B.e[2] * best.bx + B.n[2] * best.by;
    const l = Math.hypot(nx, ny, nz);
    c = [nx / l, ny / l, nz / l];
  }
  return out;
}

/** Frame -> the placement fields Atlastellar stores on a photo. */
export function frameToPlacement(f, W) {
  const B = basis(f.c);
  const ue = f.up[0] * B.e[0] + f.up[1] * B.e[1] + f.up[2] * B.e[2], un = f.up[0] * B.n[0] + f.up[1] * B.n[1] + f.up[2] * B.n[2];
  return {
    ra: ((Math.atan2(f.c[1], f.c[0]) * R2D) % 360 + 360) % 360,
    dec: Math.asin(Math.max(-1, Math.min(1, f.c[2]))) * R2D,
    rot: ((Math.atan2(ue, un) * R2D) % 360 + 360) % 360,
    fovW: 2 * Math.atan((f.kappa * W) / 2) * R2D,
    flip: f.p === 1,
  };
}

/** Match every detected star against the catalogue under a trial frame, refit, and tighten. */
export function verify(frame, det, W, H, cat) {
  const M = Math.min(det.length, 150);
  let f = frame, stats = null;
  for (const frac of [0.012, 0.006, 0.004]) {
    const tol = Math.max(frac * Math.max(W, H), frac === 0.004 ? 3 : 4.5);
    // Catalogue stars that fall inside the frame, brightest first.
    const px = [], py = [], pi = [];
    for (let i = 0; i < cat.n && px.length < 260; i++) {
      const d = dot3(cat.v, i * 3, f.c);
      if (d < 0.2) continue;
      const x = W / 2 + dot3(cat.v, i * 3, f.right) / d / f.kappa, y = H / 2 - dot3(cat.v, i * 3, f.up) / d / f.kappa;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      px.push(x); py.push(y); pi.push(i);
    }
    const cell = tol * 2, gw = Math.ceil(W / cell) + 1, grid = new Map();
    for (let k = 0; k < px.length; k++) {
      const key = Math.floor(py[k] / cell) * gw + Math.floor(px[k] / cell);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(k);
    }
    const bestFor = new Map(); // catalogue star -> nearest detection
    for (let s = 0; s < M; s++) {
      const gx = Math.floor(det[s].x / cell), gy = Math.floor(det[s].y / cell);
      let bk = -1, bd = tol;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        for (const k of grid.get((gy + dy) * gw + gx + dx) || []) {
          const d = Math.hypot(px[k] - det[s].x, py[k] - det[s].y);
          if (d < bd) { bd = d; bk = k; }
        }
      }
      if (bk >= 0 && (!bestFor.has(bk) || bestFor.get(bk).d > bd)) bestFor.set(bk, { s, d: bd });
    }
    if (bestFor.size < 4) return null;
    const pairs = [...bestFor].map(([k, m]) => ({ qx: det[m.s].x - W / 2, qy: H / 2 - det[m.s].y, v: cat.v, i: pi[k] * 3 }));
    const next = fitFrame(pairs, f.c, f.p);
    if (!next) return null;
    f = next;
    // How many of the 15 brightest catalogue stars in the frame were found?
    let bright = 0;
    const nb = Math.min(15, px.length);
    for (let k = 0; k < nb; k++) if (bestFor.has(k)) bright++;
    stats = { matched: pairs.length, inFrame: px.length, used: M, tol, brightFrac: nb ? bright / nb : 0, rms: f.rms };
  }
  // Is this real? Chance alignments do happen (a handful of stars will always fall near some catalogue
  // star), but their residuals fill the whole tolerance circle, while a true solution fits to a fraction of
  // a pixel. So: clearly more matches than chance, and either a tight fit or an overwhelming number of stars
  // (the latter lets through wide lenses whose distortion a plain tangent-plane model cannot follow).
  const chance = (stats.used * stats.inFrame * Math.PI * stats.tol * stats.tol) / (W * H);
  const tight = stats.rms <= 0.25 * stats.tol;
  const ok = stats.matched >= 8
    ? stats.matched >= 3 * chance + 4 && stats.brightFrac >= 0.1 && (tight || (stats.matched >= 25 && stats.matched >= 8 * chance + 4))
    : stats.matched >= 6 && chance < 0.3 && stats.rms <= 0.1 * stats.tol && stats.matched >= 0.6 * Math.min(stats.used, stats.inFrame);
  return { ok, frame: f, ...stats, chance };
}

/**
 * One pass: assume the field is between kMin and kMax (tangent units per pixel) and look for it.
 * @returns candidate star-pair lists, most convincing first
 */
export function runPass({ det, W, H, cat, c0, kMin, kMax, eps, Ni, Nc }) {
  Ni = Math.min(Ni, det.length); Nc = Math.min(Nc, cat.n);
  if (Ni < 4 || Nc < 4) return [];
  const qx = new Float64Array(Ni), qy = new Float64Array(Ni);
  for (let i = 0; i < Ni; i++) { qx[i] = det[i].x - W / 2; qy[i] = H / 2 - det[i].y; }

  // --- image triangles, vertices ordered A, B, C opposite the longest, middle and shortest side
  const aMin = 0.12 * Math.max(W, H), SKINNY = 0.18, AMBIG = 0.975;
  const tA = [], tB = [], tC = [], tR1 = [], tR2 = [], tLen = [], tAng = [], tSign = [];
  const order = (dij, dik, djk, i, j, k) => {
    // sides: dij is opposite k, dik opposite j, djk opposite i
    let s = [[dij, k], [dik, j], [djk, i]];
    if (s[0][0] < s[1][0]) [s[0], s[1]] = [s[1], s[0]];
    if (s[1][0] < s[2][0]) [s[1], s[2]] = [s[2], s[1]];
    if (s[0][0] < s[1][0]) [s[0], s[1]] = [s[1], s[0]];
    return s;
  };
  for (let i = 0; i < Ni; i++) for (let j = i + 1; j < Ni; j++) for (let k = j + 1; k < Ni; k++) {
    const s = order(Math.hypot(qx[i] - qx[j], qy[i] - qy[j]), Math.hypot(qx[i] - qx[k], qy[i] - qy[k]), Math.hypot(qx[j] - qx[k], qy[j] - qy[k]), i, j, k);
    const a = s[0][0], b = s[1][0], c = s[2][0];
    if (a < aMin || c / a < SKINNY || b / a > AMBIG || c / b > AMBIG) continue;
    const A = s[0][1], Bv = s[1][1], C = s[2][1];
    tA.push(A); tB.push(Bv); tC.push(C); tR1.push(b / a); tR2.push(c / a); tLen.push(a);
    tAng.push(Math.atan2(qy[C] - qy[Bv], qx[C] - qx[Bv]));
    tSign.push(Math.sign((qx[Bv] - qx[A]) * (qy[C] - qy[A]) - (qy[Bv] - qy[A]) * (qx[C] - qx[A])));
  }
  const nT = tA.length;
  if (!nT) return [];

  // --- shape hash: each image triangle is filed under its own cell and the eight around it
  const G = Math.ceil(1 / eps) + 3, cellCount = new Int32Array(G * G + 1);
  const cellOf = (r1, r2) => Math.floor(r1 / eps) * G + Math.floor(r2 / eps);
  for (let t = 0; t < nT; t++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const g = cellOf(tR1[t], tR2[t]) + dx * G + dy;
    if (g >= 0 && g < G * G) cellCount[g + 1]++;
  }
  for (let g = 0; g < G * G; g++) cellCount[g + 1] += cellCount[g];
  const cellItems = new Int32Array(cellCount[G * G]), fill = cellCount.slice(0, G * G);
  for (let t = 0; t < nT; t++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const g = cellOf(tR1[t], tR2[t]) + dx * G + dy;
    if (g >= 0 && g < G * G) cellItems[fill[g]++] = t;
  }

  // --- catalogue stars on the tangent plane at the hint, and their true angular separations
  const B = basis(c0), xi = new Float64Array(Nc), eta = new Float64Array(Nc), D = new Float32Array(Nc * Nc);
  for (let i = 0; i < Nc; i++) {
    const d = Math.max(0.05, dot3(cat.v, i * 3, B.c));
    xi[i] = dot3(cat.v, i * 3, B.e) / d; eta[i] = dot3(cat.v, i * 3, B.n) / d;
  }
  for (let i = 0; i < Nc; i++) for (let j = i + 1; j < Nc; j++) {
    const ch = Math.hypot(cat.v[i * 3] - cat.v[j * 3], cat.v[i * 3 + 1] - cat.v[j * 3 + 1], cat.v[i * 3 + 2] - cat.v[j * 3 + 2]);
    D[i * Nc + j] = D[j * Nc + i] = 2 * Math.tan(Math.asin(Math.min(1, ch / 2))); // gnomonic-like length for a centred pair
  }

  // --- vote
  const DS = 0.012, DR = 1.5 * D2R, pad = 0.04;
  const lnMin = Math.log(kMin) - pad, NS = Math.ceil((Math.log(kMax / kMin) + 2 * pad) / DS) + 1, NR = Math.round(TAU / DR);
  const hist = new Uint16Array(2 * NS * NR);
  const CAP = 1500000;
  let mBin = new Int32Array(1 << 16), mTri = new Int32Array(1 << 16), mA = new Int32Array(1 << 16), mB = new Int32Array(1 << 16), mC = new Int32Array(1 << 16), nM = 0;
  const grow = (arr) => { const n = new Int32Array(arr.length * 2); n.set(arr); return n; };
  const Lmax = Math.hypot(W, H) * kMax * 1.05, Lmin = aMin * kMin * 0.95;
  const kLo = kMin / 1.04, kHi = kMax * 1.04;

  outer:
  for (let i = 0; i < Nc; i++) for (let j = i + 1; j < Nc; j++) {
    const dij = D[i * Nc + j];
    if (dij > Lmax) continue;
    for (let k = j + 1; k < Nc; k++) {
      const dik = D[i * Nc + k];
      if (dik > Lmax) continue;
      const djk = D[j * Nc + k];
      if (djk > Lmax) continue;
      let a, b, c, A, Bv, C;
      if (dij >= dik) {
        if (dik >= djk) { a = dij; A = k; b = dik; Bv = j; c = djk; C = i; }
        else if (dij >= djk) { a = dij; A = k; b = djk; Bv = i; c = dik; C = j; }
        else { a = djk; A = i; b = dij; Bv = k; c = dik; C = j; }
      } else if (dij >= djk) { a = dik; A = j; b = dij; Bv = k; c = djk; C = i; }
      else if (dik >= djk) { a = dik; A = j; b = djk; Bv = i; c = dij; C = k; }
      else { a = djk; A = i; b = dik; Bv = j; c = dij; C = k; }
      if (a < Lmin) continue;
      const r1 = b / a, r2 = c / a;
      if (r2 < SKINNY - eps) continue;
      const g = Math.floor(r1 / eps) * G + Math.floor(r2 / eps);
      const end = cellCount[g + 1];
      for (let it = cellCount[g]; it < end; it++) {
        const t = cellItems[it];
        if (Math.abs(tR1[t] - r1) > eps || Math.abs(tR2[t] - r2) > eps) continue;
        const kappa = a / tLen[t];
        if (kappa < kLo || kappa > kHi) continue;
        const sgn = Math.sign((xi[Bv] - xi[A]) * (eta[C] - eta[A]) - (eta[Bv] - eta[A]) * (xi[C] - xi[A]));
        const p = sgn * tSign[t];
        if (!p) continue;
        const ang = Math.atan2(eta[C] - eta[Bv], xi[C] - xi[Bv]);
        let phi = p > 0 ? ang - tAng[t] : ang - Math.PI + tAng[t];
        phi -= TAU * Math.floor(phi / TAU);
        const sb = Math.min(NS - 1, Math.max(0, Math.floor((Math.log(kappa) - lnMin) / DS)));
        const bin = ((p > 0 ? 1 : 0) * NS + sb) * NR + Math.min(NR - 1, Math.floor(phi / DR));
        if (hist[bin] < 65535) hist[bin]++;
        if (nM === mBin.length) { mBin = grow(mBin); mTri = grow(mTri); mA = grow(mA); mB = grow(mB); mC = grow(mC); }
        mBin[nM] = bin; mTri[nM] = t; mA[nM] = A; mB[nM] = Bv; mC[nM] = C; nM++;
        if (nM >= CAP) break outer;
      }
    }
  }
  if (!nM) return [];

  // --- fullest bins (each scored with its eight neighbours; rotation wraps around)
  const score = (bin) => {
    const r = bin % NR, s = ((bin - r) / NR) % NS, par = Math.floor(bin / (NS * NR));
    let sum = 0;
    for (let ds = -1; ds <= 1; ds++) {
      if (s + ds < 0 || s + ds >= NS) continue;
      for (let dr = -1; dr <= 1; dr++) sum += hist[(par * NS + s + ds) * NR + ((r + dr + NR) % NR)];
    }
    return sum;
  };
  const ranked = [];
  for (let bin = 0; bin < hist.length; bin++) if (hist[bin] >= 2) ranked.push([score(bin), bin]);
  ranked.sort((x, y) => y[0] - x[0]);
  const near = (b1, b2) => {
    if (Math.floor(b1 / (NS * NR)) !== Math.floor(b2 / (NS * NR))) return false;
    const r1 = b1 % NR, r2 = b2 % NR, s1 = Math.floor(b1 / NR) % NS, s2 = Math.floor(b2 / NR) % NS;
    const dr = Math.min(Math.abs(r1 - r2), NR - Math.abs(r1 - r2));
    return Math.abs(s1 - s2) <= 1 && dr <= 1;
  };
  const picks = [];
  for (const [sc, bin] of ranked) {
    if (picks.length >= 8) break;
    if (picks.some((p) => near(p.bin, bin) || (Math.floor(p.bin / (NS * NR)) === Math.floor(bin / (NS * NR)) && Math.abs((p.bin % NR) - (bin % NR)) <= 2 && Math.abs(Math.floor(p.bin / NR) - Math.floor(bin / NR)) <= 2))) continue;
    picks.push({ bin, score: sc });
  }

  // --- star pairs behind each picked bin
  const candidates = [];
  for (const pick of picks) {
    const votes = new Map();
    const add = (s, cst) => { const key = s * 65536 + cst; votes.set(key, (votes.get(key) || 0) + 1); };
    for (let m = 0; m < nM; m++) {
      if (!near(mBin[m], pick.bin)) continue;
      const t = mTri[m];
      add(tA[t], mA[m]); add(tB[t], mB[m]); add(tC[t], mC[m]);
    }
    const sorted = [...votes].sort((x, y) => y[1] - x[1]);
    if (!sorted.length) continue;
    const need = Math.max(2, sorted[0][1] * 0.3), usedS = new Set(), usedC = new Set(), pairs = [];
    for (const [key, n] of sorted) {
      if (n < need) break;
      const s = Math.floor(key / 65536), cst = key % 65536;
      if (usedS.has(s) || usedC.has(cst)) continue;
      usedS.add(s); usedC.add(cst);
      pairs.push({ qx: qx[s], qy: qy[s], v: cat.v, i: cst * 3 });
    }
    if (pairs.length >= 3) candidates.push({ pairs, score: pick.score });
  }
  return candidates;
}

/** Field widths (degrees) to try, as [low, high] ranges, most likely first. */
export function planPasses(fov, known) {
  const ladder = [];
  for (let w = 0.5; w <= 50; w *= Math.SQRT2) ladder.push(w);
  const dist = (w) => Math.abs(Math.log(w / fov));
  const order = ladder.slice().sort((a, b) => dist(a) - dist(b)).filter((w) => !known || dist(w) < Math.log(4.2));
  const passes = order.map((w) => [w / 1.2, w * 1.2]);
  if (known) passes.unshift([fov / 1.1, fov * 1.1]);
  return passes;
}

/**
 * @param input { det: [{x, y, flux}], w, h, hint: unit vector, fov: degrees, fovKnown: boolean }
 * @param cats  { deep(centre, radius, limit), bright(centre, radius, limit) } async catalogue loaders
 * @returns { ra, dec, rot, fovW, flip, matched, rms } or throws an Error with a user-facing message
 */
export async function solve(input, cats, onProgress = () => {}) {
  const { det, w: W, h: H, hint } = input;
  if (det.length < 6) throw new Error(`Only ${det.length} stars found in this photo. At least 6 are needed.`);
  const now = () => (globalThis.performance ? performance.now() : Date.now()); // monotonic: wall clocks can jump
  const diag = Math.hypot(W, H) / W, t0 = now();
  const passes = planPasses(input.fov || 3, !!input.fovKnown);
  const trail = []; // what each pass saw, attached to the error when nothing fits
  for (let n = 0; n < passes.length; n++) {
    const [lo, hi] = passes[n];
    if (now() - t0 > 45000) { trail.push('time budget reached'); break; }
    onProgress({ pass: n + 1, of: passes.length, lo, hi });
    const kMin = (2 * Math.tan((lo * D2R) / 2)) / W, kMax = (2 * Math.tan((Math.min(hi, 120) * D2R) / 2)) / W;
    const radius = Math.min(88, hi * (0.5 * diag + 0.45));
    const cat = await (lo >= 9 ? cats.bright : cats.deep)(hint, radius, 6000);
    if (cat.n < 6) { trail.push(`${lo.toFixed(2)}-${hi.toFixed(2)}: ${cat.n} catalogue stars`); continue; }
    const Ni = Math.min(22, det.length);
    const regionArea = Math.PI * radius * radius, fieldMin = lo * lo * (H / W);
    const Nc = Math.max(40, Math.min(300, Math.round(Ni * 1.8 * regionArea / fieldMin)));
    // Wide fields bend triangles near the edges of the frame, so shapes are compared more loosely.
    const eps = 0.006 + 0.6 * Math.tan(hi * 0.3 * D2R) ** 2;
    const candidates = runPass({ det, W, H, cat, c0: hint, kMin, kMax, eps: Math.min(eps, 0.05), Ni, Nc });
    trail.push(`${lo.toFixed(2)}-${hi.toFixed(2)}: cat ${cat.n}, top bins ${candidates.slice(0, 3).map((c) => c.score).join('/') || 'none'}`);
    for (const cand of candidates) {
      const first = fitFrame(cand.pairs, hint);
      if (!first || first.kappa < kMin / 1.1 || first.kappa > kMax * 1.1) continue;
      const res = verify(first, det, W, H, cat);
      if (res && res.ok) return { ...frameToPlacement(res.frame, W), matched: res.matched, rms: res.rms, detected: det.length, ms: Math.round(now() - t0) };
    }
  }
  const err = new Error('The stars in this photo could not be matched to the catalogue.');
  err.detail = `${det.length} stars detected; ` + trail.join(' | ');
  throw err;
}
