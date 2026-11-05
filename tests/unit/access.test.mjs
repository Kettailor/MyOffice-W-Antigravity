import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAccessManager,
  isPathAllowed,
  normalizeGender,
  renderRemoteAccessPage,
} from '../../server/access.mjs';
import { createChatEngine } from '../../src/shared/chat-engine.js';

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

test('AccessManager Security: No IP Fallback Auth, strict parent workspace isolation, and DOM XSS escaping', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-office-access-sec-'));
  try {
    const access = createAccessManager({ dataDir: tmpDir });

    // 1. No IP Fallback Auth for approved assistant or Director Device
    const sharedIp = '100.64.0.99';
    const uaHeader = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1';
    const assistReq = {
      socket: { remoteAddress: sharedIp },
      headers: { 'user-agent': uaHeader },
    };
    const pendingMember = access.createOrUpdateRequest(assistReq, {
      name: 'Trợ lý Bảo Mật',
      role: 'Trợ lý Giám đốc',
    });
    access.approveMember(pendingMember.id, {
      allowedWorkspaces: ['E:\\WorkOffice\\subproject'],
    });

    const directorDevice = access.createDirectorDeviceMember({
      name: 'Phó Giám đốc IP 99',
      ip: sharedIp,
      ua: 'Safari · iOS',
    });

    // Request from the exact same IP + User-Agent WITHOUT office_member cookie must NOT authenticate
    const reqWithoutCookie = {
      socket: { remoteAddress: sharedIp },
      headers: { 'user-agent': uaHeader },
    };
    assert.equal(access.getApprovedMember(reqWithoutCookie), null);
    assert.equal(access.getMemberFromReq(reqWithoutCookie), null);

    // Request WITH valid signed office_member cookie authenticates accurately
    const assistCookie = access.memberCookieHeader(pendingMember).split(';')[0];
    const reqWithAssistCookie = {
      socket: { remoteAddress: sharedIp },
      headers: { 'user-agent': uaHeader, cookie: assistCookie },
    };
    const authAssist = access.getApprovedMember(reqWithAssistCookie);
    assert.ok(authAssist);
    assert.equal(authAssist.id, pendingMember.id);

    const directorCookie = access.memberCookieHeader(directorDevice).split(';')[0];
    const reqWithDirectorCookie = {
      socket: { remoteAddress: sharedIp },
      headers: { 'user-agent': uaHeader, cookie: directorCookie },
    };
    const authDirector = access.getApprovedMember(reqWithDirectorCookie);
    assert.ok(authDirector);
    assert.equal(authDirector.id, directorDevice.id);
    assert.equal(authDirector.isDirectorDevice, true);

    // 2. Strict workspace scoping: child workspace grant must NOT allow viewing parent workspace
    assert.equal(isPathAllowed('E:\\WorkOffice\\subproject', ['E:\\WorkOffice\\subproject']), true);
    assert.equal(isPathAllowed('E:\\WorkOffice\\subproject\\src', ['E:\\WorkOffice\\subproject']), true);
    assert.equal(isPathAllowed('E:\\WorkOffice', ['E:\\WorkOffice\\subproject']), false);
    assert.equal(access.canSeeWorkspace(authAssist, 'E:\\WorkOffice\\subproject'), true);
    assert.equal(access.canSeeWorkspace(authAssist, 'E:\\WorkOffice'), false);

    // 3. renderRemoteAccessPage includes escHtml helper and escapes server-side & client-side interpolation
    const html = renderRemoteAccessPage({
      member: {
        name: '<img src=x onerror=alert(1)>',
        role: 'Trợ lý Giám đốc',
        status: 'pending',
        gender: 'female',
      },
    });
    assert.ok(html.includes('function escHtml(s)'), 'renderRemoteAccessPage must define escHtml() in client script');
    assert.ok(html.includes('escHtml(d.name)') && html.includes('escHtml(d.role)'), 'waitInfo.innerHTML must escape d.name and d.role via escHtml');
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'server-side template must escape HTML tags in member.name');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ChatEngine Security: recall() enforces message ownership for non-director members', () => {
  let savedData = null;
  const engine = createChatEngine({
    tr: (k) => k,
    now: () => Date.now(),
    members: () => [],
    store: {
      load: () => savedData,
      save: (d) => { savedData = d; },
    },
    emit: () => {},
    timer: () => null,
  });

  // Member A sends a message
  const msgA = engine.fromBoss('Báo cáo tiến độ từ Trợ lý A', null, [], {
    whoId: 'mem-alice',
    whoName: 'Alice',
    whoRole: 'Trợ lý Giám đốc',
    humanOnly: true,
  });
  assert.ok(msgA);
  assert.equal(msgA.whoId, 'mem-alice');
  assert.equal(Boolean(msgA.recalled), false);

  // Non-director Member B ('mem-bob') cannot recall Member A's message
  const bobAttempt = engine.recall(msgA.id, 'mem-bob', false);
  assert.equal(bobAttempt, false);
  assert.equal(Boolean(engine.byId(msgA.id).recalled), false);
  assert.equal(engine.byId(msgA.id).text, 'Báo cáo tiến độ từ Trợ lý A');

  // Author ('mem-alice') can recall their own message even with isDirector = false
  const aliceAttempt = engine.recall(msgA.id, 'mem-alice', false);
  assert.equal(aliceAttempt, true);
  assert.equal(engine.byId(msgA.id).recalled, true);
  assert.equal(engine.byId(msgA.id).text, '');

  // Director (isDirector = true) can recall any member's message
  const msgB = engine.fromBoss('Tin nhắn từ Trợ lý B', null, [], {
    whoId: 'mem-bob',
    whoName: 'Bob',
    whoRole: 'Trợ lý Giám đốc',
    humanOnly: true,
  });
  assert.ok(msgB);
  const directorAttempt = engine.recall(msgB.id, 'director', true);
  assert.equal(directorAttempt, true);
  assert.equal(engine.byId(msgB.id).recalled, true);
});


