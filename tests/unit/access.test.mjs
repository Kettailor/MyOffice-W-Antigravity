import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccessManager, normalizeGender } from '../../server/access.mjs';

test('AccessManager: session permissions (stop, edit, delete) across connected roles and global toggles', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-office-access-test-'));
  try {
    const access = createAccessManager({ dataDir: tmpDir });

    // 1. Default global permissions are enabled
    const initState = access.pubState();
    assert.equal(initState.allowStopSession, true);
    assert.equal(initState.allowEditSession, true);
    assert.equal(initState.allowDeleteSession, true);

    // 2. Director device (Phó Giám đốc) always has full session permissions
    const dirMember = access.createDirectorDeviceMember({ ip: '100.64.0.10', userAgent: 'iPhone' });
    assert.equal(access.canControlSession(dirMember, 'stop', 'E:\\WorkOffice'), true);
    assert.equal(access.canControlSession(dirMember, 'edit', 'E:\\WorkOffice'), true);
    assert.equal(access.canControlSession(dirMember, 'delete', 'E:\\WorkOffice'), true);

    // 3. Remote member (Trợ lý Giám đốc / Quản lý Dự án) approved for a workspace
    const fakeReq = {
      socket: { remoteAddress: '100.64.0.25' },
      headers: { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' },
    };
    const reqMember = access.createOrUpdateRequest(fakeReq, {
      name: 'Lan Trợ Lý',
      defaultWorkspaces: ['E:\\WorkOffice'],
    });
    // Pending member cannot control session
    assert.equal(access.canControlSession(reqMember, 'stop', 'E:\\WorkOffice'), false);

    // Approve member with stop=true, edit=true, delete=false
    const approved = access.approveMember(reqMember.id, {
      role: 'Quản lý Dự án',
      allowedWorkspaces: ['E:\\WorkOffice'],
      canStopSession: true,
      canEditSession: true,
      canDeleteSession: false,
    });
    assert.equal(approved.role, 'Quản lý Dự án');
    assert.equal(access.canControlSession(approved, 'stop', 'E:\\WorkOffice'), true);
    assert.equal(access.canControlSession(approved, 'edit', 'E:\\WorkOffice\\src'), true);
    assert.equal(access.canControlSession(approved, 'delete', 'E:\\WorkOffice'), false);
    // Cannot control sessions in unapproved workspace
    assert.equal(access.canControlSession(approved, 'stop', 'E:\\OtherSecretProject'), false);

    // 4. Updating member permissions dynamically grants delete
    const updated = access.updateMember(approved.id, {
      canDeleteSession: true,
    });
    assert.equal(access.canControlSession(updated, 'delete', 'E:\\WorkOffice'), true);

    // 5. Global toggle disables delete for remote roles while keeping Director Device allowed
    access.setSessionPermissions({ allowDeleteSession: false });
    assert.equal(access.canControlSession(updated, 'delete', 'E:\\WorkOffice'), false);
    assert.equal(access.canControlSession(updated, 'stop', 'E:\\WorkOffice'), true);
    assert.equal(access.canControlSession(dirMember, 'delete', 'E:\\WorkOffice'), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('AccessManager: stores and updates gender, canEditFiles, and updateSelfProfile', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-office-access-profile-'));
  try {
    const access = createAccessManager({ dataDir: tmpDir });

    assert.equal(normalizeGender('female'), 'female');
    assert.equal(normalizeGender('male'), 'male');
    assert.equal(normalizeGender('unknown'), 'male');

    // 1. Director device defaults to canEditFiles=true and normalizes gender
    const vp = access.createDirectorDeviceMember({
      name: 'Phó Giám đốc Linh',
      gender: 'female',
      ip: '100.64.0.11',
      ua: 'Safari · iOS',
    });
    assert.equal(vp.gender, 'female');
    assert.equal(vp.canEditFiles, true);

    // 2. Remote assistant defaults to canEditFiles=false and gender='male' when unspecified
    const assistReq = {
      socket: { remoteAddress: '100.64.0.42' },
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0' },
    };
    const pending = access.createOrUpdateRequest(assistReq, {
      name: 'Minh Tuấn',
      role: 'Trợ lý Giám đốc',
    });
    assert.equal(pending.gender, 'male');
    assert.equal(pending.canEditFiles, false);

    // 3. Approving member can grant canEditFiles and update gender
    const approved = access.approveMember(pending.id, {
      gender: 'female',
      canEditFiles: true,
      allowedWorkspaces: ['E:\\WorkOffice'],
    });
    assert.equal(approved.gender, 'female');
    assert.equal(approved.canEditFiles, true);
    assert.equal(approved.rawCanEditFiles, true);

    // 4. updateMember can toggle canEditFiles and gender
    const toggled = access.updateMember(pending.id, {
      gender: 'male',
      canEditFiles: false,
    });
    assert.equal(toggled.gender, 'male');
    assert.equal(toggled.canEditFiles, false);

    // 5. updateSelfProfile updates name & gender by member id, object, or request cookie
    const selfById = access.updateSelfProfile(pending.id, {
      name: 'Minh Tuấn (PM)',
      gender: 'female',
    });
    assert.ok(selfById);
    assert.equal(selfById.name, 'Minh Tuấn (PM)');
    assert.equal(selfById.gender, 'female');

    const cookieHeader = access.memberCookieHeader(pending).split(';')[0];
    const reqWithCookie = {
      socket: { remoteAddress: '100.64.0.42' },
      headers: { cookie: cookieHeader },
    };
    const selfByReq = access.updateSelfProfile(reqWithCookie, {
      name: 'Minh Tuấn Official',
      gender: 'male',
    });
    assert.ok(selfByReq);
    assert.equal(selfByReq.name, 'Minh Tuấn Official');
    assert.equal(selfByReq.gender, 'male');

    // Wait for async save() queue to flush to disk and verify reloaded state
    let reloadedAssist = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 40));
      const reloaded = createAccessManager({ dataDir: tmpDir });
      reloadedAssist = reloaded.pubState().members.find((m) => m.id === pending.id);
      if (reloadedAssist?.name === 'Minh Tuấn Official') break;
    }
    assert.ok(reloadedAssist);
    assert.equal(reloadedAssist.name, 'Minh Tuấn Official');
    assert.equal(reloadedAssist.gender, 'male');
    assert.equal(reloadedAssist.canEditFiles, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

