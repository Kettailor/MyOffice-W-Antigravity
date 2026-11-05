#!/usr/bin/env node
// Host CLI & Network Bridge for Dockerized Work Office (`server/host-bridge.mjs`).
// Runs silently on the Windows host (`127.0.0.1` / Docker host gateway port 4311) so the `work-office`
// Linux Docker container can:
// 1. Read the host's live trusted Wi-Fi SSID IP & Tailscale IP via `data/host-net.json`
// 2. Dispatch "📋 Giao việc" & Group Chat `@Mention` tasks natively via Windows `agy.exe` (with Windows Keyring OAuth)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTasks } from './tasks.mjs';
import { sysSnapshot, sysAction, setI18n, startTrend, trackOwners } from './system.mjs';
import { fetchLiveAgyQuotaAndUser } from './antigravity.mjs';
import { pickLang, createT } from '../src/i18n/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
} catch { /* ignore */ }
const DATA_DIR = process.env.OFFICE_DATA_DIR ? path.resolve(process.env.OFFICE_DATA_DIR) : path.join(ROOT, 'data');
const BRIDGE_PORT = Number(process.env.OFFICE_BRIDGE_PORT) || 4311;
const ALLOWED_WIFI_SSID = (process.env.OFFICE_WIFI_SSID || '*').trim().toLowerCase();
const HOST_NET_FILE = path.join(DATA_DIR, 'host-net.json');
const HOST_SYS_FILE = path.join(DATA_DIR, 'host-sys.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token');
const STOP_FLAG_FILE = path.join(DATA_DIR, '.bridge-stopped');
const WAKEUP_FILE = path.join(DATA_DIR, 'bridge-wakeup.json');
const AUTO_STOP = !process.argv.includes('--keep-alive') && (
  process.argv.includes('--on-demand') ||
  process.env.WORKOFFICE_BRIDGE_AUTO_STOP === '1' ||
  process.env.WORKOFFICE_BRIDGE_AUTO_STOP !== '0'
);
const IDLE_TIMEOUT_MS = Number(process.env.WORKOFFICE_BRIDGE_IDLE_MS) || 95_000;
let lastActivityAt = Date.now();
function touchActivity() {
  lastActivityAt = Date.now();
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// Legacy `--watchdog` flag now delegates to the lightweight Rust `watch-bridge` daemon
// (or watches `data/bridge-wakeup.json` on-demand instead of keeping a heavy server alive 24/7).
if (process.argv.includes('--watchdog')) {
  const rustWatcher = path.join(ROOT, 'bin', process.platform === 'win32' ? 'work-office-native.exe' : 'work-office-native');
  if (fs.existsSync(rustWatcher)) {
    if (process.platform === 'win32') {
      try {
        const cmdLine = `"${rustWatcher}" watch-bridge "${ROOT}"`.replace(/'/g, "''");
        const cwdStr = ROOT.replace(/'/g, "''");
        const ps = [
          '$si = [CimInstance]::new((Get-CimClass Win32_ProcessStartup));',
          '$si.ShowWindow = 0;',
          `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine}'; CurrentDirectory = '${cwdStr}'; ProcessStartupInformation = $si } | Out-Null`,
        ].join(' ');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          cwd: ROOT,
          stdio: 'ignore',
          timeout: 6000,
          windowsHide: true,
        });
        process.exit(0);
      } catch { /* fallback to detached spawn */ }
    }
    spawn(rustWatcher, ['watch-bridge', ROOT], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    process.exit(0);
  }
  const selfScript = fileURLToPath(import.meta.url);
  let childProc = null;
  setInterval(() => {
    if (fs.existsSync(STOP_FLAG_FILE)) process.exit(0);
    if (childProc || !fs.existsSync(WAKEUP_FILE)) return;
    try { fs.unlinkSync(WAKEUP_FILE); } catch { /* ignore */ }
    childProc = spawn(process.execPath, [selfScript, '--on-demand'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    childProc.on('exit', () => { childProc = null; });
  }, 250);
} else {

function getBridgeToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
    const created = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, created, { mode: 0o600 });
    return created;
  } catch {
    return '';
  }
}

function verifyBridgeToken(req) {
  const expected = getBridgeToken();
  if (!expected) return true;
  const provided = String(req.headers['x-bridge-token'] || req.headers['x-office-bridge-token'] || '').trim();
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hasValidBridgeToken = verifyBridgeToken;

function isTailscaleIp(addr = '') {
  const m = /^100\.(\d+)\./.exec(String(addr || ''));
  return !!(m && +m[1] >= 64 && +m[1] <= 127);
}

function currentNetIfSig() {
  const parts = [];
  for (const [ifName, list] of Object.entries(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n && n.family === 'IPv4' && !n.internal) parts.push(`${ifName}:${n.address}`);
    }
  }
  return parts.sort().join('|');
}

const wlanCache = { at: 0, sig: '', onWifi: false, macs: new Set(), names: new Set(['wi-fi', 'wlan']) };

function detectHostIps(force = false) {
  let wifiIp = null;
  let tsIp = null;
  const now = Date.now();
  const sig = currentNetIfSig();
  const ttl = wlanCache.onWifi ? 60_000 : 30_000;
  if (process.platform === 'win32' && (force || !wlanCache.at || sig !== wlanCache.sig || now - wlanCache.at >= ttl)) {
    wlanCache.at = now;
    wlanCache.sig = sig;
    let onWifi = false;
    const macs = new Set();
    const names = new Set(['wi-fi', 'wlan']);
    try {
      const out = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { timeout: 2500, windowsHide: true }).toString('utf8');
      for (const b of out.split(/\r?\n\s*\r?\n/)) {
        const ssidM = /^\s*SSID\s*:\s*(.+)$/im.exec(b);
        const ssidVal = ssidM ? ssidM[1].trim().toLowerCase() : '';
        if (!ssidVal || (ALLOWED_WIFI_SSID !== '*' && ALLOWED_WIFI_SSID !== 'any' && ssidVal !== ALLOWED_WIFI_SSID)) continue;
        onWifi = true;
        const macM = /^\s*(?:Physical address|Địa chỉ vật lý)\s*:\s*([0-9a-f:-]{17})/im.exec(b);
        if (macM) macs.add(macM[1].trim().toLowerCase().replace(/-/g, ':'));
        const nameM = /^\s*(?:Name|Tên)\s*:\s*(.+)$/im.exec(b);
        if (nameM) names.add(nameM[1].trim().toLowerCase());
      }
    } catch { /* ignore */ }
    wlanCache.onWifi = onWifi;
    wlanCache.macs = macs;
    wlanCache.names = names;
  }
  const onWifi = wlanCache.onWifi;
  const macs = wlanCache.macs;
  const names = wlanCache.names;
  const nets = os.networkInterfaces();
  for (const [ifName, list] of Object.entries(nets)) {
    const lowName = ifName.toLowerCase();
    for (const n of list || []) {
      if (!n || n.family !== 'IPv4' || n.internal || /^169\.254\./.test(n.address)) continue;
      if (isTailscaleIp(n.address)) {
        if (!tsIp) tsIp = n.address;
        continue;
      }
      if (/ethernet|vethernet|vmware|vbox|virtualbox|hyper-v|local area|loopback|tailscale|bluetooth/i.test(lowName)) continue;
      const mac = String(n.mac || '').toLowerCase().replace(/-/g, ':');
      if (process.platform === 'win32') {
        if (onWifi && (macs.has(mac) || names.has(lowName) || /wi-?fi|wlan/i.test(lowName))) {
          wifiIp = n.address;
        }
      } else if (/^en0|wlan|wi-?fi/i.test(lowName)) {
        wifiIp = n.address;
      }
    }
  }
  try {
    fs.writeFileSync(HOST_NET_FILE, JSON.stringify({ wifiIp, tsIp, onWifi, at: Date.now() }, null, 2));
  } catch { /* ignore */ }
  return { wifiIp, tsIp, onWifi };
}

detectHostIps();
setInterval(detectHostIps, 15_000).unref();

let currentBridgeLang = 'vi';
function applyBridgeLang(lang = 'vi') {
  const l = pickLang(lang || 'vi');
  currentBridgeLang = l;
  const tObj = createT(l);
  setI18n({ tr: tObj.t, num: tObj.num, lang: () => currentBridgeLang });
}
applyBridgeLang('vi');
startTrend();
trackOwners();

async function syncHostSysSnapshot(open = true, lang = currentBridgeLang) {
  try {
    if (lang && lang !== currentBridgeLang) applyBridgeLang(lang);
    const [snap] = await Promise.all([
      sysSnapshot({ open }),
      fetchLiveAgyQuotaAndUser(true).catch(() => null),
    ]);
    if (snap && snap.mem) {
      fs.writeFileSync(HOST_SYS_FILE, JSON.stringify(snap));
    }
    return snap;
  } catch {
    return null;
  }
}

// Take baseline and second delta reading on startup so CPU % and per-app CPU deltas are populated immediately
syncHostSysSnapshot(false).then(() => {
  setTimeout(() => { syncHostSysSnapshot(true).catch(() => {}); }, 600).unref?.();
}).catch(() => {});
setInterval(() => { syncHostSysSnapshot(false).catch(() => {}); }, 15_000).unref();

function findHostCli() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const agyExe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const candidates = [
    path.join(localAppData, 'agy', 'bin', agyExe),
    path.join(home, '.gemini', 'bin', agyExe),
    path.join(home, '.local', 'bin', agyExe),
  ];
  for (const f of candidates) {
    if (isFile(f)) return { file: f, onPath: false, kind: 'agy-cli' };
  }
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (d && isFile(path.join(d, agyExe))) return { file: path.join(d, agyExe), onPath: true, kind: 'agy-cli' };
  }
  return null;
}

