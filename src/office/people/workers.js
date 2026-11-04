// Workers: one character per session or subagent, what they do and where they walk.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { makeChibi, chibiPose, applyChibiPose, wearOuter, wearHat, disposeChibi } from './chibi-rig.js';
import { state } from '../core/state.js';
import { HQ, PRO, SEASON, V2, el, fmtAgo, nowMs, officeNow, rand, randInt, reduceMotion, replay, short, tint, wrapAngle } from '../core/env.js';
import { ACT, ANIM_AT, bubbleText, verb } from '../ui/event-text.js';
import { TYPE_ICON, icon } from '../ui/icons.js';
import { scene } from '../scene/renderer.js';
import { canvasTex } from '../scene/blocks.js';
import { inside } from '../world/layout.js';
import { lift, liftArrive, liftCall } from '../world/entrance.js';
import { BAGS, CHAIR_IDLE, COATS, chairs, deskKit } from '../world/desks.js';
import { CLAUDE_MARK, PRO_FX } from '../world/pro/pieces.js';
import { MEET_ROOMS, MEET_SEATS_BY_ROOM } from '../world/furniture/meeting.js';
import { DESK_SPOTS, DOOR_IN, DOOR_OUT, NODES, STATIONS, allocate, faceTo, nearestNode, route } from './navigation.js';
import { COFFEE_Q, hideMeal, joinCoffee, leaveCoffee, showMeal } from './breaks.js';
import { blocked, fp } from '../interact/first-person.js';
import { sfx } from '../audio/sfx.js';
import { t as tr } from '../../i18n/index.js';

/* ---------- workers ---------- */
export const PALETTE = ['#6A8042', '#E8742A', '#3F7CC4', '#8C4FA8', '#D64550', '#2A9D8F', '#C9A227', '#5B6CD8', '#B5651D', '#C2577A', '#3E8E7E', '#7A6FD0'];
const HAIRS = ['#3B2618', '#1E1E24', '#9A4A24', '#E2B04A', '#5A3825', '#2B2B2B', '#C2703D', '#7A4E2D'];
const STYLES = ['bob', 'spiky', 'ponytail', 'bun', 'plain', 'curly'];
const ACCS = ['headphones', 'glasses', 'beanie', 'cap', null, null, null];
// 4 phòng ban chuyên môn trong trụ sở HQ:
// 0: UI · Front-end (#0EA5E9), 1: Back-end · API (#F97316), 2: BA · Research (#8B5CF6), 3: QA · Kiểm thử (#10B981)
export const DEPT_INFO = [
  { idx: 0, badge: 'UI', color: '#0EA5E9', shirt: '#0EA5E9', pants: '#1E3A5F', acc: 'headphones', style: 'bob' },
  { idx: 1, badge: 'BE', color: '#F97316', shirt: '#F97316', pants: '#27272A', acc: 'glasses', style: 'spiky' },
  { idx: 2, badge: 'BA', color: '#8B5CF6', shirt: '#8B5CF6', pants: '#312E81', acc: 'glasses', style: 'bun' },
  { idx: 3, badge: 'QA', color: '#10B981', shirt: '#10B981', pants: '#064E3B', acc: 'cap', style: 'ponytail' },
];
const TOOL_STEP_TYPES = new Set(['read', 'grep', 'glob', 'skill', 'edit', 'write', 'bash', 'web', 'fetch', 'mcp', 'test', 'testok', 'testfail', 'commit', 'push', 'pull', 'deploy', 'compact', 'other']);
const BUSY_ANIMS = new Set(['type', 'console', 'read', 'board', 'globe', 'tidy', 'sleep', 'wake']);
// set by outings.js (with the city outside): home(w, gone) takes someone leaving out by the street (true if it does),
// arrive(w) brings someone back the same way
export const streetHooks = {};
// the attendance terminal by the lift (people/hr.js): in(w, then) on the way in from the lift, out(w, then) on the way out,
// newcomer(w) for a session's first walk in; each calls then() when done (straight away when there is nothing to do)
export const clockHooks = {};
export const awayHooks = {};
const viaClock = (kind, w, then) => (clockHooks[kind] ? clockHooks[kind](w, then) : then());
export function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export const colorOf = (s) => (s.desk >= 0 ? PALETTE[s.desk % PALETTE.length] : PALETTE[hash(s.name) % PALETTE.length]);
// What to call a session on screen: the chat's title (your rename, else Claude's), else its short name.
// The short name stays the identity: looks, colours and the timeline are keyed by it.
export const dn = (s) => (s ? s.title || s.name : '');
export const dnOf = (e) => dn(sessions.get(e.sess)) || e.name || tr('common.session');
// Which agent a session runs, shown as its logo in the list (Claude Code today; Codex and Gemini when the server
// reports them). The marks are the brands' own logos as published by Simple Icons (CC0 path data, v15.17.0); the
// trademarks belong to Anthropic, Google and OpenAI.
export const agentOf = (s) => (s?.agent === 'codex' || s?.agent === 'claude' ? s.agent : 'gemini');
export const AGENT_NAME = { gemini: 'Antigravity', claude: 'Claude Code', codex: 'Codex' };
let AGENT_SVG;
export function agentMark(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'av-logo'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = AGENT_SVG[kind] || AGENT_SVG.gemini; svg.dataset.agent = kind;
  return svg;
}
let zTex;
const zs = [];
export function isProtectedChibi(w) {
  if (!w) return false;
  const idStr = String(w.id || '');
  return idStr === '__director' || idStr.startsWith('__team_');
}
export function isChibiHiddenBySetting(w) {
  return state.showSessionChibis === false && !isProtectedChibi(w);
}
export function applySessionChibisVisibility() {
  const all = [...workers.values(), ...subs.values(), ...leaving, ...npcs];
  for (const w of all) {
    if (!w?.root) continue;
    const walking = w.phase === 'walk' && !w.held;
    const hid = (!!w.inStall && !walking) || !!w.away || !!w.offstage || isChibiHiddenBySetting(w);
    w.root.visible = !hid;
    w.root.matrixWorldAutoUpdate = !hid;
    if (hid) {
      if (w.tagObj) w.tagObj.visible = false;
      if (w.bubbleObj) w.bubbleObj.visible = false;
    } else {
      if (w.tagObj) {
        if (w.sub || w.isSub) w.tagObj.visible = state.showSubNames !== false;
        else if (w.deptStaff || w.isDeptAmbient || w.staff) w.tagObj.visible = state.showStaffNames !== false;
        else w.tagObj.visible = state.showChibiNames !== false;
      }
      if (w.bubbleObj) {
        w.bubbleObj.visible = Boolean(w.lastSay && (w.sayHushAt > state.sim || w.lastSay.kind === 'wait'));
      }
    }
  }
  if (state.showSessionChibis === false) {
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      scene.remove(z.s);
      z.s.material.dispose();
      zs.splice(i, 1);
    }
  }
}
function puffZ(w) {
  if (reduceMotion || isChibiHiddenBySetting(w)) return;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: zTex, transparent: true, depthWrite: false }));
  s.position.set(w.pos.x + 0.25, 1.95, w.pos.y + 0.15); s.scale.setScalar(0.22);
  scene.add(s); zs.push({ s, life: 2.2 });
}
export function updateZs(dt) {
  if (state.showSessionChibis === false && zs.length > 0) {
    for (let i = zs.length - 1; i >= 0; i--) {
      const z = zs[i];
      scene.remove(z.s);
      z.s.material.dispose();
      zs.splice(i, 1);
    }
    return;
  }
  for (let i = zs.length - 1; i >= 0; i--) {
    const z = zs[i]; z.life -= dt;
    z.s.position.y += dt * 0.35; z.s.position.x += Math.sin(z.life * 3) * dt * 0.15;
    z.s.scale.setScalar(0.22 + (2.2 - z.life) * 0.08); z.s.material.opacity = Math.min(1, z.life / 0.8);
    if (z.life <= 0) { scene.remove(z.s); z.s.material.dispose(); zs.splice(i, 1); }
  }
}
function lookOf(s) { const h = hash(s.name); return { shirt: colorOf(s), hair: HAIRS[h % HAIRS.length], style: STYLES[(h >>> 3) % STYLES.length], acc: ACCS[(h >>> 7) % ACCS.length], coat: COATS[(h >>> 11) % COATS.length], bag: BAGS[(h >>> 15) % BAGS.length] }; }
export const workers = new Map();   // session id -> Worker
export const npcs = [];             // people who aren't sessions: the director on the company floor + idle deptStaff
export const deptWorkers = [];      // standing department staff (3-4 per department)
export const subs = new Map();      // subagent id -> Worker
export const sessions = new Map();  // session id -> latest session object from the server
export let Worker;

const pickList = (key) => {
  const l = tr(key, null, 'list');
  return Array.isArray(l) ? l[Math.floor(Math.random() * l.length)] : l;
};

export function rekeySub(oldId, newId, info = null) {
  if (!oldId || !newId || oldId === newId || !subs.has(oldId)) return subs.get(newId) || null;
  const sw = subs.get(oldId);
  subs.delete(oldId);
  if (subs.has(newId)) {
    // Target already exists; silently release the duplicate provisional worker
    releaseSubWorkerImmediate(sw);
    return subs.get(newId);
  }
  sw.id = newId;
  if (info?.desc) sw.desc = info.desc;
  if (info?.type && info.type !== 'agent') {
    const deptCfg = DEPT_INFO[sw.dept ?? 0] || DEPT_INFO[0];
    const rawName = info.type;
    const displayName = /^\[[A-Z]{2,3}\]/.test(rawName) ? rawName : `[${deptCfg.badge}] ${short(rawName, 22)}`;
    sw.setName(displayName);
  }
  subs.set(newId, sw);
  return sw;
}

