// "Giao việc": giving Antigravity / Claude work from the office, on a phone or over Tailscale too.
// Supports both Antigravity's native `language_server agentapi` CLI (`new-conversation` / `send-message`)
// and `claude -p --output-format stream-json`.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DATA_DIR = process.env.OFFICE_DATA_DIR ? path.resolve(process.env.OFFICE_DATA_DIR) : path.join(ROOT, 'data');
export const MAX_TEXT = 200_000, MAX_CLI_INLINE_PROMPT = 12_000, MAX_IMAGES = 20, MAX_IMAGE = 12_000_000;
const IMG_KEEP_MS = 7 * 86400_000; // 7 days retention for task images & prompt files
const projectIdByDir = new Map();
const projectIdBySid = new Map();

export function requestHostBridgeWakeup(dataDir = DEFAULT_DATA_DIR, reason = 'task-dispatch') {
  const targetDataDir = dataDir ? path.resolve(dataDir) : DEFAULT_DATA_DIR;
  try {
    fs.mkdirSync(targetDataDir, { recursive: true });
    const stopFlag = path.join(targetDataDir, '.bridge-stopped');
    if (fs.existsSync(stopFlag)) {
      try { fs.unlinkSync(stopFlag); } catch { /* ignore */ }
    }
    const wakeupFile = path.join(targetDataDir, 'bridge-wakeup.json');
    fs.writeFileSync(wakeupFile, JSON.stringify({
      requestedAt: Date.now(),
      reason: String(reason || 'task-dispatch'),
      pid: process.pid,
    }));
  } catch { /* ignore */ }

  if (process.platform === 'win32') {
    try {
      const bridgeScript = path.join(ROOT, 'server', 'host-bridge.mjs');
      if (fs.existsSync(bridgeScript)) {
        const child = spawn(process.execPath, [bridgeScript, '--on-demand'], {
          cwd: ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      }
    } catch { /* ignore */ }
  }
}

async function probeBridgeHealth(bridgeBase, headers = {}, timeoutMs = 900) {
  const urls = Array.isArray(bridgeBase)
    ? bridgeBase.map((u) => String(u || '').replace(/\/+$/, '')).filter(Boolean)
    : [String(bridgeBase || process.env.OFFICE_HOST_BRIDGE || 'http://host.docker.internal:4311').replace(/\/+$/, '')];
  for (const baseUrl of urls) {
    try {
      const res = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return baseUrl;
    } catch { /* try next */ }
  }
  return null;
}

export async function ensureHostBridgeReady(bridgeBase, headers = {}, timeoutMs = 6500, dataDir = DEFAULT_DATA_DIR) {
  const initialHit = await probeBridgeHealth(bridgeBase, headers, 900);
  if (initialHit) return true;

  requestHostBridgeWakeup(dataDir, 'task-dispatch');

  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 6500);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 220));
    const hit = await probeBridgeHealth(bridgeBase, headers, 900);
    if (hit) return true;
  }
  return false;
}

