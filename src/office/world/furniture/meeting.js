// The 3 meeting rooms and their conference tables + 7 chairs each.
import * as THREE from 'three';
import { HQ, PRO } from '../../core/env.js';
import { scene } from '../../scene/renderer.js';
import { canvasTex, cyl, mat, put, rbox, toonMat } from '../../scene/blocks.js';
import { metal, potPlant, woodDark } from '../terrace.js';
import { MEET_WING_ROOMS } from '../layout.js';
import { officeChair } from '../desks.js';
import { t as tr } from '../../../i18n/index.js';

export let MEET;
export let MEET_ROOMS = [];
export let MEET_SEATS_BY_ROOM = [];
let meetChairM;
export let MEET_SEATS;

function buildConferenceTable(tx, tz) {
  put(scene, rbox(3.6, 0.07, 1.3, mat('#F2EFEA', { roughness: 0.4 }), 0.03), tx, 0.76, tz);
  for (const sx of [-1, 1]) {
    put(scene, rbox(0.1, 0.72, 0.9, metal, 0.02), tx + sx * 1.35, 0.37, tz);
    put(scene, rbox(0.5, 0.03, 0.95, metal, 0.01), tx + sx * 1.35, 0.015, tz);
  }
  put(scene, rbox(0.28, 0.05, 0.28, '#2B2F36', 0.02), tx, 0.82, tz);   // conference phone
  for (const [dx, dz] of [[-1.0, 0.4], [0.3, 0.42], [1.2, -0.38], [-0.5, -0.4]]) {
    put(scene, rbox(0.3, 0.012, 0.22, '#FBFBF7', 0.004), tx + dx, 0.802, tz + dz).rotation.y = dx * 0.3;
  }
  for (const [dx, dz] of [[-0.75, 0.3], [0.55, -0.32], [1.55, 0.3]]) {
    put(scene, cyl(0.035, 0.03, 0.12, '#BFE3F2'), tx + dx, 0.86, tz + dz);
  }
  potPlant(tx - 0.9, tz - 0.1, 0.28, 'bush', 0.8);
}

function buildSouthWhiteboard(tx, tz = 15.73, idx = 0) {
  const w = 1.9, h = 0.95, y = 1.3;
  const g0 = new THREE.Group(); g0.position.set(tx, 0, tz); g0.rotation.y = Math.PI; scene.add(g0);
  const accent = ['#3F7CC4', '#D97757', '#2A9D8F'][idx % 3];
  const tex = canvasTex(512, 256, (g, cw, ch) => {
    g.fillStyle = '#FBFBF8'; g.fillRect(0, 0, cw, ch);
    g.fillStyle = accent; g.fillRect(0, 0, cw, 46);
    g.fillStyle = '#FFFFFF'; g.font = '800 24px "Be Vietnam Pro", system-ui, sans-serif';
    g.fillText(`Sprint review · #${idx + 1}`, 20, 31);
    g.fillStyle = '#7A8494'; g.font = '600 18px "Be Vietnam Pro", system-ui, sans-serif';
    g.fillText(tr('world.slideSub'), 20, 76);
    const bars = [0.42, 0.58, 0.51, 0.74, 0.66, 0.88];
    bars.forEach((v, i) => {
      g.fillStyle = i === 5 ? '#D97757' : accent;
      g.fillRect(36 + i * 74, 232 - v * 125, 44, v * 125);
    });
    g.fillStyle = '#C9CED6'; g.fillRect(20, 234, cw - 40, 3);
  });
  put(g0, rbox(w + 0.08, h + 0.08, 0.04, '#C9CED6', 0.01), 0, y, 0);
  put(g0, new THREE.Mesh(new THREE.PlaneGeometry(w, h), toonMat({ map: tex, roughness: 0.7 })), 0, y, 0.022);
  put(g0, rbox(w * 0.6, 0.03, 0.06, '#9AA0AA', 0.005), 0, y - h / 2 - 0.05, 0.04);
  for (const sx of [-1, 1]) {
    put(g0, rbox(0.04, y - h / 2, 0.04, metal, 0.01), sx * (w / 2 - 0.05), (y - h / 2) / 2, 0);
    put(g0, rbox(0.06, 0.03, 0.42, metal, 0.01), sx * (w / 2 - 0.05), 0.015, 0);
  }
}

