#!/usr/bin/env python3
"""Download photographs of the real sky with a known answer, to test the plate solver on real stars.

Images are Digitized Sky Survey (DSS2 Red) cutouts served by NASA SkyView. They go to raw/real/
(git-ignored) with an index.json that tests/solve.html?set=real reads. About 4 MB in total.

    python3 tools/fetch_real_tests.py
"""
import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image, ImageOps

OUT = Path(__file__).resolve().parent.parent / "raw" / "real"
W, H = 1500, 1000
# name, RA, Dec, field width (degrees), SkyView rotation, Tycho-2 stars expected in frame (roughly)
FIELDS = [
    ("M31", 10.68, 41.27, 3.0, 0, 156), ("M42", 83.82, -5.39, 1.5, 40, 56), ("NGC7000", 314.7, 44.3, 4.0, 200, 407),
    ("M51", 202.47, 47.2, 0.8, 75, 2), ("M13", 250.42, 36.46, 1.0, 310, 11), ("M45", 57.5, 23.6, 5.0, 15, 358),
    ("M27", 299.9, 22.72, 0.7, 90, 24), ("M57", 283.4, 33.03, 0.5, 0, 15), ("NGC2244", 97.98, 4.95, 2.2, 135, 166),
    ("M8", 270.9, -24.0, 3.0, 20, 312), ("M81", 149.0, 69.4, 1.5, 222, 20), ("NGC6992", 313.5, 31.2, 12.0, 120, 135),
]
MIRRORED = {"M27", "NGC2244", "M13"}  # also saved flipped left-right, as a camera behind a diagonal would

OUT.mkdir(parents=True, exist_ok=True)
index = []
for name, ra, dec, width, rotation, stars in FIELDS:
    path = OUT / f"real_{name}.jpg"
    if not path.exists():
        query = urllib.parse.urlencode({
            "Position": f"{ra},{dec}", "Survey": "DSS2 Red", "Coordinates": "J2000", "Projection": "Tan",
            "Pixels": f"{W},{H}", "Size": f"{width},{width * H / W}", "Rotation": rotation, "Return": "JPEG"})
        print(f"fetching {path.name}")
        with urllib.request.urlopen(f"https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl?{query}", timeout=300) as r:
            path.write_bytes(r.read())
    truth = {
        "file": path.name, "ra": ra, "dec": dec, "real": True, "flip": False, "catalogueStars": stars,
        # SkyView's size is measured on the tangent plane, and its rotation runs opposite to position angle.
        "fovW": 2 * math.degrees(math.atan(math.radians(width) / 2)), "rot": (360 - rotation) % 360,
    }
    index.append(truth)
    if name in MIRRORED:
        mirrored = OUT / f"real_{name}_mirror.jpg"
        if not mirrored.exists():
            ImageOps.mirror(Image.open(path)).save(mirrored, quality=92)
        index.append({**truth, "file": mirrored.name, "flip": True})
(OUT / "index.json").write_text(json.dumps(index, indent=1))
print(f"{len(index)} test photos in {OUT}. Serve the project and open /tests/solve.html?set=real")
