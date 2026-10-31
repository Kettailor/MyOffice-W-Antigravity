// "Giao việc": giving Antigravity / Claude work from the office, on a phone or over Tailscale too.
// Supports both Antigravity's native `language_server agentapi` CLI (`new-conversation` / `send-message`)
// and `claude -p --output-format stream-json`.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_TEXT = 4000, MAX_IMAGES = 5, MAX_IMAGE = 4_500_000;
const IMG_KEEP_MS = 30 * 86400_000; // 30 days retention for task images
const projectIdByDir = new Map();
const projectIdBySid = new Map();

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
          if (pid && dKey) projectIdByDir.set(dKey, pid);
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
        if (dKey) projectIdByDir.set(dKey, m[2]);
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
    const srcStat = fs.statSync(srcDb);
    const dstStat = fs.existsSync(dstDb) ? fs.statSync(dstDb) : null;
    if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcDb, dstDb);
      if (fs.existsSync(`${srcDb}-wal`)) {
        fs.copyFileSync(`${srcDb}-wal`, `${dstDb}-wal`);
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
    const srcStat = fs.statSync(srcDb);
    const dstStat = fs.existsSync(dstDb) ? fs.statSync(dstDb) : null;
    if (!dstStat || srcStat.mtimeMs > dstStat.mtimeMs) {
      fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(srcDb, dstDb);
    }
  } catch { /* best effort */ }
}

function resolveAgyProjectId(binFile, dir, sid, baseEnv) {
  if (sid && projectIdBySid.has(sid)) return projectIdBySid.get(sid);
  const cleanEnv = { ...baseEnv };
  delete cleanEnv.ANTIGRAVITY_PROJECT_ID;
  delete cleanEnv.ANTIGRAVITY_SOURCE_METADATA;
  delete cleanEnv.ANTIGRAVITY_TRAJECTORY_ID;
  delete cleanEnv.ANTIGRAVITY_CONVERSATION_ID;
  if (sid) {
    try {
      const raw = execFileSync(binFile, ['agentapi', 'get-conversation-metadata', sid], {
        cwd: dir || undefined,
        env: cleanEnv,
        timeout: 4500,
        windowsHide: true,
      }).toString('utf8');
      const parsed = JSON.parse(raw.trim());
      const pid = parsed?.response?.conversationMetadata?.metadata?.projectId || '';
      if (pid) {
        projectIdBySid.set(sid, pid);
        if (dir) projectIdByDir.set(normDirKey(dir), pid);
        return pid;
      }
    } catch { /* fallback to proto lookup */ }
  }
  return lookupProjectIdFromSummariesProto(dir);
}

