# Atlastellar

**Your night sky, mapped.** Put your astrophotos where they belong on the Milky Way, tick off what you
have shot, and see how much of the sky you have captured.

Atlastellar is a small, dependency-free web app. It runs entirely in your browser: photos are never
uploaded and nothing is stored on a server.

## What it does

- **An interactive sky.** NASA's Deep Star Maps Milky Way, 41,000 stars to magnitude 8, constellation
  figures and 2,500 deep-sky objects. Drag to look around, scroll or pinch to zoom.
- **Your photos, in place.** Drop in JPEG, PNG, WebP or AVIF files. Files named after their target
  (`M31_final.jpg`, `ngc7000-ha.png`, `Rosette Nebula.jpg`) are recognised; otherwise name the target.
- **Plate solving in the browser.** Once a photo has a target, Atlastellar finds its stars, matches
  them against Tycho-2 and sets the exact centre, field width, rotation and mirror state. It works for
  fields from roughly 0.5° to 45° wide and usually takes about a second. If a photo cannot be solved it
  stays where it was, and you can line it up by hand: drag, Shift-drag to rotate and Shift-scroll to
  resize while the catalogue stars are ringed on top.
- **A sky log without photos.** Tick anything you have photographed in the Catalogue tab. Search by
  number or name, or work through the Messier and Caldwell lists.
- **Stats that mean something.**
  - Share of the entire sky you have covered, in percent, square degrees and full Moons.
  - Messier `n/110` and Caldwell `n/109`, with a passport grid for each.
  - Constellations visited out of 88, and how much of each you have covered.
  - Northern and southern hemisphere, and the Milky Way band.
  - Objects that happen to sit inside your frames are found and counted automatically.
  - "Up next": list objects you have not shot that are high at midnight this month.
- **Posters.** Export the whole sky, the Milky Way band or the current view at up to 8K, with your
  photos, your captured objects and a stats footer.
- **Portable.** Save your sky log as a small JSON file and open it in another browser.

## Run it

There is no build step. Serve the folder with any static file server:

```bash
python3 -m http.server 5173
```

Then open <http://localhost:5173>. When changing the code, use `python3 tools/serve.py` instead: it is
the same server with caching switched off, so edited modules and the solver worker always reload. (Opening `index.html` directly from disk will not work, because
browsers block module scripts and `fetch` on `file://`.)

To publish your own copy, push the repository to GitHub and enable **Pages** for the `main` branch
(root folder). The `.nojekyll` file makes Pages serve the files as they are.

No git on your machine? `python3 tools/make_upload_batches.py` sorts the project into numbered folders
of under 100 files that can be dragged onto GitHub's "Upload files" page one after another. Run it
again after making changes and it batches only the files that changed.

## How "percent of the sky" is counted

Every footprint is painted onto an equal-area grid of 8.4 million cells (RA × sin Dec), so overlapping
frames count once and a cell is worth the same solid angle everywhere on the sphere.

| You have… | It counts… |
| --- | --- |
| a placed photo | the photo's real footprint (a tangent-plane rectangle from its centre, field width, aspect and rotation) |
| a ticked object and your gear is set | one frame of your gear, centred on the object |
| a ticked object and no gear | the object's own catalogued size |

The whole sky is 41,253 square degrees. A 250 mm lens on an APS-C sensor covers about 19 of them per
frame, so percentages are honest and small. That is the fun of it.

## Project layout

```
index.html            page shell
css/app.css           styles
js/main.js            bootstrap
js/math.js            spherical maths, the two projections, frames on the sky
js/renderer.js        WebGL2: Milky Way, stars, photos
js/overlay.js         2D canvas: figures, labels, markers, frames (shared with the poster)
js/view.js            camera and pointer/touch handling
js/catalog.js         loads data/, search
js/coverage.js        equal-area coverage grid and all statistics
js/photos.js          photo import, target guessing from file names
js/solve/detect.js    star detection (background, peaks, centroids)
js/solve/solver.js    hinted plate solver: triangle hashing, voting, fit, verification
js/solve/tiles.js     catalogue loading for the solver (Tycho-2 tiles, bright stars)
js/solve/worker.js    runs detection and solving in a Web Worker
js/solve/index.js     main-thread entry point: solveImage()
js/poster.js          poster export
js/store.js           state: localStorage for the log, IndexedDB for photo pixels
js/ui.js              the side panel and on-sky controls
data/                 web-ready sky data (see CREDITS.md)
tools/                Python scripts: build data/, dev server, test photos, upload batches
tests/solve.html      solver test page (see "Testing the solver")
```