export async function dispatchViaHostBridge({
  bridgeBase,
  candidateUrls,
  headers = {},
  payload = {},
  signal,
  timeoutMs = 6500,
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const urls = Array.isArray(candidateUrls) && candidateUrls.length
    ? candidateUrls
    : [String(bridgeBase || process.env.OFFICE_HOST_BRIDGE || 'http://host.docker.internal:4311').replace(/\/+$/, '')];
  await ensureHostBridgeReady(urls, headers, timeoutMs, dataDir);
  let res = null;
  let activeUrl = urls[0];
  let lastErr = null;
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    if (attempt > 0) {
      await ensureHostBridgeReady(urls, headers, 3200, dataDir);
    }
    for (const baseUrl of urls) {
      try {
        const candidateRes = await fetch(`${baseUrl}/task/start`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal,
        });
        if (candidateRes.ok && candidateRes.body) {
          res = candidateRes;
          activeUrl = baseUrl;
          break;
        }
        lastErr = new Error(`Host bridge HTTP ${candidateRes.status}`);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  if (!res || !res.body) {
    throw lastErr || new Error('Không kết nối được Host Bridge (cổng 4311)');
  }
  return { res, bridgeUrl: activeUrl };
}

export async function stopViaHostBridge(sessionKeyOrOpts = {}, { bridgeBase, headers = {} } = {}) {
  const payload = typeof sessionKeyOrOpts === 'string'
    ? { id: sessionKeyOrOpts, sid: sessionKeyOrOpts, dir: '' }
    : {
        id: String(sessionKeyOrOpts?.id || ''),
        sid: String(sessionKeyOrOpts?.sid || ''),
        dir: String(sessionKeyOrOpts?.dir || ''),
      };
  const targetBase = bridgeBase || process.env.OFFICE_HOST_BRIDGE || 'http://host.docker.internal:4311';
  // Do NOT wake up the Host Bridge if it is already stopped (no tasks are running when bridge is off)
  const healthyUrl = await probeBridgeHealth(targetBase, headers, 700);
  if (!healthyUrl) return { ok: true, stopped: 0, bridgeSleeping: true };
  try {
    const res = await fetch(`${healthyUrl}/task/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      return { ok: true, stopped: Number(j?.stopped) || 0 };
    }
  } catch { /* ignore bridge error */ }
  return { ok: false, stopped: 0 };
}

function setBounded(map, key, val, max = 300) {
  if (!key || !val) return;
  if (map.size >= max && !map.has(key)) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, val);
}

function normDirKey(p = '') {
  const s = String(p || '').trim().replace(/^file:\/\/\/?/i, '').replace(/[\\/]+$/, '');
  if (!s) return '';
  return (process.platform === 'win32' || /^[A-Za-z]:[\\/]/.test(s)) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

export function resolveContainerDir(p = '') {
  const s = String(p || '').trim();
  if (!s) return '';
  if (fs.existsSync(s)) return s;
  if (process.platform !== 'win32') {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
    if (m) {
      const mounted = path.posix.join('/mnt', m[1].toLowerCase(), m[2].replace(/\\/g, '/'));
      if (fs.existsSync(mounted)) return mounted;
    }
  }
  return s;
}

function lookupProjectIdFromConfigProjects(targetDir) {
  const key = normDirKey(targetDir);
  if (!key) return '';
  if (projectIdByDir.has(key)) return projectIdByDir.get(key);
  try {
    const projDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
    if (!fs.existsSync(projDir)) return '';
    for (const f of fs.readdirSync(projDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(projDir, f), 'utf8'));
        const pid = String(j?.id || '').trim();
        const resList = Array.isArray(j?.projectResources?.resources) ? j.projectResources.resources : [];
        for (const r of resList) {
          let uri = String(r?.folderUri || r?.gitFolder?.folderUri || '').trim();
          if (!uri) continue;
          uri = uri.replace(/^file:\/\/\/?/i, '');
          try { uri = decodeURIComponent(uri); } catch { /* keep raw */ }
          const dKey = normDirKey(uri);
          if (pid && dKey) setBounded(projectIdByDir, dKey, pid);
        }
      } catch { /* ignore */ }
    }
    return projectIdByDir.get(key) || '';
  } catch {
    return '';
  }
}

function lookupProjectIdFromSummariesProto(targetDir) {
  const key = normDirKey(targetDir);
  if (!key) return '';
  const fromCfg = lookupProjectIdFromConfigProjects(targetDir);
  if (fromCfg) return fromCfg;
  if (projectIdByDir.has(key)) return projectIdByDir.get(key);
  try {
    const pbPaths = [
      path.join(os.homedir(), '.gemini', 'antigravity', 'agyhub_summaries_proto.pb'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'jetbox_summaries_proto.pb'),
    ];
    for (const pbPath of pbPaths) {
      if (!fs.existsSync(pbPath)) continue;
      const text = fs.readFileSync(pbPath).toString('latin1');
      const re = /file:\/\/\/([A-Za-z0-9%._~:/-]+)[\s\S]{1,40}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
      let m;
      while ((m = re.exec(text)) !== null) {
        let decoded = m[1];
        try { decoded = decodeURIComponent(m[1]); } catch { /* keep raw */ }
        const dKey = normDirKey(decoded);
        if (dKey) setBounded(projectIdByDir, dKey, m[2]);
      }
    }
    return projectIdByDir.get(key) || '';
  } catch {
    return '';
  }
}

function syncDesktopConversationToCli(sid) {
  if (!sid || !/^[0-9a-f-]{36}$/i.test(sid)) return;
  try {
    const home = os.homedir();
    const srcDb = path.join(home, '.gemini', 'antigravity', 'conversations', `${sid}.db`);
    const dstDir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    const dstDb = path.join(dstDir, `${sid}.db`);
    if (!fs.existsSync(srcDb)) return;
    // Never overwrite CLI DB while CLI is actively holding a WAL lock on it
    if (fs.existsSync(`${dstDb}-wal`) || fs.existsSync(`${dstDb}-shm`)) return;
    const srcStat = fs.statSync(srcDb);
    const dstStat = fs.existsSync(dstDb) ? fs.statSync(dstDb) : null;
    if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcDb, dstDb);
      if (fs.existsSync(`${srcDb}-wal`)) {
        fs.copyFileSync(`${srcDb}-wal`, `${dstDb}-wal`);
      } else {
        try { fs.rmSync(`${dstDb}-wal`, { force: true }); } catch { /* ignore */ }
        try { fs.rmSync(`${dstDb}-shm`, { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* best effort */ }
}

function syncCliConversationToDesktop(sid) {
  if (!sid || !/^[0-9a-f-]{36}$/i.test(sid)) return;
  try {
    const home = os.homedir();
    const srcDb = path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${sid}.db`);
    const dstDir = path.join(home, '.gemini', 'antigravity', 'conversations');
    const dstDb = path.join(dstDir, `${sid}.db`);
    if (!fs.existsSync(srcDb)) return;
    // CRITICAL: Never overwrite an existing Desktop IDE conversation DB or WAL-locked DB!
    // Overwriting an open SQLite DB on disk while the Desktop IDE (`language_server`) holds a WAL/SHM map
    // corrupts its in-memory WAL index and freezes the Desktop IDE. Only seed if the file does not exist yet.
    if (fs.existsSync(dstDb) || fs.existsSync(`${dstDb}-wal`) || fs.existsSync(`${dstDb}-shm`)) return;
    fs.mkdirSync(dstDir, { recursive: true });
    fs.copyFileSync(srcDb, dstDb);
  } catch { /* best effort */ }
}

function resolveAgyProjectId(_binFile, dir, sid) {
  if (sid && projectIdBySid.has(sid)) return projectIdBySid.get(sid);
  const pid = lookupProjectIdFromSummariesProto(dir);
  if (pid && sid) setBounded(projectIdBySid, sid, pid);
  return pid;
}

function cleanAgyError(errStr = '') {
  const s = String(errStr || '').trim();
  if (!s) return '';
  const m = /desc\s*=\s*(.+)$/i.exec(s);
  return (m ? m[1] : s).replace(/\\"/g, '"').trim();
}

/** claude() -> { file, kind? } | null; env() -> the environment to run with; onStart(task), onDone(task) for the office. */
export function createTasks({ dataDir, claude, env, onStart, onDone, max = Number(process.env.OFFICE_MAX_CONCURRENT_TASKS) || 12, perHour = Number(process.env.OFFICE_TASKS_PER_HOUR) || 100 }) {
  const running = new Map(), finished = new Map(), recent = [];   // id -> task; when the last ones started (the hourly cap)
  const IMG_DIR = path.join(dataDir, 'task-images');
  const PROMPT_DIR = path.join(dataDir, 'task-prompts');
  function bridgeHeaders() {
    let token = '';
    try { token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim(); } catch { /* ignore */ }
    return token
      ? { 'Content-Type': 'application/json', 'X-Bridge-Token': token }
      : { 'Content-Type': 'application/json' };
  }
  function getStatus({ id = '', sid = '', dir = '' } = {}) {
    const cleanSid = String(sid || '').replace(/^(?:agy:|a)/, '');
    const matchDir = normDirKey(dir);
    for (const r of running.values()) {
      const hitId = Boolean(id && (r.id === id || r.bridgeId === id));
      const hitSid = Boolean(cleanSid && (r.sid === cleanSid || r.from?.sid === cleanSid));
      const hitDir = Boolean(!id && !cleanSid && matchDir && normDirKey(r.dir) === matchDir);
      if (hitId || hitSid || hitDir) {
        return { ok: true, running: true, id: r.id, sid: r.sid || r.from?.sid || null };
      }
    }
    if (id && finished.has(id)) {
      const f = finished.get(id);
      return { ok: true, running: false, id: f.id, sid: f.sid || null, result: f.result || '', error: f.error || '' };
    }
    if (cleanSid) {
      for (const f of [...finished.values()].reverse()) {
        if (f.sid === cleanSid) {
          return { ok: true, running: false, id: f.id, sid: f.sid, result: f.result || '', error: f.error || '' };
        }
      }
    }
    return { ok: true, running: false };
  }
  function pruneTaskImages() {
    const now = Date.now();
    for (const dirPath of [IMG_DIR, PROMPT_DIR]) {
      try {
        if (!fs.existsSync(dirPath)) continue;
        for (const name of fs.readdirSync(dirPath)) {
          const full = path.join(dirPath, name);
          try {
            const st = fs.statSync(full);
            if (st.isFile() && now - st.mtimeMs > IMG_KEEP_MS) fs.rmSync(full, { force: true });
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }
  pruneTaskImages();
  setInterval(pruneTaskImages, 6 * 3600_000).unref();
  const pub = (t) => ({ id: t.id, dir: t.dir, text: t.text.slice(0, 200), at: t.at, from: t.from || null, sid: t.sid || null, by: t.by || null, model: t.model || null });
  /** { dir, text, images: [data URLs], from: { sid, name, fork } | null, by: { name, role } | null, model?: string, account?: string } -> { ok, task } or { ok: false, code } */
  function start({ dir, text, images = [], from = null, by = null, model = null, account = null }) {
    text = String(text || '').trim().slice(0, MAX_TEXT);
    if (!text) return { ok: false, code: 'empty' };
    if (running.size >= max) return { ok: false, code: 'busy' };
    const now = Date.now(); while (recent.length && now - recent[0] > 3600e3) recent.shift();
    if (recent.length >= perHour) return { ok: false, code: 'tooMany' };
    const bin = claude(); if (!bin) return { ok: false, code: 'noClaude' };
    const localDir = resolveContainerDir(dir);
    if (!dir || !fs.existsSync(localDir)) return { ok: false, code: 'noDir' };
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, files = [];
    const chosenModel = model ? String(model).trim() : null;

    if (bin.kind === 'docker-bridge') {
      const primaryUrl = String(bin.url || process.env.OFFICE_HOST_BRIDGE || 'http://host.docker.internal:4311').replace(/\/+$/, '');
      const extraBridgeUrls = [];
      try {
        const netInfo = JSON.parse(fs.readFileSync(path.join(dataDir, 'host-net.json'), 'utf8'));
        if (netInfo?.wifiIp) extraBridgeUrls.push(`http://${netInfo.wifiIp}:4311`);
        if (netInfo?.tsIp) extraBridgeUrls.push(`http://${netInfo.tsIp}:4311`);
      } catch { /* ignore */ }
      const candidateUrls = [...new Set([
        primaryUrl,
        'http://host.docker.internal:4311',
        'http://192.168.65.254:4311',
        ...extraBridgeUrls,
        'http://172.17.0.1:4311',
        'http://172.22.0.1:4311',
      ])];
      const ac = new AbortController();
      const t = { id, pid: 0, proc: { kill: () => ac.abort() }, bridgeId: null, bridgeUrl: primaryUrl, dir, text, at: now, from, by, model: chosenModel, account, sid: from?.sid || null, result: '', error: '', buf: '', isAgyCli: true };
      running.set(id, t); recent.push(now);
      (async () => {
        let gotDoneEvent = false;
        try {
          const { res, bridgeUrl } = await dispatchViaHostBridge({
            bridgeBase: primaryUrl,
            candidateUrls,
            headers: bridgeHeaders(),
            payload: { dir, text, images: images.slice(0, MAX_IMAGES), from, by, model: chosenModel, account },
            signal: ac.signal,
            timeoutMs: 6500,
            dataDir,
          });
          t.bridgeUrl = bridgeUrl;
          const dec = new TextDecoder();
          for await (const chunk of res.body) {
            t.buf += dec.decode(chunk, { stream: true });
            let nl;
            while ((nl = t.buf.indexOf('\n')) >= 0) {
              const line = t.buf.slice(0, nl).trim(); t.buf = t.buf.slice(nl + 1);
              if (!line) continue;
              try {
                const j = JSON.parse(line);
                if (j.event === 'queued' && j.task?.id) t.bridgeId = j.task.id;
                if (j.sid) t.sid = j.sid;
                if (j.event === 'error') {
                  t.error = j.code || 'error';
                  gotDoneEvent = true;
                }
                if (j.event === 'done') {
                  gotDoneEvent = true;
                  if (j.sid) t.sid = j.sid;
                  if (j.result) t.result = j.result;
                  if (j.error) t.error = j.error;
                }
              } catch { /* ignore */ }
            }
          }
        } catch (err) {
          if (!ac.signal.aborted && !t.bridgeId && !t.sid) {
            const rawErr = String(err?.message || err).trim();
            t.error = /^fetch failed$/i.test(rawErr)
              ? 'Không kết nối được Host Bridge (cổng 4311 trên máy chủ Windows). Hãy kiểm tra tiến trình server/host-bridge.mjs.'
              : rawErr.slice(0, 240);
          }
        }
        // If the NDJSON stream between Docker and Host Bridge dropped mid-task (e.g. network change or idle socket timeout),
        // keep polling Host Bridge `/task/status` until the actual Windows CLI process finishes!
        if (!gotDoneEvent && !ac.signal.aborted && !t.error && (t.bridgeId || t.sid || dir)) {
          const pollDeadline = Date.now() + 4 * 3600_000;
          let consecutivePollErrors = 0;
          while (!ac.signal.aborted && Date.now() < pollDeadline) {
            await new Promise((r) => setTimeout(r, 2500));
            if (ac.signal.aborted) break;
            const qs = `id=${encodeURIComponent(t.bridgeId || '')}&sid=${encodeURIComponent(t.sid || from?.sid || '')}&dir=${encodeURIComponent(dir || '')}`;
            const urlsToTry = [...new Set([t.bridgeUrl, ...candidateUrls].filter(Boolean))];
            let statusRes = null;
            for (const u of urlsToTry) {
              try {
                const r = await fetch(`${u}/task/status?${qs}`, {
                  headers: bridgeHeaders(),
                  signal: AbortSignal.timeout(4000),
                });
                if (r.ok) {
                  statusRes = await r.json();
                  t.bridgeUrl = u;
                  break;
                }
              } catch { /* try next candidate url */ }
            }
            if (!statusRes) {
              consecutivePollErrors++;
              if (consecutivePollErrors > 24) break; // ~60s completely unreachable
              continue;
            }
            consecutivePollErrors = 0;
            if (statusRes.sid && !t.sid) t.sid = statusRes.sid;
            if (!statusRes.running) {
              if (statusRes.result && !t.result) t.result = statusRes.result;
              if (statusRes.error && !t.error) t.error = statusRes.error;
              break;
            }
          }
        }
        running.delete(id);
        setBounded(finished, id, { id, sid: t.sid, dir: t.dir, result: t.result, error: t.error, doneAt: Date.now() }, 200);
        if (!t.error && !t.result) {
          t.result = `Đã gửi yêu cầu công việc tới Antigravity CLI (${String(dir).split(/[\\/]/).pop()}).`;
        }
        onDone?.(t);
      })();
      onStart?.(t);
      return { ok: true, task: pub(t) };
    }

    for (const [i, rawImg] of images.slice(0, MAX_IMAGES).entries()) {
      const d = typeof rawImg === 'string' ? rawImg : String(rawImg?.dataUrl || rawImg?.url || '');
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(d || ''));
      if (!m || d.length > MAX_IMAGE) continue;
      fs.mkdirSync(IMG_DIR, { recursive: true });
      const f = path.join(IMG_DIR, `${id}-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(f, Buffer.from(m[2], 'base64'), { mode: 0o600 }); files.push(f);
    }
    let effectiveText = text;
    if (text.length > MAX_CLI_INLINE_PROMPT) {
      try {
        fs.mkdirSync(PROMPT_DIR, { recursive: true });
        const promptFile = path.join(PROMPT_DIR, `${id}.md`);
        fs.writeFileSync(promptFile, text, { encoding: 'utf8', mode: 0o600 });
        effectiveText = `${text.slice(0, 6000)}\n\n[... Nội dung yêu cầu rất dài (${text.length} ký tự) — BẮT BUỘC dùng công cụ read_file đọc toàn bộ nội dung đầy đủ tại file sau trước khi thực hiện / Full prompt (${text.length} chars) saved to file, MUST read_file first:]\n${promptFile}`;
      } catch {
        effectiveText = text.slice(0, MAX_CLI_INLINE_PROMPT);
      }
    }
    const prompt = files.length ? `${effectiveText}\n\n${files.length > 1 ? 'Attached images' : 'Attached image'} (read ${files.length > 1 ? 'them' : 'it'} with read_file):\n${files.join('\n')}` : effectiveText;

    const spawnEnv = { ...env() };
    if (chosenModel) {
      spawnEnv.ANTIGRAVITY_MODEL = chosenModel;
    }
    // Always prefer standalone headless `agy` CLI (`agy-cli`) over the Desktop IDE's `language_server` (`agentapi`)
    // so closing the Desktop IDE never interrupts or kills website tasks!
    const useLsAgentApi = bin.kind === 'agy' && Boolean(spawnEnv.ANTIGRAVITY_LS_ADDRESS);
    const isAgyCli = bin.kind === 'agy-cli' && !useLsAgentApi;
    const isAgy = useLsAgentApi;
    const execBin = useLsAgentApi ? (bin.lsFile || bin.file) : bin.file;

    let targetProjectId = '';
    if (isAgy || isAgyCli) {
      delete spawnEnv.ANTIGRAVITY_SOURCE_METADATA;
      delete spawnEnv.ANTIGRAVITY_TRAJECTORY_ID;
      delete spawnEnv.ANTIGRAVITY_CONVERSATION_ID;
      delete spawnEnv.VSCODE_PID;
      delete spawnEnv.VSCODE_IPC_HOOK;
      delete spawnEnv.VSCODE_CWD;
      delete spawnEnv.ELECTRON_RUN_AS_NODE;
      targetProjectId = resolveAgyProjectId(bin.lsFile || bin.file, dir, from?.sid || null, spawnEnv);
      if (isAgy) {
        if (targetProjectId) spawnEnv.ANTIGRAVITY_PROJECT_ID = targetProjectId;
        else delete spawnEnv.ANTIGRAVITY_PROJECT_ID;
        if (from?.sid) spawnEnv.ANTIGRAVITY_CONVERSATION_ID = from.sid;
      } else {
        delete spawnEnv.ANTIGRAVITY_LS_ADDRESS;
        delete spawnEnv.ANTIGRAVITY_CSRF_TOKEN;
        delete spawnEnv.ANTIGRAVITY_PROJECT_ID;
        if (from?.sid) syncDesktopConversationToCli(from.sid);
      }
    }

    const buildArgs = (resumeSid, overrideModel = null, overridePrompt = null) => {
      const effectiveModel = overrideModel || chosenModel || '';
      const activePrompt = overridePrompt || prompt;
      if (isAgyCli) {
        return [
          '--add-dir', dir,
          ...(targetProjectId ? ['--project', targetProjectId] : []),
          ...(resumeSid ? ['--conversation', resumeSid] : []),
          ...(effectiveModel ? ['--model', effectiveModel] : []),
          '--output-format', 'stream-json',
          '--dangerously-skip-permissions',
          '--print-timeout', '4h',
          '-p', activePrompt,
        ];
      }
      if (isAgy) {
        return resumeSid
          ? ['agentapi', 'send-message', `--title=${text.slice(0, 60)}`, resumeSid, activePrompt]
          : ['agentapi', 'new-conversation', `--title=${text.slice(0, 60)}`, activePrompt];
      }
      return [
        '-p', activePrompt,
        '--output-format', 'stream-json',
        '--verbose',
        ...(effectiveModel ? ['--model', effectiveModel] : []),
        ...(resumeSid ? ['--resume', resumeSid, ...(from?.fork === false ? [] : ['--fork-session'])] : []),
      ];
    };

    let proc;
    try { proc = spawn(execBin, buildArgs(from?.sid || null), { cwd: dir, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch { return { ok: false, code: 'noClaude' }; }
    const t = { id, pid: proc.pid, proc, dir, text, at: now, from, by, model: chosenModel, account, sid: from?.sid || null, result: '', error: '', buf: '', isAgy, isAgyCli };
    running.set(id, t); recent.push(now);

    const attachHandlers = (childProc) => {
      childProc.stdout.on('data', (c) => {
        t.buf += String(c);
        if (!t.isAgy) {
          let nl;
          while ((nl = t.buf.indexOf('\n')) >= 0) {
            const line = t.buf.slice(0, nl).trim(); t.buf = t.buf.slice(nl + 1);
            if (!line) continue;
            try {
              const j = JSON.parse(line);
              if (t.isAgyCli) {
                const cid = j.conversation_id || j.step_update?.conversation_id || j.result?.conversation_id;
                if (cid) t.sid = cid;
                if (j.event === 'step_update' && j.step_update?.step_type === 'agent_response' && typeof j.step_update.text_delta === 'string') {
                  t.streamText = (t.streamText || '') + j.step_update.text_delta;
                }
                if (j.event === 'result' && j.result) {
                  const r = j.result;
                  if (typeof r.response === 'string' && r.response.trim()) t.result = r.response.trim();
                  if (r.status === 'ERROR' || r.error) t.error = cleanAgyError(r.error || 'error');
                }
              } else {
                if (j.type === 'system' && j.subtype === 'init' && j.session_id) t.sid = j.session_id;
                if (j.type === 'result') { t.result = String(j.result || ''); if (j.is_error) t.error = t.result || j.subtype || 'error'; }
              }
            } catch { /* not a JSON line */ }
          }
        }
        if (t.buf.length > 1e6) t.buf = '';
      });
      childProc.stderr.on('data', (c) => {
        const msg = String(c).trim().split('\n').pop().slice(0, 300);
        if (t.isAgyCli && /^Fetching available models|^⟳|^✓/i.test(msg)) return;
        t.error = msg;
      });
      childProc.on('error', (e) => { t.error = String(e.message || e).slice(0, 300); });
      childProc.on('exit', (code) => {
        // First retry: if resuming an existing Desktop conversation in standalone CLI fails due to a retired model key in its DB,
        // retry WITH the same conversation ID and an explicit active model so the conversation history is preserved!
        if (!t.stopped && t.isAgyCli && from?.sid && !t.retriedWithModel && (code !== 0 || t.error) && /unknown model key|failed to construct executor/i.test(t.error || t.buf)) {
          t.retriedWithModel = true;
          t.error = '';
          t.result = '';
          t.streamText = '';
          t.buf = '';
          try {
            const retryProc = spawn(execBin, buildArgs(from.sid, 'gemini-4-argon-medium'), { cwd: dir, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
            t.proc = retryProc;
            t.pid = retryProc.pid;
            attachHandlers(retryProc);
            return;
          } catch { /* fall through */ }
        }
        // Second fallback: if the conversation DB is missing/corrupt on CLI, start a fresh session in the same workspace
        if (!t.stopped && t.isAgyCli && from?.sid && !t.retriedFresh && (code !== 0 || t.error) && /unknown model key|not found|failed to construct executor/i.test(t.error || t.buf)) {
          t.retriedFresh = true;
          t.error = '';
          t.result = '';
          t.streamText = '';
          t.buf = '';
          t.sid = null;
          try {
            const retryProc = spawn(execBin, buildArgs(null, chosenModel || 'gemini-4-argon-medium'), { cwd: dir, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
            t.proc = retryProc;
            t.pid = retryProc.pid;
            attachHandlers(retryProc);
            return;
          } catch { /* fall through */ }
        }
        // Third fallback: if a long-running task gets interrupted mid-way by a transient network/RPC error,
        // automatically resume the same conversation up to 2 times so the task finishes seamlessly!
        const resumeConvId = t.sid || from?.sid || null;
        if (
          !t.stopped
          && t.isAgyCli
          && resumeConvId
          && (t.transientRetries || 0) < 2
          && (code !== 0 || t.error)
          && /unavailable|deadline_exceeded|resource_exhausted|connection reset|socket hang up|econnreset|etimedout|eof|stream error|internal error|502|503|504|rate.?limit/i.test(`${t.error || ''} ${t.buf || ''}`)
        ) {
          t.transientRetries = (t.transientRetries || 0) + 1;
          t.error = '';
          t.buf = '';
          setTimeout(() => {
            if (t.stopped) {
              running.delete(id);
              onDone?.(t);
              return;
            }
            try {
              const resumePrompt = 'Tiếp tục hoàn thành công việc đang thực hiện dở (Continue and complete the interrupted task).';
              const retryProc = spawn(execBin, buildArgs(resumeConvId, chosenModel, resumePrompt), { cwd: dir, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
              t.proc = retryProc;
              t.pid = retryProc.pid;
              attachHandlers(retryProc);
            } catch {
              running.delete(id);
              setBounded(finished, id, { id, sid: t.sid, dir: t.dir, result: t.result, error: t.error || `exit ${code}`, doneAt: Date.now() }, 200);
              onDone?.(t);
            }
          }, 2500);
          return;
        }
        if (t.isAgyCli && code === 0 && t.sid) {
          syncCliConversationToDesktop(t.sid);
        }
        running.delete(id);
        if (t.isAgyCli && !t.result && t.streamText?.trim()) {
          t.result = t.streamText.trim();
        }
        if (t.isAgy) {
          const rawOut = t.buf.trim();
          if (rawOut) {
            try {
              const j = JSON.parse(rawOut);
              if (j && typeof j === 'object') {
                if (j.error) {
                  t.error = cleanAgyError(j.error);
                  t.result = '';
                } else {
                  const resp = j.response || {};
                  const foundSid = resp.conversationId || resp.id || (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(JSON.stringify(resp))?.[1] || '');
                  if (foundSid && !t.sid) t.sid = foundSid;
                  const replyText = typeof resp.reply === 'string' ? resp.reply : typeof resp.message === 'string' ? resp.message : typeof resp.text === 'string' ? resp.text : '';
                  t.result = replyText.trim() || (from?.sid
                    ? `Đã nhận công việc và đang xử lý trực tiếp trong phiên (${path.basename(dir)}).`
                    : `Đã khởi tạo phiên mới trong ${path.basename(dir)} và bắt đầu thực hiện công việc.`);
                }
              }
            } catch {
              const uuidMatch = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(rawOut);
              if (uuidMatch && !t.sid) t.sid = uuidMatch[1];
              if (/rpc error:|permission_denied/i.test(rawOut)) {
                t.error = cleanAgyError(rawOut);
                t.result = '';
              } else {
                t.result = rawOut.slice(-1500);
              }
            }
          }
        }
        if (code && !t.error) t.error = `exit ${code}`;
        if ((t.isAgy || t.isAgyCli) && !t.error && !t.result) {
          t.result = `Đã gửi yêu cầu công việc tới Antigravity CLI (${path.basename(dir)}). Agent đang xử lý trực tiếp trong phiên.`;
        }
        setBounded(finished, id, { id, sid: t.sid, dir: t.dir, result: t.result, error: t.error, doneAt: Date.now() }, 200);
        onDone?.(t);
      });
    };
    attachHandlers(proc);
    onStart?.(t);
    return { ok: true, task: pub(t) };
  }
  /** Stops a task (its whole process group: the commands it started too). */
  function stop(id) {
    const t = running.get(id); if (!t) return false;
    t.stopped = true;
    running.delete(id);
    if (t.bridgeUrl && (t.bridgeId || t.sid || t.dir)) {
      stopViaHostBridge(
        { id: t.bridgeId || t.id, sid: t.sid || '', dir: t.dir || '' },
        { bridgeBase: t.bridgeUrl, headers: bridgeHeaders() },
      ).catch(() => {});
    }
    try {
      if (process.platform === 'win32' && t.pid) {
        try { execFileSync('taskkill', ['/T', '/F', '/PID', String(t.pid)], { timeout: 3000, windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
      }
      if (process.platform === 'win32' || !t.pid) t.proc.kill();
      else process.kill(-t.pid, 'SIGTERM');
    } catch {
      try { t.proc.kill(); } catch { /* gone */ }
    }
    return true;
  }
  async function stopBySession({ id = '', sid = '', dir = '' } = {}) {
    let stopped = 0;
    const matchDir = normDirKey(dir);
    for (const r of [...running.values()]) {
      const hitSid = Boolean(sid && (r.sid === sid || r.from?.sid === sid || r.from?.orig === sid));
      const hitId = Boolean(id && (r.id === id || r.from?.id === id || r.bridgeId === id));
      const hitDir = Boolean(!sid && dir && (r.dir === dir || (matchDir && normDirKey(r.dir) === matchDir)));
      if (hitSid || hitId || hitDir) {
        if (stop(r.id)) stopped++;
      }
    }
    const bin = typeof claude === 'function' ? claude() : null;
    if (bin?.kind === 'docker-bridge' || process.env.OFFICE_DOCKER === '1') {
      const bridgeUrl = String(bin?.url || process.env.OFFICE_HOST_BRIDGE || 'http://host.docker.internal:4311').replace(/\/+$/, '');
      const r = await stopViaHostBridge(
        { id, sid, dir },
        { bridgeBase: bridgeUrl, headers: bridgeHeaders() },
      );
      if (typeof r?.stopped === 'number') stopped += r.stopped;
    }
    return { ok: true, stopped };
  }
  const api = { start, stop, stopBySession, getStatus, list: () => [...running.values()].map(pub) };
  activeTasksInstance = api;
  return api;
}

let activeTasksInstance = null;

export async function stopBySession(opts = {}) {
  if (activeTasksInstance && typeof activeTasksInstance.stopBySession === 'function') {
    return activeTasksInstance.stopBySession(opts);
  }
  return { ok: true, stopped: 0 };
}

const tasksModule = {
  createTasks,
  resolveContainerDir,
  stopBySession,
  requestHostBridgeWakeup,
  ensureHostBridgeReady,
  dispatchViaHostBridge,
  stopViaHostBridge,
};
export default tasksModule;
