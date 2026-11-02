// Phone modal, notifications, the night switch.
import { state } from '../core/state.js';
import { $, el, replay, small } from '../core/env.js';
import { dn } from '../people/workers.js';
import { night, setNight } from '../world/room-update.js';
import { toast } from './activity.js';
import { closeSession, drM, drS, openSession } from './session-drawer.js';
import { closeMac, isAssistantRestricted, renderLimits } from './mac-drawer.js';
export { renderLimits };
import { closePlace, plcState } from '../interact/place-cards.js';
import { popLook, togglePlan, togglePop } from './settings.js';
import { exitFp, fp } from '../interact/first-person.js';
import { closeTimeline } from '../replay/timeline.js';
import { t as tr } from '../../i18n/index.js';

export let bellOn = false;
export function renderBell() { $('btn-bell').setAttribute('aria-pressed', String(bellOn)); }
export function notifyWait(s, e) {
  if (replay.on) return;
  if (!bellOn || document.visibilityState === 'visible' && document.hasFocus()) return;
  try { const n = new Notification(tr('topbar.waitTitle', { name: dn(s) }), { body: e.label || tr('topbar.waitBody'), tag: 'wait-' + s.id }); n.onclick = () => { window.focus(); openSession(s.id); n.close(); }; } catch { /* unsupported */ }
}

/* ---------- the phone window: the two ways in (the home network, or anywhere through the Cloudflare tunnel) as tabs, each
   with its switch, its QR code and address; the PIN; and what phones may do (approve, give Claude work, Remote Control),
   each a switch with a line on what it means. Everything is switched here, on the Mac: nothing to type in a terminal. ---------- */
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null);
// a row with a switch: what it is (bold), a line on what it means, the switch on the right
function phoneSwitch(text, on, disabled, fn, desc = '') {
  const row = el('label', 'pm-approve pm-toggle'), cb = el('input'), words = el('span', 'pm-tt');
  cb.type = 'checkbox'; cb.checked = on; cb.disabled = disabled; cb.setAttribute('role', 'switch');
  cb.addEventListener('change', async () => { cb.disabled = true; if (!(await fn(cb.checked))) { cb.checked = !cb.checked; cb.disabled = false; } });
  words.append(el('b', null, text)); if (desc) words.append(el('small', null, desc));
  row.append(words, cb);
  return row;
}
// 123 456, 1234 5678, 123 4567, 123 456 7890
const pinFmt = (p) => (p.length % 4 === 0 && p.length % 3 ? p.match(/\d{4}/g).join(' ') : p.replace(/\d{3}(?=\d{2})/g, '$& '));
let tun = null, tunPoll = 0;   // the tunnel's state (GET /api/tunnel), asked again while it starts
let pmTab = null;              // the way in shown: 'home' | 'away' (null: the tunnel's if it is on)
async function loadTunnel() {
  tun = await fetch('/api/tunnel').then((r) => r.json()).catch(() => null);
  if (tun) {
    if ('lan' in tun) state.lanUrl = tun.lan || null;
    if ('lanBase' in tun) state.lanBase = tun.lanBase || null;
    if ('ts' in tun) state.tsUrl = tun.ts || null;
    if (tun.pin) state.phonePin = tun.pin;
    if ('lanFixed' in tun) state.lanFixed = !!tun.lanFixed;
  }
  clearTimeout(tunPoll);
  if (tun && ['download', 'starting'].includes(tun.state) && !$('phone-modal').hidden) tunPoll = setTimeout(() => loadTunnel().then(renderPhone), 1500);
}
// an address to open: as text you can select, and a button that copies it
function urlRow(url) {
  const row = el('div', 'pm-urlrow'), copy = el('button', 'btn btn--sm', tr('topbar.phone.copy')); copy.type = 'button';
  copy.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast(tr('topbar.phone.copied')), () => {}));
  row.append(el('b', 'url pm-url', url), copy);
  return row;
}
let lastViewerSig = '';
export function renderViewerBadge() {
  const restricted = isAssistantRestricted();
  const btnMac = $('btn-mac');
  if (btnMac && btnMac.hidden !== restricted) btnMac.hidden = restricted;
  if (restricted) { const drMac = $('dr-mac'); if (drMac && !drMac.hidden) drMac.hidden = true; }
  const btnLook = $('btn-look');
  if (btnLook && btnLook.hidden) btnLook.hidden = false;
  const btnReplay = $('btn-replay');
  if (btnReplay && btnReplay.hidden) btnReplay.hidden = false;
  const btnTop = $('btn-phone-top');
  if (btnTop) {
    if (btnTop.hidden) btnTop.hidden = false;
    if (state.isLocal) {
      const pendMembers = (state.access?.members || []).filter((m) => m.status === 'pending').length;
      const pendTasks = (state.access?.pendingTasks || []).length;
      const total = pendMembers + pendTasks;
      const sig = `local:${total}`;
      if (sig === lastViewerSig) return;
      lastViewerSig = sig;
      let badge = $('phone-top-badge');
      if (!badge) {
        badge = el('i', 'tb-badge');
        badge.id = 'phone-top-badge';
        btnTop.append(badge);
      }
      badge.hidden = total === 0;
      badge.textContent = total > 9 ? '9+' : String(total);
      btnTop.title = total > 0 ? `Từ xa & Phân quyền (${total} yêu cầu chờ duyệt)` : tr('ui.topBar.phoneTitle');
    } else if (state.viewer) {
      const isDirDev = state.viewer.isDirectorDevice || state.viewer.role === 'Phó Giám đốc';
      const sig = `remote:${isDirDev ? 1 : 0}:${state.viewer.role || ''}:${state.viewer.name || ''}:${state.requireTaskApproval ? 1 : 0}`;
      if (sig === lastViewerSig) return;
      lastViewerSig = sig;
      btnTop.classList.remove('tb-icon');
      btnTop.replaceChildren(
        el('span', null, `${isDirDev ? '👔' : '💼'} ${state.viewer.role || 'Trợ lý Giám đốc'}: ${state.viewer.name || 'Từ xa'}`),
      );
      btnTop.title = isDirDev
        ? 'Thiết bị chính chủ Giám đốc (Phó Giám đốc) · Toàn quyền dự án & Giao việc trực tiếp'
        : state.requireTaskApproval
          ? 'Chế độ: Giám đốc duyệt trước khi Agent thực hiện'
          : 'Chế độ: Giao việc trực tiếp';
    }
  }
}

