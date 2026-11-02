// Dashed lines from a boss to its subagents.
import * as THREE from 'three';
import { state } from '../core/state.js';
import { scene } from '../scene/renderer.js';
import { leaving, subs, workers } from './workers.js';
import { fp } from '../interact/first-person.js';

let teamGeo;
let teamLines;
export function updateTeam() {
  if (fp.on) { teamLines.visible = false; return; }
  const boss = (state.selectedId && workers.get(state.selectedId)) || (state.hovered ? (state.hovered.sub ? state.hovered.parent : state.hovered) : null);
  if (!boss) { teamLines.visible = false; return; }
  const a = teamGeo.attributes.position; let n = 0;
  for (const m of subs.values()) {
    if (m.sub && m.parent === boss && m.root.parent) {
      a.setXYZ(n++, boss.pos.x, 1.1, boss.pos.y); a.setXYZ(n++, m.pos.x, 0.8, m.pos.y);
      if (n >= 64) break;
    }
  }
  if (n < 64) {
    for (const m of leaving) {
      if (m.sub && m.parent === boss && m.root.parent) {
        a.setXYZ(n++, boss.pos.x, 1.1, boss.pos.y); a.setXYZ(n++, m.pos.x, 0.8, m.pos.y);
        if (n >= 64) break;
      }
    }
  }
  if (!n) { teamLines.visible = false; return; }
  a.needsUpdate = true; teamGeo.setDrawRange(0, n); teamLines.computeLineDistances(); teamLines.visible = true;
}

export function setup() {
  /* team lines: from the selected (or pointed-at) boss to each of its subagents, dashed, drawn over everything */
  teamGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 2 * 32), 3));
  teamLines = new THREE.LineSegments(teamGeo, new THREE.LineDashedMaterial({ color: '#8EC2FF', dashSize: 0.16, gapSize: 0.1, transparent: true, opacity: 0.9, depthTest: false }));
  teamLines.frustumCulled = false;
   teamLines.renderOrder = 6;
   teamLines.visible = false;
   teamLines.userData.dynamic = true;
   scene.add(teamLines);
}
