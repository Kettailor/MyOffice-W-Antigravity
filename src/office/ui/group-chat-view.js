// The group chat's window (the conversation: group-chat.js), drawn after the Vietnamese messenger's group chat on a
// phone (its own web CSS and string table, and a 2026 screenshot of the app, for the colours, sizes and words): the
// blue gradient bar with the back chevron, the group's name and "👥 N thành viên", call, video and ☰; the pinned message
// under it; the conversation on a lavender-grey ground, gathered at the bottom like the app's, the others' white
// bubbles on the left (the name at the top inside the first of a run, the face beside it, the time inside the last),
// yours pale blue on the right with who has seen it; dark pills for the time lines, white ones for what the group does;
// "Tin nhắn mới" where you stopped reading; replies quoting what they answer; a recalled message's "Tin nhắn đã được
// thu hồi"; the ♡ on a bubble's corner and a small pill once someone reacts (hover a bubble for the six, a reply and,
// on yours, recall); polls and reminders as cards in the middle; "… đang soạn tin"; the input bar: stickers and emoji,
// "Tin nhắn", ••• (a poll, @ someone), the mic and a photo, or send once you type. No brand, logo, sticker art or sound
// of theirs: the stickers are drawn here, the sound is the office's own.
import { $, STATIC, el } from '../core/env.js';
import { state } from '../core/state.js';
import { icon } from './icons.js';
import { avatar } from './chat-avatars.js';
import { photoOn } from './photo.js';
import { dn, sessions } from '../people/workers.js';
import { MAX_TASK_IMAGES, openTaskSheet, dictate, shrink } from './task-sheet.js';
import { toast } from './activity.js';
import { TOKEN } from '../net/live.js';
import { sfx } from '../audio/sfx.js';
import { CHAT_RETENTION_MS, REACTIONS, STAFF_FACES, byId, canSeeSession, channelOf, chat, chatPin, chatPoll, chatSend, chatSendPhoto, chatSendPhotoData, isMentioningMe, isMsgVisible, myViewerId, onChat, people, react, recall, rsvp, setChatChannel, setOpen, shouldNotifyForMsg, vote, who } from './group-chat.js';
import { t as tr, locale } from '../../i18n/index.js';

let root, body, typingEl, pinEl, newBtn, input, bar, stickersEl, membersEl, mentionEl, moreEl, replyEl, headSub, headAv, toEl, pickEl, chatThumbsEl, tabsEl, tabWorkBtn, tabCasualBtn, tabWorkBadge, tabCasualBadge, channelSubEl;
let replyTo = null, readTo = null, stickTab = 'sticker';   // the message you answer; the last one read when the window shut; the panel's tab
let lastHeadKey = '';
let msgLimit = 100;
let mentionedHumans = [];   // IDs of human participants @mentioned in the current input
const chatPhotos = [];   // up to MAX_TASK_IMAGES (5) images pasted via Ctrl+V or attached in chat

function getHumanParticipants() {
  const map = new Map();
  map.set('director', { id: 'director', name: 'Giám đốc', role: 'Giám đốc' });
  const raw = [
    ...(Array.isArray(state.participants) ? state.participants : []),
    ...(Array.isArray(state.teamMembers) ? state.teamMembers : []),
    ...((state.access?.members || []).filter((m) => m.status === 'approved')),
  ];
  for (const p of raw) {
    if (!p || !p.id) continue;
    map.set(p.id, { id: p.id, name: p.name || p.role || 'Thành viên', role: p.role || 'Trợ lý Giám đốc' });
  }
  if (!state.isLocal && state.viewer?.id && !map.has(state.viewer.id)) {
    map.set(state.viewer.id, { id: state.viewer.id, name: state.viewer.name || 'Trợ lý Giám đốc', role: state.viewer.role || 'Trợ lý Giám đốc' });
  }
  return [...map.values()];
}

