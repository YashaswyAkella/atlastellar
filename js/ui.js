// The side panel (Photos · Catalogue · Stats · Export), the object card and the on-sky controls.

import { store, blobs } from './store.js';
import { catalog, search, desig, title, label, TYPE_LABEL, TYPE_PLURAL } from './catalog.js';
import { gearFov } from './coverage.js';
import { addFiles, removePhoto, placeOn, defaultFov, withoutPixels, MAX_PHOTOS } from './photos.js';
import { makePoster, download, REGIONS } from './poster.js';
import { fmtRA, fmtDec, fmtAngle, bestMonth, wrap360, clamp, vec, SKY_SQDEG } from './math.js';
import { solveImage } from './solve/index.js';

// ---------------------------------------------------------------------------- tiny DOM helper
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export function toast(msg, ms = 3200) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

const SENSORS = [
  ['Full frame · 36 × 24 mm', 36, 24], ['APS-C · 23.5 × 15.6 mm', 23.5, 15.6], ['APS-C Canon · 22.3 × 14.9 mm', 22.3, 14.9],
  ['Micro Four Thirds · 17.3 × 13 mm', 17.3, 13], ['1-inch · 13.2 × 8.8 mm', 13.2, 8.8],
  ['IMX571 (ASI2600, 268M) · 23.5 × 15.7 mm', 23.5, 15.7], ['IMX533 (ASI533) · 11.3 × 11.3 mm', 11.31, 11.31],
  ['IMX294 (ASI294) · 19.1 × 13 mm', 19.1, 13], ['IMX183 (ASI183) · 13.2 × 8.8 mm', 13.2, 8.8],
  ['IMX585 (ASI585) · 11.2 × 6.3 mm', 11.2, 6.3], ['IMX462 / IMX290 · 5.6 × 3.2 mm', 5.6, 3.2],
  ['Seestar S50 (IMX462) · 5.6 × 3.2 mm', 5.6, 3.2], ['Medium format 44 × 33 mm', 43.8, 32.9],
];
const pct = (x) => (x >= 10 ? x.toFixed(1) : x >= 0.1 ? x.toFixed(2) : x > 0 ? x.toFixed(3) : '0');
const num = (x) => Math.round(x).toLocaleString();

