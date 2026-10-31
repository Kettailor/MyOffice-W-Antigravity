// The company group chat, on the page (the window: group-chat-view.js; the people and what they say:
// src/shared/chat-engine.js). In the office the conversation lives on the server, the same for the Mac and a phone:
// this page shows what the server sends ({ k: 'chat' }), sends what you do (POST /api/chat), and, on the Mac, tells it
// the office's life as it happens here (a parcel, the Friday tea with a photo of the table, a birthday…). The online
// demo has no server: the same engine runs in the page, kept in this browser.
//
// chatSay(from, text, opts): from = a session id (one of the people), or a staff key ('reception', 'hr', 'cleaner',
// 'guard', 'director', 'courier', 'accountant'); text = the line, already in the office's language. opts: delay,
// sticker (index), photo (data URL), react (emojis others may add), reacts (how many), answer ([{ key, chance }]: lines
// under chat.reply that someone answers with), pin, key (two pages telling the same moment make one message).
import * as THREE from 'three';
import { state } from '../core/state.js';
import { STATIC, officeNow, replay } from '../core/env.js';
import { dn, npcs, sessions, workers } from '../people/workers.js';
import { sfx } from '../audio/sfx.js';
import { DEMO } from '../demo/demo.js';
import { ringBell } from '../people/gatherings.js';
import { teatime } from '../people/teatime.js';
import { camera, composer, controls, renderer, scene, SOFTWARE_GL } from '../scene/renderer.js';
import { lite } from './lite.js';
import { TOKEN } from '../net/live.js';
import { createChatEngine, CHAT_RETENTION_MS, REACTIONS } from '../../shared/chat-engine.js';
import { t as tr } from '../../i18n/index.js';

export { REACTIONS };
export const chat = { msgs: [], pinned: null, unread: 0, open: false, typing: [] };
const views = new Set();
/** The window listens: (what, m) with what = 'add' | 'update' | 'typing' | 'all' | 'badge'. */
export const onChat = (fn) => views.add(fn);
const emit = (what, m) => { for (const fn of views) fn(what, m); };
export const byId = (id) => chat.msgs.find((m) => m.id === id);
export const myViewerId = () => (state.isLocal ? 'director' : (state.viewer?.id || (state.viewer?.isDirectorDevice ? 'director' : '')));