const streams = new Map(); // taskId -> res

// Send periodic NDJSON heartbeats so Node undici fetch inside Docker never times out during long Antigravity turns
setInterval(() => {
  for (const [id, res] of streams.entries()) {
    if (!res || res.writableEnded || res.destroyed) {
      streams.delete(id);
      continue;
    }
    try {
      res.write(JSON.stringify({ event: 'ping', t: Date.now() }) + '\n');
    } catch {
      streams.delete(id);
    }
  }
}, 10_000).unref();

process.on('uncaughtException', (err) => {
  console.error('[host-bridge] uncaughtException:', err?.message || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[host-bridge] unhandledRejection:', err?.message || err);
});

const hostTasks = createTasks({
  dataDir: DATA_DIR,
  claude: findHostCli,
  max: Number(process.env.OFFICE_MAX_CONCURRENT_TASKS) || 12,
  perHour: Number(process.env.OFFICE_TASKS_PER_HOUR) || 100,
  env: () => {
    const e = { ...process.env };
    delete e.ANTIGRAVITY_LS_ADDRESS;
    delete e.ANTIGRAVITY_CSRF_TOKEN;
    delete e.ANTIGRAVITY_CONVERSATION_ID;
    delete e.ANTIGRAVITY_TRAJECTORY_ID;
    delete e.ANTIGRAVITY_SOURCE_METADATA;
    delete e.VSCODE_PID;
    delete e.VSCODE_IPC_HOOK;
    delete e.ELECTRON_RUN_AS_NODE;
    return e;
  },
  onStart(t) {
    touchActivity();
    const res = streams.get(t.id);
    if (res && !res.writableEnded) {
      res.write(JSON.stringify({ event: 'start', id: t.id, sid: t.sid || null }) + '\n');
    }
  },
  onDone(t) {
    touchActivity();
    const res = streams.get(t.id);
    streams.delete(t.id);
    if (res && !res.writableEnded) {
      res.write(JSON.stringify({ event: 'done', id: t.id, sid: t.sid || null, result: t.result || '', error: t.error || '' }) + '\n');
      res.end();
    }
  },
});

function isAllowedBridgeClient(req) {
  const ip = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\./.test(ip)
  );
}

