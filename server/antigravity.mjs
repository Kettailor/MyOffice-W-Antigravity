// Antigravity Brain Watcher, SQLite Summary Reader & Real-Time Quota Engine.
// Automatically discovers and tails live Antigravity conversations in ~/.gemini/antigravity/brain/<conversation-id>,
// cross-references ~/.gemini/antigravity/conversation_summaries.db for authoritative workspaces & subagent links,
// parses transcript.jsonl, task.md checklists, implementation_plan.md titles, per-step token usage, and normalizes
// Antigravity tool calls and hook payloads into Work Office events.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './redact.mjs';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const subRoleByConvId = new Map(); // convId -> { role, typeName }

const DATA_DIR = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.join(process.cwd(), 'data');
const SUMMARY_CACHE_FILE = path.join(DATA_DIR, 'agy-summaries-cache.json');
const DELETED_SESSIONS_FILE = path.join(DATA_DIR, 'deleted-sessions.json');
const persistentMetaMap = new Map();
const deletedConvIds = new Map(); // convId -> deletedAtMs
let saveCacheTimer = null;

try {
  const saved = JSON.parse(fs.readFileSync(SUMMARY_CACHE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) {
      if (v && typeof v === 'object') persistentMetaMap.set(k, v);
    }
  }
} catch { /* first run or missing cache */ }

try {
  const delSaved = JSON.parse(fs.readFileSync(DELETED_SESSIONS_FILE, 'utf8'));
  if (delSaved && typeof delSaved === 'object') {
    for (const [k, v] of Object.entries(delSaved)) {
      if (k) deletedConvIds.set(k, Number(v) || Date.now());
    }
  }
} catch { /* first run or missing file */ }

function scheduleSaveSummaryCache() {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj = Object.fromEntries(persistentMetaMap);
      fsp.writeFile(SUMMARY_CACHE_FILE, JSON.stringify(obj)).catch(() => {});
    } catch { /* ignore */ }
  }, 2500);
  saveCacheTimer.unref?.();
}

function saveDeletedSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(deletedConvIds);
    fsp.writeFile(DELETED_SESSIONS_FILE, JSON.stringify(obj)).catch(() => {});
  } catch { /* ignore */ }
}

function formatSubagentRole(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/world-3d|3d\s*world|chibi\s*engineer|scene|webgl/i.test(s)) return '3D World / Chibi';
  if (/ui-chat|group\s*chat|front-?end|ui\b|i18n|css|giao\s*diện/i.test(s)) return 'UI / Front-end';
  if (/backend-agy|back-?end|watcher|server|network|api|database|sqlite/i.test(s)) return 'Back-end';
  if (/qa-test|qa\b|test|verifier|build|lint|kiểm\s*thử/i.test(s)) return 'QA / Test';
  if (/research|codebase\s*researcher|ba\b|analyst|khảo\s*sát/i.test(s)) return 'BA / Research';
  return s;
}

export function agyBrainDirs() {
  if (process.env.OFFICE_AGY_BRAIN_DIR) return [path.resolve(process.env.OFFICE_AGY_BRAIN_DIR)];
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity-cli', 'brain'),
    path.join(home, '.gemini', 'antigravity', 'brain'),
  ];
}

export function agyBrainDir() {
  if (process.env.OFFICE_AGY_BRAIN_DIR) return path.resolve(process.env.OFFICE_AGY_BRAIN_DIR);
  const dirs = agyBrainDirs();
  for (const d of dirs) {
    if (fs.existsSync(d)) return d;
  }
  return dirs[dirs.length - 1];
}

const baseNameOf = (p = '') => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const normProjKey = (p = '') => String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();

// Decodes a file:// URI from conversation_summaries.db (e.g. "file:///e%3A/WorkOffice") into a clean OS path.
export function decodeWorkspaceUri(uri = '') {
  if (!uri || typeof uri !== 'string') return '';
  let raw = uri.trim();
  if (raw.startsWith('file://')) {
    raw = raw.replace(/^file:\/\/\/?/, '');
    try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
    if (process.platform === 'win32' || /^\/?[A-Za-z]:[\\/]/.test(raw)) {
      raw = raw.replace(/^\/+([A-Za-z]:)/, '$1').replace(/\//g, '\\');
      if (/^[A-Za-z]:\\/.test(raw)) raw = raw[0].toLowerCase() + raw.slice(1);
    } else if (!raw.startsWith('/')) {
      raw = '/' + raw;
    }
  }
  return raw.replace(/[\\/]+$/, '');
}

// Normalizes any path inside a workspace to its canonical workspace root (case-insensitive on Windows or Windows paths inside Docker).
export function normalizeWorkspacePath(dir = '', knownRoots = []) {
  if (!dir || typeof dir !== 'string') return '';
  let clean = dir.trim().replace(/[\\/]+$/, '');
  const isWin = process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(clean);
  if (isWin) {
    clean = clean.replace(/\//g, '\\');
    if (/^[A-Za-z]:\\/.test(clean)) clean = clean[0].toLowerCase() + clean.slice(1);
  }
  const lower = isWin ? clean.toLowerCase() : clean;
  const sep = isWin ? '\\' : path.sep;
  for (const root of knownRoots) {
    if (!root) continue;
    const rClean = isWin ? root.replace(/\//g, '\\').replace(/[\\/]+$/, '') : root.replace(/\/+$/, '');
    const rLower = isWin ? rClean.toLowerCase() : rClean;
    if (lower === rLower || lower.startsWith(rLower + sep)) {
      return rClean;
    }
  }
  return clean;
}

// Reads ~/.gemini/config/projects/*.json to map project_id -> workspace root path (used by Antigravity CLI `agy`).
function readConfigProjectWorkspaces() {
  const out = new Map();
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const projDir = path.join(home, '.gemini', 'config', 'projects');
    if (!fs.existsSync(projDir)) return out;
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(projDir, f), 'utf8'));
        const pid = String(j?.id || '').trim();
        const resList = Array.isArray(j?.projectResources?.resources) ? j.projectResources.resources : [];
        for (const r of resList) {
          const uri = r?.folderUri || r?.gitFolder?.folderUri || '';
          const dec = decodeWorkspaceUri(uri);
          if (pid && dec) {
            out.set(pid, dec);
            break;
          }
        }
      } catch { /* ignore malformed project file */ }
    }
  } catch { /* ignore */ }
  return out;
}

function querySummaryRowsFromDb(db) {
  try {
    return db.prepare(`
      SELECT conversation_id, title, workspace_uris, project_id, status, not_fully_idle,
             parent_conversation_id, agent_name, step_count, last_modified_time, nesting_depth
      FROM conversation_summaries
    `).all();
  } catch {
    return db.prepare(`
      SELECT conversation_id, title, workspace_uris, project_id, status, not_fully_idle,
             parent_conversation_id, agent_name, step_count, last_modified_time
      FROM conversation_summaries
    `).all();
  }
}