function releaseSubWorkerImmediate(w) {
  if (!w) return;
  leaving.delete(w);
  if (w.deptStaff && !w.isTempSupport) {
    w.busySub = false; w.sub = false; w.isSub = false; w.parent = null; w.id = w.defaultId; w.desc = ''; w.want = null; w.reportingToBoss = false;
    w.inBriefing = false; w.briefGuestOf = null; w.deferredSubAct = null; w.hurry = false;
    w.tagEl.classList.remove('tag--sub');
    w.setName(w.defaultName);
    if (!npcs.includes(w)) npcs.push(w);
    const seat = w.subDesk >= 0 ? DESK_SPOTS[w.subDesk] : null;
    if (seat) {
      if ('by' in seat) seat.by = w;
      w.pos.set(seat.x, seat.z); w.spot = seat; w.face = w.faceTarget = seat.face; w.pose = 'sit'; w.station = 'desk'; w.anim = 'type';
      deskKit[w.subDesk] = w;
    }
  } else {
    w.remove();
  }
}

function deferMainAction(w, a) {
  if (!w || !a) return;
  w.deferredWork ||= [];
  const isStop = a.type === 'stop' || a.station === 'director';
  const existingStopIdx = w.deferredWork.findIndex((x) => x.type === 'stop' || x.station === 'director');
  if (isStop) {
    if (existingStopIdx >= 0) w.deferredWork.splice(existingStopIdx, 1);
    w.deferredWork.push(a);
    return;
  }
  if (existingStopIdx >= 0) {
    w.deferredWork.splice(existingStopIdx, 0, a);
  } else {
    w.deferredWork.push(a);
  }
  while (w.deferredWork.length > 5) w.deferredWork.shift();
}

function popDeferredMainAction(w) {
  if (!w?.deferredWork?.length) return null;
  const stopIdx = w.deferredWork.findIndex((x) => x.type === 'stop' || x.station === 'director');
  if (stopIdx >= 0) {
    const [stopAct] = w.deferredWork.splice(stopIdx, 1);
    w.deferredWork.length = 0;
    return stopAct;
  }
  const nextAct = w.deferredWork.pop();
  w.deferredWork.length = 0;
  return nextAct;
}

function checkBossSubsDone(boss) {
  if (!boss) return;
  const activeCount = [...subs.values()].filter((sw) => sw.parent === boss).length;
  const reportingCount = [...npcs, ...leaving].filter((sw) => sw.reportingToBoss && sw.parent === boss).length;
  const guestCount = deptWorkers.filter((dw) => dw.briefGuestOf === boss && dw.inBriefing).length;
  boss.setTeam(activeCount);
  if (activeCount === 0 && reportingCount === 0 && guestCount === 0 && !boss.inSubBrief && boss.waitingForSubs) {
    boss.waitingForSubs = false;
    boss.inSubBrief = false;
    boss.hasCalledSubSupport = false;
    boss.briefRoomIdx = null;
    if (boss.deferredWork?.length) {
      const nextAct = popDeferredMainAction(boss);
      if (nextAct && !boss.want) boss.push(nextAct);
    }
    if (!boss.want && !boss.leaving && (boss.station === 'phone' || boss.station === 'meeting')) {
      const s = sessions.get(boss.id);
      if (s?.status !== 'wait') {
        boss.hush();
        boss.lastSay = null;
      }
      if (s?.status === 'rest') {
        boss.goHomeAndRest();
      } else {
        const home = boss.homeSpot();
        const d = s?.desk ?? -1;
        boss.goTo(home, () => {
          boss.station = 'desk';
          boss.pose = home.sit ? 'sit' : 'stand';
          boss.anim = 'type';
          if (s?.status !== 'wait') {
            boss.hush();
            boss.lastSay = null;
          }
          if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = boss;
        });
      }
    }
  }
}

function pickBriefRoom(parent) {
  if (parent.briefRoomIdx != null && MEET_SEATS_BY_ROOM[parent.briefRoomIdx]) return parent.briefRoomIdx;
  const usedRooms = new Set();
  for (const w of workers.values()) if (w !== parent && w.briefRoomIdx != null) usedRooms.add(w.briefRoomIdx);
  for (let r = 0; r < MEET_ROOMS.length; r++) {
    if (!usedRooms.has(r)) return r;
  }
  return hash(parent.id || '0') % Math.max(1, MEET_ROOMS.length);
}

function scheduleSubBriefing(parent) {
  if (!parent || parent.leaving || parent.callingPhone) return;
  parent.waitingForSubs = true;
  parent.inSubBrief = true;
  if (parent.briefTimer) clearTimeout(parent.briefTimer);
  if (replay.on) {
    parent.briefTimer = null;
    runSubBriefing(parent);
    return;
  }
  parent.briefTimer = setTimeout(() => {
    parent.briefTimer = null;
    runSubBriefing(parent);
  }, 80);
}