function parseLegacySender(m) {
  const raw = String(m?.text || '');
  const match = /^👔 \[([^\]]+)\]\s*(.*)$/s.exec(raw);
  if (!match) return { whoName: m?.whoName || null, whoRole: m?.whoRole || null, cleanText: raw };
  const parts = match[1].split('·').map((s) => s.trim()).filter(Boolean);
  const parsedRole = parts.length > 1 ? parts[0] : (parts[0] || '');
  const parsedName = parts.length > 1 ? parts.slice(1).join(' · ') : (parts[0] || '');
  return {
    whoName: m?.whoName || parsedName || null,
    whoRole: m?.whoRole || parsedRole || null,
    cleanText: match[2] || '',
  };
}
const RUN_MS = 3 * 60e3, GAP_MS = 20 * 60e3;   // one run of bubbles: the same person within 3 minutes; a time line after 20 quiet minutes
const seeVotes = new Set();   // polls whose voters are listed
const p2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => { const d = new Date(ts); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
// the time lines: "14:32 Hôm nay", "Hôm qua", within the week "Thứ Hai 27/10/2026", else "27/09/2026"
function timeLabel(ts) {
  const d = new Date(ts), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  const date = `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
  const day = d.toDateString() === now.toDateString() ? tr('chat.today') : d.toDateString() === y.toDateString() ? tr('chat.yesterday')
    : now - d < 7 * 864e5 ? `${d.toLocaleDateString(locale(), { weekday: 'long' })} ${date}` : date;
  return `${fmtTime(ts)} ${day}`;
}
const mask = (text) => (state.streamer ? String(text || '').replace(/“[^”]*”/g, '“…”') : String(text || ''));
const meP = () => ({ key: 'me', name: !state.isLocal && state.viewer ? `${state.viewer.role || 'Trợ lý'}: ${state.viewer.name}` : tr('chat.boss') });
const faceOf = (key, name) => {
  if (key === 'me') return meP();
  const w = who(key);
  if (w) return { ...w, key: w.key || key, name: w.name || name || '?' };
  const sf = STAFF_FACES[key] || STAFF_FACES[`__${key}`];
  if (sf) return { key, name: name || (sf.nameKey ? tr(sf.nameKey) : `?`), look: sf.look, staff: true };
  return { key, name: name || '?' };
};
const nameOf = (key) => (key === 'me' ? tr('chat.you') : who(key)?.name || '');
const inCurrentChannel = (m) => {
  if (!isMsgVisible(m) || channelOf(m) !== (chat.channel || 'work')) return false;
  const ts = m.ts || m.at;
  if (ts && Date.now() - ts > CHAT_RETENTION_MS) return false;
  return true;
};

/* ---------- stickers: drawn here (no one's artwork): a big emoji and a caption in round, outlined letters ---------- */
const STICKER_EMOJI = ['👌', '🙏', '👀', '🔥', '💪', '🤭', '🎉', '🥺'];
const EMOJI = '😀 😁 😂 🤣 😊 😍 🥰 😘 😎 🤩 🥳 😅 😆 😉 🤗 🤔 😴 🥱 😮 😢 😭 😡 🤯 🙄 😬 🤭 🫡 🫠 👍 👎 👏 🙏 💪 👌 ✌️ 🤝 👀 ❤️ 💔 🔥 ✨ 🎉 🎂 🍻 🧋 ☕ 🍜 🍱 🍗 🛵 🚀 💯 ✅ ❌ ⚠️ 🐛 💻 📦 📌 🕘'.split(' ');
const stickerCache = new Map();
function stickerUrl(i) {
  if (stickerCache.has(i)) return stickerCache.get(i);
  const c = document.createElement('canvas'); c.width = c.height = 260; const g = c.getContext('2d');
  g.font = '128px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(STICKER_EMOJI[i % STICKER_EMOJI.length], 130, 104);
  const cap = tr('chat.stickers', null, 'list')[i] || '';
  g.font = '900 40px "Baloo 2", "Be Vietnam Pro", system-ui, sans-serif'; g.lineJoin = 'round';
  g.lineWidth = 13; g.strokeStyle = '#FFFFFF'; g.strokeText(cap, 130, 212);
  g.lineWidth = 4; g.strokeStyle = '#1B2A4A'; g.strokeText(cap, 130, 212); g.fillStyle = '#FFD24A'; g.fillText(cap, 130, 212);
  const url = c.toDataURL('image/png'); stickerCache.set(i, url); return url;
}

/* ---------- a message ---------- */
function reactPill(m) {
  const all = Object.entries(m.reacts || {}).filter(([, l]) => l.length);
  if (!all.length) return null;
  const pill = el('span', 'zc-rx'), n = all.reduce((a, [, l]) => a + l.length, 0);
  pill.append(...all.sort((a, b) => b[1].length - a[1].length).slice(0, 3).map(([e]) => el('i', null, e)));
  if (n > 1) pill.append(el('b', null, String(n)));
  pill.title = all.map(([e, l]) => `${e} ${l.map(nameOf).filter(Boolean).join(', ')}`).join('\n');
  return pill;
}
// over a bubble: the six reactions, a reply, pin and (yours) recall; on a touch screen, a tap shows them
function tools(m, mine) {
  const box = el('span', 'zc-tools'), pick = el('span', 'zc-pick');
  REACTIONS.forEach((e, i) => { const b = el('button', 'zc-pick-b', e); b.type = 'button'; b.style.animationDelay = `${i * 20}ms`; b.addEventListener('click', (ev) => { ev.stopPropagation(); react(m, e); }); pick.append(b); });
  const rep = el('button', 'zc-tool'); rep.type = 'button'; rep.title = tr('chat.reply'); rep.append(icon('reply'));
  rep.addEventListener('click', (ev) => { ev.stopPropagation(); setReply(m); });
  const isPinned = chat.pinned === m.id;
  const pin = el('button', `zc-tool${isPinned ? ' is-pinned' : ''}`); pin.type = 'button'; pin.title = isPinned ? 'Bỏ ghim tin nhắn' : 'Ghim tin nhắn'; pin.append(icon('pinbar'));
  pin.addEventListener('click', (ev) => { ev.stopPropagation(); chatPin(m.id); });
  box.append(pick, rep, pin);
  if (mine) { const rc = el('button', 'zc-tool'); rc.type = 'button'; rc.title = tr('chat.recall'); rc.append(icon('undo')); rc.addEventListener('click', (ev) => { ev.stopPropagation(); recall(m); }); box.append(rc); }
  return box;
}
function permCard(m) {
  const p = m.perm || {};
  const card = el('div', `zc-perm-card${p.resolved ? ' is-resolved' : ''}`);
  const headIcon = p.kind === 'ask' ? '❓' : p.kind === 'plan' ? '📋' : '🛡️';
  const headTitle = p.kind === 'ask' ? 'Antigravity cần bạn chọn hướng xử lý' : p.kind === 'plan' ? 'Antigravity trình duyệt Kế hoạch' : 'Antigravity xin cấp quyền truy cập / thực thi';
  card.append(el('span', 'zc-card-tag', `${headIcon} ${headTitle}`));
  if (p.label) card.append(el('b', 'zc-perm-title', mask(p.label)));
  if (p.detail && p.detail !== p.label) card.append(el('pre', 'zc-perm-detail', mask(p.detail)));

  const sendDecision = async (choice, answers = null, btnEl = null) => {
    if (btnEl) btnEl.disabled = true;
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    const res = await fetch(`/api/perm${tq()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, choice, ...(answers ? { answers } : {}) }),
    }).then((x) => x.json()).catch(() => null);
    if (res?.ok) {
      sfx?.play('task');
      toast('✅ Đã gửi phản hồi cho Antigravity tiếp tục công việc!', 3500);
    } else {
      toast(res?.message || 'Không thể gửi phản hồi (phiên đã đóng hoặc không đủ quyền).', 4500);
      for (const b of card.querySelectorAll('button')) b.disabled = false;
    }
  };

  if (p.resolved) {
    const choiceMap = { allow: '✅ Đã cho phép', deny: '❌ Đã từ chối', approve: '✅ Đã duyệt kế hoạch', revise: '✏️ Yêu cầu chỉnh sửa', answer: '✅ Đã chọn phương án' };
    const badgeText = `${choiceMap[p.choice] || `✅ Đã xử lý (${p.choice || 'ok'})`}${p.byName ? ` · bởi ${p.byName}` : ''}`;
    card.append(el('div', 'zc-perm-resolved', badgeText));
    return card;
  }

  if (p.kind === 'ask' && Array.isArray(p.questions) && p.questions.length) {
    const selectedAnswers = {};
    for (const qItem of p.questions) {
      const qBox = el('div', 'zc-perm-q');
      qBox.append(el('b', 'zc-perm-qt', qItem.question || qItem.header || 'Lựa chọn phương án:'));
      const optsWrap = el('div', 'zc-perm-opts');
      const opts = Array.isArray(qItem.options) ? qItem.options : [];
      opts.forEach((o, idx) => {
        const optLabel = typeof o === 'string' ? o : (o.label || `Phương án ${idx + 1}`);
        const optDesc = typeof o === 'object' && o?.description ? o.description : '';
        const optBtn = el('button', 'zc-perm-opt');
        optBtn.type = 'button';
        optBtn.append(el('b', null, `${idx + 1}. ${optLabel}`));
        if (optDesc) optBtn.append(el('small', null, optDesc));
        optBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          for (const x of optsWrap.querySelectorAll('.zc-perm-opt')) x.classList.remove('is-sel');
          optBtn.classList.add('is-sel');
          selectedAnswers[qItem.question] = optLabel;
          if (p.questions.length === 1) sendDecision('answer', selectedAnswers, optBtn);
        });
        optsWrap.append(optBtn);
      });
      qBox.append(optsWrap);
      card.append(qBox);
    }
    if (p.questions.length > 1) {
      const submitAsk = el('button', 'zc-perm-btn is-allow', '✅ Gửi lựa chọn cho Antigravity');
      submitAsk.type = 'button';
      submitAsk.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendDecision('answer', selectedAnswers, submitAsk);
      });
      card.append(submitAsk);
    }
  } else if (p.kind === 'plan') {
    const acts = el('div', 'zc-perm-acts');
    const okBtn = el('button', 'zc-perm-btn is-allow', '✅ Duyệt kế hoạch');
    const revBtn = el('button', 'zc-perm-btn is-deny', '✏️ Yêu cầu sửa');
    okBtn.type = revBtn.type = 'button';
    okBtn.addEventListener('click', (ev) => { ev.stopPropagation(); sendDecision('approve', null, okBtn); });
    revBtn.addEventListener('click', (ev) => { ev.stopPropagation(); sendDecision('revise', null, revBtn); });
    acts.append(okBtn, revBtn);
    card.append(acts);
  } else {
    const acts = el('div', 'zc-perm-acts');
    const allowBtn = el('button', 'zc-perm-btn is-allow', '✅ Cho phép tiếp tục');
    const denyBtn = el('button', 'zc-perm-btn is-deny', '❌ Từ chối');
    allowBtn.type = denyBtn.type = 'button';
    allowBtn.addEventListener('click', (ev) => { ev.stopPropagation(); sendDecision('allow', null, allowBtn); });
    denyBtn.addEventListener('click', (ev) => { ev.stopPropagation(); sendDecision('deny', null, denyBtn); });
    acts.append(allowBtn, denyBtn);
    card.append(acts);
  }
  return card;
}
function pollCard(m) {
  const card = el('div', 'zc-poll'), voters = new Set(m.poll.opts.flatMap((o) => o.by)), max = Math.max(1, ...m.poll.opts.map((o) => o.by.length)), open = seeVotes.has(m.id);
  card.append(el('span', 'zc-card-tag', `📊 ${tr('chat.pollTag')}`), el('b', 'zc-poll-q', m.poll.q));
  m.poll.opts.forEach((o, i) => {
    const row = el('button', 'zc-poll-o' + (o.by.includes('me') ? ' is-mine' : '')); row.type = 'button';
    const fill = el('i', 'zc-poll-bar'); fill.style.width = `${(o.by.length / max) * 100}%`;
    const faces = el('span', 'zc-poll-faces'); for (const k of o.by.slice(-3)) faces.append(avatar(faceOf(k), 18));
    row.append(fill, el('span', 'zc-poll-t', o.t), faces, el('b', 'zc-poll-c', String(o.by.length)));
    row.addEventListener('click', () => vote(m, i));
    card.append(row);
    if (open && o.by.length) card.append(el('small', 'zc-poll-who', o.by.map(nameOf).filter(Boolean).join(', ')));
  });
  card.append(el('small', 'zc-poll-n', tr('chat.pollVoters', { n: voters.size })));
  const btn = el('button', 'zc-card-btn', tr(open ? 'chat.pollSee' : voters.has('me') ? 'chat.pollChange' : 'chat.pollVote')); btn.type = 'button';
  btn.addEventListener('click', () => { if (open) seeVotes.delete(m.id); else seeVotes.add(m.id); redrawOne(m); });
  card.append(btn);
  return card;
}
// a reminder ("Nhắc hẹn"): the date on a calendar leaf, the time, the repeat, who's going, yes or no
function remindCard(m) {
  const r = m.remind, d = new Date(r.at), card = el('div', 'zc-remind'), leaf = el('span', 'zc-leaf');
  leaf.append(el('b', null, d.toLocaleDateString(locale(), { month: 'short' }).replace('.', '')), el('strong', null, String(d.getDate())));
  const info = el('span', 'zc-rm-info');
  info.append(el('span', 'zc-card-tag', `⏰ ${tr('chat.remindTag')}`), el('b', 'zc-rm-t', r.title), el('small', null, `${fmtTime(r.at)} · ${d.toLocaleDateString(locale(), { weekday: 'long', day: '2-digit', month: '2-digit' })}`));
  if (r.repeat) info.append(el('small', null, `🔁 ${tr('chat.remindWeek')}`));
  const top = el('div', 'zc-rm-top'); top.append(leaf, info);
  const going = el('div', 'zc-rm-going'), faces = el('span', 'zc-poll-faces');
  for (const k of r.yes.slice(-4)) faces.append(avatar(faceOf(k), 20));
  going.append(faces, el('small', null, r.done ? tr('chat.remindDone') : tr('chat.remindGoing', { n: r.yes.length })));
  const acts = el('div', 'zc-rm-acts');
  for (const [yes, label] of [[false, 'chat.remindNo'], [true, 'chat.remindYes']]) {
    const b = el('button', `zc-rm-b${yes ? ' is-yes' : ''}${(yes ? r.yes : r.no).includes('me') ? ' is-on' : ''}`, tr(label)); b.type = 'button'; b.disabled = !!r.done;
    b.addEventListener('click', () => rsvp(m, yes)); acts.append(b);
  }
  card.append(top, going, acts);
  return card;
}
function quote(r) {
  const q = el('span', 'zc-quote'); q.append(el('b', null, r.name), el('span', null, mask(r.text)));
  q.addEventListener('click', (ev) => { ev.stopPropagation(); flash(r.id); });
  return q;
}
function resolveImgUrl(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^[0-9a-f]{16}$/i.test(u)) return `/api/image?id=${u}${TOKEN ? `&k=${encodeURIComponent(TOKEN)}` : ''}`;
  if (u.startsWith('/api/image?') && TOKEN && !u.includes('k=')) return `${u}&k=${encodeURIComponent(TOKEN)}`;
  return u;
}
function msgPhotos(m) {
  if (!m || m.recalled) return [];
  const list = [];
  if (Array.isArray(m.images)) {
    for (const raw of m.images) {
      const u = resolveImgUrl(raw);
      if (u && !list.includes(u)) list.push(u);
    }
  }
  if (typeof m.photo === 'string' && m.photo) {
    const u = resolveImgUrl(m.photo);
    if (u && !list.includes(u)) list.push(u);
  }
  return list;
}
function buildPhotoGrid(m, photos, showTimeOnLast = true) {
  const wrap = el('div', `zc-photo-grid${photos.length > 1 ? ' is-multi' : ''}`);
  photos.forEach((src, idx) => {
    const box = el('span', 'zc-photo'), img = el('img', 'zc-msg-img');
    img.src = src; img.alt = tr('chat.photo'); img.loading = 'lazy';
    box.append(img);
    if (showTimeOnLast && idx === photos.length - 1) box.append(el('span', 'zc-ptime', fmtTime(m.at)));
    box.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(m.id, idx); });
    wrap.append(box);
  });
  return wrap;
}
function content(m) {
  if (m.recalled) return el('span', 'zc-text zc-muted', tr('chat.recalled'));
  if (m.kind === 'perm') return permCard(m);
  if (m.kind === 'sticker') { const img = el('img', 'zc-sticker'); img.src = stickerUrl(m.sticker); img.alt = tr('chat.sticker'); return img; }
  const photos = msgPhotos(m);
  if (m.kind === 'photo') {
    if (!photos.length) return el('span', 'zc-text zc-muted', tr('chat.photo'));
    return buildPhotoGrid(m, photos, true);
  }
  const { cleanText } = parseLegacySender(m);
  if (photos.length && !cleanText.trim()) return buildPhotoGrid(m, photos, true);
  if (!photos.length && bigEmoji(cleanText)) return el('span', 'zc-bigemo', cleanText);
  const t = el('span', 'zc-text');
  // @names in blue, the way the app shows a mention: the whole name of someone in the group (names have spaces), else one word
  const humanNames = getHumanParticipants().flatMap((h) => [h.name, h.role]).filter(Boolean);
  const names = [tr('chat.boss'), tr('chat.everyone'), 'All', 'Giám đốc', 'Phó Giám đốc', 'Trợ lý Giám đốc', ...(m.ownerName ? [m.ownerName] : []), ...humanNames, ...people().map((id) => dn(sessions.get(id)))].filter(Boolean).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})|@[^\\s,.!?:]+)`, 'u');
  const myId = myViewerId();
  const isDirectorOrDeputy = state.isLocal || !!state.viewer?.isDirectorDevice || state.viewer?.role === 'Phó Giám đốc' || myId === 'director';
  const myName = state.isLocal ? 'giám đốc' : String(state.viewer?.name || '').toLowerCase();
  const myRole = state.isLocal ? 'giám đốc' : String(state.viewer?.role || '').toLowerCase();
  for (const part of mask(cleanText).split(re)) {
    if (part?.startsWith('@')) {
      const pLow = part.slice(1).trim().toLowerCase();
      const isMeAt = (myName && pLow === myName) || (myRole && pLow === myRole) || (isDirectorOrDeputy && (pLow === 'giám đốc' || pLow === 'phó giám đốc' || pLow === 'sếp'));
      t.append(el('span', `zc-at${isMeAt ? ' is-me' : ''}`, part));
    } else if (part) {
      t.append(part);
    }
  }
  if (photos.length) {
    const mixed = el('div', 'zc-msg-mixed');
    mixed.append(buildPhotoGrid(m, photos, false), t);
    return mixed;
  }
  return t;
}
// one to three emoji and nothing else (a 👍 sent with the button, say): shown big, without a bubble
const EMO_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
const bigEmoji = (t) => !!t && t.length <= 24 && EMO_ONLY.test(t.trim());
function row(m, prev, nextM) {
  if (m.kind === 'sys') return el('div', 'zc-sys', m.text);
  if (m.kind === 'poll' || m.kind === 'remind') { const r = el('div', 'zc-row zc-row--card is-first'); r.dataset.id = m.id; r.append(m.kind === 'poll' ? pollCard(m) : remindCard(m)); return r; }
  const myId = myViewerId();
  const sameSender = (a, b) => a && b && a.from === b.from && (a.whoId || '') === (b.whoId || '') && (a.whoName || '') === (b.whoName || '');
  const run = (a, b) => sameSender(a, b) && a.kind !== 'sys' && a.kind !== 'poll' && a.kind !== 'remind' && Math.abs(b.at - a.at) <= RUN_MS;
  const mine = m.whoId ? m.whoId === myId : m.from === 'me';
  const first = !run(prev, m), last = !run(m, nextM);
  const mentionMe = isMentioningMe(m);
  const r = el('div', `zc-row${mine ? ' is-mine' : ''}${first ? ' is-first' : ''}${last ? ' is-last' : ''}${mentionMe ? ' is-mention-me' : ''}`); r.dataset.id = m.id;
  const parsed = parseLegacySender(m);
  if (!mine) {
    const slot = el('span', 'zc-av-slot');
    if (first) {
      const displaySender = parsed.whoName || m.name;
      slot.append(avatar(faceOf(m.from === 'me' ? (m.whoId || 'director') : m.from, displaySender), 32));
    }
    r.append(slot);
  }
  const hasPhotosOnly = msgPhotos(m).length > 0 && !parsed.cleanText.trim();
  const bare = !m.recalled && (m.kind === 'sticker' || m.kind === 'photo' || hasPhotosOnly || (m.kind === 'text' && bigEmoji(parsed.cleanText)));
  const bub = el('div', `zc-bub${bare ? ' is-bare' : ''}${mentionMe ? ' is-mention-me' : ''}`);
  if (first && !bare) {
    if (m.role === 'boss' || m.from === 'me') {
      const senderName = parsed.whoName || (mine ? (state.isLocal ? 'Giám đốc' : state.viewer?.name || tr('chat.you')) : tr('chat.boss'));
      const senderRole = parsed.whoRole || (mine ? (state.isLocal ? 'Giám đốc' : state.viewer?.role || '') : '');
      const n = el('span', 'zc-name', senderName);
      if (senderRole) n.append(el('i', 'zc-role-badge', senderRole));
      bub.append(n);
    } else if (!mine) {
      const n = el('span', 'zc-name', m.name);
      if (m.tag === 'claude') n.append(el('i', 'zc-claude', tr('chat.claudeTag')));
      bub.append(n);
    }
  }
  if (m.reply && !m.recalled) bub.append(quote(m.reply));
  bub.append(content(m));
  if (last && !bare) bub.append(el('span', 'zc-time', fmtTime(m.at)));
  if (!m.recalled) {
    const rx = reactPill(m); if (rx) bub.append(rx);
    else if (!mine && !bare) { const heart = el('button', 'zc-like'); heart.type = 'button'; heart.title = tr('chat.react'); heart.append(el('i', null, '♡')); heart.addEventListener('click', (ev) => { ev.stopPropagation(); react(m, '❤️'); }); bub.append(heart); }
    bub.append(tools(m, mine));
    bub.addEventListener('click', () => { for (const x of body.querySelectorAll('.zc-bub.is-tools')) if (x !== bub) x.classList.remove('is-tools'); bub.classList.toggle('is-tools'); });   // (touch: tap for the tools)
  }
  r.append(bub);
  return r;
}

/* ---------- drawing ---------- */
const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
function drawTabs() {
  if (!tabsEl) return;
  const ch = chat.channel || 'work';
  root?.setAttribute('data-channel', ch);
  if (tabWorkBtn) {
    const on = ch === 'work';
    tabWorkBtn.classList.toggle('is-on', on);
    tabWorkBtn.setAttribute('aria-selected', String(on));
  }
  if (tabCasualBtn) {
    const on = ch === 'casual';
    tabCasualBtn.classList.toggle('is-on', on);
    tabCasualBtn.setAttribute('aria-selected', String(on));
  }
  if (tabWorkBadge) {
    const nw = state.chatNotify === 'off' ? 0 : (chat.unreadWork || 0);
    tabWorkBadge.hidden = !nw || ch === 'work';
    tabWorkBadge.textContent = nw > 9 ? '9+' : String(nw);
  }
  if (tabCasualBadge) {
    const nc = state.chatNotify === 'off' ? 0 : (chat.unreadCasual || 0);
    tabCasualBadge.hidden = !nc || ch === 'casual';
    tabCasualBadge.textContent = nc > 9 ? '9+' : String(nc);
  }
  if (channelSubEl) {
    channelSubEl.textContent = tr(ch === 'casual' ? 'chat.tabs.casualSub' : 'chat.tabs.workSub');
  }
  if (toEl) {
    toEl.hidden = DEMO_CHAT || ch === 'casual';
  }
  if (pickEl && ch === 'casual') {
    pickEl.hidden = true;
  }
}
function switchChannel(ch) {
  const next = ch === 'casual' ? 'casual' : 'work';
  if (chat.channel === next) return;
  msgLimit = 100;
  setReply(null);
  setChatChannel(next);
  drawTabs();
  drawTarget();
  redraw();
  drawTyping();
  body.scrollTop = body.scrollHeight;
}
function redraw() {
  if (!root) return;
  drawTabs();
  const allList = chat.msgs.filter(inCurrentChannel);
  const list = allList.length > msgLimit ? allList.slice(-msgLimit) : allList;
  const frag = document.createDocumentFragment();
  frag.append(el('div', 'zc-push'));   // (pushes a short conversation down to the input, like the app)
  if (allList.length > msgLimit) {
    const hiddenCount = allList.length - msgLimit;
    const moreBtn = el('button', 'zc-day zc-load-more', `⬆️ Xem thêm ${Math.min(100, hiddenCount)} tin nhắn cũ`);
    moreBtn.type = 'button';
    moreBtn.addEventListener('click', () => {
      const prevHeight = body.scrollHeight;
      msgLimit += 100;
      redraw();
      body.scrollTop = Math.max(0, body.scrollHeight - prevHeight);
    });
    frag.append(moreBtn);
  }
  let newDone = false;
  for (let i = 0; i < list.length; i++) {
    if (i === 0 || list[i].at - list[i - 1].at > GAP_MS || new Date(list[i].at).toDateString() !== new Date(list[i - 1].at).toDateString()) frag.append(el('div', 'zc-day', timeLabel(list[i].at)));
    // where you stopped reading: "Tin nhắn mới"
    if (!newDone && readTo && i > 0 && list[i - 1].id === readTo && list.slice(i).some((m) => m.kind !== 'sys' && m.from !== 'me')) { newDone = true; const line = el('div', 'zc-newline'); line.append(el('span', null, tr('chat.newLine'))); frag.append(line); }
    frag.append(row(list[i], list[i - 1], list[i + 1]));
  }
  // the latest message of others keeps its ♡ in view (the way the app shows it on the newest bubble)
  const rows = frag.querySelectorAll('.zc-row:not(.is-mine) .zc-like'); rows[rows.length - 1]?.classList.add('is-on');
  // under your last message: the faces of those who have seen it (the people in the office), or "Đã nhận"
  const lastMsg = [...list].reverse().find((m) => m.kind !== 'sys');
  if (lastMsg?.from === 'me') {
    const seen = el('div', 'zc-seen'), ppl = people(), st = el('span', 'zc-seen-st');
    st.append(icon('checks'), document.createTextNode(tr(ppl.length ? 'chat.seen' : 'chat.received')));
    seen.append(st);
    if (ppl.length) { for (const id of ppl.slice(0, 4)) seen.append(avatar(who(id), 16)); if (ppl.length > 4) seen.append(el('span', 'zc-seen-n', `+${ppl.length - 4}`)); }
    frag.append(seen);
  }
  body.replaceChildren(frag);
  drawPin(); drawHead(); drawTyping();
}
export const renderMessages = redraw;
// a new message at the end: added on its own (redrawing every row would take a bubble out from under the pointer);
// the one before may lose its time and its ♡, the "seen" line moves under it
function appendOne(m) {
  drawTabs();
  if (!inCurrentChannel(m)) { drawHead(); return; }
  const list = chat.msgs.filter(inCurrentChannel), i = list.indexOf(m), prev = list[i - 1];
  if (i < 0 || i !== list.length - 1 || !prev || (prev.kind !== 'sys' && !body.querySelector(`.zc-row[data-id="${CSS.escape(prev.id)}"]`))) { redraw(); return; }
  body.querySelector('.zc-seen')?.remove();
  if (m.at - prev.at > GAP_MS || new Date(m.at).toDateString() !== new Date(prev.at).toDateString()) body.append(el('div', 'zc-day', timeLabel(m.at)));
  if (prev.kind !== 'sys') redrawOne(prev);
  body.append(row(m, prev, undefined));
  if (m.from !== 'me' && m.kind !== 'sys') { for (const x of body.querySelectorAll('.zc-like.is-on')) x.classList.remove('is-on'); const likes = body.querySelectorAll('.zc-row:not(.is-mine) .zc-like'); likes[likes.length - 1]?.classList.add('is-on'); }
  if (m.from === 'me') { const seen = el('div', 'zc-seen'), ppl = people(), st = el('span', 'zc-seen-st'); st.append(icon('checks'), document.createTextNode(tr(ppl.length ? 'chat.seen' : 'chat.received'))); seen.append(st); for (const id of ppl.slice(0, 4)) seen.append(avatar(who(id), 16)); body.append(seen); }
  drawPin(); drawHead();
}
function redrawOne(m) {
  const old = body?.querySelector(`.zc-row[data-id="${CSS.escape(m.id)}"]`); if (!old) return;
  const list = chat.msgs.filter(inCurrentChannel);
  const i = list.findIndex((x) => x.id === m.id);
  if (i < 0) return;
  old.replaceWith(row(list[i] || m, list[i - 1], list[i + 1]));
}
function flash(id) { const r = body.querySelector(`.zc-row[data-id="${CSS.escape(id || '')}"]`); r?.scrollIntoView({ block: 'center', behavior: 'smooth' }); r?.classList.add('is-flash'); setTimeout(() => r?.classList.remove('is-flash'), 1400); }
function drawHead() {
  const ppl = people();
  const isCasual = chat.channel === 'casual';
  const subTxt = tr(isCasual ? 'chat.tabs.casualSub' : 'chat.tabs.workSub');
  headSub.textContent = `${tr('chat.members', { n: ppl.length + (isCasual ? 9 : 1) })} · ${subTxt}`;
  const headKey = `${chat.channel || 'work'}|${ppl.join(',')}|${state.isLocal}|${state.viewer?.name || ''}`;
  if (headKey !== lastHeadKey) {
    lastHeadKey = headKey;
    headAv.replaceChildren(groupAvatar(46));
  }
}
function drawPin() {
  const m = chat.pinned && byId(chat.pinned);
  const visibleInCh = m && !m.recalled && channelOf(m) === (chat.channel || 'work');
  pinEl.hidden = !visibleInCh;
  if (visibleInCh) {
    pinEl.querySelector('.zc-pin-t').textContent = m.kind === 'poll' ? `📊 ${m.poll.q}` : m.kind === 'remind' ? `⏰ ${m.remind.title}` : m.kind === 'perm' ? `🛡️ ${m.perm?.label || mask(m.text)}` : `${m.name}: ${mask(m.text)}`;
  }
}
export const renderPin = drawPin;
function drawTyping() {
  if (!typingEl) return;
  const curCh = chat.channel || 'work';
  const names = [...new Set((chat.typing || [])
    .filter((x) => (typeof x === 'string' ? curCh === 'work' : (x?.channel || 'work') === curCh))
    .map((x) => (typeof x === 'string' ? x : x?.name))
    .filter(Boolean))];
  typingEl.hidden = !names.length;
  if (names.length) typingEl.querySelector('span').textContent = tr('chat.typing', { name: names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0] });
}
function badge() {
  const b = $('chat-badge'); if (!b) return;
  const n = state.chatNotify === 'off' ? 0 : chat.unread;
  b.hidden = !n;
  b.textContent = n > 5 ? '5+' : String(n);
}
// the group's picture: four of its faces in a square, the last a count of the rest when there are more
function groupAvatar(size = 40) {
  const box = el('span', 'zc-gav'), ids = people(), t = Math.round(size / 2) - 1;
  box.style.width = box.style.height = `${size}px`;
  const faces = [meP(), ...ids.map((id) => who(id))];
  for (const p of faces.slice(0, faces.length > 4 ? 3 : 4)) box.append(avatar(p, t));
  if (faces.length > 4) { const n = el('span', 'zc-gav-n', String(Math.min(99, faces.length - 3))); n.style.width = n.style.height = `${t}px`; box.append(n); }
  return box;
}
// a small card by the button for a new message while the window is shut (like a conversation in the app's list)
let peekTimer = 0;
function peek(m) {
  if (chat.open || !shouldNotifyForMsg(m) || photoOn()) return;
  let p = $('zc-peek'); if (!p) { p = el('button', 'zc-peek'); p.id = 'zc-peek'; p.type = 'button'; p.addEventListener('click', () => toggle(true)); document.body.append(p); }
  const txt = m.kind === 'text' ? mask(m.text) : m.kind === 'perm' ? `🛡️ ${m.perm?.label || mask(m.text)}` : m.kind === 'poll' ? `📊 ${m.poll.q}` : m.kind === 'remind' ? `⏰ ${m.remind.title}` : m.kind === 'photo' ? tr('chat.photo') : tr('chat.sticker');
  const box = el('span', 'zc-peek-t'); box.append(el('b', null, tr('chat.group')), el('span', null, `${m.name}: ${txt}`));
  p.replaceChildren(groupAvatar(44), box);
  p.hidden = false; p.classList.remove('is-out'); clearTimeout(peekTimer);
  peekTimer = setTimeout(() => { p.classList.add('is-out'); setTimeout(() => { p.hidden = true; }, 300); }, 4200);
}
onChat((what, m) => {
  badge();
  if (what === 'badge') return;
  if (what === 'add') peek(m);
  if (!root || root.hidden) return;
  drawTabs();
  if (what === 'typing') { drawTyping(); return; }
  if (what === 'update') { redrawOne(m); drawPin(); return; }
  const stick = atBottom() || m?.from === 'me';
  if (what === 'add') appendOne(m); else redraw();
  if (what === 'add' && !inCurrentChannel(m)) return;
  if (stick) body.scrollTop = body.scrollHeight;
  else if (what === 'add' && m.kind !== 'sys') { const n = (Number(newBtn.dataset.n) || 0) + 1; newBtn.dataset.n = String(n); newBtn.textContent = tr('chat.newMsgs', { n }); newBtn.hidden = false; }
});

/* ---------- the input: text, a reply, @ someone, stickers and emoji, a poll, a photo; send once something is typed ---------- */
function syncBar() {
  const hasContent = !!input.value.trim() || chatPhotos.length > 0;
  bar.classList.toggle('has-text', hasContent);
  root.classList.toggle('has-text', hasContent);
}
function drawChatThumbs() {
  if (!chatThumbsEl) return;
  chatThumbsEl.hidden = !chatPhotos.length;
  if (!chatPhotos.length) { chatThumbsEl.replaceChildren(); return; }
  const label = el('span', 'zc-ct-label', `🖼️ Ảnh đính kèm (${chatPhotos.length}/${MAX_TASK_IMAGES})${target ? ` · Gửi cho ${target.name}` : ' · Chọn người nhận hoặc bấm Giao việc'}`);
  const rowEl = el('div', 'zc-ct-row');
  chatPhotos.forEach((u, idx) => {
    const item = el('span', 'zc-task-thumb'), img = el('img'), x = el('button', null, '✕');
    img.src = u; x.type = 'button';
    x.addEventListener('click', () => { chatPhotos.splice(idx, 1); drawChatThumbs(); syncBar(); });
    item.append(img, x);
    rowEl.append(item);
  });
  if (!target) {
    const taskBtn = el('button', 'zc-ct-task', '📋 Giao việc kèm ảnh');
    taskBtn.type = 'button';
    taskBtn.addEventListener('click', () => {
      const imgs = chatPhotos.splice(0);
      const txt = input.value.trim();
      input.value = '';
      drawChatThumbs();
      syncBar();
      openTaskSheet(root, { text: txt, images: imgs });
    });
    rowEl.append(taskBtn);
  }
  chatThumbsEl.replaceChildren(label, rowEl);
}
async function addChatImageFiles(fileList) {
  const imgs = [...(fileList || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
  if (!imgs.length) return;
  const slots = MAX_TASK_IMAGES - chatPhotos.length;
  if (slots <= 0) {
    toast(`Đã đạt giới hạn tối đa ${MAX_TASK_IMAGES} ảnh đính kèm cho Antigravity.`, 3500);
    return;
  }
  for (const f of imgs.slice(0, slots)) {
    try { chatPhotos.push(await shrink(f)); } catch { /* ignore unreadable */ }
  }
  if (imgs.length > slots) toast(`Chỉ gửi tối đa ${MAX_TASK_IMAGES} ảnh (đã thêm ${slots} ảnh).`, 3500);
  drawChatThumbs();
  syncBar();
}
function setReply(m) {
  replyTo = m;
  const s = m?.tag === 'claude' && sessions.get(m.from);   // (an answer from Claude: what you write back goes to it)
  if (s?.sid) setTarget({ id: s.id, sid: s.sid, name: dn(s), folder: folderOf(s) });
  replyEl.hidden = !m;
  if (m) {
    const t = m.kind === 'text' || m.kind === 'perm' ? mask(m.text) : m.kind === 'poll' ? `📊 ${m.poll.q}` : m.kind === 'photo' ? tr('chat.photo') : tr('chat.sticker');
    replyEl.querySelector('b').textContent = tr('chat.replyTo', { name: m.from === 'me' ? tr('chat.you') : m.name });
    replyEl.querySelector('.zc-reply-t').textContent = t;
    input.focus();
  }
}
function send() {
  const v = input.value; input.value = ''; mentionEl.hidden = true; input.style.height = '';
  const imgs = chatPhotos.splice(0);
  drawChatThumbs();
  syncBar();

  // Collect human @mentions from menu selections and text matching
  const humanParticipants = getHumanParticipants();
  const activeMentions = new Set(mentionedHumans);
  mentionedHumans = [];
  if (v.trim()) {
    const vLow = v.toLowerCase();
    for (const h of humanParticipants) {
      if ((h.name && vLow.includes(`@${h.name.toLowerCase()}`)) || (h.role && vLow.includes(`@${h.role.toLowerCase()}`))) {
        activeMentions.add(h.id);
      }
    }
  }
  const mentionList = [...activeMentions];

  if (target && chat.channel !== 'casual' && !mentionList.length && (v.trim() || imgs.length)) {
    sendTo(v.trim() || 'Hãy phân tích hình ảnh đính kèm và xử lý yêu cầu.', imgs);
    setReply(null);
    return;
  }
  const tagged = v.trim() && !mentionList.length && [...sessions.values()].filter(canSeeSession).sort((a, b) => dn(b).length - dn(a).length).find((s) => v.includes(`@${dn(s)}`));
  if (imgs.length && tagged && chat.channel !== 'casual') {
    openTaskSheet(root, { to: { id: tagged.id }, text: v.replace(`@${dn(tagged)}`, '').trim(), images: imgs });
    setReply(null);
    return;
  }
  if (imgs.length) {
    for (const imgData of imgs) chatSendPhotoData(imgData, { channel: chat.channel });
  }
  if (v.trim()) {
    chatSend(v, {
      channel: chat.channel,
      replyTo: replyTo?.id,
      mentions: mentionList,
      humanOnly: mentionList.length > 0,
    });
  }
  setReply(null);
  // @ a conversation: give it this as work? (one tap opens the sheet with it filled in: its folder, photos, send)
  if (tagged && chat.channel !== 'casual') setTimeout(() => {
    const ask = el('div', 'zc-ask'), yes = el('button', 'zc-ask-yes', tr('chat.task.askYes')), no = el('button', 'zc-ask-no', tr('chat.task.askNo'));
    yes.type = no.type = 'button';
    yes.addEventListener('click', () => { ask.remove(); openTaskSheet(root, { to: { id: tagged.id }, text: v.replace(`@${dn(tagged)}`, '').trim() }); });
    no.addEventListener('click', () => ask.remove());
    ask.append(el('span', null, tr('chat.task.ask', { name: dn(tagged), folder: folderOf(tagged) })), no, yes);
    body.append(ask); body.scrollTop = body.scrollHeight;
  }, 300);
}
/* ---------- who gets what you write: the whole group (people chatting), or one conversation, Claude for real (it goes to
   that conversation as work on its own branch, and the answer comes back here from its person: server, POST /api/tasks
   { chat }); chosen above the input, or by replying to one of Claude's answers ---------- */
const DEMO_CHAT = STATIC || new URLSearchParams(location.search).has('demo');
const tq = () => (TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : '');
let target = null;   // { id, sid, name, folder }, or null: the whole group
try { target = DEMO_CHAT ? null : JSON.parse(sessionStorage.getItem('office-chat-to') || 'null'); } catch { /* storage blocked */ }
function setTarget(t) {
  target = t; try { sessionStorage.setItem('office-chat-to', JSON.stringify(t)); } catch { /* storage blocked */ }
  if (pickEl) pickEl.hidden = true;
  drawTarget();
  drawChatThumbs();
}
function drawTarget() {
  if (!toEl) return;
  const chip = el('button', `zc-to-chip${target ? ' is-on' : ''}`); chip.type = 'button'; chip.title = tr('chat.to.pick');
  chip.append(el('small', null, tr('chat.to.label')));
  if (target) chip.append(avatar(faceOf(target.id, target.name), 20), el('b', null, target.name)); else chip.append(el('b', null, `💬 ${tr('chat.to.group')}`));
  chip.append(el('i', 'zc-to-caret', '▾'));
  chip.addEventListener('click', openPick);
  toEl.replaceChildren(chip);
  if (target) {
    const x = el('button', 'zc-ib zc-to-x'); x.type = 'button'; x.title = tr('chat.to.clear'); x.append(icon('x')); x.addEventListener('click', () => setTarget(null));
    toEl.append(el('small', 'zc-to-sub', tr('chat.to.sub', { folder: target.folder })), x);
  }
  const isCasual = chat.channel === 'casual';
  toEl.hidden = DEMO_CHAT || isCasual;
  input.placeholder = !isCasual && target
    ? `${tr('chat.to.placeholder', { name: target.name })} (Ctrl+V dán tối đa ${MAX_TASK_IMAGES} ảnh)`
    : tr(isCasual ? 'chat.tabs.casualPlaceholder' : 'chat.tabs.workPlaceholder');
  root.classList.toggle('is-to', !isCasual && !!target);
}
// the list: the group, then each conversation open now (its folder, what it's doing)
async function openPick() {
  if (!pickEl.hidden) { pickEl.hidden = true; return; }
  mentionEl.hidden = moreEl.hidden = stickersEl.hidden = true;
  pickEl.replaceChildren(el('small', 'zc-to-h', tr('chat.to.pick'))); pickEl.hidden = false;
  const r = await fetch(`/api/tasks${tq()}`).then((x) => x.json()).catch(() => null);
  const opt = (face, title, sub, on, pick, off) => {
    const b = el('button', `zc-to-o${on ? ' is-sel' : ''}`); b.type = 'button'; b.disabled = !!off;
    const t = el('span', 'zc-men-t'); t.append(el('b', null, title), el('small', null, sub)); b.append(face, t);
    b.addEventListener('click', pick); return b;
  };
  const items = [opt(el('span', 'zc-to-group', '💬'), tr('chat.to.group'), tr('chat.to.groupSub'), !target, () => setTarget(null))];
  if (r?.ok && !r.allowed) items.push(el('p', 'zc-to-note', tr('chat.to.notAllowed')));
  items.push(el('small', 'zc-to-h', tr('chat.to.sessions')));
  const list = (r?.sessions || []).filter((s) => !s.masked && !sessions.get(s.id)?.masked);
  if (!list.length) items.push(el('p', 'zc-to-note', r ? tr('chat.to.none') : tr('drawer.unreachable')));
  for (const s of list) {
    const folder = s.dir.split('/').slice(-2).join('/'), st = tr(s.status === 'rest' ? 'chat.memberRest' : s.status === 'wait' ? 'chat.memberWait' : 'chat.memberWork');
    const o = opt(avatar(faceOf(s.id, s.name), 30), s.name, `📁 ${folder} · ${st}`, target?.sid === s.sid, () => { setTarget({ id: s.id, sid: s.sid, name: s.name, folder }); input.focus(); }, r && !r.allowed);
    o.dataset.sid = s.sid; items.push(o);
  }
  pickEl.replaceChildren(...items);
}
async function sendTo(text, images = []) {
  const r = await fetch(`/api/tasks${tq()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: target.sid, text, images, chat: true }) }).then((x) => x.json()).catch(() => null);
  if (r?.ok) {
    sfx?.play('task');
    if (r.pendingApproval) toast(r.message || '⏳ Đã gửi yêu cầu công việc tới Giám đốc để phê duyệt!', 5500);
    return;
  }
  toast(r?.code === 'notAllowed' ? tr('chat.to.notAllowed') : r?.message || tr('drawer.unreachable'), 7000);
  if (!input.value) { input.value = text; syncBar(); }   // (nothing lost: back in the input)
}
// a session's project folder, short (its last two parts), and what it's doing now
const folderOf = (s) => { const d = String(s?.dir || '').replace(/\/+$/, ''); return d.split('/').slice(-2).join('/') || d; };
const statusOf = (s) => tr(s.status === 'rest' ? 'chat.memberRest' : s.status === 'wait' ? 'chat.memberWait' : 'chat.memberWork');
// @: human participants first (👤), then visible AI conversations, newest first, with folder and status
function openAt(customQ = null) {
  let q = customQ;
  if (q === null) {
    const m = /@([^\s@]*)$/.exec(input.value.slice(0, input.selectionStart));
    if (!m) { mentionEl.hidden = true; return; }
    q = m[1].toLowerCase();
  } else {
    q = String(q || '').toLowerCase();
  }
  const humans = getHumanParticipants().filter((h) => `${h.name} ${h.role || ''}`.toLowerCase().includes(q));
  const list = [...sessions.values()].filter((s) => canSeeSession(s) && `${dn(s)} ${s.dir || ''}`.toLowerCase().includes(q)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, 8);
  if (!humans.length && !list.length) {
    mentionEl.replaceChildren(el('small', 'zc-men-empty', tr('chat.noSessions')));
    mentionEl.hidden = false;
    return;
  }
  const rows = [];
  if (humans.length) {
    rows.push(el('small', 'zc-to-h', '👤 Người đang truy cập (Nhắn trực tiếp)'));
    for (const h of humans) {
      const row = el('div', 'zc-men-row'), b = el('button', 'zc-men-o'); b.type = 'button';
      const badge = el('span', 'zc-to-group', '👤');
      const t = el('span', 'zc-men-t');
      t.append(el('b', null, `@${h.name}`), el('small', null, `👔 ${h.role || 'Thành viên'} · Nhắn thông báo trực tiếp`));
      b.append(badge, t);
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        if (!mentionedHumans.includes(h.id)) mentionedHumans.push(h.id);
        const pos = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, pos).replace(/@[^\s@]*$/, `@${h.name} `);
        input.value = before + input.value.slice(pos);
        input.setSelectionRange(before.length, before.length);
        mentionEl.hidden = true;
        syncBar();
        input.focus();
      });
      row.append(b);
      rows.push(row);
    }
  }
  if (list.length) {
    if (humans.length) rows.push(el('small', 'zc-to-h', '🤖 Phiên làm việc Antigravity'));
    for (const s of list) {
      const row = el('div', 'zc-men-row'), b = el('button', 'zc-men-o'); b.type = 'button';
      const t = el('span', 'zc-men-t'); t.append(el('b', null, dn(s)), el('small', null, `📁 ${folderOf(s)} · ${statusOf(s)}`));
      b.append(avatar(faceOf(s.id, dn(s)), 30), t);
      b.addEventListener('pointerdown', (e) => e.preventDefault());   // (the input keeps the keyboard up)
      b.addEventListener('click', () => { const pos = input.selectionStart, before = input.value.slice(0, pos).replace(/@[^\s@]*$/, `@${dn(s)} `); input.value = before + input.value.slice(pos); input.setSelectionRange(before.length, before.length); mentionEl.hidden = true; syncBar(); input.focus(); });
      const task = el('button', 'zc-men-task'); task.type = 'button'; task.title = tr('chat.task.title'); task.append(icon('clipboard'));
      task.addEventListener('pointerdown', (e) => e.preventDefault());
      task.addEventListener('click', () => { mentionEl.hidden = true; const imgs = chatPhotos.splice(0); drawChatThumbs(); syncBar(); openTaskSheet(root, { to: { id: s.id }, text: input.value.replace(/@[^\s@]*$/, '').trim(), images: imgs }); });
      row.append(b, task);
      if (s.link) { const go = el('a', 'zc-men-go', tr('chat.giveWork')); go.href = s.link; go.target = '_blank'; go.rel = 'noopener'; row.append(go); }
      rows.push(row);
    }
  }
  mentionEl.replaceChildren(...rows);
  mentionEl.hidden = false;
}
const mentions = () => openAt(null);
// the panel under the input: stickers (sent at once) or emoji (into the text), the way the app has both behind 😊
function drawStickers() {
  const tabs = el('div', 'zc-stk-tabs');
  for (const [k, label] of [['sticker', 'chat.stickerTab'], ['emoji', 'chat.emojiTab']]) {
    const b = el('button', `zc-stk-tab${stickTab === k ? ' is-on' : ''}`, tr(label)); b.type = 'button'; b.addEventListener('click', () => { stickTab = k; drawStickers(); }); tabs.append(b);
  }
  const grid = el('div', stickTab === 'sticker' ? 'zc-stk-grid' : 'zc-emo-grid');
  if (stickTab === 'sticker') grid.append(...tr('chat.stickers', null, 'list').map((cap, i) => {
    const b = el('button', 'zc-stk'); b.type = 'button'; b.title = cap; const img = el('img'); img.src = stickerUrl(i); img.alt = cap; b.append(img);
    b.addEventListener('click', () => { stickersEl.hidden = true; chatSend('', { sticker: i, replyTo: replyTo?.id }); setReply(null); });
    return b;
  }));
  else grid.append(...EMOJI.map((e) => { const b = el('button', 'zc-emo', e); b.type = 'button'; b.addEventListener('click', () => { input.setRangeText(e, input.selectionStart, input.selectionEnd, 'end'); syncBar(); input.focus(); }); return b; }));
  stickersEl.replaceChildren(tabs, grid);
}
// ••• : a poll of your own (a question and up to four choices), or @ someone
function drawMore() {
  const form = el('form', 'zc-more-poll'), q = el('input', 'zc-more-in'); q.placeholder = tr('chat.pollAsk'); q.maxLength = 120; q.required = true;
  const opts = [0, 1, 2, 3].map((i) => { const o = el('input', 'zc-more-in'); o.placeholder = `${i + 1}.`; o.maxLength = 60; o.required = i < 2; return o; });
  const go = el('button', 'zc-card-btn', tr('chat.newPoll')); go.type = 'submit';
  form.append(el('b', null, `📊 ${tr('chat.newPoll')}`), q, ...opts, go);
  form.addEventListener('submit', (e) => { e.preventDefault(); const list = opts.map((o) => o.value.trim()).filter(Boolean); if (!q.value.trim() || list.length < 2) return; moreEl.hidden = true; chatPoll(q.value.trim(), list); });
  for (const inp of [q, ...opts]) inp.addEventListener('keydown', (e) => e.stopPropagation());
  const at = el('button', 'zc-more-o'); at.type = 'button'; at.append(icon('at'), el('span', null, tr('chat.mention')));
  at.addEventListener('click', () => { moreEl.hidden = true; input.focus(); input.setRangeText(input.value && !/\s$/.test(input.value) ? ' @' : '@', input.selectionStart, input.selectionEnd, 'end'); mentions(); });
  const task = el('button', 'zc-more-o'); task.type = 'button'; task.append(icon('clipboard'), el('span', null, tr('chat.task.title')));
  task.addEventListener('click', () => { moreEl.hidden = true; if (chat.channel === 'casual') switchChannel('work'); const imgs = chatPhotos.splice(0); drawChatThumbs(); syncBar(); openTaskSheet(root, { text: input.value.trim(), images: imgs }); });
  moreEl.replaceChildren(task, at, form);
}
function drawMembers() {
  const rows = [];
  const add = (p, note, link) => {
    const r = el('div', 'zc-mem'), t = el('span', 'zc-mem-t'); t.textContent = p.name; r.append(avatar(p, 40), t, el('small', null, note));
    // a session with Remote Control: give it work in the Claude app (the real way to prompt it from here)
    if (link) { const a = el('a', 'zc-mem-go', tr('chat.giveWork')); a.href = link; a.target = '_blank'; a.rel = 'noopener'; r.append(a); }
    rows.push(r);
  };
  add({ ...meP(), name: `${tr('chat.boss')} (${tr('chat.you')})` }, tr('chat.memberYou'));
  for (const s of [...sessions.values()].filter(canSeeSession).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))) add(faceOf(s.id, dn(s)), `${statusOf(s)} · 📁 ${folderOf(s)}`, s.link);
  if (chat.channel === 'casual') {
    for (const k of ['dept1', 'dept2', 'dept3', 'dept4', 'reception', 'hr', 'accountant', 'guard', 'cleaner']) { const p = who(k); if (p) add(p, tr('chat.memberStaff')); }
  }
  membersEl.replaceChildren(el('b', 'zc-mem-h', `${tr('chat.membersTitle')} (${rows.length})`), ...rows, el('p', 'zc-mem-note', tr('chat.note')));
}
const ib = (name, title, fn, cls = '') => { const b = el('button', `zc-ib ${cls}`); b.type = 'button'; b.title = title; b.append(icon(name)); if (fn) b.addEventListener('click', fn); else { b.disabled = true; b.classList.add('is-deco'); } return b; };
const only = (box) => { for (const x of [stickersEl, moreEl]) if (x !== box) x.hidden = true; };
const openStickers = (tab) => { only(stickersEl); if (!stickersEl.hidden && stickTab === tab) { stickersEl.hidden = true; return; } stickTab = tab; stickersEl.hidden = false; drawStickers(); };
const openMore = () => { only(moreEl); moreEl.hidden = !moreEl.hidden; if (!moreEl.hidden) drawMore(); };

