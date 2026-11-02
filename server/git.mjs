// Git in the office. For each open session's folder: the repository's branch, how many files are changed and not yet
// committed (that desk gets messier), commits and pushes (the printer prints, the rocket launches), and the latest CI run
// on GitHub (a red beacon in the server room when it fails). Commits and pushes are noticed by watching HEAD and the
// upstream, so they count whether Claude or you made them. Read with `git` and `gh` on this Mac, only while an office
// page is open; nothing is written. OFFICE_CI=0 stops the GitHub check.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveContainerDir } from './tasks.mjs';

const run = (cmd, args, cwd, timeout = 5000) => new Promise((res) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => res(err ? null : String(out)));
});
// gh: GH_PATH, the usual install places, then anywhere on PATH (gh.exe on Windows)
const EXE = process.platform === 'win32' ? 'gh.exe' : 'gh';
const GH = [process.env.GH_PATH, path.join(os.homedir(), '.local/bin/gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh',
  ...(process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', EXE)] : []),
  ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, EXE))].find((p) => p && fs.existsSync(p)) || null;
const CI_ON = process.env.OFFICE_CI !== '0';

/**
 * @param {{ onRepo: (r: object) => void, onCommit: (r: object, subject: string) => void, onPush: (r: object) => void, onPull?: (r: object, branch: string) => void, onInitRepo?: (r: object, events: Array<object>) => void, onCi: (r: object, was: string|null) => void }} o
 */