const server = http.createServer((req, res) => {
  if (!isAllowedBridgeClient(req)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    touchActivity();
    const activeTasks = hostTasks.list().length;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      ok: true,
      mode: AUTO_STOP ? 'on-demand' : 'persistent',
      running: activeTasks,
      idleMs: Math.max(0, Date.now() - lastActivityAt),
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    }));
    return;
  }
  if (req.method === 'GET' && req.url === '/status') {
    touchActivity();
    if (!hasValidBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const net = detectHostIps();
    const activeTasks = hostTasks.list().length;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      ok: true,
      mode: AUTO_STOP ? 'on-demand' : 'persistent',
      running: activeTasks,
      idleMs: Math.max(0, Date.now() - lastActivityAt),
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      ...net,
    }));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/sys')) {
    touchActivity();
    if (!hasValidBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const open = u.searchParams.get('open') === '1';
    const lang = u.searchParams.get('lang') || 'vi';
    syncHostSysSnapshot(open, lang)
      .then((snap) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(snap || { ok: false }));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
      });
    return;
  }
  if (req.method === 'POST' && req.url === '/sys/action') {
    touchActivity();
    if (!verifyBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const chunks = [];
    let len = 0;
    req.on('data', (c) => { len += c.length; if (len <= 1_000_000) chunks.push(c); });
    req.on('end', () => {
      touchActivity();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      if (body?.lang) applyBridgeLang(body.lang);
      sysAction(body || {})
        .then((out) => {
          syncHostSysSnapshot(true).catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, message: String(err?.message || err) }));
        });
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/task/status')) {
    touchActivity();
    if (!hasValidBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const st = typeof hostTasks.getStatus === 'function'
      ? hostTasks.getStatus({
          id: u.searchParams.get('id') || '',
          sid: u.searchParams.get('sid') || '',
          dir: u.searchParams.get('dir') || '',
        })
      : { ok: true, running: hostTasks.list().length > 0 };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(st));
    return;
  }
  if (req.method === 'POST' && (req.url === '/task/start' || req.url === '/dispatch')) {
    touchActivity();
    if (!verifyBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    req.socket?.setTimeout?.(0);
    req.socket?.setKeepAlive?.(true, 15_000);
    const chunks = [];
    let len = 0;
    req.on('data', (c) => { len += c.length; if (len <= 64_000_000) chunks.push(c); });
    req.on('end', () => {
      touchActivity();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'badJson' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      const r = hostTasks.start({
        dir: body.dir,
        text: body.text,
        images: body.images || [],
        from: body.from || null,
        by: body.by || null,
        model: body.model || null,
        account: body.account || null,
      });
      if (!r.ok) {
        res.end(JSON.stringify({ event: 'error', code: r.code || 'noClaude' }) + '\n');
        return;
      }
      streams.set(r.task.id, res);
      res.write(JSON.stringify({ event: 'queued', task: r.task }) + '\n');
    });
    return;
  }
  if (req.method === 'POST' && (req.url === '/task/stop' || req.url === '/stop')) {
    touchActivity();
    if (!verifyBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      touchActivity();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      let stopped = 0;
      if (body?.id && hostTasks.stop(String(body.id))) {
        stopped++;
      }
      if (typeof hostTasks.stopBySession === 'function' && (body?.sid || body?.dir || body?.id)) {
        const r = await hostTasks.stopBySession({
          id: String(body?.id || ''),
          sid: String(body?.sid || ''),
          dir: String(body?.dir || ''),
        });
        stopped += Number(r?.stopped) || 0;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, stopped }));
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/docker/control') {
    touchActivity();
    if (!verifyBridgeToken(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'forbidden' }));
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      touchActivity();
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const action = String(body?.action || 'status').toLowerCase();
      if (action === 'bridge') {
        const net = detectHostIps(true);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, action: 'bridge', message: 'Host Bridge synced', ...net }));
        return;
      }
      if (action === 'restart' || action === 'up' || action === 'down') {
        const composeArgs = action === 'restart' ? ['compose', 'restart'] : action === 'up' ? ['compose', 'up', '-d'] : ['compose', 'stop'];
        try {
          const child = spawn('docker', composeArgs, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
          child.unref();
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, action }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, action, error: String(err?.message || err) }));
        }
        return;
      }
      // 'status'
      let containerRunning = false;
      try {
        const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'work-office'], { timeout: 3000, windowsHide: true }).toString('utf8').trim();
        containerRunning = out === 'true';
      } catch { /* ignore */ }
      const net = detectHostIps();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        ok: true,
        action: 'status',
        containerRunning,
        bridgeUp: true,
        bridgeOnDemand: AUTO_STOP,
        ...net,
      }));
    });
    return;
  }
  res.writeHead(404).end();
});

