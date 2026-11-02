// "Giao việc": giving Claude work from the group chat (server/tasks.mjs runs it on the Mac). A sheet over the chat: who
// it goes to (a conversation, carried on with its whole context as a branch of it, or a new conversation in a folder
// sessions have worked in), what to do (typed, or spoken: 🎤 in the office's language), photos (from the camera or the
// gallery, made smaller here before they go). From a phone only once the Mac allows it (the phone window).
import { el } from '../core/env.js';
import { icon } from './icons.js';
import { toast } from './activity.js';
import { avatar } from './chat-avatars.js';
import { who } from './group-chat.js';
import { sessions } from '../people/workers.js';
import { TOKEN } from '../net/live.js';
import { deleteSession, renameSession } from './session-drawer.js';
import { sfx } from '../audio/sfx.js';
import { t as tr, locale } from '../../i18n/index.js';

const q = () => (TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : '');
export const MAX_TASK_IMAGES = 20;
const PIN_KEY = 'office-pinned-tasks';
const MODEL_KEY = 'office-task-model';
const SESS_MODELS_KEY = 'office-session-models';
const DRAFTS_KEY = 'office-task-drafts-v1';
const LAST_PICK_KEY = 'office-task-last-pick';
const IDB_NAME = 'office-task-drafts-db';
const IDB_STORE = 'drafts';
let sheet = null;
let activeSheetCleanup = null;
const memoryDrafts = new Map();
let lastPick = null;

function loadLocalStorageDrafts() {
  try {
    if (!lastPick) {
      const rawPick = JSON.parse(localStorage.getItem(LAST_PICK_KEY) || 'null');
      if (rawPick && (rawPick.sid || rawPick.dir)) lastPick = rawPick;
    }
  } catch { /* storage blocked */ }
  try {
    const raw = JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}');
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (!k || !v || typeof v !== 'object') continue;
        const existing = memoryDrafts.get(k);
        if (!existing) {
          memoryDrafts.set(k, {
            text: String(v.text || ''),
            photos: Array.isArray(v.photos) ? v.photos.slice(0, MAX_TASK_IMAGES) : [],
          });
        }
      }
    }
  } catch { /* storage blocked */ }
}

function saveLocalStorageDrafts() {
  const all = {};
  for (const [k, v] of memoryDrafts.entries()) {
    if (!k || (!v?.text && !v?.photos?.length)) continue;
    all[k] = {
      text: String(v.text || ''),
      photos: Array.isArray(v.photos) ? v.photos.slice(0, MAX_TASK_IMAGES) : [],
    };
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
  } catch {
    const textOnly = {};
    for (const [k, v] of Object.entries(all)) {
      textOnly[k] = { text: v.text || '', photos: [] };
    }
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(textOnly)); } catch { /* storage blocked */ }
  }
}

function openDraftsIdb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSaveDraft(key, draft) {
  const db = await openDraftsIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({
      key,
      text: String(draft?.text || ''),
      photos: Array.isArray(draft?.photos) ? draft.photos.slice(0, MAX_TASK_IMAGES) : [],
      updatedAt: Date.now(),
    });
  } catch { /* ignore */ }
}

async function idbDeleteDraft(key) {
  const db = await openDraftsIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
  } catch { /* ignore */ }
}

