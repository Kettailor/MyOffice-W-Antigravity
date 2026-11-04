// Antigravity Brain Watcher, SQLite Summary Reader & Real-Time Quota Engine.
// Automatically discovers and tails live Antigravity conversations in ~/.gemini/antigravity/brain/<conversation-id>,
// cross-references ~/.gemini/antigravity/conversation_summaries.db for authoritative workspaces & subagent links,
// parses transcript.jsonl, task.md checklists, implementation_plan.md titles, per-step token usage, and normalizes
// Antigravity tool calls and hook payloads into Work Office events.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './redact.mjs';

let cachedNativeBin = undefined;
export function findNativeRustBin() {
  if (cachedNativeBin !== undefined) return cachedNativeBin;
  const envBin = process.env.WORK_OFFICE_NATIVE_BIN;
  const binName = process.platform === 'win32' ? 'work-office-native.exe' : 'work-office-native';
  const candidates = [
    ...(envBin ? [envBin] : []),
    '/usr/local/bin/work-office-native',
    path.join(process.cwd(), 'bin', binName),
    path.join(process.cwd(), 'rust-native', 'target', 'release', binName),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        cachedNativeBin = c;
        return c;
      }
    } catch { /* ignore */ }
  }
  cachedNativeBin = null;
  return null;
}

function scanBrainWithRust(nativeBin, brainDirs) {
  return new Promise((resolve) => {
    execFile(nativeBin, ['--scan-brain', ...brainDirs], { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      try {
        const arr = JSON.parse(String(stdout));
        if (!Array.isArray(arr)) { resolve(null); return; }
        resolve(arr.map((item) => ({
          convId: item.convId,
          convDir: item.convDir,
          transcriptFile: item.transcriptFile,
          st: {
            isFile: () => true,
            size: Number(item.size) || 0,
            mtimeMs: Number(item.mtimeMs) || 0,
            birthtimeMs: Number(item.birthtimeMs) || Number(item.mtimeMs) || 0,
          },
        })));
      } catch {
        resolve(null);
      }
    });
  });
}

function tailTranscriptWithRust(nativeBin, transcriptFile, offset = 0) {
  return new Promise((resolve) => {
    execFile(nativeBin, ['--tail-transcript', transcriptFile, String(offset)], {
      timeout: 3000,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const res = JSON.parse(stdout);
        if (!res || !res.ok || !Array.isArray(res.lines)) return resolve(null);
        resolve(res);
      } catch {
        resolve(null);
      }
    });
  });
}

function capMap(map, max = 500, keep = 400) {
  if (map.size <= max) return;
  const drop = map.size - keep;
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i >= drop) break;
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const subRoleByConvId = new Map(); // convId -> { role, typeName }

const DATA_DIR = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.join(process.cwd(), 'data');
const SUMMARY_CACHE_FILE = path.join(DATA_DIR, 'agy-summaries-cache.json');
const DELETED_SESSIONS_FILE = path.join(DATA_DIR, 'deleted-sessions.json');
const CLEARED_WAITS_FILE = path.join(DATA_DIR, 'cleared-waits.json');
const persistentMetaMap = new Map();
const deletedConvIds = new Map(); // convId -> deletedAtMs
const clearedWaits = new Map(); // convId -> clearedAtMs
let saveCacheTimer = null;

try {
  const saved = JSON.parse(fs.readFileSync(SUMMARY_CACHE_FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) {
      if (v && typeof v === 'object') persistentMetaMap.set(k, v);
    }
    capMap(persistentMetaMap, 600, 450);
  }
} catch { /* first run or missing cache */ }

try {
  const delSaved = JSON.parse(fs.readFileSync(DELETED_SESSIONS_FILE, 'utf8'));
  if (delSaved && typeof delSaved === 'object') {
    const cutoff30d = Date.now() - 30 * 86400_000;
    for (const [k, v] of Object.entries(delSaved)) {
      const ts = Number(v) || Date.now();
      if (k && ts >= cutoff30d) deletedConvIds.set(k, ts);
    }
    capMap(deletedConvIds, 500, 400);
  }
} catch { /* first run or missing file */ }

try {
  const cwSaved = JSON.parse(fs.readFileSync(CLEARED_WAITS_FILE, 'utf8'));
  if (cwSaved && typeof cwSaved === 'object') {
    const cutoff14d = Date.now() - 14 * 86400_000;
    for (const [k, v] of Object.entries(cwSaved)) {
      const ts = Number(v) || 0;
      if (k && ts >= cutoff14d) clearedWaits.set(k, ts);
    }
    capMap(clearedWaits, 500, 400);
  }
} catch { /* first run or missing file */ }

function scheduleSaveSummaryCache() {
  if (saveCacheTimer) return;
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    try {
      capMap(persistentMetaMap, 600, 450);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const obj = Object.fromEntries(persistentMetaMap);
      fsp.writeFile(SUMMARY_CACHE_FILE, JSON.stringify(obj)).catch(() => {});
    } catch { /* ignore */ }
  }, 2500);
  saveCacheTimer.unref?.();
}

function saveDeletedSessions() {
  try {
    const cutoff30d = Date.now() - 30 * 86400_000;
    for (const [k, ts] of deletedConvIds) {
      if (ts < cutoff30d) deletedConvIds.delete(k);
    }
    capMap(deletedConvIds, 500, 400);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(deletedConvIds);
    fsp.writeFile(DELETED_SESSIONS_FILE, JSON.stringify(obj)).catch(() => {});
  } catch { /* ignore */ }
}

