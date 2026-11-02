import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redact } from '../../server/redact.mjs';
import { hashPinSecret, signSessionToken, createAccessManager } from '../../server/access.mjs';
import { findNativeRustBin } from '../../server/antigravity.mjs';

test('masks bearer tokens, API keys and GitHub tokens', () => {
  assert.doesNotMatch(redact('curl -H "Authorization: Bearer abc.def.ghi"'), /abc\.def\.ghi/);
  assert.equal(redact('export KEY=sk-live_1234567890abcdef'), 'export KEY=•••');
  assert.match(redact('git clone https://ghp_ABCDEFGHIJ1234567890@github.com/x/y'), /•••/);
  assert.doesNotMatch(redact('token: hunter2'), /hunter2/);
});

test('masks credentials in URLs and IP addresses', () => {
  assert.equal(redact('postgres://admin:s3cret@db.local/app'), 'postgres://•••@db.local/app');
  assert.equal(redact('ssh root@143.198.87.247'), 'ssh root@•••');
});

test('keeps ordinary text', () => {
  assert.equal(redact('npm run build && git status'), 'npm run build && git status');
  assert.equal(redact(null), '');
});

test('access security: hashPinSecret, signSessionToken and getSecurityStatus', () => {
  const h1 = hashPinSecret('123456', 'work-office-salt');
  const h2 = hashPinSecret('654321', 'work-office-salt');
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.notEqual(h1, h2);

  const sig = signSessionToken('mem-test', 'secret-xyz');
  assert.match(sig, /^[0-9a-f]{24}$/);
  assert.equal(sig, signSessionToken('mem-test', 'secret-xyz'));

  const mgr = createAccessManager({ dataDir: path.join(os.tmpdir(), `wo-sec-test-${process.pid}`) });
  const sec = mgr.getSecurityStatus();
  assert.equal(sec.ok, true);
  assert.equal(sec.engine, 'rust-native');
  assert.equal(sec.lanBlocked, true);
  assert.equal(sec.secretRedaction, true);
});

test('Native Rust binary: --hash-pin and --redact match security expectations', () => {
  const bin = findNativeRustBin();
  if (!bin) return;
  const rustHash = execFileSync(bin, ['--hash-pin', '123456', 'work-office-salt'], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.equal(rustHash, hashPinSecret('123456', 'work-office-salt'));

  const rustRedacted = execFileSync(bin, ['--redact', 'Bearer sk-1234567890abcdef ghp_ABCDEFGHIJ1234567890'], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.doesNotMatch(rustRedacted, /sk-1234567890abcdef/);
  assert.doesNotMatch(rustRedacted, /ghp_ABCDEFGHIJ1234567890/);
  assert.match(rustRedacted, /•••/);
});

