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
import { setupFileManager } from './file-manager.js';
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
    if ('lanOn' in tun) state.lanOn = !!tun.lanOn;
    if ('wifiOn' in tun) state.wifiOn = !!tun.wifiOn;
    if ('tsOn' in tun) state.tsOn = !!tun.tsOn;
    if ('lan' in tun) state.lanUrl = tun.lan || null;
    if ('lanBase' in tun) state.lanBase = tun.lanBase || null;
    if ('wifiHere' in tun) state.wifiHere = !!tun.wifiHere;
    if ('ts' in tun) state.tsUrl = tun.ts || null;
    if ('tsHere' in tun) state.tsHere = !!tun.tsHere;
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

export function canStopSession(s) {
  if (s?.masked) return false;
  if (state.isLocal) return true;
  const v = state.viewer;
  if (!v) return false;
  if (v.isDirectorDevice || v.role === 'Phó Giám đốc') return state.access ? state.access.allowStopSession !== false : true;
  if (typeof v.canStopSession === 'boolean') return v.canStopSession;
  if (v.sessionPerms && typeof v.sessionPerms.stop === 'boolean') return v.sessionPerms.stop;
  return true;
}

export function canEditSession(s) {
  if (s?.masked) return false;
  if (state.isLocal) return true;
  const v = state.viewer;
  if (!v) return false;
  if (v.isDirectorDevice || v.role === 'Phó Giám đốc') return state.access ? state.access.allowEditSession !== false : true;
  if (typeof v.canEditSession === 'boolean') return v.canEditSession;
  if (v.sessionPerms && typeof v.sessionPerms.edit === 'boolean') return v.sessionPerms.edit;
  return true;
}

export function canDeleteSession(s) {
  if (s?.masked) return false;
  if (state.isLocal) return true;
  const v = state.viewer;
  if (!v) return false;
  if (v.isDirectorDevice || v.role === 'Phó Giám đốc') return state.access ? state.access.allowDeleteSession !== false : true;
  if (typeof v.canDeleteSession === 'boolean') return v.canDeleteSession;
  if (v.sessionPerms && typeof v.sessionPerms.delete === 'boolean') return v.sessionPerms.delete;
  return true;
}

