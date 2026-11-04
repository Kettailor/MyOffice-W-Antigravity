import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const MCP_PRESETS = [
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
    args: ['-y', '@modelcontextprotocol/server-filesystem', './'],
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

export function maskSecret(val) {
  const s = String(val ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return `${s.slice(0, 2)}••••••`;
  return `${s.slice(0, 4)}••••••${s.slice(-4)}`;
}

function maskObjectValues(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!k) continue;
    out[k] = maskSecret(v);
  }
  return out;
}

function normalizeStringMap(input, existingMap = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [rawKey, rawVal] of Object.entries(input)) {
    const k = String(rawKey || '').trim();
    if (!k) continue;
    const v = String(rawVal ?? '').trim();
    if (!v) continue;
    // Preserve original secret if the user submitted the masked placeholder unchanged
    if (v.includes('••••') && existingMap && typeof existingMap[k] === 'string' && existingMap[k]) {
      out[k] = existingMap[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeArgsList(args) {
  if (Array.isArray(args)) {
    return args.map((a) => String(a ?? '').trim()).filter(Boolean);
  }
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map((a) => String(a ?? '').trim()).filter(Boolean);
      } catch { /* fall through */ }
    }
    const tokens = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(trimmed)) !== null) {
      tokens.push(m[1] ?? m[2] ?? m[3]);
    }
    return tokens;
  }
  return [];
}