export function setup() {
  /* meeting rooms: in HQ mode, all 3 meeting rooms (idx = 0, 1, 2) sit in MEET_WING_ROOMS[0..2] */
  MEET = HQ ? { x: -4.35, z: 13.3 } : PRO ? { x: 0.2, z: -5.6 } : { x: 5.2, z: 2.4 };
  meetChairM = mat(PRO ? '#3C4656' : '#4E7D5B', { roughness: 0.95 });
  if (PRO) {
    const seat = (x, z, face, node, roomIdx = 0) => ({ x, z, face, node, sit: true, by: null, roomIdx });
    if (HQ) {
      MEET_ROOMS = [];
      MEET_SEATS_BY_ROOM = [];
      MEET_WING_ROOMS.forEach((rm, idx) => {
        const cx = rm.cx, cz = rm.cz;
        buildConferenceTable(cx, cz);
        buildSouthWhiteboard(cx, rm.z1 - 0.07, idx);
        const roomSeats = [
          seat(cx - 1.15, cz - 1.25, 0, `M${idx}_0`, idx),
          seat(cx, cz - 1.25, 0, `M${idx}_1`, idx),
          seat(cx + 1.15, cz - 1.25, 0, `M${idx}_2`, idx),
          seat(cx - 1.15, cz + 1.25, Math.PI, `M${idx}_3`, idx),
          seat(cx, cz + 1.25, Math.PI, `M${idx}_4`, idx),
          seat(cx + 1.15, cz + 1.25, Math.PI, `M${idx}_5`, idx),
          seat(cx - 2.2, cz, Math.PI / 2, `M${idx}_6`, idx),
        ];
        MEET_ROOMS.push({ id: idx, x: cx, z: cz, seats: roomSeats });
        MEET_SEATS_BY_ROOM.push(roomSeats);
      });
    } else {
      buildConferenceTable(MEET.x, MEET.z);
      const room0Seats = [
        seat(-0.95, -4.35, Math.PI, 'DRw', 0),
        seat(0.2, -4.35, Math.PI, 'DRw', 0),
        seat(1.35, -4.35, Math.PI, 'DRw', 0),
        seat(-0.95, -6.85, 0, 'DRw', 0),
        seat(0.2, -6.85, 0, 'DRw', 0),
        seat(1.35, -6.85, 0, 'DRw', 0),
        seat(-2.15, -5.6, Math.PI / 2, 'DRw', 0),
      ];
      MEET_ROOMS = [{ id: 0, x: MEET.x, z: MEET.z, seats: room0Seats }];
      MEET_SEATS_BY_ROOM = [room0Seats];
    }
    MEET_SEATS = MEET_SEATS_BY_ROOM.flat();
    for (const s of MEET_SEATS) {
      const c = officeChair(scene, s.x, s.z, meetChairM);
      c.rotation.y = s.face;
    }
  } else {
    put(scene, cyl(1.02, 1.02, 0.08, mat('#A87B52', { roughness: 0.45 }), 48), MEET.x, 0.76, MEET.z);
    put(scene, cyl(0.12, 0.18, 0.7, woodDark), MEET.x, 0.36, MEET.z);
    put(scene, cyl(0.5, 0.55, 0.05, woodDark), MEET.x, 0.03, MEET.z);
    potPlant(MEET.x + 0.25, MEET.z - 0.2, 0.32, 'bush', 0.8);
    put(scene, rbox(0.42, 0.02, 0.3, '#FBFBF7', 0.01), MEET.x - 0.35, 0.81, MEET.z + 0.25).rotation.y = -0.4;
    put(scene, cyl(0.06, 0.055, 0.12, '#7EC8E3'), MEET.x - 0.05, 0.86, MEET.z + 0.45);
    const seatSpot = (a, node) => { const x = MEET.x + Math.sin(a) * 1.35, z = MEET.z + Math.cos(a) * 1.35; return { x, z, face: Math.atan2(MEET.x - x, MEET.z - z), node, sit: true, by: null, roomIdx: 0 }; };
    MEET_SEATS = [seatSpot(Math.PI, 'P'), seatSpot(-Math.PI / 2, 'GR2'), seatSpot(Math.PI / 2, 'P'), seatSpot(0, 'M')];
    MEET_ROOMS = [{ id: 0, x: MEET.x, z: MEET.z, seats: MEET_SEATS }];
    MEET_SEATS_BY_ROOM = [MEET_SEATS];
    for (const s of MEET_SEATS) {
      const c = new THREE.Group(); c.position.set(s.x, 0, s.z); c.rotation.y = s.face; scene.add(c);
      put(c, rbox(0.52, 0.12, 0.5, meetChairM, 0.05), 0, 0.44, 0);
      const back = rbox(0.52, 0.5, 0.1, meetChairM, 0.05); back.position.set(0, 0.72, -0.24); back.rotation.x = -0.12; c.add(back);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) put(c, cyl(0.025, 0.02, 0.4, woodDark, 6), sx * 0.2, 0.2, sz * 0.19);
    }
  }
}
