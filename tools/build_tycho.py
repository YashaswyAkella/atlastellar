#!/usr/bin/env python3
"""Cut the Tycho-2 catalogue into small sky tiles for the in-browser plate solver.

Input   raw/tycho2/tyc2.dat.NN.gz (20 files) and raw/tycho2/suppl_1.dat.gz  (see tools/fetch_raw.sh)
Output  data/tycho/<band>-<cell>.bin and data/tycho/index.json

Tiling: declination bands of BAND degrees starting at the south pole; band b is split into
round(360 / BAND * cos(dec_mid)) equal RA cells, so tiles are roughly square and equal in area.

Tile file: N stars sorted bright to faint, stored column-wise, little-endian:
    Uint16[N]  RA  as a fraction of the cell width   (0..65535)
    Uint16[N]  Dec as a fraction of the band height  (0..65535)
    Uint8[N]   V magnitude * 20, clamped to 0..255
"""
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw" / "tycho2"
OUT = ROOT / "data" / "tycho"
BAND = 6.0
MAG_LIMIT = float(sys.argv[1]) if len(sys.argv) > 1 else 11.5


def column(table, a, b):
    """Fixed-width byte columns a..b (1-based, inclusive) as floats; blanks become NaN."""
    col = np.ascontiguousarray(table[:, a - 1:b]).view(f"S{b - a + 1}").ravel()
    col = np.char.strip(col)
    col[col == b""] = b"nan"
    return col.astype(np.float64)


def read_fixed(path, width):
    raw = gzip.open(path).read()
    n = len(raw) // width
    return np.frombuffer(raw, dtype="S1", count=n * width).reshape(n, width)


def load():
    ra, dec, mag = [], [], []
    for path in sorted(RAW.glob("tyc2.dat.*.gz")):
        first = gzip.open(path).readline()
        t = read_fixed(path, len(first))
        # Mean J2000 position; "X" entries have none, so fall back to the observed position.
        r, d = column(t, 16, 27), column(t, 29, 40)
        ro, do = column(t, 153, 164), column(t, 166, 177)
        r, d = np.where(np.isnan(r), ro, r), np.where(np.isnan(d), do, d)
        bt, vt = column(t, 111, 116), column(t, 124, 129)
        ra.append(r); dec.append(d); mag.append(v_mag(bt, vt))
        print(f"  {path.name}: {len(r)}")
    sup = RAW / "suppl_1.dat.gz"
    if sup.exists():
        first = gzip.open(sup).readline()
        t = read_fixed(sup, len(first))
        ra.append(column(t, 16, 27)); dec.append(column(t, 29, 40))
        mag.append(v_mag(column(t, 84, 89), column(t, 97, 102)))
        print(f"  {sup.name}: {len(ra[-1])}")
    return np.concatenate(ra), np.concatenate(dec), np.concatenate(mag)


def v_mag(bt, vt):
    """Johnson V from Tycho BT/VT (ESA 1997); use whichever band exists when one is missing."""
    v = vt - 0.090 * (bt - vt)
    v = np.where(np.isnan(v), np.where(np.isnan(vt), bt, vt), v)
    return v


def cells_in_band(b):
    dec_mid = -90 + BAND * (b + 0.5)
    return max(1, round(360 / BAND * math.cos(math.radians(dec_mid))))


def main():
    print("Reading Tycho-2")
    ra, dec, mag = load()
    ok = ~(np.isnan(ra) | np.isnan(dec) | np.isnan(mag)) & (mag <= MAG_LIMIT)
    ra, dec, mag = ra[ok] % 360.0, dec[ok], mag[ok]
    print(f"  {len(ra)} stars to V {MAG_LIMIT}")

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.bin"):
        old.unlink()
    nb = int(round(180 / BAND))
    band = np.clip(((dec + 90) / BAND).astype(int), 0, nb - 1)
    total, files = 0, 0
    counts = []
    for b in range(nb):
        nc = cells_in_band(b)
        sel = np.where(band == b)[0]
        cw = 360.0 / nc
        cell = np.clip((ra[sel] / cw).astype(int), 0, nc - 1)
        row = []
        for c in range(nc):
            idx = sel[cell == c]
            idx = idx[np.argsort(mag[idx], kind="stable")]
            fx = np.clip(np.round((ra[idx] - c * cw) / cw * 65535), 0, 65535).astype("<u2")
            fy = np.clip(np.round((dec[idx] - (-90 + b * BAND)) / BAND * 65535), 0, 65535).astype("<u2")
            m = np.clip(np.round(mag[idx] * 20), 0, 255).astype("u1")
            (OUT / f"{b}-{c}.bin").write_bytes(fx.tobytes() + fy.tobytes() + m.tobytes())
            total += 5 * len(idx); files += 1
            row.append(len(idx))
        counts.append(row)
    (OUT / "index.json").write_text(json.dumps({
        "catalogue": "Tycho-2 (Hog et al. 2000) with supplement 1", "band": BAND, "magLimit": MAG_LIMIT,
        "cells": [cells_in_band(b) for b in range(nb)], "stars": int(len(ra)),
    }, separators=(",", ":")))
    print(f"  {files} tiles, {total / 1e6:.1f} MB, largest tile {max(max(r) for r in counts)} stars, "
          f"smallest {min(min(r) for r in counts)}")


if __name__ == "__main__":
    main()
