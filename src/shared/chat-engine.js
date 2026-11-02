// The company group chat's engine, the same for the server (server/index.mjs: one conversation for every page, the Mac's
// and a phone's, kept in data/chat.json) and for the online demo (src/office/ui/group-chat.js, kept in the browser).
// It knows nothing of files, pages or the 3D office: what it needs comes in ctx.
//
// People type for a moment before a line shows (emit 'typing'), react and answer each other, vote in polls, say yes
// or no to a reminder, and answer you: @ someone and they say what they're on; "họp" / "meeting" rings the bell,
// "trà sữa" / "milk tea" brings the Friday tea out (ctx.act). What the sessions say about their work comes from the
// hooks' events (onEvent); the office's life (a parcel, the tea, a birthday…) is told by the page where it happens,
// as a finished line (say, with a key so two pages telling the same moment make one message).
//
// ctx: tr (the office's words), now() (ms), members() -> [{ id, name, status, task, last }], staffName(key) -> name or
// null, store { load() -> data | null, save(data) }, emit(op, payload) with op 'add' | 'update' | 'typing' | 'all',
// act(what) for 'meeting' | 'tea', timer(fn, ms).
const MAX_WORK = 2000, MAX_CASUAL = 200, WORK_PHOTOS = 200, CASUAL_PHOTOS = 24, KEYS = 600;
export const CHAT_RETENTION_MS = 7 * 86400_000;
export const REACTIONS = ['❤️', '👍', '😆', '😮', '😭', '😡'];
const STAFF = {
  reception: '__reception',
  hr: '__hr',
  cleaner: '__cleaner',
  guard: '__guard',
  director: '__director',
  courier: '__courier',
  accountant: '__accountant',
  dept1: '__dept1',
  dept2: '__dept2',
  dept3: '__dept3',
  dept4: '__dept4',
};
const CASUAL_STAFF_FROM = new Set([
  'hr', 'reception', 'cleaner', 'guard', 'accountant', 'courier', 'dept1', 'dept2', 'dept3', 'dept4',
  '__hr', '__reception', '__cleaner', '__guard', '__accountant', '__courier', '__dept1', '__dept2', '__dept3', '__dept4',
]);
const CASUAL_TEXT_RE = /(?:circle\s*k|gs25|7-?eleven|familymart|mixue|trà\s*sữa|trà\s*đào|nước\s*suối|ốc\s*quế|sundae|chanh\s*tươi|bánh\s*tráng\s*trộn|cơm\s*tấm|bún\s*bò|sữa\s*chua\s*dâu|bình\s*cà\s*phê|hạt\s*arabica|bàn\s*bida|cơ\s*giải\s*lao|karaoke|điện\s*tử\s*thùng|mèo\s*văn\s*phòng|router\s*wi-?fi|shipper|shopee|grabfood|mỏi\s*lưng|trời\s*mát\s*ghê|em\s*tan\s*ca\s*nha|em\s*về\s*trước\s*nha|mình\s*về\s*trước|hôm\s*nay\s*tới\s*đây\s*nha|bye\s*bye|mai\s*gặp\s*nha|về\s*cẩn\s*thận\s*nha|em\s*vào\s*ca\s*rồi|chào\s*cả\s*nhà|chào\s*buổi\s*sáng|ngủ\s*trưa\s*thôi|kéo\s*rèm\s*nha|hết\s*giờ\s*ngủ|họp\s*giao\s*ban|sinh\s*nhật|hpbd|lau\s*nhà\s*nha|hôm\s*nay\s*rằm|mùng\s*một\s*đầu\s*tháng|^(?:nhanh\s*ghê|ngon\s*lành\s*👍|giỏi\s*quá\s*👏)$)/i;
const KINDS = new Set(['text', 'sticker', 'photo', 'poll', 'remind', 'perm', 'sys']);
const short = (s, n = 60) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const rand = (a, b) => a + Math.random() * (b - a);
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

