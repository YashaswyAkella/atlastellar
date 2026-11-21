#!/usr/bin/env python3
"""Build the web-ready data files in ../data from the raw public sources in ../raw.

Run tools/fetch_raw.sh first. Requires: numpy, Pillow, imageio, astropy, and ffmpeg on PATH.

Outputs
  data/milkyway-4k.webp, data/milkyway-8k.webp   NASA SVS Deep Star Maps 2020 (equirect, J2000)
  data/stars.bin          Float32 [ra, dec, mag, bv] x N, sorted by magnitude
  data/sky.json           constellation lines/labels, named stars
  data/objects.json       deep-sky objects (OpenNGC) with Messier / Caldwell cross references
  data/lists.json         observing lists (Messier, Caldwell, ...)
  data/constellations.json  constellation grid (RLE) + areas, for coverage statistics
"""
import csv
import json
import math
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "data"
OUT.mkdir(exist_ok=True)


def jdump(obj, name):
    p = OUT / name
    p.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
    print(f"  {name}: {p.stat().st_size / 1024:.0f} KB")


def r(x, n=4):
    return round(float(x), n)


# ----------------------------------------------------------------------------- Milky Way
def build_milkyway():
    import imageio.v3 as iio
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = None
    exr = RAW / "milkyway_2020_8k.exr"
    tif = RAW / "mw8k.tif"
    if not tif.exists():
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-apply_trc", "iec61966_2_1",
             "-i", str(exr), "-pix_fmt", "rgb48be", str(tif)], check=True)
    a = iio.imread(tif).astype(np.float32) / 65535.0
    # Gentle filmic stretch: lift the faint band, roll off the galactic core.
    gain = 2.6
    a = 1.0 - np.exp(-a * gain)
    a = np.clip(a * 1.04, 0, 1) ** 0.95
    img8 = Image.fromarray((a * 255 + 0.5).astype(np.uint8), "RGB")
    img8.save(OUT / "milkyway-8k.webp", quality=70, method=6)
    img8.resize((4096, 2048), Image.LANCZOS).save(OUT / "milkyway-4k.webp", quality=84, method=6)
    img8.resize((1024, 512), Image.LANCZOS).save(OUT / "milkyway-1k.jpg", quality=80)
    for n in ("milkyway-8k.webp", "milkyway-4k.webp", "milkyway-1k.jpg"):
        print(f"  {n}: {(OUT / n).stat().st_size / 1e6:.2f} MB")


# ----------------------------------------------------------------------------- stars + figures
def build_sky():
    stars = json.loads((RAW / "stars.8.json").read_text())["features"]
    names = json.loads((RAW / "starnames.json").read_text())
    rows = []
    for f in stars:
        lon, lat = f["geometry"]["coordinates"]
        try:
            bv = float(f["properties"]["bv"])
        except (TypeError, ValueError):
            bv = 0.6
        rows.append((lon % 360.0, lat, float(f["properties"]["mag"]), bv, f["id"]))
    rows.sort(key=lambda s: s[2])
    with open(OUT / "stars.bin", "wb") as fh:
        for s in rows:
            fh.write(struct.pack("<4f", *s[:4]))
    print(f"  stars.bin: {len(rows)} stars, {(OUT / 'stars.bin').stat().st_size / 1024:.0f} KB")

    named = []
    for ra, dec, mag, bv, hip in rows:
        n = names.get(str(hip), {})
        if n.get("name") and mag <= 3.6:
            named.append([n["name"], r(ra), r(dec), r(mag, 2)])

    cons = json.loads((RAW / "constellations.json").read_text())["features"]
    lines = {f["id"]: f for f in json.loads((RAW / "constellations.lines.json").read_text())["features"]}
    out = []
    for f in cons:
        cid = f["id"]
        lon, lat = f["geometry"]["coordinates"]
        segs = []
        if cid in lines:
            for seg in lines[cid]["geometry"]["coordinates"]:
                flat = []
                for lo, la in seg:
                    flat += [r(lo % 360.0, 3), r(la, 3)]
                segs.append(flat)
        out.append({"id": cid, "name": f["properties"]["name"], "rank": int(f["properties"]["rank"]),
                    "ra": r(lon % 360.0, 2), "dec": r(lat, 2), "lines": segs})
    jdump({"constellations": out, "namedStars": named}, "sky.json")
    return [c["id"] for c in out]


