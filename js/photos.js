// Bringing photos in: decode, downscale, keep a local copy, guess the target from the file name.

import { store, blobs } from './store.js';
import { catalog } from './catalog.js';
import { gearFov } from './coverage.js';

export const MAX_PHOTOS = 60;
const MAX_SIDE = 2560;   // stored + displayed resolution (long side)
const THUMB = 112;

/** Photo ids whose pixels are not available here (e.g. imported from a sky-log file). */
export const withoutPixels = new Set();

async function toCanvas(bitmap, maxSide) {
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s)); c.height = Math.max(1, Math.round(bitmap.height * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}

const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

/** Find a catalogue object named in a file name: "M31_final.jpg", "ngc-7000 ha.png", "Rosette Nebula.jpg". */
export function guessTarget(filename) {
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/(?<![a-z0-9])(messier|ngc|ic|m)[\s_-]?(\d{1,4})(?!\d)/i);
  if (m) {
    const key = `${m[1].toLowerCase() === 'messier' ? 'm' : m[1].toLowerCase()}${+m[2]}`;
    const hit = catalog.objects.find((o) => o.key.includes(key));
    if (hit) return hit;
  }
  const words = ` ${base.toLowerCase().replace(/[_\-.]+/g, ' ')} `;
  let best = null;
  for (const o of catalog.objects) {
    if (!o.n || o.n.length < 5) continue;
    const n = o.n.toLowerCase().replace(/ (nebula|galaxy|cluster)$/, '');
    if (n.length >= 4 && words.includes(` ${n}`) && (!best || n.length > best.len)) best = { o, len: n.length };
  }
  return best?.o || null;
}

/** A sensible field width (degrees) for a photo of this object. */
export function defaultFov(photo, obj, gear) {
  const g = gearFov(photo.focal ? { ...gear, focal: photo.focal } : gear);
  if (g) {
    // The sensor's long side follows the image's long side.
    const long = Math.max(g.w, g.h), short = Math.min(g.w, g.h);
    return photo.aspect >= 1 ? long : short;
  }
  if (obj?.a) return Math.min(60, Math.max(0.4, (obj.a / 60) * 3));
  return 2;
}

/** Centre a photo on an object (keeps any rotation the user already set). */
export function placeOn(photo, obj, gear) {
  photo.objectId = obj.id;
  photo.ra = obj.ra; photo.dec = obj.dec;
  if (photo.fovAuto !== false) { photo.fovW = defaultFov(photo, obj, gear); photo.fovAuto = true; }
}

export async function addFiles(files, renderer) {
  const result = { added: [], failed: [], skipped: 0 };
  for (const file of files) {
    if (store.state.photos.length + result.added.length >= MAX_PHOTOS) { result.skipped++; continue; }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { result.failed.push(file.name); continue; }
    const canvas = await toCanvas(bitmap, Math.min(MAX_SIDE, renderer.maxTex));
    const thumb = (await toCanvas(bitmap, THUMB)).toDataURL('image/jpeg', 0.7);
    bitmap.close?.();
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const blob = await toBlob(canvas, 'image/jpeg', 0.92);
    try { await blobs.put(id, blob); } catch { /* storage full: the photo still works for this session */ }
    renderer.setPhotoTexture(id, canvas);
    const photo = {
      id, name: file.name.replace(/\.[a-z0-9]+$/i, ''), objectId: null, label: '', ra: null, dec: null, rot: 0,
      fovW: null, fovAuto: true, aspect: canvas.width / canvas.height, flip: false, opacity: 1, feather: 0.08, melt: 0,
      visible: true, thumb,
    };
    const guess = guessTarget(file.name);
    if (guess) placeOn(photo, guess, store.state.gear);
    result.added.push(photo);
  }
  if (result.added.length) store.update((s) => { s.photos.push(...result.added); });
  return result;
}

/** Re-create textures for photos saved in an earlier session. */
export async function restorePhotos(renderer) {
  await Promise.all(store.state.photos.map(async (p) => {
    try {
      const blob = await blobs.get(p.id);
      if (!blob) { withoutPixels.add(p.id); return; }
      const bitmap = await createImageBitmap(blob);
      renderer.setPhotoTexture(p.id, bitmap);
      bitmap.close?.();
    } catch { withoutPixels.add(p.id); }
  }));
}

export function removePhoto(id, renderer) {
  renderer.removePhotoTexture(id);
  blobs.del(id).catch(() => {});
  withoutPixels.delete(id);
  store.update((s) => { s.photos = s.photos.filter((p) => p.id !== id); });
}
