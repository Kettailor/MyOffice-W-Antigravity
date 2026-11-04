// Approve / deny cards, Focus-to-Approve floating modal, and AI session questions/plans.
import { state } from '../core/state.js';
import { dangerKey } from '../../shared/danger.js';
import { $, STATIC, el } from '../core/env.js';
import { icon } from './icons.js';
import { colorOf, dn, sessions, workers } from '../people/workers.js';
import { queueUi, toast } from './activity.js';
import { mdBlocks, openWindowOf, renderSessionHead } from './session-drawer.js';
import { autoCam, panTo } from './camera-bar.js';
import { fp } from '../interact/first-person.js';
import { TOKEN } from '../net/live.js';
import { sfx } from '../audio/sfx.js';
import { DEMO } from '../demo/demo.js';
import { renderPhone, renderViewerBadge } from './topbar.js';
import { MAX_TASK_IMAGES, dictate, shrink } from './dictate.js';
import { t as tr } from '../../i18n/index.js';

/* ---------- approve / deny: held permission requests & focus-to-approve modal ---------- */
export const perms = new Map();
let PAGE_ID;
let presenceTimer = 0;
let activeWaitSessId = null;
let activeModalCardId = null;
let stopActiveMic = null;
const dismissedCardIds = new Map(); // sessId -> cardId minimized by the user
const alertedCardIds = new Set();   // cardIds that already triggered the alert sound

const isAdminPerm = (p) => p?.kind === 'accessReq' || p?.kind === 'taskReq';

