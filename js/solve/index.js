// Main-thread side of the plate solver: hand a photo's pixels to the worker and wait for the answer.

import { luminance } from './detect.js';

let worker = null, seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    if (e.data.progress) { job.onProgress(e.data.progress); return; }
    pending.delete(e.data.id);
    if (e.data.error) job.reject(Object.assign(new Error(e.data.error), { detail: e.data.detail })); else job.resolve(e.data.result);
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || 'The solver could not start in this browser.'));
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * Find where an image sits on the sky.
 * @param source  Blob, ImageBitmap, HTMLImageElement or canvas
 * @param opts    { hint: unit vector near the field, fov: field width guess in degrees, fovKnown, onProgress }
 * @returns {Promise<{ ra, dec, rot, fovW, flip, matched, rms, detected, ms }>}
 */
export async function solveImage(source, { hint, fov, fovKnown = false, onProgress = () => {} }) {
  const bitmap = source instanceof Blob ? await createImageBitmap(source) : source;
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (source instanceof Blob) bitmap.close?.();
  const lum = luminance(ctx.getImageData(0, 0, w, h).data, w, h);
  onProgress({ stage: 'detecting' });
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, lum, w, h, hint, fov, fovKnown }, [lum.buffer]);
  });
}
