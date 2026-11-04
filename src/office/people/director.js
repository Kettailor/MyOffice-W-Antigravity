// The director: brings each prompt to its desk, receives reports.
import * as THREE from 'three';
import { state } from '../core/state.js';
import { PRO, rand, reduceMotion, short } from '../core/env.js';
import { scene } from '../scene/renderer.js';
import { mat } from '../scene/blocks.js';
import { DESKS, dLocal } from '../world/desks.js';
import { DESK_SPOTS, DOOR_IN, faceTo } from './navigation.js';
import { Worker, dn, nearBoss, npcs, sessions, workers } from './workers.js';
import { sfx } from '../audio/sfx.js';
import { t as tr } from '../../i18n/index.js';

/* ---------- the director (pro plan) ----------
   You, in the corner office. Each prompt you send, the director carries to that session's person, wherever they are,
   and hands it over; when a session finishes its turn, its person comes to the director's desk to report. */
const DIR_HOME = { x: -5.4, z: -7.0, face: 0, node: 'DRs', sit: true };
const EXEC_SPOTS = [
  { deskX: -0.65, deskZ: -6.25, seatX: -0.65, seatZ: -7.0, standX: -0.65, standZ: -6.82, x: -0.65, z: -7.0, face: 0, node: 'DRs0', sit: true },
  { deskX: -0.65, deskZ: -4.75, seatX: -0.65, seatZ: -4.0, standX: -0.65, standZ: -4.18, x: -0.65, z: -4.0, face: Math.PI, node: 'DRs1', sit: true },
  { deskX: 1.45, deskZ: -6.25, seatX: 1.45, seatZ: -7.0, standX: 1.45, standZ: -6.82, x: 1.45, z: -7.0, face: 0, node: 'DRs2', sit: true },
  { deskX: 1.45, deskZ: -4.75, seatX: 1.45, seatZ: -4.0, standX: 1.45, standZ: -4.18, x: 1.45, z: -4.0, face: Math.PI, node: 'DRs3', sit: true },
];
export const EXEC_STYLES_MALE = [
  { gender: 'male', skirt: false, shirt: '#1E3A8A', hair: '#27272A', style: 'parted', acc: 'glasses', outfit: 'suit', tie: '#B91C1C', pants: '#1E293B', shoes: '#0F172A' },
  { gender: 'male', skirt: false, shirt: '#334155', hair: '#1E1B4B', style: 'spiky', acc: 'headphones', outfit: 'suit', tie: '#2563EB', pants: '#1E293B', shoes: '#0F172A' },
  { gender: 'male', skirt: false, shirt: '#312E81', hair: '#3B2618', style: 'plain', acc: 'glasses', outfit: 'suit', tie: '#D97706', pants: '#1F2937', shoes: '#111827' },
  { gender: 'male', skirt: false, shirt: '#1E293B', hair: '#27272A', style: 'parted', acc: null, outfit: 'shirt', pants: '#0F172A', shoes: '#18181B' },
];
export const EXEC_STYLES_FEMALE = [
  { gender: 'female', skirt: true, shirt: '#0F766E', skirtColor: '#134E4A', hair: '#451A03', style: 'ponytail', acc: 'glasses', outfit: 'blazer', pants: '#134E4A', shoes: '#1C1917' },
  { gender: 'female', skirt: true, shirt: '#BE185D', skirtColor: '#1E293B', hair: '#27272A', style: 'bun', acc: null, outfit: 'blazer', pants: '#1E293B', shoes: '#1C1917' },
  { gender: 'female', skirt: true, shirt: '#6D28D9', skirtColor: '#2E1065', hair: '#3F2E21', style: 'bob', acc: 'glasses', outfit: 'blazer', pants: '#2E1065', shoes: '#111827' },
  { gender: 'female', skirt: true, shirt: '#B91C1C', skirtColor: '#1F2937', hair: '#1C1917', style: 'ponytail', acc: null, outfit: 'shirt', pants: '#1F2937', shoes: '#18181B' },
];
export const EXEC_STYLES = [...EXEC_STYLES_MALE, ...EXEC_STYLES_FEMALE];
const paperGeo = new THREE.BoxGeometry(0.17, 0.012, 0.23);
let paperDocM;
export const flights = [];   // papers in the air, director -> person
let Director;
export const teamChibis = new Map(); // memberId -> Director instance
const lastTeamDeliver = new Map(); // sess -> timestamp ms
const lastDirDeliver = new Map();  // normDir -> timestamp ms
const lastTextDeliver = new Map(); // normText -> timestamp ms
const normDeliverDir = (dir) => String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const normDeliverText = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
export function wasDeliveredByTeam(sess, text = '', dir = '') {
  const now = Date.now();
  const tSess = sess ? lastTeamDeliver.get(sess) : 0;
  if (tSess && now - tSess < 60_000) return true;
  const nd = normDeliverDir(dir || (sess ? sessions.get(sess)?.dir : ''));
  const tDir = nd ? lastDirDeliver.get(nd) : 0;
  if (tDir && now - tDir < 60_000) return true;
  const nt = normDeliverText(text);
  const tTxt = nt && nt !== 'công việc nội bộ' ? lastTextDeliver.get(nt) : 0;
  if (tTxt && now - tTxt < 60_000) return true;
  return false;
}
function flyPaper(from, to) {
  if (reduceMotion) return;
  const m = new THREE.Mesh(paperGeo, paperDocM); m.userData.dynamic = true; scene.add(m);
  from.paper.getWorldPosition(m.position);
  flights.push({ m, a: m.position.clone(), to, t: 0 });
}
// a task left on an empty desk: a sheet of paper until its person sits down there (or a minute passes)
const deskNotes = new Map();
function dropNote(d, sess) {
  if (d == null || d < 0) return;
  deskNotes.get(d)?.m.removeFromParent();
  const m = new THREE.Mesh(paperGeo, paperDocM); m.userData.dynamic = true;
  const [nx, nz] = dLocal(DESKS[d], -0.1, -0.12); m.position.set(nx, 0.785, nz); m.rotation.y = DESKS[d].ry + rand(-0.4, 0.4); scene.add(m);
  deskNotes.set(d, { m, sess, until: state.sim + 60 });
}
export function updateFlights(dt) {
  for (const [d, n] of deskNotes) {
    const w = workers.get(n.sess);
    if (state.sim > n.until || !w || (w.station === 'desk' && w.phase !== 'walk' && w.pose === 'sit')) { n.m.removeFromParent(); deskNotes.delete(d); }
  }
  for (let i = flights.length - 1; i >= 0; i--) {
    const f = flights[i]; f.t = Math.min(1, f.t + dt / 0.55);
    const bx = f.to.pos.x, bz = f.to.pos.y, by = f.to.pose === 'sit' ? 0.95 : 1.15;
    f.m.position.set(f.a.x + (bx - f.a.x) * f.t, f.a.y + (by - f.a.y) * f.t + Math.sin(f.t * Math.PI) * 0.35, f.a.z + (bz - f.a.z) * f.t);
    f.m.rotation.y = f.t * 6;
    if (f.t >= 1) { scene.remove(f.m); flights.splice(i, 1); }
  }
}
export let director;