function runSubBriefing(parent) {
  if (!parent || parent.leaving || parent.callingPhone || !workers.has(parent.id)) return;
  if (replay.on) {
    parent.inSubBrief = false;
    parent.hurry = false;
    parent.hush();
    parent.lastSay = null;
    const home = parent.homeSpot();
    const d = sessions.get(parent.id)?.desk ?? -1;
    parent.pos.set(home.x, home.z);
    parent.spot = home;
    parent.face = parent.faceTarget = home.face;
    parent.pose = home.sit ? 'sit' : 'stand';
    parent.station = 'desk';
    parent.phase = 'idle';
    parent.path = [];
    parent.onArrive = null;
    parent.anim = 'type';
    if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = parent;
    for (const sw of [...subs.values()].filter((x) => x.parent === parent && !x.briefed)) {
      sw.callingPhoneWait = false;
      sw.offstage = false;
      sw.enteringFromLift = false;
      sw.inBriefing = false;
      sw.briefed = true;
      sw.liftHold = false;
      sw.hurry = false;
      sw.dress(false);
      const seat = sw.homeSpot();
      if (seat && 'by' in seat) seat.by = sw;
      sw.pos.set(seat.x, seat.z);
      sw.spot = seat;
      sw.face = sw.faceTarget = seat.face;
      sw.pose = seat.sit ? 'sit' : 'stand';
      sw.station = 'meeting';
      sw.phase = 'idle';
      sw.path = [];
      sw.onArrive = null;
      sw.anim = 'type';
      if (sw.deferredSubAct) {
        const act = sw.deferredSubAct;
        sw.deferredSubAct = null;
        sw.push(act);
      }
      if (sw.pendingDropReport != null) {
        const rep = sw.pendingDropReport;
        sw.pendingDropReport = null;
        dropSub(sw.id, rep);
      }
    }
    checkBossSubsDone(parent);
    return;
  }
  const teamSubs = [...subs.values()].filter((sw) => sw.parent === parent && !sw.leaving && !sw.callingPhoneWait && !sw.briefed);
  const participants = teamSubs.slice(0, 6);
  if (participants.length === 0) {
    parent.inSubBrief = false;
    parent.hurry = false;
    for (const sw of [...subs.values()].filter((x) => x.parent === parent)) {
      sw.callingPhoneWait = false;
      sw.inBriefing = false;
      sw.briefed = true;
      sw.offstage = false;
      sw.enteringFromLift = false;
      sw.liftHold = false;
      if (sw.pendingDropReport != null) {
        const rep = sw.pendingDropReport;
        sw.pendingDropReport = null;
        dropSub(sw.id, rep);
      }
    }
    checkBossSubsDone(parent);
    if (parent.station !== 'desk' && !parent.want && !parent.leaving) {
      const s = sessions.get(parent.id);
      if (s?.status !== 'wait') {
        parent.hush();
        parent.lastSay = null;
      }
      const home = parent.homeSpot();
      const d = s?.desk ?? -1;
      parent.goTo(home, () => {
        parent.station = 'desk';
        parent.pose = home.sit ? 'sit' : 'stand';
        parent.anim = 'type';
        if (s?.status !== 'wait') {
          parent.hush();
          parent.lastSay = null;
        }
        if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = parent;
      });
    }
    return;
  }
  const roomIdx = pickBriefRoom(parent);
  parent.briefRoomIdx = roomIdx;
  parent.waitingForSubs = true;
  parent.inSubBrief = true;
  parent.hurry = true;
  const rm = MEET_ROOMS[roomIdx] || MEET_ROOMS[0];
  const seats = MEET_SEATS_BY_ROOM[roomIdx] || MEET_SEATS_BY_ROOM[0] || STATIONS.meeting;
  const bossSeat = seats[0] || STATIONS.brief?.[roomIdx] || parent.homeSpot();
  const promptText = short(sessions.get(parent.id)?.lastPrompt || tr('people.newTask'), 38);

  const totalAttendees = 1 + participants.length;
  let arrivedCount = 0;
  let meetingStarted = false;

  const finishBriefing = () => {
    if (parent.briefWalkTimer) { clearTimeout(parent.briefWalkTimer); parent.briefWalkTimer = null; }
    if (parent.briefEndTimer) { clearTimeout(parent.briefEndTimer); parent.briefEndTimer = null; }
    parent.inSubBrief = false;
    parent.hurry = false;
    const stillHasSubs = [...subs.values()].some((sw) => sw.parent === parent && !sw.leaving);
    if (!stillHasSubs) {
      parent.waitingForSubs = false;
      parent.hasCalledSubSupport = false;
      parent.briefRoomIdx = null;
    }
    // Main Agent returns straight to sit at its own workspace desk after everyone finishes the meeting briefing
    if (workers.get(parent.id) === parent && !parent.leaving) {
      const s = sessions.get(parent.id);
      if (s?.status !== 'wait') {
        parent.hush();
        parent.lastSay = null;
      }
      const home = parent.homeSpot();
      const d = s?.desk ?? -1;
      parent.goTo(home, () => {
        parent.station = 'desk';
        parent.pose = home.sit ? 'sit' : 'stand';
        parent.anim = 'type';
        if (s?.status !== 'wait') {
          parent.hush();
          parent.lastSay = null;
        }
        if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = parent;
        if (!parent.waitingForSubs && parent.deferredWork?.length) {
          const nextAct = popDeferredMainAction(parent);
          if (nextAct && !parent.want) parent.push(nextAct);
        }
      });
    }
    // Each Subagent in this briefing starts its subsequent task/action after the meeting finishes
    for (const sw of participants) {
      if (!subs.has(sw.id) || sw.leaving) continue;
      sw.callingPhoneWait = false;
      sw.offstage = false;
      sw.enteringFromLift = false;
      sw.liftHold = false;
      sw.inBriefing = false;
      sw.briefed = true;
      sw.hurry = false;
      if (sw.pos.x > -6.0) sw.dress(false);
      const seat = sw.homeSpot();
      if (sw.deferredSubAct) {
        const act = sw.deferredSubAct;
        sw.deferredSubAct = null;
        sw.dwellUntil = 0;
        sw.push(act);
        if (sw.phase !== 'walk') sw.tick();
        if (sw.pendingDropReport != null) {
          const rep = sw.pendingDropReport;
          sw.pendingDropReport = null;
          setTimeout(() => { if (subs.has(sw.id)) dropSub(sw.id, rep); }, 1400);
        }
      } else if (sw.pendingDropReport != null) {
        const rep = sw.pendingDropReport;
        sw.pendingDropReport = null;
        setTimeout(() => { if (subs.has(sw.id)) dropSub(sw.id, rep); }, 600);
      } else if (!sw.want) {
        const alreadyGoingToSeat = sw.phase === 'walk' && sw.spot === seat;
        const alreadyAtSeat = sw.spot === seat && Math.hypot(sw.pos.x - seat.x, sw.pos.y - seat.z) < 0.25;
        if (!alreadyGoingToSeat && !alreadyAtSeat) {
          sw.goTo(seat, () => {
            sw.dress(false);
            sw.station = 'meeting';
            sw.pose = seat.sit ? 'sit' : 'stand';
            sw.anim = 'type';
            sw.say('agent', sw.desc || tr('people.subThinking'));
          });
        }
      }
    }
  };

  const startMeetingHold = () => {
    if (meetingStarted) return;
    meetingStarted = true;
    if (parent.briefWalkTimer) { clearTimeout(parent.briefWalkTimer); parent.briefWalkTimer = null; }
    if (parent.briefEndTimer) clearTimeout(parent.briefEndTimer);
    const holdMs = sessions.get(parent.id)?.status === 'rest' ? 500 : 1100;
    parent.briefEndTimer = setTimeout(finishBriefing, holdMs);
  };

  const onMemberArrived = () => {
    arrivedCount++;
    if (arrivedCount >= totalAttendees) startMeetingHold();
  };

  if (parent.briefWalkTimer) clearTimeout(parent.briefWalkTimer);
  if (parent.briefEndTimer) { clearTimeout(parent.briefEndTimer); parent.briefEndTimer = null; }
  parent.briefWalkTimer = setTimeout(startMeetingHold, 6200);

  if (parent.want) {
    deferMainAction(parent, parent.want);
    parent.want = null;
  }
  parent.goTo(bossSeat, () => {
    if (!parent.waitingForSubs) return;
    parent.station = 'meeting';
    parent.pose = bossSeat.sit ? 'sit' : 'stand';
    parent.faceTarget = faceTo(parent.pos.x, parent.pos.y, rm.x, rm.z);
    parent.anim = 'board';
    parent.say('agent', tr('people.handOver', { what: promptText }));
    onMemberArrived();
  });

  participants.forEach((sw, idx) => {
    const seat = seats[Math.min(idx + 1, seats.length - 1)] || bossSeat;
    sw.meetSeat = seat;
    sw.inBriefing = true;
    sw.hurry = true;
    sw.enteringFromLift = false;
    const onSeatReached = () => {
      sw.dress(false);
      sw.station = 'meeting';
      sw.pose = seat.sit ? 'sit' : 'stand';
      sw.faceTarget = faceTo(sw.pos.x, sw.pos.y, rm.x, rm.z);
      sw.anim = idx % 2 === 0 ? 'idle' : 'read';
      sw.say('agent', tr('people.subOnIt', { task: short(sw.desc || sw.subType || promptText || tr('people.subagent'), 44) }));
      onMemberArrived();
    };
    if (sw.phase === 'walk' && sw.spot === seat) {
      sw.onArrive = onSeatReached;
    } else {
      sw.goTo(seat, onSeatReached);
    }
  });
}
export function addWorker(s, walkIn) {
  const w = new Worker({ name: s.name, ...lookOf(s) }, { id: s.id });
  if (s.desk >= 0 && s.desk < chairs.length && chairs[s.desk]) chairs[s.desk].color.set(colorOf(s));
  const home = w.homeSpot();
  if (w.lateRest(s)) {   // opened or discovered while idle >= 8h: stays at home, never rides the lift or calls HR
    w.away = true; w.station = 'away'; w.pos.set(DOOR_OUT.x, DOOR_OUT.z); w.spot = DOOR_OUT; w.dress(true); w.hush();
    awayHooks.change?.(w);
  } else if (walkIn) {
    w.pos.set(DOOR_OUT.x, DOOR_OUT.z); w.face = w.faceTarget = Math.PI / 2; w.spot = DOOR_OUT;
    w.dress(true); liftArrive(w); clockHooks.newcomer?.(w);
    viaClock('in', w, () => w.goTo(home, () => { w.station = 'desk'; w.anim = 'type'; if (home === DESK_SPOTS[s.desk]) w.unpack(s.desk); else w.dress(false); }));
  } else {
    if (home && 'by' in home) home.by = w;
    w.pos.set(home.x, home.z); w.spot = home; w.face = w.faceTarget = home.face; w.pose = home.sit ? 'sit' : 'stand'; w.station = 'desk';
    if (s.desk >= 0 && s.desk < DESK_SPOTS.length) deskKit[s.desk] = w;
    if (s.status === 'rest') { w.anim = 'sleep'; w.hush(); }
    else if (s.status === 'wait') { w.anim = 'hand'; w.say('wait', tr('people.needsApproval'), 'wait'); }
    else { w.anim = 'type'; if (s.last) w.say(s.last.type, s.last.label || verb(s.last)); }
  }
  workers.set(s.id, w);
  for (const sub of s.subs || []) spawnSub(w, sub.id, sub.type, !walkIn, sub);
  return w;
}
function releaseQueuedPhoneSubs(parent) {
  if (!parent) return;
  const batch = (parent.pendingPhoneSubs || []).splice(0);
  for (const sw of batch) {
    if (!subs.has(sw.id) || sw.leaving) continue;
    sw.callingPhoneWait = false;
    sw.offstage = false;
    sw.enteringFromLift = true;
    sw.inBriefing = true;
    sw.hurry = true;
    sw.dress(true);
    liftArrive(sw);
    sw.say('agent', pickList('people.phoneSupport.arrive'));
  }
}
function hasAllExpectedSubs(parent) {
  if (!parent) return true;
  if ((parent.pendingPhoneSubs?.length || 0) > 0) return false;
  const expected = sessions.get(parent.id)?.subs || [];
  for (const x of expected) {
    if (!x?.id) continue;
    const sw = subs.get(x.id);
    if (sw && sw.callingPhoneWait) return false;
  }
  return true;
}
export function spawnSub(parent, agentId, type, instant = false, info = null) {
  if (!agentId) return null;
  if (info?.prevId && subs.has(info.prevId)) {
    return rekeySub(info.prevId, agentId, { type, desc: info.desc });
  }
  const x = () => info || sessions.get(parent.id)?.subs?.find((y) => y.id === agentId);
  const initInfo = x();
  const deptIdx = classifyDept(type || '', initInfo?.desc || '');
  if (!String(agentId).startsWith('prov-')) {
    for (const [k, sw] of subs) {
      if (sw.parent === parent && String(k).startsWith('prov-') && sw.dept === deptIdx) {
        return rekeySub(k, agentId, { type, desc: info?.desc });
      }
    }
    for (const [k, sw] of subs) {
      if (sw.parent === parent && String(k).startsWith('prov-')) {
        return rekeySub(k, agentId, { type, desc: info?.desc });
      }
    }
  }
  if (subs.has(agentId)) return subs.get(agentId);
  const h = hash(agentId);
  const deptCfg = DEPT_INFO[deptIdx] || DEPT_INFO[0];
  const rawName = type || 'agent';
  const displayName = /^\[[A-Z]{2,3}\]/.test(rawName) ? rawName : `[${deptCfg.badge}] ${short(rawName, 22)}`;

  const w = new Worker({
    name: displayName,
    shirt: deptCfg.shirt || tint(parent.cfg.shirt, 0.3),
    hair: HAIRS[h % HAIRS.length],
    style: deptCfg.style || STYLES[(h >>> 3) % STYLES.length],
    acc: deptCfg.acc ?? ((h >>> 6) % 3 === 0 ? 'glasses' : null),
    pants: deptCfg.pants || '#4C566A',
    coat: COATS[(h >>> 9) % COATS.length],
    bag: BAGS[(h >>> 12) % BAGS.length],
  }, { sub: true, scale: 0.84, parent, id: agentId });
  w.dept = deptIdx;
  w.deptBadge = deptCfg.badge;
  w.subType = type || 'agent';
  w.desc = initInfo?.desc || '';
  w.isTempSupport = true;
  w.subDesk = -1;
  if (w.tagDot) w.tagDot.style.background = deptCfg.color;
  subs.set(agentId, w);
  const teamSubs = [...subs.values()].filter((sw) => sw.parent === parent);
  parent.setTeam(teamSubs.length);

  const roomIdx = pickBriefRoom(parent);
  parent.briefRoomIdx = roomIdx;
  const roomSeats = MEET_SEATS_BY_ROOM[roomIdx] || MEET_SEATS_BY_ROOM[0] || STATIONS.meeting || [];
  if (roomSeats.length > 0) {
    const seatIdx = Math.min(teamSubs.length, roomSeats.length - 1);
    w.meetSeat = roomSeats[seatIdx] || roomSeats[0];
  }

  const seated = () => {
    w.briefed = true;
    w.inBriefing = false;
    w.station = 'meeting';
    w.anim = 'type';
    const i = x();
    if (i?.last) w.say(i.last.type, i.last.label || verb(i.last)); else w.say('agent', i?.desc || type || 'agent');
  };
  if (instant || replay.on) {
    const seat = w.homeSpot();
    if (seat && 'by' in seat) seat.by = w;
    w.pos.set(seat.x, seat.z); w.spot = seat; w.face = w.faceTarget = seat.face; w.pose = seat.sit ? 'sit' : 'stand'; seated();
    const last = x()?.last; if (last && ACT[last.type]) w.push(subAct({ type: last.type, label: last.label }));
    return w;
  }

  // Every time Main Agent assigns a task to a Subagent:
  // 1) Main Agent walks to the Reception 3D Telephone once per subagent wave to call support
  // 2) Subagent(s) arrive via the elevator
  // 3) Main Agent and unbriefed Subagents walk into the Meeting Room and hold a briefing before starting subsequent tasks
  parent.waitingForSubs = true;
  const alreadySupported = Boolean(parent.hasCalledSubSupport)
    || [...subs.values()].some((sw) => sw !== w && sw.parent === parent && !sw.leaving && (sw.briefed || (!sw.callingPhoneWait && !sw.inBriefing)));
  if ((parent.inSubBrief || alreadySupported) && !parent.callingPhone && !parent.leaving) {
    w.callingPhoneWait = false;
    w.offstage = false;
    w.enteringFromLift = true;
    w.inBriefing = Boolean(parent.inSubBrief);
    w.briefed = !parent.inSubBrief;
    w.hurry = true;
    w.dress(true);
    liftCall(4.0);
    liftArrive(w);
    w.say('agent', pickList('people.phoneSupport.arrive'));
    const seat = w.homeSpot();
    w.goTo(seat, () => {
      if (w.leaving) return;
      w.enteringFromLift = false;
      w.inBriefing = false;
      w.briefed = true;
      w.hurry = false;
      w.dress(false);
      w.station = 'meeting';
      w.pose = seat.sit ? 'sit' : 'stand';
      w.anim = 'type';
      if (w.deferredSubAct) {
        const act = w.deferredSubAct;
        w.deferredSubAct = null;
        w.dwellUntil = 0;
        w.push(act);
        w.tick();
      }
    });
    return w;
  }

  w.callingPhoneWait = true;
  w.inBriefing = true;
  w.offstage = true;
  w.pos.set(DOOR_OUT.x, DOOR_OUT.z); w.face = w.faceTarget = Math.PI / 2; w.spot = DOOR_OUT;
  (parent.pendingPhoneSubs ||= []).push(w);

  const finishPhoneCall = () => {
    if (parent.phoneWalkTimer) { clearTimeout(parent.phoneWalkTimer); parent.phoneWalkTimer = null; }
    if (parent.phoneTimer) { clearTimeout(parent.phoneTimer); parent.phoneTimer = null; }
    parent._finishPhoneCall = null;
    if (PRO_FX.phoneHandset) PRO_FX.phoneHandset.position.y = 0.036;
    parent.callingPhone = false;
    parent.hurry = false;
    parent.hasCalledSubSupport = true;
    parent.hush();
    parent.lastSay = null;
    releaseQueuedPhoneSubs(parent);
    if (parent.leaving) return;
    const unbriefedSubs = [...subs.values()].filter(
      (sw) => sw.parent === parent && !sw.leaving && !sw.callingPhoneWait && !sw.briefed
    );
    if (unbriefedSubs.length > 0) {
      scheduleSubBriefing(parent);
    } else {
      parent.inSubBrief = false;
      const hasAnySub = [...subs.values()].some((sw) => sw.parent === parent && !sw.leaving);
      if (!hasAnySub) checkBossSubsDone(parent);
      if (!parent.want) {
        const s = sessions.get(parent.id);
        if (s?.status === 'rest' && !parent.waitingForSubs) {
          parent.goHomeAndRest();
        } else {
          const home = parent.homeSpot();
          const d = s?.desk ?? -1;
          parent.goTo(home, () => {
            parent.station = 'desk';
            parent.pose = home.sit ? 'sit' : 'stand';
            parent.anim = 'type';
            parent.hush();
            parent.lastSay = null;
            if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = parent;
          });
        }
      }
    }
  };

  const holdCallAndWait3s = () => {
    if (parent.leaving || !parent.callingPhone) return;
    if (parent.phoneWalkTimer) { clearTimeout(parent.phoneWalkTimer); parent.phoneWalkTimer = null; }
    parent.station = 'phone';
    parent.anim = 'hand';
    if (PRO_FX.phoneHandset) PRO_FX.phoneHandset.position.y = 0.085;
    releaseQueuedPhoneSubs(parent);
    if (hasAllExpectedSubs(parent)) {
      if (parent.phoneTimer) clearTimeout(parent.phoneTimer);
      parent.phoneTimer = setTimeout(parent._finishPhoneCall || finishPhoneCall, reduceMotion ? 250 : 3000);
    }
  };

  const phoneSpot = STATIONS.phone?.[0];
  if (PRO && phoneSpot && !parent.leaving) {
    liftCall(4.0);
    if (!parent.callingPhone) {
      if (parent.briefTimer) { clearTimeout(parent.briefTimer); parent.briefTimer = null; }
      if (parent.briefWalkTimer) { clearTimeout(parent.briefWalkTimer); parent.briefWalkTimer = null; }
      if (parent.briefEndTimer) { clearTimeout(parent.briefEndTimer); parent.briefEndTimer = null; }
      if (parent.phoneWalkTimer) { clearTimeout(parent.phoneWalkTimer); parent.phoneWalkTimer = null; }
      if (parent.phoneTimer) { clearTimeout(parent.phoneTimer); parent.phoneTimer = null; }
      parent.inSubBrief = false;
      parent.callingPhone = true;
      parent.hurry = true;
      parent._finishPhoneCall = finishPhoneCall;
      if (parent.want) {
        deferMainAction(parent, parent.want);
        parent.want = null;
      }
      parent.phoneWalkTimer = setTimeout(finishPhoneCall, reduceMotion ? 600 : 9500);
      parent.goTo(phoneSpot, () => {
        if (parent.phoneWalkTimer) { clearTimeout(parent.phoneWalkTimer); parent.phoneWalkTimer = null; }
        if (parent.leaving || !parent.callingPhone) return;
        sfx.play('beep');
        parent.say('agent', pickList('people.phoneSupport.call'));
        parent.sayHushAt = state.sim + 5.0;
        holdCallAndWait3s();
      });
    } else if (parent.station === 'phone' || Math.hypot(parent.pos.x - phoneSpot.x, parent.pos.y - phoneSpot.z) < 0.35) {
      parent.sayHushAt = state.sim + 5.0;
      holdCallAndWait3s();
    }
  } else {
    releaseQueuedPhoneSubs(parent);
    scheduleSubBriefing(parent);
  }
  return w;
}
export function classifyDept(roleOrType = '', desc = '') {
  const s = `${roleOrType} ${desc}`.toLowerCase();
  if (/ui-chat|world-3d|frontend|front-end|\bui\b|\bcss\b|three|webgl|design|layout|landing|mobile|hero|style|component/.test(s)) return 0;
  if (/qa-test|\bqa\b|\btest\b|verify|lint|typecheck|playwright|vitest|pytest|check|audit|bug/.test(s)) return 3;
  if (/research|explore|\bba\b|plan|doc|spec|search|architecture|analyst|investigat|pipeline|data/.test(s)) return 2;
  if (/backend|back-end|server|\bapi\b|sql|db|auth|infra|deploy|general|agent|worker|shop/.test(s)) return 1;
  return hash(s || 'agent') % 4;
}
// What a subagent does for one of its steps: the same places as everyone (library, server room, window), its "desk"
// is the meeting table; it stays at least 2.5 s somewhere before moving on, so a burst of steps doesn't make it run.
export function subAct(e) {
  const a = ACT[e.type] || ACT.other;
  return { ...a, type: ACT[e.type] ? e.type : 'other', text: bubbleText(e), e, dwell: Math.max(2.5, a.dwell || 0), kind: e.type === 'fail' ? 'fail' : a.kind };
}
// A free place to stand next to the boss (behind or beside, never inside their desk), clear of other people.
export function nearBoss(boss, me) {
  const f = boss.face, others = [...workers.values(), ...subs.values(), ...leaving, ...npcs].filter((o) => o !== me && o !== boss).map((o) => (o.spot ? [o.spot.x, o.spot.z] : [o.pos.x, o.pos.y]));
  for (const r of [0.95, 1.4, 1.9]) for (const da of [Math.PI, Math.PI / 2, -Math.PI / 2, (3 * Math.PI) / 4, -(3 * Math.PI) / 4, Math.PI / 4, -Math.PI / 4, 0]) {
    const a = f + da, x = boss.pos.x + Math.sin(a) * r, z = boss.pos.y + Math.cos(a) * r;
    if (!inside(x, z) || (fp.grid && blocked(x, z, 0.28))) continue;
    if (others.every(([ox, oz]) => Math.hypot(ox - x, oz - z) >= 0.85)) return { x, z, face: Math.atan2(boss.pos.x - x, boss.pos.y - z), node: nearestNode(new V2(x, z)) };
  }
  return allocate('meeting', me);
}
function calcPace(w) {
  if (!w) return 1.0;
  const idStr = String(w.id || '');
  const isDirectorOrExec = idStr === '__director' || idStr.startsWith('__team_');
  let activeWork = false;
  if (isDirectorOrExec) {
    activeWork = Boolean(w.job) || (w.queue?.length > 0);
  } else if (w.sub || w.isSub) {
    activeWork = !w.leaving || Boolean(w.reportingToBoss);
  } else if (!w.deptStaff && !w.staff && w.id && sessions.has(w.id)) {
    const s = sessions.get(w.id);
    const personalTrip = Boolean(w.chore || w.outing || w.homeBound || w.wcBusy || w.inStall);
    const sessionActive = s?.status === 'work' || Boolean(s?.busy || w.callingPhone || w.inSubBrief || w.waitingForSubs || (w.deferredWork?.length > 0));
    activeWork = sessionActive && !personalTrip;
  } else {
    activeWork = Boolean(w.hurry || w.inBriefing || w.inSubBrief || w.reportingToBoss || w.callingPhone);
  }
  if (!activeWork) return 1.0;

  const urgentWork = Boolean(
    w.callingPhone ||
    w.inSubBrief ||
    w.inBriefing ||
    w.reportingToBoss ||
    (w.deferredWork?.length > 0) ||
    w.deferredSubAct
  );
  let pace = urgentWork
    ? 1.75 + Math.min(0.3, (w.deferredWork?.length || 0) * 0.1)
    : 1.55;

  if (w.path?.length > 0) {
    const lastPt = w.path[w.path.length - 1];
    const remDist = Math.hypot((lastPt.x ?? w.pos.x) - w.pos.x, (lastPt.y ?? w.pos.y) - w.pos.y) + w.path.length * 1.2;
    if (remDist > 8) pace += Math.min(0.2, (remDist - 8) * 0.025);
  }
  return Math.min(2.05, pace);
}
// Workers walking out of the office: no longer in workers/subs, but still animated until they reach the door.
export const leaving = new Set();
export const leavingIds = new Set();
export function dropSub(agentId, report = true) {
  const w = subs.get(agentId); if (!w) return;
  const boss = w.parent;
  if (report && !document.hidden && !reduceMotion && !replay.on && boss && workers.get(boss.id) === boss && !boss.leaving) {
    if (w.callingPhoneWait || w.inBriefing || boss.callingPhone || boss.inSubBrief) {
      w.pendingDropReport = report;
      return;
    }
  }
  subs.delete(agentId);
  if (document.hidden || reduceMotion || !report || !boss || workers.get(boss.id) !== boss || boss.leaving || replay.on) {
    if (w.deptStaff && !w.isTempSupport) {
      releaseSubWorkerImmediate(w);
    } else if (document.hidden) {
      leaving.delete(w); w.remove();
    } else {
      leaving.add(w); w.leave();
    }
    checkBossSubsDone(boss);
    return;
  }
  if (w.deptStaff && !w.isTempSupport) {
    if (!npcs.includes(w)) npcs.push(w);
  } else {
    leaving.add(w);
  }
  w.reportingToBoss = true;
  const desc = w.desc || '';
  w.want = null; w.inBriefing = false; w.briefGuestOf = null; w.deferredSubAct = null; w.hurry = true; w.hush();
  if (boss) boss.setTeam([...subs.values()].filter((sw) => sw.parent === boss).length);
  w.goTo(nearBoss(boss, w), () => {
    w.faceTarget = Math.atan2(boss.pos.x - w.pos.x, boss.pos.y - w.pos.y); w.anim = 'read';
    w.say('substop', tr('people.subReport', { what: desc ? short(desc, 44) : tr('people.subReportDone') }));
    const text = tr('people.bossThanks');
    boss.say('substop', text);
    setTimeout(() => { if (boss.lastSay?.text === text && boss.lastSay?.kind !== 'wait') { boss.hush(); boss.lastSay = null; } }, 1400);
    setTimeout(() => {
      w.reportingToBoss = false;
      w.hurry = false;
      w.say('idle', pickList('people.phoneSupport.bye'));
      w.dress(true);
      w.leave();
      checkBossSubsDone(boss);
    }, 900);
  });
}