function cleanAgyError(errStr = '') {
  const s = String(errStr || '').trim();
  if (!s) return '';
  const m = /desc\s*=\s*(.+)$/i.exec(s);
  return (m ? m[1] : s).replace(/\\"/g, '"').trim();
}

/** claude() -> { file, kind? } | null; env() -> the environment to run with; onStart(task), onDone(task) for the office. */
export function createTasks({ dataDir, claude, env, onStart, onDone, max = 3, perHour = 12 }) {
  const running = new Map(), recent = [];   // id -> task; when the last ones started (the hourly cap)
  const IMG_DIR = path.join(dataDir, 'task-images');
  const imgDir = IMG_DIR;
  function pruneTaskImages() {
    try {
      if (!fs.existsSync(IMG_DIR)) return;
      const now = Date.now();
      for (const name of fs.readdirSync(IMG_DIR)) {
        const full = path.join(IMG_DIR, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile() && now - st.mtimeMs > IMG_KEEP_MS) fs.rmSync(full, { force: true });
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
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
      const candidateUrls = [...new Set([primaryUrl, 'http://host.docker.internal:4311', 'http://192.168.65.254:4311'])];
      const ac = new AbortController();
      const t = { id, pid: 0, proc: { kill: () => ac.abort() }, bridgeId: null, bridgeUrl: primaryUrl, dir, text, at: now, from, by, model: chosenModel, account, sid: from?.sid || null, result: '', error: '', buf: '', isAgyCli: true };
      running.set(id, t); recent.push(now);
      (async () => {
        try {
          let res = null;
          let lastErr = null;
          for (let attempt = 0; attempt < 3 && !res; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
            for (const baseUrl of candidateUrls) {
              try {
                const candidateRes = await fetch(`${baseUrl}/task/start`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ dir, text, images: images.slice(0, MAX_IMAGES), from, by, model: chosenModel, account }),
                  signal: ac.signal,
                });
                if (candidateRes.ok && candidateRes.body) {
                  res = candidateRes;
                  t.bridgeUrl = baseUrl;
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
                if (j.event === 'error') t.error = j.code || 'error';
                if (j.event === 'done') {
                  if (j.sid) t.sid = j.sid;
                  if (j.result) t.result = j.result;
                  if (j.error) t.error = j.error;
                }
              } catch { /* ignore */ }
            }
          }
        } catch (err) {
          if (!ac.signal.aborted) t.error = String(err?.message || err).slice(0, 240);
        } finally {
          running.delete(id);
          if (!t.error && !t.result) {
            t.result = `Đã gửi yêu cầu công việc tới Antigravity CLI (${String(dir).split(/[\\/]/).pop()}).`;
          }
          onDone?.(t);
        }
      })();
      onStart?.(t);
      return { ok: true, task: pub(t) };
    }

    for (const [i, d] of images.slice(0, MAX_IMAGES).entries()) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(d || ''));
      if (!m || d.length > MAX_IMAGE) continue;
      fs.mkdirSync(imgDir, { recursive: true });
      const f = path.join(imgDir, `${id}-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(f, Buffer.from(m[2], 'base64'), { mode: 0o600 }); files.push(f);
    }
    const prompt = files.length ? `${text}\n\n${files.length > 1 ? 'Attached images' : 'Attached image'} (read ${files.length > 1 ? 'them' : 'it'} with read_file):\n${files.join('\n')}` : text;

    const spawnEnv = { ...env() };
    // Prefer language_server agentapi only when ANTIGRAVITY_LS_ADDRESS is active in env; otherwise run standalone `agy` CLI!
    const useLsAgentApi = (bin.kind === 'agy' || (bin.kind === 'agy-cli' && bin.lsFile)) && Boolean(spawnEnv.ANTIGRAVITY_LS_ADDRESS);
    const isAgyCli = bin.kind === 'agy-cli' && !useLsAgentApi;
    const isAgy = useLsAgentApi;
    const execBin = useLsAgentApi ? (bin.lsFile || bin.file) : bin.file;

    let targetProjectId = '';
    if (isAgy || isAgyCli) {
      delete spawnEnv.ANTIGRAVITY_SOURCE_METADATA;
      delete spawnEnv.ANTIGRAVITY_TRAJECTORY_ID;
      delete spawnEnv.ANTIGRAVITY_CONVERSATION_ID;
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

    const buildArgs = (resumeSid, overrideModel = null) => {
      const effectiveModel = overrideModel || chosenModel || '';
      if (isAgyCli) {
        return [
          '--add-dir', dir,
          ...(targetProjectId ? ['--project', targetProjectId] : []),
          ...(resumeSid ? ['--conversation', resumeSid] : []),
          ...(effectiveModel ? ['--model', effectiveModel] : []),
          '--output-format', 'stream-json',
          '--dangerously-skip-permissions',
          '--print-timeout', '30m',
          '-p', prompt,
        ];
      }
      if (isAgy) {
        return resumeSid
          ? ['agentapi', 'send-message', `--title=${text.slice(0, 60)}`, resumeSid, prompt]
          : ['agentapi', 'new-conversation', `--title=${text.slice(0, 60)}`, prompt];
      }
      return [
        '-p', prompt,
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
        if (t.isAgyCli && from?.sid && !t.retriedWithModel && (code !== 0 || t.error) && /unknown model key|failed to construct executor/i.test(t.error || t.buf)) {
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
        if (t.isAgyCli && from?.sid && !t.retriedFresh && (code !== 0 || t.error) && /unknown model key|not found|failed to construct executor/i.test(t.error || t.buf)) {
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
    if (t.bridgeUrl && t.bridgeId) {
      fetch(`${t.bridgeUrl}/task/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.bridgeId }) }).catch(() => {});
    }
    try { if (process.platform === 'win32' || !t.pid) t.proc.kill(); else process.kill(-t.pid, 'SIGTERM'); } catch { try { t.proc.kill(); } catch { /* gone */ } }
    return true;
  }
  return { start, stop, list: () => [...running.values()].map(pub) };
}