function formatTeamMemberLabel(m) {
  const rawName = String(m?.name || '').trim();
  const isVp = Boolean(m?.isDirectorDevice || m?.role === 'Phó Giám đốc');
  if (isVp) {
    if (!rawName || rawName === 'Phó Giám đốc') return '👔 Phó Giám đốc';
    return rawName.startsWith('👔') ? rawName : `👔 Phó Giám đốc · ${rawName}`;
  }
  const role = String(m?.role || 'Trợ lý Giám đốc').trim() || 'Trợ lý Giám đốc';
  if (!rawName || rawName === role || rawName === 'Trợ lý' || rawName === 'Trợ lý từ xa') {
    return `💼 ${role}`;
  }
  return rawName.startsWith('💼') ? rawName : `💼 ${role} · ${rawName}`;
}

export function ensureTeamMemberChibi(m, idxHint = 0) {
  if (!PRO || !Director) return director;
  if (!m || !m.id || m.id === 'director' || m.isDirector || m.isLocal) return director;
  const isVp = Boolean(m.isDirectorDevice || m.role === 'Phó Giám đốc');
  const gender = m.gender === 'female' ? 'female' : 'male';
  const stylePool = gender === 'female' ? EXEC_STYLES_FEMALE : EXEC_STYLES_MALE;
  const label = short(formatTeamMemberLabel(m), 32);
  const dot = isVp ? '#60A5FA' : '#34D399';
  const existing = teamChibis.get(m.id);
  if (existing) {
    existing.setName(label);
    if (existing.tagDot) existing.tagDot.style.background = dot;
    if (existing.label) existing.label.hidden = false;
    if (existing.tagObj && existing.root?.visible) existing.tagObj.visible = true;
    if (existing.gender !== gender) {
      existing.gender = gender;
      const slotIdx = existing.slotIdx ?? idxHint;
      const st = stylePool[slotIdx % stylePool.length];
      Object.assign(existing.cfg, st, { name: label, gender, look: 'pixar' });
      existing.rebuild();
      existing.waveUntil = (state.sim || 0) + 2.2;
    }
    return existing;
  }
  const usedSpots = new Set();
  for (const ch of teamChibis.values()) {
    const idx = EXEC_SPOTS.indexOf(ch.homeData);
    if (idx >= 0) usedSpots.add(idx);
  }
  const prefIdx = isVp ? 0 : 1;
  let spotIdx = !usedSpots.has(prefIdx) ? prefIdx : EXEC_SPOTS.findIndex((_, idx) => !usedSpots.has(idx));
  if (spotIdx < 0) spotIdx = idxHint % EXEC_SPOTS.length;
  const homeSpot = EXEC_SPOTS[spotIdx];
  const st = stylePool[spotIdx % stylePool.length];
  const ch = new Director({
    id: `__team_${m.id}`,
    memberId: m.id,
    gender,
    slotIdx: spotIdx,
    name: label,
    homeSpot,
    dot,
    styleCfg: { ...st, gender, look: 'pixar' },
  });
  if (DOOR_IN && !reduceMotion) {
    ch.pos.set(DOOR_IN.x, DOOR_IN.z);
    ch.spot = DOOR_IN;
    ch.face = ch.faceTarget = DOOR_IN.face || 0;
    ch.pose = 'stand';
    ch.station = 'arriving';
    ch.hurry = true;
    ch.goHome();
  }
  ch.waveUntil = (state.sim || 0) + 3.0;
  ch.say('agent', `${label} đã vào văn phòng!`);
  teamChibis.set(m.id, ch);
  npcs.push(ch);
  return ch;
}

