// Headquarters' wing: in front of the company floor, corridor A (z 9.0 -> 10.8) leads directly into the 3 side-by-side
// meeting rooms (z 10.8 -> 15.8).
import * as THREE from 'three';
import { HQ } from '../../core/env.js';
import { scene } from '../../scene/renderer.js';
import { mat, put, rbox } from '../../scene/blocks.js';
import { potPlant } from '../terrace.js';
import { wallWindow } from '../windows.js';
import { MEET_WING_ROOMS, WING } from '../layout.js';
import { floorZone, glassWall as glassWallPiece, gridTex, lowWall, plateTex, speckTex } from './pieces.js';
import { t as tr } from '../../../i18n/index.js';

const glassWall = (a, b, c, d, e, f) => (typeof a === 'number' ? glassWallPiece(a, b, c, d, e, f) : glassWallPiece(b, c, d, e, f));
const windowWall = (_sc, x, z, w) => wallWindow(x, 2.1, z, w, 1.65, x < 0 ? Math.PI / 2 : -Math.PI / 2, 3);

export const DEPT_SIGNS = [];
export const DEPT_TITLE_KEYS = ['world.dept.d0', 'world.dept.d1', 'world.dept.d2', 'world.dept.d3'];
export const DEPT_SUB_KEYS = ['world.dept.d0Sub', 'world.dept.d1Sub', 'world.dept.d2Sub', 'world.dept.d3Sub'];
export const ACCENTS = ['#3F7CC4', '#D97757', '#2A9D8F', '#8C4FA8'];

function buildWing() {
  const Z0 = WING.z0, MZ1 = WING.meetZ1 || WING.z1, mid = (Z0 + MZ1) / 2, len = MZ1 - Z0;
  /* shell: the slab, outer side walls and front outer wall down to WING.meetZ1 (15.8) */
  put(scene, rbox(22.6, 0.5, len, '#7A5A3E', 0.05), 3, -0.25, mid + 0.15);
  put(scene, rbox(0.3, 4.2, len, mat('#EEE8DE', { roughness: 0.9 }), 0.04), -8.15, 2.1, mid + 0.15);
  put(scene, rbox(0.42, 0.14, len, '#E2D9C8', 0.03), -8.15, 4.25, mid + 0.15);
  put(scene, rbox(0.06, 0.18, len, '#6E5440', 0.02), -7.97, 0.09, mid + 0.15);
  windowWall(scene, -7.98, 13.3, 3.0, true);
  lowWall(14, Z0, 14, MZ1);
  lowWall(-8, MZ1, 14, MZ1);

  /* floors: corridor A in pale tiles, each meeting room in dark slate carpet */
  const corridor = gridTex('#D7D2CA', 'rgba(120,110,100,.25)', 2);
  floorZone(-8, 14, WING.corA[0], WING.corA[1], corridor, 1.2);
  MEET_WING_ROOMS.forEach((r) => floorZone(r.x0, r.x1, r.z0, r.z1, speckTex('#3E515B', 3000, 0.06), 0.8));

  /* walls: the core's front gets two doors; continuous glass wall at z = 10.8 with 3 meeting room doorways */
  const [dw, de] = WING.doors;
  lowWall(-8, Z0, -3.6, Z0);
  lowWall(-3.6, Z0, 8.6, Z0, [[dw - 0.6 + 3.6, dw + 0.6 + 3.6], [de - 0.6 + 3.6, de + 0.6 + 3.6]]);
  lowWall(8.6, Z0, 14, Z0);

  const meetGaps = MEET_WING_ROOMS.map((r) => [r.door.at - 0.55 - (-8), r.door.at + 0.55 - (-8)]);
  glassWall(-8, WING.corA[1], 14, WING.corA[1], meetGaps);
  // Glass dividers between the 3 meeting rooms at x = -0.7 and x = 6.6 (z = 10.8 .. 15.8)
  glassWall(-0.7, WING.corA[1], -0.7, MZ1);
  glassWall(6.6, WING.corA[1], 6.6, MZ1);

  /* Meeting Room 1, 2 & 3 door plaques beside each room's north door */
  const trOr = (k, fb) => { const v = tr(k); return v && v !== k ? v : fb; };
  for (const [idx, title, sub] of [
    [0, trOr('world.plaque.meeting1', tr('world.plaque.meeting')), trOr('world.plaque.meeting1Sub', tr('world.plaque.meetingSub'))],
    [1, tr('world.plaque.meeting2'), tr('world.plaque.meeting2Sub')],
    [2, tr('world.plaque.meeting3'), tr('world.plaque.meeting3Sub')],
  ]) {
    const r = MEET_WING_ROOMS[idx];
    const pm = new THREE.Mesh(
      new THREE.PlaneGeometry(0.76, 0.24),
      new THREE.MeshBasicMaterial({ map: plateTex(title, sub), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    pm.position.set(r.door.at + 1.15, 1.62, r.z0 + 0.045); pm.rotation.y = 0; scene.add(pm);
  }

  /* Plants inside the 3 meeting rooms and corridor A */
  for (const [x, z, s, k] of [
    [-7.4, 11.4, 1.0, 'monstera'],
    [-0.1, 11.4, 0.9, 'snake'],
    [7.2, 11.4, 0.9, 'snake'],
    [13.4, 11.4, 1.0, 'monstera'],
  ]) potPlant(x, z, s, k);

  /* Corridor A: the company's sign at the west end, plant at the east end */
  put(scene, rbox(0.03, 2.7, 1.6, mat('#2F4A3D', { roughness: 0.9 }), 0.005), -7.985, 1.35, (WING.corA[0] + WING.corA[1]) / 2);
  {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.36, 0.42), new THREE.MeshBasicMaterial({ map: plateTex(tr('world.dept.hq'), tr('world.dept.hqSub'), { bg: '#2F4A3D', fg: '#F3EFE8', sub: '#B9D6C4' }) }));
    m.position.set(-7.965, 1.95, (WING.corA[0] + WING.corA[1]) / 2); m.rotation.y = Math.PI / 2; scene.add(m);
  }
  potPlant(13.55, 9.9, 1.1, 'monstera');
}

export function setup() {
  if (HQ) buildWing();
}
