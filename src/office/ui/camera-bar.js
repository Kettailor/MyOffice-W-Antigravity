// The camera toolbar.
import { state } from '../core/state.js';
import { $, HQ, PRO } from '../core/env.js';
import { BASE_ZOOM, camera, controls, fpCam } from '../scene/renderer.js';
import { MEET_WING_ROOMS } from '../world/layout.js';
import { subs, workers } from '../people/workers.js';
import { queueUi, toast } from './activity.js';
import { drS } from './session-drawer.js';
import { exitFp, fp } from '../interact/first-person.js';
import { focusTarget } from '../core/loop.js';
import { t as tr } from '../../i18n/index.js';

let VIEWS;
let currentView = 'home';
let meetCycleIdx = -1;
export function setView(v) {
  currentView = v;
  if (v !== 'meeting') meetCycleIdx = -1;
  for (const b of document.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
}
let panBack = null;
let panTimer = 0;
export const autoCam = () => state.camAuto && !fp.on && !state.photo && !state.selectedId && performance.now() - state.lastUserCam > 30000;
export function panTo(w) {
  if (!panBack) panBack = focusTarget.clone();
  focusTarget.set(w.pos.x, 0.9, w.pos.y);
  clearTimeout(panTimer); panTimer = setTimeout(() => { if (panBack && !state.selectedId) focusTarget.copy(panBack); panBack = null; }, 7000);
}
function findBusyMeetingRoom() {
  if (!HQ || !MEET_WING_ROOMS.length) return null;
  const busyRooms = [];
  for (const rm of MEET_WING_ROOMS) {
    let count = 0;
    for (const w of workers.values()) {
      if (w.root?.parent && !w.away && w.pos.x >= rm.x0 && w.pos.x <= rm.x1 && w.pos.y >= rm.z0 && w.pos.y <= rm.z1) count++;
    }
    for (const sw of subs.values()) {
      if (sw.root?.parent && sw.pos.x >= rm.x0 && sw.pos.x <= rm.x1 && sw.pos.y >= rm.z0 && sw.pos.y <= rm.z1) count++;
    }
    if (count > 0) busyRooms.push({ rm, count });
  }
  if (busyRooms.length === 1) return busyRooms[0].rm;
  return null;
}
export function goView(v) {
  const V = VIEWS[v];
  if (!V) return;
  const camOff = HQ ? [19, 23, 19] : PRO ? [17, 20, 17] : [18, 16, 18];
  camera.position.set(
    controls.target.x + camOff[0],
    controls.target.y + camOff[1],
    controls.target.z + camOff[2],
  );
  if (v === 'meeting' && HQ && MEET_WING_ROOMS.length) {
    const busyRm = findBusyMeetingRoom();
    if (currentView === 'meeting') {
      meetCycleIdx = (meetCycleIdx + 1) % (MEET_WING_ROOMS.length + 1);
    } else {
      meetCycleIdx = busyRm ? MEET_WING_ROOMS.indexOf(busyRm) : -1;
    }
    if (meetCycleIdx >= 0 && MEET_WING_ROOMS[meetCycleIdx]) {
      const rm = MEET_WING_ROOMS[meetCycleIdx];
      focusTarget.set(rm.cx, 0.8, rm.cz);
      state.zoomGoal = 1.95 * BASE_ZOOM;
    } else {
      focusTarget.set(...V.t);
      state.zoomGoal = V.z * BASE_ZOOM;
    }
    setView(v);
    currentView = 'meeting';
    return;
  }
  focusTarget.set(...V.t);
  state.zoomGoal = V.z * BASE_ZOOM;
  setView(v);
}

export function setup() {
  /* ---------- camera toolbar ---------- */
  VIEWS = HQ ? {
    home: { t: [3, 0.3, 3.8], z: 1 },
    desks: { t: [2.5, 0.6, 3.2], z: 1.85 },
    wing: { t: [1.5, 0.8, 13.3], z: 1.58 },
    meeting: { t: [1.5, 0.8, 13.3], z: 1.58 },
    server: { t: [-5.6, 1.0, -0.6], z: 2.8 },
    lounge: { t: [11.2, 0.6, 2.5], z: 2.1 },
  } : PRO ? {
    home: { t: [3, 0.3, 0.7], z: 1 },
    desks: { t: [2.3, 0.6, 3.6], z: 1.9 },
    wing: { t: [2.3, 0.6, 3.6], z: 1.5 },
    meeting: { t: [-1.2, 0.6, -5.4], z: 2.0 },
    server: { t: [-5.6, 1.0, -0.6], z: 2.4 },
    lounge: { t: [11.2, 0.6, 2.5], z: 1.8 },
  } : {
    home: { t: [0, 0.3, 0.2], z: 1 },
    desks: { t: [0, 0.6, 0.4], z: 1.75 },
    wing: { t: [0, 0.6, 0.4], z: 1.4 },
    meeting: { t: [5.2, 0.6, 2.4], z: 2.3 },
    server: { t: [5.4, 1.0, -4.4], z: 2.2 },
    lounge: { t: [-3.5, 0.6, 4.5], z: 2.0 },
  };
  // Camera glides to important moments (a permission request, a deploy, an incident) unless you moved it in the last
  // 30 seconds, then returns to where it was.
  state.camAuto = true;
  try { state.camAuto = localStorage.getItem('office-autocam') !== 'off'; } catch { /* storage blocked */ }
  state.lastUserCam = -1e9;
  controls.addEventListener('start', () => { state.lastUserCam = performance.now(); panBack = null; clearTimeout(panTimer); });
  // While the mouse is on the toolbar it is held by its right edge: a view's name sliding out (on hover) then grows it to
  // the left, and the zoom, the tools and walking in stay where the pointer expects them. Centred again once it has shrunk.
  const bar = document.querySelector('.toolbar'), host = bar.parentElement;
  let unpin = 0;
  bar.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(unpin);
    if (bar.classList.contains('tb-pinned')) return;
    bar.style.right = `${host.getBoundingClientRect().right - bar.getBoundingClientRect().right}px`; bar.classList.add('tb-pinned');
  });
  bar.addEventListener('pointerleave', () => { clearTimeout(unpin); unpin = setTimeout(() => { bar.classList.remove('tb-pinned'); bar.style.right = ''; }, 340); });
  document.querySelector('.tb-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]'); if (!b) return;
    if (fp.on) exitFp();
    if (state.selectedId) { state.selectedId = null; state.subView = null; drS.hidden = true; queueUi(); }
    goView(b.dataset.view);
  });
  $('zoom-in').addEventListener('click', () => { if (fp.on) { fpCam.fov = Math.max(40, fpCam.fov - 8); fpCam.updateProjectionMatrix(); return; } state.zoomGoal = Math.min(controls.maxZoom, (state.zoomGoal ?? camera.zoom) * 1.2); });
  $('zoom-out').addEventListener('click', () => { if (fp.on) { fpCam.fov = Math.min(90, fpCam.fov + 8); fpCam.updateProjectionMatrix(); return; } state.zoomGoal = Math.max(controls.minZoom, (state.zoomGoal ?? camera.zoom) / 1.2); });
  $('btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast(tr('ui.cameraToolbar.noFullscreen')));
  });
  setInterval(() => { const v = `${Math.round((camera.zoom / BASE_ZOOM) * 100)}%`, z = $('zoom-val'); if (z.textContent !== v) z.textContent = v; }, 200);   // (written only when it changes: a write costs a style pass)
}