let idbHydratePromise = null;
function hydrateDrafts() {
  loadLocalStorageDrafts();
  if (idbHydratePromise) return idbHydratePromise;
  idbHydratePromise = (async () => {
    const db = await openDraftsIdb();
    if (!db) return;
    await new Promise((resolve) => {
      try {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => {
          const rows = Array.isArray(req.result) ? req.result : [];
          for (const row of rows) {
            if (!row?.key) continue;
            const cur = memoryDrafts.get(row.key);
            if (!cur || (!cur.photos?.length && row.photos?.length)) {
              memoryDrafts.set(row.key, {
                text: cur?.text || String(row.text || ''),
                photos: Array.isArray(row.photos) ? row.photos.slice(0, MAX_TASK_IMAGES) : [],
              });
            }
          }
          resolve();
        };
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  })();
  return idbHydratePromise;
}

if (typeof window !== 'undefined') {
  hydrateDrafts();
}

function getDraft(key) {
  if (!key) return { text: '', photos: [] };
  loadLocalStorageDrafts();
  const d = memoryDrafts.get(key);
  return {
    text: String(d?.text || ''),
    photos: Array.isArray(d?.photos) ? [...d.photos.slice(0, MAX_TASK_IMAGES)] : [],
  };
}

function setDraft(key, { text = '', photos = [] } = {}) {
  if (!key) return;
  const cleanText = String(text || '');
  const cleanPhotos = Array.isArray(photos) ? photos.slice(0, MAX_TASK_IMAGES) : [];
  if (!cleanText.trim() && !cleanPhotos.length) {
    memoryDrafts.delete(key);
    saveLocalStorageDrafts();
    idbDeleteDraft(key);
    return;
  }
  const entry = { text: cleanText, photos: [...cleanPhotos] };
  memoryDrafts.set(key, entry);
  saveLocalStorageDrafts();
  idbSaveDraft(key, entry);
}

function clearDraft(key) {
  if (!key) return;
  memoryDrafts.delete(key);
  saveLocalStorageDrafts();
  idbDeleteDraft(key);
}

function saveLastPick(p) {
  lastPick = p ? (p.sid ? { sid: p.sid } : p.dir ? { dir: p.dir } : null) : null;
  try {
    if (lastPick) localStorage.setItem(LAST_PICK_KEY, JSON.stringify(lastPick));
    else localStorage.removeItem(LAST_PICK_KEY);
  } catch { /* storage blocked */ }
}

function getLastPick() {
  loadLocalStorageDrafts();
  return lastPick;
}

const defaultModels = () => [
  { id: '', label: tr('chat.task.modelAuto') },
  { id: 'gemini-4-argon-high', label: '✨ Gemini 4 Argon (High)' },
  { id: 'gemini-4-argon-medium', label: '✨ Gemini 4 Argon (Medium)' },
  { id: 'gemini-4-argon-low', label: '✨ Gemini 4 Argon (Low)' },
  { id: 'gemini-3.8-flash-high', label: '⚡ Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: '⚡ Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: '⚡ Gemini 3.8 Flash (Low)' },
  { id: 'claude-opus-5-5-high', label: '🧠 Claude Opus 5.5 (High)' },
  { id: 'claude-opus-5-5-medium', label: '🧠 Claude Opus 5.5 (Medium)' },
  { id: 'claude-opus-5-5-low', label: '🧠 Claude Opus 5.5 (Low)' },
  { id: 'claude-sonnet-5-5-high', label: '🎯 Claude Sonnet 5.5 (High)' },
  { id: 'claude-sonnet-5-5-medium', label: '🎯 Claude Sonnet 5.5 (Medium)' },
  { id: 'claude-sonnet-5-5-low', label: '🎯 Claude Sonnet 5.5 (Low)' },
  { id: 'gpt-oss-120b-medium', label: '🤖 GPT-OSS 120B (Medium)' },
];

function loadSessionModels() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESS_MODELS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function saveSessionModels(map) {
  try { localStorage.setItem(SESS_MODELS_KEY, JSON.stringify(map || {})); } catch { /* storage blocked */ }
}

function loadPins() {
  try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]')); } catch { return new Set(); }
}
function savePins(set) {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...set])); } catch { /* storage blocked */ }
}

/* ---------- speaking instead of typing: the browser's speech recognition, in the office's language ---------- */
const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
export const canDictate = () => !!SR && window.isSecureContext;
/** 🎤 on a button: speak, and the words go into the field as they come; again to stop. -> stop() */
export function dictate(btn, field, onChange) {
  if (!canDictate()) { toast(tr('chat.task.noMic'), 6000); return null; }
  const rec = new SR(), start = field.value, sep = start && !/\s$/.test(start) ? ' ' : '';
  rec.lang = locale() === 'vi-VN' ? 'vi-VN' : 'en-US'; rec.interimResults = true; rec.continuous = true;
  let done = '';
  rec.onresult = (e) => {
    let live = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { if (e.results[i].isFinal) done += e.results[i][0].transcript; else live += e.results[i][0].transcript; }
    field.value = `${start}${sep}${done}${live}`.slice(0, 4000); onChange?.();
  };
  const end = () => { btn.classList.remove('is-rec'); btn.setAttribute('aria-pressed', 'false'); };
  rec.onend = end; rec.onerror = (e) => { end(); if (e.error === 'not-allowed') toast(tr('chat.task.micBlocked'), 6000); };
  try { rec.start(); } catch { end(); return null; }
  btn.classList.add('is-rec'); btn.setAttribute('aria-pressed', 'true');
  return () => { try { rec.stop(); } catch { /* stopped */ } end(); };
}

