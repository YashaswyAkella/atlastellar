#!/usr/bin/env python3
"""Render a synthetic astrophoto of any patch of sky, with a known answer, to test placement and solving.

Stars come from the Tycho-2 tiles in data/tycho (or data/stars.bin for fields wider than 12 degrees). To make
the solver work for its living the image also gets: fainter stars the catalogue does not know, brightness
scatter, blurred and saturated star profiles, a sky gradient, nebula-like blobs and noise.

    python3 tools/make_test_photo.py                       # Pleiades, 4 degrees wide, rotated 30 degrees
    python3 tools/make_test_photo.py --ra 83.82 --dec -5.39 --width 1.5 --rot 140 --mirror --name M42_test
    python3 tools/make_test_photo.py --plain               # clean dots only, for checking geometry by eye

The file lands in raw/ (git-ignored) and the true placement is printed and saved next to it as JSON.
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def load_stars(ra0, dec0, radius, wide):
    if wide or not (ROOT / "data/tycho/index.json").exists():
        d = np.fromfile(ROOT / "data/stars.bin", dtype="<f4").reshape(-1, 4)
        return d[:, 0].astype(float), d[:, 1].astype(float), d[:, 2].astype(float)
    idx = json.loads((ROOT / "data/tycho/index.json").read_text())
    B, ras, decs, mags = idx["band"], [], [], []
    for b, nc in enumerate(idx["cells"]):
        lo, hi = -90 + b * B, -90 + (b + 1) * B
        if hi < dec0 - radius or lo > dec0 + radius:
            continue
        cw = 360 / nc
        for c in range(nc):
            # Cheap overlap test: keep the cell if its centre is within radius + cell diagonal.
            cra, cdec = (c + 0.5) * cw, (lo + hi) / 2
            sep = math.degrees(math.acos(max(-1, min(1, math.sin(math.radians(dec0)) * math.sin(math.radians(cdec)) +
                  math.cos(math.radians(dec0)) * math.cos(math.radians(cdec)) * math.cos(math.radians(cra - ra0))))))
            if sep > radius + B + cw:
                continue
            raw = (ROOT / f"data/tycho/{b}-{c}.bin").read_bytes()
            n = len(raw) // 5
            fx = np.frombuffer(raw, "<u2", n, 0); fy = np.frombuffer(raw, "<u2", n, 2 * n); fm = np.frombuffer(raw, "u1", n, 4 * n)
            ras.append((c + fx / 65535) * cw); decs.append(lo + fy / 65535 * B); mags.append(fm / 20)
    return np.concatenate(ras), np.concatenate(decs), np.concatenate(mags)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ra", type=float, default=56.75); ap.add_argument("--dec", type=float, default=24.12)
    ap.add_argument("--width", type=float, default=4.0, help="field width in degrees")
    ap.add_argument("--rot", type=float, default=30.0, help="position angle of image-up, north through east")
    ap.add_argument("--mirror", action="store_true"); ap.add_argument("--plain", action="store_true")
    ap.add_argument("--size", default="1800x1200"); ap.add_argument("--name", default="M45_test")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    W, H = (int(v) for v in a.size.split("x"))
    rng = np.random.default_rng(a.seed)

    hw = math.tan(math.radians(a.width / 2)); hh = hw * H / W
    radius = math.degrees(math.atan(math.hypot(hw, hh))) * 1.05
    ra, dec, mag = load_stars(a.ra, a.dec, radius, a.width > 12)
    a0, d0, t = np.radians(a.ra), np.radians(a.dec), np.radians(a.rot)
    al, dl = np.radians(ra), np.radians(dec)
    cosc = np.sin(d0) * np.sin(dl) + np.cos(d0) * np.cos(dl) * np.cos(al - a0)
    ok = cosc > 0.05
    al, dl, mag, cosc = al[ok], dl[ok], mag[ok], cosc[ok]
    xi = np.cos(dl) * np.sin(al - a0) / cosc                                            # toward east
    eta = (np.cos(d0) * np.sin(dl) - np.sin(d0) * np.cos(dl) * np.cos(al - a0)) / cosc  # toward north
    # Image-up points at position angle `rot`; an unmirrored sky image has east on the left.
    s = 1.0 if a.mirror else -1.0
    x = s * (xi * np.cos(t) - eta * np.sin(t)); y = xi * np.sin(t) + eta * np.cos(t)
    u, v = 0.5 + x / (2 * hw), 0.5 - y / (2 * hh)
    inside = (u > 0) & (u < 1) & (v > 0) & (v < 1)
    px, py, m = u[inside] * W, v[inside] * H, mag[inside]

    img = np.zeros((H, W, 3), np.float32)
    if a.plain:
        img[:] = (14 / 255, 10 / 255, 22 / 255)
        yy, xx = np.mgrid[0:H, 0:W]
        for sx, sy, sm in zip(px, py, m):
            r = max(1.5, (9.5 - sm) * 1.6)
            img[(xx - sx) ** 2 + (yy - sy) ** 2 <= r * r] = (0.47, 0.78, 1.0)
    else:
        # Stars the catalogue has never heard of: about three times as many again, all fainter.
        # They start near the catalogue's own limit (it thins out before it stops).
        faint_floor = 9.0 if a.width > 12 else max(11.0, float(np.percentile(m, 90)) if len(m) else 11.0)
        extra = 3 * len(m) + 150
        px = np.concatenate([px, rng.uniform(0, W, extra)]); py = np.concatenate([py, rng.uniform(0, H, extra)])
        m = np.concatenate([m + rng.normal(0, 0.35, len(m)), faint_floor + rng.exponential(1.2, extra)])
        ref = float(np.percentile(m, 3))                 # the brightest few percent saturate
        fwhm = rng.uniform(2.6, 3.8); sig = fwhm / 2.355
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        gx, gy = rng.uniform(-0.04, 0.04, 2)
        sky = 0.07 + gx * (xx / W - 0.5) + gy * (yy / H - 0.5)
        for _ in range(4):                                # nebula-like glow, red-heavy
            cx, cy, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0.08, 0.3) * W
            blob = rng.uniform(0.05, 0.22) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))
            img += blob[..., None] * np.array([1.0, 0.35, 0.45], np.float32)
        img += sky[..., None]
        for sx, sy, sm in zip(px, py, m):
            amp = 10 ** (-0.4 * (sm - ref)) * 1.4
            rad = int(min(60, max(4, 4 * sig * (1 + 0.6 * math.log10(max(amp, 1))))))
            x0, x1, y0, y1 = int(max(0, sx - rad)), int(min(W, sx + rad + 1)), int(max(0, sy - rad)), int(min(H, sy + rad + 1))
            if x0 >= x1 or y0 >= y1:
                continue
            g = amp * np.exp(-((xx[y0:y1, x0:x1] - sx + 0.5) ** 2 + (yy[y0:y1, x0:x1] - sy + 0.5) ** 2) / (2 * sig * sig))
            tint = np.array([1.0, 1.0, 1.0], np.float32) + rng.normal(0, 0.12, 3).astype(np.float32)
            img[y0:y1, x0:x1] += g[..., None] * tint
        img += rng.normal(0, 0.012, img.shape).astype(np.float32)
    out = ROOT / "raw" / "test" / f"{a.name}.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).save(out, quality=90)
    truth = {"file": out.name, "ra": a.ra, "dec": a.dec, "fovW": a.width, "rot": a.rot % 360, "flip": a.mirror,
             "catalogueStars": int(inside.sum())}
    out.with_suffix(".json").write_text(json.dumps(truth))
    # tests/solve.html reads this list of every test photo made so far.
    truths = [json.loads(p.read_text()) for p in sorted(out.parent.glob("*.json")) if p.name != "index.json"]
    (out.parent / "index.json").write_text(json.dumps(truths, indent=1))
    print(json.dumps(truth))


if __name__ == "__main__":
    main()