function renderAccessSection(body) {
  const acc = state.access || {
    requireTaskApproval: true,
    allowStopSession: true,
    allowEditSession: true,
    allowDeleteSession: true,
    roles: ['Trợ lý Giám đốc', 'Phó Giám đốc', 'Quản lý Dự án', 'Trưởng nhóm Kỹ thuật', 'Cộng tác viên', 'Khách xem'],
    workspaces: [],
    members: [],
    pendingTasks: [],
  };
  const sec = el('div', 'pm-access');
  sec.append(el('h4', 'pm-h', '👔 Phân quyền Tailscale & Các vai trò kết nối'));

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
      toast(want ? '🛡️ Đã BẬT chế độ duyệt trước khi Agent chạy task từ xa' : '⚡ Đã TẮT chế độ chờ duyệt — Người dùng giao việc chạy ngay');
      renderPhone();
      renderViewerBadge();
      return true;
    },
    'Khi BẬT: Mọi task/conversation do người kết nối từ xa giao sẽ hiện thẻ chờ bạn duyệt trước khi Agent thực hiện. Khi TẮT: Chạy ngay lập tức.',
  ));

  // 1b. Global Session Control Permissions for Connected Roles
  const sessPermBox = el('div', 'pm-qbox');
  sessPermBox.append(
    el('b', 'pm-qh', '🎛️ Cấp quyền chức năng phiên làm việc cho các vai trò kết nối'),
    el('p', 'muted pm-note', 'Bật/tắt quyền thao tác phiên làm việc chung cho các người dùng kết nối từ xa (bạn cũng có thể tùy chỉnh riêng từng người ở danh sách bên dưới):'),
    phoneSwitch(
      '⏹️ Cho phép dừng phiên làm việc (Stop Session)',
      acc.allowStopSession !== false,
      false,
      async (want) => {
        const r = await post('/api/access', { action: 'setSessionPermissions', allowStopSession: want });
        if (!r?.ok) return false;
        state.access = r;
        toast(want ? '⏹️ Đã cho phép các vai trò kết nối dừng phiên làm việc' : '🔒 Đã tắt quyền dừng phiên làm việc từ xa');
        renderPhone();
        return true;
      },
      'Cho phép Trợ lý / Quản lý dừng tiến trình Agent đang chạy trên các Workspace được cấp quyền.',
    ),
    phoneSwitch(
      '✏️ Cho phép chỉnh sửa / đổi tên phiên (Edit Session)',
      acc.allowEditSession !== false,
      false,
      async (want) => {
        const r = await post('/api/access', { action: 'setSessionPermissions', allowEditSession: want });
        if (!r?.ok) return false;
        state.access = r;
        toast(want ? '✏️ Đã cho phép các vai trò kết nối chỉnh sửa tên phiên' : '🔒 Đã tắt quyền chỉnh sửa tên phiên từ xa');
        renderPhone();
        return true;
      },
      'Cho phép đổi tên hiển thị của các phiên làm việc trong danh sách và bảng điều khiển.',
    ),
    phoneSwitch(
      '🗑️ Cho phép xóa phiên làm việc (Delete Session)',
      acc.allowDeleteSession !== false,
      false,
      async (want) => {
        const r = await post('/api/access', { action: 'setSessionPermissions', allowDeleteSession: want });
        if (!r?.ok) return false;
        state.access = r;
        toast(want ? '🗑️ Đã cho phép các vai trò kết nối xóa phiên làm việc' : '🔒 Đã tắt quyền xóa phiên làm việc từ xa');
        renderPhone();
        return true;
      },
      'Cho phép xóa các phiên làm việc không còn sử dụng trên các Workspace được cấp quyền.',
    ),
  );
  sec.append(sessPermBox);

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

    let selectedGender = m.gender === 'female' ? 'female' : 'male';
    const genderRow = el('div', 'pm-gender-row');
    const genderLbl = el('small', 'pm-mwstitle', '🧑 Giới tính Chibi:');
    const maleBtn = el('button', `btn btn--sm pm-gender-btn${selectedGender === 'male' ? ' is-active' : ''}`, '👦 Nam');
    maleBtn.type = 'button';
    const femaleBtn = el('button', `btn btn--sm pm-gender-btn${selectedGender === 'female' ? ' is-active' : ''}`, '👧 Nữ');
    femaleBtn.type = 'button';
    const syncGenderBtns = () => {
      maleBtn.classList.toggle('is-active', selectedGender === 'male');
      maleBtn.setAttribute('aria-pressed', String(selectedGender === 'male'));
      femaleBtn.classList.toggle('is-active', selectedGender === 'female');
      femaleBtn.setAttribute('aria-pressed', String(selectedGender === 'female'));
    };
    syncGenderBtns();
    genderRow.append(genderLbl, maleBtn, femaleBtn);

    const wsTitle = el('small', 'pm-mwstitle', '📁 Workspaces được phép nhìn thấy & giao việc:');
    const wsGrid = el('div', 'pm-mwsgrid');
    const picked = new Set((m.allowedWorkspaces || []).map((x) => String(x).toLowerCase()));
    const checkboxes = [];

    const permTitle = el('small', 'pm-mwstitle', `🎛️ Quyền chức năng phiên làm việc (${m.role || 'Trợ lý Giám đốc'}):`);
    const permGrid = el('div', 'pm-mwsgrid actionPermsWrap');
    const makePermCb = (labelTxt, initChecked) => {
      const lbl = el('label', 'pm-mws');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = initChecked;
      lbl.append(cb, el('span', null, labelTxt));
      permGrid.append(lbl);
      return cb;
    };
    const isDeputyRole = (m.role || '') === 'Phó Giám đốc' || Boolean(m.isDirectorDevice);
    const canStopCb = makePermCb('⏹️ Dừng phiên', m.rawCanStopSession !== false && m.canStopSession !== false);
    const canEditCb = makePermCb('✏️ Chỉnh sửa phiên', m.rawCanEditSession !== false && m.canEditSession !== false);
    const canDeleteCb = makePermCb('🗑️ Xóa phiên', m.rawCanDeleteSession !== false && m.canDeleteSession !== false);
    const canEditFilesCb = makePermCb(
      '📁 Cho phép tải lên / sửa / xóa file dự án',
      typeof m.rawCanEditFiles === 'boolean' ? m.rawCanEditFiles : (typeof m.canEditFiles === 'boolean' ? m.canEditFiles : isDeputyRole),
    );

    const saveMemberPerms = async (quietToast = false) => {
      const allowedWorkspaces = checkboxes.filter((c) => c.checked).map((c) => c.value);
      const action = m.status === 'approved' ? 'updateMember' : 'approveMember';
      const r = await post('/api/access', {
        action,
        id: m.id,
        name: nameIn.value.trim() || 'Trợ lý Giám đốc',
        role: roleIn.value.trim() || 'Trợ lý Giám đốc',
        gender: selectedGender,
        allowedWorkspaces,
        canStopSession: canStopCb.checked,
        canEditSession: canEditCb.checked,
        canDeleteSession: canDeleteCb.checked,
        canEditFiles: canEditFilesCb.checked,
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
    maleBtn.addEventListener('click', () => {
      selectedGender = 'male';
      syncGenderBtns();
      if (m.status === 'approved') saveMemberPerms(true);
    });
    femaleBtn.addEventListener('click', () => {
      selectedGender = 'female';
      syncGenderBtns();
      if (m.status === 'approved') saveMemberPerms(true);
    });
    if (m.status === 'approved') {
      for (const pcb of [canStopCb, canEditCb, canDeleteCb, canEditFilesCb]) {
        pcb.addEventListener('change', () => { saveMemberPerms(true); });
      }
    }
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
    card.append(top, fields, genderRow, wsTitle, wsGrid, permTitle, permGrid, acts);
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
  const lanOn = state.lanOn !== undefined ? !!state.lanOn : !!(state.lanUrl || state.tsUrl || tun?.lanOn);
  const wifiOn = state.wifiOn !== false;
  const tsOn = state.tsOn !== false;
  const tunOn = !!tun?.on, tab = pmTab || (tunOn ? 'away' : 'home');
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
  const applyLanResp = (r) => {
    state.lanOn = !!(r.lanOn ?? r.on);
    if ('wifiOn' in r) state.wifiOn = !!r.wifiOn;
    if ('tsOn' in r) state.tsOn = !!r.tsOn;
    state.lanUrl = r.lan || null;
    state.lanBase = r.lanBase || null;
    if ('wifiHere' in r) state.wifiHere = !!r.wifiHere;
    state.tsUrl = r.ts || null;
    if ('tsHere' in r) state.tsHere = !!r.tsHere;
    if (r.pin) state.phonePin = r.pin;
    state.lanFixed = !!r.fixed;
    if (tun) {
      tun.lanOn = state.lanOn;
      tun.wifiOn = state.wifiOn;
      tun.tsOn = state.tsOn;
    }
  };
  if (tab === 'home') {   // the home network: the Mac's own addresses (and its Tailscale one)
    conn.append(phoneSwitch(tr('topbar.phone.lanSwitch'), lanOn, !!state.lanFixed, async (want) => {
      const r = await post('/api/lan', { on: want }); if (!r?.ok) return false;
      applyLanResp(r);
      renderPhone(); return true;
    }, tr('topbar.phone.lanDesc')));
    if (!lanOn) conn.append(el('p', 'muted pm-note', tr('topbar.phone.lanOffNote')));
    else {
      if (state.lanFixed) conn.append(el('p', 'muted pm-note', tr('topbar.phone.lanFixed')));
      // Sub-toggle 1: Share over local Wi-Fi
      conn.append(phoneSwitch(tr('topbar.phone.wifiSwitch'), wifiOn, false, async (want) => {
        const r = await post('/api/lan', { wifi: want }); if (!r?.ok) return false;
        applyLanResp(r);
        renderPhone(); return true;
      }, tr('topbar.phone.wifiDesc')));
      if (!wifiOn) {
        conn.append(el('p', 'muted pm-note', tr('topbar.phone.wifiOffNote')));
      } else if (state.lanUrl) {
        conn.append(where(state.lanUrl, state.lanBase || state.lanUrl, tr('topbar.phone.scan')));
        conn.append(el('p', 'muted pm-note', tr('topbar.phone.wifiTip')));
      } else {
        conn.append(el('p', 'muted pm-note', tr('topbar.phone.wifiNoIp')));
      }
      // Sub-toggle 2: Share over Tailscale
      conn.append(phoneSwitch(tr('topbar.phone.tsSwitch'), tsOn, false, async (want) => {
        const r = await post('/api/lan', { ts: want }); if (!r?.ok) return false;
        applyLanResp(r);
        renderPhone(); return true;
      }, tr('topbar.phone.tsDesc')));
      if (!tsOn) {
        conn.append(el('p', 'muted pm-note', tr('topbar.phone.tsOffNote')));
      } else if (state.tsUrl) {
        conn.append(where(state.tsUrl, state.tsUrl, tr('topbar.phone.tsOn')));
      } else {
        conn.append(el('p', 'muted pm-note', tr('topbar.phone.tsNoIp')));
      }
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
    const v = state.viewer;
    const isFull = Boolean(v.isDirector || v.isDirectorDevice || v.role === 'Phó Giám đốc');
    const canStop = isFull || (v.canStopSession !== false && v.sessionPerms?.stop !== false);
    const canEdit = isFull || (v.canEditSession !== false && v.sessionPerms?.edit !== false);
    const canDel = isFull || (v.canDeleteSession !== false && v.sessionPerms?.delete !== false);
    const canFiles = isFull || Boolean(v.canEditFiles);
    const vBox = el('div', 'pm-pinbox');
    const permBadges = el('div', 'pm-mwsgrid');
    for (const [labelTxt, allowed] of [
      ['⏹️ Dừng phiên làm việc', canStop],
      ['✏️ Chỉnh sửa tên phiên', canEdit],
      ['🗑️ Xóa phiên làm việc', canDel],
      ['📁 Tải lên / sửa / xóa file dự án', canFiles],
    ]) {
      const chip = el('span', `pm-mbadge ${allowed ? 'pm-mbadge--approved' : 'pm-mbadge--rejected'}`, `${allowed ? '🟢' : '🔒'} ${labelTxt}`);
      permBadges.append(chip);
    }

    const curGender = (state.viewer?.gender || 'male') === 'female' ? 'female' : 'male';
    const genderWrap = el('div', 'pm-gender-box');
    genderWrap.append(el('small', 'pm-mwstitle', '🧑 Giới tính nhân vật Chibi:'));
    const genderRow = el('div', 'pm-gender-row');
    for (const [gVal, gText] of [['male', '👦 Nam'], ['female', '👧 Nữ']]) {
      const gb = el('button', `btn btn--sm pm-gender-btn${curGender === gVal ? ' is-active' : ''}`, gText);
      gb.type = 'button';
      gb.setAttribute('aria-pressed', String(curGender === gVal));
      gb.addEventListener('click', async () => {
        if ((state.viewer?.gender || 'male') === gVal) return;
        gb.disabled = true;
        const r = await post('/api/access', { action: 'updateSelf', gender: gVal });
        gb.disabled = false;
        if (r?.ok) {
          state.viewer.gender = r.viewer?.gender || gVal;
          toast(gVal === 'female' ? '✅ Đã đổi nhân vật Chibi sang Nữ!' : '✅ Đã đổi nhân vật Chibi sang Nam!');
          renderPhone();
          renderViewerBadge();
        } else {
          toast(r?.message || tr('drawer.unreachable'));
        }
      });
      genderRow.append(gb);
    }
    genderWrap.append(genderRow);

    vBox.append(
      el('b', null, `👔 Vai trò: ${v.role || 'Trợ lý Giám đốc'} · ${v.name || 'Từ xa'}`),
      el('p', 'muted pm-note', state.requireTaskApproval
        ? '🛡️ Chế độ: Mọi công việc (task) bạn giao sẽ được gửi tới Giám đốc duyệt trước khi Agent thực hiện.'
        : '⚡ Chế độ: Công việc bạn giao được Agent thực hiện ngay lập tức.'),
      el('p', 'muted pm-note', `📁 Workspace được phép truy cập: ${(v.allowedWorkspaces || []).map((d) => String(d).split(/[\\/]/).filter(Boolean).pop() || d).join(', ') || 'Theo phân quyền Giám đốc'}`),
      genderWrap,
      el('small', 'pm-mwstitle', '🎛️ Quyền chức năng phiên làm việc của bạn:'),
      permBadges,
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
  /* ---------- phone modal, bell, night, closing, file manager ---------- */
  setupFileManager();
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
    if ($('mcp-modal') && !$('mcp-modal').hidden) { $('mcp-modal').hidden = true; return; }
    if ($('file-manager-modal') && !$('file-manager-modal').hidden) { $('file-manager-modal').hidden = true; return; }
    if ($('wrap-modal') && !$('wrap-modal').hidden) { $('wrap-modal').hidden = true; return; }
    if ($('zchat') && !$('zchat').hidden) { $('zchat').hidden = true; return; }
    if (!$('tl').hidden) closeTimeline(); else if (plcState.id) closePlace(); else if (!popLook.hidden) togglePop(false); else if (!$('pop-plan').hidden) togglePlan(false); else if (!$('phone-modal').hidden) $('phone-modal').hidden = true; else if (!drS.hidden) closeSession(); else if (!drM.hidden) closeMac(); else if (fp.on) exitFp();
  });
  $('feed-toggle').addEventListener('click', () => { if (!small.matches) return; const open = $('feed').classList.toggle('feed--open'); $('feed-toggle').setAttribute('aria-expanded', String(open)); });
}
