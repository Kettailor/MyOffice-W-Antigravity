// Project File Manager & Remote Document Viewer (.docx, .xlsx, .csv, .pdf, images, code/text).
import { state } from '../core/state.js';
import { $, el, fmtBytes, hhmm, pad2 } from '../core/env.js';
import { sessions } from '../people/workers.js';
import { canSeeSession } from './group-chat.js';
import { toast } from './activity.js';
import { TOKEN } from '../net/live.js';
import { DEMO } from '../demo/demo.js';
import { t as tr } from '../../i18n/index.js';

const q = (extra = '') => {
  const tok = TOKEN ? `k=${encodeURIComponent(TOKEN)}` : '';
  if (!tok && !extra) return '';
  if (tok && extra) return `?${tok}&${extra}`;
  return `?${tok || extra}`;
};

let modalEl = null;
let wsSelectEl = null;
let breadcrumbsEl = null;
let searchInEl = null;
let uploadBtnEl = null;
let mkdirBtnEl = null;
let fileInputEl = null;
let treeEl = null;
let previewEl = null;

let workspaces = [];
let currentWorkspaceRoot = '';
let currentDir = '';
let currentItems = [];
let selectedItem = null;
let canEdit = false;
let searchQuery = '';

export function canUserEditFiles() {
  if (state.isLocal) return true;
  const v = state.viewer;
  if (!v) return false;
  if (v.isDirector || v.isDirectorDevice || v.role === 'Phó Giám đốc') return true;
  return Boolean(v.canEditFiles);
}

