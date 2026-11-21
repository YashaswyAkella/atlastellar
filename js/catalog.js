// Loads the static sky data and answers lookups against it.

import { vec } from './math.js';

export const catalog = {
  objects: [],      // deep-sky objects, most notable first
  byId: new Map(),
  lists: [],        // observing lists: [{ id, name, blurb, items: [{ n, o }] }]
  constellations: [],
  namedStars: [],
  conGrid: null,    // { w, h, ids, areas, cells: Uint8Array }
  conName: new Map(),
};

export const TYPE_LABEL = {
  galaxy: 'Galaxy', nebula: 'Nebula', planetary: 'Planetary nebula', snr: 'Supernova remnant', dark: 'Dark nebula',
  open: 'Open cluster', globular: 'Globular cluster', star: 'Star system', other: 'Other',
};
export const TYPE_PLURAL = {
  galaxy: 'Galaxies', nebula: 'Nebulae', planetary: 'Planetary nebulae', snr: 'Supernova remnants', dark: 'Dark nebulae',
  open: 'Open clusters', globular: 'Globular clusters', star: 'Star systems', other: 'Other',
};

const json = (name) => fetch(`data/${name}`).then((r) => {
  if (!r.ok) throw new Error(`Could not load data/${name} (${r.status})`);
  return r.json();
});

export async function loadCatalog() {
  const [objects, lists, sky, con] = await Promise.all([json('objects.json'), json('lists.json'), json('sky.json'), json('constellations.json')]);
  for (const o of objects) {
    o.v = vec(o.ra, o.dec);
    o.key = keysOf(o);
    catalog.byId.set(o.id, o);
  }
  catalog.objects = objects;
  catalog.lists = lists;
  for (const c of sky.constellations) {
    c.v = vec(c.ra, c.dec);
    c.segs = c.lines.map((flat) => {
      const pts = [];
      for (let i = 0; i < flat.length; i += 2) pts.push(vec(flat[i], flat[i + 1]));
      return pts;
    });
    catalog.conName.set(c.id, c.name);
  }
  catalog.constellations = sky.constellations;
  catalog.namedStars = sky.namedStars.map(([name, ra, dec, mag]) => ({ name, mag, v: vec(ra, dec) }));

  // Decode the run-length constellation grid.
  const cells = new Uint8Array(con.w * con.h);
  con.rle.forEach((runs, row) => {
    let x = row * con.w;
    for (let i = 0; i < runs.length; i += 2) { cells.fill(runs[i + 1], x, x + runs[i]); x += runs[i]; }
  });
  catalog.conGrid = { w: con.w, h: con.h, ids: con.ids, areas: con.areas, cells };
  return catalog;
}

/** Constellation index at a position (degrees). */
export function constellationAt(ra, dec) {
  const g = catalog.conGrid;
  const row = Math.min(g.h - 1, Math.max(0, Math.floor(((90 - dec) / 180) * g.h)));
  const col = Math.min(g.w - 1, Math.floor((((ra % 360) + 360) % 360) / 360 * g.w));
  return g.cells[row * g.w + col];
}

/** Short designation: "M31", "NGC 7000", "IC 1396". */
export const desig = (o) => (o.m ? `M${o.m}` : o.d);

/** "M31 · Andromeda Galaxy" */
export const title = (o) => (o.n ? `${desig(o)} · ${o.n}` : desig(o));

/** Best human label for a marker next to the object. */
export const label = (o) => o.n || desig(o);

function keysOf(o) {
  const k = [o.d.toLowerCase().replace(/\s+/g, '')];
  if (o.m) k.push(`m${o.m}`, `messier${o.m}`);
  if (o.c) k.push(`c${o.c}`, `caldwell${o.c}`);
  return k;
}

/** Search by designation ("m 31", "ngc7000", "c14") or by name ("veil"). */
export function search(query, limit = 30) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const compact = q.replace(/\s+/g, '');
  const hits = [];
  for (let i = 0; i < catalog.objects.length; i++) {
    const o = catalog.objects[i];
    let score = 0;
    if (o.key.includes(compact)) score = 100;
    else if (o.key.some((k) => k.startsWith(compact))) score = 60;
    else if (o.n) {
      const n = o.n.toLowerCase();
      if (n.startsWith(q)) score = 50;
      else if (n.includes(q)) score = 30;
    }
    if (score) hits.push([score - i / 1e5, o]);
  }
  hits.sort((a, b) => b[0] - a[0]);
  return hits.slice(0, limit).map((h) => h[1]);
}
