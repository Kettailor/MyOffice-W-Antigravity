// Windows readings: one PowerShell run per reading (CIM for processes and the page file, Get-NetTCPConnection for
// sockets: its states are numbers, so a German or Vietnamese Windows reads the same), shared for two seconds because
// starting PowerShell takes a moment. Windows has no user ids or process groups: a process's "uid" is its session
// (services run in session 0) and each process is its own group.
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cpuFromDelta, kidsOf, readText, sh } from './shared.mjs';
import { findNativeRustBin } from '../antigravity.mjs';

export const NAME = 'Windows';
const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
export const PATHS = {
  claudeTmp: path.join(os.tmpdir(), 'claude'),
  playwright: path.join(LOCAL, 'ms-playwright'),
  npmCache: path.join(LOCAL, 'npm-cache', '_cacache'),
  // npm.cmd cannot be started without a shell: run npm's own script with this node instead
  npmClean: [process.execPath, [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'cache', 'clean', '--force']],
};
export let UID = -1;   // this server's session, known after the first reading

const SCRIPT = `$ErrorActionPreference='SilentlyContinue'
$e=[datetime]'1970-01-01'
$p=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate,SessionId | ForEach-Object { [pscustomobject]@{ i=$_.ProcessId; pp=$_.ParentProcessId; n=$_.Name; x=$_.ExecutablePath; c=$_.CommandLine; w=$_.WorkingSetSize; t=[double]($_.KernelModeTime+$_.UserModeTime); s=$(if($_.CreationDate){[int64]($_.CreationDate.ToUniversalTime()-$e).TotalSeconds}else{0}); se=$_.SessionId } }
$f=Get-CimInstance Win32_PageFileUsage | Measure-Object -Property AllocatedBaseSize,CurrentUsage -Sum
$t=Get-NetTCPConnection | ForEach-Object { [pscustomobject]@{ l=$_.LocalPort; s=[int]$_.State; o=$_.OwningProcess } }
[pscustomobject]@{ p=@($p); fa=($f|Where-Object Property -eq 'AllocatedBaseSize').Sum; fu=($f|Where-Object Property -eq 'CurrentUsage').Sum; t=@($t) } | ConvertTo-Json -Compress -Depth 3`;
const LISTEN = 2, ESTABLISHED = 5;   // MSFT_NetTCPConnection.State

/** The parsed reading: procs (Map), page file (bytes), TCP rows. Exported for tests. */
export function parseReading(json, now = Date.now()) {
  let j; try { j = JSON.parse(json); } catch { return null; }
  const procs = new Map(), list = Array.isArray(j.p) ? j.p : j.p ? [j.p] : [];
  for (const r of list) {
    if (!r || r.i == null || r.i === 0 || /^System Idle Process$/i.test(r.n || '')) continue;
    const start = Number(r.s) || 0;
    procs.set(r.i, { pid: r.i, ppid: r.pp ?? 0, pgid: r.i, uid: r.se ?? 0, rss: Number(r.w) || 0, mem: Number(r.w) || 0, start,
      up: start ? Math.max(0, Math.round(now / 1000 - start)) : 0, cpuSec: (Number(r.t) || 0) / 1e7, comm: r.x || r.n || '', args: r.c || r.n || '' });
  }
  const tcp = (Array.isArray(j.t) ? j.t : j.t ? [j.t] : []).map((r) => ({ port: Number(r.l), state: Number(r.s), pid: Number(r.o) }));
  return { procs, pageTotal: (Number(j.fa) || 0) * 1024 ** 2, pageUsed: (Number(j.fu) || 0) * 1024 ** 2, tcp };
}

let prevCpuTicks = null;
let lastCpuPct = 0;
function sampleCpuTicks() {
  let busy = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    const b = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0);
    busy += b;
    total += b + (t.idle || 0);
  }
  return { busy, total };
}
prevCpuTicks = sampleCpuTicks();

/** Accurate whole-machine CPU % from os.cpus() tick deltas across all cores. */
export function cpuPercent() {
  const cur = sampleCpuTicks();
  if (!prevCpuTicks) {
    prevCpuTicks = cur;
    return lastCpuPct;
  }
  const dTotal = cur.total - prevCpuTicks.total;
  const dBusy = cur.busy - prevCpuTicks.busy;
  if (dTotal > 0) {
    lastCpuPct = Math.max(0, Math.min(100, Math.round((dBusy / dTotal) * 100)));
    prevCpuTicks = cur;
  }
  return lastCpuPct;
}

