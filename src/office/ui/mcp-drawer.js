// MCP Hub modal: view, test, toggle, clone, export/import, add/edit and inspect Model Context Protocol servers & tools.
import { state } from '../core/state.js';
import { $, el } from '../core/env.js';
import { toast } from './activity.js';
import { icon } from './icons.js';
import { TOKEN } from '../net/live.js';
import { t as tr } from '../../i18n/index.js';

const qParam = () => (TOKEN ? `?k=${encodeURIComponent(TOKEN)}` : '');

const FALLBACK_PRESETS = [
  {
    id: 'figma',
    name: 'figma',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    envKeys: ['FIGMA_API_KEY'],
    headerKeys: [],
    title: 'Figma Developer MCP',
    desc: 'Đọc thiết kế, layout, component và tải ảnh trực tiếp từ Figma',
  },
  {
    id: '@21st-dev/magic',
    name: '@21st-dev/magic',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@21st-dev/magic@latest'],
    envKeys: ['API_KEY'],
    headerKeys: [],
    title: '21st.dev Magic UI',
    desc: 'Tạo UI component hiện đại, tìm kiếm cảm hứng thiết kế và dựng video block',
  },
  {
    id: 'stitch',
    name: 'stitch',
    transport: 'http',
    serverUrl: 'https://stitch.googleapis.com/mcp',
    envKeys: [],
    headerKeys: ['X-Goog-Api-Key'],
    title: 'Google Stitch MCP',
    desc: 'Thiết kế màn hình UI, tạo Design System và sinh biến thể giao diện với Google Stitch',
  },
  {
    id: 'composio',
    name: 'composio',
    transport: 'http',
    serverUrl: 'https://connect.composio.dev/mcp',
    envKeys: [],
    headerKeys: ['x-consumer-api-key'],
    title: 'Composio Integration Hub',
    desc: 'Kết nối hàng trăm ứng dụng bên ngoài (GitHub, Notion, Slack, Gmail, Jira...)',
  },
  {
    id: 'github',
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    headerKeys: [],
    title: 'GitHub Official MCP',
    desc: 'Quản lý Repository, Issue, Pull Request và tìm kiếm mã nguồn GitHub',
  },
  {
    id: 'playwright',
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    envKeys: [],
    headerKeys: [],
    title: 'Playwright Browser Automation',
    desc: 'Điều khiển trình duyệt tự động, kiểm thử E2E và chụp ảnh giao diện web',
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envKeys: [],
    headerKeys: [],
    title: 'Sequential Thinking',
    desc: 'Hỗ trợ phân tích bài toán phức tạp theo chuỗi suy luận từng bước',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', 'E:/WorkOffice'],
    envKeys: [],
    headerKeys: [],
    title: 'Filesystem MCP',
    desc: 'Đọc/ghi và quản lý cây thư mục dự án được cấp phép',
  },
  {
    id: 'memory',
    name: 'memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    envKeys: [],
    headerKeys: [],
    title: 'Knowledge Graph Memory',
    desc: 'Bộ nhớ đồ thị tri thức dài hạn lưu trữ thực thể và quan hệ cho AI Agent',
  },
  {
    id: 'fetch',
    name: 'fetch',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    envKeys: [],
    headerKeys: [],
    title: 'Web Fetch & Markdown Reader',
    desc: 'Tải nội dung trang web, tài liệu kỹ thuật và chuyển đổi sang Markdown sạch',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: ['BRAVE_API_KEY'],
    headerKeys: [],
    title: 'Brave Web & Local Search',
    desc: 'Tìm kiếm web thời gian thực và tra cứu thông tin qua Brave Search API',
  },
  {
    id: 'postgres',
    name: 'postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost:5432/mydb'],
    envKeys: [],
    headerKeys: [],
    title: 'PostgreSQL Database Inspector',
    desc: 'Khảo sát schema bảng và chạy truy vấn đọc an toàn trên cơ sở dữ liệu PostgreSQL',
  },
];

let mcpData = {
  canManage: true,
  servers: [],
  summary: { total: 0, enabled: 0, disabled: 0, totalTools: 0 },
  presets: FALLBACK_PRESETS,
  configPath: '',
  rawConfigJson: '',
};

let searchQuery = '';
let statusFilter = 'all'; // 'all' | 'enabled' | 'disabled'
let editorOpen = false;
let editorTab = 'presets'; // 'presets' | 'custom' | 'json' | 'export'
let editingServer = null; // server object when editing existing
const expandedTools = new Set();
const expandedToolItems = new Set();
const perServerToolFilter = new Map();
const revealedSecrets = new Set();
const testingNames = new Set();
let testingAll = false;

let listContainerEl = null;
let statPillsEl = null;
let pathBarEl = null;
let editorContainerEl = null;

