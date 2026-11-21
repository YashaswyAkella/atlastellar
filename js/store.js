// App state. Everything lives in this browser: settings and marks in localStorage, photo pixels in IndexedDB.

const KEY = 'atlastellar:v1';
const DB = 'atlastellar', STORE = 'photos';

const DEFAULTS = () => ({
  version: 1,
  gear: { name: '', focal: null, sensorW: null, sensorH: null, preset: '' },
  marks: {},   // objectId -> { at: ISO date string, note? } : captured, with or without a photo
  photos: [],  // { id, name, objectId, label, ra, dec, rot, fovW, aspect, flip, opacity, feather, melt, visible, focal }
  settings: { lines: true, names: true, grid: false, markers: true, remaining: true, photoLabels: true, list: 'messier' },
  view: { ra: 266.4, dec: -29, fov: 110 },
});

class Store {
  constructor() {
    this.listeners = new Set();
    this.state = DEFAULTS();
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved && saved.version === 1) this.state = merge(DEFAULTS(), saved);
    } catch { /* storage unavailable or corrupt: start clean */ }
    this.saveTimer = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /**
   * Mutate the state. `what` tells listeners what changed so they can do the minimum:
   *   'view'  camera only · 'sky' redraw the sky · 'data' marks/photos changed (stats) · 'ui' rebuild panels
   */
  update(fn, what = 'data ui') {
    fn(this.state);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 250);
    const tags = new Set(what.split(' '));
    for (const l of this.listeners) l(tags, this.state);
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* quota or private mode */ }
  }

  /** Portable copy of the sky log (no photo pixels). */
  exportJSON() {
    const { gear, marks, photos, settings } = this.state;
    return JSON.stringify({ app: 'atlastellar', version: 1, exported: new Date().toISOString(), gear, marks, photos, settings }, null, 2);
  }

  importJSON(text) {
    const data = JSON.parse(text);
    if (data.app !== 'atlastellar' || typeof data.marks !== 'object') throw new Error('This is not an Atlastellar file.');
    this.update((s) => {
      Object.assign(s.marks, data.marks);
      if (data.gear?.focal && !s.gear.focal) s.gear = data.gear;
      const have = new Set(s.photos.map((p) => p.id));
      for (const p of data.photos || []) if (!have.has(p.id)) s.photos.push(p);
    });
    return Object.keys(data.marks).length;
  }

  async clearAll() {
    const view = this.state.view;
    this.state = DEFAULTS();
    this.state.view = view;
    await idb('readwrite', (st) => st.clear());
    this.update(() => {});
  }
}

function merge(base, saved) {
  for (const k of Object.keys(base)) {
    if (saved[k] === undefined) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && k !== 'marks') Object.assign(base[k], saved[k]);
    else base[k] = saved[k];
  }
  return base;
}

// ---------------------------------------------------------------------------- photo blobs (IndexedDB)

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const blobs = {
  put: (id, blob) => idb('readwrite', (st) => st.put(blob, id)),
  get: (id) => idb('readonly', (st) => st.get(id)),
  del: (id) => idb('readwrite', (st) => st.delete(id)),
};

export const store = new Store();
