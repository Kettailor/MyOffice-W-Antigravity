#!/usr/bin/env node
// One-command Docker + Rust + Host Bridge controller (`scripts/docker-ctl.mjs`).
// Usage:
//   node scripts/docker-ctl.mjs up       -> Starts Host Bridge (4311), frees standalone Node (4310), builds & runs Docker container
//   node scripts/docker-ctl.mjs down     -> Stops Docker container and Host Bridge
//   node scripts/docker-ctl.mjs restart  -> Restarts Docker container and ensures Host Bridge is running
//   node scripts/docker-ctl.mjs bridge   -> Ensures Host Bridge (4311) is running and synced
//   node scripts/docker-ctl.mjs status   -> Prints JSON status of Docker container, Host Bridge, and Rust Native Engine
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const action = (process.argv[2] || 'up').toLowerCase();

function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureDockerDaemon() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch {
    if (process.platform === 'win32') {
      const dockerExe = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
      if (fs.existsSync(dockerExe)) {
        console.log('[docker-ctl] Starting Docker Desktop...');
        spawn(dockerExe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
            return true;
          } catch { /* wait */ }
        }
      }
    }
    return false;
  }
}

function stopStandaloneNodeOnPort(port) {
  if (process.platform !== 'win32') return;
  try {
    const netOut = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { timeout: 3000, windowsHide: true }).toString('utf8');
    const pids = new Set();
    for (const raw of netOut.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('TCP')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;
      if (parts[1].endsWith(`:${port}`) && (parts[3] === 'LISTENING' || parts[2].endsWith(':0'))) {
        const pid = Number(parts[parts.length - 1]);
        if (pid > 4 && pid !== process.pid) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        const tl = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { timeout: 2000, windowsHide: true }).toString('utf8');
        if (/node\.exe/i.test(tl)) {
          process.kill(pid, 'SIGTERM');
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function isBridgeWatcherUp() {
  const watcherFile = path.join(ROOT, 'data', 'bridge-watcher.json');
  try {
    if (fs.existsSync(watcherFile)) {
      const j = JSON.parse(fs.readFileSync(watcherFile, 'utf8'));
      const pid = Number(j?.pid);
      if (pid > 1) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          if (e && e.code === 'EPERM') return true;
        }
      }
      if (j?.ok && Date.now() - (Number(j.at) || 0) < 35_000) return true;
    }
  } catch { /* ignore */ }
  if (process.platform === 'win32') {
    try {
      const tl = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq work-office-native.exe', '/NH'], { timeout: 2000, windowsHide: true }).toString('utf8');
      if (/work-office-native\.exe/i.test(tl)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

async function ensureBridgeWatcher() {
  const stopFlag = path.join(ROOT, 'data', '.bridge-stopped');
  try { if (fs.existsSync(stopFlag)) fs.unlinkSync(stopFlag); } catch { /* ignore */ }
  if (isBridgeWatcherUp()) return true;
  const binName = process.platform === 'win32' ? 'work-office-native.exe' : 'work-office-native';
  const rustBin = path.join(ROOT, 'bin', binName);
  if (!fs.existsSync(rustBin)) return false;
  if (process.platform === 'win32') {
    try {
      const cmdLine = `"${rustBin}" watch-bridge "${ROOT}"`.replace(/'/g, "''");
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
    } catch {
      const child = spawn(rustBin, ['watch-bridge', ROOT], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
  } else {
    const child = spawn(rustBin, ['watch-bridge', ROOT], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (isBridgeWatcherUp()) return true;
  }
  return isBridgeWatcherUp();
}

async function ensureHostBridge() {
  const stopFlag = path.join(ROOT, 'data', '.bridge-stopped');
  try { if (fs.existsSync(stopFlag)) fs.unlinkSync(stopFlag); } catch { /* ignore */ }
  const watcherReady = await ensureBridgeWatcher();
  if (await checkPort(4311)) {
    console.log('[docker-ctl] Host Bridge already active on port 4311 (On-Demand Watcher ready).');
    return true;
  }
  console.log('[docker-ctl] Waking up Host Bridge on port 4311 (On-Demand, auto-stops after 45s idle)...');
  try {
    fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'data', 'bridge-wakeup.json'), JSON.stringify({
      requestedAt: Date.now(),
      reason: 'docker-ctl',
    }));
  } catch { /* ignore */ }
  if (!watcherReady) {
    const bridgeScript = path.join(ROOT, 'server', 'host-bridge.mjs');
    const child = spawn(process.execPath, [bridgeScript, '--on-demand'], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await checkPort(4311)) {
      console.log('[docker-ctl] Host Bridge ready on port 4311 (On-Demand mode).');
      return true;
    }
  }
  return watcherReady;
}

async function main() {
  if (action === 'status') {
    const [officeUp, bridgePortUp] = await Promise.all([checkPort(4310), checkPort(4311)]);
    const bridgeWatcherUp = isBridgeWatcherUp();
    const bridgeUp = bridgePortUp || bridgeWatcherUp;
    let containerRunning = false;
    try {
      const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', 'work-office'], { timeout: 3000, windowsHide: true }).toString('utf8').trim();
      containerRunning = out === 'true';
    } catch { /* ignore */ }
    const binName = process.platform === 'win32' ? 'work-office-native.exe' : 'work-office-native';
    const rustBin = fs.existsSync(path.join(ROOT, 'bin', binName));
    console.log(JSON.stringify({
      ok: true,
      containerRunning,
      officeUp,
      bridgeUp,
      bridgePortUp,
      bridgeWatcherUp,
      bridgeMode: 'on-demand',
      rustNativeReady: rustBin,
    }, null, 2));
    return;
  }

  if (action === 'bridge' || action === 'ensure-bridge') {
    await ensureHostBridge();
    return;
  }

  if (action === 'down') {
    const stopFlag = path.join(ROOT, 'data', '.bridge-stopped');
    try {
      fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
      fs.writeFileSync(stopFlag, String(Date.now()));
    } catch { /* ignore */ }
    try {
      execFileSync('docker', ['compose', 'down'], { cwd: ROOT, stdio: 'inherit' });
    } catch { /* ignore */ }
    stopStandaloneNodeOnPort(4311);
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/F', '/IM', 'work-office-native.exe'], { stdio: 'ignore', timeout: 2000, windowsHide: true }); } catch { /* ignore */ }
    }
    try { fs.rmSync(path.join(ROOT, 'data', 'bridge-watcher.json'), { force: true }); } catch { /* ignore */ }
    console.log('[docker-ctl] Work Office Docker container & Host Bridge stopped.');
    return;
  }

  const ready = await ensureDockerDaemon();
  if (!ready) {
    console.error('[docker-ctl] Docker daemon is not running. Please start Docker Desktop.');
    process.exit(1);
  }

  await ensureHostBridge();

  if (action === 'restart') {
    execFileSync('docker', ['compose', 'restart'], { cwd: ROOT, stdio: 'inherit' });
    return;
  }

  // Stop any standalone node.exe occupying port 4310 so Docker can bind 4310:4310 cleanly
  stopStandaloneNodeOnPort(4310);
  execFileSync('docker', ['compose', 'up', '-d', '--build'], { cwd: ROOT, stdio: 'inherit' });
}

main().catch((err) => {
  console.error('[docker-ctl] Error:', err?.message || err);
  process.exit(1);
});