export function inferChatChannel(m) {
  if (!m || typeof m !== 'object') return 'work';
  if (m.kind === 'perm' || m.tag === 'claude') return 'work';
  if (m.kind === 'poll' || m.kind === 'remind' || m.kind === 'sticker' || m.sticker != null || m.poll || m.remind) return 'casual';
  if (m.role === 'staff' || CASUAL_STAFF_FROM.has(m.from) || String(m.from || '').startsWith('__')) return 'casual';
  if (m.key && String(m.key).startsWith('life:')) return 'casual';
  if (m.kind === 'sys') {
    const txt = String(m.text || '');
    if (/giao việc|gave|duyệt|workspace|pin|chưa giao được|couldn[’']t start/i.test(txt)) return 'work';
    if (/bình chọn|poll|nhắc hẹn|remind|thêm .* vào nhóm|added .* to the group|rời khỏi nhóm|left the group/i.test(txt)) return 'casual';
    return m.channel === 'casual' ? 'casual' : 'work';
  }
  if (m.role !== 'boss' && m.from !== 'me' && m.kind === 'text') {
    const stripped = String(m.text || '').replace(/^@(?:Giám\s*đốc|Phó\s*Giám\s*đốc)\s+/i, '').trim();
    if (CASUAL_TEXT_RE.test(stripped)) {
      if (stripped !== String(m.text || '').trim()) {
        m.text = stripped;
        m.mentions = [];
      }
      return 'casual';
    }
  }
  if (m.channel === 'work' || m.channel === 'casual') return m.channel;
  return 'work';
}

export function createChatEngine(ctx) {
  const { tr } = ctx, timer = ctx.timer || ((fn, ms) => setTimeout(fn, ms));
  const st = { msgs: [], pinned: null, days: {}, keys: [], typing: [] };
  const queue = [], cool = new Map(), busy = new Map();   // (busy: who is working on what you sent them, key -> name)
  let seq = 0, tickT = null;
  const nid = () => `${ctx.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const keepRecent = (list) => {
    const now = ctx.now ? ctx.now() : Date.now();
    const recent = (list || []).filter((m) => {
      if (!m) return false;
      const ts = m.ts || m.at || now;
      return (now - ts) <= CHAT_RETENTION_MS;
    });
    let workCount = 0, casualCount = 0, workPhotos = 0, casualPhotos = 0;
    const kept = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      const ch = inferChatChannel(m);
      m.channel = ch;
      if (ch === 'casual') {
        if (++casualCount > MAX_CASUAL) continue;
        if (m.photo && ++casualPhotos > CASUAL_PHOTOS) m.photo = null;
      } else {
        if (++workCount > MAX_WORK) continue;
        if (m.photo && ++workPhotos > WORK_PHOTOS) m.photo = null;
      }
      kept.push(m);
    }
    kept.reverse();
    if (st.pinned && !kept.some((m) => m.id === st.pinned)) st.pinned = null;
    return kept;
  };

  /* ---------- the store ---------- */
  const data = ctx.store.load();
  if (data?.v === 1 && Array.isArray(data.msgs)) {
    st.pinned = data.pinned || null;
    st.days = data.days || {};
    st.keys = data.keys || [];
    st.msgs = keepRecent(data.msgs);
  }
  function save() {
    st.msgs = keepRecent(st.msgs);
    ctx.store.save({ v: 1, msgs: st.msgs, pinned: st.pinned, days: st.days, keys: st.keys.slice(-KEYS) });
  }
  if (!st.msgs.length) add({ kind: 'sys', text: tr('chat.sys.created'), channel: 'work' });

  /* ---------- who ---------- */
  const members = () => ctx.members();
  const fallbackStaffName = (key) => {
    const map = {
      __reception: tr('people.staff.receptionist'),
      __hr: tr('people.staff.hr'),
      __cleaner: tr('people.staff.cleaner'),
      __guard: tr('people.guard.name'),
      __director: tr('people.director'),
      __courier: tr('people.staff.shipper'),
      __accountant: tr('people.accountant.name'),
      __dept1: `[UI] ${tr('people.deptWorker', { n: 1 })}`,
      __dept2: `[BE] ${tr('people.deptWorker', { n: 2 })}`,
      __dept3: `[BA] ${tr('people.deptWorker', { n: 3 })}`,
      __dept4: `[QA] ${tr('people.deptWorker', { n: 4 })}`,
    };
    return map[key] || null;
  };
  function who(from) {
    if (from === 'me') return { key: 'me', name: tr('chat.boss') };
    const key = STAFF[from] || String(from || '');
    if (key.startsWith('__')) {
      const name = ctx.staffName?.(key) || fallbackStaffName(key);
      return name ? { key, name, staff: true } : null;
    }
    const m = members().find((x) => x.id === key);
    return m ? { key, name: m.name } : null;
  }
  const resting = () => members().filter((m) => m.status === 'rest').map((m) => m.id);
  const anyone = (but = []) => { const r = resting().filter((id) => !but.includes(id)); const pool = r.length ? r : members().map((m) => m.id).filter((id) => !but.includes(id)); return pool.length ? pickOne(pool) : null; };
  const some = (n, but = []) => members().map((m) => m.id).filter((id) => !but.includes(id)).sort(() => Math.random() - 0.5).slice(0, n);
  const casualPool = (but = []) => {
    const ids = [...members().map((m) => m.id), 'dept1', 'dept2', 'dept3', 'dept4', 'hr', 'reception', 'accountant', 'guard'];
    return ids.filter((id) => !but.includes(id) && !but.includes(STAFF[id]));
  };
  const someCasual = (n, but = []) => casualPool(but).sort(() => Math.random() - 0.5).slice(0, n);

  /* ---------- messages ---------- */
  function add(m) {
    const now = ctx.now();
    m = { id: nid(), at: now, ts: m?.ts || m?.at || now, reacts: {}, ...m };
    if (!KINDS.has(m.kind)) m.kind = 'text';
    m.channel = inferChatChannel(m);
    st.msgs.push(m);
    st.msgs = keepRecent(st.msgs);
    save(); ctx.emit('add', m);
    return m;
  }
  const update = (m) => { save(); ctx.emit('update', m); };
  const byId = (id) => st.msgs.find((m) => m.id === id);
  const fresh = (key) => { if (!key) return true; if (st.keys.includes(key)) return false; st.keys.push(key); if (st.keys.length > KEYS + 50) st.keys.splice(0, st.keys.length - KEYS); return true; };
  function system(text, o = {}) { return add({ kind: 'sys', text, ...(o?.channel ? { channel: o.channel } : {}) }); }
  /** Someone says something after typing a moment (opts.now: at once). opts: delay, sticker, photo, poll, remind, reply
   *  ({ id, name, text }), react (emojis others may add), reacts (how many at most), answer ([{ key, chance, vars }]: lines
   *  others answer with, under chat.reply), pin, key (once only), long (up to 4000 characters: Antigravity's own answer), tag ('claude': Antigravity's answer), then(m). */
  function say(from, text, opts = {}) {
    if (!fresh(opts.key) || (!text && opts.sticker == null && !opts.photo && !opts.poll && !opts.remind)) return;
    const p = who(from); if (!p) return;
    const ch = opts.channel || inferChatChannel({ from: p.key, text, sticker: opts.sticker, poll: opts.poll, remind: opts.remind });
    const now = ctx.now(), wait = opts.now ? 0 : opts.delay ?? rand(400, 1800), typing = opts.now || p.key === 'me' ? 0 : Math.min(2800, 700 + String(text || '').length * 30);
    queue.push({ p, text: String(text || '').slice(0, opts.long ? 4000 : 600), opts: { ...opts, channel: ch }, typeAt: now + wait, at: now + wait + typing });
    queue.sort((a, b) => a.at - b.at);
    tick();
  }
  function tick() {
    clearTimeout(tickT);
    const now = ctx.now();
    while (queue.length && queue[0].at <= now) {
      const { p, text, opts } = queue.shift();
      const kind = opts.poll ? 'poll' : opts.remind ? 'remind' : opts.photo ? 'photo' : opts.sticker != null ? 'sticker' : 'text';
      const defaultRole = p.key === 'me' ? 'boss' : (!p.staff ? 'agent' : 'staff');
      const mentions = Array.isArray(opts.mentions) ? opts.mentions : (opts.ownerId ? [opts.ownerId] : []);
      const ch = opts.channel || inferChatChannel({ from: p.key, kind, text, sticker: opts.sticker, poll: opts.poll, remind: opts.remind });
      const m = add({
        from: p.key,
        name: opts.whoName || p.name,
        role: opts.role || defaultRole,
        kind,
        channel: ch,
        text,
        sticker: opts.sticker ?? null,
        photo: opts.photo || null,
        ...(Array.isArray(opts.images) && opts.images.length && { images: opts.images }),
        poll: opts.poll || null,
        remind: opts.remind || null,
        reply: opts.reply || null,
        ownerId: opts.ownerId || null,
        ownerName: opts.ownerName || null,
        mentions,
        ...(opts.tag && { tag: opts.tag }),
        ...(opts.whoName && { whoName: opts.whoName }),
        ...(opts.whoRole && { whoRole: opts.whoRole }),
        ...(opts.whoId && { whoId: opts.whoId }),
        ...(opts.humanOnly != null && { humanOnly: !!opts.humanOnly }),
        ...(opts.to && { to: opts.to }),
      });
      if (opts.pin) pin(m.id, opts.whoName || p.name);
      if (opts.react?.length) {
        const n = opts.reacts === 0 ? 0 : (opts.reacts ?? (Math.random() < 0.7 ? 1 : 2));
        if (n > 0) autoReact(m, opts.react, n);
      }
      for (const a of opts.answer || []) answer(m, a.key, a.chance ?? 1, a.vars, ch);
      opts.then?.(m);
    }
    const rawTyping = [
      ...queue.filter((q) => q.typeAt <= now && q.at > now).map((q) => ({ name: q.p.name, channel: inferChatChannel({ ...q.opts, from: q.p.key }) })),
      ...[...busy.values()].map((name) => ({ name, channel: 'work' })),
    ];
    const seenTyping = new Set();
    const typing = rawTyping.filter((item) => {
      const k = `${item.channel}:${item.name}`;
      if (seenTyping.has(k)) return false;
      seenTyping.add(k);
      return true;
    });
    const prevKey = (st.typing || []).map((x) => (typeof x === 'string' ? `work:${x}` : `${x.channel}:${x.name}`)).join('|');
    const nextKey = typing.map((x) => `${x.channel}:${x.name}`).join('|');
    if (nextKey !== prevKey) { st.typing = typing; ctx.emit('typing', typing); }
    if (queue.length) tickT = timer(tick, Math.max(60, Math.min(...queue.map((q) => (q.typeAt > now ? q.typeAt : q.at))) - now));
  }
  /** Someone "typing" for as long as they work on what you asked them (Claude on a message sent to its conversation). */
  function working(from, on) { const p = who(from); if (!p) return; if (on) busy.set(p.key, p.name); else busy.delete(p.key); tick(); }
  /** A reaction ('me' for you); the same emoji again takes it back. */
  function react(id, by, emoji) {
    const m = byId(id); if (!m || !REACTIONS.includes(emoji) || m.recalled) return;
    for (const [e, list] of Object.entries(m.reacts)) { const i = list.indexOf(by); if (i >= 0) { list.splice(i, 1); if (!list.length) delete m.reacts[e]; if (e === emoji) { update(m); return; } } }
    (m.reacts[emoji] ||= []).push(by); update(m);
  }
  function autoReact(m, emojis, n) {
    const actors = m.channel === 'casual' ? someCasual(n, [m.from]).map((k) => STAFF[k] || k) : some(n, [m.from]);
    for (const id of actors) timer(() => { if (byId(m.id)) react(m.id, id, pickOne(emojis)); }, rand(2500, 16000));
  }
  function answer(m, key, chance = 1, vars, channel) {
    if (Math.random() > chance) return;
    const ch = channel || m.channel || 'work';
    const id = ch === 'casual' ? someCasual(1, [m.from])[0] : anyone([m.from]);
    if (id) say(id, tr(`chat.reply.${key}`, vars), { delay: rand(1500, 6000), channel: ch });
  }
  /** A vote in a poll (an option's index; the same again takes it back). */
  function vote(id, by, i) {
    const m = byId(id); if (m?.kind !== 'poll' || !m.poll.opts[i]) return;
    const had = m.poll.opts[i].by.includes(by);
    for (const o of m.poll.opts) o.by = o.by.filter((x) => x !== by);
    if (!had) m.poll.opts[i].by.push(by);
    update(m);
  }
  function poll(from, q, options, keyOrOpts) {
    const o = typeof keyOrOpts === 'object' && keyOrOpts ? keyOrOpts : { key: keyOrOpts };
    const ch = o.channel || 'casual';
    const p = who(from); if (!p || !fresh(o.key)) return;
    options = options.map((t) => short(String(t).trim(), 60)).filter(Boolean).slice(0, 6);
    if (options.length < 2) return;
    system(tr('chat.sys.poll', { name: p.name, q: short(q, 120) }), { channel: ch });
    say(from, short(q, 120), { now: true, pin: true, channel: ch, poll: { q: short(q, 120), opts: options.map((t) => ({ t, by: [] })) },
      then: (m) => {
        const voters = ch === 'casual' ? someCasual(4).map((k) => STAFF[k] || k) : resting();
        for (const id of voters) timer(() => vote(m.id, id, Math.floor(Math.random() * options.length)), rand(5000, 70000));
      } });
  }
  /** A reminder card ("Nhắc hẹn"): title, when (ms), repeat ('week' or ''); people say yes over time; a line when it's due. */
  function remind(from, title, at, repeat = '', keyOrOpts) {
    const o = typeof keyOrOpts === 'object' && keyOrOpts ? keyOrOpts : { key: keyOrOpts };
    const ch = o.channel || 'casual';
    const p = who(from); if (!p || !fresh(o.key)) return;
    system(tr('chat.sys.remind', { name: p.name }), { channel: ch });
    say(from, title, { now: true, channel: ch, remind: { title, at, repeat, yes: [], no: [] },
      then: (m) => {
        const goers = ch === 'casual' ? someCasual(4).map((k) => STAFF[k] || k) : resting();
        for (const id of goers) timer(() => rsvp(m.id, id, true), rand(4000, 60000));
      } });
  }
  function rsvp(id, by, yes) {
    const m = byId(id); if (m?.kind !== 'remind') return;
    m.remind.yes = m.remind.yes.filter((x) => x !== by); m.remind.no = m.remind.no.filter((x) => x !== by);
    (yes ? m.remind.yes : m.remind.no).push(by); update(m);
  }
  function pin(id, byName) {
    const m = byId(id); if (!m) return;
    if (st.pinned === id) { st.pinned = null; save(); ctx.emit('all'); return; }
    st.pinned = id; system(tr('chat.sys.pinned', { name: byName || tr('chat.boss') }), { channel: m.channel || 'work' }); ctx.emit('all');
  }
  function addPerm(perm) {
    if (!perm?.id) return null;
    const existing = st.msgs.find((m) => m.kind === 'perm' && m.perm?.id === perm.id);
    if (existing) return existing;
    const p = who(perm.sess) || { key: perm.sess || 'me', name: perm.name || 'Antigravity' };
    return add({
      from: p.key,
      name: p.name,
      role: 'agent',
      kind: 'perm',
      channel: 'work',
      text: perm.detail || perm.title || '',
      perm: { ...perm, resolved: false, choice: null, byName: null },
      tag: 'claude',
      ownerId: perm.ownerId || null,
      ownerName: perm.ownerName || null,
      mentions: perm.ownerId ? [perm.ownerId] : [],
    });
  }
  function resolvePerm(permId, choice, byName = '') {
    const m = st.msgs.find((x) => x.kind === 'perm' && x.perm?.id === permId);
    if (!m || m.perm.resolved) return;
    m.perm.resolved = true;
    m.perm.choice = choice || 'done';
    m.perm.byName = byName || '';
    update(m);
  }
  function recall(id) { const m = byId(id); if (!m || m.from !== 'me' || m.recalled) return; Object.assign(m, { recalled: true, text: '', sticker: null, photo: null, reacts: {} }); if (st.pinned === id) st.pinned = null; update(m); }

  /* ---------- what the sessions say about their work (the hooks' events) ---------- */
  const ok = (key, ms) => {
    const now = ctx.now();
    if ((cool.get(key) || 0) > now) return false;
    if (cool.size > 300) {
      for (const [k, exp] of cool) if (exp <= now) cool.delete(k);
      if (cool.size > 300) cool.delete(cool.keys().next().value);
    }
    cool.set(key, now + ms);
    return true;
  };
  const work = (id, key, vars, opts = {}) => say(id, tr(`chat.work.${key}`, vars), { role: 'agent', channel: 'work', ...opts });
  const q = (t) => (t ? `“${short(t, 60)}”` : '');
  function onEvent(e) {
    const s = members().find((x) => x.id === e.sess); if (!s) return;
    const id = s.id;
    const ownerId = e.ownerId || s.ownerId || 'director';
    const ownerName = e.ownerName || s.ownerName || 'Giám đốc';
    const mentionPrefix = `@${ownerName} `;
    const w = (key, vars, opts = {}) => work(id, key, vars, { ownerId, ownerName, channel: 'work', ...opts });
    if (e.agent) { if (e.type === 'substart' && ok(`${id}:helper`, 30 * 60e3)) w('helper', null, { channel: 'work' }); return; }
    switch (e.type) {
      case 'start':
        if (ok(`${id}:hello`, 8 * 3600e3)) {
          system(tr('chat.sys.added', { by: ctx.staffName?.('__hr') || tr('chat.boss'), name: s.name }), { channel: 'casual' });
          w('hello', { project: s.project || s.name }, { channel: 'casual', answer: [{ key: 'hello', chance: 0.5 }] });
        }
        break;
      case 'prompt':
        if (e.label && ok(`${id}:prompt`, 60e3)) {
          say('me', `@${s.name} ${q(e.label)}`, { now: true, role: 'boss', channel: 'work', whoId: ownerId, whoName: ownerName, ownerId, ownerName });
          w('ack', null, { delay: 900, channel: 'work' });
        }
        break;
      case 'stop':
        if (ok(`${id}:done`, 4 * 60e3)) {
          say(id, `${mentionPrefix}${tr('chat.work.done', { task: short(s.task || e.label, 60) })}`, {
            role: 'agent',
            channel: 'work',
            ownerId,
            ownerName,
            mentions: [ownerId],
            react: ['👍', '❤️'],
            reacts: 2,
          });
        }
        break;
      case 'wait':
      case 'ask':
        if (ok(`${id}:wait`, 3 * 60e3)) {
          say(id, `${mentionPrefix}${tr(`chat.work.${e.type}`)}`, {
            now: true,
            role: 'agent',
            channel: 'work',
            ownerId,
            ownerName,
            mentions: [ownerId],
          });
        }
        break;
      case 'fail':
        if (e.limit) { if (ok(`${id}:limit`, 30 * 60e3)) w('limit', null, { channel: 'work', react: ['😭', '😆'], reacts: 2 }); break; }
        if (ok(`${id}:fail`, 3 * 60e3)) w((cool.get(`${id}:failed`) || 0) > ctx.now() ? 'failAgain' : 'fail', null, { channel: 'work', react: ['😭'], reacts: 1 });
        cool.set(`${id}:failed`, ctx.now() + 10 * 60e3);
        break;
      case 'compact': if (ok(`${id}:compact`, 20 * 60e3)) w('compact', null, { channel: 'work' }); break;
      case 'commit': if (ok(`${id}:commit`, 5 * 60e3)) w('commit', { msg: short(e.label, 64) }, { channel: 'work', react: ['👍'], reacts: 1 }); break;
      case 'push': if (ok(`${id}:push`, 5 * 60e3)) w('push', { branch: e.branch || e.label || 'main' }, { channel: 'work', react: ['❤️', '👍'], reacts: 3 }); break;
      case 'deploy': if (ok(`${id}:deploy`, 5 * 60e3)) w('deploy', null, { channel: 'work', react: ['❤️', '👍', '😮'], reacts: 4 }); break;
      case 'cired': if (ok(`${e.repo}:ci`, 10 * 60e3)) w('ciRed', null, { channel: 'work', react: ['😮', '😭'], reacts: 2 }); break;
      case 'cigreen': if (ok(`${e.repo}:ci`, 10 * 60e3)) w('ciGreen', null, { channel: 'work', react: ['❤️'], reacts: 2 }); break;
      case 'testok': if (ok(`${id}:test`, 10 * 60e3)) w('testOk', null, { channel: 'work', react: ['👍'], reacts: 1 }); break;
      case 'testfail': if (ok(`${id}:test`, 10 * 60e3)) w('testFail', null, { channel: 'work' }); break;
    }
  }
  const onLeft = (name) => system(tr('chat.sys.left', { name }), { channel: 'casual' });
  const onMoved = (id, to) => work(id, 'moved', { to }, { channel: 'work' });

  /* ---------- you, writing in it: who it concerns answers ---------- */
  const VERB = { edit: 'edit', write: 'edit', read: 'read', grep: 'read', glob: 'read', cmd: 'cmd', bash: 'cmd', test: 'test', web: 'web', fetch: 'web', search: 'web' };
  function statusOf(m) {
    if (m.status === 'rest') return tr('chat.reply.statusRest');
    if (m.status === 'out') return tr('chat.reply.statusOut');
    const what = m.last?.type ? tr(`chat.verb.${VERB[m.last.type] || 'other'}`, { label: short(m.last.label || '', 40) }) : tr('chat.verb.other', { label: '' });
    return tr('chat.reply.statusWork', { what: what.trim(), task: short(m.task || '', 60) });
  }
  /** You wrote: supports both send({ text, ... }) and send(text, target, images, opts). */
  function send(arg1 = {}, targetArg = null, imagesArg = [], optsArg = {}) {
    const isObj = typeof arg1 === 'object' && arg1 !== null;
    const rawOpts = isObj ? arg1 : { ...(optsArg || {}), text: arg1, to: targetArg, images: imagesArg };
    let {
      text = '',
      sticker = null,
      replyTo = null,
      to = null,
      whoName = null,
      whoRole = null,
      whoId = null,
      mentions = null,
      humanOnly = false,
      ownerId = null,
      photo: singlePhoto = null,
      images = null,
      channel = null,
    } = rawOpts;
    text = String(text || '').trim().slice(0, 600);
    const imgList = Array.isArray(images) ? images.filter(Boolean) : [];
    const mainPhoto = singlePhoto || (!text && imgList.length === 1 ? imgList[0] : null);
    if (!text && sticker == null && !mainPhoto && !imgList.length) return;
    const ch = channel === 'casual' ? 'casual' : (channel || (to ? 'work' : (sticker != null ? 'casual' : 'work')));
    const r = replyTo && byId(replyTo), reply = r && !r.recalled ? { id: r.id, name: r.whoName || r.name || tr('chat.you'), text: short(r.kind === 'text' ? r.text : r.kind === 'poll' ? r.poll.q : tr(r.kind === 'photo' ? 'chat.photo' : 'chat.sticker'), 90) } : null;
    say('me', text, { now: true, channel: ch, sticker, photo: mainPhoto, images: imgList.length ? imgList : null, reply, role: 'boss', to, whoName, whoRole, whoId, mentions, humanOnly, ownerId: ownerId || whoId || null });
    const mine = st.msgs.at(-1);
    if (humanOnly && Array.isArray(mentions) && mentions.length) return;
    const quote = mine && text ? { id: mine.id, name: whoName || tr('chat.boss'), text: short(text, 90) } : null;
    const low = text.toLowerCase(), named = members().filter((m) => text.includes(`@${m.name}`));

    if (ch === 'work') {
      if (!text) return;
      for (const m of named) {
        say(m.id, statusOf(m), { delay: rand(800, 2600), reply: quote, role: 'agent', channel: 'work', ownerId: ownerId || whoId || null });
      }
      if (to && !named.some((m) => m.id === to) && who(to) && !String(to).startsWith('__')) {
        say(to, tr('chat.work.ack'), { delay: rand(800, 2200), reply: quote, role: 'agent', channel: 'work', ownerId: ownerId || whoId || null });
      } else if (r && r.from !== 'me' && !named.some((m) => m.id === r.from) && who(r.from) && !r.from.startsWith('__')) {
        say(r.from, tr('chat.work.ack'), { delay: rand(1000, 3000), reply: quote, role: 'agent', channel: 'work', ownerId: ownerId || whoId || null });
      }
      if (mine && !humanOnly && Math.random() < 0.5) autoReact(mine, ['👍', '❤️'], 1);
      return;
    }

    // ch === 'casual': company-wide watercooler & fun banter
    if (!text) {
      const id = someCasual(1)[0];
      if (id) say(id, '', { sticker: Math.floor(Math.random() * tr('chat.stickers', null, 'list').length), delay: rand(1800, 5000), channel: 'casual' });
      return;
    }
    for (const m of named) {
      say(m.id, statusOf(m), { delay: rand(800, 2800), reply: quote, role: 'agent', channel: 'casual', ownerId: ownerId || whoId || null });
    }
    if (r && r.from !== 'me' && !named.some((m) => m.id === r.from) && who(r.from)) {
      const banterList = tr('chat.banterReplies', null, 'list');
      const line = Array.isArray(banterList) && banterList.length ? pickOne(banterList) : tr('chat.reply.any');
      say(r.from, line, { delay: rand(1100, 3200), reply: quote, channel: 'casual', ownerId: ownerId || whoId || null });
    }
    const replyCasual = (key, n = 1) => someCasual(n).forEach((id, i) => say(id, tr(`chat.reply.${key}`), { delay: rand(1300, 3600) + i * 2200, channel: 'casual' }));
    if (/họp|meeting|stand-?up/.test(low)) { ctx.act?.('meeting'); say('hr', tr('chat.life.meeting'), { delay: 700, channel: 'casual' }); replyCasual('meeting', 2); }
    else if (/trà sữa|tra sua|milk ?tea|bubble tea/.test(low)) { ctx.act?.('tea'); replyCasual('milkTea', 3); }
    else if (/sinh nhật|birthday|hpbd/.test(low)) replyCasual('hpbd', 2);
    else if (/về (nhà|đây|trước)|go(ing)? home|bye/.test(low)) replyCasual('goHome', 2);
    else if (/giỏi|tốt lắm|cảm ơn|cám ơn|good job|well done|thank/.test(low)) replyCasual('praise', 2);
    else if (/ăn gì|ăn trưa|lunch/.test(low)) poll('me', tr('chat.life.lunchPoll'), tr('chat.life.lunchOpts', null, 'list'), { channel: 'casual' });
    else if (!named.length && !r && !humanOnly) {
      const count = Math.random() < 0.45 ? 2 : 1;
      const banterList = tr('chat.banterReplies', null, 'list');
      someCasual(count).forEach((id, i) => {
        const line = Array.isArray(banterList) && banterList.length ? pickOne(banterList) : tr('chat.reply.any');
        say(id, line, {
          delay: rand(1200, 3200) + i * 2400,
          reply: i === 0 ? quote : null,
          channel: 'casual',
        });
      });
    }
    if (mine && !humanOnly && Math.random() < 0.7) autoReact(mine, ['❤️', '👍', '😆'], Math.random() < 0.5 ? 1 : 2);
  }
  function fromBoss(text, to = null, images = [], meta = {}) {
    const metaObj = typeof meta === 'string' ? { replyTo: meta } : (meta || {});
    const { replyTo = null, whoName = null, whoRole = null, whoId = null, mentions = null, humanOnly = false, ownerId = null, sticker = null, channel = null } = metaObj;
    const ch = channel || 'work';
    st.msgs = keepRecent(st.msgs);
    if (Array.isArray(images)) {
      for (const img of images) if (img) photo(img, { whoName, whoRole, whoId, ownerId, channel: ch });
    }
    send({ text, sticker, replyTo, to, whoName, whoRole, whoId, mentions, humanOnly, ownerId, channel: ch });
    return st.msgs.at(-1) || null;
  }
  function photo(dataUrl, meta = {}) {
    const ch = meta.channel || 'work';
    say('me', '', { now: true, photo: dataUrl, role: 'boss', ...meta, channel: ch });
    const m = st.msgs.at(-1);
    if (m?.from === 'me') autoReact(m, ch === 'casual' ? ['❤️', '😆', '😮'] : ['👍', '❤️'], ch === 'casual' ? 3 : 1);
  }

  /* ---------- automatic watercooler banter in casual channel ---------- */
  let lastBanterAt = ctx.now(), nextBanterWait = Math.floor(rand(32_000, 65_000));
  const recentBanter = [];
  function autoChatter(force = false) {
    const now = ctx.now();
    if (!force && now - lastBanterAt < nextBanterWait) return;
    lastBanterAt = now;
    nextBanterWait = Math.floor(rand(32_000, 65_000));
    const scripts = tr('chat.banter', null, 'list');
    if (!Array.isArray(scripts) || !scripts.length) return;
    const candidates = scripts.map((_, i) => i).filter((i) => !recentBanter.includes(i));
    const idx = pickOne(candidates.length ? candidates : scripts.map((_, i) => i));
    recentBanter.push(idx);
    if (recentBanter.length > 10) recentBanter.shift();
    const lines = scripts[idx];
    if (!Array.isArray(lines) || lines.length < 2) return;
    const speakers = someCasual(lines.length);
    if (speakers.length < 2) return;
    say(speakers[0], lines[0], {
      channel: 'casual',
      delay: rand(300, 1200),
      react: ['❤️', '😆', '👍'],
      reacts: Math.random() < 0.65 ? 1 : 2,
      then: (m1) => {
        say(speakers[1], lines[1], {
          channel: 'casual',
          delay: rand(2200, 4600),
          reply: { id: m1.id, name: m1.name, text: short(m1.text, 90) },
          react: ['😆', '❤️', '👍'],
          reacts: Math.random() < 0.5 ? 1 : 0,
          then: (m2) => {
            if (lines[2] && speakers[2]) {
              say(speakers[2], lines[2], {
                channel: 'casual',
                delay: rand(2200, 4800),
                reply: { id: m2.id, name: m2.name, text: short(m2.text, 90) },
                react: ['❤️', '😆', '👍'],
                reacts: 1,
              });
            }
          },
        });
      },
    });
  }

  /* ---------- by the clock: the morning hello, the lunch poll, reminders for the stand-up and the Friday tea ---------- */
  const hm = (d) => d.getHours() * 100 + d.getMinutes();
  function at(d, h, m) { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); }
  function clock() {
    const beforeLen = st.msgs.length;
    st.msgs = keepRecent(st.msgs);
    if (st.msgs.length !== beforeLen) {
      if (st.pinned && !st.msgs.some((m) => m.id === st.pinned)) st.pinned = null;
      save();
      ctx.emit('all');
    }
    autoChatter();
    const d = new Date(ctx.now()), day = d.toDateString(), wd = d.getDay();
    const once = (k) => {
      if (st.days[k] === day) return false;
      for (const [dk, dv] of Object.entries(st.days)) if (dv !== day) delete st.days[dk];
      st.days[k] = day;
      save();
      return true;
    };
    if (wd % 6 && hm(d) >= 750 && hm(d) < 830 && once('morning')) say('reception', tr('chat.life.morning'), { channel: 'casual', react: ['❤️', '👍'], reacts: 3, answer: [{ key: 'hello', chance: 0.7 }] });
    if (wd === 1 && hm(d) >= 820 && hm(d) < 855 && once('standupRemind')) remind('hr', tr('chat.life.standupTitle'), at(d, 9, 0), 'week', { channel: 'casual' });
    if (wd % 6 && hm(d) >= 1045 && hm(d) < 1130 && once('lunch')) poll(anyone() || 'reception', tr('chat.life.lunchPoll'), tr('chat.life.lunchOpts', null, 'list'), { channel: 'casual' });
    if (wd === 5 && hm(d) >= 1530 && hm(d) < 1555 && once('teaRemind')) remind('hr', tr('chat.life.teaTitle'), at(d, 16, 0), 'week', { channel: 'casual' });
    // a reminder that has come round: the app's own line for it
    for (const m of st.msgs) if (m.kind === 'remind' && !m.remind.done && m.remind.at <= ctx.now()) { m.remind.done = true; update(m); system(tr('chat.sys.remindNow', { title: m.remind.title }), { channel: 'casual' }); }
  }
  const chatterTimer = setInterval(() => { try { autoChatter(); } catch { /* ignore */ } }, 22_000);
  chatterTimer.unref?.();

  return { state: st, who, byId, say, system, send, fromBoss, working, react, vote, rsvp, poll, remind, pin, addPerm, resolvePerm, recall, photo, onEvent, onLeft, onSessionGone: onLeft, onMoved, clock, autoChatter, fresh };
}
