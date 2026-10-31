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
import { deleteSession } from './session-drawer.js';
import { sfx } from '../audio/sfx.js';
import { t as tr, locale } from '../../i18n/index.js';

const q = () => (TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : '');
export const MAX_TASK_IMAGES = 5;
const PIN_KEY = 'office-pinned-tasks';
const MODEL_KEY = 'office-task-model';
const SESS_MODELS_KEY = 'office-session-models';
let sheet = null;

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

/* ---------- photos: made smaller here (1600 px, JPEG) so they go quickly over a phone's connection ---------- */
export async function shrink(file) {
  const bmp = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  let url = c.toDataURL('image/jpeg', 0.82);
  if (url.length > 480_000) url = c.toDataURL('image/jpeg', 0.6);   // (under what the group chat shows too)
  return url;
}

/** Opens the sheet inside the chat window; to: { sid } (a conversation) or { dir } (a folder) to start with; text. */
export async function openTaskSheet(host, { to = null, text = '', images: initImages = [] } = {}) {
  sheet?.remove();
  let stopMic = null;
  const r = await fetch(`/api/tasks${q()}`).then((x) => x.json()).catch(() => null);
  sheet = el('div', 'zc-task'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', tr('chat.task.title'));
  const head = el('div', 'zc-task-head'), close = el('button', 'zc-ib'); close.type = 'button'; close.title = tr('chat.close'); close.append(icon('x'));
  close.addEventListener('click', () => { stopMic?.(); sheet.remove(); sheet = null; });
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
  const sortSessions = () => [...visibleSessions()].sort((a, b) => (pins.has(`s:${b.sid}`) ? 1 : 0) - (pins.has(`s:${a.sid}`) ? 1 : 0));
  const sortProjects = () => [...visibleProjects()].sort((a, b) => (pins.has(`d:${b.dir}`) ? 1 : 0) - (pins.has(`d:${a.dir}`) ? 1 : 0));
  const initS = sortSessions(), initP = sortProjects();
  const toSid = to?.id ? visibleSessions().find((s) => s.id === to.id)?.sid : to?.sid;
  let pick = toSid ? { sid: toSid } : to?.dir ? { dir: to.dir } : initS[0] ? { sid: initS[0].sid } : initP[0] ? { dir: initP[0].dir } : null;
  const list = el('div', 'zc-task-list');
  const modelSelect = el('select', 'zc-task-model-select');
  const syncModelSelect = () => {
    const want = getModelForPick(pick);
    modelSelect.value = models.some((m) => m.id === want) ? want : '';
  };
  const option = (key, pinKey, label, sub, face, sel, sessObj = null) => {
    const isPinned = pins.has(pinKey);
    const wrap = el('div', `zc-task-row${sel ? ' is-on' : ''}${isPinned ? ' is-pinned' : ''}`);
    const b = el('button', `zc-task-o${sel ? ' is-on' : ''}`); b.type = 'button';
    const t = el('span', 'zc-men-t');
    const titleEl = el('b', null, isPinned ? `📌 ${label}` : label);
    t.append(titleEl, el('small', null, sub));
    b.append(face, t);
    b.addEventListener('click', () => {
      pick = key;
      for (const x of list.querySelectorAll('.zc-task-o')) x.classList.toggle('is-on', x === b);
      for (const x of list.querySelectorAll('.zc-task-row')) x.classList.toggle('is-on', x === wrap);
      syncModelSelect();
      sync();
    });
    const pinBtn = el('button', `zc-task-pin${isPinned ? ' is-on' : ''}`, '📌');
    pinBtn.type = 'button';
    pinBtn.title = isPinned ? 'Bỏ ghim' : 'Ghim lên đầu danh sách';
    pinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (pins.has(pinKey)) pins.delete(pinKey);
      else pins.add(pinKey);
      savePins(pins);
      drawList();
    });
    wrap.append(b, pinBtn);
    if (sessObj) {
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
        r.sessions = (r.sessions || []).filter((x) => x.sid !== sessObj.sid && x.id !== sessObj.id);
        if (pick?.sid === sessObj.sid) {
          const nextS = sortSessions()[0];
          const nextP = sortProjects()[0];
          pick = nextS ? { sid: nextS.sid } : nextP ? { dir: nextP.dir } : null;
        }
        drawList();
        syncModelSelect();
        sync();
      });
      wrap.append(delBtn);
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
    if (projList.length) items.push(el('small', 'zc-task-h', tr('chat.task.newIn')));
    for (const p of projList) {
      const f = el('span', 'zc-task-folder', '📁');
      const mId = getModelForPick({ dir: p.dir });
      const mText = labelOfModel(mId);
      const subText = mText ? `${p.dir} · ${mText}` : p.dir;
      items.push(option({ dir: p.dir }, `d:${p.dir}`, p.name, subText, f, pick?.dir === p.dir && !pick?.sid));
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
  // what to do: typed or spoken, and photos (up to 5 images via button or Ctrl+V)
  const field = el('textarea', 'zc-task-in'); field.rows = 4; field.maxLength = 4000; field.placeholder = `${tr('chat.task.placeholder')} · Ctrl+V dán ảnh (tối đa ${MAX_TASK_IMAGES} ảnh)`; field.value = text;
  field.addEventListener('keydown', (e) => e.stopPropagation());
  const photos = [...initImages.slice(0, MAX_TASK_IMAGES)], thumbs = el('div', 'zc-task-thumbs');
  const camSpan = el('span', null, `${tr('chat.task.photo')} (${photos.length}/${MAX_TASK_IMAGES})`);
  const drawThumbs = () => {
    camSpan.textContent = `${tr('chat.task.photo')} (${photos.length}/${MAX_TASK_IMAGES})`;
    thumbs.replaceChildren(...photos.map((u, i) => {
      const t = el('span', 'zc-task-thumb'), img = el('img'), x = el('button', null, '✕');
      img.src = u; x.type = 'button';
      x.addEventListener('click', () => { photos.splice(i, 1); drawThumbs(); sync(); });
      t.append(img, x);
      return t;
    }));
  };
  if (photos.length) drawThumbs();
  const addImageFiles = async (fileList) => {
    const imgs = [...(fileList || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
    if (!imgs.length) return;
    const slots = MAX_TASK_IMAGES - photos.length;
    if (slots <= 0) {
      toast(`Đã đạt giới hạn tối đa ${MAX_TASK_IMAGES} ảnh cho Antigravity.`, 3500);
      return;
    }
    for (const f of imgs.slice(0, slots)) {
      try { photos.push(await shrink(f)); } catch { /* not an image it can read */ }
    }
    if (imgs.length > slots) toast(`Chỉ gửi tối đa ${MAX_TASK_IMAGES} ảnh (đã thêm ${slots} ảnh).`, 3500);
    drawThumbs();
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
  mic.addEventListener('click', () => { if (stopMic) { stopMic(); stopMic = null; } else stopMic = dictate(mic, field, sync); });
  const cam = el('button', 'zc-task-tool'); cam.type = 'button'; cam.title = `${tr('chat.task.photo')} (Ctrl+V · tối đa ${MAX_TASK_IMAGES} ảnh)`; cam.append(icon('image'), camSpan);
  cam.addEventListener('click', () => file.click());
  const tools = el('div', 'zc-task-tools'); tools.append(mic, cam, file);
  const sendLabel = r.requireTaskApproval ? '⏳ Gửi Giám đốc duyệt & Giao việc' : tr('chat.task.send');
  const go = el('button', 'zc-task-go', sendLabel); go.type = 'button';
  const sync = () => { go.disabled = !pick || (!field.value.trim() && !photos.length); };
  field.addEventListener('input', sync);
  go.addEventListener('click', async () => {
    stopMic?.(); stopMic = null; go.disabled = true; go.textContent = tr('chat.task.sending');
    const k = keyOfPick(pick);
    if (k) {
      sessModels[k] = modelSelect.value;
      saveSessionModels(sessModels);
    }
    const promptText = field.value.trim() || (photos.length ? 'Hãy phân tích hình ảnh đính kèm và xử lý yêu cầu.' : '');
    const res = await fetch(`/api/tasks${q()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...pick, text: promptText, images: photos, model: modelSelect.value }) }).then((x) => x.json()).catch(() => null);
    if (res?.ok) {
      sfx?.play('task');
      toast(res.pendingApproval ? (res.message || '⏳ Đã gửi yêu cầu công việc tới Giám đốc để phê duyệt!') : tr('chat.task.started'), 5500);
      sheet.remove(); sheet = null; return;
    }
    toast(res?.message || tr('drawer.unreachable'), 6000); go.textContent = sendLabel; sync();
  });
  sheet.append(list, modelRow, field, thumbs, tools, el('p', 'zc-task-note', tr('chat.task.note')), go);
  if (r.running.length) sheet.append(el('p', 'zc-task-note', tr('chat.task.running', { n: r.running.length })));
  host.append(sheet);
  sync(); setTimeout(() => field.focus({ preventScroll: true }), 50);
}