function build() {
  root = el('section', 'zc'); root.id = 'zchat'; root.hidden = true; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', tr('chat.group'));
  // the bar: on a computer white, the group's picture, its name and members, then search, call, video, the info panel
  // and a close; on a phone the blue one, with back, call, video and ☰ (group-chat.css swaps them)
  const head = el('header', 'zc-head');
  headSub = el('small', 'zc-sub'); headAv = el('span', 'zc-head-av zc-pc');
  const title = el('div', 'zc-title'), sub = el('span', 'zc-subline'); sub.append(icon('users'), headSub);
  title.append(el('b', null, tr('chat.group')), sub);
  const members = () => { membersEl.hidden = !membersEl.hidden; if (!membersEl.hidden) drawMembers(); };
  head.append(ib('back', tr('chat.close'), () => toggle(false), 'zc-back zc-mo'), headAv, title,
    ib('search', '', null, 'zc-pc'), ib('call', ''), ib('video', ''), ib('panel', tr('chat.membersTitle'), members, 'zc-pc'), ib('menu', tr('chat.membersTitle'), members, 'zc-mo'), ib('x', tr('chat.close'), () => toggle(false), 'zc-pc zc-close'));
  // 2-channel tabs bar: Work Group (`work`) vs Watercooler Chat (`casual`)
  tabsEl = el('div', 'zc-tabs'); tabsEl.setAttribute('role', 'tablist');
  const tabRow = el('div', 'zc-tabs-row');
  tabWorkBtn = el('button', 'zc-tab is-on'); tabWorkBtn.id = 'zc-tab-work'; tabWorkBtn.type = 'button'; tabWorkBtn.dataset.ch = 'work'; tabWorkBtn.setAttribute('role', 'tab'); tabWorkBtn.setAttribute('aria-selected', 'true');
  tabWorkBadge = el('i', 'zc-tab-badge'); tabWorkBadge.id = 'zc-badge-work'; tabWorkBadge.hidden = true;
  tabWorkBtn.append(el('span', null, tr('chat.tabs.work')), tabWorkBadge);
  tabWorkBtn.addEventListener('click', () => switchChannel('work'));

  tabCasualBtn = el('button', 'zc-tab'); tabCasualBtn.id = 'zc-tab-casual'; tabCasualBtn.type = 'button'; tabCasualBtn.dataset.ch = 'casual'; tabCasualBtn.setAttribute('role', 'tab'); tabCasualBtn.setAttribute('aria-selected', 'false');
  tabCasualBadge = el('i', 'zc-tab-badge'); tabCasualBadge.id = 'zc-badge-casual'; tabCasualBadge.hidden = true;
  tabCasualBtn.append(el('span', null, tr('chat.tabs.casual')), tabCasualBadge);
  tabCasualBtn.addEventListener('click', () => switchChannel('casual'));

  tabRow.append(tabWorkBtn, tabCasualBtn);
  channelSubEl = el('small', 'zc-tabs-sub', tr('chat.tabs.workSub'));
  tabsEl.append(tabRow, channelSubEl);

  pinEl = el('div', 'zc-pin'); pinEl.hidden = true;
  const pinText = el('span', 'zc-pin-x'); pinText.append(el('b', null, tr('chat.pinned')), el('span', 'zc-pin-t'));
  const pinIc = el('span', 'zc-pin-ic'); pinIc.append(icon('pinbar'));
  const unpinBtn = el('button', 'zc-ib zc-pin-unpin', '✕'); unpinBtn.type = 'button'; unpinBtn.title = 'Bỏ ghim';
  unpinBtn.addEventListener('click', (ev) => { ev.stopPropagation(); if (chat.pinned) chatPin(chat.pinned); });
  pinEl.append(pinIc, pinText, unpinBtn);
  pinEl.addEventListener('click', () => flash(chat.pinned));
  body = el('div', 'zc-body');
  body.addEventListener('scroll', () => { if (atBottom()) { newBtn.hidden = true; newBtn.dataset.n = '0'; } }, { passive: true });
  newBtn = el('button', 'zc-new'); newBtn.type = 'button'; newBtn.hidden = true; newBtn.addEventListener('click', () => { body.scrollTop = body.scrollHeight; });
  typingEl = el('div', 'zc-typing'); typingEl.hidden = true; typingEl.append(el('i', 'zc-dots'), el('span'));
  mentionEl = el('div', 'zc-men'); mentionEl.hidden = true;
  stickersEl = el('div', 'zc-stks'); stickersEl.hidden = true;
  moreEl = el('div', 'zc-more'); moreEl.hidden = true;
  // answering a message: "Trả lời <tên>" over the input, with what it says and an ✕
  replyEl = el('div', 'zc-reply'); replyEl.hidden = true;
  const replyX = el('button', 'zc-ib zc-reply-x'); replyX.type = 'button'; replyX.title = tr('chat.cancel'); replyX.append(icon('x')); replyX.addEventListener('click', () => setReply(null));
  const replyText = el('span', 'zc-reply-q'); replyText.append(el('b'), el('span', 'zc-reply-t'));
  replyEl.append(icon('reply'), replyText, replyX);
  // file input for attaching up to 5 images in chat
  const chatFileIn = el('input'); chatFileIn.type = 'file'; chatFileIn.accept = 'image/*'; chatFileIn.multiple = true; chatFileIn.hidden = true;
  chatFileIn.addEventListener('change', async () => { await addChatImageFiles(chatFileIn.files); chatFileIn.value = ''; });
  // a computer's toolbar over the input: stickers, a photo of the office, attach images, a card, a poll, @, more
  const photoBtn = (cls) => { const b = ib('image', tr('chat.sendPhoto'), () => chatSendPhoto(), cls); b.hidden = !state.isLocal; return b; };   // (a photo of the office as it is now: taken on the Mac)
  const attachBtn = (cls = '', idAttr = '') => { const b = ib('clip', tr('chat.attachPhoto'), () => chatFileIn.click(), cls); if (idAttr) b.id = idAttr; return b; };
  const atBtn = () => { moreEl.hidden = true; input.focus(); input.setRangeText(input.value && !/\s$/.test(input.value) ? ' @' : '@', input.selectionStart, input.selectionEnd, 'end'); mentions(); };
  const toolbar = el('div', 'zc-toolbar zc-pc');
  const taskToolbarBtn = ib('clipboard', tr('chat.task.title'), () => {
    if (chat.channel === 'casual') switchChannel('work');
    const imgs = chatPhotos.splice(0);
    drawChatThumbs();
    syncBar();
    openTaskSheet(root, { text: input.value.trim(), images: imgs });
  }, 'zc-task-btn');
  taskToolbarBtn.id = 'zc-task-btn';
  toolbar.append(ib('smile', tr('chat.stickerTab'), () => openStickers('sticker')), photoBtn(''), attachBtn('', 'zc-photo-btn'), ib('card', ''), ib('chart', tr('chat.newPoll'), openMore), ib('at', tr('chat.mention'), atBtn),
    taskToolbarBtn, ib('format', ''), ib('more', tr('chat.more'), openMore), chatFileIn);
  chatThumbsEl = el('div', 'zc-chat-thumbs'); chatThumbsEl.hidden = true;
  bar = el('form', 'zc-bar');
  input = el('textarea', 'zc-in'); input.id = 'zc-input'; input.rows = 1; input.maxLength = 600;
  input.placeholder = tr(matchMedia('(max-width: 640px)').matches ? 'chat.placeholder' : 'chat.placeholderPc', { group: tr('chat.group') });
  input.addEventListener('input', () => { syncBar(); mentions(); input.style.height = ''; input.style.height = `${Math.min(110, input.scrollHeight)}px`; });
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } if (e.key === 'Escape') { if (replyTo) setReply(null); else toggle(false); } });
  input.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length) {
      e.preventDefault();
      await addChatImageFiles(pasted);
    }
  });
  // the phone's 🎤: speak into the input (the browser's speech recognition, in the office's language)
  let stopMic = null;
  const micBtn = ib('mic', tr('chat.task.mic'), () => { if (stopMic) { stopMic(); stopMic = null; } else stopMic = dictate(micBtn, input, () => { syncBar(); input.dispatchEvent(new Event('input')); }); }, 'zc-mo zc-when-empty zc-mic');
  const like = el('button', 'zc-like-send zc-pc zc-when-empty', '👍'); like.type = 'button'; like.title = tr('chat.like'); like.addEventListener('click', () => { chatSend('👍', { replyTo: replyTo?.id }); setReply(null); });
  const sendBtn = el('button', 'zc-send'); sendBtn.type = 'submit'; sendBtn.title = tr('chat.send'); sendBtn.append(icon('send'), el('span', 'zc-send-t', tr('chat.sendPc')));
  bar.append(ib('smile', tr('chat.sticker'), () => openStickers('sticker'), 'zc-mo'), input,
    ib('more', tr('chat.more'), openMore, 'zc-mo zc-when-empty'), micBtn, attachBtn('zc-mo zc-when-empty'), photoBtn('zc-mo zc-when-empty'),
    ib('smile', tr('chat.emojiTab'), () => openStickers('emoji'), 'zc-pc'), like, sendBtn);
  bar.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  membersEl = el('aside', 'zc-mems'); membersEl.hidden = true;
  // what this chat is (and isn't): a word over the input until you close it
  const hint = el('div', 'zc-hint'), hintX = el('button', 'zc-ib zc-reply-x'); hintX.type = 'button'; hintX.title = tr('chat.close'); hintX.append(icon('x'));
  hint.append(el('span', null, tr('chat.hintRc')), hintX);
  try { hint.hidden = localStorage.getItem('office-chat-hint') === 'seen'; } catch { /* storage blocked */ }
  hintX.addEventListener('click', () => { hint.hidden = true; try { localStorage.setItem('office-chat-hint', 'seen'); } catch { /* storage blocked */ } });
  toEl = el('div', 'zc-to'); toEl.id = 'zc-to'; toEl.hidden = DEMO_CHAT; pickEl = el('div', 'zc-to-pick'); pickEl.hidden = true;
  root.append(head, tabsEl, pinEl, body, newBtn, typingEl, mentionEl, replyEl, hint, stickersEl, moreEl, toolbar, pickEl, toEl, chatThumbsEl, bar, membersEl);
  drawTabs();
  drawTarget();
  $('app').append(root);
}
export function toggle(on = !chat.open) {
  if (!root) build();
  msgLimit = 100;
  if (!on) readTo = [...chat.msgs.filter(inCurrentChannel)].reverse().find((m) => m.kind !== 'sys')?.id || null;   // (where to draw "Tin nhắn mới" next time)
  root.hidden = !on; setOpen(on); $('btn-chat')?.setAttribute('aria-pressed', String(on));
  if (on) {
    redraw(); drawTyping();
    const line = body.querySelector('.zc-newline');
    if (line) line.scrollIntoView({ block: 'center' }); else body.scrollTop = body.scrollHeight;
    $('zc-peek')?.setAttribute('hidden', ''); fitKeyboard(); setTimeout(() => input.focus({ preventScroll: true }), 30);
  }
  badge();
}
function fitKeyboard() {
  const vv = window.visualViewport;
  if (!root || root.hidden || !vv || !matchMedia('(max-width: 640px)').matches) { if (root) { root.style.height = ''; root.style.top = ''; } return; }
  root.style.top = `${vv.offsetTop}px`; root.style.height = `${vv.height}px`;
  if (document.activeElement === input) body.scrollTop = body.scrollHeight;
}
/* ---------- Zalo-style Photo Lightbox (#zc-lightbox) ---------- */
let lbEl, lbImg, lbTitle, lbSender, lbStrip, lbZoomBadge, lbZoomVal, lbPrevBtn, lbNextBtn, lbSideToggle;
let lbItems = [], lbIndex = 0, lbZoom = 1, lbRot = 0, lbPanX = 0, lbPanY = 0, lbBadgeTimer = 0;
let lbDragging = false, lbStartX = 0, lbStartY = 0, lbOriginX = 0, lbOriginY = 0;