function fileCategoryIcon(cat, ext = '') {
  if (cat === 'folder') return '📁';
  if (cat === 'docx' || ext === '.docx' || ext === '.doc') return '📘';
  if (cat === 'xlsx' || ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv') return '📗';
  if (cat === 'pdf' || ext === '.pdf') return '📕';
  if (cat === 'image') return '🖼️';
  if (cat === 'video') return '🎬';
  if (cat === 'audio') return '🎵';
  if (cat === 'code') return '💻';
  return '📄';
}

function fmtFileDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hhmm(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hhmm(ms)}`;
}

function excelColName(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const SAFE_DOCX_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'br', 'span', 'div',
]);

function buildSafeDocxDom(htmlStr, fallbackText = '') {
  const page = el('div', 'fm-docx-page');
  if (htmlStr && typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(htmlStr, 'text/html');
      const cloneSafe = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return document.createTextNode(node.textContent || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return null;
        const tag = node.tagName.toLowerCase();
        const outTag = SAFE_DOCX_TAGS.has(tag) ? tag : 'span';
        const domEl = document.createElement(outTag);
        if (node.className && /^docx-/.test(node.className)) {
          domEl.className = node.className;
        }
        for (const child of node.childNodes) {
          const c = cloneSafe(child);
          if (c) domEl.append(c);
        }
        return domEl;
      };
      for (const child of doc.body.childNodes) {
        const safeNode = cloneSafe(child);
        if (safeNode) page.append(safeNode);
      }
      if (page.childNodes.length > 0) return page;
    } catch { /* fallback to plain text */ }
  }
  const lines = String(fallbackText || '').split(/\r?\n/);
  if (!lines.some((l) => l.trim())) {
    page.append(el('p', 'muted', 'Tài liệu Word trống.'));
    return page;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    page.append(el('p', 'docx-p', line));
  }
  return page;
}

function buildXlsxViewer(sheets = []) {
  const wrap = el('div', 'fm-xlsx-wrap');
  if (!Array.isArray(sheets) || !sheets.length) {
    wrap.append(el('p', 'fm-empty', 'Bảng tính trống hoặc không có dữ liệu.'));
    return wrap;
  }
  let activeSheetIdx = 0;
  let rowFilter = '';

  const topBar = el('div', 'fm-sheet-topbar');
  const tabsWrap = el('div', 'fm-sheet-tabs');
  const filterIn = el('input', 'fm-sheet-filter');
  filterIn.type = 'search';
  filterIn.placeholder = '🔍 Tìm kiếm dòng trong bảng tính...';
  filterIn.addEventListener('keydown', (e) => e.stopPropagation());

  const gridHost = el('div', 'fm-sheet-grid-host');

  const renderGrid = () => {
    tabsWrap.replaceChildren();
    sheets.forEach((sh, idx) => {
      const tb = el('button', `fm-sheet-tab${idx === activeSheetIdx ? ' is-active' : ''}`, `📗 ${sh.name || `Sheet ${idx + 1}`}`);
      tb.type = 'button';
      tb.addEventListener('click', () => {
        activeSheetIdx = idx;
        renderGrid();
      });
      tabsWrap.append(tb);
    });

    const sheet = sheets[activeSheetIdx] || sheets[0];
    const allRows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    const qLow = rowFilter.trim().toLowerCase();
    const filteredRows = [];
    allRows.forEach((r, rIdx) => {
      if (!qLow || r.some((cell) => String(cell ?? '').toLowerCase().includes(qLow))) {
        filteredRows.push({ rIdx, cells: r });
      }
    });

    const colCount = Math.max(
      1,
      allRows.reduce((max, r) => Math.max(max, Array.isArray(r) ? r.length : 0), 0),
    );

    const table = el('table', 'fm-sheet-table');
    const thead = el('thead');
    const headTr = el('tr');
    headTr.append(el('th', 'fm-sheet-corner', '#'));
    for (let c = 0; c < colCount; c++) {
      headTr.append(el('th', 'fm-sheet-col-hd', excelColName(c)));
    }
    thead.append(headTr);

    const tbody = el('tbody');
    if (!filteredRows.length) {
      const emptyTr = el('tr');
      const td = el('td', 'fm-sheet-empty', 'Không có dòng nào khớp bộ lọc.');
      td.colSpan = colCount + 1;
      emptyTr.append(td);
      tbody.append(emptyTr);
    } else {
      for (const { rIdx, cells } of filteredRows) {
        const trEl = el('tr', rIdx === 0 ? 'fm-sheet-row-first' : '');
        trEl.append(el('td', 'fm-sheet-rownum', String(rIdx + 1)));
        for (let c = 0; c < colCount; c++) {
          const val = cells?.[c] ?? '';
          const td = el('td', null, String(val));
          if (String(val).length > 42) td.title = String(val);
          trEl.append(td);
        }
        tbody.append(trEl);
      }
    }
    table.append(thead, tbody);
    gridHost.replaceChildren(table);
  };

  filterIn.addEventListener('input', () => {
    rowFilter = filterIn.value;
    renderGrid();
  });

  topBar.append(tabsWrap, filterIn);
  wrap.append(topBar, gridHost);
  renderGrid();
  return wrap;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function parentDirOf(dirPath, rootPath) {
  const dNorm = normPath(dirPath);
  const rNorm = normPath(rootPath);
  if (!dNorm || (rNorm && dNorm.toLowerCase() === rNorm.toLowerCase())) return '';
  const isWin = dirPath.includes('\\') || /^[A-Za-z]:/.test(dirPath);
  const sep = isWin ? '\\' : '/';
  const parts = dNorm.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  parts.pop();
  const joined = parts.join(sep);
  return isWin && /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined;
}

function renderBreadcrumbs() {
  if (!breadcrumbsEl) return;
  breadcrumbsEl.replaceChildren();
  if (!currentDir) return;
  const rootNorm = normPath(currentWorkspaceRoot);
  const dirNorm = normPath(currentDir);
  const isWin = currentDir.includes('\\') || /^[A-Za-z]:/.test(currentDir);
  const sep = isWin ? '\\' : '/';

  const rootName = rootNorm.split('/').filter(Boolean).pop() || currentWorkspaceRoot;
  const rootBtn = el('button', 'fm-crumb', `📁 ${rootName}`);
  rootBtn.type = 'button';
  rootBtn.title = currentWorkspaceRoot;
  rootBtn.addEventListener('click', () => loadDirectory(currentWorkspaceRoot));
  breadcrumbsEl.append(rootBtn);

  if (rootNorm && dirNorm.toLowerCase().startsWith(rootNorm.toLowerCase()) && dirNorm.length > rootNorm.length) {
    const rel = dirNorm.slice(rootNorm.length).replace(/^\/+/, '');
    const segs = rel.split('/').filter(Boolean);
    let built = currentWorkspaceRoot.replace(/[\\/]+$/, '');
    for (const seg of segs) {
      breadcrumbsEl.append(el('span', 'fm-crumb-sep', '›'));
      built = `${built}${sep}${seg}`;
      const targetPath = built;
      const b = el('button', 'fm-crumb', seg);
      b.type = 'button';
      b.title = targetPath;
      b.addEventListener('click', () => loadDirectory(targetPath));
      breadcrumbsEl.append(b);
    }
  }
}

function renderTree() {
  if (!treeEl) return;
  treeEl.replaceChildren();
  const qLow = searchQuery.trim().toLowerCase();

  const parent = parentDirOf(currentDir, currentWorkspaceRoot);
  if (parent && !qLow) {
    const upBtn = el('button', 'fm-tree-item fm-tree-up');
    upBtn.type = 'button';
    upBtn.append(
      el('span', 'fm-item-ico', '⬆️'),
      el('span', 'fm-item-name', '.. (Thư mục cha)'),
    );
    upBtn.addEventListener('click', () => loadDirectory(parent));
    treeEl.append(upBtn);
  }

  const filtered = currentItems.filter((it) => !qLow || it.name.toLowerCase().includes(qLow));
  if (!filtered.length) {
    treeEl.append(el('p', 'fm-empty', qLow ? 'Không tìm thấy file khớp từ khóa.' : 'Thư mục này đang trống.'));
    return;
  }

  for (const item of filtered) {
    const row = el('button', `fm-tree-item${selectedItem?.path === item.path ? ' is-selected' : ''}`);
    row.type = 'button';
    row.title = item.path;
    const ico = el('span', 'fm-item-ico', fileCategoryIcon(item.category, item.ext));
    const main = el('span', 'fm-item-main');
    const nameEl = el('b', 'fm-item-name', item.name);
    const metaText = item.isDir
      ? `Thư mục · ${fmtFileDate(item.mtimeMs)}`
      : `${fmtBytes(item.size || 0)} · ${fmtFileDate(item.mtimeMs)}`;
    const metaEl = el('small', 'fm-item-meta', metaText);
    main.append(nameEl, metaEl);
    row.append(ico, main);
    row.addEventListener('click', () => {
      if (item.isDir) {
        loadDirectory(item.path);
      } else {
        selectFile(item);
      }
    });
    treeEl.append(row);
  }
}

async function selectFile(item) {
  selectedItem = item;
  renderTree();
  if (!previewEl) return;

  const headBar = el('div', 'fm-file-bar');
  const titleWrap = el('div', 'fm-file-title');
  titleWrap.append(
    el('span', 'fm-file-ico', fileCategoryIcon(item.category, item.ext)),
    el('b', 'fm-file-name', item.name),
    el('small', 'fm-file-meta', `${fmtBytes(item.size || 0)} · ${fmtFileDate(item.mtimeMs)}`),
  );

  const actionsWrap = el('div', 'fm-file-actions');
  const rawDownloadUrl = `/api/files/raw${q(`path=${encodeURIComponent(item.path)}&download=1`)}`;
  const dlLink = el('a', 'btn btn--sm fm-act-btn', '⬇️ Tải về máy');
  dlLink.href = rawDownloadUrl;
  dlLink.setAttribute('download', item.name);
  actionsWrap.append(dlLink);

  if (canEdit) {
    const renBtn = el('button', 'btn btn--sm fm-act-btn', '✏️ Đổi tên');
    renBtn.type = 'button';
    renBtn.addEventListener('click', () => promptRenameItem(item));

    let delArmed = false;
    const delBtn = el('button', 'btn btn--sm fm-act-btn fm-btn-danger', '🗑️ Xóa');
    delBtn.type = 'button';
    delBtn.addEventListener('click', async () => {
      if (!delArmed) {
        delArmed = true;
        delBtn.textContent = '⚠️ Bấm lần nữa để xóa';
        setTimeout(() => {
          if (delBtn.isConnected) {
            delArmed = false;
            delBtn.textContent = '🗑️ Xóa';
          }
        }, 3500);
        return;
      }
      delBtn.disabled = true;
      const r = await postFileAction({ action: 'delete', path: item.path });
      if (r?.ok) {
        toast(`🗑️ Đã xóa ${item.name}`);
        selectedItem = null;
        await loadDirectory(currentDir);
      } else {
        delBtn.disabled = false;
        toast(r?.error || r?.message || 'Không thể xóa file.');
      }
    });
    actionsWrap.append(renBtn, delBtn);
  }

  const taskBtn = el('button', 'btn btn--sm btn--confirm fm-act-btn', '📋 Giao việc với file này');
  taskBtn.type = 'button';
  taskBtn.addEventListener('click', () => {
    closeFileManager();
    import('./group-chat-view.js').then((m) => m.openTaskWithFile(item.path, currentWorkspaceRoot || currentDir)).catch(() => {});
  });
  actionsWrap.append(taskBtn);

  headBar.append(titleWrap, actionsWrap);

  const bodyWrap = el('div', 'fm-preview-body');
  bodyWrap.append(el('p', 'fm-loading', '⏳ Đang tải nội dung xem trước...'));
  previewEl.replaceChildren(headBar, bodyWrap);

  if (DEMO) {
    bodyWrap.replaceChildren(el('p', 'fm-empty', 'Chế độ Demo: Xem trước file trực tiếp hoạt động khi kết nối máy chủ Work Office.'));
    return;
  }

  try {
    const r = await fetch(`/api/files/preview${q(`path=${encodeURIComponent(item.path)}`)}`);
    const d = await r.json();
    if (selectedItem?.path !== item.path) return;
    if (!d?.ok) {
      bodyWrap.replaceChildren(el('p', 'fm-empty', `Không thể xem trước file: ${d?.error || 'Lỗi đọc file'}`));
      return;
    }

    if (d.kind === 'docx') {
      const pageHolder = el('div', 'fm-docx-holder');
      pageHolder.append(buildSafeDocxDom(d.html, d.text));
      bodyWrap.replaceChildren(pageHolder);
      return;
    }

    if (d.kind === 'xlsx') {
      bodyWrap.replaceChildren(buildXlsxViewer(d.sheets));
      return;
    }

    if (d.kind === 'media') {
      const rawUrl = `/api/files/raw${q(`path=${encodeURIComponent(item.path)}`)}`;
      if (d.mediaType === 'pdf') {
        const frame = el('iframe', 'fm-pdf-frame');
        frame.src = rawUrl;
        frame.title = item.name;
        bodyWrap.replaceChildren(frame);
      } else if (d.mediaType === 'image') {
        const imgBox = el('div', 'fm-img-wrap');
        const img = el('img', 'fm-img-preview');
        img.src = rawUrl;
        img.alt = item.name;
        imgBox.append(img);
        bodyWrap.replaceChildren(imgBox);
      } else if (d.mediaType === 'video') {
        const vid = el('video', 'fm-video-preview');
        vid.controls = true;
        vid.src = rawUrl;
        bodyWrap.replaceChildren(vid);
      } else if (d.mediaType === 'audio') {
        const aud = el('audio', 'fm-audio-preview');
        aud.controls = true;
        aud.src = rawUrl;
        bodyWrap.replaceChildren(aud);
      }
      return;
    }

    if (d.kind === 'text') {
      const editorWrap = el('div', 'fm-editor-wrap');
      const editorBar = el('div', 'fm-editor-bar');
      const lineCount = String(d.content || '').split('\n').length;
      editorBar.append(
        el('small', 'muted', `💻 ${lineCount} dòng${d.truncated ? ' · (Đang hiển thị 512KB đầu tiên)' : ''}`),
      );
      const ta = el('textarea', 'fm-code-editor');
      ta.value = d.content || '';
      ta.spellcheck = false;
      ta.readOnly = !canEdit || Boolean(d.truncated);
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && canEdit && !d.truncated) {
          e.preventDefault();
          saveBtn?.click();
        }
      });

      let saveBtn = null;
      if (canEdit && !d.truncated) {
        saveBtn = el('button', 'btn btn--sm btn--confirm', '💾 Lưu thay đổi');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', async () => {
          saveBtn.disabled = true;
          saveBtn.textContent = '⏳ Đang lưu...';
          const res = await postFileAction({ action: 'writeText', path: item.path, content: ta.value });
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Lưu thay đổi';
          if (res?.ok) {
            item.size = res.size ?? item.size;
            item.mtimeMs = res.mtimeMs ?? Date.now();
            toast(`✅ Đã lưu thay đổi vào ${item.name}`);
            renderTree();
          } else {
            toast(res?.error || 'Không thể lưu file.');
          }
        });
        editorBar.append(saveBtn);
      }
      editorWrap.append(editorBar, ta);
      bodyWrap.replaceChildren(editorWrap);
      return;
    }

    bodyWrap.replaceChildren(
      el('div', 'fm-binary-box', '📦 File nhị phân — Hãy bấm "⬇️ Tải về máy" ở thanh công cụ phía trên để mở trên thiết bị của bạn.'),
    );
  } catch {
    bodyWrap.replaceChildren(el('p', 'fm-empty', 'Không thể kết nối máy chủ để đọc file.'));
  }
}

async function postFileAction(payload) {
  try {
    const r = await fetch(`/api/files/action${q()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch {
    return { ok: false, error: 'network_error' };
  }
}

function promptRenameItem(item) {
  if (!previewEl) return;
  const nameNode = previewEl.querySelector('.fm-file-name');
  if (!nameNode) return;
  const f = el('form', 'fm-inline-form');
  const inp = el('input', 'fm-inline-in');
  inp.type = 'text';
  inp.value = item.name;
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      f.replaceWith(nameNode);
    }
  });
  const ok = el('button', 'btn btn--sm btn--confirm', 'Lưu');
  ok.type = 'submit';
  const cancel = el('button', 'btn btn--sm', 'Hủy');
  cancel.type = 'button';
  cancel.addEventListener('click', () => f.replaceWith(nameNode));
  f.append(inp, ok, cancel);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = inp.value.trim();
    if (!newName || newName === item.name) {
      f.replaceWith(nameNode);
      return;
    }
    ok.disabled = true;
    const r = await postFileAction({ action: 'rename', path: item.path, newName });
    if (r?.ok) {
      toast(`✅ Đã đổi tên thành ${r.name || newName}`);
      await loadDirectory(currentDir, r.path);
    } else {
      ok.disabled = false;
      toast(r?.error || 'Không thể đổi tên file.');
    }
  });
  nameNode.replaceWith(f);
  inp.focus();
  inp.select();
}

