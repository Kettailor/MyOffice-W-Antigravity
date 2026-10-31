#!/usr/bin/env node
// Host CLI & Network Bridge for Dockerized Work Office (`server/host-bridge.mjs`).
// Runs silently on the Windows host (`127.0.0.1` / Docker host gateway port 4311) so the `work-office`
// Linux Docker container can:
// 1. Read the host's live Wi-Fi SSID "Ket" IP & Tailscale IP via `data/host-net.json`
// 2. Dispatch "📋 Giao việc" & Group Chat `@Mention` tasks natively via Windows `agy.exe` (with Windows Keyring OAuth)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTasks } from './tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.OFFICE_DATA_DIR ? path.resolve(process.env.OFFICE_DATA_DIR) : path.join(ROOT, 'data');
const BRIDGE_PORT = Number(process.env.OFFICE_BRIDGE_PORT) || 4311;
const ALLOWED_WIFI_SSID = (process.env.OFFICE_WIFI_SSID || 'Ket').trim().toLowerCase();
const HOST_NET_FILE = path.join(DATA_DIR, 'host-net.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function isTailscaleIp(addr = '') {
  const m = /^100\.(\d+)\./.exec(String(addr || ''));
  return !!(m && +m[1] >= 64 && +m[1] <= 127);
}

function detectHostIps() {
  let wifiIp = null;
  let tsIp = null;
  let onKet = false;
  const macs = new Set();
  const names = new Set(['wi-fi', 'wlan']);
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { timeout: 2500, windowsHide: true }).toString('utf8');
      for (const b of out.split(/\r?\n\s*\r?\n/)) {
        const ssidM = /^\s*SSID\s*:\s*(.+)$/im.exec(b);
        if (!ssidM || ssidM[1].trim().toLowerCase() !== ALLOWED_WIFI_SSID) continue;
        onKet = true;
        const macM = /^\s*(?:Physical address|Địa chỉ vật lý)\s*:\s*([0-9a-f:-]{17})/im.exec(b);
        if (macM) macs.add(macM[1].trim().toLowerCase().replace(/-/g, ':'));
        const nameM = /^\s*(?:Name|Tên)\s*:\s*(.+)$/im.exec(b);
        if (nameM) names.add(nameM[1].trim().toLowerCase());
      }
    } catch { /* ignore */ }
  }
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
        if (onKet && (macs.has(mac) || names.has(lowName) || /wi-?fi|wlan/i.test(lowName))) {
          wifiIp = n.address;
        }
      } else if (/^en0|wlan|wi-?fi/i.test(lowName)) {
        wifiIp = n.address;
      }
    }
  }
  try {
    fs.writeFileSync(HOST_NET_FILE, JSON.stringify({ wifiIp, tsIp, onKet, at: Date.now() }, null, 2));
  } catch { /* ignore */ }
  return { wifiIp, tsIp, onKet };
}

detectHostIps();
setInterval(detectHostIps, 15_000).unref();

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

const hostTasks = createTasks({
  dataDir: DATA_DIR,
  claude: findHostCli,
  env: () => {
    const e = { ...process.env };
    delete e.ANTIGRAVITY_LS_ADDRESS;
    delete e.ANTIGRAVITY_CSRF_TOKEN;
    delete e.ANTIGRAVITY_CONVERSATION_ID;
    delete e.ANTIGRAVITY_TRAJECTORY_ID;
    delete e.ANTIGRAVITY_SOURCE_METADATA;
    return e;
  },
  onStart(t) {
    const res = streams.get(t.id);
    if (res && !res.writableEnded) {
      res.write(JSON.stringify({ event: 'start', id: t.id, sid: t.sid || null }) + '\n');
    }
  },
  onDone(t) {
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
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^192\.168\.65\./.test(ip)
  );
}

const server = http.createServer((req, res) => {
  if (!isAllowedBridgeClient(req)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    const net = detectHostIps();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...net }));
    return;
  }
  if (req.method === 'POST' && req.url === '/task/start') {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => { len += c.length; if (len <= 10_000_000) chunks.push(c); });
    req.on('end', () => {
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
  if (req.method === 'POST' && req.url === '/task/stop') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const ok = hostTasks.stop(String(body.id || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok }));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(BRIDGE_PORT, '0.0.0.0', () => {
  console.log(`Work Office Host Bridge listening on port ${BRIDGE_PORT}`);
});