function saveClearedWaits() {
  try {
    const cutoff14d = Date.now() - 14 * 86400_000;
    for (const [k, ts] of clearedWaits) {
      if (ts < cutoff14d) clearedWaits.delete(k);
    }
    capMap(clearedWaits, 500, 400);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(clearedWaits);
    fsp.writeFile(CLEARED_WAITS_FILE, JSON.stringify(obj)).catch(() => {});
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
let projectWsCache = { at: 0, mtimeMs: 0, map: new Map() };
function readConfigProjectWorkspaces() {
  const now = Date.now();
  if (now - projectWsCache.at < 15_000 && projectWsCache.map.size > 0) return projectWsCache.map;
  const out = new Map();
  try {
    const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const projDir = path.join(home, '.gemini', 'config', 'projects');
    if (!fs.existsSync(projDir)) return out;
    const st = fs.statSync(projDir);
    if (st.mtimeMs === projectWsCache.mtimeMs && projectWsCache.map.size > 0) {
      projectWsCache.at = now;
      return projectWsCache.map;
    }
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
    projectWsCache = { at: now, mtimeMs: st.mtimeMs, map: out };
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
export function cleanVal(v, depth = 0) {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) {
    return v.map((item) => cleanVal(item, depth + 1));
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = cleanVal(val, depth + 1);
    }
    return out;
  }
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return v;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith('[') && s.endsWith(']')) ||
    (s.startsWith('{') && s.endsWith('}'))
  ) {
    try {
      const parsed = JSON.parse(s);
      if (parsed !== v) return cleanVal(parsed, depth + 1);
    } catch {
      if (s.startsWith('"') && s.endsWith('"')) {
        const unquoted = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (unquoted !== s) return cleanVal(unquoted, depth + 1);
        return unquoted;
      }
    }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return v;
}

export function cleanArgs(args) {
  let obj = args;
  let guard = 0;
  while (typeof obj === 'string' && guard++ < 4) {
    const s = obj.trim();
    if (!s) return {};
    try {
      obj = JSON.parse(s);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = cleanVal(v, 0);
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
    case 'ask_question':
    case 'AskUserQuestion': {
      const qs = Array.isArray(a.questions)
        ? a.questions
        : Array.isArray(a.Questions)
          ? a.Questions
          : (a.question || a.Question)
            ? [a]
            : [];
      const normQuestions = qs.map((rawQ) => {
        const q = typeof rawQ === 'string' ? cleanVal(rawQ) : rawQ;
        if (typeof q === 'string') {
          return { question: q, header: '', multi: false, multiSelect: false, options: [] };
        }
        const optsRaw = Array.isArray(q?.options) ? q.options : (Array.isArray(q?.Options) ? q.Options : []);
        return {
          question: String(q?.question || q?.Question || q?.prompt || ''),
          header: String(q?.header || q?.Header || ''),
          multi: Boolean(q?.is_multi_select ?? q?.multiSelect ?? q?.multi),
          multiSelect: Boolean(q?.is_multi_select ?? q?.multiSelect ?? q?.multi),
          options: optsRaw.map((rawO) => {
            const o = typeof rawO === 'string' ? cleanVal(rawO) : rawO;
            return typeof o === 'string'
              ? { label: o, description: '' }
              : { label: String(o?.label || o?.Label || o?.value || ''), description: String(o?.description || o?.Description || '') };
          }),
        };
      });
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

async function readSingleRichTranscriptEntries(transcriptFile) {
  let fh;
  try { fh = await fsp.open(transcriptFile, 'r'); } catch { return []; }
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 8_000_000);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (size > len) lines.shift();
    const entries = [];
    let needsFull = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (Array.isArray(j.truncated_fields) && j.truncated_fields.length > 0 && j.step_index != null) {
        needsFull = true;
      }
      entries.push(j);
    }
    if (needsFull) {
      const fullPath = path.join(path.dirname(transcriptFile), 'transcript_full.jsonl');
      let fullFh;
      try {
        fullFh = await fsp.open(fullPath, 'r');
        const fullStat = await fullFh.stat();
        const fullLen = Math.min(fullStat.size, 6_000_000);
        const fullBuf = Buffer.alloc(fullLen);
        await fullFh.read(fullBuf, 0, fullLen, fullStat.size - fullLen);
        const fullLines = fullBuf.toString('utf8').split(/\r?\n/);
        if (fullStat.size > fullLen) fullLines.shift();
        const fullByStep = new Map();
        for (const fl of fullLines) {
          if (!fl.trim()) continue;
          try {
            const fj = JSON.parse(fl);
            if (fj && fj.step_index != null) fullByStep.set(fj.step_index, fj);
          } catch { /* ignore */ }
        }
        for (const j of entries) {
          if (Array.isArray(j.truncated_fields) && j.truncated_fields.length > 0 && fullByStep.has(j.step_index)) {
            const fj = fullByStep.get(j.step_index);
            if (Array.isArray(fj.tool_calls) && fj.tool_calls.length > 0) j.tool_calls = fj.tool_calls;
            if (typeof fj.thinking === 'string' && fj.thinking) j.thinking = fj.thinking;
            if (typeof fj.content === 'string' && fj.content) j.content = fj.content;
          }
        }
      } catch { /* ignore missing transcript_full.jsonl */ }
      finally { await fullFh?.close(); }
    }
    return entries;
  } finally {
    await fh.close();
  }
}

const richConvCache = new Map(); // convId -> { mtimeMs, size, sig, result }
const artifactListCache = new Map(); // cacheKey -> { at, dirSig, result }
const ARTIFACT_CACHE_TTL_MS = 2500;

export function invalidateAgyArtifactCache(convId = '') {
  if (!convId) {
    artifactListCache.clear();
    return;
  }
  const clean = String(convId).replace(/^a(?=[0-9a-f]{8}-)/i, '').trim();
  for (const k of [...artifactListCache.keys()]) {
    if (k === clean || k.startsWith(`${clean}|`)) {
      artifactListCache.delete(k);
    }
  }
}

// Reads structured turns (user prompt, media, thinking steps, tool calls, file diffs, assistant markdown responses)
// for the Antigravity IDE view (/antigravity).
export async function readAgyRichConversation(convId, transcriptFile, classify, viCache = {}, registerImage = null) {
  const cleanConvId = String(convId || '').replace(/^a(?=[0-9a-f]{8}-)/i, '').trim();
  const files = [];
  const seenFiles = new Set();
  const statParts = [];
  let primaryStat = null;
  const addFile = (fp) => {
    if (!fp || typeof fp !== 'string') return;
    try {
      const key = path.resolve(fp).toLowerCase();
      if (seenFiles.has(key)) return;
      const st = fs.statSync(fp);
      if (st && st.isFile()) {
        seenFiles.add(key);
        files.push(fp);
        if (!primaryStat) primaryStat = st;
        statParts.push(`${key}:${st.mtimeMs}:${st.size}`);
      }
    } catch { /* ignore */ }
  };
  addFile(transcriptFile);
  const inferredConvId = cleanConvId || (
    transcriptFile && /[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/i.test(transcriptFile)
      ? path.basename(path.dirname(path.dirname(path.dirname(transcriptFile))))
      : ''
  );
  if (inferredConvId && !process.env.OFFICE_AGY_BRAIN_DIR) {
    for (const bDir of agyBrainDirs()) {
      addFile(path.join(bDir, inferredConvId, '.system_generated', 'logs', 'transcript.jsonl'));
    }
  } else if (inferredConvId) {
    addFile(path.join(agyBrainDir(), inferredConvId, '.system_generated', 'logs', 'transcript.jsonl'));
  }
  if (!files.length) return [];

  const cacheKey = inferredConvId || path.resolve(files[0]).toLowerCase();
  const statSig = statParts.join('|');
  const cached = richConvCache.get(cacheKey);
  if (
    cached
    && cached.sig === statSig
    && cached.mtimeMs === (primaryStat?.mtimeMs || 0)
    && cached.size === (primaryStat?.size || 0)
  ) {
    return cached.result;
  }

  let allEntries = [];
  for (const f of files) {
    const part = await readSingleRichTranscriptEntries(f);
    allEntries.push(...part);
  }
  if (files.length > 1) {
    allEntries.sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) || 0 : 0;
      const tb = b.created_at ? Date.parse(b.created_at) || 0 : 0;
      return ta - tb || ((a.step_index ?? 0) - (b.step_index ?? 0));
    });
    const deduped = [];
    const seenSig = new Set();
    for (const e of allEntries) {
      const sig = `${e.type || ''}|${e.step_index ?? ''}|${e.created_at || ''}`;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      deduped.push(e);
    }
    allEntries = deduped;
  }

  const turns = [];
  let currentTurn = null;

  for (const j of allEntries) {
    const ts = j.created_at ? Date.parse(j.created_at) || 0 : 0;
    const stepIndex = j.step_index;
    if (j.type === 'USER_INPUT') {
      const req = extractUserRequest(j.content || '');
      const rawMedia = Array.isArray(j.media) ? j.media : [];
      if (!req && !rawMedia.length) continue;
      const media = rawMedia.map((m, idx) => {
        const uri = m?.uri || '';
        const imgId = registerImage && uri ? registerImage(uri) : '';
        return {
          mime: m?.mime_type || 'image/png',
          url: imgId ? `/api/image?id=${encodeURIComponent(imgId)}` : '',
          name: path.basename(uri || `image-${idx + 1}.png`),
        };
      }).filter((m) => m.url);
      currentTurn = {
        id: `turn-${stepIndex || turns.length}`,
        userText: redact(req),
        ts,
        media,
        steps: [],
        responses: [],
        filesChanged: [],
        workDurationMs: 0,
        lastTs: ts,
      };
      turns.push(currentTurn);
    } else if (j.type === 'PLANNER_RESPONSE') {
      if (!currentTurn) {
        currentTurn = {
          id: `turn-${stepIndex || turns.length}`,
          userText: '',
          ts,
          media: [],
          steps: [],
          responses: [],
          filesChanged: [],
          workDurationMs: 0,
          lastTs: ts,
        };
        turns.push(currentTurn);
      }
      if (ts > 0) {
        if (!currentTurn.ts) currentTurn.ts = ts;
        currentTurn.lastTs = Math.max(currentTurn.lastTs || 0, ts);
        currentTurn.workDurationMs = Math.max(0, currentTurn.lastTs - currentTurn.ts);
      }
      if (typeof j.thinking === 'string' && j.thinking.trim()) {
        currentTurn.steps.push({
          kind: 'thinking',
          text: clip(redact(j.thinking.trim()), 4000),
          ts,
        });
      }
      if (Array.isArray(j.tool_calls)) {
        for (const tc of j.tool_calls) {
          if (!tc?.name) continue;
          const norm = normalizeAgyTool(tc.name, tc.args);
          const k = classify ? classify(norm.tool_name, norm.tool_input) : { type: 'other', label: norm.tool_name };
          const rawFp = norm.tool_input?.file_path || norm.tool_input?.Path || '';
          const fp = rawFp && rawFp !== 'file' ? String(rawFp) : '';
          currentTurn.steps.push({
            kind: 'tool',
            toolName: tc.name,
            type: k.type,
            label: (k.tr && viCache[k.label]) || k.label,
            desc: k.desc ? (viCache[k.desc] || k.desc) : '',
            file: fp,
            ts,
          });
          if ((norm.tool_name === 'Edit' || norm.tool_name === 'Write') && fp) {
            const a = cleanArgs(tc.args);
            let added = 0;
            let removed = 0;
            if (norm.tool_name === 'Write') {
              const contentStr = String(a.Content ?? a.CodeContent ?? a.content ?? '');
              added = contentStr ? contentStr.split(/\r?\n/).length : 1;
              removed = 0;
            } else {
              const oldStr = String(a.Target ?? a.old_string ?? a.TargetContent ?? '');
              const newStr = String(a.Replacement ?? a.new_string ?? a.ReplacementContent ?? '');
              if (oldStr || newStr) {
                removed = oldStr ? oldStr.split(/\r?\n/).length : 0;
                added = newStr ? newStr.split(/\r?\n/).length : 0;
              } else if (Array.isArray(a.ReplacementChunks)) {
                for (const ch of a.ReplacementChunks) {
                  const t = String(ch?.TargetContent ?? '');
                  const r = String(ch?.ReplacementContent ?? '');
                  if (t) removed += t.split(/\r?\n/).length;
                  if (r) added += r.split(/\r?\n/).length;
                }
              } else {
                added = 1;
                removed = 1;
              }
            }
            const existing = currentTurn.filesChanged.find((f) => f.path === fp);
            if (existing) {
              existing.added += added;
              existing.removed += removed;
            } else {
              currentTurn.filesChanged.push({
                path: fp,
                name: path.basename(fp),
                added,
                removed,
              });
            }
          }
        }
      }
      if (typeof j.content === 'string' && j.content.trim()) {
        currentTurn.responses.push({
          text: clip(redact(j.content.trim()), 32000),
          ts,
        });
      }
    }
  }

  const result = turns.slice(-60);
  richConvCache.set(cacheKey, {
    mtimeMs: primaryStat?.mtimeMs || 0,
    size: primaryStat?.size || 0,
    sig: statSig,
    result,
  });
  capMap(richConvCache, 30, 22);
  return result;
}