function renderAccessSection(body) {
  const acc = state.access || { requireTaskApproval: true, roles: ['Trợ lý Giám đốc'], workspaces: [], members: [], pendingTasks: [] };
  const sec = el('div', 'pm-access');
  sec.append(el('h4', 'pm-h', '👔 Phân quyền Tailscale & Trợ lý Giám đốc'));

  // 1. Master toggle: require Director approval before conversation/task execution
  sec.append(phoneSwitch(
    '🛡️ Duyệt trước khi Agent thực hiện công việc (Task Approval)',
    !!acc.requireTaskApproval,
    false,
    async (want) => {
      const r = await post('/api/access', { action: 'setRequireTaskApproval', on: want });
      if (!r?.ok) return false;
      state.access = r;
      state.requireTaskApproval = !!r.requireTaskApproval;
      toast(want ? '🛡️ Đã BẬT chế độ duyệt trước khi Agent chạy task từ xa' : '⚡ Đã TẮT chế độ chờ duyệt — Trợ lý giao việc chạy ngay');
      renderPhone();
      renderViewerBadge();
      return true;
    },
    'Khi BẬT: Mọi task/conversation do Trợ lý Giám đốc giao từ xa sẽ hiện thẻ chờ bạn duyệt trước khi Agent thực hiện. Khi TẮT: Chạy ngay lập tức.',
  ));

  // 2. Pending Tasks Queue
  const pTasks = acc.pendingTasks || [];
  if (pTasks.length > 0) {
    const qBox = el('div', 'pm-qbox');
    qBox.append(el('b', 'pm-qh', `⏳ Công việc đang chờ Giám đốc duyệt (${pTasks.length})`));
    for (const t of pTasks) {
      const item = el('div', 'pm-qitem');
      const head = el('div', 'pm-qhead');
      head.append(
        el('b', null, `👔 ${t.memberRole || 'Trợ lý Giám đốc'} · ${t.memberName}`),
        el('span', 'muted', `→ 📁 ${t.targetName}`),
      );
      const ta = el('textarea', 'pm-qtext');
      ta.rows = 2;
      ta.value = t.text || '';
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      const acts = el('div', 'pm-qacts');
      const okBtn = el('button', 'btn btn--sm btn--confirm', '✅ Duyệt & Chạy ngay');
      okBtn.type = 'button';
      const fastBtn = el('button', 'btn btn--sm', '⚡ Duyệt & Tắt chờ duyệt');
      fastBtn.type = 'button';
      const noBtn = el('button', 'btn btn--sm pm-btn-danger', '❌ Từ chối');
      noBtn.type = 'button';
      const decide = async (decision, disableRequireApproval = false) => {
        okBtn.disabled = fastBtn.disabled = noBtn.disabled = true;
        const r = await post('/api/access', { action: 'decideTask', id: t.id, decision, text: ta.value, disableRequireApproval });
        if (r?.ok) {
          state.access = r;
          state.requireTaskApproval = !!r.requireTaskApproval;
          toast(decision === 'approve' ? '🚀 Đã duyệt và giao việc cho Agent!' : '❌ Đã từ chối yêu cầu công việc.');
          renderPhone();
          renderViewerBadge();
        } else {
          toast(r?.message || tr('drawer.unreachable'));
          okBtn.disabled = fastBtn.disabled = noBtn.disabled = false;
        }
      };
      okBtn.addEventListener('click', () => decide('approve', false));
      fastBtn.addEventListener('click', () => decide('approve', true));
      noBtn.addEventListener('click', () => decide('reject', false));
      acts.append(okBtn, fastBtn, noBtn);
      item.append(head, ta, acts);
      qBox.append(item);
    }
    sec.append(qBox);
  }

  // 3. Connected / Pending Remote Members & Workspace Scoping
  const members = acc.members || [];
  const allWs = acc.workspaces || [];
  const mWrap = el('div', 'pm-members');
  mWrap.append(el('b', 'pm-qh', `👥 Danh sách người truy cập & Phân quyền Workspace (${members.length})`));

  const dl = el('datalist');
  dl.id = 'pm-role-list';
  for (const rName of acc.roles || ['Trợ lý Giám đốc', 'Trưởng nhóm', 'Kỹ sư AI', 'Quản lý Dự án', 'Khách xem']) {
    const opt = el('option');
    opt.value = rName;
    dl.append(opt);
  }
  mWrap.append(dl);

  if (!members.length) {
    mWrap.append(el('p', 'muted pm-note', 'Chưa có người truy cập từ xa. Khi đồng nghiệp mở link Tailscale/LAN, họ sẽ gửi yêu cầu (hoặc nhập mã PIN) và xuất hiện tại đây để bạn duyệt vai trò "Trợ lý Giám đốc" và giới hạn các Workspace được phép nhìn thấy.'));
  }

  for (const m of members) {
    const card = el('div', `pm-mcard pm-mcard--${m.status || 'pending'}`);
    const top = el('div', 'pm-mtop');
    const stBadge = el('span', `pm-mbadge pm-mbadge--${m.status || 'pending'}`, m.status === 'approved' ? '🟢 Đã cấp quyền' : m.status === 'rejected' ? '🔴 Đã từ chối' : '🟠 Đang chờ duyệt');
    top.append(stBadge, el('small', 'muted', `IP: ${m.ip || 'Tailscale'}`));
    if (m.note) top.append(el('small', 'muted', `· "${m.note}"`));

    const fields = el('div', 'pm-mfields');
    const nameIn = el('input', 'pm-minput');
    nameIn.type = 'text';
    nameIn.value = m.name || 'Trợ lý Giám đốc';
    nameIn.placeholder = 'Tên hiển thị';
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());

    const roleIn = el('input', 'pm-minput');
    roleIn.type = 'text';
    roleIn.setAttribute('list', 'pm-role-list');
    roleIn.value = m.role || 'Trợ lý Giám đốc';
    roleIn.placeholder = 'Vai trò (VD: Trợ lý Giám đốc)';
    roleIn.addEventListener('keydown', (e) => e.stopPropagation());
    fields.append(nameIn, roleIn);

    const wsTitle = el('small', 'pm-mwstitle', '📁 Workspaces được phép nhìn thấy & giao việc:');
    const wsGrid = el('div', 'pm-mwsgrid');
    const picked = new Set((m.allowedWorkspaces || []).map((x) => String(x).toLowerCase()));
    const checkboxes = [];
    const saveMemberPerms = async (quietToast = false) => {
      const allowedWorkspaces = checkboxes.filter((c) => c.checked).map((c) => c.value);
      const action = m.status === 'approved' ? 'updateMember' : 'approveMember';
      const r = await post('/api/access', {
        action,
        id: m.id,
        name: nameIn.value.trim() || 'Trợ lý Giám đốc',
        role: roleIn.value.trim() || 'Trợ lý Giám đốc',
        allowedWorkspaces,
        status: 'approved',
      });
      if (r?.ok) {
        state.access = r;
        toast(`✅ Đã lưu quyền cho ${roleIn.value.trim() || 'Trợ lý Giám đốc'}: ${nameIn.value.trim()} (${allowedWorkspaces.length} Workspace)`);
        if (!quietToast) renderPhone();
        renderViewerBadge();
      } else {
        toast(r?.message || tr('drawer.unreachable'));
      }
      return r;
    };
    for (const w of allWs) {
      const lbl = el('label', 'pm-mws');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = w.dir;
      const wLower = String(w.dir).toLowerCase();
      const isMatched = picked.has('*') || [...picked].some((p) => p === wLower || p.startsWith(wLower + '\\') || (wLower.length > 3 && wLower.startsWith(p + '\\')));
      cb.checked = m.status === 'pending' && !m.allowedWorkspaces?.length ? true : isMatched;
      if (m.status === 'approved') {
        cb.addEventListener('change', () => { saveMemberPerms(true); });
      }
      lbl.title = w.dir;
      lbl.append(cb, el('span', null, w.name));
      checkboxes.push(cb);
      wsGrid.append(lbl);
    }

    const acts = el('div', 'pm-qacts');
    const saveBtn = el('button', 'btn btn--sm btn--confirm', m.status === 'approved' ? '💾 Lưu phân quyền' : '✅ Duyệt & Cấp quyền');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      await saveMemberPerms(false);
      saveBtn.disabled = false;
    });

    const delBtn = el('button', 'btn btn--sm pm-btn-danger', '🗑️ Xóa');
    delBtn.type = 'button';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const r = await post('/api/access', { action: 'removeMember', id: m.id });
      if (r?.ok) {
        state.access = r;
        toast('🗑️ Đã xóa quyền truy cập.');
        renderPhone();
        renderViewerBadge();
      } else {
        delBtn.disabled = false;
      }
    });

    acts.append(saveBtn, delBtn);
    card.append(top, fields, wsTitle, wsGrid, acts);
    mWrap.append(card);
  }

  sec.append(mWrap);
  body.append(sec);
}