export function reportPresence() {
  if (STATIC) return;   // the online demo has no server to tell
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const focused = !DEMO && state.permOn && document.visibilityState === 'visible' && document.hasFocus();
    fetch(`/api/presence${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: PAGE_ID, focused }), keepalive: true }).catch(() => {});
  }, 250);
}

// a risky shell command (src/shared/danger.js): a red warning, a second click, no "always"
const dangerOf = (p) => { const k = dangerKey(p); return k ? tr(`perm.danger.${k}`) : (p?.risky ? tr('perm.danger.system') : null); };
// tool types with their own wording under perm.wants; any other tool gets perm.wants.other
const PERM_VERB = new Set(['bash', 'edit', 'write', 'web', 'fetch', 'mcp', 'agent', 'read']);

function copyTextSimple(text, btn) {
  const done = () => {
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = `✓ ${tr('drawer.copied')}`;
      setTimeout(() => { if (btn.isConnected) btn.textContent = prev; }, 1400);
    } else {
      toast(tr('drawer.copiedToast'));
    }
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, () => toast(tr('drawer.copyFailed')));
    return;
  }
  const ta = el('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast(tr('drawer.copyFailed')); }
  ta.remove();
}

/**
 * Returns the active wait card (`ask`, `perm`, `plan`) for a given session ID.
 * Searches live `perms` Map first, then falls back to `s.waitCard` on the session object.
 */
export function getSessionWaitCard(sessId) {
  if (!sessId) return null;
  for (const p of perms.values()) {
    if (p.sess === sessId && !isAdminPerm(p)) return p;
  }
  const s = sessions.get(sessId) || state.sessions?.get?.(sessId);
  if (s?.waitCard) {
    return {
      ...s.waitCard,
      id: s.waitCard.id || `wait-${sessId}-${s.waitCard.kind || 'perm'}`,
      sess: s.waitCard.sess || sessId,
      name: s.waitCard.name || dn(s) || s.name,
    };
  }
  if (s && s.status === 'wait') {
    return {
      id: `agy-ask:${s.sid || s.id}:${s.lastEventAt || 1}`,
      sess: s.id,
      sid: s.sid,
      name: s.title || s.name,
      cwd: s.cwd || s.dir || '',
      kind: 'ask',
      type: 'ask',
      tool: 'AskUserQuestion',
      label: 'Cần phản hồi để tiếp tục',
      detail: s.lastReply || s.act || s.last?.label || 'Phiên làm việc đang chờ câu trả lời hoặc phê duyệt của bạn.',
      questions: [{
        question: s.lastReply || s.act || 'Phiên làm việc đang tạm dừng chờ chỉ thị. Hãy chọn phương án hoặc nhập câu trả lời bên dưới để Antigravity tiếp tục:',
        header: 'Phản hồi phiên làm việc',
        options: [
          { label: '(Recommended) Đồng ý & Tiếp tục thực hiện', description: 'Phê duyệt và cho phép Antigravity tiếp tục công việc' },
        ],
      }],
      fromTranscript: true,
      t: s.lastEventAt || Date.now(),
    };
  }
  return null;
}

// Claude / Antigravity question (AskUserQuestion): pick an option per question, or type your own; several picks when allowed.
function askBody(card, p, sendBtnText = tr('perm.sendAnswer')) {
  const questions = Array.isArray(p.questions) && p.questions.length
    ? p.questions
    : [{ header: p.label || '', question: p.detail || p.plan || tr('perm.askTitle'), multi: false, options: [] }];
  const sel = questions.map(() => new Set()), other = questions.map(() => '');
  const box = el('div', 'pq-list'), send = el('button', 'pc-allow', sendBtnText);
  send.type = 'button';
  send.dataset.perm = 'answer';
  const sync = () => { send.disabled = sel.some((x, i) => !x.size && !other[i].trim()); };
  questions.forEach((q, qi) => {
    const wrap = el('div', 'pq'), top = el('div', 'pq-top');
    if (q.header) top.append(el('span', 'pq-chip', q.header));
    if (q.multi) top.append(el('span', 'pq-hint', tr('perm.multi')));
    if (top.children.length) wrap.append(top);
    const qEl = el('div', 'pq-q md');
    qEl.append(mdBlocks(q.question || ''));
    wrap.append(qEl);
    const opts = el('div', 'pq-opts');
    (q.options || []).forEach((o, oi) => {
      const b = el('button', 'pq-opt'); b.type = 'button'; b.setAttribute('aria-pressed', 'false');
      b.append(el('b', null, o.label));
      if (o.description) b.append(el('small', null, o.description));
      b.addEventListener('click', () => {
        if (q.multi) { if (sel[qi].has(oi)) sel[qi].delete(oi); else sel[qi].add(oi); }
        else { sel[qi].clear(); sel[qi].add(oi); other[qi] = ''; inp.value = ''; }
        for (const [k, x] of [...opts.children].entries()) x.setAttribute('aria-pressed', String(sel[qi].has(k)));
        sync();
      });
      opts.append(b);
    });
    const inp = el('input', 'pq-other');
    inp.type = 'text';
    inp.maxLength = 500;
    inp.placeholder = tr('perm.otherPlaceholder');
    inp.setAttribute('aria-label', tr('perm.otherLabel', { q: q.question || '' }));
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !send.disabled) { e.preventDefault(); send.click(); }
      if (e.key === 'Escape') { e.preventDefault(); closeWaitModal(true); }
    });
    inp.addEventListener('input', () => {
      other[qi] = inp.value;
      if (!q.multi && inp.value.trim()) {
        sel[qi].clear();
        for (const x of opts.children) x.setAttribute('aria-pressed', 'false');
      }
      sync();
    });
    if (opts.children.length) wrap.append(opts);
    wrap.append(inp);
    box.append(wrap);
  });
  card._payload = () => {
    const answers = questions.map((q, qi) => {
      const picks = [...sel[qi]];
      const labels = picks.map((idx) => q.options?.[idx]?.label).filter(Boolean);
      return { q: qi, pick: picks, labels, other: other[qi].trim() };
    });
    const textParts = answers.map((a, idx) => {
      const joined = [...(a.labels || []), a.other].filter(Boolean).join(' — ');
      return questions.length > 1 ? `${idx + 1}. ${joined}` : joined;
    }).filter(Boolean);
    const text = textParts.join('\n');
    return { answers, note: text, text };
  };
  sync();
  return { body: box, send };
}

function permCard(p) {
  const card = el('div', 'perm-card'); card.dataset.id = p.id; card.dataset.kind = p.kind || 'perm';
  const s = sessions.get(p.sess), dot = el('i'); dot.style.background = s ? colorOf(s) : '#F2B544';
  const ico = el('span', 'pc-ico'); ico.append(icon('alert'));
  const head = el('div', 'pc-head'), who = el('div', 'pc-who');
  const verbText = ' ' + (
    p.kind === 'accessReq' ? `yêu cầu quyền truy cập từ xa (${p.member?.ip || 'Tailscale'})` :
    p.kind === 'taskReq' ? `muốn giao việc vào 📁 ${p.taskReq?.targetName || p.taskReq?.dir || ''}` :
    p.kind === 'ask' ? tr('perm.asks') :
    p.kind === 'plan' ? tr('perm.plan') :
    PERM_VERB.has(p.type) ? tr(`perm.wants.${p.type}`) : tr('perm.wants.other', { tool: p.tool })
  );
  who.append(dot, el('b', null, dn(s) || p.name), document.createTextNode(verbText));
  if (p.kind === 'ask' || p.kind === 'plan') ico.replaceChildren(icon(p.kind === 'ask' ? 'sparkle' : 'list'));
  if (p.kind === 'accessReq') ico.replaceChildren(icon('users'));
  if (p.kind === 'taskReq') ico.replaceChildren(icon('clipboard'));
  const left = el('span', 'pc-left');
  head.append(ico, who, left);
  const acts = el('div', 'pc-acts');
  const accBtn = (act, text, cls) => { const b = el('button', cls, text); b.type = 'button'; b.dataset.access = act; return b; };
  const bar = el('div', 'pc-bar'), fill = el('i'); bar.append(fill);

  if (p.kind === 'accessReq') {
    const m = p.member || {};
    const wsList = p.workspaces || state.access?.workspaces || [];
    const box = el('div', 'pq-list');
    const nameIn = el('input', 'pq-other');
    nameIn.type = 'text';
    nameIn.value = m.name || 'Trợ lý Giám đốc';
    nameIn.placeholder = 'Tên hiển thị của người truy cập';
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());

    const roleIn = el('input', 'pq-other');
    roleIn.type = 'text';
    roleIn.value = m.role || 'Trợ lý Giám đốc';
    roleIn.placeholder = 'Vai trò (VD: Trợ lý Giám đốc)';
    roleIn.addEventListener('keydown', (e) => e.stopPropagation());

    const wsWrap = el('div', 'pm-mwsgrid');
    wsWrap.style.marginTop = '8px';
    const picked = new Set((m.allowedWorkspaces || []).map((x) => String(x).toLowerCase()));
    const cbs = [];
    for (const w of wsList) {
      const lbl = el('label', 'pm-mws');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = w.dir;
      cb.checked = !m.allowedWorkspaces?.length || picked.has(String(w.dir).toLowerCase());
      lbl.title = w.dir;
      lbl.append(cb, el('span', null, `📁 ${w.name}`));
      cbs.push(cb);
      wsWrap.append(lbl);
    }
    const permWrap = el('div', 'pm-mwsgrid');
    permWrap.style.marginTop = '6px';
    const makePermCb = (txt, initOn) => {
      const lbl = el('label', 'pm-mws');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = initOn;
      lbl.append(cb, el('span', null, txt));
      permWrap.append(lbl);
      return cb;
    };
    const acc = state.access || {};
    const isDeputy = (m.role || '') === 'Phó Giám đốc' || Boolean(m.isDirectorDevice);
    const cbStop = makePermCb('⏹️ Dừng phiên', m.canStopSession !== false && acc.allowStopSession !== false);
    const cbEdit = makePermCb('✏️ Chỉnh sửa phiên', m.canEditSession !== false && acc.allowEditSession !== false);
    const cbDel = makePermCb('🗑️ Xóa phiên', m.canDeleteSession !== false && acc.allowDeleteSession !== false);
    const cbFiles = makePermCb('📁 Cho phép tải lên / sửa / xóa file dự án', typeof m.canEditFiles === 'boolean' ? m.canEditFiles : isDeputy);

    let reqGender = m.gender === 'female' ? 'female' : 'male';
    const genderRow = el('div', 'pm-gender-row');
    const gMale = el('button', `btn btn--sm pm-gender-btn${reqGender === 'male' ? ' is-active' : ''}`, '👦 Nam');
    gMale.type = 'button';
    const gFemale = el('button', `btn btn--sm pm-gender-btn${reqGender === 'female' ? ' is-active' : ''}`, '👧 Nữ');
    gFemale.type = 'button';
    const syncReqGender = () => {
      gMale.classList.toggle('is-active', reqGender === 'male');
      gFemale.classList.toggle('is-active', reqGender === 'female');
    };
    gMale.addEventListener('click', () => { reqGender = 'male'; syncReqGender(); });
    gFemale.addEventListener('click', () => { reqGender = 'female'; syncReqGender(); });
    genderRow.append(el('small', 'pq-hint', 'Giới tính Chibi:'), gMale, gFemale);

    box.append(
      el('small', 'pq-hint', 'Tên & Vai trò cấp cho người truy cập Tailscale/LAN:'),
      nameIn,
      roleIn,
      genderRow,
      el('small', 'pq-hint', 'Chọn các Workspace người này được phép nhìn thấy & giao việc:'),
      wsWrap,
      el('small', 'pq-hint', 'Cấp quyền chức năng phiên làm việc (Dừng / Sửa / Xóa / File):'),
      permWrap,
    );
    if (m.note) box.append(el('p', 'pc-rule', `💬 Ghi chú: "${m.note}"`));
    card._accessPayload = (act) => ({
      action: act === 'approveMember' ? 'approveMember' : 'rejectMember',
      id: m.id,
      name: nameIn.value.trim() || 'Trợ lý Giám đốc',
      role: roleIn.value.trim() || 'Trợ lý Giám đốc',
      gender: reqGender,
      allowedWorkspaces: cbs.filter((c) => c.checked).map((c) => c.value),
      canStopSession: cbStop.checked,
      canEditSession: cbEdit.checked,
      canDeleteSession: cbDel.checked,
      canEditFiles: cbFiles.checked,
    });
    acts.append(
      accBtn('approveMember', '✅ Duyệt & Cấp quyền', 'pc-allow'),
      accBtn('rejectMember', '❌ Từ chối', 'pc-deny'),
    );
    card.append(head, box, acts, bar);
    card._tick = () => { left.textContent = 'Chờ Giám đốc duyệt'; fill.style.width = '100%'; };
    card._tick();
    return card;
  }

  if (p.kind === 'taskReq') {
    const trq = p.taskReq || {};
    const box = el('div', 'pq-list');
    const info = el('p', 'pc-rule', `📁 Workspace: ${trq.dir || trq.targetName || ''} · Người gửi: ${trq.memberRole || 'Trợ lý Giám đốc'} (${trq.memberName || ''})`);
    const ta = el('textarea', 'pq-other');
    ta.rows = 3;
    ta.style.height = 'auto';
    ta.style.padding = '8px 11px';
    ta.value = trq.text || p.detail || '';
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    box.append(info, ta);
    card._accessPayload = (act) => ({
      action: 'decideTask',
      id: trq.id,
      decision: act === 'rejectTask' ? 'reject' : 'approve',
      text: ta.value.trim(),
      disableRequireApproval: act === 'approveAndDisable',
    });
    acts.append(
      accBtn('approveTask', '✅ Duyệt & Giao việc ngay', 'pc-allow'),
      accBtn('approveAndDisable', '⚡ Duyệt & Tắt chờ duyệt', 'pc-always'),
      accBtn('rejectTask', '❌ Từ chối', 'pc-deny'),
    );
    card.append(head, box, acts, bar);
    card._tick = () => { left.textContent = 'Chờ duyệt Task'; fill.style.width = '100%'; };
    card._tick();
    return card;
  }

  return card;
}

function ensureWaitModalEl() {
  let modal = $('wait-focus-modal');
  if (!modal) {
    modal = el('div', 'wait-modal-backdrop');
    modal.id = 'wait-focus-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) closeWaitModal(true);
    });
    document.body.append(modal);
  }
  return modal;
}

export async function decide(id, choice, extra = {}) {
  const p = perms.get(id)
    || (extra.sess && getSessionWaitCard(extra.sess))
    || (activeWaitSessId && getSessionWaitCard(activeWaitSessId))
    || [...sessions.values()].map((s) => getSessionWaitCard(s.id)).find((c) => c?.id === id)
    || null;
  const sess = p?.sess || extra.sess || activeWaitSessId || state.selectedId || null;
  const doneMsg = ['allow', 'always', 'deny', 'answer', 'approve', 'revise', 'skip'].includes(choice)
    ? tr(`perm.done.${choice}`)
    : undefined;

  const cleanup = () => {
    perms.delete(id);
    const targetSid = p?.sid || '';
    if (sess) {
      dismissedCardIds.delete(sess);
    }
    for (const sessObj of sessions.values()) {
      if (sessObj.id === sess || sessObj.waitCard?.id === id || (targetSid && sessObj.sid === targetSid)) {
        dismissedCardIds.delete(sessObj.id);
        sessObj.waitCard = null;
        if (sessObj.status === 'wait') {
          sessObj.status = choice === 'skip' ? 'rest' : 'work';
        }
      }
    }
    if (activeModalCardId === id || (sess && activeWaitSessId === sess)) {
      closeWaitModal(false);
    }
    renderPerms();
    queueUi();
    if (state.selectedId) renderSessionHead();
  };

  if (DEMO) {
    toast(tr('perm.demoDone', { done: doneMsg || tr('perm.sent') }));
    cleanup();
    return { ok: true };
  }

  let res = null;
  try {
    const r = await fetch(`/api/perm${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, sess, choice, ...extra }),
    });
    res = await r.json();
    if (!res?.ok) toast(res?.message || tr('perm.expired'));
    else toast(doneMsg || tr('perm.sent'));
  } catch {
    toast(tr('perm.unreachable'));
  }
  cleanup();
  return res;
}

