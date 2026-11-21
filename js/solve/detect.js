// Star detection: find the stars in a photo and measure where they are.
// Pure functions on typed arrays, so they run the same in a Web Worker or on the main thread.

/** RGBA bytes -> luminance in 0..1. */
export function luminance(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 0.3 + rgba[j + 1] * 0.5 + rgba[j + 2] * 0.2) / 255;
  return out;
}

function smooth(src, w, h) {
  // Separable 5-tap binomial blur: merges the flat top of a saturated star into one clean peak.
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[r + Math.max(0, x - 2)], b = src[r + Math.max(0, x - 1)], c = src[r + x];
      const d = src[r + Math.min(w - 1, x + 1)], e = src[r + Math.min(w - 1, x + 2)];
      tmp[r + x] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const r0 = Math.max(0, y - 2) * w, r1 = Math.max(0, y - 1) * w, r2 = y * w, r3 = Math.min(h - 1, y + 1) * w, r4 = Math.min(h - 1, y + 2) * w;
    for (let x = 0; x < w; x++) out[r2 + x] = (tmp[r0 + x] + 4 * tmp[r1 + x] + 6 * tmp[r2 + x] + 4 * tmp[r3 + x] + tmp[r4 + x]) / 16;
  }
  return out;
}

/** Subtract a smooth background in place; returns the typical noise level. */
function flatten(img, w, h) {
  const B = Math.max(24, Math.round(Math.max(w, h) / 40));
  const gw = Math.max(2, Math.ceil(w / B)), gh = Math.max(2, Math.ceil(h / B));
  const med = new Float32Array(gw * gh), sig = new Float32Array(gw * gh);
  const buf = new Float32Array(Math.ceil(B / 2 + 1) ** 2);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let n = 0;
    const x1 = Math.min(w, (gx + 1) * B), y1 = Math.min(h, (gy + 1) * B);
    for (let y = gy * B; y < y1; y += 2) for (let x = gx * B; x < x1; x += 2) buf[n++] = img[y * w + x];
    const s = buf.subarray(0, n).sort();
    med[gy * gw + gx] = s[n >> 1];
    sig[gy * gw + gx] = s[n >> 1] - s[Math.floor(n * 0.16)]; // spread below the median: stars cannot inflate it
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const bg = (med[y0 * gw + x0] * (1 - tx) + med[y0 * gw + x1] * tx) * (1 - ty) + (med[y1 * gw + x0] * (1 - tx) + med[y1 * gw + x1] * tx) * ty;
      img[y * w + x] -= bg;
    }
  }
  const sorted = Float32Array.from(sig).sort();
  return Math.max(sorted[sorted.length >> 1], 0.5 / 255);
}

/**
 * @param lum  Float32Array luminance, row-major, w*h
 * @returns stars sorted brightest first: [{ x, y, flux, area }], pixel coordinates with (0,0) at the top-left corner
 */