# ----------------------------------------------------------------------------- deep-sky objects
TYPE_GROUP = {
    "G": "galaxy", "GPair": "galaxy", "GTrpl": "galaxy", "GGroup": "galaxy",
    "PN": "planetary", "HII": "nebula", "EmN": "nebula", "RfN": "nebula", "Neb": "nebula",
    "Cl+N": "nebula", "SNR": "snr", "DrkN": "dark", "OCl": "open", "*Ass": "open",
    "GCl": "globular", "**": "star", "*": "star", "Nova": "star", "Other": "other",
}

# Caldwell catalogue (Patrick Moore, 1995) -> OpenNGC identifier.
CALDWELL = {
    1: "NGC0188", 2: "NGC0040", 3: "NGC4236", 4: "NGC7023", 5: "IC0342", 6: "NGC6543", 7: "NGC2403",
    8: "NGC0559", 9: "C009", 10: "NGC0663", 11: "NGC7635", 12: "NGC6946", 13: "NGC0457", 14: "C014",
    15: "NGC6826", 16: "NGC7243", 17: "NGC0147", 18: "NGC0185", 19: "IC5146", 20: "NGC7000",
    21: "NGC4449", 22: "NGC7662", 23: "NGC0891", 24: "NGC1275", 25: "NGC2419", 26: "NGC4244",
    27: "NGC6888", 28: "NGC0752", 29: "NGC5005", 30: "NGC7331", 31: "IC0405", 32: "NGC4631",
    33: "NGC6992", 34: "NGC6960", 35: "NGC4889", 36: "NGC4559", 37: "NGC6882", 38: "NGC4565",
    39: "NGC2392", 40: "NGC3626", 41: "C041", 42: "NGC7006", 43: "NGC7814", 44: "NGC7479",
    45: "NGC5248", 46: "NGC2261", 47: "NGC6934", 48: "NGC2775", 49: "NGC2237", 50: "NGC2239",
    51: "IC1613", 52: "NGC4697", 53: "NGC3115", 54: "NGC2506", 55: "NGC7009", 56: "NGC0246",
    57: "NGC6822", 58: "NGC2360", 59: "NGC3242", 60: "NGC4038", 61: "NGC4039", 62: "NGC0247",
    63: "NGC7293", 64: "NGC2362", 65: "NGC0253", 66: "NGC5694", 67: "NGC1097", 68: "NGC6729",
    69: "NGC6302", 70: "NGC0300", 71: "NGC2477", 72: "NGC0055", 73: "NGC1851", 74: "NGC3132",
    75: "NGC6124", 76: "NGC6231", 77: "NGC5128", 78: "NGC6541", 79: "NGC3201", 80: "NGC5139",
    81: "NGC6352", 82: "NGC6193", 83: "NGC4945", 84: "NGC5286", 85: "IC2391", 86: "NGC6397",
    87: "NGC1261", 88: "NGC5823", 89: "NGC6087", 90: "NGC2867", 91: "NGC3532", 92: "NGC3372",
    93: "NGC6752", 94: "NGC4755", 95: "NGC6025", 96: "NGC2516", 97: "NGC3766", 98: "NGC4609",
    99: "C099", 100: "IC2944", 101: "NGC6744", 102: "IC2602", 103: "NGC2070", 104: "NGC0362",
    105: "NGC4833", 106: "NGC0104", 107: "NGC6101", 108: "NGC4372", 109: "NGC3195",
}