function buildFocusedWaitCard(p, sessId) {
  const kind = p.kind === 'ask' || p.kind === 'plan' ? p.kind : 'perm';
  const s = sessions.get(sessId) || sessions.get(p.sess);
  const modalCard = el('div', `wait-modal-card wait-modal--${kind}`);
  modalCard.dataset.id = p.id;
  modalCard.dataset.kind = kind;
  modalCard.dataset.sess = sessId;

  // --- Header ---
  const head = el('div', 'wait-modal-head');
  const ico = el('span', 'pc-ico');
  ico.append(icon(kind === 'ask' ? 'sparkle' : kind === 'plan' ? 'list' : 'alert'));

  const headMain = el('div', 'wait-head-main');
  const headTop = el('div', 'wait-head-top');
  const sessPill = el('span', 'wait-sess-pill');
  const dot = el('i');
  dot.style.background = s ? colorOf(s) : '#F2B544';
  sessPill.append(dot, el('b', null, dn(s) || p.name || 'Antigravity'));

  const badgeText = kind === 'ask'
    ? `❓ ${tr('perm.askTitle')}`
    : kind === 'plan'
      ? `📄 ${p.label || p.file || 'implementation_plan.md'}`
      : `🛠️ ${p.label || p.tool || p.type || 'bash'}`;
  const kindBadge = el('span', `wait-kind-badge wait-kind-badge--${kind}`, badgeText);
  const leftTimer = el('span', 'pc-left');
  headTop.append(sessPill, kindBadge, leftTimer);

  const verbText = kind === 'ask'
    ? tr('perm.asks')
    : kind === 'plan'
      ? tr('perm.plan')
      : PERM_VERB.has(p.type)
        ? tr(`perm.wants.${p.type}`)
        : tr('perm.wants.other', { tool: p.tool || p.label || 'tool' });
  const subText = `${verbText}${s?.dir ? ` · 📁 ${s.dir}` : ''}`;
  const headSub = el('p', 'wait-head-sub', subText);
  headMain.append(headTop, headSub);

  const headActs = el('div', 'wait-head-actions');
  if (kind === 'plan') {
    const copyBtn = el('button', 'wait-head-btn', `📋 ${tr('perm.copyPlan')}`);
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyTextSimple(p.plan || p.detail || '', copyBtn));
    headActs.append(copyBtn);
  }
  if (state.isLocal && s) {
    const ideBtn = el('button', 'wait-head-btn wait-ide-btn', kind === 'perm' ? `${tr('perm.openIdeShort')} (O)` : tr('perm.openInIde'));
    ideBtn.type = 'button';
    ideBtn.title = tr('drawer.openWindowTitle');
    ideBtn.addEventListener('click', () => openWindowOf(s));
    headActs.append(ideBtn);
  }
  const minBtn = el('button', 'wait-close-btn', '✕');
  minBtn.type = 'button';
  minBtn.title = tr('perm.minimizeModal');
  minBtn.setAttribute('aria-label', tr('perm.minimizeModal'));
  minBtn.addEventListener('click', () => closeWaitModal(true));
  headActs.append(minBtn);

  head.append(ico, headMain, headActs);
  modalCard.append(head);

  const acts = el('div', `wait-modal-acts wait-modal-acts--${kind}`);
  const bar = el('div', 'pc-bar'), fill = el('i');
  bar.append(fill);

  // --- Case 1: Questions (kind === 'ask') ---
  if (kind === 'ask') {
    const subLead = el('p', 'wait-section-lead', tr('perm.askSubtitle'));
    const { body, send } = askBody(modalCard, p, tr('perm.confirmAndApprove'));
    const skipBtn = el('button', 'pc-skip', tr('perm.skipBtn'));
    skipBtn.type = 'button';
    skipBtn.dataset.perm = 'skip';

    const submitAsk = async (choice) => {
      const payload = choice === 'answer' ? (modalCard._payload?.() || {}) : {};
      for (const x of modalCard.querySelectorAll('button, input, textarea')) x.disabled = true;
      if (choice === 'answer') send.textContent = tr('perm.sending');
      else skipBtn.textContent = tr('perm.sending');
      await decide(p.id, choice, { sess: sessId, ...payload });
    };
    send.addEventListener('click', () => submitAsk('answer'));
    skipBtn.addEventListener('click', () => submitAsk('skip'));

    acts.append(send, skipBtn);
    modalCard.append(subLead, body, acts, bar);
  }
  // --- Case 3: Implementation Plan (kind === 'plan') ---
  else if (kind === 'plan') {
    if (p.planSummary) {
      const sumBox = el('div', 'wait-plan-summary');
      sumBox.append(el('b', null, `📌 ${tr('perm.planSummaryTitle')}`), el('p', null, p.planSummary));
      modalCard.append(sumBox);
    }
    const planBody = el('div', 'wait-plan-body md');
    planBody.append(mdBlocks(p.plan || p.detail || ''));
    modalCard.append(planBody);

    // Embedded Prompt Composer identical to "📋 Giao việc" (task-sheet.js)
    const composer = el('div', 'wait-composer');
    const compLabel = el('label', 'wait-composer-label', tr('perm.planComposerLabel'));
    const field = el('textarea', 'wait-composer-in');
    field.rows = 3;
    field.maxLength = 4000;
    field.placeholder = tr('perm.planComposerPlaceholder', { max: MAX_TASK_IMAGES });

    const photos = [];
    const imgStrip = el('div', 'wait-img-strip');
    const camSpan = el('span', null, `${tr('perm.attachPhoto')} (0/${MAX_TASK_IMAGES})`);

    const drawThumbs = () => {
      camSpan.textContent = `${tr('perm.attachPhoto')} (${photos.length}/${MAX_TASK_IMAGES})`;
      imgStrip.replaceChildren(...photos.map((u, i) => {
        const t = el('span', 'wait-img-thumb'), img = el('img'), x = el('button', null, '✕');
        img.src = u;
        x.type = 'button';
        x.addEventListener('click', () => { photos.splice(i, 1); drawThumbs(); });
        t.append(img, x);
        return t;
      }));
    };

    const addImageFiles = async (fileList) => {
      const imgs = [...(fileList || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
      if (!imgs.length) return;
      const slots = MAX_TASK_IMAGES - photos.length;
      if (slots <= 0) {
        toast(tr('perm.maxPhotosReached', { max: MAX_TASK_IMAGES }), 3500);
        return;
      }
      for (const f of imgs.slice(0, slots)) {
        try { photos.push(await shrink(f)); } catch { /* ignore unreadable image */ }
      }
      drawThumbs();
    };

    const fileIn = el('input');
    fileIn.type = 'file';
    fileIn.accept = 'image/*';
    fileIn.multiple = true;
    fileIn.hidden = true;
    fileIn.addEventListener('change', async () => { await addImageFiles(fileIn.files); fileIn.value = ''; });

    field.addEventListener('paste', async (e) => {
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
        await addImageFiles(pasted);
      }
    });

    composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('is-dragover'); });
    composer.addEventListener('dragleave', () => composer.classList.remove('is-dragover'));
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      composer.classList.remove('is-dragover');
      if (e.dataTransfer?.files?.length) await addImageFiles(e.dataTransfer.files);
    });

    const micBtn = el('button', 'wait-tool-btn');
    micBtn.type = 'button';
    micBtn.title = tr('perm.voiceMic');
    micBtn.append(icon('mic'), el('span', null, tr('perm.voiceMic')));
    micBtn.addEventListener('click', () => {
      if (stopActiveMic) { stopActiveMic(); stopActiveMic = null; }
      else stopActiveMic = dictate(micBtn, field);
    });

    const camBtn = el('button', 'wait-tool-btn');
    camBtn.type = 'button';
    camBtn.title = `${tr('perm.attachPhoto')} (Ctrl+V · max ${MAX_TASK_IMAGES})`;
    camBtn.append(icon('image'), camSpan);
    camBtn.addEventListener('click', () => fileIn.click());

    const compBar = el('div', 'wait-composer-bar');
    compBar.append(micBtn, camBtn, fileIn);
    composer.append(compLabel, field, imgStrip, compBar);

    const approveBtn = el('button', 'pc-allow', tr('perm.approveAndRun'));
    approveBtn.type = 'button';
    approveBtn.dataset.perm = 'approve';

    const reviseBtn = el('button', 'pc-always', tr('perm.sendPlanNote'));
    reviseBtn.type = 'button';
    reviseBtn.dataset.perm = 'revise';

    const submitPlan = async (choice) => {
      stopActiveMic?.();
      stopActiveMic = null;
      const text = field.value.trim();
      for (const x of modalCard.querySelectorAll('button, input, textarea')) x.disabled = true;
      const targetBtn = choice === 'approve' ? approveBtn : reviseBtn;
      targetBtn.textContent = tr('perm.sending');
      await decide(p.id, choice, {
        sess: sessId,
        note: text,
        text,
        images: [...photos],
      });
    };

    approveBtn.addEventListener('click', () => submitPlan('approve'));
    reviseBtn.addEventListener('click', () => submitPlan('revise'));

    field.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (field.value.trim()) submitPlan('revise');
        else submitPlan('approve');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeWaitModal(true);
      }
    });

    modalCard._payload = () => ({ note: field.value.trim(), text: field.value.trim(), images: [...photos] });
    acts.append(approveBtn, reviseBtn);
    modalCard.append(composer, acts, bar);
  }
  // --- Case 2: Permission / Command / Access (kind === 'perm') ---
  else {
    const risky = dangerOf(p);
    const phone = !state.isLocal;
    const kbd = (b, k) => { b.append(el('kbd', null, k)); return b; };
    const mkBtn = (choice, text, cls) => {
      const b = el('button', cls, text);
      b.type = 'button';
      b.dataset.perm = choice;
      return b;
    };

    const ruleText = p.remember || p.tool || p.label || '';
    if (!phone || !risky) {
      const allowBtn = kbd(mkBtn('allow', `✅ ${tr('perm.allowOnce')}`, 'pc-allow'), 'Y');
      allowBtn.addEventListener('click', async () => {
        if (risky && allowBtn.dataset.armed !== '1') {
          allowBtn.dataset.armed = '1';
          allowBtn.firstChild.textContent = `⚠️ ${tr('perm.allowAgain')}`;
          setTimeout(() => {
            if (allowBtn.isConnected) {
              allowBtn.dataset.armed = '';
              allowBtn.firstChild.textContent = `✅ ${tr('perm.allowOnce')}`;
            }
          }, 4000);
          return;
        }
        for (const x of modalCard.querySelectorAll('button')) x.disabled = true;
        allowBtn.textContent = tr('perm.sending');
        await decide(p.id, 'allow', { sess: sessId });
      });
      acts.append(allowBtn);
    }

    if (!risky && !phone) {
      const alwaysBtn = kbd(mkBtn('always', `⚡ ${tr('perm.alwaysShort')}`, 'pc-always'), 'A');
      if (ruleText) alwaysBtn.title = tr('perm.ruleTitle', { rule: ruleText });
      alwaysBtn.addEventListener('click', async () => {
        for (const x of modalCard.querySelectorAll('button')) x.disabled = true;
        alwaysBtn.textContent = tr('perm.sending');
        await decide(p.id, 'always', { sess: sessId, rule: ruleText });
      });
      acts.append(alwaysBtn);
    }

    const denyBtn = kbd(mkBtn('deny', `❌ ${tr('perm.denyShort')}`, 'pc-deny'), 'N');
    denyBtn.addEventListener('click', async () => {
      for (const x of modalCard.querySelectorAll('button')) x.disabled = true;
      denyBtn.textContent = tr('perm.sending');
      await decide(p.id, 'deny', { sess: sessId });
    });
    acts.append(denyBtn);

    if (state.isLocal && s) {
      const openBtn = kbd(el('button', 'pc-skip', tr('perm.openIdeShort')), 'O');
      openBtn.type = 'button';
      openBtn.addEventListener('click', () => openWindowOf(s));
      acts.append(openBtn);
    }

    if (phone && risky) acts.append(el('small', 'pc-phone-note', tr('perm.riskyOnMac')));
    if (risky) {
      modalCard.classList.add('wait-modal--danger');
      modalCard.dataset.risky = '1';
    }

    const detailBox = el('pre', 'pc-detail', p.detail || p.label || p.tool || '');
    modalCard.append(
      el('p', 'wait-section-lead', tr('perm.permSubtitle')),
      detailBox,
      risky ? el('p', 'pc-danger', tr('perm.dangerNote', { reason: risky })) : '',
      !risky && ruleText ? el('p', 'pc-rule', tr('perm.ruleNote', { rule: ruleText })) : '',
      acts,
      bar,
    );
  }

  if (!state.isLocal && !state.phoneApprove && !DEMO) {
    acts.replaceChildren(el('small', 'pc-phone-note', tr('perm.phoneOff')));
  }

  modalCard._tick = () => {
    if (p.until && p.until > Date.now()) {
      const ms = Math.max(0, p.until - Date.now());
      leftTimer.textContent = tr('time.sec', { n: Math.ceil(ms / 1000) });
      fill.style.width = `${Math.min(100, (ms / 45000) * 100)}%`;
    } else {
      leftTimer.textContent = '';
      fill.style.width = '100%';
    }
  };
  modalCard._tick();
  return modalCard;
}