export function parseNetstat(text = '') {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('TCP')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddr = parts[1] || '';
    const foreignAddr = parts[2] || '';
    const stateStr = (parts[3] || '').toUpperCase();
    const pid = Number(parts[parts.length - 1]) || 0;
    const portMatch = /:(\d+)$/.exec(localAddr);
    if (!portMatch) continue;
    const port = Number(portMatch[1]) || 0;
    if (!port) continue;
    let state = 0;
    if (stateStr === 'LISTENING' || stateStr === 'LISTEN' || /:0$/.test(foreignAddr)) {
      state = LISTEN;
    } else if (stateStr === 'ESTABLISHED') {
      state = ESTABLISHED;
    }
    if (state) out.push({ port, state, pid });
  }
  return out;
}

let last = null, lastAt = 0, reading = null;
const cpuState = { prev: null, at: 0 };
function read() {
  if (last && Date.now() - lastAt < 8000) return Promise.resolve(last);
  reading ??= (async () => {
    const nativeBin = findNativeRustBin();
    if (nativeBin) {
      const [rustOut, netOut] = await Promise.all([
        sh(nativeBin, ['--sys-win32'], 4000),
        sh('netstat.exe', ['-ano', '-p', 'tcp'], 3000),
      ]);
      const r = parseReading(rustOut);
      if (r && r.procs.size > 0) {
        r.tcp = parseNetstat(netOut);
        cpuFromDelta(cpuState, r.procs);
        const me = r.procs.get(process.pid);
        if (me) UID = me.uid;
        last = r;
        lastAt = Date.now();
        return r;
      }
    }
    const out = await sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], 30000);
    const r = parseReading(out);
    if (r) {
      cpuFromDelta(cpuState, r.procs);
      const me = r.procs.get(process.pid); if (me) UID = me.uid;
      last = r; lastAt = Date.now();
    }
    return last || { procs: new Map(), pageTotal: 0, pageUsed: 0, tcp: [] };
  })().finally(() => { reading = null; });
  return reading;
}
export async function processes() { const r = await read(); return { procs: r.procs, kids: kidsOf(r.procs) }; }
export async function liteProcs() { return { procs: (await read()).procs }; }
export const footprints = async () => new Map();
export const footprintAt = () => 0;
export async function memory() {
  const r = await read(), total = os.totalmem(), used = total - os.freemem(), left = 1 - used / total;
  return { total, used, compressed: 0, swapTotal: r.pageTotal, swapUsed: r.pageUsed, pressure: left < 0.08 ? 'critical' : left < 0.18 ? 'warn' : 'normal' };
}
export async function disk() {
  try { const s = await fsp.statfs(`${process.env.SystemDrive || 'C:'}\\`); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; return { total, free, used: total - free }; }
  catch { return { total: 0, free: 0, used: 0 }; }
}

/* ---------- GPU reading (NVIDIA nvidia-smi with CIM fallback) ---------- */
let lastGpu = null, lastGpuAt = 0, readingGpu = null;
function shortenGpuName(name = '') {
  const s = String(name).replace(/NVIDIA\s+GeForce\s+/i, '').replace(/AMD\s+Radeon\s+/i, '').replace(/Laptop\s+GPU/i, '').replace(/\s+/g, ' ').trim();
  return s || name || 'GPU';
}
export function parseNvidiaSmi(csv = '') {
  const line = String(csv || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const parts = line.split(',').map((x) => x.trim());
  if (parts.length < 4) return null;
  const name = parts[0] || 'NVIDIA GPU';
  const percent = Math.max(0, Math.min(100, Math.round(Number(parts[1]) || 0)));
  const vramUsedMb = Number(parts[2]) || 0;
  const vramTotalMb = Number(parts[3]) || 0;
  const temp = Number.isFinite(Number(parts[4])) ? Math.round(Number(parts[4])) : null;
  const power = Number.isFinite(Number(parts[5])) ? Math.round(Number(parts[5]) * 10) / 10 : null;
  const vramUsed = Math.round(vramUsedMb * 1024 * 1024);
  const vramTotal = Math.round(vramTotalMb * 1024 * 1024);
  const vramPct = vramTotal > 0 ? Math.min(100, Math.round((vramUsed / vramTotal) * 100)) : 0;
  return {
    name,
    shortName: shortenGpuName(name),
    percent,
    vramUsed,
    vramTotal,
    vramPct,
    temp,
    power,
  };
}
export async function gpu() {
  if (lastGpu && Date.now() - lastGpuAt < 2500) return lastGpu;
  readingGpu ??= (async () => {
    const smiOut = await sh(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
      2500,
    );
    const parsed = parseNvidiaSmi(smiOut);
    if (parsed) {
      lastGpu = parsed;
      lastGpuAt = Date.now();
      return parsed;
    }
    // Fallback for AMD / Intel / integrated GPUs via Win32_VideoController
    const cimOut = await sh(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "$g=Get-CimInstance Win32_VideoController | Select-Object -First 1 Name,AdapterRAM; if($g){[pscustomobject]@{n=$g.Name;r=$g.AdapterRAM}|ConvertTo-Json -Compress}"],
      4000,
    );
    try {
      const j = JSON.parse(cimOut);
      if (j?.n) {
        const vramTotal = Number(j.r) || 0;
        lastGpu = {
          name: j.n,
          shortName: shortenGpuName(j.n),
          percent: 0,
          vramUsed: 0,
          vramTotal,
          vramPct: 0,
          temp: null,
          power: null,
        };
        lastGpuAt = Date.now();
        return lastGpu;
      }
    } catch { /* ignore */ }
    return lastGpu;
  })().finally(() => { readingGpu = null; });
  return readingGpu;
}