export function canSeeSession(s) {
  if (!s || s.masked === true) return false;
  if (state.isLocal || state.viewer?.isDirectorDevice || state.viewer?.role === 'Phó Giám đốc') return true;
  const dir = String(s.dir || s.cwd || '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  if (!dir) return true;
  const allowed = Array.isArray(state.viewer?.allowedWorkspaces) ? state.viewer.allowedWorkspaces : null;
  if (!allowed || allowed.includes('*')) return true;
  for (const w of allowed) {
    const nw = String(w || '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
    if (!nw) continue;
    if (dir === nw || dir.startsWith(nw + '\\') || (dir.length > 3 && nw.startsWith(dir + '\\'))) return true;
  }
  return false;
}

export function isMsgVisible(m) {
  if (!m) return false;
  if (m.role === 'boss' || m.from === 'me' || m.humanOnly) return true;
  const s = (m.from && sessions.get(m.from)) || (m.perm?.sess && sessions.get(m.perm.sess));
  if (s && s.masked === true) return false;
  if (s && !canSeeSession(s)) return false;
  return true;
}

export function isHumanSelf(m) {
  if (!m) return false;
  if (m.role !== 'boss' && m.from !== 'me') return false;
  const myId = myViewerId();
  if (!m.whoId) return !!state.isLocal;
  if (m.whoId !== myId) return false;
  if (m.whoName && !state.isLocal && state.viewer?.name && m.whoName !== state.viewer.name) return false;
  return true;
}

export function isMentioningMe(m) {
  if (!m || isHumanSelf(m)) return false;
  const myId = myViewerId();
  const isDirectorOrDeputy = state.isLocal || !!state.viewer?.isDirectorDevice || state.viewer?.role === 'Phó Giám đốc' || myId === 'director';
  if (Array.isArray(m.mentions)) {
    if (myId && m.mentions.includes(myId)) return true;
    if (isDirectorOrDeputy && m.mentions.includes('director')) return true;
  }
  const txt = String(m.text || '');
  if (!txt) return false;
  const low = txt.toLowerCase();
  if (isDirectorOrDeputy && (low.includes('@giám đốc') || low.includes('@phó giám đốc') || low.includes('@sếp'))) return true;
  if (state.viewer?.name && low.includes(`@${state.viewer.name.toLowerCase()}`)) return true;
  if (state.viewer?.role && low.includes(`@${state.viewer.role.toLowerCase()}`)) return true;
  return false;
}

export function shouldNotifyForMsg(m) {
  if (!m || m.kind === 'sys' || !isMsgVisible(m)) return false;
  if (isHumanSelf(m)) return false;
  const mode = state.chatNotify || 'all';
  if (mode === 'off') return false;
  if (mode === 'mention') return isMentioningMe(m);
  if (m.role === 'boss' || m.from === 'me') return true;
  const myId = myViewerId();
  const ownerId = m.ownerId || sessions.get(m.from)?.ownerId || null;
  return isMentioningMe(m) || !ownerId || ownerId === myId;
}

export function syncChatNotifyMode() {
  const mode = state.chatNotify || 'all';
  if (mode === 'off') {
    chat.unread = 0;
  } else if (mode === 'mention' && chat.unread > 0) {
    const recent = chat.msgs.slice(-chat.unread);
    chat.unread = recent.filter((m) => shouldNotifyForMsg(m)).length;
  }
  emit('badge');
}

/* ---------- who is in the group (for faces, @ and the member list) ---------- */
const STAFF = { reception: '__reception', hr: '__hr', cleaner: '__cleaner', guard: '__guard', director: '__director', courier: '__courier', accountant: '__accountant' };
const lookOf = (cfg) => cfg && { shirt: cfg.shirt, hair: cfg.hair, style: cfg.style, acc: cfg.acc ?? null, outfit: cfg.outfit, skin: cfg.skin };
/** { key, name, look } for a sender as the office knows them now (the face comes from their chibi), or null. */
export function who(from) {
  if (from === 'me') return { key: 'me', name: tr('chat.boss'), look: null };
  const key = STAFF[from] || from;
  if (key?.startsWith('__')) { const n = npcs.find((x) => x.id === key); return n ? { key, name: n.cfg.name, look: lookOf(n.cfg), staff: true } : null; }
  const s = sessions.get(key); if (!s) return null;
  return { key, name: dn(s), look: lookOf(workers.get(key)?.cfg) };
}
/** The sessions' people in the office now (not out on the street), optionally only those resting. */
export function people(resting = false) {
  return [...sessions.values()].filter((s) => !s.masked && workers.has(s.id) && !workers.get(s.id).offstage && (!resting || s.status === 'rest')).map((s) => s.id);
}

/* ---------- the conversation: the server's, or (the demo) this browser's own engine ---------- */
const KEY = 'office-chat-demo';
let engine = null;
function applyAdd(m) {
  if (!m || chat.msgs.some((x) => x.id === m.id)) return;
  if ((m.ts || m.at) && Date.now() - (m.ts || m.at) > CHAT_RETENTION_MS) return;
  chat.msgs.push(m); if (chat.msgs.length > 330) chat.msgs.splice(0, chat.msgs.length - 300);

  if (state.chatNotify === 'off') {
    chat.unread = 0;
  } else {
    const notify = shouldNotifyForMsg(m);
    if (notify) {
      if (!chat.open) chat.unread++;
      const mentionedMe = isMentioningMe(m);
      if (m.kind === 'perm') {
        sfx?.play('perm');
      } else if (mentionedMe) {
        sfx?.play('chime');
        sfx?.play('chatIn');
      } else if (!chat.open || m.tag === 'claude') {
        sfx?.play('chatIn');
        sfx?.play('chat');
      }
    }
  }
  emit('add', m);
}
function applyUpdate(m) { const i = chat.msgs.findIndex((x) => x.id === m.id); if (i >= 0) { chat.msgs[i] = m; emit('update', m); } }
/** A message from the server's live stream (demo.js): { op, m | add | typing, pinned }. */
export function chatApply(d) {
  if (d.pinned !== undefined) chat.pinned = d.pinned;
  if (Array.isArray(d.add)) { for (const m of d.add) applyAdd(m); }
  else if (d.op === 'add') applyAdd(d.m);
  else if (d.op === 'update') applyUpdate(d.m);
  else if (d.op === 'typing') { chat.typing = d.typing || []; emit('typing'); }
  else if (d.op === 'all') emit('all');
}
/** The whole conversation again (on connecting, and after the live stream came back). */
export async function chatLoad() {
  if (DEMO) return;
  const r = await fetch(`/api/chat${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ''}`).then((x) => x.json()).catch(() => null);
  if (!r?.ok) return;
  const now = Date.now();
  chat.msgs = (r.msgs || []).filter((m) => !m || (now - (m.ts || m.at || now)) <= CHAT_RETENTION_MS);
  chat.pinned = r.pinned || null; chat.typing = r.typing || [];
  emit('all');
}
const post = (body) => fetch(`/api/chat${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
// what you do: to the server (or the demo's engine)
export function chatSend(text, opts = {}) {
  const whoName = opts.whoName || (state.isLocal ? 'Giám đốc' : (state.viewer?.name || tr('chat.boss')));
  const whoRole = opts.whoRole || (state.isLocal ? 'Giám đốc' : (state.viewer?.role || 'Trợ lý Giám đốc'));
  const whoId = opts.whoId || myViewerId();
  const mentions = Array.isArray(opts.mentions) ? opts.mentions : [];
  const humanOnly = opts.humanOnly != null ? !!opts.humanOnly : mentions.length > 0;
  const images = Array.isArray(opts.images) && opts.images.length ? opts.images : undefined;
  const photo = opts.photo || undefined;
  const payload = {
    text,
    sticker: opts.sticker ?? null,
    replyTo: opts.replyTo || null,
    whoName,
    whoRole,
    whoId,
    mentions,
    humanOnly,
    ...(images && { images }),
    ...(photo && { photo }),
  };
  if (engine) engine.send(payload);
  else post({ op: 'send', ...payload });
}
export function react(m, emoji) { if (engine) engine.react(m.id, 'me', emoji); else post({ op: 'react', id: m.id, emoji }); }
export function vote(m, i) { if (engine) engine.vote(m.id, 'me', i); else post({ op: 'vote', id: m.id, i }); }
export function rsvp(m, yes) { if (engine) engine.rsvp(m.id, 'me', yes); else post({ op: 'rsvp', id: m.id, yes }); }
export function recall(m) { if (engine) engine.recall(m.id); else post({ op: 'recall', id: m.id }); }
export function chatPin(id) { if (engine) engine.pin(id, tr('chat.boss')); else post({ op: 'pin', id }); }
export function chatPoll(q, options) { if (engine) engine.poll('me', q, options); else post({ op: 'poll', q, opts: options }); }
export function chatSendPhoto() {
  const data = chatPhoto(null);
  if (!data) return;
  chatSendPhotoData(data);
}
export function chatSendPhotoData(data, opts = {}) {
  if (!data) return;
  const whoName = opts.whoName || (state.isLocal ? 'Giám đốc' : (state.viewer?.name || tr('chat.boss')));
  const whoRole = opts.whoRole || (state.isLocal ? 'Giám đốc' : (state.viewer?.role || 'Trợ lý Giám đốc'));
  const whoId = opts.whoId || myViewerId();
  const meta = { whoName, whoRole, whoId, ownerId: whoId };
  if (engine) engine.photo(data, meta);
  else post({ op: 'photo', data, ...meta });
}
export function setOpen(on) { chat.open = on; if (on && chat.unread) { chat.unread = 0; emit('all'); } }

/** Someone in the office says something (the office's life, from the module where it happens; on the Mac only). */
export function chatSay(from, text, opts = {}) {
  if (replay.on || (!text && opts.sticker == null && !opts.photo)) return;
  if (engine) { engine.say(from, text, opts); return; }
  if (!state.isLocal) return;   // (a phone shows the conversation; the Mac's page tells the office's life)
  const p = who(from); if (!p) return;
  post({ op: 'say', from: p.key, text, key: opts.key, sticker: opts.sticker, photo: opts.photo || undefined, pin: !!opts.pin, delay: opts.delay, react: opts.react, reacts: opts.reacts, answer: opts.answer });
}
// the work events: the server writes those itself (life/incidents.js calls this; only the demo needs it)
export function chatEvent(e) { if (engine && !replay.on && !e.quiet) engine.onEvent({ ...e, limit: String(e.text || e.label || '').startsWith(tr('server.event.limitHit')) }); }
export function chatLeft(s) { if (engine && s && !replay.on) engine.onLeft(dn(s)); }
export function chatMoved(names, to) { if (!engine) return; for (const s of sessions.values()) if (names.includes(dn(s))) engine.onMoved(s.id, to); }

/* ---------- life in the office (called from the modules where it happens) ---------- */
const life = (key, vars) => tr(`chat.life.${key}`, vars);
const lastLife = new Map();
/** kind: standup, lunchOrder, nap, wake, parcel, tea, birthday, store, altar, trophy, bye (v: id, name, shop, names,
 *  photo, every). The morning hello, the lunch poll and the reminders come by the clock, from the engine. */
export function chatLife(kind, v = {}) {
  const every = v.every ?? 20 * 60e3, now = Date.now(), lk = `${kind}:${v.id || ''}`;
  if (replay.on || (lastLife.get(lk) || 0) > now) return;
  lastLife.set(lk, now + every);
  const key = `life:${lk}:${Math.floor(now / every)}`;   // (two pages telling the same moment: one message)
  const name = v.name || (v.id ? who(v.id)?.name : '') || '';
  const restingOne = () => { const r = people(true); return r.length ? r[Math.floor(Math.random() * r.length)] : 'reception'; };
  switch (kind) {
    case 'standup': chatSay('hr', life('standup'), { key, pin: true, react: ['👍'], reacts: 3, answer: [{ key: 'meeting', chance: 0.7 }] }); break;
    case 'lunchOrder': chatSay('reception', life('lunchOrder', { name }), { key }); if (v.id) chatSay(v.id, tr('chat.reply.parcelGot'), { key: `${key}:got`, delay: 4000 }); break;
    case 'nap': chatSay(restingOne(), life('nap'), { key, react: ['😆', '❤️'], reacts: 2 }); break;
    case 'wake': chatSay(restingOne(), life('wake'), { key, react: ['😭', '😆'], reacts: 2 }); break;
    case 'parcel': chatSay('reception', life('parcel', { name }), { key }); if (v.id) chatSay(v.id, tr('chat.reply.parcelGot'), { key: `${key}:got`, delay: 4500 }); break;
    case 'tea': chatSay(v.id || restingOne(), life('tea'), { key, photo: v.photo || null, react: ['❤️', '😆', '😮'], reacts: 4, answer: [{ key: 'milkTea', chance: 0.6 }] }); break;
    case 'birthday': chatSay('hr', life('birthday', { names: v.names }), { key, react: ['❤️', '😆'], reacts: 5, answer: [{ key: 'hpbd' }, { key: 'hpbd', chance: 0.8 }, { key: 'hpbd', chance: 0.5 }] }); break;
    case 'store': if (v.id) chatSay(v.id, life('store', { shop: v.shop }), { key, answer: [{ key: 'storeAsk', chance: 0.7 }] }); break;
    case 'mixue': if (v.id) chatSay(v.id, life(v.why === 'treat' ? 'mixueTreat' : 'mixueHot', { temp: v.temp }), { key, react: ['❤️', '😆'], reacts: 3, answer: [{ key: 'mixueAsk', chance: 0.9 }, { key: 'mixueAsk', chance: 0.5 }] }); break;
    case 'altar': chatSay('reception', life('altar'), { key, react: ['❤️'], reacts: 3 }); break;
    case 'trophy': chatSay('hr', life('trophy', { name: v.name }), { key, react: ['❤️', '😮'], reacts: 5, answer: [{ key: 'deploy', chance: 0.7 }] }); break;
    case 'bye': if (v.id) chatSay(v.id, tr('chat.work.bye'), { key, answer: [{ key: 'bye', chance: 0.6 }] }); break;
  }
}

/** A photo for the chat, as someone would take it with a phone: the office framed on a thing (its world position), a
 * little closer than you see it, or (no thing) the view as it is; drawn now (the same task as the render, so the picture
 * is still there), 480 px wide. */
export function chatPhoto(obj) {
  if (lite || !controls) return null;
  const keep = { pos: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
  try {
    if (obj) {
      const at = obj.getWorldPosition(new THREE.Vector3()), off = camera.position.clone().sub(controls.target);
      controls.target.copy(at); camera.position.copy(at).add(off); camera.zoom = keep.zoom * 2.4; camera.updateProjectionMatrix(); camera.lookAt(at);
    }
    if (SOFTWARE_GL) renderer.render(scene, camera); else composer.render();
    const src = renderer.domElement, w = 480, h = Math.round((w * 3) / 4), c = document.createElement('canvas'); c.width = w; c.height = h;
    const sw = Math.min(src.width, (src.height * 4) / 3), sh = (sw * 3) / 4;   // the middle of the view, 4:3
    c.getContext('2d').drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.8);
  } catch { return null; } finally {
    camera.position.copy(keep.pos); controls.target.copy(keep.target); camera.zoom = keep.zoom; camera.updateProjectionMatrix(); camera.lookAt(controls.target);
  }
}
/** What the chat asks the office to do (someone wrote "họp" or "trà sữa"): every page runs its own office. */
export function chatAct(what) { if (what === 'meeting') ringBell(); else if (what === 'tea') teatime(true); }

export function setup() {
  if (STATIC || new URLSearchParams(location.search).has('demo')) {   // the demo (demo.js sets DEMO later in the setups): the engine runs here, kept in this browser
    engine = createChatEngine({
      tr, now: () => officeNow().getTime(),
      members: () => people().map((id) => { const s = sessions.get(id); return { id, name: dn(s), status: s.status, task: s.lastPrompt || '', last: s.last, project: (s.dir || '').split('/').pop(), ownerId: s.ownerId || 'director', ownerName: s.ownerName || 'Giám đốc' }; }),
      staffName: (key) => npcs.find((x) => x.id === key)?.cfg.name || null,
      store: { load: () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }, save: (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* full or blocked */ } } },
      emit: (op, x) => { chat.pinned = engine?.state.pinned ?? chat.pinned; if (op === 'add') applyAdd(x); else if (op === 'update') applyUpdate(x); else if (op === 'typing') { chat.typing = x; emit('typing'); } else emit('all'); },
      act: chatAct,
    });
    chat.msgs = engine.state.msgs.slice(); chat.pinned = engine.state.pinned;   // (a list of its own: the engine's grows by itself)
    setInterval(() => engine.clock(), 30e3);
  } else chatLoad();
  // the tests' hooks (?debug): the chat's state, and a way to make things happen in it
  if (new URLSearchParams(location.search).has('debug')) setTimeout(function hook() { if (!window.__office) { setTimeout(hook, 200); return; } Object.assign(window.__office, { chat, chatSay, chatLife, chatEvent, chatEngine: () => engine }); }, 0);
}