async function postMcp(body) {
  try {
    const r = await fetch(`/api/mcp${qParam()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok && (!data || typeof data.ok !== 'boolean')) {
      return { ok: false, message: `HTTP ${r.status}: ${r.statusText || 'Error'}` };
    }
    return data;
  } catch (err) {
    return { ok: false, message: err?.message || tr('drawer.unreachable') };
  }
}

function canUserManage() {
  if (typeof mcpData.canManage === 'boolean') return mcpData.canManage;
  if (state.isLocal) return true;
  const v = state.viewer;
  return Boolean(v?.isDirectorDevice || v?.role === 'Phó Giám đốc');
}

export function syncMcpBadge(summary) {
  if (summary && typeof summary === 'object') {
    state.mcpSummary = summary;
    mcpData.summary = { ...mcpData.summary, ...summary };
  }
  const s = state.mcpSummary || mcpData.summary;
  const badge = $('mcp-badge');
  if (!badge) return;
  const count = Number(s?.enabled || 0);
  badge.hidden = count <= 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

function applyServerPayload(res) {
  if (!res || typeof res !== 'object') return;
  if (Array.isArray(res.servers)) mcpData.servers = res.servers;
  if (res.summary && typeof res.summary === 'object') {
    mcpData.summary = res.summary;
    syncMcpBadge(res.summary);
  }
  if (Array.isArray(res.presets) && res.presets.length) {
    mcpData.presets = res.presets;
  }
  if (typeof res.canManage === 'boolean') {
    mcpData.canManage = res.canManage;
  }
  if (typeof res.configPath === 'string') {
    mcpData.configPath = res.configPath;
  }
  if (typeof res.rawConfigJson === 'string') {
    mcpData.rawConfigJson = res.rawConfigJson;
  }
  const addBtn = $('mcp-btn-add');
  const testAllBtn = $('mcp-btn-test-all');
  const manage = canUserManage();
  if (addBtn) {
    addBtn.hidden = !manage;
    addBtn.textContent = editorOpen ? tr('ui.mcp.closeEditor') : tr('ui.mcp.addServer');
  }
  if (testAllBtn) {
    testAllBtn.hidden = !manage;
    testAllBtn.disabled = testingAll;
    testAllBtn.textContent = testingAll ? tr('ui.mcp.testingAll') : tr('ui.mcp.testAll');
  }
}

export async function loadMcp() {
  const res = await fetch(`/api/mcp${qParam()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (res?.ok) {
    applyServerPayload(res);
  }
  if ($('mcp-modal') && !$('mcp-modal').hidden) {
    renderMcpBody();
  }
  return res;
}

export function openMcp() {
  const modal = $('mcp-modal');
  if (!modal) return;
  modal.hidden = false;
  $('btn-mcp')?.setAttribute('aria-expanded', 'true');
  renderMcpBody();
  loadMcp();
}

export function closeMcp() {
  const modal = $('mcp-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  $('btn-mcp')?.setAttribute('aria-expanded', 'false');
}

function copyText(val) {
  if (!val) return;
  navigator.clipboard?.writeText(String(val)).then(
    () => toast(tr('ui.mcp.copied')),
    () => {},
  );
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildSingleServerJson(srv) {
  const isHttp = srv.transport === 'http';
  const entry = isHttp
    ? {
        serverUrl: srv.serverUrl || srv.url || '',
        ...(Object.keys(srv.headers || srv.maskedHeaders || {}).length
          ? { headers: srv.headers || srv.maskedHeaders }
          : {}),
      }
    : {
        command: srv.command || 'npx',
        args: Array.isArray(srv.args) ? srv.args : [],
        ...(Object.keys(srv.env || srv.maskedEnv || {}).length
          ? { env: srv.env || srv.maskedEnv }
          : {}),
      };
  return JSON.stringify({ mcpServers: { [srv.name]: entry } }, null, 2);
}

function renderStatsPills() {
  if (!statPillsEl) return;
  statPillsEl.replaceChildren();
  const totalCount = mcpData.servers.length;
  const enabledCount = mcpData.servers.filter((x) => x.enabled).length;
  const disabledCount = Math.max(0, totalCount - enabledCount);
  const s = mcpData.summary || {
    total: totalCount,
    enabled: enabledCount,
    disabled: disabledCount,
    totalTools: mcpData.servers.reduce((acc, x) => acc + (x.toolsCount || x.tools?.length || 0), 0),
  };

  const leftBox = el('div', 'mcp-stat-left');
  const pillTotal = el('span', 'mcp-stat-pill', tr('ui.mcp.statTotal', { n: s.total ?? totalCount }));
  const pillActive = el('span', 'mcp-stat-pill mcp-stat-pill--ok', tr('ui.mcp.statEnabled', { n: s.enabled ?? enabledCount }));
  const pillDisabled = el('span', 'mcp-stat-pill mcp-stat-pill--off', tr('ui.mcp.statDisabled', { n: s.disabled ?? disabledCount }));
  const pillTools = el('span', 'mcp-stat-pill mcp-stat-pill--tools', tr('ui.mcp.statTools', { n: s.totalTools ?? 0 }));
  leftBox.append(pillTotal, pillActive, pillDisabled, pillTools);

  const batchBox = el('div', 'mcp-batch-acts');
  const refreshBtn = el('button', 'btn btn--sm', tr('ui.mcp.refreshBtn'));
  refreshBtn.type = 'button';
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    await loadMcp();
    refreshBtn.disabled = false;
    toast(tr('ui.mcp.refreshedToast'));
  });
  batchBox.append(refreshBtn);

  if (canUserManage()) {
    if (disabledCount > 0) {
      const enableAllBtn = el('button', 'btn btn--sm', tr('ui.mcp.enableAllBtn'));
      enableAllBtn.type = 'button';
      enableAllBtn.addEventListener('click', async () => {
        enableAllBtn.disabled = true;
        const res = await postMcp({ action: 'toggleAll', enabled: true });
        enableAllBtn.disabled = false;
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr('ui.mcp.enabledAllToast'));
          renderStatsPills();
          renderEditor();
          renderServerList();
        } else {
          toast(res?.message || tr('drawer.unreachable'));
        }
      });
      batchBox.append(enableAllBtn);
    }
    if (enabledCount > 0) {
      const disableAllBtn = el('button', 'btn btn--sm', tr('ui.mcp.disableAllBtn'));
      disableAllBtn.type = 'button';
      disableAllBtn.addEventListener('click', async () => {
        disableAllBtn.disabled = true;
        const res = await postMcp({ action: 'toggleAll', enabled: false });
        disableAllBtn.disabled = false;
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr('ui.mcp.disabledAllToast'));
          renderStatsPills();
          renderEditor();
          renderServerList();
        } else {
          toast(res?.message || tr('drawer.unreachable'));
        }
      });
      batchBox.append(disableAllBtn);
    }
    const exportBtn = el('button', 'btn btn--sm', tr('ui.mcp.exportBtn'));
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => {
      editorTab = 'export';
      editorOpen = true;
      renderEditor();
    });
    batchBox.append(exportBtn);
  }

  statPillsEl.append(leftBox, batchBox);

  if (pathBarEl) {
    pathBarEl.replaceChildren();
    if (mcpData.configPath) {
      pathBarEl.hidden = false;
      pathBarEl.append(
        el('span', '', tr('ui.mcp.configPathLabel')),
        el('code', 'mcp-path-code', mcpData.configPath),
      );
      const cpPathBtn = el('button', 'mcp-mini-btn', '📋');
      cpPathBtn.type = 'button';
      cpPathBtn.title = tr('ui.mcp.copyVal');
      cpPathBtn.addEventListener('click', () => copyText(mcpData.configPath));
      pathBarEl.append(cpPathBtn);
    } else {
      pathBarEl.hidden = true;
    }
  }
}

function buildKeyValEditor(titleText, addBtnText, initialMap = {}, { extraHelpers = [], onChange = null } = {}) {
  const wrap = el('div', 'mcp-kv-group');
  const head = el('div', 'mcp-kv-head');
  const lbl = el('label', 'mcp-field-label', titleText);
  const headBtns = el('div', 'mcp-kv-head-btns');

  const addBtn = el('button', 'btn btn--sm mcp-kv-add', addBtnText);
  addBtn.type = 'button';
  headBtns.append(addBtn);

  const rowsBox = el('div', 'mcp-kv-rows');
  const rows = [];

  const notifyChange = () => {
    if (typeof onChange === 'function') onChange();
  };

  const addRow = (k = '', v = '') => {
    const row = el('div', 'mcp-kv-row');
    const kIn = el('input', 'mcp-input mcp-kv-key');
    kIn.type = 'text';
    kIn.placeholder = tr('ui.mcp.keyPlaceholder');
    kIn.value = k;
    kIn.addEventListener('keydown', (e) => e.stopPropagation());
    kIn.addEventListener('input', notifyChange);

    const eq = el('span', 'mcp-kv-eq', '=');

    const vIn = el('input', 'mcp-input mcp-kv-val');
    vIn.type = 'text';
    vIn.placeholder = tr('ui.mcp.valPlaceholder');
    vIn.value = v;
    vIn.addEventListener('keydown', (e) => e.stopPropagation());
    vIn.addEventListener('input', notifyChange);

    const del = el('button', 'icon-btn mcp-kv-del', '✕');
    del.type = 'button';
    del.addEventListener('click', () => {
      const idx = rows.indexOf(entry);
      if (idx >= 0) rows.splice(idx, 1);
      row.remove();
      notifyChange();
    });

    const entry = { kIn, vIn };
    rows.push(entry);
    row.append(kIn, eq, vIn, del);
    rowsBox.append(row);
    notifyChange();
  };

  for (const helper of extraHelpers) {
    const hb = el('button', 'btn btn--sm', helper.label);
    hb.type = 'button';
    hb.addEventListener('click', () => addRow(helper.key, helper.val || ''));
    headBtns.append(hb);
  }

  head.append(lbl, headBtns);

  const entries = Object.entries(initialMap || {});
  if (entries.length > 0) {
    for (const [k, v] of entries) addRow(k, String(v ?? ''));
  } else {
    addRow('', '');
  }

  addBtn.addEventListener('click', () => addRow('', ''));
  wrap.append(head, rowsBox);

  return {
    el: wrap,
    getMap() {
      const out = {};
      for (const { kIn, vIn } of rows) {
        const k = kIn.value.trim();
        const v = vIn.value.trim();
        if (k && v) out[k] = v;
      }
      return out;
    },
  };
}