export function syncTeamMembers(members = []) {
  if (!PRO || !Director) return;
  const list = (Array.isArray(members) ? members : []).filter(
    (m) => m && m.id && m.id !== 'director' && !m.isDirector && !m.isLocal && m.online !== false && m.status !== 'pending' && m.status !== 'rejected',
  );
  const keepIds = new Set(list.map((m) => m.id));
  for (const [id, ch] of teamChibis) {
    if (!keepIds.has(id)) {
      teamChibis.delete(id);
      const idx = npcs.indexOf(ch);
      if (idx >= 0) npcs.splice(idx, 1);
      ch.remove();
    }
  }
  list.forEach((m, i) => {
    ensureTeamMemberChibi(m, i);
  });
}

export function deliverTaskBy(by, sess, text, dir = '') {
  if (!PRO) return;
  const now = Date.now();
  let targetSess = sess;
  const nd = normDeliverDir(dir || (sess ? sessions.get(sess)?.dir : ''));
  if (!targetSess && nd) {
    for (const [sid, sObj] of sessions) {
      if (normDeliverDir(sObj?.dir) === nd) {
        targetSess = sid;
        break;
      }
    }
  }
  if (targetSess) lastTeamDeliver.set(targetSess, now);
  if (nd) lastDirDeliver.set(nd, now);
  const nt = normDeliverText(text);
  if (nt) lastTextDeliver.set(nt, now);
  if (!targetSess) return;
  sfx.play('task');
  let actor = director;
  if (by && by.id && by.id !== 'director' && !by.isDirector && !by.isLocal) {
    actor = ensureTeamMemberChibi(by) || director;
  }
  const s = sessions.get(targetSess);
  (actor || director)?.deliver(targetSess, s?.masked ? 'Công việc nội bộ' : (text || ''));
}

export function getAssigner(ownerId) {
  if (!ownerId || ownerId === 'director') return director;
  if (teamChibis.has(ownerId)) return teamChibis.get(ownerId);
  const found = (state.teamMembers || []).find((m) => m && m.id === ownerId);
  if (found) return ensureTeamMemberChibi(found) || director;
  return director;
}