export function renderPhone() {
  const body = $('pm-body'); body.replaceChildren();
  if (!state.isLocal) { phoneSide(body); return; }
  const qr = (text) => { const box = el('div', 'qr'); try { new window.QRCode(box, { text, width: 132, height: 132 }); } catch { return el('span'); } return box; };
  // the code beside the address and what to do with it
  const where = (code, shown, lead, foot) => { const row = el('div', 'pm-where'), info = el('div', 'pm-info'); info.append(el('p', 'muted', lead), urlRow(shown)); if (foot) info.append(el('p', 'muted pm-note', foot)); row.append(qr(code), info); return row; };
  const lanOn = !!(state.lanUrl || state.tsUrl || tun?.lanOn), tunOn = !!tun?.on, tab = pmTab || (tunOn ? 'away' : 'home');
  // 1. the two ways in, as tabs (a dot: on)
  const tabs = el('div', 'pm-tabs'); tabs.setAttribute('role', 'tablist');
  for (const [k, on] of [['home', lanOn], ['away', tunOn]]) {
    const b = el('button', `pm-tab${k === tab ? ' is-sel' : ''}`); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(k === tab));
    b.append(el('span', null, tr(k === 'home' ? 'topbar.phone.tabHome' : 'topbar.phone.tabAway')), el('i', `pm-dot${on ? ' is-on' : ''}`, tr(on ? 'topbar.phone.isOn' : 'topbar.phone.isOff')));
    b.addEventListener('click', () => { pmTab = k; renderPhone(); });
    tabs.append(b);
  }
  const conn = el('div', 'pm-conn');
  body.append(tabs, conn);
  if (tab === 'home') {   // the home network: the Mac's own addresses (and its Tailscale one)
    conn.append(phoneSwitch(tr('topbar.phone.lanSwitch'), lanOn, !!state.lanFixed, async (want) => {
      const r = await post('/api/lan', { on: want }); if (!r?.ok) return false;
      state.lanUrl = r.lan; state.lanBase = r.lanBase; state.tsUrl = r.ts; state.phonePin = r.pin; state.lanFixed = r.fixed;
      if (tun) tun.lanOn = want;
      renderPhone(); return true;
    }));
    if (!lanOn) conn.append(el('p', 'muted pm-note', tr('topbar.phone.lanOffNote')));
    else {
      if (state.lanFixed) conn.append(el('p', 'muted pm-note', tr('topbar.phone.lanFixed')));
      if (state.lanUrl) {
        conn.append(where(state.lanUrl, state.lanBase || state.lanUrl, tr('topbar.phone.scan')));
        conn.append(el('p', 'muted pm-note', '📶 Lưu ý khi dùng điện thoại qua Wi-Fi Ket: Vì cục phát Wi-Fi Ket là mạng nội bộ (không có Internet), điện thoại bật sẵn 4G/5G hoặc VPN/Tailscale sẽ tự động đẩy truy cập sang mạng 4G làm không vào được. Hãy tạm TẮT 4G/5G (Dữ liệu di động) và VPN trên điện thoại (hoặc chọn «Giữ kết nối Wi-Fi») rồi quét mã / mở địa chỉ trên.'));
      } else {
        conn.append(el('p', 'muted pm-note', '⚠️ Máy tính hiện chưa có IP trên mạng Wi-Fi Ket. Hãy kiểm tra kết nối Wi-Fi Ket.'));
      }
      if (state.tsUrl) conn.append(where(state.tsUrl, state.tsUrl, tr('topbar.phone.tsOn')));
    }
  } else {                // anywhere: the Cloudflare tunnel
    conn.append(phoneSwitch(tr('topbar.phone.tunSwitch'), tunOn, ['download', 'starting'].includes(tun?.state), async (want) => {
      const r = await post('/api/tunnel', { on: want }); if (!r?.ok) return false;
      tun = r; renderPhone(); if (want) loadTunnel().then(renderPhone); return true;
    }));
    if (!tunOn) conn.append(el('p', 'muted pm-note', tr('topbar.phone.tunOffNote')));
    else if (tun.state === 'on' && tun.url) conn.append(where(tun.url, tun.url, tr('topbar.phone.tunOn'), tr('topbar.phone.tunNote')));
    else if (tun.state === 'error') conn.append(el('p', 'pm-err', tr('topbar.phone.tunError', { error: tun.error || '' })));
    else conn.append(el('p', 'muted pm-wait', tr(tun.state === 'download' ? 'topbar.phone.tunDownload' : 'topbar.phone.tunStarting')));
    // the Mac kept awake while it's on (the power adapter only): what that means right now
    if (tunOn && tun.awake) conn.append(el('p', `pm-awake${tun.awake.ac === false ? ' is-battery' : ''}`, tr(tun.awake.ac === false ? 'topbar.phone.awakeBattery' : 'topbar.phone.awakeOn')));
  }
  // 2. the PIN, for either way in; a new one signs every phone out
  const pinNow = tun?.pin || state.phonePin;
  if ((lanOn || tunOn) && pinNow) {
    const box = el('div', 'pm-pinbox'), pin = el('div', 'pm-pin'), again = el('button', 'btn btn--sm pm-newpin', tr('topbar.phone.newPin')); again.type = 'button'; again.title = tr('topbar.phone.newPinTitle');
    again.addEventListener('click', async () => {
      if (again.dataset.armed !== '1') { again.dataset.armed = '1'; again.textContent = tr('topbar.phone.newPinSure'); setTimeout(() => { if (again.isConnected) { again.dataset.armed = ''; again.textContent = tr('topbar.phone.newPin'); } }, 4000); return; }
      const r = await post('/api/pin', {}); if (r?.ok) { state.phonePin = r.pin; if (tun) tun.pin = r.pin; renderPhone(); }
    });
    // your own (6–10 digits; the server turns down one like 000000 or 123456)
    const own = el('button', 'btn btn--sm', tr('topbar.phone.setPin')); own.type = 'button';
    own.addEventListener('click', () => {
      const form = el('form', 'pm-pin pm-setpin'), field = el('input', 'pm-pinin'), err = el('p', 'pm-err');
      field.inputMode = 'numeric'; field.maxLength = 10; field.autocomplete = 'off'; field.placeholder = tr('topbar.phone.setPinHint'); field.setAttribute('aria-label', tr('topbar.phone.setPin'));
      field.addEventListener('input', () => { field.value = field.value.replace(/\D/g, '').slice(0, 10); });
      field.addEventListener('keydown', (e) => e.stopPropagation());
      const save = el('button', 'btn btn--sm btn--confirm', tr('topbar.phone.save')), cancel = el('button', 'btn btn--sm', tr('topbar.phone.cancel'));
      save.type = 'submit'; cancel.type = 'button'; cancel.addEventListener('click', renderPhone); err.hidden = true;
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); save.disabled = true;
        const r = await post('/api/pin', { pin: field.value }); save.disabled = false;
        if (r?.ok) { state.phonePin = r.pin; if (tun) tun.pin = r.pin; renderPhone(); toast(tr('topbar.phone.pinSaved')); return; }
        err.textContent = r?.message || tr('drawer.unreachable'); err.hidden = false; field.focus();
      });
      form.append(field, save, cancel); pin.replaceWith(form); form.after(err); field.focus();
    });
    const btns = el('span', 'pm-pinacts'); btns.append(again, own);
    pin.append(el('span', 'pm-pinlabel', tr('topbar.phone.pinTitle')), el('b', 'pm-digits', pinFmt(pinNow)), btns);
    box.append(pin, el('p', 'muted pm-note', tr('topbar.phone.pinNote')));
    body.append(box);
  }
  // 2b. Tailscale Remote Access, Roles ("Trợ lý Giám đốc"), Workspace Scoping & Pre-Execution Task Approval
  renderAccessSection(body);
  // 3. what phones may do: each off until switched on here (the server takes these switches from the Mac only)
  const list = el('div', 'pm-list');
  list.append(phoneSwitch(tr('topbar.phone.approve'), !!state.phoneApprove, false, async (want) => { const r = await post('/api/phone', { approve: want }); if (!r?.ok) return false; state.phoneApprove = r.approve; renderPhone(); return true; }, tr('topbar.phone.approveShort')));
  // "Giao việc" from the group chat on a phone: a new Claude Code run on this Mac (server/tasks.mjs)
  if (tun) list.append(phoneSwitch(tr('topbar.phone.tasksSwitch'), !!tun.tasks, false, async (want) => { const r = await post('/api/tasks/allow', { on: want }); if (!r?.ok) return false; tun.tasks = r.allowed; renderPhone(); return true; }, tr('topbar.phone.tasksShort')));
  // Claude Code's own Remote Control, on by itself in every new session if you like
  if (tun) list.append(phoneSwitch(tr('topbar.phone.rcSwitch'), !!tun.rc, false, async (want) => { const r = await post('/api/rc', { on: want }); if (!r?.ok) return false; tun.rc = r.rc; renderPhone(); return true; }, tr(tun.rc ? 'topbar.phone.rcShortOn' : 'topbar.phone.rcShort')));
  body.append(el('h4', 'pm-h', tr('topbar.phone.mayTitle')), list);
}