### Rebuilding the data

```bash
tools/fetch_raw.sh            # about 320 MB into raw/ (git-ignored)
python3 tools/build_data.py   # needs numpy, Pillow, imageio, astropy and ffmpeg
python3 tools/build_tycho.py  # Tycho-2 tiles for the solver; pass a magnitude limit to change 11.5
```

### Adding an observing list

Lists live in `data/lists.json` and are generated in `build_objects()` in `tools/build_data.py`. A list
is a name, a one-line blurb and items of the form `{ "n": "C14", "o": "<OpenNGC id>" }`. Add the table,
rebuild, and the Catalogue tab, the stats and the poster footer pick it up.

### How the solver works

1. **Detect.** Subtract a smooth background, find peaks, grow each to its half-maximum region and take
   the weighted centroid. Streaks, halo rings and large low-contrast lumps of nebulosity are dropped,
   and what remains is ranked by contrast so real stars come first.
2. **Hash.** Triangles from the 22 brightest image stars are filed by shape: two side ratios that do
   not change with scale, rotation or mirroring.
3. **Vote.** Triangles from the brightest catalogue stars around the target are looked up in that
   hash. Each hit implies a scale, a rotation and a parity. Real hits pile into one bin; chance hits
   scatter.
4. **Fit and verify.** The star pairs behind the fullest bins get a least-squares similarity fit on
   the tangent plane, re-centred until it converges. The fit is accepted only if far more detected
   stars land on catalogue stars than chance would give.

The field width is taken from your gear when it is set. Otherwise the solver walks a ladder of widths
outward from its first guess. Fields narrower than about 0.5°, or with fewer than six Tycho-2 stars in
frame (common away from the Milky Way at long focal lengths), cannot be solved yet; that needs a
deeper catalogue.

### Testing the solver

`python3 tools/make_test_photo.py --help` renders a synthetic astrophoto of any patch of sky with a
known answer: real catalogue stars plus fainter unknown ones, brightness scatter, saturated cores,
nebula glow, gradients and noise. Make a few, serve the folder and open `/tests/solve.html`: each one
is solved from an off-centre hint, with and without a known field width, and compared with the truth.
`--plain` draws clean dots for checking placement by eye against the alignment rings.

`python3 tools/fetch_real_tests.py` downloads twelve real fields (Digitized Sky Survey cutouts from
NASA SkyView: M42, M31, the Pleiades, the Lagoon, the Rosette and others, some mirrored) and
`/tests/solve.html?set=real` runs the solver on them. Real plates bring saturated nebulae, halos,
diffraction spikes and stars the catalogue does not list.

## Roadmap

Ideas that are wanted, roughly in order:

1. **Deeper solving.** Gaia tiles so narrow fields (under 0.5°) and sparse high-latitude fields solve
   too, blind solving without naming a target, and lens-distortion terms for wide lenses.
2. **Read existing solutions.** Import WCS from FITS/XISF headers and from astrometry.net, ASTAP,
   Siril and PixInsight output.
3. **More lists.** Herschel 400, Sharpless, Barnard, Arp, Abell planetaries, LDN/LBN.
4. **Deeper sky when zoomed in.** Fainter star tiles and a survey background (HiPS) at small fields.
5. **Planning.** What is visible from your latitude tonight, mosaic planning from your gear frame.
6. **Richer posters.** Numbered thumbnails legend, custom palettes, print sizes.
7. **Sharing.** A link that encodes your sky log (no photos), and translations.

Issues and pull requests are welcome. The code is plain ES modules with no dependencies; please keep it
that way unless a dependency clearly earns its place.

## Credits

Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020
(Gaia DR2: ESA/Gaia/DPAC). Stars and constellation figures: d3-celestial by Olaf Frohn. Deep-sky
objects: OpenNGC by Mattia Verga. Solver catalogue: Tycho-2 (Høg et al. 2000) via CDS/VizieR. Inspired by the "Make yours" atlas on Cosmic Lens. Full details and
licences are in [CREDITS.md](CREDITS.md).

Code: MIT. Data: see CREDITS.md.