export function detectStars(lum, w, h, opts = {}) {
  const { max = 300, sigma = 5 } = opts;
  const img = smooth(lum, w, h);
  const noise = flatten(img, w, h);
  const thr = Math.max(sigma * noise, 4 / 255);

  // Local maxima above the threshold.
  const peaks = [];
  const R = 3;
  for (let y = R; y < h - R; y++) {
    for (let x = R; x < w - R; x++) {
      const v = img[y * w + x];
      if (v < thr) continue;
      let top = true;
      for (let dy = -R; dy <= R && top; dy++) {
        const r = (y + dy) * w + x;
        for (let dx = -R; dx <= R; dx++) {
          const u = img[r + dx];
          if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) { top = false; break; }
        }
      }
      if (top) peaks.push(y * w + x);
    }
  }
  peaks.sort((a, b) => img[b] - img[a]);

  // Grow each peak into its half-maximum region and take the weighted centroid of that region.
  const label = new Uint8Array(w * h);
  const stack = new Int32Array(8192);
  const AREA_MAX = Math.max(600, Math.round(w * h * 0.0015));
  const stars = [], ring = new Float32Array(32);
  const SHOULDER_MAX = opts.shoulder ?? 0.45;
  for (const p of peaks) {
    if (label[p]) continue;
    const peak = img[p], cut = peak * 0.5;
    let sp = 0, area = 0, sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, flux = 0, edge = false, big = false, raw = 0;
    stack[sp++] = p; label[p] = 1;
    while (sp) {
      const q = stack[--sp], qx = q % w, qy = (q - qx) / w, v = img[q], wt = v - cut;
      area++; flux += v;
      if (lum[q] > raw) raw = lum[q];
      sw += wt; sx += wt * qx; sy += wt * qy; sxx += wt * qx * qx; syy += wt * qy * qy; sxy += wt * qx * qy;
      if (qx < 2 || qy < 2 || qx > w - 3 || qy > h - 3) { edge = true; continue; }
      if (area > AREA_MAX) { big = true; break; }
      for (const n of [q - 1, q + 1, q - w, q + w]) {
        if (!label[n] && img[n] > cut && sp < stack.length) { label[n] = 1; stack[sp++] = n; }
      }
    }
    if (edge || big || sw <= 0 || area < 3) continue;
    const cx = sx / sw, cy = sy / sw;
    // Reject long streaks (trails, diffraction spikes, text): compare the two principal widths.
    const vxx = sxx / sw - cx * cx, vyy = syy / sw - cy * cy, vxy = sxy / sw - cx * cy;
    const tr = vxx + vyy, det = vxx * vyy - vxy * vxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 0.05);
    if (area > 12 && l1 / l2 > 6) continue;
    // Point-source test: just outside a star the light has all but gone, while a nebula knot, a galaxy core
    // or a halo ring sits on a broad shoulder. Sample two rings and take the median (neighbours cannot fool it).
    const re = Math.sqrt(area / Math.PI);
    let nr = 0;
    for (const rad of [1.8 * re + 1, 2.6 * re + 2]) {
      for (let k = 0; k < 16; k++) {
        const ang = (k + (rad > 2 * re + 1.5 ? 0.5 : 0)) * Math.PI / 8;
        const rx = Math.round(cx + rad * Math.cos(ang)), ry = Math.round(cy + rad * Math.sin(ang));
        if (rx >= 0 && ry >= 0 && rx < w && ry < h) ring[nr++] = img[ry * w + rx];
      }
    }
    const shoulder = nr >= 8 ? ring.subarray(0, nr).sort()[nr >> 1] / peak : 0;
    if (shoulder > SHOULDER_MAX) continue;
    // A halo ring or spike around a star already found shares its centre: keep the first (brighter) one.
    const x = cx + 0.5, y = cy + 0.5;
    let dup = false;
    for (let k = 0; k < stars.length && !dup; k++) dup = Math.hypot(stars[k].x - x, stars[k].y - y) < Math.max(3, stars[k].r * 1.5, re);
    if (dup) continue;
    stars.push({ x, y, flux, area, r: re, shoulder, raw, peak });
  }
  // Nebulosity survives the background fit as broad, faint lumps: far bigger than a star image yet nowhere
  // near as strong as the bright stars. A big region is only believable if it is a saturated star.
  let kept = stars;
  if (stars.length >= 12 && opts.lumps !== false) {
    const byPeak = stars.map((s) => s.peak).sort((a, b) => b - a);
    const strong = byPeak[Math.floor(byPeak.length * 0.1)];                       // contrast of the bright stars
    const sharp = stars.filter((s) => s.peak >= byPeak[Math.floor(byPeak.length / 3)]).map((s) => s.area).sort((a, b) => a - b);
    const typical = sharp[sharp.length >> 1];                                     // area of an ordinary star image
    kept = stars.filter((s) => !(s.area > 3 * typical && s.peak < 0.6 * strong));
  }
  // Rank by contrast squared times area: ordinary stars order by peak, saturated ones by size, and whatever
  // low-contrast lumps remain sink to the bottom.
  for (const s of kept) s.flux = s.peak * s.peak * s.area;
  kept.sort((a, b) => b.flux - a.flux);
  return kept.slice(0, max);
}
