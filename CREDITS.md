# Credits and data licences

Atlastellar's code is MIT licensed (see `LICENSE`). The sky data in `data/` is built from the public
sources below by `tools/build_data.py`, and each file keeps the licence of its source.

| File | Source | Licence |
| --- | --- | --- |
| `data/milkyway-*.webp`, `data/milkyway-1k.jpg` | [Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851), NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. Tone-mapped and resized. | Public domain (NASA media usage guidelines); please keep the credit line |
| `data/stars.bin`, `data/sky.json` | [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn: stars to magnitude 8, star names, constellation figures | BSD-3-Clause, see `licenses/d3-celestial-LICENSE.txt` |
| `data/objects.json`, `data/lists.json` | [OpenNGC](https://github.com/mattiaverga/OpenNGC) by Mattia Verga: NGC/IC objects, Messier cross references, common names. Filtered and reformatted; Caldwell numbers added. | CC-BY-SA-4.0 (these two files are a derivative and stay CC-BY-SA-4.0) |
| `data/tycho/*.bin`, `data/tycho/index.json` | [Tycho-2](https://cdsarc.cds.unistra.fr/viz-bin/cat/I/259) (Høg et al. 2000, A&A 355, L27) with its first supplement, from the CDS/VizieR archive. Cut to V ≤ 11.5 (1.5 million stars) and packed into sky tiles for the plate solver. | Free to use with acknowledgement of the catalogue and of CDS/VizieR |
| `data/constellations.json` | IAU constellation boundaries, rasterised with [Astropy](https://www.astropy.org)'s `get_constellation` | Derived data; Astropy is BSD-3-Clause |

Coordinates are J2000 throughout.

