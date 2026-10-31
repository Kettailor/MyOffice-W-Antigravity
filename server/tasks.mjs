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
  return process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s;
}

function lookupProjectIdFromSummariesProto(targetDir) {
  const key = normDirKey(targetDir);
  if (!key) return '';
  if (projectIdByDir.has(key)) return projectIdByDir.get(key);
  try {
    const pbPath = path.join(os.homedir(), '.gemini', 'antigravity', 'agyhub_summaries_proto.pb');
    if (!fs.existsSync(pbPath)) return '';
    const text = fs.readFileSync(pbPath).toString('latin1');
    const re = /file:\/\/\/([A-Za-z0-9%._~:/-]+)[\s\S]{1,40}?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      let decoded = m[1];
      try { decoded = decodeURIComponent(m[1]); } catch { /* keep raw */ }
      const dKey = normDirKey(decoded);
      if (dKey) projectIdByDir.set(dKey, m[2]);
    }
    return projectIdByDir.get(key) || '';
  } catch {
    return '';
  }
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
  const pub = (t) => ({ id: t.id, dir: t.dir, text: t.text.slice(0, 200), at: t.at, from: t.from || null, sid: t.sid || null, by: t.by || null });
  /** { dir, text, images: [data URLs], from: { sid, name, fork } | null, by: { name, role } | null } -> { ok, task } or { ok: false, code } */
  function start({ dir, text, images = [], from = null, by = null }) {
    text = String(text || '').trim().slice(0, MAX_TEXT);
    if (!text) return { ok: false, code: 'empty' };
    if (running.size >= max) return { ok: false, code: 'busy' };
    const now = Date.now(); while (recent.length && now - recent[0] > 3600e3) recent.shift();
    if (recent.length >= perHour) return { ok: false, code: 'tooMany' };
    const bin = claude(); if (!bin) return { ok: false, code: 'noClaude' };
    if (!dir || !fs.existsSync(dir)) return { ok: false, code: 'noDir' };
    const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, files = [];
    for (const [i, d] of images.slice(0, MAX_IMAGES).entries()) {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(d || ''));
      if (!m || d.length > MAX_IMAGE) continue;
      fs.mkdirSync(imgDir, { recursive: true });
      const f = path.join(imgDir, `${id}-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
      fs.writeFileSync(f, Buffer.from(m[2], 'base64'), { mode: 0o600 }); files.push(f);
    }
    const prompt = files.length ? `${text}\n\n${files.length > 1 ? 'Attached images' : 'Attached image'} (read ${files.length > 1 ? 'them' : 'it'} with read_file):\n${files.join('\n')}` : text;

    const isAgy = bin.kind === 'agy';
    const args = isAgy
      ? (from?.sid
          ? ['agentapi', 'send-message', `--title=${text.slice(0, 60)}`, from.sid, prompt]
          : ['agentapi', 'new-conversation', `--title=${text.slice(0, 60)}`, prompt])
      : ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...(from?.sid ? ['--resume', from.sid, ...(from.fork === false ? [] : ['--fork-session'])] : [])];

    const spawnEnv = { ...env() };
    if (isAgy) {
      delete spawnEnv.ANTIGRAVITY_SOURCE_METADATA;
      delete spawnEnv.ANTIGRAVITY_TRAJECTORY_ID;
      delete spawnEnv.ANTIGRAVITY_CONVERSATION_ID;
      const targetProjectId = resolveAgyProjectId(bin.file, dir, from?.sid || null, spawnEnv);
      if (targetProjectId) spawnEnv.ANTIGRAVITY_PROJECT_ID = targetProjectId;
      else delete spawnEnv.ANTIGRAVITY_PROJECT_ID;
      if (from?.sid) spawnEnv.ANTIGRAVITY_CONVERSATION_ID = from.sid;
    }

    let proc;
    try { proc = spawn(bin.file, args, { cwd: dir, env: spawnEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch { return { ok: false, code: 'noClaude' }; }
    const t = { id, pid: proc.pid, proc, dir, text, at: now, from, by, sid: from?.sid || null, result: '', error: '', buf: '', isAgy };
    running.set(id, t); recent.push(now);

    proc.stdout.on('data', (c) => {
      t.buf += String(c);
      if (!isAgy) {
        let nl;
        while ((nl = t.buf.indexOf('\n')) >= 0) {
          const line = t.buf.slice(0, nl); t.buf = t.buf.slice(nl + 1);
          try {
            const j = JSON.parse(line);
            if (j.type === 'system' && j.subtype === 'init' && j.session_id) t.sid = j.session_id;
            if (j.type === 'result') { t.result = String(j.result || ''); if (j.is_error) t.error = t.result || j.subtype || 'error'; }
          } catch { /* not a line of its stream */ }
        }
      }
      if (t.buf.length > 1e6) t.buf = '';
    });
    proc.stderr.on('data', (c) => { t.error = String(c).trim().split('\n').pop().slice(0, 300); });
    proc.on('error', (e) => { t.error = String(e.message || e).slice(0, 300); });
    proc.on('exit', (code) => {
      running.delete(id);
      if (isAgy) {
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
      if (isAgy && !t.error && !t.result) {
        t.result = `Đã gửi yêu cầu công việc tới Antigravity (${path.basename(dir)}). Agent đang xử lý trực tiếp trong phiên.`;
      }
      onDone?.(t);
    });
    onStart?.(t);
    return { ok: true, task: pub(t) };
  }
  /** Stops a task (its whole process group: the commands it started too). */
  function stop(id) {
    const t = running.get(id); if (!t) return false;
    try { if (process.platform === 'win32') t.proc.kill(); else process.kill(-t.pid, 'SIGTERM'); } catch { try { t.proc.kill(); } catch { /* gone */ } }
    return true;
  }
  return { start, stop, list: () => [...running.values()].map(pub) };
}