function readSummaryRowsSafe(dbPath) {
  let db = null;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true, timeout: 2000 });
    return querySummaryRowsFromDb(db);
  } catch {
    try { db?.close(); } catch { /* ignore */ }
    db = null;
    // Fallback when Antigravity Desktop closed with uncheckpointed WAL (.db-wal exists without .db-shm):
    // copy .db (+ .db-wal) to os.tmpdir() and open writable so SQLite replays WAL cleanly.
    const tmpBase = path.join(os.tmpdir(), `wo-agy-sum-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
    try {
      fs.copyFileSync(dbPath, tmpBase);
      if (fs.existsSync(`${dbPath}-wal`)) {
        fs.copyFileSync(`${dbPath}-wal`, `${tmpBase}-wal`);
      }
      db = new DatabaseSync(tmpBase, { open: true, timeout: 2000 });
      return querySummaryRowsFromDb(db);
    } catch {
      return [];
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      db = null;
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.rmSync(`${tmpBase}${ext}`, { force: true }); } catch { /* ignore */ }
      }
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// Cached reader for ~/.gemini/antigravity/conversation_summaries.db and ~/.gemini/antigravity-cli/conversation_summaries.db
let summariesCache = { at: 0, sig: '', map: new Map(), roots: [] };
export function readAgySummariesDb(brainDir = agyBrainDir()) {
  const now = Date.now();
  if (now - summariesCache.at < 2500 && summariesCache.map.size > 0) return summariesCache;
  const customEnv = Boolean(process.env.OFFICE_AGY_BRAIN_DIR);
  const brainDirs = customEnv ? [path.resolve(brainDir)] : agyBrainDirs();
  const dbPaths = [...new Set(brainDirs.map((b) => path.join(path.dirname(b), 'conversation_summaries.db')))];
  const sigParts = [];
  const validDbs = [];
  for (const dbPath of dbPaths) {
    try {
      const dbStat = fs.statSync(dbPath);
      let walStat = null;
      try { walStat = fs.statSync(`${dbPath}-wal`); } catch { /* optional wal */ }
      sigParts.push(`${dbPath}:${dbStat.mtimeMs}:${dbStat.size}:${walStat ? `${walStat.mtimeMs}:${walStat.size}` : '0'}`);
      validDbs.push(dbPath);
    } catch { /* missing db */ }
  }
  const projectWsMap = readConfigProjectWorkspaces();
  const map = new Map();
  const rootSet = new Set(projectWsMap.values());
  if (!customEnv) {
    for (const [cid, cached] of persistentMetaMap) {
      map.set(cid, { ...cached, status: '', notFullyIdle: false });
      if (Array.isArray(cached.workspaces)) {
        for (const w of cached.workspaces) if (w) rootSet.add(w);
      } else if (cached.workspace) {
        rootSet.add(cached.workspace);
      }
    }
  }
  if (!validDbs.length) {
    if (!customEnv && map.size > 0) {
      summariesCache = {
        at: now,
        sig: 'cached',
        map,
        roots: [...rootSet].sort((a, b) => a.length - b.length),
      };
    }
    return summariesCache;
  }
  const sig = sigParts.join('|');
  if (sig === summariesCache.sig && summariesCache.map.size > 0) {
    summariesCache.at = now;
    return summariesCache;
  }
  let cacheUpdated = false;
  for (const dbPath of validDbs) {
    const rows = readSummaryRowsSafe(dbPath);
    for (const r of rows) {
      if (!r?.conversation_id) continue;
      let uris = [];
      try { uris = JSON.parse(r.workspace_uris || '[]'); } catch { uris = []; }
      let workspaces = uris.map(decodeWorkspaceUri).filter(Boolean);
      const pid = String(r.project_id || '').trim();
      if (!workspaces.length && pid && projectWsMap.has(pid)) {
        workspaces = [projectWsMap.get(pid)];
      }
      for (const w of workspaces) rootSet.add(w);
      const entry = {
        id: r.conversation_id,
        title: String(r.title || '').trim(),
        workspace: workspaces[0] || '',
        workspaces,
        projectId: pid,
        status: String(r.status || ''),
        notFullyIdle: Boolean(r.not_fully_idle),
        parentId: String(r.parent_conversation_id || '').trim(),
        agentName: String(r.agent_name || '').trim(),
        nestingDepth: Number(r.nesting_depth) || 0,
        stepCount: Number(r.step_count) || 0,
        lastModified: r.last_modified_time ? Date.parse(r.last_modified_time) || 0 : 0,
      };
      const prev = map.get(r.conversation_id);
      let merged = entry;
      if (prev) {
        const newer = entry.lastModified >= (prev.lastModified || 0) ? entry : prev;
        const older = newer === entry ? prev : entry;
        merged = {
          ...newer,
          title: newer.title || older.title,
          workspace: newer.workspace || older.workspace,
          workspaces: newer.workspaces?.length ? newer.workspaces : (older.workspaces || []),
          projectId: newer.projectId || older.projectId,
          parentId: newer.parentId || older.parentId,
          agentName: newer.agentName || older.agentName,
          nestingDepth: Math.max(newer.nestingDepth || 0, older.nestingDepth || 0),
          stepCount: Math.max(newer.stepCount || 0, older.stepCount || 0),
        };
      }
      map.set(r.conversation_id, merged);
      if (!customEnv && (merged.workspace || merged.parentId || merged.title || merged.agentName || merged.nestingDepth > 0)) {
        persistentMetaMap.set(r.conversation_id, {
          id: merged.id,
          title: merged.title,
          workspace: merged.workspace,
          workspaces: merged.workspaces,
          projectId: merged.projectId,
          parentId: merged.parentId,
          agentName: merged.agentName,
          nestingDepth: merged.nestingDepth,
          stepCount: merged.stepCount,
          lastModified: merged.lastModified,
        });
        cacheUpdated = true;
      }
    }
  }
  if (cacheUpdated) scheduleSaveSummaryCache();
  summariesCache = {
    at: now,
    sig,
    map,
    roots: [...rootSet].sort((a, b) => a.length - b.length),
  };
  return summariesCache;
}

// Antigravity serializes tool call argument values in transcript.jsonl with extra quotes (e.g. "\"e:\\\\WorkOffice\"").
export function cleanVal(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try { return JSON.parse(s); } catch { return s.replace(/^"|"$/g, ''); }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return v;
}

export function cleanArgs(args) {
  let obj = args;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = cleanVal(v);
  return out;
}

// Maps Antigravity's native tool names & arguments into the canonical { tool_name, tool_input } format.
export function normalizeAgyTool(rawName = '', rawArgs = {}) {
  if (rawName && typeof rawName === 'object') {
    rawArgs = rawName.args || rawName.arguments || rawArgs || {};
    rawName = rawName.name || rawName.tool_name || '';
  }
  const name = String(rawName || '').replace(/^default_api:/, '');
  const a = cleanArgs(rawArgs);
  switch (name) {
    case 'read_file':
    case 'view_file':
    case 'view_file_outline':
    case 'view_code_item':
    case 'read_resource':
    case 'list_resources':
      return { tool_name: 'Read', name: 'Read', tool_input: { file_path: String(a.Path || a.AbsolutePath || a.File || a.Uri || a.ServerName || 'file') } };
    case 'write_file':
    case 'write_to_file': {
      const filePath = String(a.Path || a.TargetFile || '');
      const meta = a.ArtifactMetadata && typeof a.ArtifactMetadata === 'object' ? a.ArtifactMetadata : null;
      const isPlanFile = /(?:^|[\\/])implementation_plan\.md$/i.test(filePath);
      const requestFeedback = Boolean(meta && meta.RequestFeedback === true) || isPlanFile;
      return {
        tool_name: 'Write',
        name: 'Write',
        tool_input: { file_path: filePath || 'file' },
        requestFeedback,
        isPlanFile,
        artifactSummary: String(meta?.Summary || ''),
      };
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const filePath = String(a.Path || a.TargetFile || '');
      const meta = a.ArtifactMetadata && typeof a.ArtifactMetadata === 'object' ? a.ArtifactMetadata : null;
      const isPlanFile = /(?:^|[\\/])implementation_plan\.md$/i.test(filePath);
      const requestFeedback = Boolean(meta && meta.RequestFeedback === true) || isPlanFile;
      return {
        tool_name: 'Edit',
        name: 'Edit',
        tool_input: { file_path: filePath || 'file' },
        requestFeedback,
        isPlanFile,
        artifactSummary: String(meta?.Summary || ''),
      };
    }
    case 'run_command':
    case 'send_command_input':
      return {
        tool_name: 'Bash',
        name: 'Bash',
        tool_input: {
          command: String(a.CommandLine || a.Input || ''),
          description: String(a.toolSummary || ''),
        },
      };
    case 'manage_task':
      return {
        tool_name: 'Bash',
        name: 'Bash',
        tool_input: {
          command: `task ${a.Action || 'status'} ${a.TaskId || ''}`.trim(),
          description: a.Action ? `Task ${a.Action}` : 'Manage background task',
        },
      };
    case 'grep_search':
      return { tool_name: 'Grep', name: 'Grep', tool_input: { pattern: String(a.Query || a.Pattern || a.SearchPath || 'grep') } };
    case 'find_by_name':
    case 'list_dir':
      return { tool_name: 'Glob', name: 'Glob', tool_input: { pattern: String(a.Pattern || a.SearchDirectory || a.DirectoryPath || '*') } };
    case 'search_web':
      return { tool_name: 'WebSearch', name: 'WebSearch', tool_input: { query: String(a.query || a.Query || '') } };
    case 'search_marketplace': {
      const qs = Array.isArray(a.queries) ? a.queries.join(', ') : String(a.queries || '');
      return { tool_name: 'WebSearch', name: 'WebSearch', tool_input: { query: qs || 'marketplace' } };
    }
    case 'read_url_content':
      return { tool_name: 'WebFetch', name: 'WebFetch', tool_input: { url: String(a.Url || a.url || 'https://web') } };
    case 'invoke_subagent':
    case 'define_subagent':
    case 'send_message':
    case 'manage_subagents': {
      const recId = a.Recipient ? String(a.Recipient).trim() : '';
      const mapped = recId ? subRoleByConvId.get(recId) : null;
      const mappedRole = mapped?.role || mapped?.typeName || (typeof mapped === 'string' ? mapped : '');
      const rawType = String(a.Role || a.TypeName || a.Name || mappedRole || recId || 'subagent').trim();
      return {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: rawType,
          description: String(a.Prompt || a.Description || a.Message || a.Action || ''),
        },
      };
    }
    case 'ask_question': {
      const qs = Array.isArray(a.questions) ? a.questions : [];
      const normQuestions = qs.map((q) => ({
        question: String(q?.question || ''),
        header: String(q?.header || ''),
        multi: Boolean(q?.is_multi_select ?? q?.multiSelect ?? q?.multi),
        multiSelect: Boolean(q?.is_multi_select ?? q?.multiSelect ?? q?.multi),
        options: (Array.isArray(q?.options) ? q.options : []).map((o) => (
          typeof o === 'string'
            ? { label: o, description: '' }
            : { label: String(o?.label || ''), description: String(o?.description || '') }
        )),
      }));
      return {
        tool_name: 'AskUserQuestion',
        name: 'AskUserQuestion',
        tool_input: { questions: normQuestions },
        requestFeedback: true,
      };
    }
    case 'call_mcp_tool':
      return {
        tool_name: `mcp__${a.ServerName || 'mcp'}__${a.ToolName || 'tool'}`,
        name: `mcp__${a.ServerName || 'mcp'}__${a.ToolName || 'tool'}`,
        tool_input: typeof a.Arguments === 'object' && a.Arguments ? a.Arguments : {},
      };
    case 'schedule':
      return { tool_name: 'TodoWrite', name: 'TodoWrite', tool_input: { description: String(a.Prompt || 'Schedule') } };
    case 'list_plugin_accounts':
      return { tool_name: 'ToolSearch', name: 'ToolSearch', tool_input: { name: 'plugins' } };
    default:
      if (name.startsWith('mcp_')) {
        const rest = name.slice(4);
        const idx = rest.indexOf('_');
        const srv = idx > 0 ? rest.slice(0, idx) : 'mcp';
        const fn = idx > 0 ? rest.slice(idx + 1) : rest;
        return { tool_name: `mcp__${srv}__${fn}`, name: `mcp__${srv}__${fn}`, tool_input: a };
      }
      return { tool_name: name, name, tool_input: a };
  }
}

// Normalizes an incoming Antigravity hook payload (camelCase) into the server's internal hook event shape.
export function normalizeAgyHookPayload(p, defaultEvent = '') {
  if (!p || typeof p !== 'object') return p;
  if (p.session_id && p.hook_event_name) return p;
  if (!p.conversationId && !p.toolCall && !p.workspacePaths && !p.artifactDirectoryPath) return p;
  const sid = p.conversationId || p.session_id || '';
  const cwd = (Array.isArray(p.workspacePaths) && p.workspacePaths[0]) || p.cwd || '';
  const tc = p.toolCall || {};
  const tcArgs = tc.args || tc.arguments || {};
  const norm = tc.name ? normalizeAgyTool(tc.name, tcArgs) : { tool_name: p.tool_name || '', tool_input: p.tool_input || {} };
  let ev = p.hook_event_name || p.event || defaultEvent;
  if (!ev) {
    if (tc.name && p.toolResult !== undefined) ev = 'PostToolUse';
    else if (tc.name) ev = 'PreToolUse';
    else if (p.lastUserInput && p.terminationReason === undefined && p.fullyIdle === undefined) ev = 'UserPromptSubmit';
    else if (p.fullyIdle !== undefined || p.terminationReason !== undefined) ev = p.error ? 'StopFailure' : 'Stop';
    else ev = 'SessionStart';
  }
  if (ev === 'PreInvocation') ev = 'UserPromptSubmit';
  if (ev === 'PostInvocation') ev = 'Stop';
  return {
    ...p,
    isAgy: true,
    hook_event_name: ev,
    session_id: sid,
    cwd,
    transcript_path: p.transcriptPath || p.transcript_path || '',
    prompt: p.lastUserInput || p.prompt || '',
    tool_name: norm.tool_name,
    tool_input: norm.tool_input,
    raw_tool_name: tc.name || p.tool_name || '',
    model: p.modelName || p.model || '',
  };
}

// Extracts user prompt text from Antigravity's <USER_REQUEST>...</USER_REQUEST> block.
export function extractUserRequest(content = '') {
  if (!content || typeof content !== 'string') return '';
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(content);
  const raw = m ? m[1] : content.replace(/<[a-zA-Z_][\w-]*>[\s\S]*?<\/[a-zA-Z_][\w-]*>/g, '');
  return raw.trim();
}

// Extracts workspace directory from <user_information> block.
function extractWorkspaceFromInfo(content = '') {
  if (!content || typeof content !== 'string') return '';
  const infoBlock = /<user_information>([\s\S]*?)<\/user_information>/i.exec(content)?.[1];
  if (!infoBlock) return '';
  const isPath = (p) => /^([A-Za-z]:[\\/]|\/|~[\\/])[^*?"<>|\r\n]+$/.test(p);
  const m1 = /Command Working Directory:\s*([^\r\n<]+)/i.exec(infoBlock);
  if (m1 && isPath(m1[1].trim())) return m1[1].trim();
  const m2 = /Active Workspaces:\s*\r?\n\s*-\s*([^\r\n<]+)/i.exec(infoBlock);
  if (m2 && isPath(m2[1].trim())) return m2[1].trim();
  const m3 = /The user's current workspace is\s+([^\r\n<]+)/i.exec(infoBlock);
  if (m3 && isPath(m3[1].trim())) return m3[1].trim();
  return '';
}

// Extracts model name strictly from <USER_SETTINGS_CHANGE> block so code snippets cannot pollute it.
function extractModelFromInfo(content = '') {
  if (!content || typeof content !== 'string') return '';
  const block = /<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/i.exec(content)?.[1];
  if (!block) return '';
  const m = /(?:Selected model|setting `Model Selection`) changed from [^\r\n]+? to ([A-Za-z0-9 ()._-]{3,50}?)(?:\.|\r|\n|<|$)/i.exec(block);
  return m ? m[1].trim() : '';
}

// Reads checklist items from <convDir>/task.md for the 3D Whiteboard & Session Drawer.
export async function readAgyTodos(convDir) {
  const file = path.join(convDir, 'task.md');
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([ xX/])\]\s+(.+)$/.exec(line);
    if (!m) continue;
    const mark = m[1].toLowerCase();
    const status = mark === 'x' ? 'done' : mark === '/' ? 'doing' : 'todo';
    const clean = m[2]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*`~]/g, '')
      .replace(/<!--.*?-->/g, '')
      .trim();
    if (clean) out.push({ text: clip(redact(oneLine(clean)), 80), status });
    if (out.length >= 20) break;
  }
  return out;
}

