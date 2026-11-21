// Atlastellar — bootstrap.

import { store } from './store.js';
import { loadCatalog } from './catalog.js';
import { Renderer } from './renderer.js';
import { SkyView } from './view.js';
import { computeStats } from './coverage.js';
import { restorePhotos } from './photos.js';
import { initUI, toast } from './ui.js';

const loading = document.getElementById('loading');

async function bitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return createImageBitmap(await res.blob());
}

async function main() {
  const renderer = new Renderer(document.getElementById('gl'));
  const view = new SkyView(document.getElementById('stage'), renderer, document.getElementById('overlay'));

  // A tiny Milky Way first so there is something to look at immediately.
  bitmap('data/milkyway-1k.jpg').then((b) => { if (!renderer.bgReady) { renderer.setBackground(b); renderer.bgReady = false; view.requestDraw(); } }).catch(() => {});

  const [, stars] = await Promise.all([loadCatalog(), fetch('data/stars.bin').then((r) => r.arrayBuffer())]);
  renderer.setStars(new Float32Array(stars));

  const app = { view, stats: computeStats(store.state) };
  view.captured = app.stats.captured;
  const ui = initUI(app);
  view.onCam = ui.renderReadout;

  store.on((tags) => {
    if (tags.has('data')) {
      app.stats = computeStats(store.state);
      view.captured = app.stats.captured;
      ui.renderHud(); ui.renderCard();
    }
    if (tags.has('ui')) { ui.render(); ui.renderLayers(); }
    view.requestDraw();
  });
  ui.render(); ui.renderHud(); ui.renderLayers(); ui.renderReadout();
  view.requestDraw();
  loading.classList.add('done');

  // Sharper backgrounds as they arrive: 4K everywhere, 8K on desktops that can hold it.
  const roomy = renderer.maxTex >= 8192 && matchMedia('(pointer: fine)').matches && (navigator.deviceMemory ?? 8) >= 8;
  bitmap('data/milkyway-4k.webp').then((b) => {
    renderer.setBackground(b); view.requestDraw();
    if (roomy) return bitmap('data/milkyway-8k.webp').then((b8) => { renderer.setBackground(b8); view.requestDraw(); });
  }).catch((err) => console.warn('Milky Way background failed to load', err));

  restorePhotos(renderer).then(() => { ui.render(); view.requestDraw(); });

  // Handy in the console, and for anyone scripting their own sky.
  window.atlastellar = { store, view, app };
}

main().catch((err) => {
  console.error(err);
  loading.classList.remove('done');
  loading.textContent = `Atlastellar could not start: ${err.message}`;
  toast(err.message, 8000);
});
