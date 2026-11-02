// Graphics quality: Auto (the default), Low, Medium or High, each viewer's own choice (Settings → Display).
//   High:   up to 2× resolution on Retina screens, soft shadows, 4× MSAA, bloom at night.
//   Medium: up to 1.5×, plain shadows from a smaller map, 2× MSAA, bloom at night.
//   Low:    1×, no shadows, no post-processing (one plain draw), 30 frames a second.
// Auto starts from what the device looks like (a phone: Low, its CPU is what runs out first, measured at 15 fps on
// Medium with the main thread full; a tablet or a narrow window: Medium; no GPU: Low; else High). When frames keep arriving late
// even at the lowest resolution step, it goes down one level and remembers that for this device. A remembered level is
// tried one step higher again after three days, so a busy afternoon does not cap the office for good.
import * as THREE from 'three';
import { SOFTWARE_GL, bloom, camera, composer, renderer, scene } from './renderer.js';
import { sun } from './lights.js';

export const LEVELS = ['low', 'medium', 'high'];
const PRESET = {
  high: { prMax: 2, shadows: true, soft: true, map: 2048, msaa: 4, plain: false, bloom: true, fps: 60 },
  medium: { prMax: 1.35, shadows: true, soft: false, map: 1024, msaa: 0, plain: true, bloom: false, fps: 60 },
  low: { prMax: 1, shadows: false, soft: false, map: 512, msaa: 0, plain: true, bloom: false, fps: 30 },
};
const KEY = 'office-quality-v2';
// choice: what the viewer picked ('auto' or a level); level: what is in use; plain: draw without post-processing
export const quality = { choice: 'auto', level: 'medium', plain: true, bloom: false, fps: 60, prMax: 1.35 };
const listeners = new Set();

const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };
/** A phone: a touch screen whose short side is under 600 px (a tablet is not one). */
let phone = null;
export const phoneLike = () => (phone ??= matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
function autoStart() {
  if (SOFTWARE_GL) return 'low';
  if (phoneLike()) return 'low';
  return 'medium';
}

function apply(level) {
  const p = PRESET[level];
  const useBloom = !!p.bloom && quality.choice === 'high' && !SOFTWARE_GL;
  Object.assign(quality, { level, bloom: useBloom, plain: p.plain || !useBloom || SOFTWARE_GL, fps: p.fps, prMax: SOFTWARE_GL ? 0.5 : p.prMax });
  if (bloom) bloom.enabled = useBloom;
  if (!SOFTWARE_GL) {
    sun.castShadow = p.shadows;
    const type = p.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (renderer.shadowMap.type !== type) renderer.shadowMap.type = type;
    if (sun.shadow.mapSize.x !== p.map) { sun.shadow.mapSize.set(p.map, p.map); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
    for (const rt of [composer.renderTarget1, composer.renderTarget2]) if (rt.samples !== p.msaa) { rt.samples = p.msaa; rt.dispose(); }
  }
  for (const fn of listeners) fn(quality);
}

/** Draws one frame with the current quality: through the post-processing chain, or plainly when it is off. */
export function drawFrame(cam = camera) {
  if (quality.plain || !quality.bloom || !bloom?.enabled) renderer.render(scene, cam); else composer.render();
}
/** The viewer picked a level (or 'auto') in Settings. */
export function setQuality(choice) {
  if (choice !== 'auto' && !LEVELS.includes(choice)) return;
  quality.choice = choice; store.set(KEY, choice);
  apply(choice === 'auto' ? autoStart() : choice);
}
/** Auto only: on desktop discrete GPUs, keep full graphics quality without auto-downgrading. */
export function stepDown() {
  if (!phoneLike() || quality.choice !== 'auto' || quality.level === 'low' || SOFTWARE_GL) return false;
  const level = LEVELS[LEVELS.indexOf(quality.level) - 1];
  apply(level);
  return true;
}
/** Called now and on every change: core/loop.js keeps its resolution steps under the cap, Settings shows the level. */
export function onQualityChange(fn) { listeners.add(fn); fn(quality); }

export function setup() {
  const saved = store.get(KEY);
  quality.choice = saved === 'auto' || LEVELS.includes(saved) ? saved : 'auto';
  apply(quality.choice === 'auto' ? autoStart() : quality.choice);
}