export function createGit({ onRepo, onCommit, onPush, onPull, onInitRepo, onCi }) {
  const roots = new Map();   // normalized folder -> normalized repository root
  const repos = new Map();   // root -> { root, name, branch, dirty, staged, modified, untracked, ahead, behind, totalCommits, todayCommits, lastCommit, lastReflog, remoteReflog, head, upstream, ci, ciName, ciUrl, born }
  let polling = null, ciPolling = null;

  function parseRefLine(line = '') {
    const trimmed = String(line || '').trim();
    if (!trimmed) return null;
    const parts = trimmed.split('|');
    if (parts.length < 3) return null;
    const ct = Number(parts.pop()) || 0;
    const hash = parts.shift() || '';
    const text = parts.join('|').trim();
    return { hash, text, ts: ct ? ct * 1000 : Date.now() };
  }

  async function rootOf(rawCwd) {
    if (!rawCwd) return '';
    const localCwd = resolveContainerDir(String(rawCwd));
    const cwd = path.resolve(localCwd || String(rawCwd));
    if (roots.has(cwd)) return roots.get(cwd);
    if (roots.has(String(rawCwd))) return roots.get(String(rawCwd));
    const out = await run('git', ['rev-parse', '--show-toplevel'], cwd);
    if (out && out.trim()) {
      const normRoot = path.resolve(out.trim());
      if (roots.size >= 200) {
        const oldest = roots.keys().next().value;
        if (oldest !== undefined) roots.delete(oldest);
      }
      roots.set(cwd, normRoot);
      roots.set(String(rawCwd), normRoot);
      return normRoot;
    }
    return '';
  }

  function repoOf(rawCwd) {
    if (!rawCwd) return null;
    const localCwd = resolveContainerDir(String(rawCwd));
    const norm = path.resolve(localCwd || String(rawCwd));
    const mapped = roots.get(norm) || roots.get(String(rawCwd));
    if (mapped && repos.has(mapped)) return repos.get(mapped);
    const normLow = norm.toLowerCase();
    for (const r of repos.values()) {
      if (!r?.root) continue;
      const rLow = r.root.toLowerCase();
      if (normLow === rLow || normLow.startsWith(rLow + path.sep)) return r;
    }
    return null;
  }

  async function read(root) {
    // GIT_OPTIONAL_LOCKS=0: `git status` must not take the index lock while Claude/Antigravity is committing in the same repo
    const [status, head, branchOut, totalCommitsOut, todayLogOut, lastCommitOut, reflogOut] = await Promise.all([
      run('git', ['status', '--porcelain=v1', '--branch', '-uall'], root, 8000),
      run('git', ['rev-parse', 'HEAD'], root),
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root),
      run('git', ['rev-list', '--count', 'HEAD'], root),
      run('git', ['log', '--since=00:00:00', '--oneline'], root),
      run('git', ['log', '-1', '--format=%h|%s|%ct'], root),
      run('git', ['reflog', '-1', '--format=%H|%gs|%ct'], root),
    ]);
    if (status == null) return null;
    const lines = status.split(/\r?\n/).filter(Boolean);
    const rawHeaderBranch = (lines[0] || '')
      .replace(/^## /, '')
      .replace(/^No commits yet on /, '')
      .replace(/^Initial commit on /, '')
      .split('...')[0]
      .trim();
    const fallbackBranch = (branchOut || '').trim();
    const branch = (rawHeaderBranch && !/^HEAD\b/i.test(rawHeaderBranch))
      ? rawHeaderBranch
      : (fallbackBranch && fallbackBranch !== 'HEAD' ? fallbackBranch : rawHeaderBranch || 'main');

    const fileLines = lines.slice(1);
    const dirty = fileLines.length;
    const untracked = fileLines.filter((l) => l.startsWith('??')).length;
    const staged = fileLines.filter((l) => !l.startsWith('??') && l[0] && l[0] !== ' ').length;
    const modified = fileLines.filter((l) => !l.startsWith('??') && l[1] && l[1] !== ' ').length;

    const todayCommits = todayLogOut ? todayLogOut.split(/\r?\n/).filter(Boolean).length : 0;
    const totalCommits = Number((totalCommitsOut || '').trim()) || 0;

    const parsedCommit = parseRefLine(lastCommitOut);
    const lastCommit = parsedCommit ? { hash: parsedCommit.hash, subject: parsedCommit.text, ts: parsedCommit.ts } : null;

    const parsedReflog = parseRefLine(reflogOut);
    const lastReflog = parsedReflog ? { hash: parsedReflog.hash, action: parsedReflog.text, ts: parsedReflog.ts } : null;

    let upstream = ((await run('git', ['rev-parse', '@{u}'], root)) || '').trim();
    let refSpec = upstream ? '@{u}' : '';
    if (!upstream && branch) {
      const orig = ((await run('git', ['rev-parse', `origin/${branch}`], root)) || '').trim();
      if (orig) {
        upstream = orig;
        refSpec = `origin/${branch}`;
      }
    }

    let ahead = totalCommits;
    let behind = 0;
    if (refSpec) {
      const lrOut = ((await run('git', ['rev-list', '--left-right', '--count', `${refSpec}...HEAD`], root)) || '').trim();
      if (lrOut) {
        const [bStr, aStr] = lrOut.split(/\s+/);
        behind = Number(bStr) || 0;
        ahead = Number(aStr) || 0;
      } else {
        ahead = 0;
        behind = 0;
      }
    }

    let remoteReflog = null;
    if (branch) {
      const remRef = ((await run('git', ['reflog', 'show', `origin/${branch}`, '-1', '--format=%H|%gs|%ct'], root)) || '').trim();
      const parsedRem = parseRefLine(remRef);
      if (parsedRem) remoteReflog = { hash: parsedRem.hash, action: parsedRem.text, ts: parsedRem.ts };
    }

    return {
      branch,
      dirty,
      staged,
      modified,
      untracked,
      head: (head || '').trim(),
      upstream,
      ahead,
      behind,
      totalCommits,
      todayCommits,
      lastCommit,
      lastReflog,
      remoteReflog,
    };
  }

  async function pollNow(cwds) {
    const live = new Set();
    for (const cwd of new Set(cwds)) {
      if (!cwd) continue;
      const r = await rootOf(cwd);
      if (r) live.add(r);
    }
    for (const root of live) {
      const now = await read(root);
      if (!now) continue;
      const was = repos.get(root);
      const cur = { ...(was || { ci: null, ciName: '', ciUrl: '' }), ...now, root, name: path.basename(root) };
      // its birthday, once: the oldest root commit's date (the office's monthly party, people/hr.js)
      if (cur.born === undefined) {
        cur.born = (((await run('git', ['log', '--max-parents=0', '--reverse', '--format=%as'], root)) || '').trim().split(/\r?\n/)[0]) || null;
      }
      repos.set(root, cur);

      if (!was) {
        const [headReflogToday, remReflogToday] = await Promise.all([
          run('git', ['reflog', '--since=00:00:00', '--format=%H|%gs|%ct'], root),
          cur.branch ? run('git', ['reflog', 'show', `origin/${cur.branch}`, '--since=00:00:00', '--format=%H|%gs|%ct'], root) : Promise.resolve(null),
        ]);
        const recentEvents = [];
        for (const line of String(headReflogToday || '').split(/\r?\n/).filter(Boolean)) {
          const p = parseRefLine(line);
          if (!p) continue;
          const cm = /^commit(?:\s*\([^)]+\))?:\s*(.*)$/i.exec(p.text);
          if (cm) {
            recentEvents.push({ type: 'commit', label: cm[1].trim() || cur.lastCommit?.subject || 'commit', ts: p.ts });
          } else if (/^pull\b/i.test(p.text)) {
            recentEvents.push({ type: 'pull', label: cur.branch, ts: p.ts });
          }
        }
        for (const line of String(remReflogToday || '').split(/\r?\n/).filter(Boolean)) {
          const p = parseRefLine(line);
          if (!p) continue;
          if (/update by push/i.test(p.text)) {
            recentEvents.push({ type: 'push', label: cur.branch, ts: p.ts });
          }
        }
        recentEvents.sort((a, b) => a.ts - b.ts);
        onInitRepo?.(cur, recentEvents);
        onRepo?.(cur);
        continue;
      }

      const refChanged = Boolean(cur.lastReflog?.ts && cur.lastReflog.ts !== was.lastReflog?.ts);
      const headChanged = Boolean(cur.head && cur.head !== was.head);
      const isPull = (refChanged || headChanged) && /^pull\b/i.test(cur.lastReflog?.action || '');
      if (isPull) {
        onPull?.(cur, cur.branch);
      }

      const isCommit = !isPull && (headChanged || (refChanged && /^commit\b/i.test(cur.lastReflog?.action || '')));
      if (isCommit) {
        const subject = cur.lastCommit?.subject
          || ((await run('git', ['log', '-1', '--pretty=%s'], root)) || '').trim()
          || 'commit';
        onCommit?.(cur, subject);
      }

      const remChanged = Boolean(cur.remoteReflog?.ts && cur.remoteReflog.ts !== was.remoteReflog?.ts && /push/i.test(cur.remoteReflog?.action || ''));
      const upChanged = Boolean(cur.upstream && cur.upstream !== was.upstream && cur.upstream === cur.head && !isPull);
      const aheadCleared = Boolean(was.ahead > 0 && cur.ahead === 0 && cur.head === was.head);
      if (remChanged || upChanged || aheadCleared) {
        onPush?.(cur);
      }

      if (
        was.dirty !== cur.dirty ||
        was.staged !== cur.staged ||
        was.modified !== cur.modified ||
        was.untracked !== cur.untracked ||
        was.branch !== cur.branch ||
        was.ahead !== cur.ahead ||
        was.behind !== cur.behind ||
        was.totalCommits !== cur.totalCommits ||
        was.todayCommits !== cur.todayCommits ||
        was.head !== cur.head ||
        was.upstream !== cur.upstream
      ) {
        onRepo?.(cur);
      }
    }
    for (const root of [...repos.keys()]) if (!live.has(root)) repos.delete(root);
  }
  async function pollCiNow() {
    if (!CI_ON || !GH) return;
    for (const r of [...repos.values()]) {
      if (!r.branch) continue;
      const out = await run(GH, ['run', 'list', '--limit', '10', '--branch', r.branch, '--json', 'status,conclusion,workflowName,url,event'], r.root, 15000);
      if (out == null) continue;   // not a GitHub repository, offline, or gh not logged in
      // the checks of the code (runs started by a push or a pull request), not a scheduled job that happens to be newer
      let runs; try { runs = JSON.parse(out); } catch { continue; }
      const last = runs.find((x) => x.event === 'push' || x.event === 'pull_request') || runs[0];
      const state = !last ? null : last.status !== 'completed' ? 'running' : last.conclusion === 'success' ? 'green'
        : ['failure', 'timed_out', 'startup_failure'].includes(last.conclusion) ? 'red' : null;
      const was = r.ci;
      Object.assign(r, { ci: state, ciName: last?.workflowName || '', ciUrl: last?.url || '' });
      if (was !== state) { onRepo(r); if (state === 'red' || (was === 'red' && state === 'green')) onCi(r, was); }
    }
  }
  return {
    // one poll at a time; a second request while one runs is dropped
    poll: (cwds) => (polling ??= pollNow(cwds).finally(() => { polling = null; })),
    pollCi: () => (ciPolling ??= pollCiNow().finally(() => { ciPolling = null; })),
    repoOf,
    rootOf,
    ghAvailable: !!GH && CI_ON,
  };
}