export function reportSpotForAssigner(assigner) {
  const target = assigner || director;
  if (!target) return null;
  if (target === director) return null; // use STATIONS.director
  const h = target.homeData || DIR_HOME;
  const rx = h.standX ?? (h.x - 0.85), rz = h.standZ ?? (h.z + 0.35);
  return { x: rx, z: rz, face: faceTo(rx, rz, h.seatX ?? h.x, h.seatZ ?? h.z), node: h.node || 'DRw', sit: false };
}

export function setup() {
  paperDocM = mat('#FBFBF7', { roughness: 0.9 });
  Director = class Director extends Worker {
    constructor(opts = {}) {
      const styleCfg = opts.styleCfg || { gender: 'male', shirt: '#2B3A55', hair: '#3A3A40', style: 'plain', acc: 'glasses', outfit: 'suit', pants: '#262B35', shoes: '#1B1B1E' };
      super({ name: opts.name || tr('people.director'), ...styleCfg }, { id: opts.id || '__director' });
      this.memberId = opts.memberId || null;
      this.gender = opts.gender || styleCfg.gender || 'male';
      this.slotIdx = opts.slotIdx ?? 0;
      this.homeData = opts.homeSpot || DIR_HOME;
      this.label = this.tagEl;
      this.tagEl.classList.add('tag--boss'); this.tagDot.style.background = opts.dot || '#E2B04A';
      this.queue = []; this.job = null; this.given = 0; this.reports = 0; this.nextIdle = 0;
      this.pos.set(this.homeData.x, this.homeData.z); this.spot = this.homeData; this.face = this.faceTarget = this.homeData.face || 0; this.pose = 'sit'; this.station = 'home'; this.anim = 'type';
      this.attachPaper();
    }
    homeSpot() { return this.homeData; }
    attachPaper() { this.paper = new THREE.Mesh(paperGeo, paperDocM); this.paper.position.set(0, -0.06, 0.07); this.paper.rotation.x = 0.3; this.paper.visible = !!this.job; this.P.armR.hand.add(this.paper); }
    rebuild() { super.rebuild(); this.attachPaper(); }
    deliver(sess, text) {
      if (!sess) return;
      this.recentDelivers ||= new Map();
      const now = Date.now();
      const normTxt = normDeliverText(text);
      const prev = this.recentDelivers.get(sess);
      const q = this.queue.find((j) => j.sess === sess);
      if (q) {
        q.text = text;
        this.recentDelivers.set(sess, { at: now, text: normTxt });
        return;
      }
      if (this.job?.sess === sess) {
        this.job.text = text;
        this.recentDelivers.set(sess, { at: now, text: normTxt });
        return;
      }
      if (prev && (now - prev.at < 15_000 || (normTxt && prev.text === normTxt && now - prev.at < 45_000))) {
        this.recentDelivers.set(sess, { at: prev.at, text: normTxt || prev.text });
        return;
      }
      this.recentDelivers.set(sess, { at: now, text: normTxt });
      this.queue.push({ sess, text, at: state.sim });
    }
    // where to take it: beside the person's desk, in the aisle behind the chair; someone without a desk, where they are
    target(j) {
      const d = sessions.get(j.sess)?.desk ?? -1;
      if (d >= 0 && d < DESK_SPOTS.length) { const ds = DESK_SPOTS[d], x = ds.x - 0.55, z = ds.z - 0.8; return { x, z, face: faceTo(x, z, ds.x, ds.z), node: ds.node, desk: d }; }
      const w = workers.get(j.sess), sp = nearBoss(w, this); sp.face = Math.atan2(w.pos.x - sp.x, w.pos.y - sp.z); return sp;
    }
    start(j) {
      const w = workers.get(j.sess);
      if (!w || w.leaving || state.sim - j.at > 90) return;
      this.job = { ...j, stage: 'going' }; this.paper.visible = true; this.hush(); this.station = 'out';
      this.hurry = true;
      this.job.to = this.target(j);
      this.goTo(this.job.to, () => this.arrive());
    }
    arrive() {
      const j = this.job; if (!j) return;
      const w = workers.get(j.sess);
      if (!w || w.leaving) { this.job = null; this.paper.visible = false; return; }
      const near = state.showSessionChibis !== false && w.phase !== 'walk' && !w.wcBusy && Math.hypot(w.pos.x - this.pos.x, w.pos.y - this.pos.y) < 1.7;
      j.stage = 'hand'; j.w = w; j.drop = !near && j.to.desk != null;
      const who = short(dn(sessions.get(j.sess)), 22), what = state.streamer ? tr('people.newTask') : short(j.text, 44);
      const holdDur = this.queue.length > 0 ? 0.45 : near ? (reduceMotion ? 0.65 : 0.85) : 0.65;
      if (near) {   // hand it over
        this.faceTarget = Math.atan2(w.pos.x - this.pos.x, w.pos.y - this.pos.y); this.anim = 'globe'; j.until = state.sim + holdDur;
        this.say('prompt', tr('people.handOver', { what }));
        if (w.pose !== 'sit') w.faceTarget = Math.atan2(this.pos.x - w.pos.x, this.pos.y - w.pos.y);
      } else {      // not at the desk: leave it there
        this.faceTarget = j.to.face; this.anim = 'tidy'; j.until = state.sim + holdDur;
        this.say('prompt', j.drop ? tr('people.leaveOnDesk', { who }) : tr('people.handOver', { what }));
      }
      sfx.play('task');
    }
    update(dt, t) {
      super.update(dt, t);
      if (this.memberId && this.root?.visible) {
        if (this.tagObj) this.tagObj.visible = true;
        if (this.tagEl) this.tagEl.hidden = false;
        if (this.label) this.label.hidden = false;
      }
    }
    step(dt, t) { this.update(dt, t); }
    tick() {
      if (this.phase === 'walk') return;
      const j = this.job;
      if (j?.stage === 'hand') {
        if (state.sim < j.until) return;
        if (j.drop) dropNote(j.to.desk, j.sess); else flyPaper(this, j.w);
        this.given++; this.paper.visible = false; this.job = null; this.hurry = this.queue.length > 0; this.hush(); this.anim = 'idle';
        return;
      }
      if (!j && this.queue.length && state.sim >= (this.holdUntil || 0)) { this.start(this.queue.shift()); return; }
      if (!j && this.station !== 'home' && this.station !== 'going-home') { this.goHome(); return; }
      if (this.station === 'home' && state.sim > this.nextIdle) {   // at the desk: works, reads a report, thinks
        const busy = [...sessions.values()].some((s) => s.status === 'work');
        this.anim = busy ? (Math.random() < 0.65 ? 'type' : 'think') : (Math.random() < 0.5 ? 'read' : 'type');
        this.nextIdle = state.sim + rand(6, 11);
      }
    }
    goHome() { this.station = 'going-home'; this.hurry = this.queue.length > 0; this.goTo(this.homeData, () => { this.station = 'home'; this.hurry = false; this.face = this.faceTarget = this.homeData.face || 0; this.anim = 'type'; this.nextIdle = state.sim + rand(4, 8); }); }
    // a person reports a finished turn at the desk
    ack(w) {
      this.reports++;
      const nearHome = Math.hypot(this.pos.x - this.homeData.x, this.pos.y - this.homeData.z) < 3.5;
      if (!nearHome && this.phase === 'walk') return false;
      if (w && this.pose !== 'sit') this.faceTarget = Math.atan2(w.pos.x - this.pos.x, w.pos.y - this.pos.y);
      this.anim = 'idle'; this.waveUntil = state.sim + 1.4; this.nextIdle = this.holdUntil = state.sim + 2.6;
      const text = tr('people.directorThanks'); this.say('substop', text);
      setTimeout(() => { if (this.lastSay?.text === text) this.hush(); }, 2400);
      return true;
    }
    reset() { for (const n of deskNotes.values()) n.m.removeFromParent(); deskNotes.clear(); this.recentDelivers?.clear(); this.queue = []; this.job = null; this.hurry = false; this.chore = null; this.after = null; this.paper.visible = false; this.hush(); this.path = []; this.phase = 'idle'; this.pos.set(this.homeData.x, this.homeData.z); this.spot = this.homeData; this.face = this.faceTarget = this.homeData.face || 0; this.pose = 'sit'; this.station = 'home'; this.anim = 'type'; }
  };
  director = PRO ? new Director() : null;
  if (director) npcs.push(director);
  if (Array.isArray(state.teamMembers) && state.teamMembers.length) {
    syncTeamMembers(state.teamMembers);
  }
}
