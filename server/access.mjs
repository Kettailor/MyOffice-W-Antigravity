// Remote Tailscale / LAN Access Control, Role Assignment ("Trợ lý Giám đốc"),
// Workspace-Scoped Visibility & Pre-Execution Task Approval Manager.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_ROLE = 'Trợ lý Giám đốc';
export const DIRECTOR_DEVICE_ROLE = 'Phó Giám đốc';
export const ROLE_PRESETS = [
  'Trợ lý Giám đốc',
  'Phó Giám đốc',
  'Quản lý Dự án',
  'Trưởng nhóm Kỹ thuật',
  'Cộng tác viên',
  'Khách xem',
];

function normWinPath(p = '') {
  const s = String(p || '').trim().replace(/[\\/]+$/, '');
  if (!s) return '';
  return (process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(s)) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

export function isPathAllowed(targetDir = '', allowedWorkspaces = []) {
  if (!Array.isArray(allowedWorkspaces) || allowedWorkspaces.length === 0) return false;
  if (allowedWorkspaces.includes('*')) return true;
  const t = normWinPath(targetDir);
  if (!t) return false;
  const sep = (process.platform === 'win32' || /^[A-Za-z]:\\/.test(t)) ? '\\' : '/';
  for (const w of allowedWorkspaces) {
    const nw = normWinPath(w);
    if (!nw) continue;
    if (t === nw || t.startsWith(nw + sep) || (t.length > 3 && nw.startsWith(t + sep))) return true;
  }
  return false;
}

export function createAccessManager({ dataDir, onUpdate, onAccessRequest, onTaskRequest }) {
  const file = path.join(dataDir, 'access.json');
  let state = {
    requireTaskApproval: true,
    defaultRole: DEFAULT_ROLE,
    members: [],
    pendingTasks: [],
  };

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.requireTaskApproval === 'boolean') state.requireTaskApproval = raw.requireTaskApproval;
      if (typeof raw.defaultRole === 'string' && raw.defaultRole.trim()) state.defaultRole = raw.defaultRole.trim();
      if (Array.isArray(raw.members)) state.members = raw.members;
      if (Array.isArray(raw.pendingTasks)) state.pendingTasks = raw.pendingTasks.filter((t) => t && t.status === 'pending');
    }
  } catch { /* fresh start */ }

  let saving = Promise.resolve();
  function save() {
    const payload = JSON.stringify(state, null, 2);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    saving = saving
      .then(() => fsp.mkdir(dataDir, { recursive: true }))
      .then(() => fsp.writeFile(tmp, payload))
      .then(() => fsp.rename(tmp, file))
      .catch(() => {});
    return saving;
  }

  function parseCookies(req) {
    const out = {};
    const raw = req?.headers?.cookie || '';
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
    return out;
  }

  function clientIp(req) {
    const raw = String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    return raw || 'unknown';
  }

  function shortUa(req) {
    const ua = String(req?.headers?.['user-agent'] || '');
    const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS|Macintosh/i.test(ua) ? 'Mac' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Linux/i.test(ua) ? 'Linux' : 'Thiết bị';
    const br = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    return `${br} · ${os}`;
  }

  function getMemberFromReq(req, { cookieOnly = false } = {}) {
    const cookies = parseCookies(req);
    const tok = cookies.office_member || '';
    const ip = clientIp(req);
    if (tok && tok.includes('.')) {
      const [id, secret] = tok.split('.');
      const m = state.members.find((x) => x.id === id && x.secret === secret);
      if (m) {
        m.lastSeenAt = Date.now();
        if (ip && ip !== 'unknown' && !['127.0.0.1', '::1'].includes(ip)) m.ip = ip;
        return m;
      }
    }
    if (!cookieOnly && ip && ip !== 'unknown' && !['127.0.0.1', '::1'].includes(ip)) {
      const byIp = state.members.find((x) => x.ip === ip && x.status === 'approved') || state.members.find((x) => x.ip === ip);
      if (byIp) {
        byIp.lastSeenAt = Date.now();
        return byIp;
      }
    }
    return null;
  }

  function createDirectorDeviceMember(req, { name = '' } = {}) {
    let m = getMemberFromReq(req, { cookieOnly: true });
    const ip = clientIp(req);
    const ua = shortUa(req);
    const now = Date.now();
    const existingVpCount = state.members.filter((x) => x.isDirectorDevice && x.id !== m?.id).length;
    const defaultVpName = existingVpCount === 0 ? 'Phó Giám đốc' : `Phó Giám đốc ${existingVpCount + 1}`;
    const customName = String(name || '').trim();
    const cleanName = (customName && customName !== 'Trợ lý Giám đốc' && customName !== 'Trợ lý từ xa')
      ? customName.slice(0, 48)
      : (m?.isDirectorDevice && m.name ? m.name : defaultVpName);

    if (!m) {
      m = {
        id: 'mem-' + crypto.randomBytes(5).toString('hex'),
        secret: crypto.randomBytes(18).toString('hex'),
        name: cleanName,
        role: DIRECTOR_DEVICE_ROLE,
        isDirectorDevice: true,
        note: `Thiết bị chính chủ (${ua})`,
        ip,
        ua,
        status: 'approved',
        allowedWorkspaces: ['*'],
        requireApproval: false,
        createdAt: now,
        approvedAt: now,
        lastSeenAt: now,
      };
      state.members.unshift(m);
    } else {
      m.name = cleanName;
      m.role = DIRECTOR_DEVICE_ROLE;
      m.isDirectorDevice = true;
      m.ip = ip;
      m.ua = ua;
      m.status = 'approved';
      m.allowedWorkspaces = ['*'];
      m.requireApproval = false;
      m.approvedAt = m.approvedAt || now;
      m.lastSeenAt = now;
    }
    save();
    onUpdate?.();
    return m;
  }

  function getApprovedMember(req) {
    const m = getMemberFromReq(req);
    if (m && m.status === 'approved') return m;
    return null;
  }

  function createOrUpdateRequest(req, { name, role, note, autoApprove = false, defaultWorkspaces = [] } = {}) {
    let m = getMemberFromReq(req);
    const cleanName = String(name || m?.name || 'Trợ lý từ xa').trim().slice(0, 48) || 'Trợ lý từ xa';
    const cleanRole = String(role || m?.role || state.defaultRole || DEFAULT_ROLE).trim().slice(0, 48) || DEFAULT_ROLE;
    const cleanNote = String(note || '').trim().slice(0, 160);
    const ip = clientIp(req);
    const ua = shortUa(req);
    const now = Date.now();

    if (!m) {
      m = {
        id: 'mem-' + crypto.randomBytes(5).toString('hex'),
        secret: crypto.randomBytes(18).toString('hex'),
        name: cleanName,
        role: cleanRole,
        note: cleanNote,
        ip,
        ua,
        status: autoApprove ? 'approved' : 'pending',
        allowedWorkspaces: autoApprove ? (defaultWorkspaces.length ? defaultWorkspaces : ['*']) : defaultWorkspaces,
        requireApproval: null,
        createdAt: now,
        approvedAt: autoApprove ? now : 0,
        lastSeenAt: now,
      };
      state.members.unshift(m);
    } else {
      m.name = cleanName;
      m.role = cleanRole;
      if (cleanNote) m.note = cleanNote;
      m.ip = ip;
      m.ua = ua;
      m.lastSeenAt = now;
      if (autoApprove) {
        m.status = 'approved';
        m.approvedAt = now;
        if (!m.allowedWorkspaces?.length) m.allowedWorkspaces = defaultWorkspaces.length ? defaultWorkspaces : ['*'];
      } else if (m.status === 'rejected') {
        m.status = 'pending';
      }
    }

    save();
    onUpdate?.();
    if (m.status === 'pending') onAccessRequest?.(pubMember(m));
    return m;
  }

  function approveMember(id, { name, role, allowedWorkspaces, requireApproval } = {}) {
    const m = state.members.find((x) => x.id === id);
    if (!m) return null;
    if (typeof name === 'string' && name.trim()) m.name = name.trim().slice(0, 48);
    if (typeof role === 'string' && role.trim()) m.role = role.trim().slice(0, 48);
    if (Array.isArray(allowedWorkspaces)) {
      m.allowedWorkspaces = allowedWorkspaces.map((w) => String(w || '').trim()).filter(Boolean);
    }
    if (requireApproval === null || typeof requireApproval === 'boolean') {
      m.requireApproval = requireApproval;
    }
    m.status = 'approved';
    m.approvedAt = Date.now();
    save();
    onUpdate?.();
    return pubMember(m);
  }

  function updateMember(id, patch = {}) {
    const m = state.members.find((x) => x.id === id);
    if (!m) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) m.name = patch.name.trim().slice(0, 48);
    if (typeof patch.role === 'string' && patch.role.trim()) m.role = patch.role.trim().slice(0, 48);
    if (Array.isArray(patch.allowedWorkspaces)) {
      m.allowedWorkspaces = patch.allowedWorkspaces.map((w) => String(w || '').trim()).filter(Boolean);
    }
    if (patch.status && ['pending', 'approved', 'rejected'].includes(patch.status)) {
      m.status = patch.status;
      if (patch.status === 'approved' && !m.approvedAt) m.approvedAt = Date.now();
    }
    if (patch.requireApproval === null || typeof patch.requireApproval === 'boolean') {
      m.requireApproval = patch.requireApproval;
    }
    save();
    onUpdate?.();
    return pubMember(m);
  }

  function removeMember(id) {
    const idx = state.members.findIndex((x) => x.id === id);
    if (idx < 0) return false;
    state.members.splice(idx, 1);
    save();
    onUpdate?.();
    return true;
  }

  function setRequireTaskApproval(val) {
    state.requireTaskApproval = Boolean(val);
    save();
    onUpdate?.();
    return state.requireTaskApproval;
  }

  function effectiveRequireApproval(member) {
    if (!member || member.isDirectorDevice || member.role === DIRECTOR_DEVICE_ROLE) return false;
    if (typeof member.requireApproval === 'boolean') return member.requireApproval;
    return Boolean(state.requireTaskApproval);
  }

  function canSeeWorkspace(member, targetDir = '') {
    if (!member || member.isDirectorDevice || member.role === DIRECTOR_DEVICE_ROLE) return true; // local director or PIN device
    if (member.status !== 'approved') return false;
    return isPathAllowed(targetDir, member.allowedWorkspaces);
  }

  function getApprovedTeamMembers() {
    return state.members.filter((m) => m.status === 'approved').map(pubMember);
  }

  function getRestrictedWorkspaces() {
    const restrictedMembers = state.members.filter(
      (m) => m.status === 'approved' && Array.isArray(m.allowedWorkspaces) && !m.allowedWorkspaces.includes('*'),
    );
    if (!restrictedMembers.length) return null;
    const out = new Set();
    for (const m of restrictedMembers) {
      for (const w of m.allowedWorkspaces) if (w) out.add(w);
    }
    return [...out];
  }

  function queueTask(member, payload = {}) {
    const item = {
      id: 'rtask-' + crypto.randomBytes(5).toString('hex'),
      memberId: member?.id || 'remote',
      memberName: member?.name || 'Trợ lý từ xa',
      memberRole: member?.role || DEFAULT_ROLE,
      ip: member?.ip || '',
      dir: String(payload.dir || ''),
      sid: String(payload.sid || ''),
      model: String(payload.model || '').trim(),
      targetName: String(payload.targetName || path.basename(String(payload.dir || '')) || 'Dự án'),
      chat: Boolean(payload.chat),
      text: String(payload.text || '').trim().slice(0, 4000),
      images: Array.isArray(payload.images) ? payload.images : [],
      status: 'pending',
      createdAt: Date.now(),
      decidedAt: 0,
    };
    state.pendingTasks.unshift(item);
    if (state.pendingTasks.length > 50) state.pendingTasks.length = 50;
    save();
    onUpdate?.();
    onTaskRequest?.(item);
    return item;
  }

  function resolveTask(taskId, decision = 'approve', editedText = null) {
    const idx = state.pendingTasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return null;
    const item = state.pendingTasks[idx];
    state.pendingTasks.splice(idx, 1);
    item.status = decision === 'approve' ? 'approved' : 'rejected';
    item.decidedAt = Date.now();
    if (typeof editedText === 'string' && editedText.trim()) {
      item.text = editedText.trim().slice(0, 4000);
    }
    save();
    onUpdate?.();
    return item;
  }

  function pubMember(m) {
    if (!m) return null;
    const { secret, ...rest } = m;
    return rest;
  }

  function pubState(allWorkspaces = []) {
    return {
      requireTaskApproval: state.requireTaskApproval,
      defaultRole: state.defaultRole,
      roles: ROLE_PRESETS,
      workspaces: allWorkspaces,
      members: state.members.map(pubMember),
      pendingTasks: state.pendingTasks.filter((t) => t.status === 'pending'),
    };
  }

  function memberCookieHeader(m) {
    return `office_member=${encodeURIComponent(`${m.id}.${m.secret}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`;
  }

  return {
    get state() { return state; },
    getMemberFromReq,
    getApprovedMember,
    createDirectorDeviceMember,
    createOrUpdateRequest,
    approveMember,
    updateMember,
    removeMember,
    setRequireTaskApproval,
    effectiveRequireApproval,
    canSeeWorkspace,
    getApprovedTeamMembers,
    getRestrictedWorkspaces,
    queueTask,
    resolveTask,
    pubMember,
    pubState,
    memberCookieHeader,
  };
}

// Renders the Tailscale / LAN Remote Access Request & Approval Waiting screen at /pin
export function renderRemoteAccessPage({ member = null, wrongPin = false, defaultRole = DEFAULT_ROLE } = {}) {
  const isPending = member && member.status === 'pending';
  const isRejected = member && member.status === 'rejected';
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Work Office · Cổng Truy Cập Từ Xa (Ket Wi-Fi / Tailscale)</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100dvh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 50% 0%,#1d283a 0%,#0f141c 70%);color:#f3f4f6;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{width:min(460px,100%);background:rgba(22,29,41,0.94);border:1px solid rgba(255,255,255,0.12);border-radius:18px;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,0.55);backdrop-filter:blur(16px)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:rgba(56,189,248,0.14);color:#38bdf8;font-size:12px;font-weight:600;margin-bottom:10px}
h1{font-size:20px;font-weight:700;letter-spacing:-0.01em;margin-bottom:6px;color:#fff}
p.lead{color:#9ca3af;font-size:13px;margin-bottom:16px}
.pin-card{padding:14px 16px;border-radius:14px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.28);margin-bottom:18px}
.pin-card h2{font-size:14px;font-weight:700;color:#7dd3fc;margin-bottom:4px}
.pin-card p{font-size:12px;color:#cbd5e1;margin-bottom:10px}
.field{margin-bottom:12px;text-align:left}
.field label{display:block;font-size:12px;font-weight:600;color:#d1d5db;margin-bottom:5px}
.field input,.field select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:rgba(15,20,28,0.85);color:#fff;font-size:14px;outline:none;transition:border-color .15s}
.field input:focus,.field select:focus{border-color:#38bdf8}
.btn{width:100%;padding:11px 16px;border-radius:10px;border:0;background:linear-gradient(135deg,#0284c7,#2563eb);color:#fff;font-weight:600;font-size:14px;cursor:pointer;transition:transform .1s,opacity .15s}
.btn:hover{opacity:0.94}
.btn:active{transform:scale(0.99)}
.wait-box{padding:16px;border-radius:12px;background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.3);margin-bottom:16px;text-align:center}
.wait-box b{display:block;color:#fde047;font-size:14.5px;margin-bottom:6px}
.wait-box p{color:#e5e7eb;font-size:13px}
.err{color:#f87171;font-size:13px;margin-bottom:12px;padding:8px 12px;border-radius:8px;background:rgba(248,113,113,0.12)}
.divider{margin:16px 0;border-top:1px solid rgba(255,255,255,0.1);position:relative;text-align:center}
.divider span{position:relative;top:-10px;background:#161d29;padding:0 10px;color:#9ca3af;font-size:12px;font-weight:600}
.pin-row{display:flex;gap:8px;margin-top:8px}
.pin-row input{flex:1;padding:10px;border-radius:10px;border:1px solid rgba(56,189,248,0.35);background:#0f141c;color:#fff;font:700 18px/1 monospace;letter-spacing:.25em;text-align:center}
.pin-row button{padding:10px 18px;border-radius:10px;border:0;background:linear-gradient(135deg,#0ea5e9,#2563eb);color:#fff;font-weight:700;cursor:pointer;white-space:nowrap}
.spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(253,224,71,0.3);border-top-color:#fde047;border-radius:50%;animation:sp .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes sp{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="card">
  <div class="badge">🌐 Kết nối từ xa · Wi-Fi Ket & Tailscale</div>
  <h1>Work Office · Điều hành Agent</h1>
  <p class="lead">Phân quyền truy cập cho Chính chủ Giám đốc (thiết bị phụ) và Trợ lý Giám đốc.</p>

  ${isRejected ? '<div class="err">Yêu cầu truy cập trước đó đã bị từ chối. Bạn có thể gửi lại yêu cầu bên dưới.</div>' : ''}
  ${wrongPin ? '<div class="err">Mã PIN không đúng. Vui lòng kiểm tra mã PIN 6 số trên máy chính Giám đốc.</div>' : ''}

  <div class="pin-card">
    <h2>👔 Chính chủ Giám đốc (Thiết bị khác)</h2>
    <p>Nhập mã PIN 6 số tạo từ máy chính để vào ngay với nhân vật Chibi <b>Phó Giám đốc</b> (toàn quyền tất cả dự án):</p>
    <form method="post" action="/pin">
      <input type="hidden" name="mode" value="director_pin">
      <div class="pin-row">
        <input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••••" autocomplete="one-time-code" required>
        <button type="submit">Vào ngay</button>
      </div>
    </form>
  </div>

  <div class="divider"><span>HOẶC ĐĂNG KÝ TRỢ LÝ GIÁM ĐỐC</span></div>

  <div id="wait-panel" class="wait-box" ${isPending ? '' : 'hidden'}>
    <b><span class="spin"></span>Đang chờ Giám đốc phê duyệt…</b>
    <p id="wait-info">Xin chào <strong>${esc(member?.name || '')}</strong> (${esc(member?.role || defaultRole)}).<br>Thông báo đã hiện trên màn hình Giám đốc. Sau khi duyệt bạn sẽ có nhân vật Chibi riêng trong văn phòng!</p>
  </div>

  <form id="req-form">
    <div class="field">
      <label for="f-name">Họ và tên Trợ lý hiển thị</label>
      <input id="f-name" name="name" required maxlength="48" placeholder="VD: Nguyễn Minh Anh" value="${esc(member && !member.isDirectorDevice ? member.name : '')}" autocomplete="name">
    </div>
    <div class="field">
      <label for="f-role">Vai trò đề xuất (Giám đốc có thể chỉnh lại)</label>
      <select id="f-role" name="role">
        ${ROLE_PRESETS.filter((r) => r !== 'Phó Giám đốc').map((r) => `<option value="${esc(r)}" ${(member?.role || defaultRole) === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label for="f-note">Ghi chú công việc (tuỳ chọn)</label>
      <input id="f-note" name="note" maxlength="120" placeholder="VD: Hỗ trợ giao task dự án được phân quyền" value="${esc(member?.note || '')}">
    </div>
    <button class="btn" type="submit" id="btn-submit">${isPending ? 'Cập nhật & Gửi lại yêu cầu' : '🚀 Đăng ký Trợ lý Giám đốc'}</button>
  </form>
</div>
<script>
const form = document.getElementById('req-form');
const waitPanel = document.getElementById('wait-panel');
const waitInfo = document.getElementById('wait-info');
const btnSubmit = document.getElementById('btn-submit');
const fName = document.getElementById('f-name');
const fRole = document.getElementById('f-role');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Đang gửi yêu cầu…';
  try {
    const r = await fetch('/api/access/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fName.value.trim(),
        role: fRole.value,
        note: document.getElementById('f-note').value.trim(),
      }),
    });
    const d = await r.json();
    if (d.status === 'approved') {
      location.replace('/');
      return;
    }
    waitPanel.hidden = false;
    waitInfo.innerHTML = 'Xin chào <strong>' + (d.name || '') + '</strong> (' + (d.role || '') + ').<br>Thông báo đã hiện trên màn hình Giám đốc. Trang sẽ tự động mở ngay khi được duyệt!';
    btnSubmit.textContent = 'Đã gửi · Cập nhật thông tin';
  } catch {
    btnSubmit.textContent = 'Thử gửi lại';
  } finally {
    btnSubmit.disabled = false;
  }
});

async function pollStatus() {
  try {
    const r = await fetch('/api/access/status');
    const d = await r.json();
    if (d.status === 'approved') {
      location.replace('/');
    }
  } catch {}
}
setInterval(pollStatus, 1800);
</script>
</body>
</html>`;
}
