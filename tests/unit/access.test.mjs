import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccessManager } from '../../server/access.mjs';

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