export function renderFocusedWaitModal(force = false) {
  const modal = ensureWaitModalEl();
  const sessId = activeWaitSessId || state.selectedId;
  const card = sessId ? getSessionWaitCard(sessId) : null;
  if (!card) {
    if (!modal.hidden) closeWaitModal(false);
    return;
  }
  if (!force && dismissedCardIds.get(sessId) === card.id) {
    return;
  }
  // Critical: do NOT recreate DOM if the modal is already open and displaying the exact same card.id!
  if (!modal.hidden && activeModalCardId === card.id && modal.children.length > 0) {
    modal.firstElementChild?._tick?.();
    return;
  }
  stopActiveMic?.();
  stopActiveMic = null;
  activeModalCardId = card.id;
  activeWaitSessId = sessId;
  const domCard = buildFocusedWaitCard(card, sessId);
  modal.replaceChildren(domCard);
  modal.hidden = false;
}

export function openWaitModalFor(sessId, focusInput = false) {
  if (!sessId) return;
  activeWaitSessId = sessId;
  if (focusInput) dismissedCardIds.delete(sessId);
  renderFocusedWaitModal(focusInput);
  if (focusInput) {
    setTimeout(() => {
      const modal = $('wait-focus-modal');
      const inp = modal?.querySelector('textarea.wait-composer-in, input.pq-other');
      inp?.focus();
    }, 40);
  }
}