function promptNewFolder() {
  if (!treeEl || !currentDir) return;
  const existing = treeEl.querySelector('.fm-mkdir-box');
  if (existing) {
    existing.querySelector('input')?.focus();
    return;
  }
  const box = el('form', 'fm-mkdir-box');
  const inp = el('input', 'fm-inline-in');
  inp.type = 'text';
  inp.placeholder = 'Nhập tên thư mục mới...';
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      box.remove();
    }
  });
  const ok = el('button', 'btn btn--sm btn--confirm', 'Tạo');
  ok.type = 'submit';
  const cancel = el('button', 'btn btn--sm', 'Hủy');
  cancel.type = 'button';
  cancel.addEventListener('click', () => box.remove());
  box.append(inp, ok, cancel);
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const folderName = inp.value.trim();
    if (!folderName) return;
    ok.disabled = true;
    const r = await postFileAction({ action: 'mkdir', path: currentDir, newName: folderName });
    if (r?.ok) {
      toast(`📁 Đã tạo thư mục "${folderName}"`);
      await loadDirectory(currentDir);
    } else {
      ok.disabled = false;
      toast(r?.error || 'Không thể tạo thư mục.');
    }
  });
  treeEl.prepend(box);
  inp.focus();
}

async function handleUploadFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length || !currentDir) return;
  if (uploadBtnEl) {
    uploadBtnEl.disabled = true;
    uploadBtnEl.textContent = '⏳ Đang tải lên...';
  }
  try {
    const payloadFiles = [];
    for (const f of files.slice(0, 25)) {
      const contentBase64 = await readFileAsBase64(f);
      payloadFiles.push({ name: f.name, contentBase64 });
    }
    const r = await fetch(`/api/files/upload${q()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir: currentDir, files: payloadFiles }),
    }).then((x) => x.json()).catch(() => null);
    if (r?.ok) {
      const count = r.saved?.length || payloadFiles.length;
      toast(`✅ Đã tải lên ${count} file vào thư mục hiện tại!`);
      const firstSaved = r.saved?.[0]?.path || '';
      await loadDirectory(currentDir, firstSaved);
    } else {
      toast(r?.error || 'Không thể tải file lên.');
    }
  } catch {
    toast('Lỗi khi đọc hoặc tải file lên.');
  } finally {
    if (uploadBtnEl) {
      uploadBtnEl.disabled = false;
      uploadBtnEl.textContent = '⬆️ Tải file lên';
    }
  }
}

async function loadWorkspaces(preferredDir = '') {
  try {
    const r = await fetch(`/api/files/workspaces${q()}`).then((x) => x.json()).catch(() => null);
    if (r?.ok && Array.isArray(r.workspaces)) {
      workspaces = r.workspaces;
      canEdit = Boolean(r.canEditFiles);
    } else {
      const seen = new Map();
      for (const s of sessions.values()) {
        if (s.masked || !canSeeSession(s)) continue;
        const d = s.cwd || s.dir;
        if (d && !seen.has(d)) {
          seen.set(d, { path: d, name: d.split(/[\\/]/).filter(Boolean).pop() || d, canEdit: canUserEditFiles() });
        }
      }
      workspaces = [...seen.values()];
      canEdit = canUserEditFiles();
    }
  } catch {
    workspaces = [];
    canEdit = canUserEditFiles();
  }

  if (uploadBtnEl) uploadBtnEl.hidden = !canEdit;
  if (mkdirBtnEl) mkdirBtnEl.hidden = !canEdit;

  if (wsSelectEl) {
    wsSelectEl.replaceChildren();
    if (!workspaces.length) {
      const opt = el('option', null, 'Chưa có Workspace khả dụng');
      opt.value = '';
      wsSelectEl.append(opt);
    } else {
      for (const ws of workspaces) {
        const opt = el('option', null, `📁 ${ws.name} (${ws.path})`);
        opt.value = ws.path;
        wsSelectEl.append(opt);
      }
    }
  }

  let targetDir = preferredDir;
  if (targetDir) {
    const normTarget = normPath(targetDir).toLowerCase();
    const matchedWs = workspaces.find((ws) => {
      const nw = normPath(ws.path).toLowerCase();
      return normTarget === nw || normTarget.startsWith(nw + '/');
    });
    if (matchedWs) {
      currentWorkspaceRoot = matchedWs.path;
      if (wsSelectEl) wsSelectEl.value = matchedWs.path;
    } else if (workspaces[0]) {
      currentWorkspaceRoot = workspaces[0].path;
      targetDir = workspaces[0].path;
      if (wsSelectEl) wsSelectEl.value = workspaces[0].path;
    }
  } else if (workspaces[0]) {
    currentWorkspaceRoot = workspaces[0].path;
    targetDir = workspaces[0].path;
    if (wsSelectEl) wsSelectEl.value = workspaces[0].path;
  }

  if (targetDir) {
    await loadDirectory(targetDir);
  } else if (treeEl) {
    treeEl.replaceChildren(el('p', 'fm-empty', 'Chưa có dự án nào được cấp quyền truy cập.'));
  }
}

async function loadDirectory(dirPath, autoSelectPath = '') {
  if (!dirPath) return;
  if (treeEl) treeEl.replaceChildren(el('p', 'fm-loading', '⏳ Đang đọc danh sách file...'));
  try {
    const r = await fetch(`/api/files/list${q(`dir=${encodeURIComponent(dirPath)}`)}`).then((x) => x.json()).catch(() => null);
    if (!r?.ok) {
      if (treeEl) treeEl.replaceChildren(el('p', 'fm-empty', `Không thể mở thư mục: ${r?.error || 'Không có quyền hoặc không tồn tại'}`));
      return;
    }
    currentDir = r.dir || dirPath;
    currentWorkspaceRoot = r.workspaceRoot || currentWorkspaceRoot || currentDir;
    if (typeof r.canEdit === 'boolean') {
      canEdit = r.canEdit;
      if (uploadBtnEl) uploadBtnEl.hidden = !canEdit;
      if (mkdirBtnEl) mkdirBtnEl.hidden = !canEdit;
    }
    if (wsSelectEl && currentWorkspaceRoot) {
      wsSelectEl.value = currentWorkspaceRoot;
    }
    currentItems = Array.isArray(r.items) ? r.items : [];
    renderBreadcrumbs();
    renderTree();

    if (autoSelectPath) {
      const hit = currentItems.find((x) => !x.isDir && normPath(x.path).toLowerCase() === normPath(autoSelectPath).toLowerCase());
      if (hit) {
        await selectFile(hit);
        return;
      }
    }
    if (!selectedItem || !currentItems.some((x) => x.path === selectedItem.path)) {
      selectedItem = null;
      if (previewEl) {
        previewEl.replaceChildren(
          el('div', 'fm-preview-placeholder', '👈 Chọn một file ở danh sách bên trái (.docx, .xlsx, .csv, .pdf, ảnh, code...) để xem trực tiếp hoặc tải về.'),
        );
      }
    }
  } catch {
    if (treeEl) treeEl.replaceChildren(el('p', 'fm-empty', 'Không thể tải danh sách thư mục.'));
  }
}

function ensureFileManagerModal() {
  if (modalEl) return modalEl;
  modalEl = el('div', 'modal fm-modal');
  modalEl.id = 'file-manager-modal';
  modalEl.hidden = true;
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  modalEl.setAttribute('aria-label', tr('ui.files.title'));

  const card = el('div', 'modal-card fm-card');

  // Top Header & Toolbar
  const topBar = el('div', 'fm-toolbar');
  const titleRow = el('div', 'fm-title-row');
  const titleLeft = el('div', 'fm-title-left');
  titleLeft.append(el('h3', 'fm-title', '📁 Quản lý & Xem File Dự Án'));

  wsSelectEl = el('select', 'fm-ws-select');
  wsSelectEl.setAttribute('aria-label', 'Chọn dự án Workspace');
  wsSelectEl.addEventListener('change', () => {
    if (wsSelectEl.value) {
      currentWorkspaceRoot = wsSelectEl.value;
      selectedItem = null;
      loadDirectory(wsSelectEl.value);
    }
  });
  titleLeft.append(wsSelectEl);

  const toolActions = el('div', 'fm-tool-actions');
  searchInEl = el('input', 'fm-search-in');
  searchInEl.type = 'search';
  searchInEl.placeholder = '🔍 Tìm nhanh file...';
  searchInEl.addEventListener('keydown', (e) => e.stopPropagation());
  searchInEl.addEventListener('input', () => {
    searchQuery = searchInEl.value;
    renderTree();
  });

  fileInputEl = el('input');
  fileInputEl.type = 'file';
  fileInputEl.multiple = true;
  fileInputEl.hidden = true;
  fileInputEl.addEventListener('change', async () => {
    if (fileInputEl.files?.length) {
      await handleUploadFiles(fileInputEl.files);
      fileInputEl.value = '';
    }
  });

  uploadBtnEl = el('button', 'btn btn--sm btn--confirm fm-btn-upload', '⬆️ Tải file lên');
  uploadBtnEl.type = 'button';
  uploadBtnEl.title = 'Tải file (.docx, .xlsx, .pdf, ảnh, code...) từ thiết bị của bạn lên thư mục này';
  uploadBtnEl.addEventListener('click', () => fileInputEl.click());

  mkdirBtnEl = el('button', 'btn btn--sm fm-btn-mkdir', '➕ Tạo thư mục');
  mkdirBtnEl.type = 'button';
  mkdirBtnEl.addEventListener('click', () => promptNewFolder());

  const refreshBtn = el('button', 'btn btn--sm fm-btn-refresh', '🔄 Làm mới');
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', () => loadDirectory(currentDir || currentWorkspaceRoot));

  const closeBtn = el('button', 'ib fm-btn-close', '✕');
  closeBtn.type = 'button';
  closeBtn.title = 'Đóng (Esc)';
  closeBtn.addEventListener('click', closeFileManager);

  toolActions.append(searchInEl, fileInputEl, uploadBtnEl, mkdirBtnEl, refreshBtn, closeBtn);
  titleRow.append(titleLeft, toolActions);

  breadcrumbsEl = el('div', 'fm-breadcrumbs');
  topBar.append(titleRow, breadcrumbsEl);

  // Two-pane body
  const splitBody = el('div', 'fm-body');
  treeEl = el('div', 'fm-tree');
  previewEl = el('div', 'fm-preview');
  previewEl.append(
    el('div', 'fm-preview-placeholder', '👈 Chọn một file ở danh sách bên trái (.docx, .xlsx, .csv, .pdf, ảnh, code...) để xem trực tiếp hoặc tải về.'),
  );
  splitBody.append(treeEl, previewEl);

  card.append(topBar, splitBody);
  modalEl.append(card);

  modalEl.addEventListener('click', (ev) => {
    if (ev.target === modalEl) closeFileManager();
  });

  document.body.append(modalEl);
  return modalEl;
}

export function closeFileManager() {
  if (modalEl) modalEl.hidden = true;
}

export async function openFileManager(initialDir = '') {
  const modal = ensureFileManagerModal();
  modal.hidden = false;
  const fallbackDir = initialDir
    || (state.selectedId && (sessions.get(state.selectedId)?.cwd || sessions.get(state.selectedId)?.dir))
    || '';
  await loadWorkspaces(fallbackDir);
}

export function setupFileManager() {
  ensureFileManagerModal();
  const topbarRight = document.querySelector('.topbar .tb-group--primary') || document.querySelector('.topbar .tb-actions') || document.querySelector('#topbar .tb-right');
  if (topbarRight && !$('btn-files-top')) {
    const btn = el('button', 'tb-btn tb-btn--files');
    btn.id = 'btn-files-top';
    btn.type = 'button';
    btn.title = 'Mở trình quản lý & xem trực tiếp file dự án (.docx, .xlsx, .pdf, ảnh, code)';
    btn.append(el('span', 'tb-files-ico', '📁'), el('span', 'lbl', 'File Dự Án'));
    btn.addEventListener('click', () => openFileManager());
    const anchorBtn = $('btn-mcp') || $('btn-task');
    if (anchorBtn && anchorBtn.parentElement === topbarRight) {
      anchorBtn.before(btn);
    } else {
      topbarRight.prepend(btn);
    }
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && modalEl && !modalEl.hidden) {
      ev.preventDefault();
      ev.stopPropagation();
      closeFileManager();
    }
  });
}