function parsePreviewArgs(rawStr) {
  const trimmed = String(rawStr || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* fall through */ }
  }
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function renderEditor() {
  if (!editorContainerEl) return;
  editorContainerEl.replaceChildren();
  const addBtn = $('mcp-btn-add');
  if (addBtn) {
    addBtn.textContent = editorOpen ? tr('ui.mcp.closeEditor') : tr('ui.mcp.addServer');
    addBtn.classList.toggle('is-open', editorOpen);
  }
  if (!editorOpen || !canUserManage()) {
    editorContainerEl.hidden = true;
    return;
  }
  editorContainerEl.hidden = false;

  const editor = el('section', 'mcp-editor');

  // Tabs header
  const tabsBar = el('div', 'mcp-editor-tabs');
  tabsBar.setAttribute('role', 'tablist');
  const tabDefs = [
    ['presets', tr('ui.mcp.tabPresets')],
    ['custom', tr('ui.mcp.tabCustom')],
    ['json', tr('ui.mcp.tabJson')],
    ['export', tr('ui.mcp.tabExport')],
  ];
  for (const [id, label] of tabDefs) {
    const b = el('button', `mcp-tab-btn${editorTab === id ? ' is-active' : ''}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(editorTab === id));
    b.addEventListener('click', () => {
      editorTab = id;
      if (id !== 'custom') editingServer = null;
      renderEditor();
    });
    tabsBar.append(b);
  }
  editor.append(tabsBar);

  const pane = el('div', 'mcp-editor-pane');

  if (editorTab === 'presets') {
    const grid = el('div', 'mcp-preset-grid');
    const serverByLowerName = new Map(
      (mcpData.servers || []).map((s) => [s.name.toLowerCase(), s]),
    );
    const presets = mcpData.presets?.length ? mcpData.presets : FALLBACK_PRESETS;

    for (const p of presets) {
      const card = el('div', 'mcp-preset-card');
      const existingSrv = serverByLowerName.get(p.name.toLowerCase()) || null;
      const isInstalled = Boolean(existingSrv);
      const isEnabled = Boolean(existingSrv?.enabled);

      const top = el('div', 'mcp-preset-top');
      const titleWrap = el('div', 'mcp-preset-titles');
      titleWrap.append(
        el('b', 'mcp-preset-title', p.title || p.name),
        el('code', 'mcp-preset-id', p.name),
      );
      const badgeWrap = el('div', 'mcp-card-badges');
      badgeWrap.append(
        el(
          'span',
          `mcp-badge ${p.transport === 'http' ? 'mcp-badge--http' : 'mcp-badge--stdio'}`,
          p.transport === 'http' ? tr('ui.mcp.badgeHttp') : tr('ui.mcp.badgeStdio'),
        ),
      );
      if (isInstalled) {
        badgeWrap.append(
          el(
            'span',
            `mcp-badge ${isEnabled ? 'mcp-badge--on' : 'mcp-badge--off'}`,
            isEnabled ? tr('ui.mcp.statusEnabled') : tr('ui.mcp.presetDisabledState'),
          ),
        );
      }
      top.append(titleWrap, badgeWrap);

      const desc = el('p', 'mcp-preset-desc', p.desc || '');
      const cmdPreview = el(
        'code',
        'mcp-preset-cmd',
        p.transport === 'http' ? p.serverUrl : [p.command, ...(p.args || [])].join(' '),
      );

      const inputsWrap = el('div', 'mcp-preset-inputs');
      const envInputs = {};
      const headerInputs = {};

      for (const ek of p.envKeys || []) {
        const inp = el('input', 'mcp-input mcp-input--sm');
        inp.type = 'password';
        inp.autocomplete = 'off';
        inp.placeholder = tr('ui.mcp.presetKeyHint', { key: ek });
        if (existingSrv?.env?.[ek]) inp.value = existingSrv.env[ek];
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        envInputs[ek] = inp;
        inputsWrap.append(inp);
      }
      for (const hk of p.headerKeys || []) {
        const inp = el('input', 'mcp-input mcp-input--sm');
        inp.type = 'password';
        inp.autocomplete = 'off';
        inp.placeholder = tr('ui.mcp.presetKeyHint', { key: hk });
        if (existingSrv?.headers?.[hk]) inp.value = existingSrv.headers[hk];
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        headerInputs[hk] = inp;
        inputsWrap.append(inp);
      }

      const actsRow = el('div', 'mcp-preset-acts');
      const connectBtn = el(
        'button',
        `btn btn--sm ${isInstalled ? 'mcp-preset-btn--installed' : 'btn--confirm'} mcp-preset-btn`,
        isInstalled ? tr('ui.mcp.presetConnected') : tr('ui.mcp.presetConnect'),
      );
      connectBtn.type = 'button';
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true;
        connectBtn.textContent = tr('ui.mcp.saving');
        const env = {};
        for (const [k, inp] of Object.entries(envInputs)) {
          if (inp.value.trim()) env[k] = inp.value.trim();
        }
        const headers = {};
        for (const [k, inp] of Object.entries(headerInputs)) {
          if (inp.value.trim()) headers[k] = inp.value.trim();
        }
        const res = await postMcp({
          action: 'upsert',
          name: p.name,
          title: p.title,
          desc: p.desc,
          transport: p.transport,
          command: p.command,
          args: p.args,
          serverUrl: p.serverUrl,
          env,
          headers,
          enabled: true,
        });
        connectBtn.disabled = false;
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr('ui.mcp.savedToast', { name: p.name }));
          renderStatsPills();
          renderEditor();
          renderServerList();
        } else {
          connectBtn.textContent = isInstalled ? tr('ui.mcp.presetConnected') : tr('ui.mcp.presetConnect');
          toast(res?.message || tr('drawer.unreachable'));
        }
      });
      actsRow.append(connectBtn);

      if (isInstalled && !isEnabled) {
        const quickEnableBtn = el('button', 'btn btn--sm btn--confirm', tr('ui.mcp.presetEnableNow'));
        quickEnableBtn.type = 'button';
        quickEnableBtn.addEventListener('click', async () => {
          quickEnableBtn.disabled = true;
          const res = await postMcp({ action: 'toggle', name: existingSrv.name, enabled: true });
          quickEnableBtn.disabled = false;
          if (res?.ok) {
            applyServerPayload(res);
            toast(tr('ui.mcp.toggledOnToast', { name: existingSrv.name }));
            renderStatsPills();
            renderEditor();
            renderServerList();
          } else {
            toast(res?.message || tr('drawer.unreachable'));
          }
        });
        actsRow.append(quickEnableBtn);
      }

      card.append(top, desc, cmdPreview);
      if ((p.envKeys && p.envKeys.length) || (p.headerKeys && p.headerKeys.length)) {
        card.append(inputsWrap);
      }
      card.append(actsRow);
      grid.append(card);
    }
    pane.append(grid);
  } else if (editorTab === 'custom') {
    const isEdit = Boolean(editingServer);
    const initTransport = editingServer?.transport === 'http' ? 'http' : 'stdio';
    let currentTransport = initTransport;
    let wantEnabled = editingServer ? editingServer.enabled !== false : true;

    const form = el('form', 'mcp-custom-form');
    const heading = el(
      'h3',
      'mcp-form-title',
      isEdit ? tr('ui.mcp.formTitleEdit', { name: editingServer.name }) : tr('ui.mcp.formTitleAdd'),
    );

    const row1 = el('div', 'mcp-form-grid');
    const nameField = el('div', 'mcp-field');
    nameField.append(el('label', 'mcp-field-label', tr('ui.mcp.serverName')));
    const nameIn = el('input', 'mcp-input');
    nameIn.type = 'text';
    nameIn.required = true;
    nameIn.placeholder = tr('ui.mcp.serverNamePlaceholder');
    nameIn.value = editingServer?.name || '';
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    nameField.append(nameIn);

    const typeField = el('div', 'mcp-field');
    typeField.append(el('label', 'mcp-field-label', tr('ui.mcp.protocolType')));
    const typeSeg = el('div', 'mcp-type-seg');
    const btnStdio = el('button', `mcp-seg-btn${currentTransport === 'stdio' ? ' is-on' : ''}`, tr('ui.mcp.typeStdio'));
    btnStdio.type = 'button';
    const btnHttp = el('button', `mcp-seg-btn${currentTransport === 'http' ? ' is-on' : ''}`, tr('ui.mcp.typeHttp'));
    btnHttp.type = 'button';
    typeSeg.append(btnStdio, btnHttp);
    typeField.append(typeSeg);
    row1.append(nameField, typeField);

    // Optional Title, Description & Initial Status row
    const rowMeta = el('div', 'mcp-form-grid');
    const titleField = el('div', 'mcp-field');
    titleField.append(el('label', 'mcp-field-label', tr('ui.mcp.serverTitleLabel')));
    const titleIn = el('input', 'mcp-input');
    titleIn.type = 'text';
    titleIn.placeholder = tr('ui.mcp.serverTitlePlaceholder');
    titleIn.value = editingServer?.title && editingServer.title !== editingServer.name ? editingServer.title : '';
    titleIn.addEventListener('keydown', (e) => e.stopPropagation());
    titleField.append(titleIn);

    const stateField = el('div', 'mcp-field');
    stateField.append(el('label', 'mcp-field-label', tr('ui.mcp.initialStateLabel')));
    const stateSeg = el('div', 'mcp-type-seg');
    const btnStateOn = el('button', `mcp-seg-btn${wantEnabled ? ' is-on' : ''}`, tr('ui.mcp.stateEnableImmediate'));
    btnStateOn.type = 'button';
    const btnStateOff = el('button', `mcp-seg-btn${!wantEnabled ? ' is-on' : ''}`, tr('ui.mcp.stateStartDisabled'));
    btnStateOff.type = 'button';
    stateSeg.append(btnStateOn, btnStateOff);
    stateField.append(stateSeg);
    rowMeta.append(titleField, stateField);

    const descField = el('div', 'mcp-field');
    descField.append(el('label', 'mcp-field-label', tr('ui.mcp.serverDescLabel')));
    const descIn = el('input', 'mcp-input');
    descIn.type = 'text';
    descIn.placeholder = tr('ui.mcp.serverDescPlaceholder');
    descIn.value = editingServer?.desc || '';
    descIn.addEventListener('keydown', (e) => e.stopPropagation());
    descField.append(descIn);

    // Stdio section
    const stdioSec = el('div', 'mcp-transport-sec');
    const cmdField = el('div', 'mcp-field');
    cmdField.append(el('label', 'mcp-field-label', tr('ui.mcp.commandLabel')));
    const cmdIn = el('input', 'mcp-input');
    cmdIn.type = 'text';
    cmdIn.placeholder = tr('ui.mcp.commandPlaceholder');
    cmdIn.value = editingServer?.command || (currentTransport === 'stdio' ? 'npx' : '');
    cmdIn.addEventListener('keydown', (e) => e.stopPropagation());

    const cmdChips = el('div', 'mcp-cmd-chips');
    for (const sampleCmd of ['npx', 'node', 'uvx', 'python', 'docker']) {
      const chip = el('button', 'mcp-cmd-chip', sampleCmd);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        cmdIn.value = sampleCmd;
        updateLivePreview();
      });
      cmdChips.append(chip);
    }
    cmdField.append(cmdIn, cmdChips);

    const argsField = el('div', 'mcp-field');
    argsField.append(el('label', 'mcp-field-label', tr('ui.mcp.argsLabel')));
    const argsIn = el('input', 'mcp-input');
    argsIn.type = 'text';
    argsIn.placeholder = tr('ui.mcp.argsPlaceholder');
    argsIn.value = Array.isArray(editingServer?.args) ? editingServer.args.join(' ') : '';
    argsIn.addEventListener('keydown', (e) => e.stopPropagation());
    argsField.append(argsIn);

    const previewBox = el('div', 'mcp-live-preview');
    previewBox.append(el('label', 'mcp-field-label', tr('ui.mcp.livePreviewLabel')));
    const previewPre = el('pre', 'mcp-preview-pre');
    previewBox.append(previewPre);

    let envEditor = null;
    let headersEditor = null;

    function updateLivePreview() {
      const srvKey = nameIn.value.trim() || 'my-mcp-server';
      const entry =
        currentTransport === 'http'
          ? {
              serverUrl: urlIn.value.trim() || 'https://example.com/mcp',
              ...(headersEditor && Object.keys(headersEditor.getMap()).length
                ? { headers: headersEditor.getMap() }
                : {}),
            }
          : {
              command: cmdIn.value.trim() || 'npx',
              args: parsePreviewArgs(argsIn.value),
              ...(envEditor && Object.keys(envEditor.getMap()).length
                ? { env: envEditor.getMap() }
                : {}),
            };
      previewPre.textContent = JSON.stringify({ mcpServers: { [srvKey]: entry } }, null, 2);
    }

    const initEnv = editingServer?.env || editingServer?.maskedEnv || {};
    envEditor = buildKeyValEditor(tr('ui.mcp.envLabel'), tr('ui.mcp.addEnv'), initEnv, {
      onChange: updateLivePreview,
    });
    stdioSec.append(cmdField, argsField, envEditor.el);

    // HTTP section
    const httpSec = el('div', 'mcp-transport-sec');
    const urlField = el('div', 'mcp-field');
    urlField.append(el('label', 'mcp-field-label', tr('ui.mcp.serverUrlLabel')));
    const urlIn = el('input', 'mcp-input');
    urlIn.type = 'url';
    urlIn.placeholder = tr('ui.mcp.serverUrlPlaceholder');
    urlIn.value = editingServer?.serverUrl || editingServer?.url || '';
    urlIn.addEventListener('keydown', (e) => e.stopPropagation());
    urlField.append(urlIn);

    const initHeaders = editingServer?.headers || editingServer?.maskedHeaders || {};
    headersEditor = buildKeyValEditor(tr('ui.mcp.headersLabel'), tr('ui.mcp.addHeader'), initHeaders, {
      extraHelpers: [
        { label: tr('ui.mcp.addBearerHeader'), key: 'Authorization', val: 'Bearer ' },
        { label: tr('ui.mcp.addApiKeyHeader'), key: 'X-Api-Key', val: '' },
      ],
      onChange: updateLivePreview,
    });
    httpSec.append(urlField, headersEditor.el);

    const syncTransportView = () => {
      btnStdio.classList.toggle('is-on', currentTransport === 'stdio');
      btnHttp.classList.toggle('is-on', currentTransport === 'http');
      stdioSec.hidden = currentTransport !== 'stdio';
      httpSec.hidden = currentTransport !== 'http';
      updateLivePreview();
    };
    btnStdio.addEventListener('click', () => { currentTransport = 'stdio'; syncTransportView(); });
    btnHttp.addEventListener('click', () => { currentTransport = 'http'; syncTransportView(); });

    const syncStateView = () => {
      btnStateOn.classList.toggle('is-on', wantEnabled);
      btnStateOff.classList.toggle('is-on', !wantEnabled);
    };
    btnStateOn.addEventListener('click', () => { wantEnabled = true; syncStateView(); });
    btnStateOff.addEventListener('click', () => { wantEnabled = false; syncStateView(); });

    nameIn.addEventListener('input', updateLivePreview);
    cmdIn.addEventListener('input', updateLivePreview);
    argsIn.addEventListener('input', updateLivePreview);
    urlIn.addEventListener('input', updateLivePreview);
    syncTransportView();

    const acts = el('div', 'mcp-form-acts');
    const saveBtn = el('button', 'btn btn--sm btn--confirm', tr('ui.mcp.saveConnect'));
    saveBtn.type = 'submit';
    const cancelBtn = el('button', 'btn btn--sm', tr('ui.mcp.cancel'));
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => {
      editingServer = null;
      editorOpen = false;
      renderEditor();
    });
    acts.append(saveBtn, cancelBtn);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) {
        toast(tr('ui.mcp.nameRequired'));
        nameIn.focus();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = tr('ui.mcp.saving');
      const payload = {
        action: 'upsert',
        name,
        prevName: editingServer?.name || '',
        title: titleIn.value.trim(),
        desc: descIn.value.trim(),
        transport: currentTransport,
        enabled: wantEnabled,
      };
      if (currentTransport === 'http') {
        payload.serverUrl = urlIn.value.trim();
        payload.headers = headersEditor.getMap();
      } else {
        payload.command = cmdIn.value.trim();
        payload.args = argsIn.value.trim();
        payload.env = envEditor.getMap();
      }
      const res = await postMcp(payload);
      saveBtn.disabled = false;
      saveBtn.textContent = tr('ui.mcp.saveConnect');
      if (res?.ok) {
        applyServerPayload(res);
        toast(tr('ui.mcp.savedToast', { name }));
        editingServer = null;
        editorOpen = false;
        renderStatsPills();
        renderEditor();
        renderServerList();
      } else {
        toast(res?.message || tr('drawer.unreachable'));
      }
    });

    form.append(heading, row1, rowMeta, descField, stdioSec, httpSec, previewBox, acts);
    pane.append(form);
  } else if (editorTab === 'json') {
    const jsonBox = el('div', 'mcp-json-import');
    const hint = el('p', 'mcp-json-hint', tr('ui.mcp.jsonHint'));
    const ta = el('textarea', 'mcp-textarea');
    ta.rows = 9;
    ta.placeholder = tr('ui.mcp.jsonPlaceholder');
    ta.addEventListener('keydown', (e) => e.stopPropagation());

    const acts = el('div', 'mcp-form-acts');
    const importBtn = el('button', 'btn btn--sm btn--confirm', tr('ui.mcp.importJsonBtn'));
    importBtn.type = 'button';
    const formatBtn = el('button', 'btn btn--sm', tr('ui.mcp.formatJsonBtn'));
    formatBtn.type = 'button';
    const cancelBtn = el('button', 'btn btn--sm', tr('ui.mcp.cancel'));
    cancelBtn.type = 'button';

    const parseLooseClientJson = (rawText) => {
      let s = String(rawText || '').trim().replace(/,\s*$/, '');
      if (/^"[^"]+"\s*:\s*\{[\s\S]*\}$/.test(s)) {
        s = `{${s}}`;
      }
      s = s.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(s);
    };

    formatBtn.addEventListener('click', () => {
      try {
        const parsed = parseLooseClientJson(ta.value);
        ta.value = JSON.stringify(parsed, null, 2);
      } catch {
        toast(tr('ui.mcp.invalidJson'));
      }
    });

    cancelBtn.addEventListener('click', () => {
      editorOpen = false;
      renderEditor();
    });

    importBtn.addEventListener('click', async () => {
      const raw = ta.value.trim();
      if (!raw) {
        toast(tr('ui.mcp.invalidJson'));
        ta.focus();
        return;
      }
      let normalizedJson = raw;
      try {
        normalizedJson = JSON.stringify(parseLooseClientJson(raw), null, 2);
      } catch {
        toast(tr('ui.mcp.invalidJson'));
        ta.focus();
        return;
      }
      importBtn.disabled = true;
      importBtn.textContent = tr('ui.mcp.saving');
      const res = await postMcp({ action: 'importJson', json: normalizedJson, enabled: true });
      importBtn.disabled = false;
      importBtn.textContent = tr('ui.mcp.importJsonBtn');
      if (res?.ok) {
        applyServerPayload(res);
        toast(tr('ui.mcp.importedToast'));
        editorOpen = false;
        renderStatsPills();
        renderEditor();
        renderServerList();
      } else {
        toast(res?.message || tr('ui.mcp.invalidJson'));
      }
    });

    acts.append(importBtn, formatBtn, cancelBtn);
    jsonBox.append(hint, ta, acts);
    pane.append(jsonBox);
  } else if (editorTab === 'export') {
    const expBox = el('div', 'mcp-json-import');
    const hint = el('p', 'mcp-json-hint', tr('ui.mcp.exportHint'));
    const ta = el('textarea', 'mcp-textarea');
    ta.rows = 11;
    const activeEntries = {};
    for (const srv of mcpData.servers || []) {
      if (!srv.enabled) continue;
      if (srv.transport === 'http') {
        activeEntries[srv.name] = {
          serverUrl: srv.serverUrl || srv.url || '',
          ...(Object.keys(srv.headers || srv.maskedHeaders || {}).length
            ? { headers: srv.headers || srv.maskedHeaders }
            : {}),
        };
      } else {
        activeEntries[srv.name] = {
          command: srv.command || 'npx',
          args: Array.isArray(srv.args) ? srv.args : [],
          ...(Object.keys(srv.env || srv.maskedEnv || {}).length
            ? { env: srv.env || srv.maskedEnv }
            : {}),
        };
      }
    }
    ta.value = mcpData.rawConfigJson || JSON.stringify({ mcpServers: activeEntries }, null, 2);
    ta.addEventListener('keydown', (e) => e.stopPropagation());

    const acts = el('div', 'mcp-form-acts');
    const copyBtn = el('button', 'btn btn--sm btn--confirm', tr('ui.mcp.copyConfigBtn'));
    copyBtn.type = 'button';
    copyBtn.addEventListener('click', () => copyText(ta.value));

    const dlBtn = el('button', 'btn btn--sm', tr('ui.mcp.downloadConfigBtn'));
    dlBtn.type = 'button';
    dlBtn.addEventListener('click', () => downloadTextFile('mcp_config.json', ta.value));

    const applyRawBtn = el('button', 'btn btn--sm', tr('ui.mcp.saveRawConfigBtn'));
    applyRawBtn.type = 'button';
    applyRawBtn.addEventListener('click', async () => {
      const raw = ta.value.trim();
      try {
        JSON.parse(raw);
      } catch {
        toast(tr('ui.mcp.invalidJson'));
        ta.focus();
        return;
      }
      applyRawBtn.disabled = true;
      applyRawBtn.textContent = tr('ui.mcp.saving');
      const res = await postMcp({ action: 'importJson', json: raw, enabled: true });
      applyRawBtn.disabled = false;
      applyRawBtn.textContent = tr('ui.mcp.saveRawConfigBtn');
      if (res?.ok) {
        applyServerPayload(res);
        toast(tr('ui.mcp.importedToast'));
        renderStatsPills();
        renderEditor();
        renderServerList();
      } else {
        toast(res?.message || tr('ui.mcp.invalidJson'));
      }
    });

    const cancelBtn = el('button', 'btn btn--sm', tr('ui.mcp.cancel'));
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => {
      editorOpen = false;
      renderEditor();
    });

    acts.append(copyBtn, dlBtn, applyRawBtn, cancelBtn);
    expBox.append(hint, ta, acts);
    pane.append(expBox);
  }

  editor.append(pane);
  editorContainerEl.append(editor);
}

function renderServerList() {
  if (!listContainerEl) return;
  listContainerEl.replaceChildren();

  const q = searchQuery.trim().toLowerCase();
  const manage = canUserManage();

  const filtered = (mcpData.servers || []).filter((srv) => {
    if (statusFilter === 'enabled' && !srv.enabled) return false;
    if (statusFilter === 'disabled' && srv.enabled) return false;
    if (!q) return true;
    const matchServer =
      srv.name?.toLowerCase().includes(q) ||
      srv.title?.toLowerCase().includes(q) ||
      srv.desc?.toLowerCase().includes(q) ||
      srv.command?.toLowerCase().includes(q) ||
      srv.serverUrl?.toLowerCase().includes(q);
    const matchTool = (srv.tools || []).some(
      (tl) => tl.name?.toLowerCase().includes(q) || tl.description?.toLowerCase().includes(q),
    );
    return matchServer || matchTool;
  });

  if (filtered.length === 0) {
    listContainerEl.append(el('p', 'mcp-empty', tr('ui.mcp.emptyList')));
    return;
  }

  for (const srv of filtered) {
    const isHttp = srv.transport === 'http';
    const isTesting = testingNames.has(srv.name);
    const tools = srv.tools || [];
    const matchingTools = q
      ? tools.filter((tl) => tl.name?.toLowerCase().includes(q) || tl.description?.toLowerCase().includes(q))
      : tools;
    const autoExpandBySearch = Boolean(q && matchingTools.length > 0);
    const isToolsOpen = expandedTools.has(srv.name) || autoExpandBySearch;

    const card = el('article', `mcp-card${srv.enabled ? '' : ' is-disabled'}`);
    card.dataset.serverName = srv.name;

    // 1. Card Header
    const head = el('div', 'mcp-card-head');
    const left = el('div', 'mcp-card-id');
    const icWrap = el('span', 'mcp-card-ic');
    icWrap.append(icon(isHttp ? 'globe' : 'plug'));
    const nameWrap = el('div', 'mcp-card-names');
    const nameRow = el('div', 'mcp-card-namerow');
    nameRow.append(el('b', 'mcp-name', srv.name));
    if (srv.title && srv.title.toLowerCase() !== srv.name.toLowerCase()) {
      nameRow.append(el('span', 'mcp-card-subname', srv.title));
    }
    nameWrap.append(nameRow);
    if (srv.desc) {
      nameWrap.append(el('p', 'mcp-card-desc', srv.desc));
    }
    left.append(icWrap, nameWrap);

    const badges = el('div', 'mcp-card-badges');
    badges.append(
      el(
        'span',
        `mcp-badge ${isHttp ? 'mcp-badge--http' : 'mcp-badge--stdio'}`,
        isHttp ? tr('ui.mcp.badgeHttp') : tr('ui.mcp.badgeStdio'),
      ),
      el(
        'span',
        `mcp-badge ${srv.enabled ? 'mcp-badge--on' : 'mcp-badge--off'}`,
        srv.enabled ? tr('ui.mcp.statusEnabled') : tr('ui.mcp.statusDisabled'),
      ),
      el('span', 'mcp-badge mcp-badge--tools', tr('ui.mcp.toolsCount', { n: srv.toolsCount ?? tools.length })),
    );

    if (isTesting) {
      badges.append(el('span', 'mcp-badge mcp-badge--testing', tr('ui.mcp.pingTesting')));
    } else if (srv.testResult) {
      const ok = srv.testResult.ok || srv.testResult.status === 'ok';
      const pingBadge = el(
        'span',
        `mcp-badge ${ok ? 'mcp-badge--ping-ok' : 'mcp-badge--ping-err'}`,
        ok ? tr('ui.mcp.pingOk', { ms: srv.testResult.latencyMs || 1 }) : tr('ui.mcp.pingFail'),
      );
      if (srv.testResult.message) pingBadge.title = srv.testResult.message;
      badges.append(pingBadge);
    }

    if (manage) {
      const swWrap = el('label', 'mcp-switch');
      swWrap.title = tr('ui.mcp.switchTitle');
      const swIn = el('input');
      swIn.type = 'checkbox';
      swIn.checked = Boolean(srv.enabled);
      swIn.setAttribute('role', 'switch');
      swIn.setAttribute('aria-label', `${srv.name} toggle`);
      swIn.addEventListener('change', async () => {
        swIn.disabled = true;
        const want = swIn.checked;
        const res = await postMcp({ action: 'toggle', name: srv.name, enabled: want });
        swIn.disabled = false;
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr(want ? 'ui.mcp.toggledOnToast' : 'ui.mcp.toggledOffToast', { name: srv.name }));
          renderStatsPills();
          renderEditor();
          renderServerList();
        } else {
          swIn.checked = !want;
          toast(res?.message || tr('drawer.unreachable'));
        }
      });
      swWrap.append(swIn, el('i', 'mcp-switch-slider'));
      badges.append(swWrap);
    }

    head.append(left, badges);
    card.append(head);

    // 2. Config Details (Command / URL + Masked Env / Headers)
    const cfgBox = el('div', 'mcp-card-cfg');
    const cmdTarget = isHttp ? srv.serverUrl || srv.url || '' : [srv.command, ...(srv.args || [])].join(' ');
    if (cmdTarget) {
      const cmdRow = el('div', 'mcp-cfg-endpoint');
      cmdRow.append(el('code', 'mcp-cfg-code', cmdTarget));
      const cpBtn = el('button', 'mcp-mini-btn', '📋');
      cpBtn.type = 'button';
      cpBtn.title = tr('ui.mcp.copyVal');
      cpBtn.addEventListener('click', () => copyText(cmdTarget));
      cmdRow.append(cpBtn);
      cfgBox.append(cmdRow);
    }

    const maskedMap = isHttp ? srv.maskedHeaders || {} : srv.maskedEnv || {};
    const rawMap = isHttp ? srv.headers || {} : srv.env || {};
    const secretKeys = Object.keys(maskedMap);
    if (secretKeys.length > 0) {
      const secList = el('div', 'mcp-secrets-list');
      for (const k of secretKeys) {
        const sKey = `${srv.name}:${k}`;
        const isRevealed = revealedSecrets.has(sKey);
        const rawVal = rawMap[k];
        const displayVal = isRevealed && rawVal ? rawVal : maskedMap[k];

        const chip = el('div', 'mcp-secret-chip');
        chip.append(el('span', 'mcp-secret-k', `${k}:`), el('code', 'mcp-secret-v', displayVal));

        if (manage && rawVal) {
          const eyeBtn = el('button', 'mcp-mini-btn', isRevealed ? '🙈' : '👁️');
          eyeBtn.type = 'button';
          eyeBtn.title = tr('ui.mcp.revealSecret');
          eyeBtn.addEventListener('click', () => {
            if (revealedSecrets.has(sKey)) revealedSecrets.delete(sKey);
            else revealedSecrets.add(sKey);
            renderServerList();
          });
          const cpBtn = el('button', 'mcp-mini-btn', '📋');
          cpBtn.type = 'button';
          cpBtn.title = tr('ui.mcp.copyVal');
          cpBtn.addEventListener('click', () => copyText(rawVal));
          chip.append(eyeBtn, cpBtn);
        }
        secList.append(chip);
      }
      cfgBox.append(secList);
    }

    if (srv.testResult?.message) {
      const note = el(
        'p',
        `mcp-test-msg ${srv.testResult.ok || srv.testResult.status === 'ok' ? 'is-ok' : 'is-err'}`,
        srv.testResult.message,
      );
      cfgBox.append(note);
    }

    card.append(cfgBox);

    // 3. Action bar (.mcp-card-acts)
    const acts = el('div', 'mcp-card-acts');
    const nTools = srv.toolsCount ?? tools.length;
    const toolsBtn = el(
      'button',
      `btn btn--sm mcp-act-btn${isToolsOpen ? ' is-open' : ''}`,
      tr(isToolsOpen ? 'ui.mcp.hideTools' : 'ui.mcp.viewTools', { n: nTools }),
    );
    toolsBtn.type = 'button';
    toolsBtn.addEventListener('click', () => {
      if (expandedTools.has(srv.name)) expandedTools.delete(srv.name);
      else expandedTools.add(srv.name);
      renderServerList();
    });
    acts.append(toolsBtn);

    if (manage) {
      const testBtn = el(
        'button',
        'btn btn--sm mcp-act-btn',
        isTesting ? tr('ui.mcp.pingTesting') : tr('ui.mcp.testConn'),
      );
      testBtn.type = 'button';
      testBtn.disabled = isTesting;
      testBtn.addEventListener('click', async () => {
        testingNames.add(srv.name);
        renderServerList();
        const res = await postMcp({ action: 'test', name: srv.name });
        testingNames.delete(srv.name);
        if (res?.ok) {
          applyServerPayload(res);
          const trRes = res.testResult;
          if (trRes?.ok || trRes?.status === 'ok') {
            toast(tr('ui.mcp.testOkToast', { name: srv.name, ms: trRes.latencyMs || 1 }));
          } else {
            toast(tr('ui.mcp.testFailToast', { name: srv.name, err: trRes?.message || 'Error' }));
          }
        } else {
          toast(res?.message || tr('drawer.unreachable'));
        }
        renderStatsPills();
        renderServerList();
      });

      const editBtn = el('button', 'btn btn--sm mcp-act-btn', tr('ui.mcp.editBtn'));
      editBtn.type = 'button';
      editBtn.addEventListener('click', () => {
        editingServer = srv;
        editorTab = 'custom';
        editorOpen = true;
        renderEditor();
        $('mcp-body')?.scrollTo?.({ top: 0, behavior: 'smooth' });
      });

      const cloneBtn = el('button', 'btn btn--sm mcp-act-btn', tr('ui.mcp.cloneBtn'));
      cloneBtn.type = 'button';
      cloneBtn.addEventListener('click', async () => {
        cloneBtn.disabled = true;
        const res = await postMcp({ action: 'duplicate', name: srv.name });
        cloneBtn.disabled = false;
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr('ui.mcp.clonedToast', { name: res.name }));
          renderStatsPills();
          renderServerList();
        } else {
          toast(res?.message || tr('drawer.unreachable'));
        }
      });

      const copyJsonBtn = el('button', 'btn btn--sm mcp-act-btn', tr('ui.mcp.copyServerJsonBtn'));
      copyJsonBtn.type = 'button';
      copyJsonBtn.addEventListener('click', () => copyText(buildSingleServerJson(srv)));

      const delBtn = el('button', 'btn btn--sm mcp-act-btn mcp-btn-danger', tr('ui.mcp.deleteBtn'));
      delBtn.type = 'button';
      delBtn.addEventListener('click', async () => {
        if (delBtn.dataset.armed !== '1') {
          delBtn.dataset.armed = '1';
          delBtn.textContent = tr('ui.mcp.deleteConfirm');
          setTimeout(() => {
            if (delBtn.isConnected) {
              delBtn.dataset.armed = '';
              delBtn.textContent = tr('ui.mcp.deleteBtn');
            }
          }, 3500);
          return;
        }
        delBtn.disabled = true;
        const res = await postMcp({ action: 'delete', name: srv.name });
        if (res?.ok) {
          applyServerPayload(res);
          toast(tr('ui.mcp.deletedToast', { name: srv.name }));
          renderStatsPills();
          renderEditor();
          renderServerList();
        } else {
          delBtn.disabled = false;
          toast(res?.message || tr('drawer.unreachable'));
        }
      });

      acts.append(testBtn, editBtn, cloneBtn, copyJsonBtn, delBtn);
    }

    card.append(acts);

    // 4. Expandable Tools & Instructions Drawer (.mcp-tools-drawer)
    if (isToolsOpen) {
      const drawer = el('div', 'mcp-tools-drawer');

      if (srv.instructions) {
        const details = el('details', 'mcp-instructions-box');
        const summary = el('summary', 'mcp-instructions-sum', tr('ui.mcp.instructionsTitle'));
        const pre = el('pre', 'mcp-instructions-pre', srv.instructions);
        details.append(summary, pre);
        drawer.append(details);
      }

      const localToolQuery = (perServerToolFilter.get(srv.name) || '').trim().toLowerCase();
      if (tools.length > 6 && !autoExpandBySearch) {
        const tfIn = el('input', 'mcp-input mcp-input--sm');
        tfIn.type = 'search';
        tfIn.placeholder = tr('ui.mcp.toolFilterPlaceholder');
        tfIn.value = perServerToolFilter.get(srv.name) || '';
        tfIn.addEventListener('keydown', (e) => e.stopPropagation());
        tfIn.addEventListener('input', () => {
          perServerToolFilter.set(srv.name, tfIn.value);
          renderServerList();
        });
        drawer.append(tfIn);
      }

      const baseTools = autoExpandBySearch ? matchingTools : tools;
      const toolsToShow = localToolQuery
        ? baseTools.filter(
            (tl) =>
              tl.name?.toLowerCase().includes(localToolQuery) ||
              tl.description?.toLowerCase().includes(localToolQuery),
          )
        : baseTools;

      if (toolsToShow.length === 0) {
        drawer.append(el('p', 'mcp-tools-empty', tr('ui.mcp.noTools')));
      } else {
        const grid = el('div', 'mcp-tools-grid');
        for (const tl of toolsToShow) {
          const toolKey = `${srv.name}:${tl.name}`;
          const isToolExpanded = expandedToolItems.has(toolKey);
          const item = el('div', `mcp-tool-item${isToolExpanded ? ' is-expanded' : ''}`);
          const tHead = el('div', 'mcp-tool-head');
          tHead.append(el('code', 'mcp-tool-name', tl.name));
          const cpTlBtn = el('button', 'mcp-mini-btn', '📋');
          cpTlBtn.type = 'button';
          cpTlBtn.title = tr('ui.mcp.copyToolId');
          cpTlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyText(tl.name);
          });
          tHead.append(cpTlBtn);
          item.append(tHead);

          if (tl.description) {
            item.append(el('p', 'mcp-tool-desc', tl.description));
          }
          const reqParams = tl.requiredParams || [];
          const optParams = tl.optionalParams || [];
          if (reqParams.length > 0 || optParams.length > 0) {
            const paramsRow = el('div', 'mcp-tool-params');
            for (const rp of reqParams) {
              const chip = el('span', 'mcp-param mcp-param--req', `${rp}*`);
              chip.title = `${rp} (${tr('ui.mcp.requiredParam')})`;
              paramsRow.append(chip);
            }
            for (const op of optParams) {
              const chip = el('span', 'mcp-param mcp-param--opt', op);
              chip.title = `${op} (${tr('ui.mcp.optionalParam')})`;
              paramsRow.append(chip);
            }
            item.append(paramsRow);
          }

          if (isToolExpanded && Array.isArray(tl.params) && tl.params.length > 0) {
            const schemaBox = el('div', 'mcp-tool-schema');
            for (const pInfo of tl.params) {
              const sRow = el('div', 'mcp-schema-row');
              const sTop = el('div', 'mcp-schema-top');
              sTop.append(
                el('code', `mcp-param ${pInfo.required ? 'mcp-param--req' : 'mcp-param--opt'}`, pInfo.name),
                el('span', 'mcp-schema-type', pInfo.type || 'any'),
              );
              sRow.append(sTop);
              if (pInfo.description) {
                sRow.append(el('p', 'mcp-schema-desc', pInfo.description));
              }
              schemaBox.append(sRow);
            }
            item.append(schemaBox);
          }

          item.addEventListener('click', () => {
            if (expandedToolItems.has(toolKey)) expandedToolItems.delete(toolKey);
            else expandedToolItems.add(toolKey);
            renderServerList();
          });

          grid.append(item);
        }
        drawer.append(grid);
      }
      card.append(drawer);
    }

    listContainerEl.append(card);
  }
}

function renderMcpBody() {
  const body = $('mcp-body');
  if (!body) return;
  body.replaceChildren();

  const manage = canUserManage();
  const addBtn = $('mcp-btn-add');
  const testAllBtn = $('mcp-btn-test-all');
  if (addBtn) {
    addBtn.hidden = !manage;
    addBtn.textContent = editorOpen ? tr('ui.mcp.closeEditor') : tr('ui.mcp.addServer');
  }
  if (testAllBtn) {
    testAllBtn.hidden = !manage;
    testAllBtn.disabled = testingAll;
    testAllBtn.textContent = testingAll ? tr('ui.mcp.testingAll') : tr('ui.mcp.testAll');
  }

  // 1. Toolbar (.mcp-toolbar)
  const toolbar = el('div', 'mcp-toolbar');
  statPillsEl = el('div', 'mcp-stat-pills');
  pathBarEl = el('div', 'mcp-path-bar');
  renderStatsPills();

  const searchRow = el('div', 'mcp-search-row');
  const searchWrap = el('div', 'mcp-search-wrap');
  const searchIn = el('input', 'mcp-search');
  searchIn.type = 'search';
  searchIn.placeholder = tr('ui.mcp.searchPlaceholder');
  searchIn.value = searchQuery;
  searchIn.addEventListener('keydown', (e) => e.stopPropagation());
  searchIn.addEventListener('input', () => {
    searchQuery = searchIn.value;
    renderServerList();
  });
  searchWrap.append(searchIn);

  const filterBar = el('div', 'mcp-filter-pills');
  const filterDefs = [
    ['all', tr('ui.mcp.filterAll')],
    ['enabled', tr('ui.mcp.filterEnabled')],
    ['disabled', tr('ui.mcp.filterDisabled')],
  ];
  const filterBtns = [];
  for (const [fKey, fLabel] of filterDefs) {
    const fb = el('button', `mcp-filter-btn${statusFilter === fKey ? ' is-active' : ''}`, fLabel);
    fb.type = 'button';
    fb.addEventListener('click', () => {
      statusFilter = fKey;
      for (const b of filterBtns) b.classList.toggle('is-active', b.dataset.filter === statusFilter);
      renderServerList();
    });
    fb.dataset.filter = fKey;
    filterBtns.push(fb);
    filterBar.append(fb);
  }

  searchRow.append(searchWrap, filterBar);
  toolbar.append(statPillsEl, pathBarEl, searchRow);
  body.append(toolbar);

  if (!manage) {
    body.append(el('p', 'mcp-readonly-note', tr('ui.mcp.readOnlyNote')));
  }

  // 2. Editor section (.mcp-editor)
  editorContainerEl = el('div', 'mcp-editor-wrap');
  body.append(editorContainerEl);
  renderEditor();

  // 3. Server Cards List (.mcp-list)
  listContainerEl = el('div', 'mcp-list');
  body.append(listContainerEl);
  renderServerList();
}

export function setup() {
  const btnMcp = $('btn-mcp');
  const modal = $('mcp-modal');
  const btnAdd = $('mcp-btn-add');
  const btnTestAll = $('mcp-btn-test-all');

  btnMcp?.addEventListener('click', () => {
    if (modal && !modal.hidden) closeMcp();
    else openMcp();
  });

  btnAdd?.addEventListener('click', () => {
    editorOpen = !editorOpen;
    if (!editorOpen) editingServer = null;
    renderEditor();
  });

  btnTestAll?.addEventListener('click', async () => {
    if (testingAll) return;
    testingAll = true;
    btnTestAll.disabled = true;
    btnTestAll.textContent = tr('ui.mcp.testingAll');
    const res = await postMcp({ action: 'testAll' });
    testingAll = false;
    btnTestAll.disabled = false;
    btnTestAll.textContent = tr('ui.mcp.testAll');
    if (res?.ok) {
      applyServerPayload(res);
      const results = Object.values(res.results || {});
      const okCount = results.filter((r) => r?.ok || r?.status === 'ok').length;
      toast(tr('ui.mcp.testAllDoneToast', { ok: okCount, total: results.length }));
      renderStatsPills();
      renderServerList();
    } else {
      toast(res?.message || tr('drawer.unreachable'));
    }
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) {
      closeMcp();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) {
      closeMcp();
    }
  });

  if (state.mcpSummary) {
    syncMcpBadge(state.mcpSummary);
  }
}