export function buildInlineWaitBanner(sessId) {
  const card = getSessionWaitCard(sessId);
  if (!card) return null;
  const kind = card.kind === 'ask' || card.kind === 'plan' ? card.kind : 'perm';
  const banner = el('div', `ds-wait-banner ds-wait-banner--${kind}`);
  banner.id = 'ds-wait-banner';
  banner.dataset.cardId = card.id;

  const head = el('div', 'ds-wb-head');
  const titleText = kind === 'plan'
    ? `📄 Kế hoạch cần duyệt: ${card.label || card.file || 'implementation_plan.md'}`
    : kind === 'ask'
      ? `❓ Câu hỏi cần phản hồi: ${card.label || 'Cần phản hồi để tiếp tục'}`
      : `🛠️ Lệnh chờ phê duyệt: ${card.label || card.tool || 'Quyền thực thi'}`;
  head.append(el('b', 'ds-wb-title', titleText));

  const summaryText = kind === 'plan'
    ? (card.planSummary || card.detail || card.plan || 'Phiên làm việc đã lập kế hoạch và đang chờ bạn phê duyệt.')
    : kind === 'ask'
      ? (card.questions?.[0]?.question || card.detail || 'Phiên làm việc đang tạm dừng chờ câu trả lời của bạn.')
      : (card.detail || card.label || 'Phiên làm việc đang chờ quyền chạy công cụ.');
  const summaryEl = el('p', 'ds-wb-summary', String(summaryText).slice(0, 360));

  const acts = el('div', 'ds-wb-acts');
  const openModalBtn = el('button', 'btn btn--sm ds-wb-btn-open', '⚡ Mở khung trả lời & duyệt chi tiết');
  openModalBtn.type = 'button';
  openModalBtn.addEventListener('click', () => openWaitModalFor(sessId, true));

  const approveNowBtn = el('button', 'btn btn--sm btn--confirm ds-wb-btn-approve', '✅ Duyệt & Tiếp tục ngay');
  approveNowBtn.type = 'button';

  const quickForm = el('form', 'ds-wb-form');
  const quickIn = el('input', 'ds-wb-input');
  quickIn.type = 'text';
  quickIn.maxLength = 1000;
  quickIn.placeholder = kind === 'plan'
    ? 'Nhập góp ý sửa kế hoạch hoặc để trống rồi bấm Duyệt...'
    : 'Nhập câu trả lời nhanh cho Antigravity...';
  quickIn.addEventListener('keydown', (e) => e.stopPropagation());
  const quickSendBtn = el('button', 'btn btn--sm btn--confirm ds-wb-send', 'Gửi');
  quickSendBtn.type = 'submit';
  quickForm.append(quickIn, quickSendBtn);

  const submitQuick = async (isApproveBtn = false) => {
    const text = quickIn.value.trim();
    openModalBtn.disabled = approveNowBtn.disabled = quickSendBtn.disabled = quickIn.disabled = true;
    if (kind === 'plan') {
      const choice = (!isApproveBtn && text) ? 'revise' : 'approve';
      await decide(card.id, choice, { sess: sessId, feedback: text, note: text, text });
    } else if (kind === 'ask') {
      const ansText = text || '(Recommended) Đồng ý & Tiếp tục thực hiện';
      await decide(card.id, 'answer', {
        sess: sessId,
        feedback: ansText,
        note: ansText,
        text: ansText,
        answers: [{ q: 0, a: [ansText], pick: text ? [] : [0], labels: text ? [] : [ansText], other: text }],
      });
    } else {
      if (text) {
        await decide(card.id, 'answer', {
          sess: sessId,
          feedback: text,
          note: text,
          text,
          answers: [{ q: 0, a: [text], other: text }],
        });
      } else {
        await decide(card.id, 'allow', { sess: sessId });
      }
    }
  };

  approveNowBtn.addEventListener('click', () => submitQuick(true));
  quickForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitQuick(false);
  });

  acts.append(openModalBtn, approveNowBtn);
  banner.append(head, summaryEl, acts, quickForm);
  return banner;
}

