// Web Worker: star detection and plate solving off the main thread.

import { detectStars } from './detect.js';
import { solve } from './solver.js';
import { loadDeep, loadBright } from './tiles.js';

self.onmessage = async (e) => {
  const { id, lum, w, h, hint, fov, fovKnown } = e.data;
  try {
    const det = detectStars(lum, w, h);
    self.postMessage({ id, progress: { stage: 'matching', stars: det.length } });
    const result = await solve({ det, w, h, hint, fov, fovKnown }, { deep: loadDeep, bright: loadBright },
      (p) => self.postMessage({ id, progress: { stage: 'matching', stars: det.length, ...p } }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err), detail: err.detail });
  }
};
