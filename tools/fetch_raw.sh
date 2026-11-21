#!/usr/bin/env bash
# Download the public source data into ./raw (about 320 MB).
# Then run: python3 tools/build_data.py && python3 tools/build_tycho.py
set -euo pipefail
cd "$(dirname "$0")/.." && mkdir -p raw && cd raw

# NASA/Goddard Space Flight Center Scientific Visualization Studio — Deep Star Maps 2020 (public domain)
curl -L -o milkyway_2020_8k.exr https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_8k.exr

# d3-celestial by Olaf Frohn (BSD-3-Clause): stars, star names, constellation figures
B=https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data
for f in stars.8.json starnames.json constellations.json constellations.lines.json; do
  curl -L -o "$f" "$B/$f"
done

# OpenNGC by Mattia Verga (CC-BY-SA-4.0): NGC/IC objects with Messier cross references
N=https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files
curl -L -o NGC.csv "$N/NGC.csv"
curl -L -o addendum.csv "$N/addendum.csv"

# Tycho-2 (Hog et al. 2000, CDS catalogue I/259): 2.5 million stars for the plate solver, about 169 MB.
# The Harvard VizieR mirror is used here; https://cdsarc.cds.unistra.fr/ftp/I/259 carries the same files.
T=https://vizier.cfa.harvard.edu/ftp/cats/I/259
mkdir -p tycho2 && cd tycho2
curl -L -O "$T/ReadMe" -O "$T/suppl_1.dat.gz"
for i in $(seq -w 0 19); do curl -L -O "$T/tyc2.dat.$i.gz"; done