export function closeWaitModal(minimize = true) {
  if (minimize && activeWaitSessId) {
    const card = getSessionWaitCard(activeWaitSessId);
    if (card?.id) dismissedCardIds.set(activeWaitSessId, card.id);
  }
  stopActiveMic?.();
  stopActiveMic = null;
  activeModalCardId = null;
  activeWaitSessId = null;
  const modal = $('wait-focus-modal');
  if (modal) {
    modal.hidden = true;
    modal.replaceChildren();
  }
}

export function syncSessionWaitCards() {
  let changed = false;
  for (const k of dismissedCardIds.keys()) if (!sessions.has(k)) dismissedCardIds.delete(k);
  for (const s of sessions.values()) {
    const card = getSessionWaitCard(s.id);
    if (card && s.status === 'wait') {
      if (!alertedCardIds.has(card.id)) {
        if (alertedCardIds.size > 300) alertedCardIds.delete(alertedCardIds.values().next().value);
        alertedCardIds.add(card.id);
        sfx.play('perm');
        changed = true;
      }
      const w = workers.get(s.id);
      if (w && w.anim !== 'hand') {
        w.anim = 'hand';
        changed = true;
      }
    } else if (!card && dismissedCardIds.has(s.id)) {
      dismissedCardIds.delete(s.id);
      changed = true;
    }
  }
  if (state.selectedId) {
    const card = getSessionWaitCard(state.selectedId);
    if (card) {
      if (dismissedCardIds.get(state.selectedId) !== card.id) {
        activeWaitSessId = state.selectedId;
        renderFocusedWaitModal(false);
      }
    } else if (activeWaitSessId === state.selectedId) {
      closeWaitModal(false);
      changed = true;
    }
  } else if (activeWaitSessId && !getSessionWaitCard(activeWaitSessId)) {
    closeWaitModal(false);
    changed = true;
  }
  if (changed) queueUi();
}

