#!/usr/bin/env node
/**
 * Export a clean, sanitized copy of the project for GitHub release.
 *
 * Usage:
 *   node scripts/export-github.mjs [targetDir]
 *
 * Default targetDir: ../WorkOffice-GitHub
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET = path.resolve(process.argv[2] || path.join(ROOT, '..', 'WorkOffice-GitHub'));

const EXCLUDE_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'AGENTS.md',
  'CLAUDE.md',
]);

const EXCLUDE_PREFIXES = [
  'data/',
  '.agents/',
  '.gemini/',
  '.claude/',
  'node_modules/',
  '.next/',
  'dist/',
  'coverage/',
  'rust-native/target/',
];

const SENSITIVE_PATTERNS = [
  { label: 'Hardcoded Wi-Fi SSID (Ket)', re: /['"`]Ket['"`]|SSID\s*=\s*Ket/ },
  { label: 'Personal Windows Username (lekie/lekiet)', re: /C:[/\\]+Users[/\\]+lekie/i },
  { label: 'Personal Tailscale IP', re: /\b100\.107\.115\.111\b/ },
  { label: 'Personal LAN IP (192.168.1.x)', re: /\b192\.168\.1\.\d{1,3}\b/ },
];

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml',
  '.css', '.html', '.rs', '.toml', '.bat', '.sh', '.ps1', '.example',
]);

function shouldExclude(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (EXCLUDE_FILES.has(norm)) return true;
  for (const prefix of EXCLUDE_PREFIXES) {
    if (norm.startsWith(prefix)) return true;
  }
  return false;
}

function getTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !shouldExclude(f));
}

function main() {
  console.log(`[export-github] Source: ${ROOT}`);
  console.log(`[export-github] Target: ${TARGET}`);

  const files = getTrackedFiles();
  for (const extra of ['.env.example', 'scripts/export-github.mjs']) {
    if (!files.includes(extra) && fs.existsSync(path.join(ROOT, extra))) {
      files.push(extra);
    }
  }

  // Clean existing files in target (except .git if already initialized)
  fs.mkdirSync(TARGET, { recursive: true });
  for (const entry of fs.readdirSync(TARGET)) {
    if (entry === '.git') continue;
    fs.rmSync(path.join(TARGET, entry), { recursive: true, force: true });
  }

  let copied = 0;
  const findings = [];

  for (const rel of files) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    const dst = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied++;

    const ext = path.extname(rel).toLowerCase() || (rel.startsWith('.env') ? '.example' : '');
    if (TEXT_EXTS.has(ext)) {
      const content = fs.readFileSync(dst, 'utf8');
      for (const pat of SENSITIVE_PATTERNS) {
        if (pat.re.test(content)) {
          findings.push({ file: rel, reason: pat.label });
        }
      }
    }
  }

  // Create empty data/.gitkeep so runtime directory structure is clear
  const dataDir = path.join(TARGET, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.gitkeep'), '', 'utf8');

  if (findings.length > 0) {
    console.error('[export-github] ERROR: Sensitive patterns detected in exported files:');
    for (const f of findings) {
      console.error(`  - ${f.file}: ${f.reason}`);
    }
    process.exit(1);
  }

  // Initialize git repo in target if not already present
  if (!fs.existsSync(path.join(TARGET, '.git'))) {
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: TARGET, stdio: 'ignore' });
    } catch {
      execFileSync('git', ['init'], { cwd: TARGET, stdio: 'ignore' });
    }
  }

  console.log(`[export-github] Copied ${copied} clean files to ${TARGET}`);
  console.log('[export-github] Security & privacy audit: 0 sensitive patterns found (PASS)');
}

main();