function formatArtifactNameAsTitle(filename = '') {
  return String(filename || '')
    .replace(/\.md$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /^(ui|ai|id|db|os|qa)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

async function readMdArtifactEntry(dirPath, fileName, knownStat = null) {
  const fullPath = path.join(dirPath, fileName);
  const st = knownStat || await fsp.stat(fullPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  let content = '';
  const fh = await fsp.open(fullPath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const readLen = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(readLen);
    await fh.read(buf, 0, readLen, 0);
    content = buf.toString('utf8');
  } finally {
    await fh.close();
  }
  let summary = '';
  let mtimeMs = st.mtimeMs || 0;
  try {
    const metaRaw = await fsp.readFile(`${fullPath}.metadata.json`, 'utf8');
    const meta = JSON.parse(metaRaw);
    if (typeof meta?.summary === 'string') summary = meta.summary.trim();
    if (meta?.updatedAt) {
      const parsedAt = Date.parse(meta.updatedAt);
      if (parsedAt > mtimeMs) mtimeMs = parsedAt;
    }
  } catch { /* optional metadata file */ }
  const headingMatch = /^#\s+(.+)$/m.exec(content);
  const rawHeading = headingMatch
    ? headingMatch[1].replace(/[*`~]/g, '').trim()
    : '';
  const title = clip(redact(oneLine(rawHeading || formatArtifactNameAsTitle(fileName))), 120);
  return {
    name: fileName,
    title: title || fileName,
    summary: summary ? clip(redact(oneLine(summary)), 280) : '',
    mtimeMs,
    size: st.size,
    content: redact(content),
  };
}

// Reads markdown artifacts (custom blueprints, implementation_plan.md, task.md, walkthrough.md) for a conversation.
export async function readAgyBrainArtifacts(convId, workspaceDir = '') {
  const cleanConvId = String(convId || '').replace(/^a(?=[0-9a-f]{8}-)/i, '').trim();
  const cacheKey = `${cleanConvId || '__default__'}|${workspaceDir || ''}`;
  const now = Date.now();
  const brainDirs = agyBrainDirs();

  // Compute a fast signature of .md files inside the target convDir (if any) so direct edits invalidate cache immediately
  const convDirsWithMd = [];
  const sigParts = [];
  if (cleanConvId) {
    for (const bDir of brainDirs) {
      const cDir = path.join(bDir, cleanConvId);
      let names = [];
      try { names = await fsp.readdir(cDir); } catch { continue; }
      const mdFiles = [];
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.md') || name.startsWith('.')) continue;
        const st = await fsp.stat(path.join(cDir, name)).catch(() => null);
        if (st && st.isFile()) {
          mdFiles.push({ name, st });
          sigParts.push(`${cDir}:${name}:${st.mtimeMs}:${st.size}`);
        }
      }
      if (mdFiles.length > 0) {
        convDirsWithMd.push({ cDir, mdFiles });
      }
    }
  }
  const dirSig = sigParts.join('|');
  const cached = artifactListCache.get(cacheKey);
  if (cached && now - cached.at < ARTIFACT_CACHE_TTL_MS && cached.dirSig === dirSig) {
    return cached.result;
  }

  const byName = new Map();

  for (const { cDir, mdFiles } of convDirsWithMd) {
    for (const { name, st } of mdFiles) {
      const low = name.toLowerCase();
      const item = await readMdArtifactEntry(cDir, name, st);
      if (!item) continue;
      const prev = byName.get(low);
      if (!prev || item.mtimeMs > prev.mtimeMs) {
        byName.set(low, item);
      }
    }
  }

  // Only fallback to scanning recent brain conversation folders when the target conversation has no artifacts (byName.size === 0)
  if (byName.size === 0) {
    const scanConvDir = async (cDir) => {
      let names = [];
      try { names = await fsp.readdir(cDir); } catch { return; }
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.md') || name.startsWith('.')) continue;
        const low = name.toLowerCase();
        const item = await readMdArtifactEntry(cDir, name);
        if (!item) continue;
        const prev = byName.get(low);
        if (!prev || item.mtimeMs > prev.mtimeMs) {
          byName.set(low, item);
        }
      }
    };

    const recentConvDirs = [];
    for (const bDir of brainDirs) {
      let entries = [];
      try { entries = await fsp.readdir(bDir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name === cleanConvId) continue;
        const fullDir = path.join(bDir, ent.name);
        const st = await fsp.stat(fullDir).catch(() => null);
        if (st) recentConvDirs.push({ dir: fullDir, mtimeMs: st.mtimeMs || 0 });
      }
    }
    recentConvDirs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const rc of recentConvDirs.slice(0, 5)) {
      await scanConvDir(rc.dir);
      if (byName.size >= 4) break;
    }
  }

  // Check workspace root for blueprint/plan markdown artifacts if still empty
  if (byName.size === 0) {
    const candidateRoots = [workspaceDir, process.cwd()].filter(Boolean);
    for (const root of candidateRoots) {
      let names = [];
      try { names = await fsp.readdir(root); } catch { continue; }
      for (const name of names) {
        if (!name.toLowerCase().endsWith('.md')) continue;
        if (/^(readme|agents|changelog|license|contributing)\.md$/i.test(name)) continue;
        const item = await readMdArtifactEntry(root, name);
        if (item && !byName.has(name.toLowerCase())) {
          byName.set(name.toLowerCase(), item);
        }
      }
    }
  }

  const STD_RANK = {
    'implementation_plan.md': 1,
    'task.md': 2,
    'walkthrough.md': 3,
  };
  const result = [...byName.values()].sort((a, b) => {
    const ra = STD_RANK[a.name.toLowerCase()] ?? 0;
    const rb = STD_RANK[b.name.toLowerCase()] ?? 0;
    if (ra !== rb) return ra - rb;
    return (b.mtimeMs || 0) - (a.mtimeMs || 0);
  });

  artifactListCache.set(cacheKey, {
    at: Date.now(),
    dirSig,
    result,
  });
  capMap(artifactListCache, 40, 30);
  return result;
}

// Quota weight of a single prompt or planner response step in the 5-hour rolling window.
// Calibrated against real Antigravity IDE (Gemini Models) usage (~26 tasks & ~1113 steps => 20% 5h used / 80% left, 12% weekly used / 88% left):
// - Assigning a new task (USER_INPUT) increments quota (+0.035% 5h window)
// - Every agent step (PLANNER_RESPONSE) increments quota based on step count + fresh/cached tokens
function stepQuotaUnits5h(step) {
  if (!step) return 0;
  if (step.kind === 'prompt') return 0.035 * 1.15;
  const base = 0.013;
  const freshWeight = ((Number(step.inp) || 0) + (Number(step.out) || 0)) / 50_000 * 0.02;
  const cacheWeight = (Number(step.cr) || 0) / 2_500_000 * 0.01;
  return (base + freshWeight + cacheWeight) * 1.15;
}

export function readAgyUseAiCredits() {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const j = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return Boolean(j?.userSettings?.useAiCredits);
  } catch {
    return false;
  }
}

export async function writeAgyUseAiCredits(enabled) {
  try {
    const cfgPath = path.join(os.homedir(), '.gemini', 'config', 'config.json');
    let j = {};
    if (fs.existsSync(cfgPath)) {
      j = JSON.parse(await fsp.readFile(cfgPath, 'utf8'));
    }
    j.userSettings = { ...(j.userSettings || {}), useAiCredits: Boolean(enabled) };
    await fsp.mkdir(path.dirname(cfgPath), { recursive: true });
    await fsp.writeFile(cfgPath, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
    return { ok: true, useAiCredits: Boolean(enabled) };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

let cachedAgyAccountEmail = '';
let cachedAgyAccountEmailAt = 0;

export function clearAgyAccountEmailCache() {
  cachedAgyAccountEmail = '';
  cachedAgyAccountEmailAt = 0;
}

export function detectAgyAccountEmail() {
  const now = Date.now();
  if (cachedAgyAccountEmail && now - cachedAgyAccountEmailAt < 60_000) {
    return cachedAgyAccountEmail;
  }
  const isRealEmail = (val) => {
    const s = String(val || '').trim();
    return s.includes('@') && !/@users\.noreply\.github\.com$/i.test(s) && !/@antigravity\.local$/i.test(s);
  };
  const envEmail = String(process.env.OFFICE_AGY_EMAIL || '').trim();
  if (isRealEmail(envEmail)) {
    cachedAgyAccountEmail = envEmail;
    cachedAgyAccountEmailAt = now;
    return envEmail;
  }
  const home = os.homedir();
  const appData = process.env.APPDATA || (
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.config')
  );
  const appStorageFiles = [
    path.join(appData, 'Antigravity', 'app_storage.json'),
    path.join(home, 'AppData', 'Roaming', 'Antigravity', 'app_storage.json'),
    path.join(home, 'Library', 'Application Support', 'Antigravity', 'app_storage.json'),
    path.join(home, '.config', 'Antigravity', 'app_storage.json'),
  ];
  for (const fp of appStorageFiles) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      const loginUser = data?.['jetski.onboarding.lastLoginUsername'] || data?.lastLoginUsername || data?.email;
      if (isRealEmail(loginUser)) {
        cachedAgyAccountEmail = String(loginUser).trim();
        cachedAgyAccountEmailAt = now;
        return cachedAgyAccountEmail;
      }
      const matches = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const firstReal = matches.find(isRealEmail);
      if (firstReal) {
        cachedAgyAccountEmail = firstReal.trim();
        cachedAgyAccountEmailAt = now;
        return cachedAgyAccountEmail;
      }
    } catch { /* ignore */ }
  }
  const candFiles = [
    path.join(home, '.gemini', 'google_accounts.json'),
    path.join(home, '.gemini', 'accounts.json'),
    path.join(home, '.gemini', 'oauth_creds.json'),
  ];
  for (const fp of candFiles) {
    try {
      if (!fs.existsSync(fp)) continue;
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        if (isRealEmail(data.active)) {
          cachedAgyAccountEmail = data.active.trim();
          cachedAgyAccountEmailAt = now;
          return cachedAgyAccountEmail;
        }
        if (isRealEmail(data.email)) {
          cachedAgyAccountEmail = data.email.trim();
          cachedAgyAccountEmailAt = now;
          return cachedAgyAccountEmail;
        }
        if (Array.isArray(data.accounts)) {
          const acc = data.accounts.find((a) => a && isRealEmail(a.email));
          if (acc) {
            cachedAgyAccountEmail = acc.email.trim();
            cachedAgyAccountEmailAt = now;
            return cachedAgyAccountEmail;
          }
        }
        if (typeof data.id_token === 'string' && data.id_token.includes('.')) {
          const parts = data.id_token.split('.');
          if (parts[1]) {
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            if (payload && isRealEmail(payload.email)) {
              cachedAgyAccountEmail = payload.email.trim();
              cachedAgyAccountEmailAt = now;
              return cachedAgyAccountEmail;
            }
          }
        }
      }
      const matches = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const firstReal = matches.find(isRealEmail);
      if (firstReal) {
        cachedAgyAccountEmail = firstReal;
        cachedAgyAccountEmailAt = now;
        return cachedAgyAccountEmail;
      }
    } catch { /* ignore */ }
  }
  try {
    const gitEmail = execFileSync('git', ['config', '--global', 'user.email'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    }).trim();
    if (isRealEmail(gitEmail)) {
      cachedAgyAccountEmail = gitEmail;
      cachedAgyAccountEmailAt = now;
      return gitEmail;
    }
  } catch { /* ignore */ }
  const fallback = `${process.env.USERNAME || process.env.USER || 'director'}@gmail.com`;
  cachedAgyAccountEmail = fallback;
  cachedAgyAccountEmailAt = now;
  return fallback;
}

let cachedHasUltraConfig = null;
let cachedHasUltraConfigAt = 0;
function hasLocalUltraConfig() {
  const now = Date.now();
  if (cachedHasUltraConfig !== null && now - cachedHasUltraConfigAt < 60_000) {
    return cachedHasUltraConfig;
  }
  const home = os.homedir();
  const appData = process.env.APPDATA || (
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : path.join(home, '.config')
  );
  const candidates = [
    path.join(home, '.gemini', 'config', 'config.json'),
    path.join(appData, 'Antigravity', 'app_storage.json'),
    path.join(home, 'AppData', 'Roaming', 'Antigravity', 'app_storage.json'),
  ];
  cachedHasUltraConfig = candidates.some((fp) => {
    try { return fs.existsSync(fp); } catch { return false; }
  });
  cachedHasUltraConfigAt = now;
  return cachedHasUltraConfig;
}

// Computes real-time Antigravity 5-hour quota and 7-day weekly quota aggregated by Account Email!
export function computeAgyQuota(sessions, allowedFilter = null, accountSlug = null, accountEmail = '') {
  const now = Date.now();
  const fiveHoursMs = 5 * 3600_000;
  const sevenDaysMs = 7 * 86400_000;
  const cutoff5h = now - fiveHoursMs;
  const cutoff7d = now - sevenDaysMs;
  const startOfTodayMs = new Date(now).setHours(0, 0, 0, 0);

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
  const stepTimestamps = [];
  for (const s of sessions.values()) {
    if (!s.isAgy) continue;
    const dir = s.cwd || path.join(process.cwd(), 'antigravity');
    if (allowedFilter && !allowedFilter(dir)) continue;
    const stepList = Array.isArray(s.agySteps) ? s.agySteps : [];
    for (const st of stepList) {
      if (!st || !st.ts || st.ts < cutoff7d) continue;
      if (accountSlug !== null) {
        const stAcct = st.acct ?? s.agyAccount ?? '';
        if (stAcct !== accountSlug) continue;
      }
      stepTimestamps.push(st.ts);
    }
  }
  stepTimestamps.sort((a, b) => a - b);

  // Weekly & 5-hour quota cycles: uses local Google AI Ultra anchor when local config & historical transcript steps exist,
  // otherwise dynamic rolling cycles from the session's own transcript steps.
  const ANCHOR_WEEK_MS = Date.parse('2026-11-04T02:49:00Z');
  const ANCHOR_5H_MS = Date.parse('2026-11-04T13:30:00Z');
  const isPrimaryUltraAnchor = !accountEmail
    && (accountSlug === null || accountSlug === '')
    && hasLocalUltraConfig()
    && stepTimestamps.some((ts) => ts <= ANCHOR_5H_MS);

  let activeWeekStartMs = cutoff7d;
  let activeReset7dMs = now + sevenDaysMs;
  if (isPrimaryUltraAnchor && now >= ANCHOR_WEEK_MS && stepTimestamps.length > 0) {
    const elapsedWeeks = Math.max(0, Math.floor((now - ANCHOR_WEEK_MS) / sevenDaysMs));
    activeWeekStartMs = ANCHOR_WEEK_MS + elapsedWeeks * sevenDaysMs;
    activeReset7dMs = activeWeekStartMs + sevenDaysMs;
  } else if (stepTimestamps.length > 0) {
    let cycleReset7d = 0;
    for (const ts of stepTimestamps) {
      if (ts >= cycleReset7d) {
        activeWeekStartMs = ts;
        cycleReset7d = ts + sevenDaysMs;
      }
    }
    activeReset7dMs = cycleReset7d > now ? Math.max(now + 60_000, cycleReset7d) : now + sevenDaysMs;
  }

  let cycleStart5h = 0;
  let cycleReset5h = 0;
  if (isPrimaryUltraAnchor && now >= ANCHOR_5H_MS && stepTimestamps.some((ts) => ts >= ANCHOR_5H_MS)) {
    const elapsed5hBlocks = Math.max(0, Math.floor((now - ANCHOR_5H_MS) / fiveHoursMs));
    const blockStart = ANCHOR_5H_MS + elapsed5hBlocks * fiveHoursMs;
    const hasStepInBlock = stepTimestamps.some((ts) => ts >= blockStart);
    if (hasStepInBlock) {
      cycleStart5h = blockStart;
      cycleReset5h = blockStart + fiveHoursMs;
    }
  }
  if (!cycleReset5h) {
    for (const ts of stepTimestamps) {
      if (ts >= cycleReset5h) {
        cycleStart5h = ts;
        cycleReset5h = ts + fiveHoursMs;
      }
    }
  }
  const hasActive5h = cycleReset5h > now;
  const activeCutoff5h = hasActive5h ? Math.max(cutoff5h, cycleStart5h) : now + 1;
  const activeReset5hMs = hasActive5h
    ? Math.max(now + 60_000, cycleReset5h)
    : now + fiveHoursMs;

  let unitsWeekCycle = 0;
  let claudeUnits5h = 0;
  let claudeUnitsWeek = 0;

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
    let sessPromptsToday = 0;
    let sessStepsToday = 0;
    let sessToolsToday = 0;
    let sessCostToday = 0;

    for (const st of stepList) {
      if (!st || !st.ts || st.ts < cutoff7d) continue;
      if (accountSlug !== null) {
        const stAcct = st.acct ?? s.agyAccount ?? '';
        if (stAcct !== accountSlug) continue;
      }
      const w = stepQuotaUnits5h(st);
      const tok = (Number(st.inp) || 0) + (Number(st.cr) || 0) + (Number(st.out) || 0);
      const isClaudeOrGpt = /claude|sonnet|opus|gpt/i.test(String(st.model || s.model || ''));
      units7d += w;
      proj.units7d += w;
      if (st.ts >= activeWeekStartMs) {
        if (isClaudeOrGpt) claudeUnitsWeek += w;
        else unitsWeekCycle += w;
      }
      if (!oldest7d || st.ts < oldest7d) oldest7d = st.ts;
      if (st.kind === 'prompt') prompts7d++;
      else {
        steps7d++;
        tokens7d += tok;
        cost7d += Number(st.cost) || 0;
      }

      if (st.ts >= startOfTodayMs) {
        if (st.kind === 'prompt') {
          sessPromptsToday++;
        } else {
          sessStepsToday++;
          sessCostToday += Number(st.cost) || 0;
          sessToolsToday += (Number(st.read) || 0) + (Number(st.edit) || 0) + (Number(st.cmd) || 0) + (Number(st.web) || 0);
        }
      }

      if (st.ts >= activeCutoff5h) {
        if (isClaudeOrGpt) claudeUnits5h += w;
        else units5h += w;
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
      s.usage.promptsToday = sessPromptsToday;
      s.usage.stepsToday = sessStepsToday;
      s.usage.toolsToday = sessToolsToday;
      s.usage.costToday = Math.round(sessCostToday * 100) / 100;
      const activeSubKeys = Object.keys(s.subs || {});
      const doneTodayCount = (s.doneSubs || []).filter(
        (d) => d && !activeSubKeys.includes(d.id) && (d.endedAt || d.startedAt || 0) >= startOfTodayMs,
      ).length;
      s.usage.subsToday = activeSubKeys.length + doneTodayCount;
    }
  }

  const pct = Math.min(100, units5h > 0 ? Math.max(1, Math.round(units5h)) : 0);
  // Google AI Ultra weekly budget (~3.97x the 5-hour unit scale in the active weekly cycle)
  const weekPct = Math.min(100, unitsWeekCycle > 0 ? Math.max(1, Math.round(unitsWeekCycle / 3.97)) : 0);
  const left5hPct = Math.max(0, 100 - pct);
  const leftWeekPct = Math.max(0, 100 - weekPct);
  const claudeGptPct5h = Math.min(100, claudeUnits5h > 0 ? Math.max(1, Math.round(claudeUnits5h)) : 0);
  const claudeGptLeft5hPct = Math.max(0, 100 - claudeGptPct5h);
  const claudeGptWeekPct = Math.min(100, claudeUnitsWeek > 0 ? Math.max(1, Math.round(claudeUnitsWeek / 3.97)) : 0);
  const claudeGptLeftWeekPct = Math.max(0, 100 - claudeGptWeekPct);
  const resetsAt = new Date(activeReset5hMs).toISOString();
  const weekResetsAt = new Date(activeReset7dMs).toISOString();
  const useAiCredits = readAgyUseAiCredits();

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

  const resolvedEmail = (accountEmail && String(accountEmail).includes('@'))
    ? String(accountEmail).trim()
    : detectAgyAccountEmail();

  return {
    source: 'agy',
    email: resolvedEmail,
    planName: 'Google AI Ultra',
    billingCycle: `5g: còn ${left5hPct}% · Tuần: còn ${leftWeekPct}%`,
    pct,
    left5hPct,
    resetsAt,
    weekPct,
    leftWeekPct,
    weekResetsAt,
    claudeGptPct5h,
    claudeGptLeft5hPct,
    claudeGptWeekPct,
    claudeGptLeftWeekPct,
    useAiCredits,
    prompts5h,
    steps5h,
    tokens5h,
    prompts7d,
    steps7d,
    tokens7d,
    cost7d: Math.round(cost7d * 100) / 100,
    extraEnabled: useAiCredits,
    extraPct: null,
    extraUsed: null,
    extraLimit: null,
    projects: [],
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
  isRemovedDir,
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
  const convStatCache = new Map(); // "${brain}|${convId}" -> { checkedAt, convDir, transcriptFile, st }

  function readFullStepToolCalls(convDir, stepIndex) {
    if (!convDir || stepIndex === undefined || stepIndex === null) return null;
    try {
      const fullPath = path.join(convDir, '.system_generated', 'logs', 'transcript_full.jsonl');
      if (!fs.existsSync(fullPath)) return null;
      const stat = fs.statSync(fullPath);
      const maxRead = Math.min(stat.size, 2 * 1024 * 1024);
      const fd = fs.openSync(fullPath, 'r');
      try {
        const buf = Buffer.alloc(maxRead);
        fs.readSync(fd, buf, 0, maxRead, Math.max(0, stat.size - maxRead));
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const ln = lines[i].trim();
          if (!ln || !ln.includes('"PLANNER_RESPONSE"')) continue;
          try {
            const parsed = JSON.parse(ln);
            if (parsed && parsed.step_index === stepIndex && Array.isArray(parsed.tool_calls)) {
              return parsed.tool_calls;
            }
          } catch { /* ignore */ }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* ignore */ }
    return null;
  }

  function parseStepLine(line, s, st, liveEvents, knownRoots, fallbackTs = Date.now(), convDir = '') {
    if (!line.trim()) return false;
    let j;
    try { j = JSON.parse(line); } catch { return false; }
    if (j.type === 'PLANNER_RESPONSE' && Array.isArray(j.truncated_fields) && j.truncated_fields.includes('tool_calls') && convDir) {
      const fullTools = readFullStepToolCalls(convDir, j.step_index);
      if (Array.isArray(fullTools) && fullTools.length > 0) {
        j.tool_calls = fullTools;
      }
    }
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
        s.usage ||= { cost: 0, in: 0, cr: 0, out: 0, ctx: 0, steps: 0, prompts: 0, model: s.preferredModelLabel || st.model || 'Gemini 3.1 Pro' };
        if (s.preferredModelLabel || st.model) {
          s.usage.model = s.preferredModelLabel || st.model || s.usage.model || 'Gemini 3.1 Pro';
        }
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
      const tools = Array.isArray(j.tool_calls) ? j.tool_calls.filter((t) => t?.name) : [];
      let stepRead = 0, stepEdit = 0, stepCmd = 0, stepWeb = 0;
      for (const tc of tools) {
        const normT = normalizeAgyTool(String(tc.name || ''), tc.args);
        const tk = { Read: 'read', Grep: 'read', Glob: 'read', Edit: 'edit', Write: 'edit', Bash: 'cmd', WebSearch: 'web', WebFetch: 'web' }[normT.tool_name];
        if (tk === 'read') stepRead++;
        else if (tk === 'edit') stepEdit++;
        else if (tk === 'cmd') stepCmd++;
        else if (tk === 'web') stepWeb++;
      }
      s.usage ||= { cost: 0, in: 0, cr: 0, out: 0, ctx: 0, steps: 0, prompts: 0, model: s.preferredModelLabel || st.model || 'Gemini 3.1 Pro' };
      s.usage.steps = (s.usage.steps || 0) + 1;
      if (inp || cr || out) {
        const stepCost = (inp * 1.25 + cr * 0.3 + out * 10) / 1e6;
        s.usage.in += inp + cr;
        s.usage.cr = (s.usage.cr || 0) + cr;
        s.usage.out += out;
        s.usage.ctx = inp + cr + out;
        s.usage.model = s.preferredModelLabel || st.model || s.usage.model || 'Gemini 3.1 Pro';
        s.usage.cost += stepCost;
        if (ts >= cutoff8d) {
          st.steps.push({ ts, kind: 'step', inp, cr, out, cost: stepCost, read: stepRead, edit: stepEdit, cmd: stepCmd, web: stepWeb, acct: s.agyAccount || activeAcct });
        }
        usageChanged = true;
      } else if (ts >= cutoff8d) {
        st.steps.push({ ts, kind: 'step', inp: 0, cr: 0, out: 0, cost: 0, read: stepRead, edit: stepEdit, cmd: stepCmd, web: stepWeb, acct: s.agyAccount || activeAcct });
        usageChanged = true;
      }
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
            const fbTs = ts || fallbackTs || Date.now();
            if (fbTs > (st.clearedWaitAt || 0)) {
              stepHasWait = true;
              st.lastFeedbackAt = fbTs;
              st.waitInfo = {
                kind: 'ask',
                ts: fbTs,
                questions: norm.tool_input?.questions || [],
                detail: norm.tool_input?.questions?.[0]?.question || '',
              };
              if (liveEvents) {
                liveEvents.push({
                  kind: 'wait',
                  ts: fbTs,
                  label: (st.waitInfo.detail || 'AskUserQuestion').slice(0, 60),
                });
              }
            }
          } else if (norm.requestFeedback || norm.isPlanFile) {
            const fbTs = ts || fallbackTs || Date.now();
            if (fbTs > (st.clearedWaitAt || 0)) {
              stepHasWait = true;
              st.lastFeedbackAt = fbTs;
              st.waitInfo = {
                kind: 'plan',
                ts: fbTs,
                filePath: norm.tool_input?.file_path || '',
                summary: norm.artifactSummary || '',
              };
              if (liveEvents) {
                liveEvents.push({
                  kind: 'wait',
                  ts: fbTs,
                  label: path.basename(norm.tool_input?.file_path || 'implementation_plan.md') || 'implementation_plan.md',
                });
              }
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
              capMap(subRoleByConvId, 500, 400);
            }
            const subLabel = clip(subAgent || 'Subagent', 28);
            const subDesc = clip(redact(oneLine(a.Prompt || a.Message || a.Description || '')), 70);
            const provKey = recId || `prov-${subAgent.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
            const nowInvoke = Date.now();
            const alreadyFinished = Array.isArray(s.doneSubs)
              && s.doneSubs.some((d) => d && (d.id === provKey || d.prevId === provKey) && (d.endedAt || 0) >= ts);
            if (!alreadyFinished) {
              st.pendingSubCalls = (st.pendingSubCalls || 0) + 1;
              st.lastSubInvokeAt = ts || nowInvoke;
            }
            let isNewSubStart = false;
            if (!alreadyFinished && nowInvoke - ts < 60_000) {
              s.subs ||= {};
              const promotedEntry = Object.values(s.subs).find((v) => v && !v.provisional && (v.id === provKey || v.prevId === provKey || (v.type && v.type === clip(subAgent, 24))));
              if (promotedEntry) {
                promotedEntry.seenAt = nowInvoke;
                promotedEntry.invokedAt = nowInvoke;
                if (subDesc) promotedEntry.desc = subDesc;
              } else if (!s.subs[provKey]) {
                isNewSubStart = true;
                s.subs[provKey] = {
                  id: provKey,
                  type: clip(subAgent, 24),
                  desc: subDesc,
                  last: { type: 'agent', label: subDesc || subLabel },
                  startedAt: ts || nowInvoke,
                  seenAt: nowInvoke,
                  invokedAt: nowInvoke,
                  steps: 1,
                  provisional: true,
                };
              } else {
                s.subs[provKey].seenAt = nowInvoke;
                s.subs[provKey].invokedAt = nowInvoke;
                if (subDesc) s.subs[provKey].desc = subDesc;
                if (subAgent && s.subs[provKey].type !== clip(subAgent, 24) && !/^[0-9a-f-]{8,}$/i.test(subAgent)) {
                  s.subs[provKey].type = clip(subAgent, 24);
                }
              }
            }
            if (liveEvents && isNewSubStart) {
              liveEvents.push({
                kind: 'substart',
                ts,
                agent: provKey,
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
        if (!stepHasWait && st.lastFeedbackAt > 0 && ts >= st.lastFeedbackAt) {
          st.lastFeedbackAt = 0;
          st.waitInfo = null;
          if (s) s.waitCard = null;
        }
      } else if (typeof j.content === 'string' && j.content.trim()) {
        s.lastReply = clip(redact(oneLine(j.content.trim())), 240);
        usageChanged = true;
        if ((st.pendingSubCalls || 0) > 0 && st.lastSubInvokeAt > 0 && ts - st.lastSubInvokeAt > 5 * 60_000) {
          st.pendingSubCalls = 0;
        }
        const hasActiveSubs = ((st.pendingSubCalls || 0) > 0 && Date.now() - ts < 5 * 60_000) || Object.keys(s.subs || {}).length > 0 || (s.bg && s.bg.size > 0);
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
      if (typeof j.content === 'string' && j.content.includes('You requested user feedback on this artifact')) {
        const fbTs = ts || fallbackTs || Date.now();
        if (!st.waitInfo && fbTs > (st.clearedWaitAt || 0)) {
          st.lastFeedbackAt = fbTs;
          st.waitInfo = {
            kind: 'plan',
            ts: fbTs,
            filePath: convDir ? path.join(convDir, 'implementation_plan.md') : '',
            summary: '',
          };
        }
      }
    }
    if (st.steps.length > 600 && st.steps[0]?.ts < cutoff8d) {
      let drop = 0;
      while (drop < st.steps.length && st.steps[drop].ts < cutoff8d) drop++;
      if (drop > 0) st.steps.splice(0, drop);
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
              const tools = Array.isArray(j.tool_calls) ? j.tool_calls.filter((t) => t?.name) : [];
              let stepRead = 0, stepEdit = 0, stepCmd = 0, stepWeb = 0;
              for (const tc of tools) {
                const normT = normalizeAgyTool(String(tc.name || ''), tc.args);
                const tk = { Read: 'read', Grep: 'read', Glob: 'read', Edit: 'edit', Write: 'edit', Bash: 'cmd', WebSearch: 'web', WebFetch: 'web' }[normT.tool_name];
                if (tk === 'read') stepRead++;
                else if (tk === 'edit') stepEdit++;
                else if (tk === 'cmd') stepCmd++;
                else if (tk === 'web') stepWeb++;
              }
              if (ts >= cutoff8d) {
                const entry = { ts, kind: 'step', inp, cr, out, cost: stepCost, read: stepRead, edit: stepEdit, cmd: stepCmd, web: stepWeb, subId: subCand.convId, acct: subAcct };
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
              if (tools.length > 0) {
                const tc = tools[tools.length - 1];
                const norm = normalizeAgyTool(tc.name, tc.args);
                subSt.lastTool = norm;
                newTool = norm;
                newToolTs = ts;
              }
            }
          }
          if (subSt.steps.length > 300 && subSt.steps[0]?.ts < cutoff8d) {
            let drop = 0;
            while (drop < subSt.steps.length && subSt.steps[drop].ts < cutoff8d) drop++;
            if (drop > 0) subSt.steps.splice(0, drop);
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
      const prevSub = parentSession.subs[subCand.convId];
      const wasRunning = !!prevSub;
      const nowSubMs = Date.now();
      const recentlyInvoked = Boolean(
        prevSub && (
          (prevSub.provisional && nowSubMs - (prevSub.seenAt || 0) < 45_000) ||
          (prevSub.invokedAt && nowSubMs - prevSub.invokedAt < 45_000)
        )
      );
      const parentStForSub = states.get(meta.parentId);
      const isParentForceStopped = Boolean(parentStForSub?.stoppedAtMtime && subCand.st.mtimeMs <= parentStForSub.stoppedAtMtime + 500);
      const isRunning = !isParentForceStopped && (
        meta.status === 'CASCADE_RUN_STATUS_RUNNING'
        || meta.notFullyIdle
        || (nowSubMs - subCand.st.mtimeMs < 30_000)
        || recentlyInvoked
      );
      if (meta.agentName || meta.title) {
        const cleanRole = formatSubagentRole(meta.agentName || meta.title) || meta.agentName || meta.title;
        subRoleByConvId.set(subCand.convId, { role: cleanRole, typeName: meta.agentName || meta.title });
        capMap(subRoleByConvId, 500, 400);
      }
      const savedRole = subRoleByConvId.get(subCand.convId);
      const rawSubName = savedRole?.role || meta.agentName || meta.title || `sub-${subCand.convId.slice(0, 4)}`;
      const subName = formatSubagentRole(rawSubName) || rawSubName;
      const subLabel = clip(subName, 24);
      const subDesc = clip(meta.title || subSt.promptDesc || prevSub?.desc || subName, 70);
      if (isRunning) {
        let matchedProvId = prevSub?.prevId || null;
        let matchedProvSub = null;
        if (!wasRunning || prevSub?.provisional) {
          for (const [k, v] of Object.entries(parentSession.subs)) {
            if (k !== subCand.convId && v?.provisional && v.type === subLabel) {
              matchedProvId = k;
              matchedProvSub = v;
              break;
            }
          }
          if (!matchedProvId) {
            for (const [k, v] of Object.entries(parentSession.subs)) {
              if (k !== subCand.convId && v?.provisional) {
                matchedProvId = k;
                matchedProvSub = v;
                break;
              }
            }
          }
          if (matchedProvId && matchedProvId !== subCand.convId && parentSession.subs[matchedProvId]?.provisional) {
            delete parentSession.subs[matchedProvId];
          }
        } else {
          for (const [k, v] of Object.entries(parentSession.subs)) {
            if (v?.provisional && v.type === subLabel && k !== subCand.convId) {
              matchedProvId = k;
              matchedProvSub = v;
              delete parentSession.subs[k];
              break;
            }
          }
        }
        const lastInfo = subSt.lastClassified
          ? { type: subSt.lastClassified.type, label: subSt.lastClassified.label }
          : (prevSub?.last || matchedProvSub?.last || { type: 'agent', label: clip(meta.title || subSt.promptDesc || 'Đang chạy tác vụ phụ', 60) });
        const keepProvisional = recentlyInvoked
          && meta.status !== 'CASCADE_RUN_STATUS_RUNNING'
          && !meta.notFullyIdle
          && (nowSubMs - subCand.st.mtimeMs >= 30_000);
        parentSession.subs[subCand.convId] = {
          id: subCand.convId,
          type: subLabel,
          desc: subDesc,
          last: lastInfo,
          startedAt: prevSub?.startedAt || matchedProvSub?.startedAt || subCand.st.birthtimeMs || subCand.st.mtimeMs,
          seenAt: Math.max(nowSubMs, subCand.st.mtimeMs || 0),
          invokedAt: prevSub?.invokedAt || matchedProvSub?.invokedAt || 0,
          ...(keepProvisional ? { provisional: true } : {}),
          steps: meta.stepCount || subSt.steps.length || 1,
          ...(matchedProvId && matchedProvId !== subCand.convId ? { prevId: matchedProvId } : {}),
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
            ...(matchedProvId ? { prevAgent: matchedProvId } : {}),
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
        parentSession.doneSubs ||= [];
        const existingIdx = parentSession.doneSubs.findIndex((d) => d && d.id === subCand.convId);
        const lastInfo = subSt.lastClassified
          ? { type: subSt.lastClassified.type, label: subSt.lastClassified.label }
          : { type: 'agent', label: clip(meta.title || subSt.promptDesc || 'Đã hoàn thành', 60) };
        const doneItem = {
          id: subCand.convId,
          type: subLabel,
          desc: subDesc,
          last: lastInfo,
          startedAt: subCand.st.birthtimeMs || subCand.st.mtimeMs,
          endedAt: subCand.st.mtimeMs,
          steps: meta.stepCount || subSt.steps.length || 1,
        };
        if (existingIdx >= 0) {
          const prev = parentSession.doneSubs[existingIdx];
          if (prev.steps !== doneItem.steps || prev.endedAt !== doneItem.endedAt || prev.type !== doneItem.type) {
            parentSession.doneSubs[existingIdx] = doneItem;
            changed = true;
          }
        } else {
          parentSession.doneSubs.push(doneItem);
          parentSession.doneSubs.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
          if (parentSession.doneSubs.length > 12) parentSession.doneSubs.length = 12;
          changed = true;
        }
      }
    }
    return changed;
  }

  async function syncConversation(convId, convDir, transcriptFile, fileStat, isPrimaryForWorkspace, workspaceIndex, dbMeta, knownRoots, hasActiveSubCandidate = false, nativeBin = null) {
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
    let resyncingTranscript = false;
    const prevLastEventAt = s.lastEventAt || 0;
    if (!st) {
      st = {
        offset: 0,
        mtimeMs: 0,
        transcriptFile,
        model: '',
        firstPrompt: '',
        lastStepType: '',
        lastStepHasTools: false,
        lastFeedbackAt: 0,
        clearedWaitAt: clearedWaits.get(convId) || 0,
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
      resyncingTranscript = true;
      st.offset = 0;
      st.mtimeMs = 0;
      st.transcriptFile = transcriptFile;
      st.clearedWaitAt = Math.max(st.clearedWaitAt || 0, clearedWaits.get(convId) || 0);
    } else {
      st.transcriptFile = transcriptFile;
      st.clearedWaitAt = Math.max(st.clearedWaitAt || 0, clearedWaits.get(convId) || 0);
    }
    if (st.lastFeedbackAt > 0 && st.lastFeedbackAt <= (st.clearedWaitAt || 0)) {
      st.lastFeedbackAt = 0;
      st.waitInfo = null;
      s.waitCard = null;
    }

    const liveEvents = [];
    let usageChanged = false;
    if (fileStat.size > st.offset) {
      const readLen = fileStat.size - st.offset;
      let handledByRust = false;
      if (!initial && nativeBin && readLen > 262_144) {
        const rustTail = await tailTranscriptWithRust(nativeBin, transcriptFile, st.offset);
        if (rustTail && rustTail.ok) {
          st.offset = Number(rustTail.nextOffset) || st.offset;
          for (const line of rustTail.lines) {
            if (parseStepLine(line, s, st, liveEvents, knownRoots, fileStat.mtimeMs, convDir)) usageChanged = true;
          }
          handledByRust = true;
        }
      }
      if (!handledByRust) {
        const fh = await fsp.open(transcriptFile, 'r');
        try {
          if (initial && fileStat.size > 12_000_000) {
            // Very large transcript (>12 MB): read 256 KB head + 4 MB tail
            const headBuf = Buffer.alloc(262144);
            await fh.read(headBuf, 0, headBuf.length, 0);
            for (const line of headBuf.toString('utf8').split(/\r?\n/)) {
              if (parseStepLine(line, s, st, null, knownRoots, fileStat.mtimeMs, convDir)) usageChanged = true;
            }
            const tailLen = 4_000_000;
            const tailBuf = Buffer.alloc(tailLen);
            await fh.read(tailBuf, 0, tailLen, fileStat.size - tailLen);
            const tailLines = tailBuf.toString('utf8').split(/\r?\n/);
            tailLines.shift();
            for (const line of tailLines) {
              if (parseStepLine(line, s, st, liveEvents, knownRoots, fileStat.mtimeMs, convDir)) usageChanged = true;
            }
          } else {
            const buf = Buffer.alloc(readLen);
            await fh.read(buf, 0, readLen, st.offset);
            const end = buf.lastIndexOf(0x0a);
            if (end >= 0) {
              st.offset += end + 1;
              const lines = buf.subarray(0, end).toString('utf8').split(/\r?\n/);
              for (const line of lines) {
                if (parseStepLine(line, s, st, liveEvents, knownRoots, fileStat.mtimeMs, convDir)) usageChanged = true;
              }
            }
          }
          if (initial) st.offset = fileStat.size;
        } finally { await fh.close(); }
      }
    }
    if (resyncingTranscript && liveEvents.length > 0) {
      const nowTs = Date.now();
      for (let idx = liveEvents.length - 1; idx >= 0; idx--) {
        const ev = liveEvents[idx];
        if ((prevLastEventAt > 0 && ev.ts <= prevLastEventAt) || nowTs - (ev.ts || 0) > 8000) {
          liveEvents.splice(idx, 1);
        }
      }
    }

    // Normalize s.cwd against known workspace roots so subfolders (e.g. e:\DemoApp\apps\backend) group under e:\DemoApp
    if (s.cwd && knownRoots.length) {
      const norm = normalizeWorkspacePath(s.cwd, knownRoots);
      if (norm && norm !== s.cwd) {
        s.cwd = norm;
        noteDir(norm);
      }
    }
    if (s.cwd && typeof isRemovedDir === 'function' && isRemovedDir(s.cwd)) {
      states.delete(convId);
      dropSession(key, s);
      return false;
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
        s.autoTitle = clip(redact(oneLine(dbMeta.title)), 75);
        s.title = s.customTitle || s.autoTitle;
      } else if (initial || !s.title || (taskStat && taskStat.mtimeMs !== st.titleMtime)) {
        st.titleMtime = taskStat?.mtimeMs || 0;
        const artTitle = await readArtifactTitle(convDir);
        const fallbackTitle = st.firstPrompt
          ? st.firstPrompt.replace(/https?:\/\/\S+/g, '').trim() || st.firstPrompt
          : '';
        const title = artTitle || clip(fallbackTitle, 75);
        if (title) {
          s.autoTitle = title;
          s.title = s.customTitle || s.autoTitle;
        }
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

    if (st.stoppedAtMtime && fileStat.mtimeMs > st.stoppedAtMtime + 500) {
      st.stoppedAtMtime = 0;
    }
    const isForceStopped = Boolean(st.stoppedAtMtime && fileStat.mtimeMs <= st.stoppedAtMtime + 500);
    if (isForceStopped) {
      s.subs = {};
      st.pendingSubCalls = 0;
      st.deferredStopLabel = null;
      st.deferredStopAt = 0;
    }

    // Determine live status ('work', 'wait', 'rest') combining DB status, subagent activity, and transcript freshness
    const ageMs = Date.now() - Math.max(fileStat.mtimeMs, s.lastEventAt || 0);
    const dbRunning = !isForceStopped && dbMeta && (dbMeta.status === 'CASCADE_RUN_STATUS_RUNNING' || dbMeta.notFullyIdle) && ageMs < 5 * 60_000;
    const hasWaitInfo = !isForceStopped && Boolean(st.waitInfo && (st.waitInfo.kind === 'ask' || st.waitInfo.kind === 'plan'));
    const waitingFeedback = !isForceStopped
      && st.lastFeedbackAt > 0
      && st.lastFeedbackAt > (st.clearedWaitAt || 0)
      && Date.now() - st.lastFeedbackAt < 12 * 3600_000
      && (
        (hasWaitInfo && (st.lastStepType === 'PLANNER_RESPONSE' || st.lastStepType === 'GENERIC'))
        || (st.lastStepType === 'PLANNER_RESPONSE' && !st.lastStepHasTools && !dbRunning)
      );
    const activeTurn = !isForceStopped && (dbRunning || ((st.lastStepType === 'USER_INPUT' || st.lastStepType === 'GENERIC' || st.lastStepHasTools) && ageMs < 90_000));
    const hasRunningSubs = !isForceStopped && Boolean(hasActiveSubCandidate || Object.keys(s.subs || {}).length > 0 || (st.pendingSubCalls || 0) > 0);

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
        const stopTs = Math.max(st.lastSubStopAt || 0, st.deferredStopAt || 0, s.lastEventAt || 0, fileStat.mtimeMs || 0);
        st.deferredStopLabel = null;
        st.deferredStopAt = 0;
        s.status = 'rest';
        s.busy = false;
        s.inTool = false;
        s.waitCard = null;
        s.doneAt = initial ? (stopTs || Date.now()) : Date.now();
        if (!initial && !hookActive) {
          liveEvents.push({ kind: 'stop', ts: Date.now(), label: stopLabel });
        }
      }
    } else {
      s.status = 'rest';
      s.busy = false;
      s.inTool = false;
      s.waitCard = null;
      if (!s.doneAt) s.doneAt = s.lastEventAt || fileStat.mtimeMs || 0;
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
            pushFeed({ id: nextSeq(), ts: ev.ts, sess: s.id, name: s.name, type: 'substart', agent: ev.agent, label: ev.label, ...(ev.desc ? { desc: ev.desc } : {}), ...(ev.prevAgent ? { prevAgent: ev.prevAgent } : {}) });
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
            ...(ev.prevAgent ? { prevAgent: ev.prevAgent } : {}),
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
    const isCustomEnv = Boolean(process.env.OFFICE_AGY_BRAIN_DIR);
    const nativeBin = !isCustomEnv ? findNativeRustBin() : null;
    let candidates = nativeBin ? await scanBrainWithRust(nativeBin, brainDirs) : null;
    if (!candidates) {
      const byConvId = new Map();
      const scanNow = Date.now();
      for (const brain of brainDirs) {
        let entries = [];
        try { entries = await fsp.readdir(brain, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
          const convDir = path.join(brain, ent.name);
          const transcriptFile = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
          const cacheKey = `${brain}|${ent.name}`;
          const cached = !isCustomEnv ? convStatCache.get(cacheKey) : null;
          try {
            let st;
            if (cached && (scanNow - cached.st.mtimeMs > 3600_000) && (scanNow - cached.checkedAt < 15_000)) {
              st = cached.st;
            } else {
              st = await fsp.stat(transcriptFile);
              if (!isCustomEnv && st.isFile() && st.size > 0) {
                convStatCache.set(cacheKey, { checkedAt: scanNow, convDir, transcriptFile, st });
              }
            }
            if (st.isFile() && st.size > 0) {
              const prev = byConvId.get(ent.name);
              if (!prev || st.mtimeMs > prev.st.mtimeMs || (st.mtimeMs === prev.st.mtimeMs && st.size > prev.st.size)) {
                byConvId.set(ent.name, { convId: ent.name, convDir, transcriptFile, st });
              }
            }
          } catch { /* no transcript */ }
        }
      }
      candidates = [...byConvId.values()];
      candidates.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      if (convStatCache.size > 500) {
        for (const [k, v] of convStatCache) {
          if (scanNow - v.checkedAt > 10 * 60_000) convStatCache.delete(k);
        }
        capMap(convStatCache, 500, 400);
      }
    }
    if (!candidates.length) return;

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
      if (meta?.workspace && typeof isRemovedDir === 'function' && isRemovedDir(meta.workspace)) {
        continue;
      }
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
        nativeBin,
      ).catch((err) => {
        console.error('agy sync', err);
        return false;
      });
      if (sessions.has(key)) {
        const sRef = sessions.get(key);
        if (sRef) sRef.missedScans = 0;
        liveKeys.add(key);
        countByWorkspace.set(wsKey, wsIdx + 1);
      }
      if (changed) anyUsageChanged = true;
    }

    // Sync subagents and attach their token/step usage + active status to their parent conversation
    const touchedParents = new Set();
    for (const sub of subCandidates) {
      if (now - sub.st.mtimeMs > 14 * 86400_000) continue;
      const parentKey = 'a' + sub.meta.parentId;
      const parentSession = sessions.get(parentKey);
      const subChanged = await syncSubagent(sub, sub.meta, parentSession).catch(() => false);
      if (subChanged) {
        anyUsageChanged = true;
        if (parentSession) touchedParents.add(parentSession);
      }
    }

    for (const [key, s] of sessions) {
      if (s.isAgy && s.fromFile && !liveKeys.has(key)) {
        const explicitlyRemoved = deletedConvIds.has(s.sid)
          || (s.cwd && typeof isRemovedDir === 'function' && isRemovedDir(s.cwd));
        if (!explicitlyRemoved) {
          s.missedScans = (s.missedScans || 0) + 1;
          if (s.missedScans < 3) continue;
        }
        states.delete(s.sid);
        for (const [subId, subSt] of subStates) {
          if (subSt.parentId === s.sid) subStates.delete(subId);
        }
        dropSession(key, s);
        anyUsageChanged = true;
      }
    }
    capMap(subStates, 300, 220);

    // Sync today's per-session and global stats so the Activity KPI strip is always accurate after startup/scan
    const startOfTodayMs = new Date(now).setHours(0, 0, 0, 0);
    let todayRead = 0, todayEdit = 0, todayCmd = 0, todayWeb = 0;
    let todayPrompts = 0, todaySteps = 0, todaySubs = 0, todayCost = 0;
    for (const s of sessions.values()) {
      if (!s.isAgy) continue;
      let sPromptsToday = 0, sStepsToday = 0, sToolsToday = 0, sCostToday = 0;
      let sRead = 0, sEdit = 0, sCmd = 0, sWeb = 0;
      for (const st of s.agySteps || []) {
        if (!st || !st.ts || st.ts < startOfTodayMs) continue;
        if (st.kind === 'prompt') {
          sPromptsToday++;
        } else {
          sStepsToday++;
          sCostToday += Number(st.cost) || 0;
          const r = Number(st.read) || 0;
          const e = Number(st.edit) || 0;
          const c = Number(st.cmd) || 0;
          const w = Number(st.web) || 0;
          sRead += r; sEdit += e; sCmd += c; sWeb += w;
          sToolsToday += r + e + c + w;
        }
      }
      const activeSubIds = Object.keys(s.subs || {});
      const doneTodayCount = (s.doneSubs || []).filter(
        (d) => d && !activeSubIds.includes(d.id) && (d.endedAt || d.startedAt || 0) >= startOfTodayMs,
      ).length;
      const sSubsToday = activeSubIds.length + doneTodayCount;
      todayRead += sRead;
      todayEdit += sEdit;
      todayCmd += sCmd;
      todayWeb += sWeb;
      todayPrompts += sPromptsToday;
      todaySteps += sStepsToday;
      todaySubs += sSubsToday;
      todayCost += sCostToday;
      if (s.usage) {
        const roundedCost = Math.round(sCostToday * 100) / 100;
        if (
          s.usage.promptsToday !== sPromptsToday
          || s.usage.stepsToday !== sStepsToday
          || s.usage.toolsToday !== sToolsToday
          || s.usage.costToday !== roundedCost
          || s.usage.subsToday !== sSubsToday
        ) {
          s.usage.promptsToday = sPromptsToday;
          s.usage.stepsToday = sStepsToday;
          s.usage.toolsToday = sToolsToday;
          s.usage.costToday = roundedCost;
          s.usage.subsToday = sSubsToday;
          touchedParents.add(s);
        }
      }
    }
    rollDay?.();
    const statsObj = typeof getStats === 'function' ? getStats() : null;
    let statsChanged = false;
    if (statsObj) {
      const nextRead = Math.max(statsObj.read || 0, todayRead);
      const nextEdit = Math.max(statsObj.edit || 0, todayEdit);
      const nextCmd = Math.max(statsObj.cmd || 0, todayCmd);
      const nextWeb = Math.max(statsObj.web || 0, todayWeb);
      const nextPrompts = Math.max(statsObj.prompts || 0, todayPrompts);
      const nextSteps = Math.max(statsObj.steps || 0, todaySteps);
      const nextSubs = Math.max(statsObj.subs || 0, todaySubs);
      const nextCost = Math.round(Math.max(statsObj.cost || 0, todayCost) * 100) / 100;
      if (
        statsObj.read !== nextRead
        || statsObj.edit !== nextEdit
        || statsObj.cmd !== nextCmd
        || statsObj.web !== nextWeb
        || statsObj.prompts !== nextPrompts
        || statsObj.steps !== nextSteps
        || statsObj.subs !== nextSubs
        || statsObj.cost !== nextCost
      ) {
        statsObj.read = nextRead;
        statsObj.edit = nextEdit;
        statsObj.cmd = nextCmd;
        statsObj.web = nextWeb;
        statsObj.prompts = nextPrompts;
        statsObj.steps = nextSteps;
        statsObj.subs = nextSubs;
        statsObj.cost = nextCost;
        statsChanged = true;
      }
    }
    for (const pSess of touchedParents) {
      broadcast({ k: 'sess', s: pub(pSess), ...(statsObj ? { stats: statsObj } : {}) });
    }
    if (statsChanged && touchedParents.size === 0 && statsObj) {
      broadcast({ k: 'stats', stats: statsObj });
    }

    if (anyUsageChanged && typeof onUsageChange === 'function') {
      onUsageChange();
    }
  }

  function clearWait(convId) {
    if (!convId) return;
    const now = Date.now();
    const cleanId = String(convId).replace(/^(?:agy:|a)/, '');
    if (cleanId) {
      clearedWaits.set(cleanId, now);
      saveClearedWaits();
    }
    for (const id of new Set([String(convId), cleanId])) {
      const st = states.get(id);
      if (st) {
        st.clearedWaitAt = now;
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
        if (s.status === 'wait') {
          s.status = 'work';
          s.act = '';
        }
      }
    }
  }

  function stopSession(convId) {
    if (!convId) return false;
    const cleanId = String(convId).replace(/^(?:agy:|a)/, '');
    clearWait(cleanId);
    for (const id of new Set([String(convId), cleanId])) {
      const st = states.get(id);
      if (st) {
        st.stoppedAtMtime = Math.max(st.mtimeMs || 0, Date.now());
        st.pendingSubCalls = 0;
        st.deferredStopLabel = null;
        st.deferredStopAt = 0;
        st.waitInfo = null;
        st.lastFeedbackAt = 0;
      }
      const sKey = sidToKey?.get(id);
      const s = (sKey && sessions.get(sKey))
        || sessions.get('a' + id)
        || sessions.get('agy:' + id)
        || [...sessions.values()].find((x) => x.sid === id || x.id === id);
      if (s) {
        s.waitCard = null;
        s.busy = false;
        s.inTool = false;
        s.status = 'rest';
        s.subs = {};
        s.doneAt = Date.now();
      }
    }
    return true;
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

  return { scan, clearWait, stopSession, deleteSession };
}

export { createAntigravityWatcher as startAntigravityWatcher };