// Auto-stop idle timer: when running on-demand and 0 tasks are active for IDLE_TIMEOUT_MS (45s),
// cleanly shut down to free 100% of Node.js RAM & CPU on the Windows host.
setInterval(() => {
  const runningCount = hostTasks.list().length + streams.size;
  if (runningCount > 0) {
    touchActivity();
    return;
  }
  if (AUTO_STOP && Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS) {
    try { detectHostIps(true); } catch { /* ignore */ }
    try { if (fs.existsSync(WAKEUP_FILE)) fs.unlinkSync(WAKEUP_FILE); } catch { /* ignore */ }
    console.log(`[host-bridge] Idle for ${Math.round((Date.now() - lastActivityAt) / 1000)}s with 0 active tasks. Auto-stopping to free RAM.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 400).unref();
  }
}, 5_000).unref();

server.requestTimeout = 0;
server.timeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65_000;
server.on('connection', (socket) => {
  socket.setMaxListeners(0);
  socket.on('error', () => {});
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // Another Host Bridge instance is already listening on 4311
    process.exit(0);
  }
  console.error('[host-bridge] server error:', err?.message || err);
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  touchActivity();
  try {
    if (fs.existsSync(WAKEUP_FILE)) fs.unlinkSync(WAKEUP_FILE);
  } catch { /* ignore */ }
  console.log(`Work Office Host Bridge listening on port ${BRIDGE_PORT} (${AUTO_STOP ? `on-demand, auto-stop after ${Math.round(IDLE_TIMEOUT_MS / 1000)}s idle` : 'persistent'})`);
});
}