/* ---------- photos: made smaller here (2560 px, JPEG) so they go quickly over a phone's connection ---------- */
export async function shrink(file) {
  const bmp = await createImageBitmap(file), k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  let url = c.toDataURL('image/jpeg', 0.90);
  if (url.length > 2_500_000) url = c.toDataURL('image/jpeg', 0.78);
  return url;
}

/** Opens the sheet inside the chat window; to: { sid } (a conversation) or { dir } (a folder) to start with; text. */
export async function openTaskSheet(host, { to = null, text = '', images: initImages = [] } = {}) {
  activeSheetCleanup?.();
  activeSheetCleanup = null;
  sheet?.remove();
  let stopMic = null;
  const [r] = await Promise.all([
    fetch(`/api/tasks${q()}`).then((x) => x.json()).catch(() => null),
    hydrateDrafts(),
  ]);
  sheet = el('div', 'zc-task'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', tr('chat.task.title'));
  const head = el('div', 'zc-task-head'), close = el('button', 'zc-ib'); close.type = 'button'; close.title = tr('chat.close'); close.append(icon('x'));
  let saveCurrentDraft = () => {};
  const closeSheet = () => {
    saveCurrentDraft();
    stopMic?.();
    stopMic = null;
    activeSheetCleanup = null;
    sheet?.remove();
    sheet = null;
  };
  activeSheetCleanup = () => {
    saveCurrentDraft();
    stopMic?.();
    stopMic = null;
  };
  close.addEventListener('click', closeSheet);
  head.append(el('b', null, `📋 ${tr('chat.task.title')}`), close);
  sheet.append(head);
  if (!r?.ok) { sheet.append(el('p', 'zc-task-note', tr('drawer.unreachable'))); host.append(sheet); return; }
  if (!r.allowed) { sheet.append(el('p', 'zc-task-note', tr('chat.task.notAllowed'))); host.append(sheet); return; }
  if (r.viewer) {
    const isDirDev = r.viewer.isDirectorDevice || r.viewer.role === 'Phó Giám đốc';
    const roleBanner = el('p', 'zc-task-note');
    roleBanner.style.color = isDirDev ? '#1D4ED8' : r.requireTaskApproval ? '#D97706' : '#059669';
    roleBanner.style.fontWeight = '600';
    roleBanner.textContent = isDirDev
      ? `👔 ${r.viewer.role || 'Phó Giám đốc'} (${r.viewer.name || 'Thiết bị Giám đốc'}) · ⚡ Toàn quyền dự án & Giao việc trực tiếp`
      : `💼 ${r.viewer.role || 'Trợ lý Giám đốc'} (${r.viewer.name || 'Từ xa'}) · ${r.requireTaskApproval ? '🛡️ Chế độ Giám đốc duyệt trước khi Agent thực hiện đang BẬT' : '⚡ Giao việc chạy trực tiếp'}`;
    sheet.append(roleBanner);
  }
  const pins = loadPins();
  const models = Array.isArray(r.models) && r.models.length ? r.models : defaultModels();
  const sessModels = { ...loadSessionModels(), ...(r.sessionModels && typeof r.sessionModels === 'object' ? r.sessionModels : {}) };
  for (const s of r.sessions || []) {
    if (s.sid && s.selectedModel && !sessModels[`s:${s.sid}`]) sessModels[`s:${s.sid}`] = s.selectedModel;
  }
  for (const p of r.projects || []) {
    if (p.dir && p.selectedModel && !sessModels[`d:${p.dir}`]) sessModels[`d:${p.dir}`] = p.selectedModel;
  }
  saveSessionModels(sessModels);
  const keyOfPick = (p) => (p?.sid ? `s:${p.sid}` : p?.dir ? `d:${p.dir}` : '');
  const getModelForPick = (p) => {
    const k = keyOfPick(p);
    if (k && Object.prototype.hasOwnProperty.call(sessModels, k)) return sessModels[k] || '';
    if (p?.sid) {
      const sObj = (r.sessions || []).find((x) => x.sid === p.sid);
      if (sObj?.selectedModel) return sObj.selectedModel;
    }
    try { return localStorage.getItem(MODEL_KEY) || ''; } catch { return ''; }
  };
  const labelOfModel = (modelId) => {
    if (!modelId) return '';
    const m = models.find((x) => x.id === modelId);
    return m ? m.label : modelId;
  };
  // who it goes to: the conversations (their folder), then "a new one in…" each folder (pinned items float to top)
  const visibleSessions = () => (r.sessions || []).filter((s) => !s.masked && !sessions.get(s.id)?.masked);
  const visibleProjects = () => (r.projects || []).filter((p) => !p.masked);
  const isSessBusy = (s) => {
    const live = sessions.get(s.id) || s;
    return live?.status === 'work' || live?.status === 'wait' || Boolean(live?.busy) || Boolean(s?.busy);
  };
  const sortSessions = () => [...visibleSessions()].sort((a, b) => {
    const pa = pins.has(`s:${a.sid}`) ? 1 : 0;
    const pb = pins.has(`s:${b.sid}`) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ba = isSessBusy(a) ? 1 : 0;
    const bb = isSessBusy(b) ? 1 : 0;
    if (ba !== bb) return ba - bb;
    return 0;
  });
  const sortProjects = () => [...visibleProjects()].sort((a, b) => (pins.has(`d:${b.dir}`) ? 1 : 0) - (pins.has(`d:${a.dir}`) ? 1 : 0));
  const initS = sortSessions(), initP = sortProjects();
  const toSid = to?.id ? visibleSessions().find((s) => s.id === to.id)?.sid : to?.sid;
  const savedPick = getLastPick();
  const savedMatch = savedPick?.sid && initS.some((s) => s.sid === savedPick.sid)
    ? { sid: savedPick.sid }
    : savedPick?.dir && initP.some((p) => p.dir === savedPick.dir)
      ? { dir: savedPick.dir }
      : null;
  let pick = toSid ? { sid: toSid } : to?.dir ? { dir: to.dir } : savedMatch || (initS[0] ? { sid: initS[0].sid } : initP[0] ? { dir: initP[0].dir } : null);
  if (pick) saveLastPick(pick);
  let showNewIn = initS.length === 0 || Boolean(to?.dir && !to?.sid);
  let savedShowNewIn = null;
  try {
    savedShowNewIn = localStorage.getItem('zc_task_show_new_in');
    if (savedShowNewIn === '1' || savedShowNewIn === 'true') showNewIn = true;
    else if (savedShowNewIn === '0' || savedShowNewIn === 'false') showNewIn = false;
  } catch { /* storage blocked */ }
  if (to?.dir && !to?.sid) showNewIn = true;
  if (initS.length === 0 && savedShowNewIn == null) showNewIn = true;
  const list = el('div', 'zc-task-list');
  const modelSelect = el('select', 'zc-task-model-select');
  const syncModelSelect = () => {
    const want = getModelForPick(pick);
    modelSelect.value = models.some((m) => m.id === want) ? want : '';
  };
  const initDraft = getDraft(keyOfPick(pick));
  const initialText = text ? text : (initDraft.text || '');
  const initialPhotos = (Array.isArray(initImages) && initImages.length ? initImages : (initDraft.photos || [])).slice(0, MAX_TASK_IMAGES);
  const field = el('textarea', 'zc-task-in'); field.rows = 4; field.maxLength = 4000; field.placeholder = `${tr('chat.task.placeholder')} · ${tr('chat.task.pasteHint', { max: MAX_TASK_IMAGES })}`; field.value = initialText;
  const photos = [...initialPhotos], thumbs = el('div', 'zc-task-thumbs');
  const camSpan = el('span', null, `${tr('chat.task.photo')} (${photos.length}/${MAX_TASK_IMAGES})`);
  saveCurrentDraft = () => {
    const k = keyOfPick(pick);
    if (k) setDraft(k, { text: field.value, photos });
    if (pick) saveLastPick(pick);
  };
  saveCurrentDraft();
  let sync = () => {};
  const drawThumbs = () => {
    camSpan.textContent = `${tr('chat.task.photo')} (${photos.length}/${MAX_TASK_IMAGES})`;
    thumbs.replaceChildren(...photos.map((u, i) => {
      const t = el('span', 'zc-task-thumb'), img = el('img'), x = el('button', null, '✕');
      img.src = u; x.type = 'button';
      x.addEventListener('click', () => { photos.splice(i, 1); drawThumbs(); saveCurrentDraft(); sync(); });
      t.append(img, x);
      return t;
    }));
  };
  if (photos.length) drawThumbs();
  const option = (key, pinKey, label, sub, face, sel, sessObj = null) => {
    const isPinned = pins.has(pinKey);
    const wrap = el('div', `zc-task-row${sel ? ' is-on' : ''}${isPinned ? ' is-pinned' : ''}`);
    const b = el('button', `zc-task-o${sel ? ' is-on' : ''}`); b.type = 'button';
    const t = el('span', 'zc-men-t');
    const titleEl = el('b', null, isPinned ? `📌 ${label}` : label);
    if (sessObj && isSessBusy(sessObj)) {
      const dot = el('span', 'zc-task-live-dot');
      dot.title = tr('chat.task.activeWorking');
      titleEl.append(' ', dot);
    }
    t.append(titleEl, el('small', null, sub));
    b.append(face, t);
    b.addEventListener('click', () => {
      saveCurrentDraft();
      pick = key;
      saveLastPick(pick);
      for (const x of list.querySelectorAll('.zc-task-o')) x.classList.toggle('is-on', x === b);
      for (const x of list.querySelectorAll('.zc-task-row')) x.classList.toggle('is-on', x === wrap);
      const nextDraft = getDraft(keyOfPick(pick));
      field.value = nextDraft.text || '';
      photos.splice(0, photos.length, ...(nextDraft.photos || []).slice(0, MAX_TASK_IMAGES));
      drawThumbs();
      syncModelSelect();
      sync();
    });
    const pinBtn = el('button', `zc-task-pin${isPinned ? ' is-on' : ''}`, '📌');
    pinBtn.type = 'button';
    pinBtn.title = isPinned ? tr('chat.task.unpin') : tr('chat.task.pin');
    pinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (pins.has(pinKey)) pins.delete(pinKey);
      else pins.add(pinKey);
      savePins(pins);
      drawList();
    });
    wrap.append(b, pinBtn);
    if (sessObj) {
      const editBtn = el('button', 'zc-task-edit', '✏️');
      editBtn.type = 'button';
      editBtn.title = tr('drawer.rename.title');
      editBtn.setAttribute('aria-label', tr('drawer.rename.title'));
      editBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const current = sessObj.name || '';
        const inp = el('input', 'zc-task-rename-in');
        inp.type = 'text';
        inp.maxLength = 75;
        inp.value = current;
        inp.placeholder = sessObj.rawName || tr('drawer.rename.placeholder');
        titleEl.replaceWith(inp);
        let done = false;
        const finish = async (save) => {
          if (done) return;
          done = true;
          const val = inp.value.trim();
          if (save && val !== current) {
            const newName = await renameSession(sessObj, val);
            if (newName !== null) {
              sessObj.name = newName;
            }
          }
          drawList();
        };
        inp.addEventListener('click', (e) => e.stopPropagation());
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); finish(true); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        inp.addEventListener('blur', () => finish(true));
        inp.focus();
        inp.select();
      });
      const delBtn = el('button', 'zc-task-del', '🗑️');
      delBtn.type = 'button';
      delBtn.title = tr('drawer.delete.title');
      delBtn.setAttribute('aria-label', tr('drawer.delete.title'));
      let delTimer = 0;
      delBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!delBtn.classList.contains('is-confirm')) {
          delBtn.classList.add('is-confirm');
          delBtn.textContent = tr('drawer.delete.shortConfirm');
          clearTimeout(delTimer);
          delTimer = setTimeout(() => {
            delBtn.classList.remove('is-confirm');
            delBtn.textContent = '🗑️';
          }, 4000);
          return;
        }
        clearTimeout(delTimer);
        delBtn.disabled = true;
        const ok = await deleteSession(sessObj);
        if (!ok) {
          delBtn.disabled = false;
          delBtn.classList.remove('is-confirm');
          delBtn.textContent = '🗑️';
          return;
        }
        clearDraft(`s:${sessObj.sid}`);
        r.sessions = (r.sessions || []).filter((x) => x.sid !== sessObj.sid && x.id !== sessObj.id);
        if (pick?.sid === sessObj.sid) {
          const nextS = sortSessions()[0];
          const nextP = sortProjects()[0];
          pick = nextS ? { sid: nextS.sid } : nextP ? { dir: nextP.dir } : null;
          saveLastPick(pick);
          const nextDraft = getDraft(keyOfPick(pick));
          field.value = nextDraft.text || '';
          photos.splice(0, photos.length, ...(nextDraft.photos || []).slice(0, MAX_TASK_IMAGES));
          drawThumbs();
        }
        drawList();
        syncModelSelect();
        sync();
      });
      wrap.append(editBtn, delBtn);
    }
    return wrap;
  };
  const drawList = () => {
    const items = [];
    const sessList = sortSessions();
    const projList = sortProjects();
    if (sessList.length) items.push(el('small', 'zc-task-h', tr('chat.task.conversations')));
    for (const s of sessList) {
      const mId = getModelForPick({ sid: s.sid });
      const mText = labelOfModel(mId) || s.model || '';
      const subText = mText ? `📁 ${s.dir} · ${mText}` : `📁 ${s.dir}`;
      items.push(option({ sid: s.sid }, `s:${s.sid}`, s.name, subText, avatar({ ...(who(s.id) || {}), key: s.id, name: s.name }, 30), pick?.sid === s.sid, s));
    }
    if (projList.length) {
      const projHead = el('div', 'zc-task-h zc-task-h-toggle');
      const toggleBtn = el('button', 'zc-task-toggle-btn', showNewIn ? `${tr('chat.task.hideNewIn')} ▲` : `${tr('chat.task.showNewIn')} (${projList.length}) ▼`);
      toggleBtn.type = 'button';
      toggleBtn.setAttribute('aria-expanded', String(showNewIn));
      const toggleNewIn = (ev) => {
        ev.stopPropagation();
        showNewIn = !showNewIn;
        try { localStorage.setItem('zc_task_show_new_in', showNewIn ? '1' : '0'); } catch { /* storage blocked */ }
        drawList();
      };
      projHead.addEventListener('click', toggleNewIn);
      projHead.append(el('span', null, tr('chat.task.newIn')), toggleBtn);
      items.push(projHead);
      if (showNewIn) {
        for (const p of projList) {
          const f = el('span', 'zc-task-folder', '📁');
          const mId = getModelForPick({ dir: p.dir });
          const mText = labelOfModel(mId);
          const subText = mText ? `${p.dir} · ${mText}` : p.dir;
          items.push(option({ dir: p.dir }, `d:${p.dir}`, p.name, subText, f, pick?.dir === p.dir && !pick?.sid));
        }
      }
    }
    list.replaceChildren(...items);
  };
  drawList();
  // AI Model selector row (persisted per session/folder in server & localStorage until changed)
  const modelRow = el('div', 'zc-task-model-row');
  const modelLabel = el('label', 'zc-task-model-label', `🤖 ${tr('chat.task.modelLabel')}`);
  modelSelect.setAttribute('aria-label', tr('chat.task.modelLabel'));
  for (const m of models) {
    const opt = el('option', null, m.id === '' ? tr('chat.task.modelAuto') : m.label);
    opt.value = m.id;
    modelSelect.append(opt);
  }
  syncModelSelect();
  modelSelect.addEventListener('change', () => {
    const val = modelSelect.value;
    const k = keyOfPick(pick);
    if (k) {
      sessModels[k] = val;
      saveSessionModels(sessModels);
    }
    try { localStorage.setItem(MODEL_KEY, val); } catch { /* storage blocked */ }
    drawList();
    if (pick) {
      fetch(`/api/tasks/model${q()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...pick, model: val }),
      }).catch(() => {});
    }
  });
  modelRow.append(modelLabel, modelSelect);
  // what to do: typed or spoken, and photos (up to 20 images via button or Ctrl+V)
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
  });
  const addImageFiles = async (fileList) => {
    const imgs = [...(fileList || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
    if (!imgs.length) return;
    const slots = MAX_TASK_IMAGES - photos.length;
    if (slots <= 0) {
      toast(tr('chat.task.photoLimit', { max: MAX_TASK_IMAGES }), 3500);
      return;
    }
    for (const f of imgs.slice(0, slots)) {
      try { photos.push(await shrink(f)); } catch { /* not an image it can read */ }
    }
    if (imgs.length > slots) toast(tr('chat.task.photoAddedMax', { max: MAX_TASK_IMAGES, added: slots }), 3500);
    drawThumbs();
    saveCurrentDraft();
    sync();
  };
  const file = el('input'); file.type = 'file'; file.accept = 'image/*'; file.multiple = true; file.hidden = true;
  file.addEventListener('change', async () => { await addImageFiles(file.files); file.value = ''; });
  field.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length) {
      e.preventDefault();
      await addImageFiles(pastedFiles);
    }
  });
  const mic = el('button', 'zc-task-tool'); mic.type = 'button'; mic.title = tr('chat.task.mic'); mic.append(icon('mic'), el('span', null, tr('chat.task.mic')));
  mic.addEventListener('click', () => { if (stopMic) { stopMic(); stopMic = null; } else stopMic = dictate(mic, field, () => { saveCurrentDraft(); sync(); }); });
  const cam = el('button', 'zc-task-tool'); cam.type = 'button'; cam.title = `${tr('chat.task.photo')} (${tr('chat.task.pasteHint', { max: MAX_TASK_IMAGES })})`; cam.append(icon('image'), camSpan);
  cam.addEventListener('click', () => file.click());
  const tools = el('div', 'zc-task-tools'); tools.append(mic, cam, file);
  const sendLabel = r.requireTaskApproval ? tr('chat.task.sendApprove') : tr('chat.task.send');
  const go = el('button', 'zc-task-go', sendLabel); go.type = 'button';
  sync = () => { go.disabled = !pick || (!field.value.trim() && !photos.length); };
  field.addEventListener('input', () => { saveCurrentDraft(); sync(); });
  go.addEventListener('click', async () => {
    stopMic?.(); stopMic = null; go.disabled = true; go.textContent = tr('chat.task.sending');
    const k = keyOfPick(pick);
    if (k) {
      sessModels[k] = modelSelect.value;
      saveSessionModels(sessModels);
    }
    const promptText = field.value.trim() || (photos.length ? tr('chat.task.defaultImagePrompt') : '');
    const res = await fetch(`/api/tasks${q()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pick, text: promptText, images: photos, model: modelSelect.value }) }).then((x) => x.json()).catch(() => null);
    if (res?.ok) {
      sfx?.play('task');
      toast(res.pendingApproval ? (res.message || tr('chat.task.sentForApproval')) : tr('chat.task.started'), 5500);
      clearDraft(k);
      activeSheetCleanup = null;
      sheet.remove(); sheet = null; return;
    }
    toast(res?.message || tr('drawer.unreachable'), 6000); go.textContent = sendLabel; sync();
  });
  sheet.append(list, modelRow, field, thumbs, tools, el('p', 'zc-task-note', tr('chat.task.note')), go);
  if (r.running.length) sheet.append(el('p', 'zc-task-note', tr('chat.task.running', { n: r.running.length })));
  host.append(sheet);
  sync(); setTimeout(() => field.focus({ preventScroll: true }), 50);
}