export function initUI(app) {
  const { view } = app;
  const body = document.getElementById('tab-body');
  const ui = { tab: 'photos', filter: 'all', query: '', openPhoto: null, gearOpen: !store.state.gear.focal };

  // -------------------------------------------------------------------------- actions
  const select = (objectId, fly = true) => {
    view.selection.objectId = objectId;
    const o = catalog.byId.get(objectId);
    if (o && fly) {
      const size = o.a ? o.a / 60 : 0.3;
      view.flyTo(o.ra, o.dec, clamp(Math.max(size * 6, 8), 3, Math.min(view.cam.fov, 60)));
    }
    renderCard(); render(); view.requestDraw();
  };

  const toggleMark = (id) => {
    const had = !!store.state.marks[id];
    store.update((s) => { if (had) delete s.marks[id]; else s.marks[id] = { at: new Date().toISOString().slice(0, 10) }; });
  };

  const selectPhoto = (id, open = true) => {
    view.selection.photoId = id;
    ui.openPhoto = open ? id : ui.openPhoto;
    view.adjusting = !!id && ui.openPhoto === id;
    render(); view.requestDraw();
  };

  view.onPick = ({ objectId, photoId }) => {
    if (objectId) { select(objectId, false); return; }
    if (photoId) { ui.tab = 'photos'; syncTabs(); selectPhoto(photoId); return; }
    if (view.selection.objectId) { view.selection.objectId = null; renderCard(); render(); view.requestDraw(); }
  };
  view.onPhotoEdit = (p, final) => {
    if (final) store.update(() => { p.solved = null; }, 'data ui'); // moved by hand: no longer the solver's answer
  };

  // -------------------------------------------------------------------------- plate solving
  const solving = new Map();   // photo id -> status text while the solver works on it
  const solveNote = new Map(); // photo id -> why the last attempt failed
  let solveChain = Promise.resolve();
  const setSolveStatus = (id, text) => {
    solving.set(id, text);
    const el = document.querySelector(`[data-solve="${id}"]`);
    if (el) el.textContent = text;
  };
  /** Place a photo from its own stars. Needs a rough position first (a target). A failed solve changes nothing. */
  function solvePhoto(p, { announce = true } = {}) {
    if (p.ra == null || solving.has(p.id) || withoutPixels.has(p.id)) return;
    solving.set(p.id, 'Waiting for the solver…');
    solveNote.delete(p.id);
    render();
    solveChain = solveChain.then(async () => {
      if (!store.state.photos.includes(p)) { solving.delete(p.id); return; }
      try {
        const blob = await blobs.get(p.id);
        if (!blob) throw new Error('This photo’s pixels are not stored in this browser.');
        setSolveStatus(p.id, 'Finding stars…');
        const r = await solveImage(blob, {
          hint: vec(p.ra, p.dec), fov: p.fovW || 3,
          fovKnown: !!gearFov(store.state.gear) || p.fovAuto === false,
          onProgress: (s) => {
            if (s.stage === 'matching') setSolveStatus(p.id, s.lo ? `Matching ${s.stars} stars · trying ${fmtAngle(s.lo)}–${fmtAngle(s.hi)} fields` : `Matching ${s.stars} stars…`);
          },
        });
        solving.delete(p.id);
        if (!store.state.photos.includes(p)) return;
        store.update(() => { Object.assign(p, { ra: r.ra, dec: r.dec, rot: r.rot, fovW: r.fovW, flip: r.flip, fovAuto: false, solved: { matched: r.matched } }); });
        if (announce) toast(`Placed from its stars: ${r.matched} matched.`);
        if (view.selection.photoId === p.id) view.flyTo(p.ra, p.dec, clamp(p.fovW * 2.6, 1, 90));
      } catch (err) {
        solving.delete(p.id);
        solveNote.set(p.id, err.message);
        if (err.detail) console.info(`Atlastellar solver, ${p.name}: ${err.detail}`);
        render();
      }
    });
  }

  // -------------------------------------------------------------------------- shared widgets
  function targetInput(value, onChoose, placeholder = 'Search: M31, NGC 7000, Rosette…') {
    const list = h('ul', { hidden: true });
    let results = [], active = 0;
    const input = h('input', { type: 'search', value, placeholder, autocomplete: 'off', spellcheck: false });
    const show = () => {
      results = search(input.value, 12);
      list.replaceChildren(...results.map((o, i) => h('li', { class: i === active ? 'active' : '', onmousedown: (e) => { e.preventDefault(); choose(o); } },
        h('span', {}, title(o)), h('small', {}, `${TYPE_LABEL[o.t]} · ${o.con}`))));
      list.hidden = !results.length;
    };
    const choose = (o) => { input.value = title(o); list.hidden = true; onChoose(o); };
    input.addEventListener('input', () => { active = 0; show(); });
    input.addEventListener('focus', () => { input.select(); });
    input.addEventListener('blur', () => { list.hidden = true; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { active = clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, results.length - 1); show(); e.preventDefault(); }
      if (e.key === 'Enter' && results[active]) choose(results[active]);
    });
    return h('div', { class: 'suggest' }, input, list);
  }

  const field = (text, control) => h('label', { class: 'field' }, h('span', {}, text), control);
  const toggle = (text, checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), text);

  function slider(text, value, min, max, step, fmt, oninput) {
    const out = h('b', {}, fmt(value));
    return h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', { class: 'grow' }, text), out),
      h('input', { type: 'range', min, max, step, value, oninput: (e) => { out.textContent = fmt(+e.target.value); oninput(+e.target.value); }, onchange: () => store.update(() => {}, 'data') }));
  }

  // -------------------------------------------------------------------------- Photos tab
  function gearCard() {
    const g = store.state.gear, fov = gearFov(g);
    const summary = fov ? `${g.focal} mm · ${fmtAngle(fov.w)} × ${fmtAngle(fov.h)}` : 'Not set yet';
    const setGear = (patch) => store.update((s) => {
      Object.assign(s.gear, patch);
      for (const p of s.photos) if (p.fovAuto && p.objectId) p.fovW = defaultFov(p, catalog.byId.get(p.objectId), s.gear);
    });
    const head = h('div', { class: 'row', style: 'cursor:pointer', onclick: () => { ui.gearOpen = !ui.gearOpen; render(); } },
      h('div', { class: 'grow' }, h('strong', {}, 'Your gear'), h('div', { class: 'muted' }, summary)),
      h('span', { class: 'icon-btn' }, ui.gearOpen ? '▴' : '▾'));
    if (!ui.gearOpen) return h('div', { class: 'card' }, head);
    const preset = h('select', { onchange: (e) => { const s = SENSORS[+e.target.value]; if (s) setGear({ preset: s[0], sensorW: s[1], sensorH: s[2] }); else setGear({ preset: 'custom' }); } },
      h('option', { value: '' }, 'Choose a sensor…'),
      SENSORS.map((s, i) => h('option', { value: i, selected: g.preset === s[0] }, s[0])),
      h('option', { value: 'custom', selected: g.preset === 'custom' }, 'Custom size…'));
    return h('div', { class: 'card stack' }, head,
      field('Focal length (mm)', h('input', { type: 'number', min: 1, step: 'any', value: g.focal ?? '', placeholder: 'e.g. 250', onchange: (e) => setGear({ focal: +e.target.value || null }) })),
      field('Camera sensor', preset),
      g.preset === 'custom' && h('div', { class: 'cols' },
        field('Sensor width (mm)', h('input', { type: 'number', min: 0.1, step: 'any', value: g.sensorW ?? '', onchange: (e) => setGear({ sensorW: +e.target.value || null }) })),
        field('Sensor height (mm)', h('input', { type: 'number', min: 0.1, step: 'any', value: g.sensorH ?? '', onchange: (e) => setGear({ sensorH: +e.target.value || null }) }))),
      h('p', { class: 'muted', style: 'margin-bottom:0' }, fov
        ? `Each frame covers ${fmtAngle(fov.w)} × ${fmtAngle(fov.h)} of sky. New photos start at this size, and objects you tick without a photo count one frame each.`
        : 'Set this once so photos start at the right size and ticked objects count a real frame of sky.'));
  }

  async function handleFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|avif)$/i.test(f.name));
    if (!list.length) { toast('Those files are not images this browser can open (JPEG, PNG, WebP, AVIF).'); return; }
    toast(`Adding ${list.length} photo${list.length > 1 ? 's' : ''}…`, 60000);
    const r = await addFiles(list, view.renderer);
    const placed = r.added.filter((p) => p.ra != null);
    const parts = [];
    if (r.added.length) parts.push(`${r.added.length} added${placed.length ? `, ${placed.length} placed from the file name` : ''}`);
    if (r.failed.length) parts.push(`${r.failed.length} could not be opened`);
    if (r.skipped) parts.push(`${r.skipped} over the ${MAX_PHOTOS}-photo limit`);
    toast(parts.join(' · ') || 'Nothing added.');
    if (r.added.length) {
      const first = placed[0] || r.added[0];
      selectPhoto(first.id);
      if (first.ra != null) view.flyTo(first.ra, first.dec, clamp(first.fovW * 3.5, 2, 90));
      for (const p of placed) solvePhoto(p, { announce: placed.length === 1 });
    }
  }

  function dropZone(compact) {
    const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/avif', multiple: true, hidden: true, onchange: (e) => { handleFiles(e.target.files); e.target.value = ''; } });
    const zone = h('div', { class: 'drop' },
      !compact && h('strong', {}, 'Add your photos'),
      !compact && h('div', { class: 'muted' }, 'Drag them here, or choose them from your device.'),
      h('button', { class: `btn ${compact ? '' : 'primary'}`, onclick: () => input.click() }, compact ? '+ Add more photos' : 'Choose photos'),
      !compact && h('div', { class: 'muted', style: 'margin-top:10px' }, `JPEG, PNG, WebP or AVIF · up to ${MAX_PHOTOS} photos`), input);
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); handleFiles(e.dataTransfer.files); });
    if (compact) { zone.style.padding = '10px'; zone.querySelector('.btn').style.marginTop = '0'; }
    return zone;
  }

  function photoCard(p) {
    const obj = catalog.byId.get(p.objectId), open = ui.openPhoto === p.id, placed = p.ra != null;
    const live = (fn) => { fn(); view.requestDraw(); };
    const head = h('div', { class: 'photo-head', onclick: () => {
      ui.openPhoto = open ? null : p.id; view.selection.photoId = p.id; view.adjusting = !open;
      if (!open && placed) view.flyTo(p.ra, p.dec, clamp(p.fovW * 3.5, 2, Math.max(view.cam.fov, 20)));
      render(); view.requestDraw();
    } },
      h('img', { src: p.thumb, alt: '' }),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, p.label || (obj ? title(obj) : p.name)),
        h('div', { class: 'row', style: 'gap:6px;margin-top:3px' },
          solving.has(p.id) ? h('span', { class: 'badge warn' }, 'Matching stars…')
            : placed ? h('span', { class: 'badge ok' }, p.solved ? `✓ Solved · ${p.solved.matched} stars` : '✓ Placed') : h('span', { class: 'badge warn' }, 'Needs a target'),
          placed && h('span', { class: 'muted' }, `${fmtAngle(p.fovW)} × ${fmtAngle(p.fovW / p.aspect)}`),
          withoutPixels.has(p.id) && h('span', { class: 'badge' }, 'outline only'))),
      h('button', { class: `icon-btn ${p.visible === false ? 'off' : ''}`, title: p.visible === false ? 'Show on the sky' : 'Hide on the sky', 'aria-label': 'Toggle visibility',
        onclick: (e) => { e.stopPropagation(); store.update(() => { p.visible = p.visible === false; }, 'ui sky'); } }, p.visible === false ? '◌' : '●'),
      h('button', { class: 'icon-btn', title: 'Remove photo', 'aria-label': 'Remove photo', onclick: (e) => { e.stopPropagation(); if (view.selection.photoId === p.id) view.selection.photoId = null; removePhoto(p.id, view.renderer); } }, '✕'));
    if (!open) return h('div', { class: `card photo ${view.selection.photoId === p.id ? 'selected' : ''}` }, head);

    const bodyEl = h('div', { class: 'photo-body stack' },
      field('Target', targetInput(obj ? title(obj) : '', (o) => {
        store.update(() => { placeOn(p, o, store.state.gear); p.solved = null; });
        solvePhoto(p);
        view.flyTo(p.ra, p.dec, clamp(p.fovW * 3.5, 2, 90));
      })),
      !placed && h('p', { class: 'muted', style: 'margin:0' }, 'Name what this photo shows. Atlastellar then matches its stars to the catalogue and places it exactly; if that fails you can line it up by hand.'),
      placed && [
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: solving.has(p.id) || withoutPixels.has(p.id), onclick: () => solvePhoto(p) }, 'Find from stars'),
          h('span', { class: 'muted grow', 'data-solve': p.id }, solving.get(p.id)
            || (p.solved ? `Placed exactly, from ${p.solved.matched} matched stars.`
              : solveNote.has(p.id) ? `${solveNote.get(p.id)} Line it up by hand below.`
                : 'Matches this photo’s stars to the catalogue.'))),
        field('Label on the sky', h('input', { type: 'text', value: p.label || '', placeholder: obj ? label(obj) : p.name, onchange: (e) => store.update(() => { p.label = e.target.value.trim(); }, 'ui sky') })),
        slider('Field width', p.fovW, 0.05, 120, 0.01, (v) => fmtAngle(v), (v) => live(() => { p.fovW = v; p.fovAuto = false; p.solved = null; })),
        slider('Rotation', p.rot || 0, 0, 360, 0.1, (v) => `${v.toFixed(1)}°`, (v) => live(() => { p.rot = v; p.solved = null; })),
        h('div', { class: 'cols' },
          slider('Opacity', p.opacity ?? 1, 0.1, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => live(() => { p.opacity = v; })),
          slider('Soft edge', p.feather ?? 0.08, 0, 0.35, 0.005, (v) => `${Math.round(v * 100)}%`, (v) => live(() => { p.feather = v; }))),
        slider('Melt dark background into the sky', p.melt ?? 0, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => live(() => { p.melt = v; })),
        h('div', { class: 'row' },
          toggle('Mirrored', !!p.flip, (v) => store.update(() => { p.flip = v; p.solved = null; }, 'data')),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: () => view.flyTo(p.ra, p.dec, clamp(p.fovW * 2.2, 1, 90)) }, 'Zoom to photo')),
        h('p', { class: 'muted', style: 'margin:0' }, 'By hand, on the sky: drag the photo to move it · Shift + drag to rotate · Shift + scroll to resize, until its stars sit in the rings.'),
        h('details', {}, h('summary', { class: 'muted', style: 'cursor:pointer' }, 'Exact position (from a plate solve)'),
          h('div', { class: 'cols', style: 'margin-top:8px' },
            field('RA (degrees)', h('input', { type: 'number', step: 'any', value: +p.ra.toFixed(4), onchange: (e) => store.update(() => { p.ra = wrap360(+e.target.value || 0); }) })),
            field('Dec (degrees)', h('input', { type: 'number', step: 'any', value: +p.dec.toFixed(4), onchange: (e) => store.update(() => { p.dec = clamp(+e.target.value || 0, -90, 90); }) })),
            field('Field width (degrees)', h('input', { type: 'number', step: 'any', value: +p.fovW.toFixed(4), onchange: (e) => store.update(() => { p.fovW = clamp(+e.target.value || 1, 0.02, 170); p.fovAuto = false; }) })),
            field('Rotation (degrees E of N)', h('input', { type: 'number', step: 'any', value: +(p.rot || 0).toFixed(2), onchange: (e) => store.update(() => { p.rot = wrap360(+e.target.value || 0); }) })))),
      ]);
    return h('div', { class: 'card photo selected' }, head, bodyEl);
  }

  function photosTab() {
    const photos = store.state.photos;
    return [
      h('div', { class: 'section' }, gearCard()),
      h('div', { class: 'section' }, dropZone(photos.length > 0)),
      photos.length
        ? h('div', { class: 'section' }, photos.map(photoCard))
        : h('div', { class: 'section' }, h('h2', {}, 'How it works'), h('ol', { class: 'steps' },
          h('li', {}, 'Add your astrophotos. Files named like “M31.jpg” place themselves.'),
          h('li', {}, 'Name each photo’s target. It then finds its exact place from its own stars.'),
          h('li', {}, 'No photos handy? Tick what you have shot in the Catalogue tab.'),
          h('li', {}, 'Watch your share of the sky grow, then download your poster.'))),
    ];
  }

  // -------------------------------------------------------------------------- Catalogue tab
  function objRow(o, tag) {
    const how = app.stats.captured.get(o.id);
    const marked = !!store.state.marks[o.id];
    const tick = h('button', {
      class: `tick ${marked || how === 'photo' ? 'on' : how === 'frame' ? 'frame' : ''}`,
      title: how === 'frame' ? 'Already inside one of your photos' : how === 'photo' ? 'You have a photo of this' : marked ? 'Captured — click to undo' : 'Mark as captured',
      'aria-label': `Mark ${desig(o)} as captured`, 'aria-pressed': String(!!how),
      onclick: (e) => { e.stopPropagation(); if (how === 'photo' || how === 'frame') { toast('Counted because it is in one of your photos.'); return; } toggleMark(o.id); },
    }, '✓');
    return h('li', { class: `obj ${view.selection.objectId === o.id ? 'selected' : ''}`, onclick: () => select(o.id) },
      tick, h('span', { class: 'id' }, tag || desig(o)),
      h('div', { class: 'grow' }, h('div', { class: 'nm' }, o.n || (tag ? o.d : TYPE_LABEL[o.t])),
        h('div', { class: 'meta' }, [TYPE_LABEL[o.t], catalog.conName.get(o.con) || o.con, o.mag != null && `mag ${o.mag}`].filter(Boolean).join(' · '))));
  }

  function catalogTab() {
    const st = store.state.settings;
    const list = catalog.lists.find((l) => l.id === st.list) || catalog.lists[0];
    const listEl = h('ul', { class: 'obj-list' });
    const fill = () => {
      const q = ui.query.trim();
      if (q) {
        const res = search(q, 60);
        listEl.replaceChildren(...(res.length ? res.map((o) => objRow(o)) : [h('li', { class: 'muted', style: 'padding:10px 6px' }, 'Nothing found. Try a number (M 42, NGC 7000) or a name (Veil).')]));
        return;
      }
      let items = list.items.map((it) => ({ it, o: catalog.byId.get(it.o) })).filter((x) => x.o);
      if (ui.filter === 'done') items = items.filter((x) => app.stats.captured.has(x.o.id));
      if (ui.filter === 'todo') items = items.filter((x) => !app.stats.captured.has(x.o.id));
      listEl.replaceChildren(...(items.length ? items.map((x) => objRow(x.o, x.it.n)) : [h('li', { class: 'muted', style: 'padding:10px 6px' }, ui.filter === 'done' ? 'Nothing ticked yet. Tap the circle next to anything you have photographed.' : 'All done. Clear skies!')]));
    };
    const searchBox = h('input', { type: 'search', value: ui.query, placeholder: 'Search 2,500 objects: M 42, NGC 7000, Veil…', oninput: (e) => { ui.query = e.target.value; fill(); } });
    fill();
    return [
      h('div', { class: 'section' },
        h('p', { class: 'muted', style: 'margin-top:0' }, 'Tick everything you have photographed. No photo needed.'),
        searchBox),
      h('div', { class: 'section' },
        h('div', { class: 'seg' }, catalog.lists.map((l) => {
          const s = app.stats.lists.find((x) => x.id === l.id);
          return h('button', { 'aria-pressed': String(l.id === list.id), onclick: () => { ui.query = ''; store.update((x) => { x.settings.list = l.id; }, 'ui sky'); } }, `${l.name} ${s.done}/${s.total}`);
        })),
        h('p', { class: 'muted', style: 'margin:8px 0' }, list.blurb),
        h('div', { class: 'seg' }, [['all', 'All'], ['todo', 'Still to shoot'], ['done', 'Captured']].map(([id, text]) =>
          h('button', { 'aria-pressed': String(ui.filter === id), onclick: () => { ui.filter = id; render(); } }, text))),
        listEl),
    ];
  }

  // -------------------------------------------------------------------------- Stats tab
  const statRow = (name, value, fraction) => h('div', { class: 'stat-row' }, h('span', {}, name), h('b', {}, value),
    h('div', { class: 'bar' }, h('i', { style: `width:${clamp(fraction * 100, 0, 100)}%` })));

  function statsTab() {
    const s = app.stats, st = store.state, month = new Date().getMonth();
    const empty = !s.captured.size && !s.photos;
    const passport = (l) => h('div', { class: 'passport' }, catalog.lists.find((x) => x.id === l.id).items.map((it) =>
      h('button', { class: s.captured.has(it.o) ? 'on' : '', title: title(catalog.byId.get(it.o)), onclick: () => select(it.o) }, it.n.slice(1))));
    const cons = s.con.filter((c) => c.visited).sort((a, b) => b.pct - a.pct);
    const order = ['galaxy', 'nebula', 'open', 'globular', 'planetary', 'snr', 'dark', 'star', 'other'];
    // What to shoot next: uncaptured list objects that are well placed around midnight this month or next.
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const inSeason = new Set([months[month], months[(month + 1) % 12]]);
    const next = [];
    for (const l of catalog.lists) for (const it of l.items) {
      const o = catalog.byId.get(it.o);
      if (!s.captured.has(o.id) && inSeason.has(bestMonth(o.ra)) && !next.some((n) => n.o === o)) next.push({ o, tag: it.n });
    }
    next.sort((a, b) => (a.o.mag ?? 99) - (b.o.mag ?? 99));

    return [
      h('div', { class: 'section card hero' },
        h('div', { class: 'big' }, `${pct(s.pct)}%`),
        h('div', { class: 'sub' }, 'of the entire night sky captured'),
        h('div', { class: 'muted', style: 'margin-top:8px' }, empty ? 'Tick an object or add a photo to start.' : `${s.sqdeg < 10 ? s.sqdeg.toFixed(2) : num(s.sqdeg)} of ${num(SKY_SQDEG)} square degrees · about ${num(s.moons)} full Moons`)),
      h('div', { class: 'section kv' },
        h('div', {}, h('b', {}, s.captured.size), h('span', {}, 'objects')),
        h('div', {}, h('b', {}, `${s.conVisited}/88`), h('span', {}, 'constellations')),
        h('div', {}, h('b', {}, s.photos), h('span', {}, 'photos placed'))),
      s.marksWithoutArea && h('p', { class: 'muted section' }, 'Tip: set your gear in the Photos tab. Ticked objects then count a full frame of sky instead of just their own size.'),
      s.lists.map((l) => h('div', { class: 'section card' },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, l.name), h('b', {}, `${l.done} / ${l.total}`)),
        h('div', { class: 'bar', style: 'margin-top:8px' }, h('i', { style: `width:${(100 * l.done) / l.total}%` })),
        passport(l))),
      h('div', { class: 'section card' }, h('h2', {}, 'Where on the sky'),
        statRow('Northern hemisphere', `${pct(s.northPct)}%`, s.northPct / 100),
        statRow('Southern hemisphere', `${pct(s.southPct)}%`, s.southPct / 100),
        statRow('Milky Way band (±10°)', `${pct(s.bandPct)}%`, s.bandPct / 100)),
      s.captured.size > 0 && h('div', { class: 'section card' }, h('h2', {}, 'What you shoot'),
        order.filter((t) => s.byType[t]).map((t) => statRow(TYPE_PLURAL[t], s.byType[t], s.byType[t] / s.captured.size))),
      cons.length > 0 && h('div', { class: 'section card' }, h('h2', {}, `Constellations · ${s.conVisited} of 88`),
        cons.slice(0, 8).map((c) => statRow(c.name, c.pct > 0 ? `${pct(c.pct)}%` : 'visited', c.pct / 100)),
        cons.length > 8 && h('p', { class: 'muted', style: 'margin:6px 0 0' }, `…and ${cons.length - 8} more`)),
      next.length > 0 && h('div', { class: 'section' }, h('h2', {}, `Up next · high at midnight in ${months[month]}`),
        h('ul', { class: 'obj-list', style: 'margin-top:0' }, next.slice(0, 6).map((n) => objRow(n.o, n.tag)))),
      h('p', { class: 'muted' }, st.photos.length || gearFov(st.gear)
        ? 'Photos count their real footprint; overlaps count once. Ticked objects without a photo count one frame of your gear.'
        : 'Photos count their real footprint. Ticked objects count their own size until you set your gear.'),
    ];
  }

  // -------------------------------------------------------------------------- Export tab
  const exp = { region: 'sky', width: 4096, title: 'My night sky', format: 'image/jpeg', footer: true };
  function exportTab() {
    const big = view.renderer.maxTex >= 8192;
    const go = h('button', { class: 'btn primary block', onclick: async () => {
      go.disabled = true; go.textContent = 'Rendering…';
      await new Promise((r) => setTimeout(r, 30));
      try {
        const blob = await makePoster(exp, view, app.stats);
        download(blob, `atlastellar-${exp.region}-${exp.width}.${exp.format === 'image/png' ? 'png' : 'jpg'}`);
        toast('Poster saved to your downloads.');
      } catch (err) { toast(err.message || 'Could not render the poster.'); }
      go.disabled = false; go.textContent = 'Download poster';
    } }, 'Download poster');
    const importer = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async (e) => {
      try { const n = store.importJSON(await e.target.files[0].text()); toast(`Imported. ${n} ticked objects in the file.`); } catch (err) { toast(err.message); }
      e.target.value = '';
    } });
    return [
      h('div', { class: 'section card stack' }, h('h2', {}, 'Poster'),
        field('Title', h('input', { type: 'text', value: exp.title, maxLength: 60, oninput: (e) => { exp.title = e.target.value; } })),
        field('Region', h('select', { onchange: (e) => { exp.region = e.target.value; } }, Object.entries(REGIONS).map(([id, r]) => h('option', { value: id, selected: exp.region === id }, `${r.name} — ${r.hint}`)))),
        h('div', { class: 'cols' },
          field('Width', h('select', { onchange: (e) => { exp.width = +e.target.value; } },
            [[2048, '2K · 2048 px'], [4096, '4K · 4096 px'], big && [8192, '8K · 8192 px']].filter(Boolean).map(([v, t]) => h('option', { value: v, selected: exp.width === v }, t)))),
          field('Format', h('select', { onchange: (e) => { exp.format = e.target.value; } },
            h('option', { value: 'image/jpeg', selected: exp.format === 'image/jpeg' }, 'JPEG'), h('option', { value: 'image/png', selected: exp.format === 'image/png' }, 'PNG (large)')))),
        toggle('Footer with your stats', exp.footer, (v) => { exp.footer = v; }),
        go,
        h('p', { class: 'muted', style: 'margin-bottom:0' }, 'The poster uses the layers switched on in the sky view (figures, names, objects).')),
      h('div', { class: 'section card stack' }, h('h2', {}, 'Your sky log'),
        h('p', { class: 'muted', style: 'margin:0' }, 'A small file with your gear, ticked objects and photo placements (not the photos themselves). Keep it as a backup or move it to another browser.'),
        h('div', { class: 'cols' },
          h('button', { class: 'btn', onclick: () => download(new Blob([store.exportJSON()], { type: 'application/json' }), 'atlastellar-sky-log.json') }, 'Save file'),
          h('button', { class: 'btn', onclick: () => importer.click() }, 'Open file')), importer),
      h('div', { class: 'section muted' }, h('h2', {}, 'Credits'),
        h('p', {}, 'Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 (Gaia DR2: ESA/Gaia/DPAC).'),
        h('p', {}, 'Stars and constellation figures: d3-celestial by Olaf Frohn (BSD-3-Clause). Deep-sky objects: OpenNGC by Mattia Verga (CC-BY-SA-4.0). Coordinates are J2000.'),
        h('p', {}, 'Atlastellar is open source. Ideas, catalogues and fixes are welcome.')),
    ];
  }

  // -------------------------------------------------------------------------- object card on the sky
  const card = document.getElementById('card');
  function renderCard() {
    const o = catalog.byId.get(view.selection.objectId);
    card.hidden = !o;
    if (!o) return;
    const how = app.stats.captured.get(o.id), fov = gearFov(store.state.gear);
    const tags = [o.m && `M${o.m}`, o.c && `Caldwell ${o.c}`, o.d].filter(Boolean);
    const facts = [TYPE_LABEL[o.t], catalog.conName.get(o.con) || o.con, o.mag != null && `mag ${o.mag}`, o.a && (o.b && o.b !== o.a ? `${fmtAngle(o.a / 60)} × ${fmtAngle(o.b / 60)}` : fmtAngle(o.a / 60))].filter(Boolean);
    let framing = null;
    if (fov && o.a) {
      const fill = (o.a / 60) / Math.max(fov.w, fov.h);
      framing = fill > 1.15 ? `Larger than your ${fmtAngle(fov.w)} frame — a mosaic target.` : fill > 0.25 ? `Fills about ${Math.round(fill * 100)}% of your frame.` : `Small in your ${fmtAngle(fov.w)} frame (${Math.round(fill * 100)}% of its width).`;
    }
    card.replaceChildren(
      h('button', { class: 'icon-btn close', 'aria-label': 'Close', onclick: () => { view.selection.objectId = null; renderCard(); render(); view.requestDraw(); } }, '✕'),
      h('h3', {}, o.n || desig(o)),
      h('div', { class: 'facts' }, `${[...new Set(tags)].join(' · ')} — ${facts.join(' · ')}`),
      h('div', { class: 'muted', style: 'margin-bottom:10px' }, `${fmtRA(o.ra)}  ${fmtDec(o.dec)} · highest at midnight in ${bestMonth(o.ra)}${framing ? ' · ' + framing : ''}`),
      h('div', { class: 'row' },
        how === 'photo' || how === 'frame'
          ? h('span', { class: 'badge ok' }, how === 'photo' ? '✓ You have a photo of this' : '✓ Inside one of your photos')
          : h('button', { class: `btn ${how ? '' : 'primary'}`, onclick: () => toggleMark(o.id) }, how ? '✓ Captured — undo' : 'Mark as captured'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small', onclick: () => view.flyTo(o.ra, o.dec, clamp(Math.max((o.a || 20) / 60 * 5, 4), 2, 40)) }, 'Zoom in')));
  }

  // -------------------------------------------------------------------------- stage chrome
  const hud = document.getElementById('hud');
  hud.addEventListener('click', () => { ui.tab = 'stats'; syncTabs(); render(); });
  function renderHud() {
    const s = app.stats;
    hud.replaceChildren(h('span', {}, h('b', {}, `${pct(s.pct)}%`), ' of the sky'),
      ...s.lists.map((l) => h('span', {}, `${l.name} `, h('b', {}, `${l.done}`), `/${l.total}`)));
  }

  const layers = document.getElementById('layers');
  function renderLayers() {
    const st = store.state.settings;
    layers.replaceChildren(...[['lines', 'Figures'], ['names', 'Names'], ['markers', 'Objects'], ['grid', 'Grid']].map(([k, text]) =>
      h('button', { 'aria-pressed': String(!!st[k]), title: `Show or hide ${text.toLowerCase()}`, onclick: () => store.update((s) => { s.settings[k] = !s.settings[k]; }, 'sky ui') }, text)));
  }
  document.getElementById('zoom-in').addEventListener('click', () => view.flyTo(view.cam.ra, view.cam.dec, view.cam.fov / 1.8, 250));
  document.getElementById('zoom-out').addEventListener('click', () => view.flyTo(view.cam.ra, view.cam.dec, view.cam.fov * 1.8, 250));
  document.getElementById('show-all').addEventListener('click', () => view.flyTo(266.4, -29, 150));
  document.getElementById('clear-all').addEventListener('click', async () => {
    if (!confirm('Remove all photos, ticked objects and gear from this browser? This cannot be undone.')) return;
    for (const p of store.state.photos) view.renderer.removePhotoTexture(p.id);
    view.selection = { objectId: null, photoId: null };
    await store.clearAll();
    toast('Everything cleared.');
  });

  const readout = document.getElementById('readout');
  function renderReadout() {
    readout.textContent = `${fmtRA(view.cam.ra)}  ${fmtDec(view.cam.dec)} · ${fmtAngle(view.cam.fov)} field`;
  }

  // Dropping photos anywhere on the sky works too.
  const stage = document.getElementById('stage');
  stage.addEventListener('dragover', (e) => e.preventDefault());
  stage.addEventListener('drop', (e) => { e.preventDefault(); ui.tab = 'photos'; syncTabs(); handleFiles(e.dataTransfer.files); });
  const hint = document.getElementById('hint');
  stage.addEventListener('pointerdown', () => hint.classList.add('gone'), { once: true });

  // -------------------------------------------------------------------------- tabs
  const tabButtons = [...document.querySelectorAll('.tabs [data-tab]')];
  function syncTabs() { for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)); }
  for (const b of tabButtons) b.addEventListener('click', () => { ui.tab = b.dataset.tab; syncTabs(); body.scrollTop = 0; render(); });

  function render() {
    const keep = body.scrollTop;
    const focused = document.activeElement?.type === 'search' && body.contains(document.activeElement) && ui.tab === 'catalog';
    const content = ui.tab === 'photos' ? photosTab() : ui.tab === 'catalog' ? catalogTab() : ui.tab === 'stats' ? statsTab() : exportTab();
    body.replaceChildren(...content.flat().filter(Boolean));
    body.scrollTop = keep;
    if (focused) { const s = body.querySelector('input[type=search]'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }
    document.getElementById('count-photos').textContent = store.state.photos.length || '';
    const list = catalog.lists.find((l) => l.id === store.state.settings.list) || catalog.lists[0];
    view.listIds = new Set(list.items.map((it) => it.o));
  }

  syncTabs();
  return { render, renderCard, renderHud, renderLayers, renderReadout, ui };
}