# A few names OpenNGC lacks or that astrophotographers use more often.
NAME_OVERRIDES = {
    "Mel022": "Pleiades", "C041": "Hyades", "M040": "Winnecke 4", "NGC6992": "Eastern Veil Nebula",
    "NGC6960": "Western Veil Nebula", "IC4715": "Small Sagittarius Star Cloud", "NGC2237": "Rosette Nebula",
    "NGC5866": "Spindle Galaxy", "NGC0869": "Double Cluster (h Persei)", "NGC0884": "Double Cluster (χ Persei)",
    "NGC1976": "Orion Nebula", "NGC0224": "Andromeda Galaxy", "NGC0598": "Triangulum Galaxy",
}
# OpenNGC files these under the duplicate NGC number; show the familiar one.
DISPLAY_OVERRIDES = {"NGC6882": "NGC 6885", "NGC2239": "NGC 2244"}
# Sizes (arcmin) for big objects whose OpenNGC entry has none.
SIZE_OVERRIDES = {"C099": (400, 300), "IC4715": (120, 60), "C041": (330, 330), "M040": (1, 1)}


def sexa(s, hours):
    sign = -1 if s.strip().startswith("-") else 1
    p = [float(x) for x in s.strip().lstrip("+-").split(":")]
    v = p[0] + p[1] / 60 + p[2] / 3600
    return sign * v * (15 if hours else 1)


def pretty_id(name):
    for pre in ("NGC", "IC"):
        if name.startswith(pre) and name[len(pre):len(pre) + 4].isdigit():
            return f"{pre} {int(name[len(pre):len(pre) + 4])}{name[len(pre) + 4:].strip()}"
    if name.startswith("Mel"):
        return f"Mel {int(name[3:])}"
    if name.startswith("B") and name[1:].isdigit():
        return f"B {int(name[1:])}"
    if name.startswith("M") and name[1:].isdigit():
        return f"M {int(name[1:])}"
    if name.startswith("C") and name[1:].isdigit():
        return f"C {int(name[1:])}"
    return name


def build_objects():
    rows = []
    for fn in ("NGC.csv", "addendum.csv"):
        with open(RAW / fn, newline="") as fh:
            rows += list(csv.DictReader(fh, delimiter=";"))
    cald_rev = {v: k for k, v in CALDWELL.items()}
    # Cross-check the table against the "C nnn" identifiers OpenNGC carries.
    for row in rows:
        for ident in row["Identifiers"].split(","):
            ident = ident.strip()
            if ident.startswith("C ") and ident[2:].isdigit() and row["Type"] != "Dup":
                n = int(ident[2:])
                if CALDWELL.get(n) != row["Name"]:
                    print(f"  note: OpenNGC lists C{n} as {row['Name']}, table says {CALDWELL.get(n)}")
    objs, seen = [], set()
    for row in rows:
        name, typ = row["Name"], row["Type"]
        if typ in ("Dup", "NonEx") or not row["RA"] or name in seen:
            continue
        m = int(row["M"]) if row["M"] else None
        if name == "Mel022":
            m = 45
        if name == "NGC5866":
            m = 102  # the usual identification of Messier 102
        c = cald_rev.get(name)
        common = NAME_OVERRIDES.get(name) or (row["Common names"].split(",")[0].strip() or None)
        mag = None
        for k in ("V-Mag", "B-Mag"):
            if row[k]:
                mag = float(row[k])
                break
        maj = float(row["MajAx"]) if row["MajAx"] else None
        mnr = float(row["MinAx"]) if row["MinAx"] else None
        if name in SIZE_OVERRIDES and not maj:
            maj, mnr = SIZE_OVERRIDES[name]
        group = TYPE_GROUP.get(typ, "other")
        notable = m or c or common
        if group == "star" and not notable:
            continue
        if not notable and not ((mag is not None and mag <= 12.5) or (maj and maj >= 6)):
            continue
        seen.add(name)
        o = {"id": name, "d": DISPLAY_OVERRIDES.get(name) or pretty_id(name), "t": group, "ra": r(sexa(row["RA"], True), 4),
             "dec": r(sexa(row["Dec"], False), 4), "con": row["Const"]}
        if common:
            o["n"] = common
        if mag is not None:
            o["mag"] = r(mag, 1)
        if maj:
            o["a"] = r(maj, 1)
            o["b"] = r(mnr if mnr else maj, 1)
        if row["PosAng"]:
            o["pa"] = int(float(row["PosAng"]))
        if m:
            o["m"] = m
        if c:
            o["c"] = c
        objs.append(o)

    by_id = {o["id"]: o for o in objs}
    messier = {o["m"]: o["id"] for o in objs if "m" in o}
    missing_m = [i for i in range(1, 111) if i not in messier]
    missing_c = [i for i in range(1, 110) if CALDWELL[i] not in by_id]
    assert not missing_m, f"missing Messier: {missing_m}"
    assert not missing_c, f"missing Caldwell: {missing_c}"
    # Caldwell numbers run north to south: a cheap check that the table above is not scrambled.
    decs = [by_id[CALDWELL[i]]["dec"] for i in range(1, 110)]
    bad = [i + 1 for i in range(108) if decs[i + 1] > decs[i] + 3.0]
    assert not bad, f"Caldwell declination order broken near {bad}"

    def rank(o):
        return (0 if "m" in o else 1 if "c" in o else 2 if "n" in o else 3, o.get("mag", 99))
    objs.sort(key=rank)
    jdump(objs, "objects.json")
    print(f"  objects: {len(objs)}")

    lists = [
        {"id": "messier", "name": "Messier", "blurb": "Charles Messier's 110 showpieces — the classic first catalogue.",
         "items": [{"n": f"M{i}", "o": messier[i]} for i in range(1, 111)]},
        {"id": "caldwell", "name": "Caldwell", "blurb": "Patrick Moore's 109 bright objects Messier left out, north to south.",
         "items": [{"n": f"C{i}", "o": CALDWELL[i]} for i in range(1, 110)]},
    ]
    jdump(lists, "lists.json")