// The same window on a phone: changing the PIN (with the one it has now), and what the Mac allows phones (switched there)
function phoneSide(body) {
  if (state.viewer) {
    const vBox = el('div', 'pm-pinbox');
    vBox.append(
      el('b', null, `👔 Vai trò: ${state.viewer.role || 'Trợ lý Giám đốc'} · ${state.viewer.name || 'Từ xa'}`),
      el('p', 'muted pm-note', state.requireTaskApproval
        ? '🛡️ Chế độ: Mọi công việc (task) bạn giao sẽ được gửi tới Giám đốc duyệt trước khi Agent thực hiện.'
        : '⚡ Chế độ: Công việc bạn giao được Agent thực hiện ngay lập tức.'),
      el('p', 'muted pm-note', `📁 Workspace được phép truy cập: ${(state.viewer.allowedWorkspaces || []).map((d) => String(d).split(/[\\/]/).filter(Boolean).pop() || d).join(', ') || 'Theo phân quyền Giám đốc'}`),
    );
    body.append(vBox);
  }
  const form = el('form', 'pm-setpin pm-side'), now = el('input', 'pm-pinin'), next = el('input', 'pm-pinin'), err = el('p', 'pm-err');
  for (const [f, ph] of [[now, 'topbar.phone.pinCurrent'], [next, 'topbar.phone.pinNew']]) {
    f.inputMode = 'numeric'; f.maxLength = 10; f.autocomplete = 'off'; f.placeholder = tr(ph); f.setAttribute('aria-label', tr(ph));
    f.addEventListener('input', () => { f.value = f.value.replace(/\D/g, '').slice(0, 10); });
    f.addEventListener('keydown', (e) => e.stopPropagation());
  }
  now.type = 'password';
  const save = el('button', 'btn btn--sm btn--confirm', tr('topbar.phone.save')); save.type = 'submit'; err.hidden = true;
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); save.disabled = true;
    const r = await post('/api/pin', { current: now.value, pin: next.value }); save.disabled = false;
    if (r?.ok) { renderPhone(); toast(tr('topbar.phone.pinChanged')); return; }
    err.textContent = r?.message || tr('drawer.unreachable'); err.hidden = false;
  });
  form.append(now, next, save);
  body.append(el('h4', 'pm-h', tr('topbar.phone.pinChangeTitle')), form, err, el('p', 'muted pm-note', tr('topbar.phone.pinPhoneNote')));
  // what the Mac allows: each on, or off with where to turn it on
  body.append(el('h4', 'pm-h', tr('topbar.phone.macAllows')));
  for (const [on, what] of [[state.phoneApprove, 'topbar.phone.approve'], [state.phoneTasks, 'topbar.phone.tasksSwitch']]) {
    body.append(el('p', `pm-allow${on ? ' is-on' : ''}`, tr(on ? 'topbar.phone.allowOn' : 'topbar.phone.allowOff', { what: tr(what) })));
  }
}