export async function listeners() {
  const map = new Map();
  for (const t of (await read()).tcp) if (t.state === LISTEN && t.port && t.pid) { if (!map.has(t.pid)) map.set(t.pid, new Set()); map.get(t.pid).add(t.port); }
  return map;
}
export async function established() {
  const ports = new Map();
  for (const t of (await read()).tcp) if (t.state === ESTABLISHED && t.port) ports.set(t.port, (ports.get(t.port) || 0) + 1);
  return ports;
}
export async function cwds() { return new Map(); }   // Windows does not show another process's working folder
export async function startedAt(pid) { const p = (await read()).procs.get(pid); return p?.start ? p.start * 1000 : 0; }
/** Bytes in a folder, walked in JavaScript (no du on Windows). */
export async function folderBytes(p) {
  let total = 0;
  const walk = async (d) => {
    let items = []; try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const f = path.join(d, it.name);
      if (it.isDirectory()) await walk(f); else if (it.isFile()) { try { total += (await fsp.stat(f)).size; } catch { /* gone */ } }
    }
  };
  await walk(p);
  return total;
}

const WIN_APP_MAP = [
  [/antigravity\.exe$/i, 'Antigravity IDE'],
  [/language_server[^\\/]*\.exe$/i, 'Antigravity Engine'],
  [/chrome\.exe$/i, 'Google Chrome'],
  [/msedge\.exe$/i, 'Microsoft Edge'],
  [/firefox\.exe$/i, 'Firefox'],
  [/brave\.exe$/i, 'Brave Browser'],
  [/code\.exe$/i, 'VS Code'],
  [/cursor\.exe$/i, 'Cursor'],
  [/docker desktop\.exe$|com\.docker\.backend\.exe$/i, 'Docker Desktop'],
  [/tailscale[^\\/]*\.exe$/i, 'Tailscale'],
  [/discord\.exe$/i, 'Discord'],
  [/telegram\.exe$/i, 'Telegram'],
  [/zalo\.exe$/i, 'Zalo'],
  [/slack\.exe$/i, 'Slack'],
  [/spotify\.exe$/i, 'Spotify'],
  [/obs64\.exe$/i, 'OBS Studio'],
  [/windowsterminal\.exe$/i, 'Windows Terminal'],
  [/explorer\.exe$/i, 'Windows Explorer'],
];
export function appOf(comm = '') {
  if (!comm) return null;
  const s = String(comm).trim();
  for (const [re, label] of WIN_APP_MAP) {
    if (re.test(s)) return label;
  }
  if (/\\Program Files|\\AppData\\Local\\Programs/i.test(s)) {
    const base = path.basename(s).replace(/\.exe$/i, '');
    if (base && !/^(node|conhost|svchost|powershell|pwsh|cmd|git|rg)$/i.test(base)) return base;
  }
  return null;
}

export async function claudeLogin(dir = CLAUDE_DIR) {
  try { return JSON.parse(await readText(path.join(dir, '.credentials.json'))).claudeAiOauth || null; } catch { return null; }
}