# ----------------------------------------------------------------------------- constellation grid
def build_constellation_grid(order):
    from astropy import units as u
    from astropy.coordinates import SkyCoord, get_constellation

    W, H = 1440, 720  # 0.25 degree plate carree cells, row 0 at dec +90
    ra = (np.arange(W) + 0.5) * 360.0 / W
    dec = 90.0 - (np.arange(H) + 0.5) * 180.0 / H
    rr, dd = np.meshgrid(ra, dec)
    names = get_constellation(SkyCoord(rr.ravel() * u.deg, dd.ravel() * u.deg, frame="icrs"), short_name=True)
    names = np.asarray(names).reshape(H, W)
    fix = {"Ser": "Ser"}
    idx = {c: i for i, c in enumerate(order)}
    grid = np.vectorize(lambda n: idx[fix.get(n, n)])(names).astype(np.uint8)
    rle = []
    for row in grid:
        runs, start = [], 0
        for x in range(1, W + 1):
            if x == W or row[x] != row[start]:
                runs += [x - start, int(row[start])]
                start = x
        rle.append(runs)
    cell_area = (360.0 / W) * (180.0 / H) * np.cos(np.radians(dd))
    areas = [r(cell_area[grid == i].sum(), 1) for i in range(len(order))]
    jdump({"w": W, "h": H, "ids": order, "areas": areas, "rle": rle}, "constellations.json")
    print(f"  constellation areas sum: {sum(areas):.0f} sq deg (sphere = 41253)")


if __name__ == "__main__":
    steps = sys.argv[1:] or ["milkyway", "sky", "objects", "grid"]
    order = None
    if "milkyway" in steps:
        print("Milky Way"); build_milkyway()
    if "sky" in steps or "grid" in steps:
        print("Stars + constellations"); order = build_sky()
    if "objects" in steps:
        print("Deep-sky objects"); build_objects()
    if "grid" in steps:
        print("Constellation grid"); build_constellation_grid(order)
