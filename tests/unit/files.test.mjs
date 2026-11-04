import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAccessManager } from '../../server/access.mjs';
import { handleFilesApi, resolveAllowedFilePath } from '../../server/files.mjs';

test('Files API & resolveAllowedFilePath: workspace scoping, path traversal protection, and .txt/.csv preview', async () => {
  const rootTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-office-files-test-'));
  try {
    const dataDir = path.join(rootTmp, 'data');
    const wsAllowed = path.join(rootTmp, 'ws-allowed');
    const wsSecret = path.join(rootTmp, 'ws-secret');
    await fsp.mkdir(path.join(wsAllowed, 'docs'), { recursive: true });
    await fsp.mkdir(wsSecret, { recursive: true });

    const txtPath = path.join(wsAllowed, 'notes.txt');
    const csvPath = path.join(wsAllowed, 'report.csv');
    const envPath = path.join(wsAllowed, '.env');
    const secretFile = path.join(wsSecret, 'confidential.txt');

    await fsp.writeFile(txtPath, 'Xin chào Work Office\nDòng thứ 2', 'utf8');
    await fsp.writeFile(csvPath, 'Tên,Vai trò,Điểm\n"Minh Anh",Trợ lý,95\n"Tuấn",Kỹ thuật,88\n', 'utf8');
    await fsp.writeFile(envPath, 'SECRET_KEY=123456\n', 'utf8');
    await fsp.writeFile(secretFile, 'Tài liệu mật ngoài workspace được cấp phép', 'utf8');

    const access = createAccessManager({ dataDir });
    const reqMember = access.createOrUpdateRequest({
      name: 'Lan Trợ Lý',
      role: 'Trợ lý Giám đốc',
      ip: '100.64.0.55',
    });
    const viewer = access.approveMember(reqMember.id, {
      allowedWorkspaces: [wsAllowed],
      canEditFiles: false,
    });

    const allWorkspaces = [
      { path: wsAllowed, name: 'AllowedProject' },
      { path: wsSecret, name: 'SecretProject' },
    ];

    // 1. resolveAllowedFilePath allows files in permitted workspace
    const okResolved = resolveAllowedFilePath(txtPath, allWorkspaces, {
      isLocal: false,
      viewer,
      access,
    });
    assert.ok(okResolved);
    assert.equal(okResolved.fullPath, path.resolve(txtPath));
    assert.equal(okResolved.relPath, 'notes.txt');

    // 2. resolveAllowedFilePath blocks unapproved workspace, path traversal ../, and sensitive .env files
    const blockedWs = resolveAllowedFilePath(secretFile, allWorkspaces, {
      isLocal: false,
      viewer,
      access,
    });
    assert.equal(blockedWs, null);

    const traversalPath = path.join(wsAllowed, '..', 'ws-secret', 'confidential.txt');
    const blockedTraversal = resolveAllowedFilePath(traversalPath, allWorkspaces, {
      isLocal: false,
      viewer,
      access,
    });
    assert.equal(blockedTraversal, null);

    const blockedEnv = resolveAllowedFilePath(envPath, allWorkspaces, {
      isLocal: false,
      viewer,
      access,
    });
    assert.equal(blockedEnv, null);

    // Helper to invoke handleFilesApi
    async function callFilesApi(method, urlStr, bodyObj = null, customViewer = viewer) {
      let status = 200;
      let payload = null;
      const req = { method };
      const res = {
        writeHead: (code) => {
          status = code;
          return { end: () => {} };
        },
        end: () => {},
      };
      const url = new URL(urlStr, 'http://localhost:3333');
      const handled = await handleFilesApi(req, res, url, {
        viewer: customViewer,
        isLocal: false,
        access,
        getWorkspaces: () => allWorkspaces,
        readJson: async () => bodyObj,
        json: (_res, obj, code = 200) => {
          status = code;
          payload = obj;
        },
      });
      return { handled, status, payload };
    }

    // 3. GET /api/files/workspaces returns only permitted workspaces for remote assistant
    const wsRes = await callFilesApi('GET', '/api/files/workspaces');
    assert.equal(wsRes.handled, true);
    assert.equal(wsRes.status, 200);
    assert.equal(wsRes.payload.ok, true);
    assert.equal(wsRes.payload.canEditFiles, false);
    assert.equal(wsRes.payload.workspaces.length, 1);
    assert.equal(wsRes.payload.workspaces[0].path, path.resolve(wsAllowed));

    // 4. GET /api/files/list lists allowed directory & hides .env
    const listRes = await callFilesApi('GET', `/api/files/list?dir=${encodeURIComponent(wsAllowed)}`);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.payload.ok, true);
    const listedNames = listRes.payload.items.map((i) => i.name);
    assert.ok(listedNames.includes('docs'));
    assert.ok(listedNames.includes('notes.txt'));
    assert.ok(listedNames.includes('report.csv'));
    assert.ok(!listedNames.includes('.env'), '.env must be hidden from directory listing');

    // 5. GET /api/files/list blocks unapproved workspace and ../ traversal with 403
    const forbiddenList = await callFilesApi('GET', `/api/files/list?dir=${encodeURIComponent(wsSecret)}`);
    assert.equal(forbiddenList.status, 403);
    assert.equal(forbiddenList.payload.ok, false);

    const traversalList = await callFilesApi('GET', `/api/files/list?dir=${encodeURIComponent(path.join(wsAllowed, '..', 'ws-secret'))}`);
    assert.equal(traversalList.status, 403);
    assert.equal(traversalList.payload.ok, false);

    // 6. GET /api/files/preview previews .txt and .csv files accurately
    const txtPreview = await callFilesApi('GET', `/api/files/preview?path=${encodeURIComponent(txtPath)}`);
    assert.equal(txtPreview.status, 200);
    assert.equal(txtPreview.payload.ok, true);
    assert.equal(txtPreview.payload.kind, 'text');
    assert.equal(txtPreview.payload.content, 'Xin chào Work Office\nDòng thứ 2');

    const csvPreview = await callFilesApi('GET', `/api/files/preview?path=${encodeURIComponent(csvPath)}`);
    assert.equal(csvPreview.status, 200);
    assert.equal(csvPreview.payload.ok, true);
    assert.equal(csvPreview.payload.kind, 'xlsx');
    assert.equal(csvPreview.payload.sheets.length, 1);
    assert.deepEqual(csvPreview.payload.sheets[0].rows, [
      ['Tên', 'Vai trò', 'Điểm'],
      ['Minh Anh', 'Trợ lý', '95'],
      ['Tuấn', 'Kỹ thuật', '88'],
    ]);

    // 7. POST /api/files/action blocks write when canEditFiles=false, allows when canEditFiles=true
    const deniedWrite = await callFilesApi('POST', '/api/files/action', {
      action: 'writeText',
      path: txtPath,
      content: 'Nội dung sửa trái phép',
    });
    assert.equal(deniedWrite.status, 403);
    assert.equal(deniedWrite.payload.error, 'permission_denied');

    const editorViewer = access.updateMember(reqMember.id, { canEditFiles: true });
    const allowedWrite = await callFilesApi('POST', '/api/files/action', {
      action: 'writeText',
      path: txtPath,
      content: 'Nội dung đã cập nhật hợp lệ',
    }, editorViewer);
    assert.equal(allowedWrite.status, 200);
    assert.equal(allowedWrite.payload.ok, true);
    assert.equal(fs.readFileSync(txtPath, 'utf8'), 'Nội dung đã cập nhật hợp lệ');

    // 8. Deputy Director (isDirectorDevice: true / role: 'Phó Giám đốc') sees all workspaces and canEditFiles=true
    const deputyViewer = {
      id: 'deputy-1',
      name: 'Phó Giám đốc',
      role: 'Phó Giám đốc',
      isDirectorDevice: true,
      allowedWorkspaces: [],
    };
    const deputyWsRes = await callFilesApi('GET', '/api/files/workspaces', null, deputyViewer);
    assert.equal(deputyWsRes.status, 200);
    assert.equal(deputyWsRes.payload.canEditFiles, true);
    assert.equal(deputyWsRes.payload.workspaces.length, 2);

    const deputySecretResolved = resolveAllowedFilePath(secretFile, allWorkspaces, {
      isLocal: false,
      viewer: deputyViewer,
      access,
    });
    assert.ok(deputySecretResolved, 'Deputy Director must have access to all workspaces');
    assert.equal(deputySecretResolved.fullPath, path.resolve(secretFile));
  } finally {
    await fsp.rm(rootTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
