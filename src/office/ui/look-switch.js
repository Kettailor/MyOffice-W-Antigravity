// Switching the character look.
import { state } from '../core/state.js';
import { scene } from '../scene/renderer.js';
import { leaving, npcs, subs, workers } from '../people/workers.js';
import { fp, makeAvatar } from '../interact/first-person.js';

/* ---------- character look (A / B) ---------- */
const devKey = (k) => `${k}:${new URLSearchParams(location.search).get('k') || 'local'}`;
const getPref = (k) => {
  try { return localStorage.getItem(devKey(k)) ?? localStorage.getItem(k); } catch { return null; }
};
const setPref = (k, v) => {
  try { localStorage.setItem(devKey(k), v); localStorage.setItem(k, v); } catch { /* storage blocked */ }
};

export function setLook(l) {
  if (l !== 'toy' && l !== 'pixar') return;
  state.LOOK = l;
  setPref('office-look', l);
  for (const b of document.querySelectorAll('[data-look]')) b.setAttribute('aria-pressed', String(b.dataset.look === l));
  for (const w of [...workers.values(), ...subs.values(), ...leaving, ...npcs]) w.rebuild();
  if (fp.avatar) { scene.remove(fp.avatar); fp.avatar = null; makeAvatar(); }
}

export function setup() {
  const saved = getPref('office-look');
  if ((saved === 'toy' || saved === 'pixar') && saved !== state.LOOK) setLook(saved);
  for (const b of document.querySelectorAll('[data-look]')) b.setAttribute('aria-pressed', String(b.dataset.look === state.LOOK));
}
