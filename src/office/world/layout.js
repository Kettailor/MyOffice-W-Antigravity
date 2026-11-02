// The floor plans (cozy, pro, hq): where the shared furniture stands, and the headquarters wing.
import { HQ, PRO } from '../core/env.js';

export let LAY;
/* Headquarters = the company floor (z -8 → 9) plus the meeting wing directly in front of it (z 9 → 15.8).
   Two doors in the core's front wall (on its left and right aisles) open onto corridor A (z 9 → 10.8),
   which leads directly into the 3 side-by-side meeting rooms (z 10.8 → 15.8). */
export const WING = { z0: 9, z1: 15.8, meetZ1: 15.8, corA: [9, 10.8], corB: [2.3, 4.3], corC: [9, 10.8], split: 10.8, doors: [-2.4, 7.4] };
export const DEPTS = [];
export const MEET_WING_ROOMS = [
  { x0: -8.0, x1: -0.7, z0: 10.8, z1: 15.8, cx: -4.35, cz: 13.3, door: { side: 'n', at: -4.35 } },
  { x0: -0.7, x1: 6.6, z0: 10.8, z1: 15.8, cx: 2.95, cz: 13.3, door: { side: 'n', at: 2.95 } },
  { x0: 6.6, x1: 14.0, z0: 10.8, z1: 15.8, cx: 10.3, cz: 13.3, door: { side: 'n', at: 10.3 } },
];
// The ground the office stands on (building, terrace and its edge), for the backdrops to keep clear of
export const REACH = () => ({ x0: -11, x1: 16, z0: -9, z1: 19.2 });
// Is (x, z) inside the building with a margin (people never stand closer than `m` to an outer wall)?
// a point in the sofa's own frame (x along it, z out from its seat toward the coffee table) on the floor plan; the
// company floor's sofa faces the back wall, where the lounge TV is
export function sofaAt(lx, lz) { const [x, z, , r] = LAY.sofa, c = Math.cos(r), s = Math.sin(r); return [x + lx * c + lz * s, z - lx * s + lz * c]; }
export const inside = (x, z, m = 0.4) =>
  (x > LAY.box.x0 + m && x < LAY.box.x1 - m && z > LAY.box.z0 + m && z < (PRO ? 9.0 - m : LAY.box.z1 - m)) ||
  (HQ && (
    MEET_WING_ROOMS.some((r) => x > r.x0 + m && x < r.x1 - m && z > r.z0 + m && z < r.z1 - m) ||
    (x > LAY.box.x0 + m && x < LAY.box.x1 - m && z > WING.corA[0] - m && z < WING.corA[1] + m)
  ));

export function setup() {
  /* ---------- Headquarters ('hq') floor plan ----------
     A company floor (22 x 17 m) plus a 3-room meeting wing directly in front of it. */
  LAY = {
    box: { x0: -8, x1: 14, z0: -8, z1: WING.meetZ1 }, center: [3, 4],
    shelf: [4.95, -7.62, 0], globe: [8.0, -6.55], board: [-3.42, 2.05, 7.25, 0], doorZ: 3.3, clock: [-7.96, 2.15, 1.7, Math.PI / 2],
    racks: [-7.55, -1.47, Math.PI / 2], tv: [-7.96, 3.35, -1.47, Math.PI / 2], neon: [0.2, 3.62, -7.97, 0], rocket: [13.15, 1.75],
    coffee: [10.6, -7.45, Math.PI], aq: [10.45, 8.45], arc: [13.4, 8.45], prn: [-3.15, 0.55],
    lost: [-5.2, -0.62, Math.PI / 2 - 0.5], lostTag: [-5.2, 0.85, -0.3], sofa: [11.0, 3.95, 2.2, Math.PI], gameTv: [11.0, 0.9],
    bil: [12.85, 6.2], ktv: [-1.55, 7.35, Math.PI],   // the pool table (the lounge's right side) and the karaoke box (where the front phone booth was)
  };
}