// Reads a friendly title from task.md or implementation_plan.md in <convDir>.
async function readArtifactTitle(convDir) {
  for (const name of ['task.md', 'implementation_plan.md', 'walkthrough.md']) {
    try {
      const text = await fsp.readFile(path.join(convDir, name), 'utf8');
      const m = /^#\s+(.+)$/m.exec(text);
      if (m) {
        const t = m[1]
          .replace(/^(Task|Kế hoạch|Implementation Plan|Walkthrough)\s*[:—-]\s*/i, '')
          .replace(/[*`~]/g, '')
          .trim();
        if (t) return clip(redact(oneLine(t)), 75);
      }
    } catch { /* next */ }
  }
  return '';
}

// Reads active background tasks in <convDir>/.system_generated/tasks/
async function readAgyBgTasks(convDir) {
  const dir = path.join(convDir, '.system_generated', 'tasks');
  const map = new Map();
  try {
    const names = await fsp.readdir(dir);
    const now = Date.now();
    for (const n of names) {
      if (!n.endsWith('.log')) continue;
      const full = path.join(dir, n);
      const st = await fsp.stat(full).catch(() => null);
      if (!st || now - st.mtimeMs > 120_000) continue;
      const fh = await fsp.open(full, 'r');
      try {
        const len = Math.min(st.size, 4096), buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        const head = buf.toString('utf8');
        if (/Command exited with code/i.test(head)) continue;
        const cmdMatch = /CommandLine:\s*(.+)/i.exec(head);
        const id = n.replace(/\.log$/, '');
        map.set(id, { id, desc: clip(redact(oneLine(cmdMatch ? cmdMatch[1] : id)), 70), at: st.birthtimeMs || st.mtimeMs });
      } finally { await fh.close(); }
    }
  } catch { /* no tasks dir */ }
  return map;
}

async function readSingleAgyTranscript(transcriptFile, classify, viCache = {}) {
  let fh;
  try { fh = await fsp.open(transcriptFile, 'r'); } catch { return []; }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 4_000_000);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (size > len) lines.shift();
    const items = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const ts = j.created_at ? Date.parse(j.created_at) : 0;
      if (j.type === 'USER_INPUT') {
        const req = extractUserRequest(j.content || '');
        const imgs = Array.isArray(j.media) ? j.media.length : 0;
        if (!req && !imgs) continue;
        items.push({ role: 'user', text: clip(redact(req), 8000), imgs, ts });
      } else if (j.type === 'PLANNER_RESPONSE') {
        if (typeof j.content === 'string' && j.content.trim()) {
          items.push({ role: 'claude', text: clip(redact(j.content.trim()), 12000), ts });
        }
        if (Array.isArray(j.tool_calls)) {
          for (const tc of j.tool_calls) {
            if (!tc?.name) continue;
            const norm = normalizeAgyTool(tc.name, tc.args);
            const k = classify(norm.tool_name, norm.tool_input);
            items.push({
              role: 'tool',
              type: k.type,
              label: (k.tr && viCache[k.label]) || k.label,
              desc: k.desc ? viCache[k.desc] || k.desc : '',
              ts,
            });
          }
        }
      }
    }
    return items;
  } finally { await fh.close(); }
}

// Formats conversation items from Antigravity's transcript.jsonl for GET /api/log (the Session Drawer's Chat tab).
// Seamlessly merges Desktop brain and CLI brain transcripts when a conversation was resumed via `agy` CLI.
export async function readAgyLog(transcriptFile, classify, viCache = {}, n = 120) {
  if (!transcriptFile) return [];
  const files = [transcriptFile];
  if (!process.env.OFFICE_AGY_BRAIN_DIR && /[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/i.test(transcriptFile)) {
    const convId = path.basename(path.dirname(path.dirname(path.dirname(transcriptFile))));
    if (convId) {
      const seen = new Set([path.resolve(transcriptFile).toLowerCase()]);
      for (const bDir of agyBrainDirs()) {
        const alt = path.join(bDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        const altKey = path.resolve(alt).toLowerCase();
        if (!seen.has(altKey) && fs.existsSync(alt)) {
          seen.add(altKey);
          files.push(alt);
        }
      }
    }
  }
  if (files.length === 1) {
    const items = await readSingleAgyTranscript(transcriptFile, classify, viCache);
    return items.slice(-n);
  }
  const allItems = [];
  for (const f of files) {
    const part = await readSingleAgyTranscript(f, classify, viCache);
    allItems.push(...part);
  }
  allItems.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const deduped = [];
  const seenKeys = new Set();
  for (const it of allItems) {
    const sig = `${it.role}|${it.ts || 0}|${String(it.text || it.label || '').slice(0, 80)}`;
    if (seenKeys.has(sig)) continue;
    seenKeys.add(sig);
    deduped.push(it);
  }
  return deduped.slice(-n);
}

// Quota weight of a single prompt or planner response step in the 5-hour rolling window.
// Calibrated against real Antigravity IDE (Gemini Models) usage (~26 tasks & ~1113 steps => 20% 5h used / 80% left, 12% weekly used / 88% left):
// - Assigning a new task (USER_INPUT) increments quota (+0.035% 5h window)
// - Every agent step (PLANNER_RESPONSE) increments quota based on step count + fresh/cached tokens
function stepQuotaUnits5h(step) {
  if (!step) return 0;
  if (step.kind === 'prompt') return 0.035;
  const base = 0.013;
  const freshWeight = ((Number(step.inp) || 0) + (Number(step.out) || 0)) / 50_000 * 0.02;
  const cacheWeight = (Number(step.cr) || 0) / 2_500_000 * 0.01;
  return base + freshWeight + cacheWeight;
}

// Computes real-time Antigravity 5-hour quota, 7-day weekly quota, and Per-Project quota breakdown!
export function computeAgyQuota(sessions, allowedFilter = null, accountSlug = null) {
  const now = Date.now();
  const fiveHoursMs = 5 * 3600_000;
  const sevenDaysMs = 7 * 86400_000;
  const cutoff5h = now - fiveHoursMs;
  const cutoff7d = now - sevenDaysMs;

  let units5h = 0;
  let units7d = 0;
  let prompts5h = 0;
  let steps5h = 0;
  let tokens5h = 0;
  let prompts7d = 0;
  let steps7d = 0;
  let tokens7d = 0;
  let cost7d = 0;
  let oldest5h = 0;
  let oldest7d = 0;

  const byProject = new Map(); // dir -> project stats

  for (const s of sessions.values()) {
    if (!s.isAgy) continue;
    const dir = s.cwd || path.join(process.cwd(), 'antigravity');
    if (allowedFilter && !allowedFilter(dir)) continue;
    const projKey = normProjKey(dir);
    let proj = byProject.get(projKey);
    if (!proj) {
      proj = {
        dir,
        name: baseNameOf(dir) || dir,
        units5h: 0,
        units7d: 0,
        prompts5h: 0,
        steps5h: 0,
        tokens5h: 0,
        promptsTotal: 0,
        stepsTotal: 0,
        tokensTotal: 0,
        ctx: 0,
        cost: 0,
        busy: false,
        sessions: 0,
        lastTask: '',
        updatedAt: 0,
      };
      byProject.set(projKey, proj);
    }

    proj.sessions++;
    if (s.busy || s.status === 'work') proj.busy = true;
    if ((s.lastEventAt || 0) >= proj.updatedAt) {
      proj.updatedAt = s.lastEventAt || 0;
      proj.lastTask = s.lastPrompt || s.title || proj.lastTask;
    }

    const u = s.usage || {};
    proj.promptsTotal += Number(u.prompts) || 0;
    proj.stepsTotal += Number(u.steps) || 0;
    proj.tokensTotal += (Number(u.in) || 0) + (Number(u.out) || 0);
    if ((Number(u.ctx) || 0) > proj.ctx) proj.ctx = Number(u.ctx) || 0;
    proj.cost += Number(u.cost) || 0;

    const stepList = Array.isArray(s.agySteps) ? s.agySteps : [];
    let sessUnits5h = 0;
    let sessPrompts5h = 0;
    let sessSteps5h = 0;

    for (const st of stepList) {
      if (!st || !st.ts || st.ts < cutoff7d) continue;
      if (accountSlug !== null) {
        const stAcct = st.acct ?? s.agyAccount ?? '';
        if (stAcct !== accountSlug) continue;
      }
      const w = stepQuotaUnits5h(st);
      const tok = (Number(st.inp) || 0) + (Number(st.cr) || 0) + (Number(st.out) || 0);
      units7d += w;
      proj.units7d += w;
      if (!oldest7d || st.ts < oldest7d) oldest7d = st.ts;
      if (st.kind === 'prompt') prompts7d++;
      else {
        steps7d++;
        tokens7d += tok;
        cost7d += Number(st.cost) || 0;
      }

      if (st.ts >= cutoff5h) {
        units5h += w;
        proj.units5h += w;
        sessUnits5h += w;
        if (!oldest5h || st.ts < oldest5h) oldest5h = st.ts;
        if (st.kind === 'prompt') {
          prompts5h++;
          proj.prompts5h++;
          sessPrompts5h++;
        } else {
          steps5h++;
          proj.steps5h++;
          sessSteps5h++;
          tokens5h += tok;
          proj.tokens5h += tok;
        }
      }
    }

    if (s.usage && accountSlug === null) {
      s.usage.quota5hPct = Math.min(100, Math.round(sessUnits5h * 10) / 10);
      s.usage.prompts5h = sessPrompts5h;
      s.usage.steps5h = sessSteps5h;
    }
  }

  const pct = Math.min(100, units5h > 0 ? Math.max(1, Math.round(units5h)) : 0);
  // Weekly budget calibrated to Antigravity Gemini Models weekly limit (~1.7x the 5-hour unit scale)
  const weekPct = Math.min(100, Math.max(pct > 0 ? 1 : 0, Math.round(units7d / 1.7)));
  const left5hPct = Math.max(0, 100 - pct);
  const leftWeekPct = Math.max(0, 100 - weekPct);
  const resetsAt = new Date((oldest5h || now) + fiveHoursMs).toISOString();
  const weekResetsAt = new Date((oldest7d || now) + sevenDaysMs).toISOString();

  const projects = [...byProject.values()]
    .map((p) => {
      const pPct = Math.min(100, p.units5h > 0 ? Math.max(0.1, Math.round(p.units5h * 10) / 10) : 0);
      const pWeekPct = Math.min(100, Math.round((p.units7d / 1.7) * 10) / 10);
      const sharePct = units5h > 0
        ? Math.round((p.units5h / units5h) * 100)
        : units7d > 0
          ? Math.round((p.units7d / units7d) * 100)
          : 0;
      return {
        dir: p.dir,
        name: p.name,
        pct: pPct,
        weekPct: pWeekPct,
        sharePct,
        prompts5h: p.prompts5h,
        steps5h: p.steps5h,
        tokens5h: p.tokens5h,
        promptsTotal: p.promptsTotal,
        stepsTotal: p.stepsTotal,
        tokensTotal: p.tokensTotal,
        ctx: p.ctx,
        cost: Math.round(p.cost * 100) / 100,
        busy: p.busy,
        sessions: p.sessions,
        lastTask: p.lastTask,
        updatedAt: p.updatedAt,
      };
    })
    .sort((a, b) => (b.busy - a.busy) || (b.pct - a.pct) || (b.updatedAt - a.updatedAt));

  // Attach projectQuotaPct back onto each session's usage for desk/drawer inspection
  if (accountSlug === null) {
    const projPctByDir = new Map(projects.map((p) => [normProjKey(p.dir), p.pct]));
    for (const s of sessions.values()) {
      if (!s.isAgy || !s.usage || !s.cwd) continue;
      const k = normProjKey(s.cwd);
      s.usage.projectQuotaPct = projPctByDir.get(k) ?? s.usage.quota5hPct ?? 0;
    }
  }

  return {
    source: 'agy',
    email: process.env.USER || process.env.USERNAME || 'Antigravity Local',
    planName: 'Antigravity (Gemini Models)',
    billingCycle: `5g: còn ${Math.max(0, 100 - pct)}% · Tuần: còn ${Math.max(0, 100 - weekPct)}%`,
    pct,
    left5hPct,
    resetsAt,
    weekPct,
    leftWeekPct,
    weekResetsAt,
    prompts5h,
    steps5h,
    tokens5h,
    prompts7d,
    steps7d,
    tokens7d,
    cost7d: Math.round(cost7d * 100) / 100,
    extraEnabled: false,
    extraPct: null,
    extraUsed: null,
    extraLimit: null,
    projects,
  };
}

// Creates the stateful Antigravity Brain Watcher that integrates with server/index.mjs.
export function createAntigravityWatcher({
  sessions,
  sidToKey,
  newSession,
  dropSession,
  pub,
  broadcast,
  noteDir,
  classifyVi,
  count,
  testRunner,
  imageId,
  pushFeed,
  chat,
  trophies,
  rollDay,
  getStats,
  nextSeq,
  onUsageChange,
  onGitCmd,
  getActiveAccount,
  maxDesks = 44,
}) {
  const states = new Map(); // convId -> { offset, mtimeMs, model, firstPrompt, lastStepType, lastStepHasTools, lastFeedbackAt, steps }
  const subStates = new Map(); // subConvId -> { offset, mtimeMs, steps, parentId }

  function parseStepLine(line, s, st, liveEvents, knownRoots, fallbackTs = Date.now()) {
    if (!line.trim()) return false;
    let j;
    try { j = JSON.parse(line); } catch { return false; }
    const ts = j.created_at ? Date.parse(j.created_at) : (fallbackTs || Date.now());
    if (ts > (s.lastEventAt || 0)) s.lastEventAt = ts;
    const day = new Date(ts).toLocaleDateString('sv');
    if (!s.dayFirst || s.dayFirst.day !== day) s.dayFirst = { day, at: ts };

    if (typeof j.content === 'string') {
      const ws = extractWorkspaceFromInfo(j.content);
      if (ws && !s.cwdFromDb) {
        const normWs = normalizeWorkspacePath(ws, knownRoots);
        s.cwd = normWs;
        noteDir(normWs);
      }
      const m = extractModelFromInfo(j.content);
      if (m) st.model = m;
    }

    let usageChanged = false;
    const cutoff8d = Date.now() - 8 * 86400_000;
    const activeAcct = liveEvents && typeof getActiveAccount === 'function' ? (getActiveAccount() || '') : (s.agyAccount || '');

    if (j.type !== 'PLANNER_RESPONSE' && typeof j.content === 'string' && !extractUserRequest(j.content)) {
      const msgMatches = j.content.match(/\[Message\]\s+timestamp=[^\r\n]*?\bsender=/gi);
      if (msgMatches && msgMatches.length > 0) {
        st.pendingSubCalls = Math.max(0, (st.pendingSubCalls || 0) - msgMatches.length);
      } else if (/<SYSTEM_MESSAGE>[\s\S]*?\[Message\][\s\S]*?sender=/i.test(j.content)) {
        st.pendingSubCalls = Math.max(0, (st.pendingSubCalls || 0) - 1);
      }
    }

    if (j.type === 'USER_INPUT') {
      st.lastFeedbackAt = 0;
      st.waitInfo = null;
      if (s) s.waitCard = null;
      const req = extractUserRequest(j.content || '');
      if (req) {
        const promptText = clip(redact(oneLine(req)), 90);
        if (!st.firstPrompt) st.firstPrompt = promptText;
        s.lastPrompt = promptText;
        s.taskStart = ts;
        if (liveEvents && typeof getActiveAccount === 'function') {
          s.agyAccount = getActiveAccount() || '';
        }
        st.lastStepType = 'USER_INPUT';
        st.lastStepHasTools = false;
        st.lastFeedbackAt = 0;
        st.waitInfo = null;
        st.pendingSubCalls = 0;
        st.deferredStopLabel = null;
        st.deferredStopAt = 0;
        st.lastSubStopAt = 0;
        s.usage ||= { cost: 0, in: 0, cr: 0, out: 0, ctx: 0, steps: 0, prompts: 0, model: st.model || 'Gemini 3.1 Pro' };
        s.usage.prompts = (s.usage.prompts || 0) + 1;
        if (ts >= cutoff8d) {
          st.steps.push({ ts, kind: 'prompt', inp: 0, cr: 0, out: 0, cost: 0, acct: s.agyAccount || activeAcct });
        }
        usageChanged = true;
        if (liveEvents) liveEvents.push({ kind: 'prompt', ts, label: clip(promptText, 64) });
      }
    } else if (j.type === 'PLANNER_RESPONSE') {
      const inp = Number(j.input_tokens) || 0;
      const cr = Number(j.cache_read_tokens) || 0;
      const out = Number(j.output_tokens) || 0;
      s.usage ||= { cost: 0, in: 0, cr: 0, out: 0, ctx: 0, steps: 0, prompts: 0, model: st.model || 'Gemini 3.1 Pro' };
      s.usage.steps = (s.usage.steps || 0) + 1;
      if (inp || cr || out) {
        const stepCost = (inp * 1.25 + cr * 0.3 + out * 10) / 1e6;
        s.usage.in += inp + cr;
        s.usage.cr = (s.usage.cr || 0) + cr;
        s.usage.out += out;
        s.usage.ctx = inp + cr + out;
        s.usage.model = st.model || s.usage.model || 'Gemini 3.1 Pro';
        s.usage.cost += stepCost;
        if (ts >= cutoff8d) {
          st.steps.push({ ts, kind: 'step', inp, cr, out, cost: stepCost, acct: s.agyAccount || activeAcct });
        }
        usageChanged = true;
      } else if (ts >= cutoff8d) {
        st.steps.push({ ts, kind: 'step', inp: 0, cr: 0, out: 0, cost: 0, acct: s.agyAccount || activeAcct });
        usageChanged = true;
      }
      const tools = Array.isArray(j.tool_calls) ? j.tool_calls.filter((t) => t?.name) : [];
      st.lastStepType = 'PLANNER_RESPONSE';
      st.lastStepHasTools = tools.length > 0;

      if (tools.length > 0) {
        let stepHasWait = false;
        for (const tc of tools) {
          const rawName = String(tc.name || '');
          const norm = normalizeAgyTool(rawName, tc.args);
          if (!s.cwd && norm.tool_input?.file_path && path.isAbsolute(norm.tool_input.file_path)) {
            const fp = norm.tool_input.file_path;
            if (!fp.includes('.gemini')) {
              const inferred = normalizeWorkspacePath(path.dirname(fp), knownRoots);
              s.cwd = inferred;
              noteDir(s.cwd);
            }
          }
          if (norm.name === 'AskUserQuestion' || norm.tool_name === 'AskUserQuestion') {
            stepHasWait = true;
            st.lastFeedbackAt = ts;
            st.waitInfo = {
              kind: 'ask',
              ts,
              questions: norm.tool_input?.questions || [],
              detail: norm.tool_input?.questions?.[0]?.question || '',
            };
            if (liveEvents) {
              liveEvents.push({
                kind: 'wait',
                ts,
                label: (st.waitInfo.detail || 'AskUserQuestion').slice(0, 60),
              });
            }
          } else if (norm.requestFeedback || norm.isPlanFile) {
            stepHasWait = true;
            st.lastFeedbackAt = ts;
            st.waitInfo = {
              kind: 'plan',
              ts,
              filePath: norm.tool_input?.file_path || '',
              summary: norm.artifactSummary || '',
            };
            if (liveEvents) {
              liveEvents.push({
                kind: 'wait',
                ts,
                label: path.basename(norm.tool_input?.file_path || 'implementation_plan.md') || 'implementation_plan.md',
              });
            }
          }
          if (rawName.endsWith('invoke_subagent') || rawName.endsWith('send_message')) {
            const a = cleanArgs(tc.args);
            const recId = a.Recipient ? String(a.Recipient).trim() : '';
            const mapped = recId ? subRoleByConvId.get(recId) : null;
            const mappedRole = mapped?.role || mapped?.typeName || (typeof mapped === 'string' ? mapped : '');
            const rawRole = String(a.Role || a.Name || a.TypeName || a.SubagentType || mappedRole || recId || 'Subagent').trim();
            const subAgent = formatSubagentRole(rawRole) || rawRole || 'Subagent';
            if (recId && (a.Role || a.Name || a.TypeName || a.SubagentType)) {
              subRoleByConvId.set(recId, { role: subAgent, typeName: String(a.TypeName || a.SubagentType || subAgent) });
            }
            const subLabel = clip(subAgent || 'Subagent', 28);
            const subDesc = clip(redact(oneLine(a.Prompt || a.Message || a.Description || '')), 70);
            st.pendingSubCalls = (st.pendingSubCalls || 0) + 1;
            st.lastSubInvokeAt = ts || Date.now();
            if (Date.now() - ts < 60_000) {
              s.subs ||= {};
              const provKey = recId || `prov-${subAgent.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
              if (!s.subs[provKey]) {
                s.subs[provKey] = {
                  id: provKey,
                  type: clip(subAgent, 24),
                  desc: subDesc,
                  last: { type: 'agent', label: subDesc || subLabel },
                  startedAt: ts,
                  seenAt: ts,
                  steps: 1,
                  provisional: true,
                };
              } else if (subAgent && s.subs[provKey].type !== clip(subAgent, 24) && !/^[0-9a-f-]{8,}$/i.test(subAgent)) {
                s.subs[provKey].type = clip(subAgent, 24);
              }
            }
            if (liveEvents) {
              liveEvents.push({
                kind: 'substart',
                ts,
                agent: subAgent,
                label: subLabel,
                desc: subDesc,
              });
            }
          }
          if (liveEvents) {
            liveEvents.push({
              kind: 'tool',
              ts,
              tool_name: norm.tool_name,
              tool_input: norm.tool_input,
              raw_name: tc.name,
              requestFeedback: norm.requestFeedback,
            });
          }
        }
        if (!stepHasWait && st.lastFeedbackAt > 0 && ts > st.lastFeedbackAt) {
          st.lastFeedbackAt = 0;
          st.waitInfo = null;
          if (s) s.waitCard = null;
        }
      } else if (typeof j.content === 'string' && j.content.trim()) {
        s.lastReply = clip(redact(oneLine(j.content.trim())), 240);
        usageChanged = true;
        const hasActiveSubs = (st.pendingSubCalls || 0) > 0 || Object.keys(s.subs || {}).length > 0 || (s.bg && s.bg.size > 0);
        if (hasActiveSubs) {
          s.status = 'work';
          s.busy = true;
          st.deferredStopLabel = clip(s.lastReply, 90);
          st.deferredStopAt = ts;
        } else {
          s.doneAt = ts;
          st.deferredStopLabel = null;
          st.deferredStopAt = 0;
          if (liveEvents) liveEvents.push({ kind: 'stop', ts, label: clip(s.lastReply, 90) });
        }
      }
    } else if (j.type === 'GENERIC') {
      st.lastStepType = 'GENERIC';
    }
    return usageChanged;
  }

  // Parses subagent transcripts and attaches their steps + active status onto their parent session.
  async function syncSubagent(subCand, meta, parentSession) {
    let subSt = subStates.get(subCand.convId);
    if (!subSt) {
      subSt = { offset: 0, mtimeMs: 0, transcriptFile: subCand.transcriptFile, steps: [], parentId: meta.parentId, lastLabel: '', lastTool: null, lastClassified: null, promptDesc: '' };
      subStates.set(subCand.convId, subSt);
    } else if ((subSt.transcriptFile && subSt.transcriptFile !== subCand.transcriptFile) || subCand.st.size < subSt.offset) {
      subSt.offset = 0;
      subSt.mtimeMs = 0;
      subSt.transcriptFile = subCand.transcriptFile;
    } else {
      subSt.transcriptFile = subCand.transcriptFile;
    }
    let changed = false;
    let newTool = null;
    let newToolTs = Date.now();
    if (subCand.st.size > subSt.offset) {
      const fh = await fsp.open(subCand.transcriptFile, 'r');
      try {
        const readLen = subCand.st.size - subSt.offset;
        const buf = Buffer.alloc(readLen);
        await fh.read(buf, 0, readLen, subSt.offset);
        const end = buf.lastIndexOf(0x0a);
        if (end >= 0) {
          subSt.offset += end + 1;
          const cutoff8d = Date.now() - 8 * 86400_000;
          const subAcct = parentSession?.agyAccount || (typeof getActiveAccount === 'function' ? (getActiveAccount() || '') : '');
          for (const line of buf.subarray(0, end).toString('utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            const ts = j.created_at ? Date.parse(j.created_at) : (subCand.st.mtimeMs || Date.now());
            if (j.type === 'USER_INPUT' && !subSt.promptDesc && typeof j.content === 'string') {
              const req = extractUserRequest(j.content) || (/content=([^\r\n<]+)/.exec(j.content)?.[1] ?? '');
              if (req) subSt.promptDesc = clip(redact(oneLine(req)), 70);
            } else if (j.type === 'PLANNER_RESPONSE') {
              const inp = Number(j.input_tokens) || 0;
              const cr = Number(j.cache_read_tokens) || 0;
              const out = Number(j.output_tokens) || 0;
              const stepCost = (inp * 1.25 + cr * 0.3 + out * 10) / 1e6;
              if (ts >= cutoff8d) {
                const entry = { ts, kind: 'step', inp, cr, out, cost: stepCost, subId: subCand.convId, acct: subAcct };
                subSt.steps.push(entry);
                if (parentSession) {
                  parentSession.agySteps ||= [];
                  parentSession.agySteps.push(entry);
                  parentSession.usage ||= { cost: 0, in: 0, cr: 0, out: 0, ctx: 0, steps: 0, prompts: 0, model: 'Gemini 3.1 Pro' };
                  parentSession.usage.steps = (parentSession.usage.steps || 0) + 1;
                  parentSession.usage.in += inp + cr;
                  parentSession.usage.cr = (parentSession.usage.cr || 0) + cr;
                  parentSession.usage.out += out;
                  parentSession.usage.cost += stepCost;
                }
                changed = true;
              }
              const tools = Array.isArray(j.tool_calls) ? j.tool_calls.filter((t) => t?.name) : [];
              if (tools.length > 0) {
                const tc = tools[tools.length - 1];
                const norm = normalizeAgyTool(tc.name, tc.args);
                subSt.lastTool = norm;
                newTool = norm;
                newToolTs = ts;
              }
            }
          }
        }
      } finally { await fh.close(); }
    }
    if (newTool) {
      if (newTool.tool_name === 'Bash' && /\bgit\s+(commit|push|pull|merge|rebase|checkout|switch|add|reset|stash|init)\b/i.test(String(newTool.tool_input?.command || ''))) {
        onGitCmd?.();
      }
      const c = await classifyVi(newTool.tool_name, newTool.tool_input);
      const runner = newTool.tool_name === 'Bash' && testRunner(newTool.tool_input?.command);
      if (runner) Object.assign(c, { type: 'test', runner });
      subSt.lastClassified = c;
      subSt.lastLabel = c.label || '';
    }
    subSt.mtimeMs = subCand.st.mtimeMs;
    if (parentSession) {
      parentSession.subs ||= {};
      const wasRunning = !!parentSession.subs[subCand.convId];
      const isRunning = meta.status === 'CASCADE_RUN_STATUS_RUNNING' || meta.notFullyIdle || (Date.now() - subCand.st.mtimeMs < 30_000);
      if (meta.agentName || meta.title) {
        const cleanRole = formatSubagentRole(meta.agentName || meta.title) || meta.agentName || meta.title;
        subRoleByConvId.set(subCand.convId, { role: cleanRole, typeName: meta.agentName || meta.title });
      }
      const savedRole = subRoleByConvId.get(subCand.convId);
      const rawSubName = savedRole?.role || meta.agentName || meta.title || `sub-${subCand.convId.slice(0, 4)}`;
      const subName = formatSubagentRole(rawSubName) || rawSubName;
      const subLabel = clip(subName, 24);
      const subDesc = clip(meta.title || subSt.promptDesc || subName, 70);
      if (isRunning) {
        for (const [k, v] of Object.entries(parentSession.subs)) {
          if (v?.provisional) delete parentSession.subs[k];
        }
        const prevSub = parentSession.subs[subCand.convId];
        const lastInfo = subSt.lastClassified
          ? { type: subSt.lastClassified.type, label: subSt.lastClassified.label }
          : (prevSub?.last || { type: 'agent', label: clip(meta.title || subSt.promptDesc || 'Đang chạy tác vụ phụ', 60) });
        parentSession.subs[subCand.convId] = {
          id: subCand.convId,
          type: subLabel,
          desc: subDesc,
          last: lastInfo,
          startedAt: prevSub?.startedAt || subCand.st.birthtimeMs || subCand.st.mtimeMs,
          seenAt: subCand.st.mtimeMs,
          steps: meta.stepCount || subSt.steps.length || 1,
        };
        if (parentSession.status === 'rest') {
          parentSession.status = 'work';
          parentSession.busy = true;
        }
        if (!wasRunning) {
          const e = {
            id: nextSeq(),
            ts: Date.now(),
            sess: parentSession.id,
            name: parentSession.name,
            type: 'substart',
            agent: subCand.convId,
            label: subLabel,
            desc: subDesc,
          };
          pushFeed(e);
          broadcast({ k: 'ev', e, s: pub(parentSession), stats: getStats() });
          chat.onEvent(e);
        }
        if (newTool && subSt.lastClassified) {
          const c = subSt.lastClassified;
          count(parentSession, newTool.tool_name, subCand.convId);
          const img = imageId(c.file);
          const e = {
            id: nextSeq(),
            ts: newToolTs,
            sess: parentSession.id,
            name: parentSession.name,
            type: c.type,
            label: c.label,
            agent: subCand.convId,
            agentType: subLabel,
            quiet: true,
            ...(c.desc ? { desc: c.desc } : {}),
            ...(c.runner ? { runner: c.runner } : {}),
            ...(img ? { img } : {}),
          };
          broadcast({ k: 'ev', e, s: pub(parentSession), stats: getStats() });
          chat.onEvent(e);
        }
      } else if (wasRunning) {
        const finished = parentSession.subs[subCand.convId];
        delete parentSession.subs[subCand.convId];
        if (finished) {
          finished.endedAt = Date.now();
          parentSession.doneSubs = [finished, ...(parentSession.doneSubs || []).filter((d) => d.id !== subCand.convId)].slice(0, 8);
        }
        const parentSt = states.get(meta.parentId);
        if (parentSt) {
          parentSt.lastSubStopAt = Date.now();
          if (Object.keys(parentSession.subs || {}).length === 0) {
            parentSt.pendingSubCalls = 0;
          }
        }
        const e = {
          id: nextSeq(),
          ts: Date.now(),
          sess: parentSession.id,
          name: parentSession.name,
          type: 'substop',
          agent: subCand.convId,
          label: subLabel,
          desc: subDesc,
        };
        pushFeed(e);
        broadcast({ k: 'ev', e, s: pub(parentSession), stats: getStats() });
        chat.onEvent(e);
      } else {
        delete parentSession.subs[subCand.convId];
      }
    }
    return changed;
  }

  async function syncConversation(convId, convDir, transcriptFile, fileStat, isPrimaryForWorkspace, workspaceIndex, dbMeta, knownRoots, hasActiveSubCandidate = false) {
    const key = 'a' + convId;
    let s = sessions.get(key);
    const isNew = !s;
    if (!s) {
      s = newSession(key);
      s.sid = convId;
      s.isAgy = true;
      s.fromFile = true;
      s.origin = 'Antigravity';
      s.entry = 'antigravity';
      s.transcript = transcriptFile;
      s.createdAt = fileStat.birthtimeMs || fileStat.mtimeMs;
      s.agySteps = [];
      sessions.set(key, s);
      sidToKey.set(convId, key);
    } else {
      s.transcript = transcriptFile;
    }

    if (dbMeta?.workspace) {
      s.cwd = dbMeta.workspace;
      s.cwdFromDb = true;
      noteDir(dbMeta.workspace);
    }

    let st = states.get(convId);
    const initial = !st;
    if (!st) {
      st = {
        offset: 0,
        mtimeMs: 0,
        transcriptFile,
        model: 'Gemini 3.1 Pro',
        firstPrompt: '',
        lastStepType: '',
        lastStepHasTools: false,
        lastFeedbackAt: 0,
        waitInfo: null,
        planCache: null,
        pendingSubCalls: 0,
        lastSubInvokeAt: 0,
        lastSubStopAt: 0,
        deferredStopLabel: null,
        deferredStopAt: 0,
        steps: s.agySteps || [],
      };
      s.agySteps = st.steps;
      states.set(convId, st);
    } else if ((st.transcriptFile && st.transcriptFile !== transcriptFile) || fileStat.size < st.offset) {
      st.offset = 0;
      st.mtimeMs = 0;
      st.transcriptFile = transcriptFile;
    } else {
      st.transcriptFile = transcriptFile;
    }

    const liveEvents = [];
    let usageChanged = false;
    if (fileStat.size > st.offset) {
      const fh = await fsp.open(transcriptFile, 'r');
      try {
        if (initial && fileStat.size > 12_000_000) {
          // Very large transcript (>12 MB): read 256 KB head + 4 MB tail
          const headBuf = Buffer.alloc(262144);
          await fh.read(headBuf, 0, headBuf.length, 0);
          for (const line of headBuf.toString('utf8').split(/\r?\n/)) {
            if (parseStepLine(line, s, st, null, knownRoots, fileStat.mtimeMs)) usageChanged = true;
          }
          const tailLen = 4_000_000;
          const tailBuf = Buffer.alloc(tailLen);
          await fh.read(tailBuf, 0, tailLen, fileStat.size - tailLen);
          const tailLines = tailBuf.toString('utf8').split(/\r?\n/);
          tailLines.shift();
          for (const line of tailLines) {
            if (parseStepLine(line, s, st, liveEvents, knownRoots, fileStat.mtimeMs)) usageChanged = true;
          }
        } else {
          const readLen = fileStat.size - st.offset;
          const buf = Buffer.alloc(readLen);
          await fh.read(buf, 0, readLen, st.offset);
          const end = buf.lastIndexOf(0x0a);
          if (end >= 0) {
            st.offset += end + 1;
            const lines = buf.subarray(0, end).toString('utf8').split(/\r?\n/);
            for (const line of lines) {
              if (parseStepLine(line, s, st, liveEvents, knownRoots, fileStat.mtimeMs)) usageChanged = true;
            }
          }
        }
        if (initial) st.offset = fileStat.size;
      } finally { await fh.close(); }
    }

    // Normalize s.cwd against known workspace roots so subfolders (e.g. e:\BioKit\apps\backend) group under e:\BioKit
    if (s.cwd && knownRoots.length) {
      const norm = normalizeWorkspacePath(s.cwd, knownRoots);
      if (norm && norm !== s.cwd) {
        s.cwd = norm;
        noteDir(norm);
      }
    }

    // Refresh task.md checklist & artifact title only when modified or on active turn
    const nowMs = Date.now();
    const shouldCheckAux = initial || fileStat.mtimeMs !== st.mtimeMs || (s.status === 'work' && nowMs - (st.auxAt || 0) > 8000);
    if (shouldCheckAux) {
      st.auxAt = nowMs;
      const taskStat = await fsp.stat(path.join(convDir, 'task.md')).catch(() => null);
      if (taskStat && taskStat.mtimeMs !== st.taskMtime) {
        st.taskMtime = taskStat.mtimeMs;
        const todos = await readAgyTodos(convDir);
        if (todos.length) s.todos = todos;
      }
      if (dbMeta?.title) {
        s.title = clip(redact(oneLine(dbMeta.title)), 75);
      } else if (initial || !s.title || (taskStat && taskStat.mtimeMs !== st.titleMtime)) {
        st.titleMtime = taskStat?.mtimeMs || 0;
        const artTitle = await readArtifactTitle(convDir);
        const fallbackTitle = st.firstPrompt
          ? st.firstPrompt.replace(/https?:\/\/\S+/g, '').trim() || st.firstPrompt
          : '';
        const title = artTitle || clip(fallbackTitle, 75);
        if (title) s.title = title;
      }
      s.bg = await readAgyBgTasks(convDir);
    } else if (!s.bg) {
      s.bg = new Map();
    }

    if (!s.cwd || /[\\/]agy-[0-9a-f]{4}$/i.test(s.cwd)) {
      sessions.delete(key);
      if (s.sid && sidToKey.get(s.sid) === key) sidToKey.delete(s.sid);
      return false;
    }
    const baseName = baseNameOf(s.cwd) || 'antigravity';
    s.name = workspaceIndex === 0 ? baseName : `${baseName} #${workspaceIndex + 1}`;

    // Expire stale provisional subagent entries before computing live status
    if (s.subs) {
      for (const [k, v] of Object.entries(s.subs)) {
        if (v?.provisional && Date.now() - (v.seenAt || 0) > 45_000) delete s.subs[k];
      }
    }
    if ((st.pendingSubCalls || 0) > 0 && !hasActiveSubCandidate && Object.keys(s.subs || {}).length === 0 && Date.now() - (st.lastSubInvokeAt || 0) > 5 * 60_000) {
      st.pendingSubCalls = 0;
    }

    // Determine live status ('work', 'wait', 'rest') combining DB status, subagent activity, and transcript freshness
    const ageMs = Date.now() - Math.max(fileStat.mtimeMs, s.lastEventAt || 0);
    const dbRunning = dbMeta && (dbMeta.status === 'CASCADE_RUN_STATUS_RUNNING' || dbMeta.notFullyIdle) && ageMs < 5 * 60_000;
    const hasWaitInfo = Boolean(st.waitInfo && (st.waitInfo.kind === 'ask' || st.waitInfo.kind === 'plan'));
    const waitingFeedback = st.lastFeedbackAt > 0 && Date.now() - st.lastFeedbackAt < 12 * 3600_000 && st.lastStepType === 'PLANNER_RESPONSE' && (!st.lastStepHasTools || hasWaitInfo) && !dbRunning;
    const activeTurn = dbRunning || ((st.lastStepType === 'USER_INPUT' || st.lastStepType === 'GENERIC' || st.lastStepHasTools) && ageMs < 90_000);
    const hasRunningSubs = Boolean(hasActiveSubCandidate || Object.keys(s.subs || {}).length > 0 || (st.pendingSubCalls || 0) > 0);

    // Strip any premature 'stop' events while subagents or background tasks are still running
    if (hasRunningSubs || s.bg.size > 0) {
      for (let idx = liveEvents.length - 1; idx >= 0; idx--) {
        if (liveEvents[idx].kind === 'stop') {
          st.deferredStopLabel = liveEvents[idx].label || st.deferredStopLabel || clip(s.lastReply || '', 90);
          st.deferredStopAt = liveEvents[idx].ts || Date.now();
          liveEvents.splice(idx, 1);
        }
      }
    }

    const hookActive = Date.now() - (s.hookSeenAt || 0) < 15_000;
    const prevStatus = s.status;
    if (waitingFeedback && !hasRunningSubs) {
      s.status = 'wait';
      s.busy = false;
      s.inTool = false;
      s.act = st.waitInfo?.kind === 'ask' ? 'Đang chờ chọn phương án...' : 'Đang chờ duyệt kế hoạch...';
      if (st.waitInfo?.kind === 'ask') {
        s.waitCard = {
          id: `agy-ask:${convId}:${st.waitInfo.ts || st.lastFeedbackAt}`,
          sess: s.id,
          sid: convId,
          name: s.title || s.name,
          cwd: s.cwd || '',
          kind: 'ask',
          type: 'ask',
          tool: 'AskUserQuestion',
          label: 'AskUserQuestion',
          detail: st.waitInfo.detail || st.waitInfo.questions?.[0]?.question || '',
          questions: st.waitInfo.questions || [],
          plan: null,
          planFile: null,
          planSummary: null,
          risky: false,
          remember: null,
          fromTranscript: true,
          t: st.waitInfo.ts || st.lastFeedbackAt || Date.now(),
        };
      } else {
        const defaultPlanPath = path.join(convDir, 'implementation_plan.md');
        const candPath = st.waitInfo?.filePath && fs.existsSync(st.waitInfo.filePath)
          ? st.waitInfo.filePath
          : defaultPlanPath;
        let planPath = candPath;
        let planContent = '';
        try {
          const pStat = fs.statSync(candPath);
          if (pStat.isFile()) {
            if (st.planCache && st.planCache.path === candPath && st.planCache.mtimeMs === pStat.mtimeMs) {
              planContent = st.planCache.content;
            } else {
              planContent = fs.readFileSync(candPath, 'utf8').slice(0, 24000);
              st.planCache = { path: candPath, mtimeMs: pStat.mtimeMs, content: planContent };
            }
          }
        } catch {
          planPath = st.waitInfo?.filePath || defaultPlanPath;
        }
        const planBase = path.basename(planPath) || 'implementation_plan.md';
        s.waitCard = {
          id: `agy-plan:${convId}:${st.waitInfo?.ts || st.lastFeedbackAt}`,
          sess: s.id,
          sid: convId,
          name: s.title || s.name,
          cwd: s.cwd || '',
          kind: 'plan',
          type: 'plan',
          tool: 'ExitPlanMode',
          label: planBase,
          detail: st.waitInfo?.summary || planBase,
          questions: null,
          plan: planContent || st.waitInfo?.summary || '',
          planFile: planPath || '',
          planSummary: st.waitInfo?.summary || '',
          risky: false,
          remember: null,
          fromTranscript: true,
          t: st.waitInfo?.ts || st.lastFeedbackAt || Date.now(),
        };
      }
    } else if (activeTurn || s.bg.size > 0 || hasRunningSubs) {
      s.status = 'work';
      s.busy = true;
      s.inTool = st.lastStepHasTools;
      s.waitCard = null;
      if (!s.taskStart) s.taskStart = s.lastEventAt || fileStat.mtimeMs;
    } else if (st.deferredStopLabel) {
      const sinceSubEnd = Date.now() - Math.max(st.lastSubStopAt || 0, st.deferredStopAt || 0, fileStat.mtimeMs);
      if (sinceSubEnd <= 15_000) {
        // Keep Main Agent working briefly while waiting for reactive wakeup synthesis turn
        s.status = 'work';
        s.busy = true;
        s.inTool = false;
        s.waitCard = null;
      } else {
        // Fallback: >15s elapsed after all subagents finished with no new Main Agent turn
        const stopLabel = st.deferredStopLabel;
        st.deferredStopLabel = null;
        st.deferredStopAt = 0;
        s.status = 'rest';
        s.busy = false;
        s.inTool = false;
        s.waitCard = null;
        s.doneAt = Date.now();
        if (!initial && !hookActive) {
          liveEvents.push({ kind: 'stop', ts: Date.now(), label: stopLabel });
        }
      }
    } else {
      s.status = 'rest';
      s.busy = false;
      s.inTool = false;
      s.waitCard = null;
    }
    if (s.status !== 'wait') {
      s.waitCard = null;
      if (s.act === 'Đang chờ chọn phương án...' || s.act === 'Đang chờ duyệt kế hoạch...') {
        s.act = '';
      }
    }
    if (s.status !== prevStatus) usageChanged = true;

    // Process events: on initial scan, compute counts & last tool silently; on incremental scan, emit live animations!
    if (initial) {
      let lastToolEv = null;
      for (const ev of liveEvents) {
        if (ev.kind === 'tool') {
          lastToolEv = ev;
          const k = { Read: 'read', Grep: 'read', Glob: 'read', Edit: 'edit', Write: 'edit', Bash: 'cmd', WebSearch: 'web', WebFetch: 'web' }[ev.tool_name];
          if (k) s.counts[k]++;
        }
      }
      if (lastToolEv) {
        const c = await classifyVi(lastToolEv.tool_name, lastToolEv.tool_input);
        s.last = { type: c.type, label: c.label };
      }
      if (isPrimaryForWorkspace && liveEvents.length) {
        for (const ev of liveEvents.slice(-4)) {
          if (ev.kind === 'prompt') {
            pushFeed({ id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'prompt', label: ev.label });
          } else if (ev.kind === 'substart') {
            pushFeed({ id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'substart', agent: ev.agent, label: ev.label, ...(ev.desc ? { desc: ev.desc } : {}) });
          } else if (ev.kind === 'tool') {
            const c = await classifyVi(ev.tool_name, ev.tool_input);
            const img = imageId(c.file);
            pushFeed({ id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: c.type, label: c.label, ...(c.desc ? { desc: c.desc } : {}), ...(img ? { img } : {}) });
          }
        }
      }
      broadcast({ k: 'sess', s: pub(s) });
    } else if (liveEvents.length && !hookActive) {
      rollDay();
      for (const ev of liveEvents) {
        if (ev.kind === 'prompt') {
          const stats = getStats();
          stats.prompts++;
          trophies.bump('prompts');
          trophies.session(s.sid);
          const e = { id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'prompt', label: ev.label };
          pushFeed(e);
          broadcast({ k: 'ev', e, s: pub(s), stats });
          chat.onEvent(e);
        } else if (ev.kind === 'substart') {
          const e = {
            id: nextSeq(),
            ts: ev.ts,
            sess: s.id,
            name: s.name,
            type: 'substart',
            agent: ev.agent,
            label: ev.label,
            ...(ev.desc ? { desc: ev.desc } : {}),
          };
          pushFeed(e);
          broadcast({ k: 'ev', e, s: pub(s), stats: getStats() });
          chat.onEvent(e);
        } else if (ev.kind === 'tool') {
          if (ev.tool_name === 'Bash' && /\bgit\s+(commit|push|pull|merge|rebase|checkout|switch|add|reset|stash|init)\b/i.test(String(ev.tool_input?.command || ''))) {
            onGitCmd?.();
          }
          const c = await classifyVi(ev.tool_name, ev.tool_input);
          const runner = ev.tool_name === 'Bash' && testRunner(ev.tool_input?.command);
          if (runner) Object.assign(c, { type: 'test', runner });
          s.last = { type: c.type, label: c.label };
          count(s, ev.tool_name, null);
          const img = imageId(c.file);
          const e = {
            id: nextSeq(),
            ts: ev.ts,
            sess: s.id,
            name: s.name,
            type: c.type,
            label: c.label,
            ...(c.desc ? { desc: c.desc } : {}),
            ...(c.runner ? { runner: c.runner } : {}),
            ...(img ? { img } : {}),
          };
          pushFeed(e);
          broadcast({ k: 'ev', e, s: pub(s), stats: getStats() });
          chat.onEvent(e);
        } else if (ev.kind === 'wait') {
          const w = { id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'wait', label: ev.label };
          pushFeed(w);
          broadcast({ k: 'ev', e: w, s: pub(s), stats: getStats() });
          chat.onEvent(w);
        } else if (ev.kind === 'stop') {
          const e = { id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'stop', label: ev.label };
          pushFeed(e);
          broadcast({ k: 'ev', e, s: pub(s), stats: getStats() });
          chat.onEvent(e);
        }
      }
    } else if (isNew || s.status !== prevStatus || fileStat.mtimeMs !== st.mtimeMs) {
      broadcast({ k: 'sess', s: pub(s) });
    }
    st.mtimeMs = fileStat.mtimeMs;
    return usageChanged;
  }

  async function scan() {
    const brainDirs = agyBrainDirs();
    const byConvId = new Map();
    for (const brain of brainDirs) {
      let entries = [];
      try { entries = await fsp.readdir(brain, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const convDir = path.join(brain, ent.name);
        const transcriptFile = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          const st = await fsp.stat(transcriptFile);
          if (st.isFile() && st.size > 0) {
            const prev = byConvId.get(ent.name);
            if (!prev || st.mtimeMs > prev.st.mtimeMs || (st.mtimeMs === prev.st.mtimeMs && st.size > prev.st.size)) {
              byConvId.set(ent.name, { convId: ent.name, convDir, transcriptFile, st });
            }
          }
        } catch { /* no transcript */ }
      }
    }
    const candidates = [...byConvId.values()];
    if (!candidates.length) return;
    candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

    const dbSummary = readAgySummariesDb(brainDirs[0]);
    const knownRoots = dbSummary.roots || [];

    // Separate top-level conversations from subagent conversations (parent_conversation_id != '')
    const topCandidates = [];
    const subCandidates = [];
    for (const c of candidates) {
      if (deletedConvIds.has(c.convId)) {
        const delAt = deletedConvIds.get(c.convId) || 0;
        if (c.st.mtimeMs > delAt + 10_000) {
          deletedConvIds.delete(c.convId);
          saveDeletedSessions();
        } else {
          continue;
        }
      }
      const meta = dbSummary.map.get(c.convId);
      const isSub = Boolean(meta?.parentId)
        || (Number(meta?.nestingDepth) > 0)
        || Boolean(meta?.agentName)
        || subRoleByConvId.has(c.convId)
        || /[/\\]subagents[/\\]/i.test(c.transcriptFile);
      if (isSub) {
        if (meta?.parentId) subCandidates.push({ ...c, meta });
      } else {
        topCandidates.push({ ...c, meta });
      }
    }

    // Keep top-level conversations active within the last 14 days, or at least the 8 most recent, up to maxDesks.
    const now = Date.now();
    const ACTIVE_SUB_MS = 30_000;
    const activeSubParents = new Set();
    for (const sub of subCandidates) {
      const isSubActive = sub.meta?.status === 'CASCADE_RUN_STATUS_RUNNING'
        || sub.meta?.notFullyIdle
        || (now - sub.st.mtimeMs < ACTIVE_SUB_MS);
      if (isSubActive && sub.meta?.parentId) {
        activeSubParents.add(sub.meta.parentId);
      }
    }

    const recent = topCandidates.filter((c, idx) => now - c.st.mtimeMs < 14 * 86400_000 || idx < 8).slice(0, maxDesks);
    const liveKeys = new Set();
    const countByWorkspace = new Map();
    let anyUsageChanged = false;

    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const key = 'a' + c.convId;
      const wsKey = (c.meta?.workspace || c.convId).toLowerCase();
      const wsIdx = countByWorkspace.get(wsKey) || 0;
      const changed = await syncConversation(
        c.convId,
        c.convDir,
        c.transcriptFile,
        c.st,
        i === 0,
        wsIdx,
        c.meta,
        knownRoots,
        activeSubParents.has(c.convId),
      ).catch((err) => {
        console.error('agy sync', err);
        return false;
      });
      if (sessions.has(key)) {
        liveKeys.add(key);
        countByWorkspace.set(wsKey, wsIdx + 1);
      }
      if (changed) anyUsageChanged = true;
    }

    // Sync subagents and attach their token/step usage + active status to their parent conversation
    for (const sub of subCandidates) {
      if (now - sub.st.mtimeMs > 14 * 86400_000) continue;
      const parentKey = 'a' + sub.meta.parentId;
      const parentSession = sessions.get(parentKey);
      const subChanged = await syncSubagent(sub, sub.meta, parentSession).catch(() => false);
      if (subChanged) anyUsageChanged = true;
    }

    for (const [key, s] of sessions) {
      if (s.isAgy && s.fromFile && !liveKeys.has(key)) {
        states.delete(s.sid);
        dropSession(key, s);
        anyUsageChanged = true;
      }
    }

    if (anyUsageChanged && typeof onUsageChange === 'function') {
      onUsageChange();
    }
  }

  function clearWait(convId) {
    if (!convId) return;
    const cleanId = String(convId).replace(/^(?:agy:|a)/, '');
    for (const id of new Set([String(convId), cleanId])) {
      const st = states.get(id);
      if (st) {
        st.lastFeedbackAt = 0;
        st.waitInfo = null;
      }
      const sKey = sidToKey?.get(id);
      const s = (sKey && sessions.get(sKey))
        || sessions.get('a' + id)
        || sessions.get('agy:' + id)
        || [...sessions.values()].find((x) => x.sid === id || x.id === id);
      if (s) {
        s.waitCard = null;
      }
    }
  }

  function deleteSession(convId) {
    if (!convId) return false;
    const cleanId = String(convId).replace(/^(?:agy:|a)/, '');
    deletedConvIds.set(cleanId, Date.now());
    saveDeletedSessions();
    states.delete(cleanId);
    subStates.delete(cleanId);
    clearWait(cleanId);
    return true;
  }

  return { scan, clearWait, deleteSession };
}

export { createAntigravityWatcher as startAntigravityWatcher };