export function setup() {
  /* ---------- phone modal, bell, night, closing ---------- */
  state.lanUrl = null; state.lanBase = null; state.phonePin = null;
  for (const id of ['btn-phone', 'btn-phone-top']) $(id)?.addEventListener('click', () => { $('phone-modal').hidden = false; renderPhone(); if (state.isLocal) loadTunnel().then(renderPhone); });
  try { bellOn = localStorage.getItem('office-bell') === '1' && Notification.permission === 'granted'; } catch { /* storage blocked */ }
  $('btn-bell').addEventListener('click', async () => {
    if (!bellOn && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { toast(tr('topbar.bellBlocked')); return; } }
    bellOn = !bellOn; try { localStorage.setItem('office-bell', bellOn ? '1' : '0'); } catch { /* ignore */ }
    renderBell(); toast(tr(bellOn ? 'topbar.bellOn' : 'topbar.bellOff'));
  });
  $('btn-night').addEventListener('click', () => { state.nightManual = true; setNight(!night); });
  document.addEventListener('click', (ev) => {
    const c = ev.target.closest('[data-close]'); if (!c) return;
    if (c.closest('#dr-session')) closeSession(); else if (c.closest('#dr-mac')) closeMac(); else if (c.closest('#phone-modal')) $('phone-modal').hidden = true;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if ($('wait-focus-modal') && !$('wait-focus-modal').hidden) { $('wait-focus-modal').querySelector('.wait-close-btn')?.click(); return; }
    if (!$('tl').hidden) closeTimeline(); else if (plcState.id) closePlace(); else if (!popLook.hidden) togglePop(false); else if (!$('pop-plan').hidden) togglePlan(false); else if (!$('phone-modal').hidden) $('phone-modal').hidden = true; else if (!drS.hidden) closeSession(); else if (!drM.hidden) closeMac(); else if (fp.on) exitFp();
  });
  $('feed-toggle').addEventListener('click', () => { if (!small.matches) return; const open = $('feed').classList.toggle('feed--open'); $('feed-toggle').setAttribute('aria-expanded', String(open)); });
}