export function createMcpManager({ dataDir, geminiRootDir } = {}) {
  const home = os.homedir();
  const geminiRoot = geminiRootDir
    ? path.resolve(geminiRootDir)
    : process.env.GEMINI_ROOT_DIR
      ? path.resolve(process.env.GEMINI_ROOT_DIR)
      : path.join(home, '.gemini');

  const configPaths = [
    path.join(geminiRoot, 'antigravity', 'mcp_config.json'),
    path.join(geminiRoot, 'config', 'mcp_config.json'),
  ];

  const mcpToolsRoots = [
    path.join(geminiRoot, 'antigravity-cli', 'mcp'),
    path.join(geminiRoot, 'antigravity', 'mcp'),
  ];

  const stateFile = path.join(dataDir, 'mcp-state.json');
  const state = {
    disabledServers: {},
    testResults: {},
    customMeta: {},
    serverOrder: [],
  };

  function loadState() {
    try {
      if (!fs.existsSync(stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.disabledServers && typeof raw.disabledServers === 'object') {
          state.disabledServers = { ...raw.disabledServers };
        }
        if (raw.testResults && typeof raw.testResults === 'object') {
          state.testResults = { ...raw.testResults };
        }
        if (raw.customMeta && typeof raw.customMeta === 'object') {
          state.customMeta = { ...raw.customMeta };
        }
        if (Array.isArray(raw.serverOrder)) {
          state.serverOrder = raw.serverOrder.filter((x) => typeof x === 'string' && x.trim());
        }
      }
    } catch { /* ignore corrupt state */ }
  }

  function saveState() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  loadState();

  function getPrimaryConfigPath() {
    let bestPath = '';
    let bestMtime = -1;
    for (const p of configPaths) {
      try {
        if (fs.existsSync(p)) {
          const st = fs.statSync(p);
          if ((st.mtimeMs || 0) >= bestMtime) {
            bestMtime = st.mtimeMs || 0;
            bestPath = p;
          }
        }
      } catch { /* ignore */ }
    }
    return bestPath || configPaths[0];
  }

  function stripRuntimeFlags(cfg) {
    if (!cfg || typeof cfg !== 'object') return {};
    const copy = { ...cfg };
    delete copy.disabled;
    delete copy.enabled;
    return copy;
  }

  function readActiveServers() {
    const candidates = [];
    for (const p of configPaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const st = fs.statSync(p);
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object'
          ? parsed.mcpServers
          : {};
        candidates.push({ path: p, mtimeMs: st.mtimeMs || 0, servers });
      } catch { /* ignore invalid json */ }
    }
    if (candidates.length === 0) return {};
    // Prefer newest config file as authoritative source; only fall back to older file if newest is empty and no state exists
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const primary = candidates[0].servers || {};
    const merged = {};
    let stateChanged = false;

    for (const [k, v] of Object.entries(primary)) {
      if (!k || !v || typeof v !== 'object') continue;
      if (v.disabled === true || v.enabled === false) {
        if (!state.disabledServers[k]) {
          state.disabledServers[k] = stripRuntimeFlags(v);
          stateChanged = true;
        }
        continue;
      }
      if (state.disabledServers[k]) {
        // Respect disabled state in Work Office if config file still had the entry
        continue;
      }
      merged[k] = stripRuntimeFlags(v);
    }

    if (stateChanged) saveState();
    return merged;
  }

  function writeActiveServers(mcpServers) {
    const clean = {};
    for (const [k, v] of Object.entries(mcpServers || {})) {
      if (k && v && typeof v === 'object') clean[k] = stripRuntimeFlags(v);
    }
    const payload = JSON.stringify({ mcpServers: clean }, null, 2) + '\n';
    let wroteAny = false;
    for (const p of configPaths) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, payload, 'utf8');
        wroteAny = true;
      } catch { /* ignore individual path error */ }
    }
    return wroteAny;
  }

  function scanServerTools(serverName) {
    const rawName = String(serverName || '').trim();
    if (!rawName) return { tools: [], instructions: '' };

    const relCandidates = [
      rawName.split('/'),
      [rawName.replace(/^@/, '').replace(/\//g, '-')],
      [rawName.replace(/\//g, '__')],
      [path.basename(rawName)],
    ];

    let foundDir = '';
    for (const root of mcpToolsRoots) {
      for (const segs of relCandidates) {
        const cand = path.join(root, ...segs);
        try {
          if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
            foundDir = cand;
            break;
          }
        } catch { /* ignore */ }
      }
      if (foundDir) break;
    }

    if (!foundDir) return { tools: [], instructions: '' };

    const tools = [];
    let instructions = '';
    try {
      const entries = fs.readdirSync(foundDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (ent.name.toLowerCase() === 'instructions.md') {
          try {
            instructions = fs.readFileSync(path.join(foundDir, ent.name), 'utf8').trim().slice(0, 4000);
          } catch { /* ignore */ }
          continue;
        }
        if (!ent.name.toLowerCase().endsWith('.json')) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(foundDir, ent.name), 'utf8'));
          const toolName = String(raw?.name || path.basename(ent.name, '.json')).trim();
          const description = String(raw?.description || '').trim();
          const propsObj = raw?.parameters?.properties && typeof raw.parameters.properties === 'object'
            ? raw.parameters.properties
            : {};
          const allProps = Object.keys(propsObj);
          const reqSet = new Set(Array.isArray(raw?.parameters?.required) ? raw.parameters.required : []);
          const requiredParams = allProps.filter((p) => reqSet.has(p));
          for (const r of reqSet) {
            if (!requiredParams.includes(r)) requiredParams.push(r);
          }
          const optionalParams = allProps.filter((p) => !reqSet.has(p));
          const params = allProps.map((pName) => {
            const pDef = propsObj[pName] || {};
            const pType = Array.isArray(pDef.type) ? pDef.type.join('|') : String(pDef.type || 'any');
            return {
              name: pName,
              type: pType,
              required: reqSet.has(pName),
              description: String(pDef.description || '').trim().slice(0, 240),
            };
          });
          tools.push({
            name: toolName,
            description,
            requiredParams,
            optionalParams,
            params,
          });
        } catch { /* skip malformed tool schema */ }
      }
    } catch { /* ignore */ }

    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools, instructions };
  }

  function buildServerView(name, cfg, enabled, isFullDirector = false) {
    const preset = MCP_PRESETS.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const meta = state.customMeta?.[name] || {};
    const serverUrl = String(cfg?.serverUrl || cfg?.url || '').trim();
    const command = String(cfg?.command || '').trim();
    const transport = serverUrl && !command ? 'http' : 'stdio';
    const args = Array.isArray(cfg?.args) ? cfg.args.map((x) => String(x)) : [];
    const rawEnv = cfg?.env && typeof cfg.env === 'object' ? cfg.env : {};
    const rawHeaders = cfg?.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
    const maskedEnv = maskObjectValues(rawEnv);
    const maskedHeaders = maskObjectValues(rawHeaders);
    const { tools, instructions } = scanServerTools(name);
    const testResult = state.testResults[name] || null;

    let status = 'configured';
    if (!enabled) {
      status = 'disabled';
    } else if (testResult?.status === 'error') {
      status = 'error';
    } else if (testResult?.status === 'ok' || tools.length > 0) {
      status = 'ready';
    }

    return {
      name,
      title: meta.title || preset?.title || name,
      desc: meta.desc || preset?.desc || (transport === 'http' ? `Remote MCP (${serverUrl})` : `Local Stdio (${[command, ...args].join(' ')})`),
      enabled: Boolean(enabled),
      status,
      transport,
      command,
      args,
      serverUrl,
      url: serverUrl,
      maskedEnv,
      maskedHeaders,
      envKeys: Object.keys(rawEnv),
      headerKeys: Object.keys(rawHeaders),
      ...(isFullDirector ? { env: rawEnv, headers: rawHeaders } : {}),
      tools,
      toolsCount: tools.length,
      instructions,
      testResult,
    };
  }

  function getPublicSummary() {
    const active = readActiveServers();
    const activeNames = Object.keys(active);
    const disabledNames = Object.keys(state.disabledServers).filter((k) => !active[k]);
    let totalTools = 0;
    for (const name of activeNames) {
      totalTools += scanServerTools(name).tools.length;
    }
    return {
      total: activeNames.length + disabledNames.length,
      enabled: activeNames.length,
      disabled: disabledNames.length,
      totalTools,
      names: activeNames,
    };
  }

  function exportJson({ includeDisabled = false, isFullDirector = false } = {}) {
    const active = readActiveServers();
    const out = {};
    for (const [name, cfg] of Object.entries(active)) {
      const entry = { ...stripRuntimeFlags(cfg) };
      if (!isFullDirector) {
        if (entry.env) entry.env = maskObjectValues(entry.env);
        if (entry.headers) entry.headers = maskObjectValues(entry.headers);
      }
      out[name] = entry;
    }
    if (includeDisabled) {
      for (const [name, cfg] of Object.entries(state.disabledServers)) {
        if (out[name]) continue;
        const entry = { ...stripRuntimeFlags(cfg), disabled: true };
        if (!isFullDirector) {
          if (entry.env) entry.env = maskObjectValues(entry.env);
          if (entry.headers) entry.headers = maskObjectValues(entry.headers);
        }
        out[name] = entry;
      }
    }
    return JSON.stringify({ mcpServers: out }, null, 2);
  }

  function listServers({ isFullDirector = false } = {}) {
    const active = readActiveServers();
    const allNames = new Set([
      ...Object.keys(active),
      ...Object.keys(state.disabledServers),
    ]);
    const ordered = [];
    const seen = new Set();
    for (const name of state.serverOrder || []) {
      if (allNames.has(name) && !seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    for (const name of allNames) {
      if (!seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    if (
      !Array.isArray(state.serverOrder) ||
      state.serverOrder.length !== ordered.length ||
      state.serverOrder.some((n, i) => n !== ordered[i])
    ) {
      state.serverOrder = ordered;
      saveState();
    }

    const servers = [];
    for (const name of ordered) {
      const isEnabled = Boolean(active[name]);
      const cfg = active[name] || state.disabledServers[name];
      if (!cfg) continue;
      servers.push(buildServerView(name, cfg, isEnabled, isFullDirector));
    }
    return {
      ok: true,
      canManage: Boolean(isFullDirector),
      servers,
      summary: getPublicSummary(),
      presets: MCP_PRESETS,
      configPath: getPrimaryConfigPath(),
      rawConfigJson: exportJson({ includeDisabled: false, isFullDirector }),
    };
  }

  function normalizeServerEntry(input, existingCfg = null) {
    const transport = String(input?.transport || '').toLowerCase();
    const rawUrl = String(input?.serverUrl || input?.url || '').trim();
    const rawCmd = String(input?.command || '').trim();
    const isHttp = transport === 'http' || (Boolean(rawUrl) && !rawCmd);

    if (isHttp) {
      if (!rawUrl || !/^https?:\/\/\S+/i.test(rawUrl)) {
        return { ok: false, message: 'URL của Remote MCP Server phải bắt đầu bằng http:// hoặc https://.' };
      }
      const headers = normalizeStringMap(input?.headers, existingCfg?.headers);
      const cfg = { serverUrl: rawUrl };
      if (Object.keys(headers).length > 0) cfg.headers = headers;
      return { ok: true, cfg };
    }

    if (!rawCmd) {
      return { ok: false, message: 'Vui lòng nhập lệnh thực thi (Command) cho Local Stdio MCP (ví dụ: npx, node, uvx).' };
    }
    const args = normalizeArgsList(input?.args);
    const env = normalizeStringMap(input?.env, existingCfg?.env);
    const cfg = { command: rawCmd, args };
    if (Object.keys(env).length > 0) cfg.env = env;
    return { ok: true, cfg };
  }

  function upsertServer(payload = {}) {
    const cleanName = String(payload?.name || '').trim();
    const prevName = String(payload?.prevName || '').trim();
    if (!cleanName || cleanName.length > 80 || /[\r\n\0]/.test(cleanName)) {
      return { ok: false, message: 'Tên MCP Server không hợp lệ.' };
    }

    const active = readActiveServers();
    const existingCfg = active[cleanName]
      || state.disabledServers[cleanName]
      || (prevName ? (active[prevName] || state.disabledServers[prevName]) : null)
      || null;

    const norm = normalizeServerEntry(payload, existingCfg);
    if (!norm.ok) return norm;

    const enabled = payload.enabled !== false;
    if (prevName && prevName !== cleanName) {
      delete active[prevName];
      delete state.disabledServers[prevName];
      delete state.testResults[prevName];
      if (state.customMeta?.[prevName]) {
        state.customMeta[cleanName] = state.customMeta[prevName];
        delete state.customMeta[prevName];
      }
    }

    const customTitle = String(payload?.title || '').trim();
    const customDesc = String(payload?.desc || '').trim();
    if (customTitle || customDesc) {
      state.customMeta[cleanName] = {
        ...(state.customMeta[cleanName] || {}),
        ...(customTitle ? { title: customTitle.slice(0, 120) } : {}),
        ...(customDesc ? { desc: customDesc.slice(0, 300) } : {}),
      };
    }

    if (enabled) {
      active[cleanName] = norm.cfg;
      delete state.disabledServers[cleanName];
    } else {
      delete active[cleanName];
      state.disabledServers[cleanName] = norm.cfg;
    }

    writeActiveServers(active);
    saveState();
    return { ok: true, name: cleanName, enabled };
  }

  function toggleServer(name, enabled) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, message: 'Thiếu tên MCP Server.' };
    const active = readActiveServers();
    const wantEnabled = Boolean(enabled);

    if (wantEnabled) {
      if (active[cleanName]) return { ok: true, name: cleanName, enabled: true };
      const saved = state.disabledServers[cleanName];
      if (!saved) return { ok: false, message: `Không tìm thấy cấu hình của "${cleanName}".` };
      active[cleanName] = saved;
      delete state.disabledServers[cleanName];
      writeActiveServers(active);
      saveState();
      return { ok: true, name: cleanName, enabled: true };
    } else {
      if (state.disabledServers[cleanName] && !active[cleanName]) {
        return { ok: true, name: cleanName, enabled: false };
      }
      const current = active[cleanName];
      if (!current) return { ok: false, message: `Không tìm thấy MCP Server "${cleanName}".` };
      state.disabledServers[cleanName] = current;
      delete active[cleanName];
      writeActiveServers(active);
      saveState();
      return { ok: true, name: cleanName, enabled: false };
    }
  }

  function toggleAllServers(enabled) {
    const wantEnabled = Boolean(enabled);
    const active = readActiveServers();
    if (wantEnabled) {
      for (const [name, cfg] of Object.entries(state.disabledServers)) {
        if (name && cfg && typeof cfg === 'object') {
          active[name] = stripRuntimeFlags(cfg);
        }
      }
      state.disabledServers = {};
    } else {
      for (const [name, cfg] of Object.entries(active)) {
        if (name && cfg && typeof cfg === 'object') {
          state.disabledServers[name] = stripRuntimeFlags(cfg);
        }
      }
      for (const k of Object.keys(active)) delete active[k];
    }
    writeActiveServers(active);
    saveState();
    return { ok: true, enabled: wantEnabled };
  }

  function duplicateServer(name, newName) {
    const srcName = String(name || '').trim();
    if (!srcName) return { ok: false, message: 'Thiếu tên MCP Server gốc.' };
    const active = readActiveServers();
    const srcCfg = active[srcName] || state.disabledServers[srcName];
    if (!srcCfg) return { ok: false, message: `Không tìm thấy MCP Server "${srcName}".` };

    let targetName = String(newName || '').trim();
    if (!targetName) {
      let idx = 2;
      targetName = `${srcName}-copy`;
      while (active[targetName] || state.disabledServers[targetName]) {
        targetName = `${srcName}-copy-${idx++}`;
      }
    }
    if (active[targetName] || state.disabledServers[targetName]) {
      return { ok: false, message: `Tên MCP Server "${targetName}" đã tồn tại.` };
    }

    const isEnabled = Boolean(active[srcName]);
    const clonedCfg = JSON.parse(JSON.stringify(stripRuntimeFlags(srcCfg)));
    if (isEnabled) {
      active[targetName] = clonedCfg;
    } else {
      state.disabledServers[targetName] = clonedCfg;
    }
    if (state.customMeta?.[srcName]) {
      state.customMeta[targetName] = { ...state.customMeta[srcName] };
    }
    writeActiveServers(active);
    saveState();
    return { ok: true, name: targetName, enabled: isEnabled };
  }

  function deleteServer(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, message: 'Thiếu tên MCP Server.' };
    const active = readActiveServers();
    const existed = Boolean(active[cleanName] || state.disabledServers[cleanName]);
    if (!existed) return { ok: false, message: `Không tìm thấy MCP Server "${cleanName}".` };
    delete active[cleanName];
    delete state.disabledServers[cleanName];
    delete state.testResults[cleanName];
    if (state.customMeta) delete state.customMeta[cleanName];
    writeActiveServers(active);
    saveState();
    return { ok: true, name: cleanName };
  }

  function importJson(rawJson, { enabled = true } = {}) {
    let parsed = rawJson;
    if (typeof rawJson === 'string') {
      const trimmed = rawJson.trim();
      if (!trimmed) return { ok: false, message: 'Nội dung JSON trống.' };
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        return { ok: false, message: `JSON không hợp lệ: ${err?.message || err}` };
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Cấu trúc JSON phải là một Object.' };
    }

    let entriesMap = null;
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
      entriesMap = parsed.mcpServers;
    } else if (typeof parsed.name === 'string' && (parsed.command || parsed.serverUrl || parsed.url)) {
      const { name, ...rest } = parsed;
      entriesMap = { [name]: rest };
    } else {
      entriesMap = parsed;
    }

    const imported = [];
    for (const [rawName, cfg] of Object.entries(entriesMap)) {
      const name = String(rawName || '').trim();
      if (!name || !cfg || typeof cfg !== 'object') continue;
      const r = upsertServer({
        name,
        command: cfg.command,
        args: cfg.args,
        env: cfg.env,
        serverUrl: cfg.serverUrl || cfg.url,
        headers: cfg.headers,
        enabled: cfg.disabled === true ? false : enabled,
      });
      if (!r.ok) return r;
      imported.push(name);
    }

    if (imported.length === 0) {
      return { ok: false, message: 'Không tìm thấy MCP Server hợp lệ nào trong JSON.' };
    }
    return { ok: true, imported, count: imported.length };
  }

  async function testHttpServer(name, cfg, cachedToolsCount) {
    const url = String(cfg.serverUrl || cfg.url || '').trim();
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {}),
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'work-office', version: '1.4.0' },
      },
    });
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(7000),
      });
      const latencyMs = Math.max(1, Date.now() - t0);
      const statusHttp = res.status;
      const text = await res.text().catch(() => '');

      if (statusHttp === 401 || statusHttp === 403) {
        return {
          ok: false,
          status: 'error',
          latencyMs,
          message: `HTTP ${statusHttp}: Từ chối truy cập — Kiểm tra lại API Key / Headers`,
          checkedAt: Date.now(),
          liveToolsCount: cachedToolsCount,
        };
      }

      if (statusHttp >= 200 && statusHttp < 300) {
        let serverTitle = '';
        try {
          const jsonMatch = text.includes('data:')
            ? text.split(/\r?\n/).find((l) => l.startsWith('data:'))?.slice(5).trim()
            : text;
          const j = JSON.parse(jsonMatch || text);
          serverTitle = j?.result?.serverInfo?.name || '';
        } catch { /* SSE or non-JSON body */ }
        return {
          ok: true,
          status: 'ok',
          latencyMs,
          message: `Kết nối HTTP ${statusHttp} OK (${latencyMs}ms)${serverTitle ? ` · ${serverTitle}` : ''}`,
          checkedAt: Date.now(),
          liveToolsCount: cachedToolsCount,
        };
      }

      if ([400, 405, 406].includes(statusHttp) && (text.includes('jsonrpc') || text.includes('mcp') || res.headers.get('content-type')?.includes('json'))) {
        return {
          ok: true,
          status: 'ok',
          latencyMs,
          message: `Endpoint trực tuyến (HTTP ${statusHttp} · ${latencyMs}ms)`,
          checkedAt: Date.now(),
          liveToolsCount: cachedToolsCount,
        };
      }

      return {
        ok: false,
        status: 'error',
        latencyMs,
        message: `HTTP ${statusHttp}: ${text.slice(0, 100) || res.statusText || 'Lỗi kết nối'}`,
        checkedAt: Date.now(),
        liveToolsCount: cachedToolsCount,
      };
    } catch (err) {
      const latencyMs = Math.max(1, Date.now() - t0);
      return {
        ok: false,
        status: 'error',
        latencyMs,
        message: `Không thể kết nối tới ${url}: ${err?.message || err}`,
        checkedAt: Date.now(),
        liveToolsCount: cachedToolsCount,
      };
    }
  }

  function testStdioServer(name, cfg, cachedToolsCount) {
    return new Promise((resolve) => {
      const rawCmd = String(cfg.command || '').trim();
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      const env = { ...process.env, ...(cfg.env && typeof cfg.env === 'object' ? cfg.env : {}) };
      const t0 = Date.now();
      const isWin = process.platform === 'win32';
      const cmd = isWin && /^(npx|npm|pnpm|yarn|uvx)$/i.test(rawCmd) ? `${rawCmd}.cmd` : rawCmd;

      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let child = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        try {
          if (child && !child.killed) child.kill();
        } catch { /* ignore */ }
        resolve(result);
      };

      const timer = setTimeout(() => {
        const latencyMs = Math.max(1, Date.now() - t0);
        if (child && child.exitCode === null) {
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Tiến trình ${rawCmd} khởi chạy tốt (${latencyMs}ms)${cachedToolsCount ? ` · ${cachedToolsCount} tools` : ''}`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        } else {
          finish({
            ok: cachedToolsCount > 0,
            status: cachedToolsCount > 0 ? 'ok' : 'error',
            latencyMs,
            message: cachedToolsCount > 0
              ? `Đã đồng bộ ${cachedToolsCount} tools từ Antigravity`
              : `Hết thời gian chờ phản hồi từ ${rawCmd}`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        }
      }, 6500);

      try {
        child = spawn(cmd, args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: isWin && /\.cmd$/i.test(cmd),
        });
      } catch (err) {
        clearTimeout(timer);
        const latencyMs = Math.max(1, Date.now() - t0);
        if (cachedToolsCount > 0) {
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Đã đồng bộ ${cachedToolsCount} tools từ Antigravity`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        } else {
          finish({
            ok: false,
            status: 'error',
            latencyMs,
            message: `Không thể khởi chạy "${rawCmd}": ${err?.message || err}`,
            checkedAt: Date.now(),
            liveToolsCount: 0,
          });
        }
        return;
      }

      child.on('error', (err) => {
        clearTimeout(timer);
        const latencyMs = Math.max(1, Date.now() - t0);
        if (cachedToolsCount > 0) {
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Đã đồng bộ ${cachedToolsCount} tools từ Antigravity`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        } else {
          finish({
            ok: false,
            status: 'error',
            latencyMs,
            message: `Lỗi khởi chạy "${rawCmd}": ${err?.message || err}`,
            checkedAt: Date.now(),
            liveToolsCount: 0,
          });
        }
      });

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf8');
        if (stdoutBuf.includes('"jsonrpc"') || stdoutBuf.includes('"result"') || stdoutBuf.includes('"serverInfo"')) {
          clearTimeout(timer);
          const latencyMs = Math.max(1, Date.now() - t0);
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Phản hồi JSON-RPC thành công (${latencyMs}ms)${cachedToolsCount ? ` · ${cachedToolsCount} tools` : ''}`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-600);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Math.max(1, Date.now() - t0);
        if (code === 0) {
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Tiến trình ${rawCmd} hoàn tất (${latencyMs}ms)`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        } else if (cachedToolsCount > 0 && process.env.OFFICE_DOCKER === '1') {
          finish({
            ok: true,
            status: 'ok',
            latencyMs,
            message: `Đã đồng bộ ${cachedToolsCount} tools từ Antigravity Host`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        } else {
          const cleanErr = stderrBuf.replace(/\s+/g, ' ').trim().slice(0, 120);
          finish({
            ok: false,
            status: 'error',
            latencyMs,
            message: `Tiến trình thoát (mã ${code})${cleanErr ? `: ${cleanErr}` : ''}`,
            checkedAt: Date.now(),
            liveToolsCount: cachedToolsCount,
          });
        }
      });

      try {
        const initMsg = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'work-office', version: '1.4.0' },
          },
        }) + '\n';
        child.stdin?.write(initMsg);
      } catch { /* ignore stdin write error */ }
    });
  }

  async function testServer(name) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { ok: false, message: 'Thiếu tên MCP Server.' };
    const active = readActiveServers();
    const cfg = active[cleanName] || state.disabledServers[cleanName];
    if (!cfg) return { ok: false, message: `Không tìm thấy MCP Server "${cleanName}".` };

    const { tools } = scanServerTools(cleanName);
    const serverUrl = String(cfg.serverUrl || cfg.url || '').trim();
    const isHttp = Boolean(serverUrl && !cfg.command);

    const result = isHttp
      ? await testHttpServer(cleanName, cfg, tools.length)
      : await testStdioServer(cleanName, cfg, tools.length);

    state.testResults[cleanName] = result;
    saveState();
    return { ok: true, name: cleanName, testResult: result };
  }

  async function testAllServers() {
    const active = readActiveServers();
    const names = Object.keys(active);
    const results = {};
    await Promise.all(
      names.map(async (name) => {
        const r = await testServer(name);
        results[name] = r.testResult || null;
      }),
    );
    return { ok: true, results };
  }

  return {
    getPublicSummary,
    listServers,
    upsertServer,
    toggleServer,
    toggleAllServers,
    duplicateServer,
    deleteServer,
    importJson,
    exportJson,
    testServer,
    testAllServers,
    scanServerTools,
  };
}