function lbSvg(d) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.9');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = d;
  return s;
}

function dayHeaderLabel(ts) {
  const d = new Date(ts), now = new Date(), y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return tr('chat.today');
  if (d.toDateString() === y.toDateString()) return tr('chat.yesterday');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}

function collectChatPhotos() {
  const list = [];
  for (const m of chat.msgs.filter(inCurrentChannel)) {
    const photos = msgPhotos(m);
    if (!photos.length) continue;
    const parsed = parseLegacySender(m);
    const senderName = parsed.whoName || (m.from === 'me' ? (state.isLocal ? 'Giám đốc' : state.viewer?.name || tr('chat.boss')) : m.name || tr('chat.boss'));
    const senderKey = m.from === 'me' ? (m.whoId || 'director') : m.from;
    photos.forEach((src, idx) => {
      list.push({
        key: `${m.id}:${idx}`,
        msgId: m.id,
        idx,
        src,
        at: m.at || m.ts || Date.now(),
        senderName,
        senderKey,
      });
    });
  }
  return list;
}

function applyLbTransform(showBadge = false) {
  if (!lbImg) return;
  lbImg.style.transform = `translate3d(${lbPanX}px, ${lbPanY}px, 0) scale(${lbZoom}) rotate(${lbRot}deg)`;
  lbImg.classList.toggle('is-zoomed', lbZoom > 1.01);
  const pct = `${Math.round(lbZoom * 100)}%`;
  if (lbZoomVal) lbZoomVal.textContent = pct;
  if (showBadge && lbZoomBadge) {
    lbZoomBadge.textContent = pct;
    lbZoomBadge.hidden = false;
    clearTimeout(lbBadgeTimer);
    lbBadgeTimer = setTimeout(() => { if (lbZoomBadge) lbZoomBadge.hidden = true; }, 1100);
  }
}