export function setup() {
  AGENT_SVG = {
    claude: `<path fill="#D97757" d="${CLAUDE_MARK}"/>`,
    gemini: '<defs><linearGradient id="gm-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4285F4"/><stop offset=".55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs><path fill="url(#gm-g)" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/>',
    codex: '<path fill="#FFFFFF" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/>',
  };
  /* floating "z" for napping chibis */
  zTex = canvasTex(64, 64, (g) => { g.font = '900 46px "Baloo 2", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 7; g.strokeStyle = '#1F2A12'; g.strokeText('z', 32, 34); g.fillStyle = '#FFFFFF'; g.fillText('z', 32, 34); });
  state.sim = 0;
  Worker = class Worker {
    constructor(cfg, opt = {}) {
      this.cfg = cfg; this.sub = !!opt.sub; this.isSub = this.sub; this.parent = opt.parent || null; this.id = opt.id;
      this.scale = opt.scale || 1;
      const { root, P } = makeChibi({ ...cfg, look: state.LOOK }, this.scale);
      this.root = root; this.P = P;
      if (SEASON === 'noel') wearHat(P);
      root.traverse((o) => { o.userData.worker = this; });
      scene.add(root);
      this.pos = new V2(); this.face = 0; this.faceTarget = 0;
      this.phase = 'idle'; this.anim = 'idle'; this.pose = 'stand';
      this.path = []; this.onArrive = null; this.spot = null; this.station = null;
      this.want = null; this.dwellUntil = 0; this.restAt = Infinity; this.leaving = false; this.lastSay = null;
      this.seed = rand(0, 10); this.blinkAt = rand(1, 4);
      this.tagEl = el('div', 'tag' + (this.sub ? ' tag--sub' : ''));
      this.tagDot = el('i'); this.tagDot.style.background = cfg.shirt;
      this.tagText = document.createTextNode(cfg.name);
      this.tagEl.append(this.tagDot, this.tagText);
      this.tagObj = new CSS2DObject(this.tagEl); this.tagObj.position.set(0, 2.05, 0); root.add(this.tagObj);
      this.labelObj = this.tagObj;
      this.zT = rand(0, 1.5);
      const bw = el('div', 'bubble-wrap'); this.bubbleEl = el('div', 'bubble'); bw.append(this.bubbleEl);
      this.bubbleObj = new CSS2DObject(bw); this.bubbleObj.position.set(0, 2.05, 0); this.bubbleObj.visible = false; root.add(this.bubbleObj);
      if (isChibiHiddenBySetting(this)) {
        this.root.visible = false;
        this.root.matrixWorldAutoUpdate = false;
        this.tagObj.visible = false;
        this.bubbleObj.visible = false;
      }
    }
    setName(n) { if (this.tagText.data !== n) this.tagText.data = n; }
    // the height they stand at: the office floor, or down on the street (the pavement, or the road on a crossing)
    gy() { return this.street ? this.ground : 0; }
    // which account the session runs under, when this Mac has more than one (a second login's folder name)
    setAcct(name) {
      if (this.acct === (name || '')) return; this.acct = name || '';
      if (!this.acctEl) { this.acctEl = el('span', 'tag-acct'); this.tagEl.insertBefore(this.acctEl, this.tagText.nextSibling); }
      this.acctEl.hidden = !this.acct; this.acctEl.textContent = this.acct;
    }
    setTeam(n) {
      if (this.team === n) return; this.team = n;
      if (!this.teamEl) { this.teamEl = el('span', 'tag-team'); this.tagEl.append(this.teamEl); }
      this.teamEl.hidden = !n; this.teamEl.textContent = n ? tr('people.team', { n }) : '';
    }
    rebuild() {
      const oldRoot = this.root;
      const { root, P } = makeChibi({ ...this.cfg, look: state.LOOK }, this.scale);
      if (SEASON === 'noel') wearHat(P);
      root.position.copy(oldRoot.position); root.rotation.copy(oldRoot.rotation);
      root.add(this.tagObj, this.bubbleObj);
      const parent = oldRoot.parent; if (parent) parent.remove(oldRoot);
      disposeChibi(oldRoot);
      this.root = root; this.P = P;
      root.traverse((o) => { o.userData.worker = this; });
      if (parent) parent.add(root);
      if (this.dressed) wearOuter(P, true, this.cfg);
    }
    // coat and backpack on (arriving, going home) or off (at the desk)
    dress(on) { this.dressed = on; wearOuter(this.P, on, this.cfg); }
    // at the desk on arrival: hang the coat on the chair, put the bag down
    unpack(d) {
      if (d < 0 || d == null) { this.dress(false); return; }
      this.anim = 'tidy'; this.hush(); this.afterAt = state.sim + (reduceMotion ? 0.2 : 1.0);
      this.after = () => { this.dress(false); deskKit[d] = this; this.anim = 'type'; };
    }
    say(type, text, kind = '') {
      if (!text || !String(text).trim()) {
        this.hush();
        this.lastSay = null;
        return;
      }
      this.lastSay = { type, text, kind };
      if (kind !== 'rest') this.pokeHushAt = 0;
      if (!text || ((type === 'idle' || type === 'party' || type === 'coffee') && kind === 'silent')) {
        this.sayHushAt = 0;
        this.bubbleObj.visible = false;
        return;
      }
      const key = `${type}|${text}|${kind}`;
      if (this.sayKey !== key) {
        this.sayKey = key;
        const ic = el('span', 'b-ico'); ic.append(icon(TYPE_ICON[type] || 'sparkle'));
        this.bubbleEl.replaceChildren(ic, el('span', 'b-txt', short(text, this.sub ? 60 : 80)));
        this.bubbleEl.className = 'bubble' + (kind ? ' bubble--' + kind : '') + (this.sub ? ' bubble--sub' : '');
      }
      if (state.showWorkSteps === false && TOOL_STEP_TYPES.has(type) && kind !== 'wait' && kind !== 'fail') {
        this.sayHushAt = 0;
        this.bubbleObj.visible = false;
        return;
      }
      const dur = (type === 'idle' || type === 'party' || type === 'coffee')
        ? 3.8
        : (type === 'agent' || type === 'stop' || type === 'substop' ? 4.2 : 5.5);
      this.sayHushAt = kind === 'wait' ? 0 : state.sim + dur;
      this.bubbleObj.visible = !isChibiHiddenBySetting(this) && this.root.visible;
    }
    hush() { this.sayHushAt = 0; this.bubbleObj.visible = false; }
    homeSpot() {
      if (this.sub || this.deptStaff) {
        if (this.meetSeat) return this.meetSeat;
        if (this.subDesk >= 0 && this.subDesk < DESK_SPOTS.length) return DESK_SPOTS[this.subDesk];
        return allocate('meeting', this);
      }
      const d = sessions.get(this.id)?.desk ?? -1;
      return d >= 0 && d < DESK_SPOTS.length ? DESK_SPOTS[d] : allocate('meeting', this);
    }
    goTo(spot, cb) {
      if (!spot) { cb && cb(); return; }
      if (this.mealBox) hideMeal(this);
      if (this.queued && !COFFEE_Q.includes(spot)) leaveCoffee(this);
      if (!this.sub && !this.chore && !this.reportingToBoss && this.station !== 'desk' && spot === this.homeSpot() && this.lastSay?.kind !== 'wait') {
        this.hush();
        this.lastSay = null;
      }
      const prev = this.spot;
      const inLiftCar = PRO && this.pos.x < -6.85 && Math.abs(this.pos.y - DOOR_OUT.z) < 0.85;
      const atPrev = prev && ((prev === DOOR_OUT && inLiftCar) || Math.hypot(this.pos.x - prev.x, this.pos.y - prev.z) < 0.1);
      if (prev && prev !== spot && prev.by === this) prev.by = null;
      this.spot = spot;
      if ('by' in spot) spot.by = this;
      const target = new V2(spot.x, spot.z);
      const targetNode = spot.node || nearestNode(target);
      if (prev === spot && atPrev && !inLiftCar) { this.pose = spot.sit ? 'sit' : 'stand'; cb && cb(); return; }
      // spots from wayTo / standBy (navigation.js) come with their way in (via): out of one the same way
      const V = ([x, z]) => new V2(x, z), N = (k) => { const pt = NODES[k] || NODES[PRO ? 'L2' : 'L'] || [0, 0]; return new V2(pt[0], pt[1]); }, out = atPrev && prev.via ? prev.via.map(V).reverse() : [];
      const startNode = inLiftCar ? 'O' : (atPrev && prev.node ? prev.node : nearestNode(this.pos));
      if (spot.direct) this.path = [...(spot.via || []).map(V), target];   // worked out from where they are
      else if (atPrev && prev.direct) {                             // back from it: to where they came from, then on
        const o = prev.origin;
        this.path = o === spot || !o ? [...out, target] : [...out, new V2(o.x, o.z), ...route(o.node, targetNode).map(N), target];
      } else if (atPrev && !inLiftCar && prev.node === targetNode && !prev.via && !spot.via) this.path = [target];
      else this.path = [...out, ...route(startNode, targetNode).map(N), ...(spot.via || []).map(V), target];
      this.pose = 'stand'; this.phase = 'walk'; this.onArrive = cb;
    }
    push(a) {
      if (!a) return;
      if (this.away) {
        const s = sessions.get(this.id);
        if (this.lateRest(s) && a.type !== 'prompt' && s?.status === 'rest' && !s?.bg?.length) return;
      }
      if (this.sub && (this.inBriefing || this.callingPhoneWait)) {
        this.deferredSubAct = a;
        return;
      }
      if ((this.callingPhone || this.inSubBrief) && !this.sub && !this.deptStaff && !this.staff) {
        deferMainAction(this, a);
        return;
      }
      if (this.waitingForSubs && !this.sub && !this.deptStaff && !this.staff) {
        if (a.type === 'stop' || a.station === 'director' || (a.station && a.station !== 'desk' && !a.priority)) {
          deferMainAction(this, a);
          if (a.type !== 'stop') {
            this.say(a.type || 'other', a.text, a.kind || '');
            if (this.station === 'desk') this.anim = 'type';
          }
          return;
        }
      }
      this.want = a;
    }
    apply(a) {
      this.anim = a.anim; this.phase = 'idle';
      this.say(a.type || 'other', a.text, a.kind || ''); if (a.e) this.lastSay.e = a.e;
      const fastDwell = this.deferredWork?.length > 0 || sessions.get(this.id)?.status === 'rest';
      const dwell = fastDwell ? Math.min(a.dwell || 1.2, 0.45) : (a.dwell ?? 1.4);
      this.dwellUntil = state.sim + dwell;
      this.restAt = a.rest ? state.sim + a.rest : Infinity;
      if (a.after) a.after();
    }
    tick() {
      if (this.sub && (this.callingPhoneWait || this.inBriefing)) {
        const p = this.parent;
        if (!p || p.leaving || (!p.callingPhone && !p.inSubBrief && !p.briefTimer)) {
          this.callingPhoneWait = false;
          this.inBriefing = false;
          this.offstage = false;
          this.enteringFromLift = false;
          this.liftHold = false;
          this.hurry = false;
          this.dress(false);
          if (this.deferredSubAct) {
            const act = this.deferredSubAct;
            this.deferredSubAct = null;
            this.push(act);
          }
          if (this.pos.x < -5.8 && this.phase !== 'walk' && !this.want) {
            const seat = this.homeSpot();
            this.goTo(seat, () => {
              this.station = 'meeting';
              this.pose = seat.sit ? 'sit' : 'stand';
              this.anim = 'type';
            });
            return;
          }
        }
      }
      if (this.leaving || this.phase === 'walk' || this.after || this.liftWait || this.liftRide || this.homeBound || this.callingPhone || this.inSubBrief || this.inBriefing || this.reportingToBoss) return;
      if (this.away) {
        const s = sessions.get(this.id);
        if (s && this.lateRest(s) && !this.want) return;
        if (this.want || (s && (s.status !== 'rest' || s.bg?.length || !this.lateRest(s)))) this.comeBack();
        return;
      }
      if (this.inStall || this.wcBusy) { this.wcTick(); return; }
      if (this.carry && this.anim !== 'coffee' && this.phase !== 'walk') this.carry = null;   // (the drink finished, or work)
      if (this.queued && this.want) leaveCoffee(this);
      const s = sessions.get(this.id);
      if (this.waitingForSubs && !this.sub) {
        let hasActive = false, hasReporting = false;
        for (const sw of subs.values()) if (sw.parent === this) { hasActive = true; break; }
        if (!hasActive) {
          for (const sw of npcs) if (sw.reportingToBoss && sw.parent === this) { hasReporting = true; break; }
          if (!hasReporting) for (const sw of leaving) if (sw.reportingToBoss && sw.parent === this) { hasReporting = true; break; }
        }
        const hasGuests = !hasActive && !hasReporting && deptWorkers.some((dw) => dw.briefGuestOf === this && dw.inBriefing);
        if (!hasActive && !hasReporting && !hasGuests && !this.inSubBrief) checkBossSubsDone(this);
      }
      if (!this.sub && !this.deptStaff && !this.staff && !this.callingPhone && !this.inSubBrief && !this.briefTimer) {
        if (!this.waitingForSubs && this.deferredWork?.length > 0 && !this.want) {
          const nextAct = popDeferredMainAction(this);
          if (nextAct) this.push(nextAct);
        }
        const phoneSpot = STATIONS.phone?.[0];
        const nearPhone = phoneSpot && Math.hypot(this.pos.x - phoneSpot.x, this.pos.y - phoneSpot.z) < 0.75;
        if (!this.want && (this.station === 'phone' || this.station === 'meeting' || nearPhone)) {
          if (s?.status !== 'wait') {
            this.hush();
            this.lastSay = null;
          }
          if (s?.status === 'rest' && !this.waitingForSubs) {
            this.goHomeAndRest();
          } else {
            const home = this.homeSpot();
            const d = s?.desk ?? -1;
            this.goTo(home, () => {
              this.station = 'desk';
              this.pose = home.sit ? 'sit' : 'stand';
              this.anim = 'type';
              if (s?.status !== 'wait') {
                this.hush();
                this.lastSay = null;
              }
              if (d >= 0 && d < DESK_SPOTS.length) deskKit[d] = this;
            });
          }
          return;
        }
      }
      if (this.anim === 'sleep' && !this.sub && !this.deptStaff && (this.want || (s && (s.status !== 'rest' || s.bg?.length)))) { this.anim = 'wake'; this.wakeUntil = state.sim + (reduceMotion ? 0.3 : 1.6); this.hush(); return; }
      if (this.anim === 'wake') { if (state.sim < this.wakeUntil) return; this.anim = s?.status === 'work' && !this.want ? ANIM_AT[this.station] || 'type' : 'idle'; }
      if (this.want && (this.want.priority || state.sim >= this.dwellUntil)) {
        const a = this.want; this.want = null;
        if (!a.spot && (!a.station || a.station === this.station)) { this.apply(a); return; }
        let spot = a.spot || (a.station === 'desk' ? this.homeSpot() : allocate(a.station, this, true));
        if (!spot) { if (a.anim === ANIM_AT[a.station]) a.anim = ANIM_AT.desk; a.station = 'desk'; spot = this.homeSpot(); }   // (that room is full: from their own desk)
        this.goTo(spot, () => { this.station = a.station || 'desk'; if ((this.sub || this.deptStaff) && this.station === 'desk' && this.subDesk >= 0) deskKit[this.subDesk] = this; this.apply(a); });
        a.go?.(this);   // (on the way: something in hand, say; life/post.js)
        return;
      }
      if (this.sub) {
        if (this.station !== 'meeting' && this.station !== 'desk' && state.sim > this.dwellUntil + 2.5) {
          this.goTo(this.homeSpot(), () => {
            this.station = 'meeting';
            this.anim = 'type';
            this.hush();
          });
        }
        return;
      }
      if (this.deptStaff && !this.busySub) {
        if (this.station !== 'desk') {
          this.goTo(this.homeSpot(), () => {
            this.station = 'desk';
            this.pose = 'sit';
            this.anim = 'idle';
            if (this.subDesk >= 0) deskKit[this.subDesk] = this;
            this.hush();
          });
          return;
        }
        this.pose = 'sit';
        if (state.sim > (this.deptNextAt || 0)) {
          this.deptNextAt = state.sim + rand(90, 180);
          this.anim = Math.random() < 0.5 ? 'idle' : 'type';
        }
        return;
      }
      if (!s) return;
      if (this.queued) return;
      if (this.onBreak) return;   // out of Claude (life/quota.js): on a break until the limit resets
      if (this.dailyLife(s) || this.nightOut(s)) return;
      if (this.anim === 'hand' && s.status !== 'wait' && this.station !== 'phone') { this.anim = ANIM_AT[this.station] || 'idle'; this.hush(); this.lastSay = null; }
      if (s.status === 'rest' && this.anim !== 'sleep' && state.sim > this.restAt) this.goHomeAndRest();
      if (s.status === 'rest' && this.restAt === Infinity && this.anim !== 'sleep' && this.anim !== 'coffee' && state.sim > this.dwellUntil + 20) this.goHomeAndRest();
    }
    // lunch and the afternoon coffee: from a nap, once a day each, at a slightly different minute for everyone
    dailyLife(s) {
      if (!PRO || s.status !== 'rest' || this.want || (!this.deptStaff && this.anim !== 'sleep') || this.phase === 'walk' || replay.on) return false;
      if (state.sim < (this.lifeAt || 0)) return false;
      this.lifeAt = state.sim + 4;
      const d = officeNow(), m = d.getHours() * 60 + d.getMinutes(), day = d.toDateString(), off = hash(this.id) % 18;
      const order = state.lunchOrder;   // the team's lunch on its way (outings.js): wait for it, up to 12:15
      if (m >= 690 + off && m < 780 && this.lunchDay !== day && !(order?.day === day && !order.here && m < 735)) {
        this.lunchDay = day; this.meal = true;
        const text = tr('people.lunch');
        this.want = { station: 'dining', anim: 'eat', type: 'idle', text, dwell: 3, rest: rand(900, 1500), after: () => showMeal(this) };
        setTimeout(() => { if (this.lastSay?.text === text) this.hush(); }, 7000);
        return true;
      }
      if (m >= 900 + off && m < 945 && this.coffeeDay !== day) { this.coffeeDay = day; return joinCoffee(this); }
      return false;
    }
    // clicked while napping: still under the blanket, a lazy wave and a sleepy line (what it finished, how long it has
    // been resting); a different line each click
    poke() {
      const s = sessions.get(this.id); if (!s) return;
      const done = state.streamer ? '' : short(s.lastPrompt || '', 34), ago = fmtAgo(Math.max(60, (nowMs() - (s.doneAt || s.lastAt || nowMs())) / 1000));
      const P = (key, vars) => tr(`people.poke.${key}`, vars);
      const lines = [
        done ? P('doneNamed', { done }) : P('done'),
        P('resting', { ago }),
        P('boss'),
        P('charging'),
        done ? P('wrappedNamed', { done }) : P('wrapped'),
      ];
      this.pokeN = ((this.pokeN ?? randInt(0, lines.length - 1)) + 1) % lines.length;
      this.say('idle', lines[this.pokeN], 'rest');
      this.waveUntil = state.sim + (reduceMotion ? 0 : 1.3); this.pokeHushAt = state.sim + 4.5;
      sfx.play('pop');
    }
    /* A small errand you set off (a lamp switched off, a page printed, a coffee made): say so, walk to the spot, do the
       thing there (job.at, which may return a line), walk back and carry on as before. Without a spot it happens where
       they are (lifting the cat off the keyboard). Their real work waits until they are back, a few seconds. Asked again
       on the way back, they turn round. */
    errand(job) {
      const b = this.chore?.b || { spot: this.spot, station: this.station, anim: this.anim, say: this.lastSay, shown: this.bubbleObj.visible };
      const e = this.chore = { ...job, b, said: new Set(), stage: 'go' };
      const line = (text) => { if (text) { e.said.add(text); this.say(job.type || 'idle', text); } };
      const look = () => { if (job.look && this.pose !== 'sit') this.faceTarget = faceTo(this.pos.x, this.pos.y, job.look[0], job.look[1]); };
      this.station = 'errand'; this.waveUntil = 0; this.pokeHushAt = 0;
      line(job.line); look();
      this.anim = 'idle';
      const there = () => {
        if (this.chore !== e) return;
        look(); this.anim = job.anim || 'tidy'; job.arrived?.(this);
        // (e.until: a gathering keeps everyone until it ends, and may move that time)
        const finish = () => {
          if (e.until && state.sim < e.until) { this.afterAt = e.until; this.after = finish; return; }
          e.stage = 'done'; line(job.at?.(this)); this.anim = job.anim2 || 'idle'; this.afterAt = state.sim + (reduceMotion ? 0.3 : job.linger ?? 0.9); this.after = () => this.errandBack();
        };
        this.afterAt = state.sim + (reduceMotion ? 0.3 : job.hold ?? 0.8); this.after = finish;
      };
      this.afterAt = state.sim + (reduceMotion ? 0.2 : job.wait ?? 1.0);
      this.after = () => (job.spot ? this.goTo(job.spot, there) : there());
      return e;
    }
    errandBack() {
      const e = this.chore; if (!e) return;
      const b = e.b, done = () => {
        if (this.chore !== e) return;
        this.chore = null; this.station = b.station;
        const s = sessions.get(this.id);
        this.anim = s?.status === 'wait' ? 'hand' : b.anim === 'hand' ? ANIM_AT[b.station] || 'idle' : b.anim === 'sleep' || b.anim === 'wake' ? 'idle' : b.anim;
        if (e.said.has(this.lastSay?.text)) {
          if (b.say && b.shown && b.say.kind === 'wait') this.say(b.say.type, b.say.text, b.say.kind);
          else { this.hush(); this.lastSay = null; }
        }
        e.done?.(this);
      };
      e.stage = 'back';
      if (!e.spot) { done(); return; }
      // their seat, unless someone sat down in it meanwhile
      const home = b.spot && b.spot.by && b.spot.by !== this ? (b.station === 'desk' ? this.homeSpot() : allocate(b.station, this, true) || this.homeSpot()) : b.spot || this.homeSpot();
      this.goTo(home, done);
    }
    /* First person, E next to someone asleep: they stir, stretch, sit up to see who it is, say something, and doze off
       again. Woken again within two minutes they get crosser; the fourth time they just pretend not to hear. */
    rouse() {
      const s = sessions.get(this.id);
      if (!s || this.sub || this.anim !== 'sleep' || this.phase === 'walk' || this.chore || this.after) return false;
      this.rousedN = state.sim - (this.rousedAt ?? -1e9) < 120 ? (this.rousedN || 0) + 1 : 1; this.rousedAt = state.sim;
      const R = (key, vars) => tr(`people.rouse.${key}`, vars);
      sfx.play('pop');
      if (this.rousedN >= 4) { this.say('idle', R('ignore'), 'rest'); this.pokeHushAt = state.sim + 3.5; return true; }
      const done = state.streamer ? '' : short(s.lastPrompt || '', 34), ago = fmtAgo(Math.max(60, (nowMs() - (s.doneAt || s.lastAt || nowMs())) / 1000));
      const first = [R('hi'), done ? tr('people.poke.doneNamed', { done }) : tr('people.poke.done'), tr('people.poke.resting', { ago }), tr('people.poke.boss'), tr('people.poke.charging')];
      const text = this.rousedN === 1 ? first[randInt(0, first.length - 1)] : R(this.rousedN === 2 ? 'again' : 'last');
      this.errand({ type: 'idle', anim: 'wake', wait: 0, hold: 1.6, anim2: 'idle', linger: 3.2, line: R('stir'),
        at: () => { this.waveUntil = state.sim + 1.3; return text; },
        done: () => {
          if (s.status !== 'rest' || this.want || s.bg?.length) return;   // work came in meanwhile: they are up for it
          this.anim = 'sleep'; this.restAt = Infinity; this.say('idle', R('back'), 'rest'); this.pokeHushAt = state.sim + 2.6;
        } });
      return true;
    }
    // pro plan: now and then, before the nap, a trip to the restroom (into a free stall, door shut, then wash hands)
    visitWc() {
      const stall = STATIONS.wc.find((x) => !x.by); if (!stall) return false;
      this.wcAt = state.sim; this.wcBusy = true; this.hush(); this.restAt = Infinity; this.station = 'wc';
      this.goTo(stall, () => { this.anim = 'idle'; this.inStall = stall; this.wcUntil = state.sim + rand(4, 7); });
      return true;
    }
    wcTick() {
      if (this.inStall) {
        if (state.sim < this.wcUntil && !this.want?.priority) return;
        this.inStall = null; this.anim = 'idle';
        this.goTo(allocate('sink', this), () => { this.anim = 'tidy'; this.station = 'sink'; this.sinkUntil = state.sim + 1.8; });
        return;
      }
      if (this.station === 'sink' && state.sim < this.sinkUntil && !this.want?.priority) return;
      this.wcBusy = false; this.station = 'wc-done';
      if (!this.want) this.goHomeAndRest();
    }
    goHomeAndRest() {
      if (PRO && !this.sub && !this.want && state.sim - (this.wcAt ?? -1e9) > 900 && Math.random() < 0.4 && this.visitWc()) return;
      if (this.lastSay?.kind !== 'wait') { this.hush(); this.lastSay = null; }
      const nap = () => {
        this.station = 'desk'; this.restAt = Infinity;
        const bg = sessions.get(this.id)?.bg;
        if (bg?.length) { this.anim = 'think'; this.say('bash', tr('people.bgWait', { desc: bg[0].desc })); return; }
        this.anim = 'sleep'; this.hush(); this.lastSay = null;
      };
      if (this.station === 'desk') nap(); else this.goTo(this.homeSpot(), nap);
    }
    leave(onGone) {
      if (this.leaving) return;
      this.leaving = true; this.hush(); this.want = null; this.after = null; this.chore = null;
      const gone = () => { this.remove(); onGone && onGone(); };
      if (this.outing) this.outing.drop(this);
      if (this.liftHold || this.away || this.street || this.offstage) { this.liftHold = false; gone(); return; }   // still in the lift that brought them, gone home, or out (they don't come back)
      this.walkOut(gone);
    }
    // packing up at the desk (coat on, bag on the back), then out: the lift (press the button, wait, step in, ride
    // down) or the door
    walkOut(gone) {
      const down = () => streetHooks.home?.(this, gone) || gone();   // (and with the city outside, out into the street)
      const out = () => viaClock('out', this, () => this.goTo(DOOR_IN, () => {
        if (!lift) { this.goTo(DOOR_OUT, down); return; }
        this.anim = 'idle'; this.faceTarget = DOOR_IN.face;   // press the button, wait for the car
        this.liftWait = () => this.goTo(DOOR_OUT, () => { this.faceTarget = Math.PI / 2; this.liftRide = down; });
      }));
      const d = this.sub ? -1 : (deskKit.indexOf(this) >= 0 ? deskKit.indexOf(this) : (sessions.get(this.id)?.desk ?? -1));
      if (d < 0 || d >= DESK_SPOTS.length || this.sub) { if (d >= 0 && deskKit[d] === this) deskKit[d] = null; out(); return; }
      const pack = () => {   // back at the desk: coat on, bag on the back
        this.pose = 'stand'; this.anim = 'tidy'; this.say('end', tr('people.goingHome'), 'rest');
        this.afterAt = state.sim + (reduceMotion ? 0.2 : 1.1);
        this.after = () => { if (d >= 0 && deskKit[d] === this) deskKit[d] = null; this.dress(true); this.anim = 'idle'; this.hush(); out(); };
      };
      const spot = DESK_SPOTS[d];
      if (Math.hypot(this.pos.x - spot.x, this.pos.y - spot.z) < 0.15 && this.phase !== 'walk') pack(); else this.goTo(spot, pack);
    }
    /* Inactive for >= 8 hours: put on backpack/coat and go home by the lift. Back as soon as a task is assigned. */
    lateRest(s) {
      if (this.sub || this.deptStaff || !s || s.status !== 'rest' || s.bg?.length || replay.on) return false;
      const last = Math.max(s.doneAt || 0, s.lastAt || 0);
      return last > 0 && nowMs() - last >= 8 * 3600e3;
    }
    nightOut(s) {
      if (this.want || this.chore || !this.lateRest(s)) return false;
      this.goHomeNow();
      return true;
    }
    goHomeNow() {
      this.homeBound = true; this.hush(); this.restAt = Infinity; this.station = 'out';
      this.walkOut(() => { this.homeBound = false; this.away = true; this.station = 'away'; this.hush(); if (this.spot?.by === this) this.spot.by = null; awayHooks.change?.(this); });
    }
    comeBack() {
      this.away = false; this.station = 'arriving';
      awayHooks.change?.(this);
      if (streetHooks.arrive?.(this)) return;   // (by the street, with the city outside)
      this.pos.set(DOOR_OUT.x, DOOR_OUT.z); this.face = this.faceTarget = Math.PI / 2; this.spot = DOOR_OUT;
      this.dress(true); liftArrive(this);
      const home = this.homeSpot(), d = sessions.get(this.id)?.desk ?? -1;
      viaClock('in', this, () => this.goTo(home, () => { this.station = 'desk'; this.anim = 'type'; if (home === DESK_SPOTS[d]) this.unpack(d); else this.dress(false); }));
    }
    remove() {
      if (this.phoneWalkTimer) { clearTimeout(this.phoneWalkTimer); this.phoneWalkTimer = null; }
      if (this.phoneTimer) { clearTimeout(this.phoneTimer); this.phoneTimer = null; }
      if (this.briefTimer) { clearTimeout(this.briefTimer); this.briefTimer = null; }
      if (this.briefWalkTimer) { clearTimeout(this.briefWalkTimer); this.briefWalkTimer = null; }
      if (this.briefEndTimer) { clearTimeout(this.briefEndTimer); this.briefEndTimer = null; }
      { const k = deskKit.indexOf(this); if (k >= 0) deskKit[k] = null; }
      if (this.subDesk >= 0) {
        if (deskKit[this.subDesk] === this) deskKit[this.subDesk] = null;
        if (chairs[this.subDesk]) chairs[this.subDesk].color.set(CHAIR_IDLE);
        this.subDesk = -1;
      }
      this.liftHold = false; this.liftWait = this.liftRide = null;
      if (this.queued) leaveCoffee(this);
      if (this.mealBox) hideMeal(this);
      if (this.spot && this.spot.by === this) this.spot.by = null;
      scene.remove(this.root);
      this.tagEl?.remove();
      this.bubbleEl?.remove();
      this.root.traverse((o) => { if (o.element) o.element.remove(); });
      disposeChibi(this.root);
    }
    update(dt, t) {
      if (this.after && state.sim >= this.afterAt) { const f = this.after; this.after = null; f(); }
      if (this.pokeHushAt && state.sim > this.pokeHushAt) { this.pokeHushAt = 0; if (this.lastSay?.kind === 'rest') this.hush(); }
      if (this.sayHushAt && state.sim > this.sayHushAt) { this.sayHushAt = 0; if (this.lastSay?.kind !== 'wait') { this.hush(); this.lastSay = null; } }
      this.held = false;
      const pace = (this._pace = calcPace(this));
      if (this.phase === 'walk' && !this.liftHold) {
        if (this.sub && this.dressed && !this.leaving && this.pos.x > -6.0) this.dress(false);
        const tgt = this.path[0];
        const dx = tgt.x - this.pos.x, dz = tgt.y - this.pos.y, d = Math.hypot(dx, dz), step = 1.85 * pace * dt;
        // out on the street (outings.js): a crossing waits at the kerb for the green man, and is walked at road level
        if (tgt.gate) { if (tgt.gate()) tgt.gate = null; else this.held = true; }
        if (tgt.y0 != null && !this.held) this.ground = tgt.y0;
        if (this.held) this.faceTarget = Math.atan2(dx, dz);
        else if (d <= step) {
          this.pos.copy(tgt); this.path.shift();
          if (!this.path.length) {
            this.phase = 'idle';
            if (this.spot) { this.faceTarget = this.spot.face; this.pose = this.spot.sit ? 'sit' : 'stand'; }
            const cb = this.onArrive; this.onArrive = null; cb && cb();
          }
        } else { this.pos.x += (dx / d) * step; this.pos.y += (dz / d) * step; this.faceTarget = Math.atan2(dx, dz); }
      }
      if (!this.chore) this.tick();
      if (isChibiHiddenBySetting(this)) {
        if (this.root.visible) {
          this.root.visible = false;
          this.root.matrixWorldAutoUpdate = false;
        }
        if (this.tagObj.visible) this.tagObj.visible = false;
        if (this.bubbleObj.visible) this.bubbleObj.visible = false;
        return;
      }
      if (this.deptStaff && !this.busySub && !this.inBriefing && !this.reportingToBoss && this.phase !== 'walk' && this.station === 'desk') {
        this._idleAnimAcc = (this._idleAnimAcc || 0) + dt;
        if (this._idleAnimAcc < 0.25 && this._poseInit) return;
        const stepDt = this._poseInit ? this._idleAnimAcc : Math.max(this._idleAnimAcc, 1);
        this._idleAnimAcc = 0;
        this._poseInit = true;
        this.animate(stepDt, t);
        return;
      }
      this.animate(dt, t);
    }
    animate(dt, t) {
      const walking = this.phase === 'walk' && !this.held, stomping = this.anim === 'stomp' && !walking, sit = this.pose === 'sit' && !walking && !stomping;
      const pace = this._pace || 1;
      const animDt = pace <= 1.05 ? dt : dt * Math.min(1.6, 1 + (pace - 1) * 0.65);
      if (walking) this.walkPh = (this.walkPh ?? (t + this.seed)) + animDt;
      else this.walkPh = null;
      this.stompShift = (this.stompShift || 0) + ((stomping && this.station === 'desk' ? 0.36 : 0) - (this.stompShift || 0)) * Math.min(1, dt * 6);
      const idleish = !walking && !BUSY_ANIMS.has(this.anim);
      this.lookT = (this.lookT ?? 0) - dt;
      if (this.lookT < 0) { this.lookT = rand(1.8, 4.5); this.lookY = rand(-0.55, 0.55); }
      this.blinkAt -= dt; if (this.blinkAt < 0) this.blinkAt = rand(2.5, 5);
      const napping = this.anim === 'sleep' && !walking;
      if (napping && (this.zT -= dt) < 0) { this.zT = 1.4; puffZ(this); }
      const pose = chibiPose(this.P, walking ? 'walk' : this.anim, walking ? this.walkPh : t + this.seed,
        { sit, scale: this.scale, look: idleish ? this.lookY : 0, wave: !walking && this.waveUntil > t, blink: this.blinkAt < 0.12, carry: this.carry, doze: this.doze });
      const y = applyChibiPose(this.P, pose, walking ? animDt : dt) * this.scale;
      this.root.position.set(this.pos.x + this.stompShift, y + this.gy(), this.pos.y);
      const hid = (!!this.inStall && !walking) || !!this.away || !!this.offstage || isChibiHiddenBySetting(this);   // behind a shut stall door, gone home, inside a shop or the lift
      if (this.root.visible === hid) {
        this.root.visible = !hid;
        this.root.matrixWorldAutoUpdate = !hid;
        if (hid) {
          this.tagObj.visible = false;
          this.bubbleObj.visible = false;
        } else if (this.sub || this.isSub) {
          this.tagObj.visible = state.showSubNames !== false;
        } else if (this.deptStaff || this.isDeptAmbient || this.staff) {
          this.tagObj.visible = state.showStaffNames !== false;
        } else {
          this.tagObj.visible = state.showChibiNames !== false;
        }
      }   // (out of sight: no matrices to keep up)
      const dRig = this.P?.D;
      const headTop = dRig ? dRig.hipY + dRig.headY + dRig.R : 1.86;
      const invScale = 1 / (this.scale || 1);
      const rootLift = sit ? Math.max(0, pose.y || 0) : 0;
      const lblY = napping
        ? (headTop - rootLift) + 0.02 * invScale
        : sit
          ? (headTop - rootLift) + (this.id === '__director' ? 0.04 : 0.08) * invScale
          : headTop + 0.36 * invScale;
      this.tagObj.position.y = lblY;
      this.bubbleObj.position.y = this.tagObj.visible ? lblY : lblY - 0.16 * invScale;
      this.face += wrapAngle(this.faceTarget - this.face) * Math.min(1, animDt * 10);
      this.root.rotation.y = this.face; this.root.rotation.z = pose.tilt;
    }
  };
  if (HQ) {
    deptWorkers.length = 0;
  }
}