export function renderPerms() {
  const stack = $('perm-stack');
  if (stack) {
    const adminPerms = [...perms.values()].filter(isAdminPerm);
    const adminIds = new Set(adminPerms.map((p) => p.id));
    const have = new Set([...stack.children].map((c) => c.dataset.id));
    for (const c of [...stack.children]) if (!adminIds.has(c.dataset.id)) c.remove();
    for (const p of adminPerms) if (!have.has(p.id)) stack.append(permCard(p));
    stack.hidden = !adminPerms.length;
  }
  syncSessionWaitCards();
}

export function addPerm(p) {
  if (!p || !p.id) return;
  perms.set(p.id, p);
  if (isAdminPerm(p)) {
    renderPerms();
    queueUi();
    sfx.play('perm');
    return;
  }
  if (!alertedCardIds.has(p.id)) {
    if (alertedCardIds.size > 300) alertedCardIds.delete(alertedCardIds.values().next().value);
    alertedCardIds.add(p.id);
    sfx.play('perm');
  }
  const w = workers.get(p.sess);
  if (w) {
    w.anim = 'hand';
    if (!state.selectedId && autoCam()) panTo(w);
  }
  renderPerms();
  queueUi();
  if (state.selectedId === p.sess) {
    openWaitModalFor(p.sess, false);
    renderSessionHead();
  }
}