function setLbZoom(nextZoom, showBadge = true) {
  lbZoom = Math.min(5, Math.max(0.25, Math.round(nextZoom * 100) / 100));
  if (lbZoom <= 1) { lbPanX = 0; lbPanY = 0; }
  applyLbTransform(showBadge);
}

function buildLightbox() {
  if (lbEl) return;
  lbEl = el('div', 'zc-lightbox'); lbEl.id = 'zc-lightbox'; lbEl.hidden = true;
  lbEl.setAttribute('role', 'dialog'); lbEl.setAttribute('aria-modal', 'true');

  // 1. Topbar
  const topbar = el('header', 'zc-lb-topbar');
  lbTitle = el('div', 'zc-lb-title');
  const closeBtn = el('button', 'zc-lb-close', '✕'); closeBtn.id = 'zc-lb-close'; closeBtn.type = 'button'; closeBtn.title = tr('chat.close');
  closeBtn.addEventListener('click', closeLightbox);
  topbar.append(el('span', 'zc-lb-spacer'), lbTitle, closeBtn);

  // 2. Center stage + Right filmstrip sidebar
  const main = el('div', 'zc-lb-main');
  const stage = el('div', 'zc-lb-stage'); stage.id = 'zc-lb-stage';
  lbPrevBtn = el('button', 'zc-lb-nav is-prev', '‹'); lbPrevBtn.type = 'button'; lbPrevBtn.title = tr('chat.lb.prev');
  lbNextBtn = el('button', 'zc-lb-nav is-next', '›'); lbNextBtn.type = 'button'; lbNextBtn.title = tr('chat.lb.next');
  lbPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  lbNextBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });

  lbImg = el('img', 'zc-lb-img'); lbImg.id = 'zc-lb-img'; lbImg.draggable = false;
  lbZoomBadge = el('span', 'zc-lb-zoom-badge'); lbZoomBadge.id = 'zc-lb-zoom-badge'; lbZoomBadge.hidden = true;
  stage.append(lbPrevBtn, lbImg, lbZoomBadge, lbNextBtn);

  stage.addEventListener('click', (e) => {
    if (e.target === stage) closeLightbox();
  });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    setLbZoom(lbZoom + delta, true);
  }, { passive: false });
  lbImg.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (lbZoom > 1.05) { lbZoom = 1; lbPanX = 0; lbPanY = 0; }
    else lbZoom = 2.25;
    applyLbTransform(true);
  });
  lbImg.addEventListener('pointerdown', (e) => {
    if (lbZoom <= 1.01 || e.button !== 0) return;
    e.preventDefault();
    lbDragging = true;
    lbStartX = e.clientX;
    lbStartY = e.clientY;
    lbOriginX = lbPanX;
    lbOriginY = lbPanY;
    lbImg.classList.add('is-dragging');
    lbImg.setPointerCapture?.(e.pointerId);
  });
  lbImg.addEventListener('pointermove', (e) => {
    if (!lbDragging) return;
    lbPanX = lbOriginX + (e.clientX - lbStartX);
    lbPanY = lbOriginY + (e.clientY - lbStartY);
    applyLbTransform(false);
  });
  const stopDrag = () => {
    if (!lbDragging) return;
    lbDragging = false;
    lbImg?.classList.remove('is-dragging');
  };
  lbImg.addEventListener('pointerup', stopDrag);
  lbImg.addEventListener('pointercancel', stopDrag);

  // 3. Right sidebar (Filmstrip grouped by date)
  const sidebar = el('aside', 'zc-lb-sidebar'); sidebar.id = 'zc-lb-sidebar';
  const sideArrows = el('div', 'zc-lb-side-arrows');
  const upBtn = el('button', 'zc-lb-side-arr', '⌃'); upBtn.type = 'button'; upBtn.title = tr('chat.lb.prev');
  const downBtn = el('button', 'zc-lb-side-arr', '⌄'); downBtn.type = 'button'; downBtn.title = tr('chat.lb.next');
  upBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  downBtn.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  sideArrows.append(upBtn, downBtn);
  lbStrip = el('div', 'zc-lb-strip'); lbStrip.id = 'zc-lb-strip';
  sidebar.append(sideArrows, lbStrip);

  main.append(stage, sidebar);

  // 4. Bottom toolbar
  const bottombar = el('footer', 'zc-lb-bottombar');
  lbSender = el('div', 'zc-lb-sender');
  const toolsBox = el('div', 'zc-lb-tools');

  const mkTool = (titleTxt, svgMarkup, onClick) => {
    const b = el('button', 'zc-lb-tool'); b.type = 'button'; b.title = titleTxt;
    b.append(lbSvg(svgMarkup));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const copyBtn = mkTool(tr('chat.lb.copy'), '<path d="M15 14l5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>', async () => {
    const cur = lbItems[lbIndex]; if (!cur?.src) return;
    try {
      const resp = await fetch(cur.src);
      const blob = await resp.blob();
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      } else {
        await navigator.clipboard?.writeText(cur.src);
      }
      toast(`✅ ${tr('chat.lb.copied')}`, 2500);
    } catch {
      try { await navigator.clipboard?.writeText(cur.src); toast(`✅ ${tr('chat.lb.copied')}`, 2500); } catch { /* ignore */ }
    }
  });
  const dlBtn = mkTool(tr('chat.lb.download'), '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', () => {
    const cur = lbItems[lbIndex]; if (!cur?.src) return;
    const a = document.createElement('a');
    a.href = cur.src;
    const ext = cur.src.startsWith('data:image/png') ? 'png' : 'jpg';
    a.download = `work-office-photo-${cur.at || Date.now()}.${ext}`;
    document.body.append(a);
    a.click();
    a.remove();
  });
  const rotBtn = mkTool(tr('chat.lb.rotate'), '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>', () => {
    lbRot = (lbRot + 90) % 360;
    applyLbTransform(false);
  });
  const resetBtn = mkTool(tr('chat.lb.reset'), '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/>', () => {
    lbZoom = 1; lbRot = 0; lbPanX = 0; lbPanY = 0;
    applyLbTransform(true);
  });
  const zoomInBtn = mkTool(tr('chat.lb.zoomIn'), '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>', () => setLbZoom(lbZoom + 0.25, true));
  const zoomOutBtn = mkTool(tr('chat.lb.zoomOut'), '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>', () => setLbZoom(lbZoom - 0.25, true));
  lbZoomVal = el('span', 'zc-lb-zoom-val', '100%'); lbZoomVal.id = 'zc-lb-zoom-val';

  toolsBox.append(copyBtn, dlBtn, rotBtn, resetBtn, zoomInBtn, zoomOutBtn, lbZoomVal);

  lbSideToggle = mkTool(tr('chat.lb.sidebar'), '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>', () => {
    const collapsed = lbEl.classList.toggle('is-side-collapsed');
    lbSideToggle.classList.toggle('is-on', !collapsed);
  });
  lbSideToggle.id = 'zc-lb-side-toggle';
  lbSideToggle.classList.add('zc-lb-side-btn', 'is-on');

  bottombar.append(lbSender, toolsBox, lbSideToggle);
  lbEl.append(topbar, main, bottombar);
  document.body.append(lbEl);
}