export const onPerm = addPerm;

export function removePerm(id) {
  perms.delete(id);
  for (const s of sessions.values()) {
    if (s.waitCard?.id === id) {
      dismissedCardIds.delete(s.id);
      s.waitCard = null;
    }
  }
  if (activeModalCardId === id) closeWaitModal(false);
  renderPerms();
  queueUi();
  if (state.selectedId) renderSessionHead();
}

export function clearPerms() {
  perms.clear();
  renderPerms();
  queueUi();
}

export function syncPerms(list = []) {
  perms.clear();
  for (const p of list) if (p?.id) perms.set(p.id, p);
  renderPerms();
  queueUi();
}

export function setup() {
  state.permOn = true;
  state.sessions = sessions;
  try { state.permOn = localStorage.getItem('office-perm') !== 'off'; } catch { /* storage blocked */ }
  PAGE_ID = Math.random().toString(36).slice(2, 10);
  ensureWaitModalEl();
  for (const ev of ['focus', 'blur', 'visibilitychange']) addEventListener(ev, reportPresence);
  if (!STATIC) addEventListener('pagehide', () => { try { navigator.sendBeacon(`/api/presence${TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : ''}`, new Blob([JSON.stringify({ page: PAGE_ID, focused: false })], { type: 'application/json' })); } catch { /* ignore */ } });
  setInterval(() => { if (document.hasFocus()) reportPresence(); }, 10000);
  setInterval(() => {
    if (!perms.size && !activeModalCardId) return;
    const stack = $('perm-stack');
    if (stack && !stack.hidden) for (const c of stack.children) c._tick?.();
    if (activeModalCardId) {
      const modal = $('wait-focus-modal');
      if (modal && !modal.hidden) modal.firstElementChild?._tick?.();
    }
  }, 250);
  $('perm-stack').addEventListener('click', async (ev) => {
    const ab = ev.target.closest('[data-access]');
    if (ab) {
      const card = ab.closest('.perm-card'), id = card.dataset.id, act = ab.dataset.access;
      const payload = card._accessPayload?.(act);
      if (!payload) return;
      for (const x of card.querySelectorAll('button, input, textarea')) x.disabled = true;
      ab.textContent = tr('perm.sending');
      try {
        const r = await fetch('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const d = await r.json();
        if (d?.ok) {
          state.access = d;
          state.requireTaskApproval = !!d.requireTaskApproval;
          toast(
            act === 'approveMember' ? '✅ Đã duyệt quyền truy cập & phân quyền Workspace!' :
            act === 'rejectMember' ? '❌ Đã từ chối quyền truy cập.' :
            act === 'rejectTask' ? '❌ Đã từ chối công việc.' :
            '🚀 Đã duyệt và giao việc cho Agent thực hiện!',
          );
          if (!$('phone-modal').hidden) renderPhone();
          renderViewerBadge();
        } else {
          toast(d?.message || tr('perm.expired'));
        }
      } catch {
        toast(tr('perm.unreachable'));
      }
      perms.delete(id);
      renderPerms();
      return;
    }
    const b = ev.target.closest('[data-perm]'); if (!b) return;
    const card = b.closest('.perm-card'), id = card.dataset.id, choice = b.dataset.perm;
    if (card.dataset.risky === '1' && choice === 'allow' && b.dataset.armed !== '1') {
      b.dataset.armed = '1'; b.firstChild.textContent = tr('perm.allowAgain');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.firstChild.textContent = tr('perm.allow'); } }, 4000);
      return;
    }
    for (const x of card.querySelectorAll('button, input')) x.disabled = true;
    b.textContent = tr('perm.sending');
    await decide(id, choice, card._payload?.() || {});
  });
  document.addEventListener('keydown', (e) => {
    const modal = $('wait-focus-modal');
    if (e.key === 'Escape' && modal && !modal.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeWaitModal(true);
      return;
    }
    if (e.code === 'KeyO' && state.selectedId && state.isLocal && !e.metaKey && !e.ctrlKey && !e.altKey && !fp.on && !e.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
      const s = sessions.get(state.selectedId);
      if (s) { e.preventDefault(); openWindowOf(s); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || fp.on || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const k = { KeyY: 'allow', KeyN: 'deny', KeyA: 'always' }[e.code];
    if (!k) return;
    if (modal && !modal.hidden) {
      const card = modal.querySelector('.wait-modal-card[data-kind="perm"]');
      const b = card?.querySelector(`[data-perm="${k}"]`);
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  }, true);
}