function renderLightboxStrip() {
  if (!lbStrip) return;
  const frag = document.createDocumentFragment();
  let lastDay = '';
  lbItems.forEach((it, idx) => {
    const dLbl = dayHeaderLabel(it.at);
    if (dLbl !== lastDay) {
      lastDay = dLbl;
      frag.append(el('div', 'zc-lb-date', dLbl));
    }
    const btn = el('button', `zc-lb-thumb${idx === lbIndex ? ' is-active' : ''}`);
    btn.type = 'button';
    btn.dataset.idx = String(idx);
    const im = el('img'); im.src = it.src; im.alt = ''; im.loading = 'lazy';
    btn.append(im);
    btn.addEventListener('click', (e) => { e.stopPropagation(); selectLightboxIndex(idx); });
    frag.append(btn);
  });
  lbStrip.replaceChildren(frag);
  const activeThumb = lbStrip.querySelector('.zc-lb-thumb.is-active');
  activeThumb?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function selectLightboxIndex(idx) {
  if (!lbItems.length) return;
  lbIndex = (idx + lbItems.length) % lbItems.length;
  const cur = lbItems[lbIndex];
  lbZoom = 1; lbRot = 0; lbPanX = 0; lbPanY = 0;
  lbImg.src = cur.src;
  lbTitle.textContent = `${cur.senderName} · ${tr('chat.group')}`;
  const info = el('div', 'zc-lb-sender-meta');
  info.append(el('b', null, cur.senderName), el('small', null, timeLabel(cur.at)));
  lbSender.replaceChildren(avatar(faceOf(cur.senderKey, cur.senderName), 36), info);
  lbPrevBtn.disabled = lbItems.length <= 1;
  lbNextBtn.disabled = lbItems.length <= 1;
  applyLbTransform(false);
  renderLightboxStrip();
}

function stepLightbox(delta) {
  if (lbItems.length <= 1) return;
  selectLightboxIndex(lbIndex + delta);
}

export function openLightbox(msgId, imgIdx = 0) {
  buildLightbox();
  lbItems = collectChatPhotos();
  if (!lbItems.length) return;
  const found = lbItems.findIndex((x) => x.msgId === msgId && x.idx === imgIdx);
  lbEl.hidden = false;
  selectLightboxIndex(found >= 0 ? found : lbItems.length - 1);
}

export function closeLightbox() {
  if (!lbEl || lbEl.hidden) return;
  lbEl.hidden = true;
}

export function setup() {
  window.visualViewport?.addEventListener('resize', fitKeyboard); window.visualViewport?.addEventListener('scroll', fitKeyboard);
  $('btn-chat')?.addEventListener('click', () => toggle());
  $('btn-task')?.addEventListener('click', () => {
    if (!chat.open) toggle(true);
    if (chat.channel === 'casual') switchChannel('work');
    const imgs = chatPhotos.splice(0);
    drawChatThumbs();
    syncBar();
    openTaskSheet(root, { text: input?.value.trim() || '', images: imgs });
  });
  addEventListener('keydown', (e) => {
    if (lbEl && !lbEl.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLightbox(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setLbZoom(lbZoom + 0.25, true); return; }
      if (e.key === '-') { e.preventDefault(); setLbZoom(lbZoom - 0.25, true); return; }
      if (e.key === '0') { e.preventDefault(); lbZoom = 1; lbRot = 0; lbPanX = 0; lbPanY = 0; applyLbTransform(true); return; }
      return;
    }
    if (e.key === 'Escape' && chat.open && !e.defaultPrevented) toggle(false);
  });
  badge();
}
