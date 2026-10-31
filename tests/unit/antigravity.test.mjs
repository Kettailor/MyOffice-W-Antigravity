import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  cleanVal,
  cleanArgs,
  normalizeAgyTool,
  normalizeAgyHookPayload,
  extractUserRequest,
  readAgyTodos,
  readAgyLog,
  decodeWorkspaceUri,
  normalizeWorkspacePath,
  computeAgyQuota,
} from '../../server/antigravity.mjs';
import { parseNvidiaSmi } from '../../server/platform/win32.mjs';
import { createAccessManager } from '../../server/access.mjs';

test('Antigravity: unwraps double-encoded JSON arguments', () => {
  assert.equal(cleanVal('"e:\\\\WorkOffice\\\\server\\\\index.mjs"'), 'e:\\WorkOffice\\server\\index.mjs');
  const args = cleanArgs('{"Path":"\\"e:\\\\\\\\WorkOffice\\\\\\\\README.md\\"","StartLine":"1"}');
  assert.equal(args.Path, 'e:\\WorkOffice\\README.md');
  assert.equal(args.StartLine, 1);
});

test('Antigravity: maps Antigravity tools to Work Office 3D tool classes', () => {
  const r = normalizeAgyTool('default_api:read_file', { Path: '"e:\\\\WorkOffice\\\\package.json"' });
  assert.equal(r.tool_name, 'Read');
  assert.equal(r.tool_input.file_path, 'e:\\WorkOffice\\package.json');

  const e = normalizeAgyTool('edit_file', { Path: '"e:\\\\WorkOffice\\\\server\\\\index.mjs"' });
  assert.equal(e.tool_name, 'Edit');

  const b = normalizeAgyTool('run_command', { CommandLine: '"npm test"', toolSummary: '"Run unit tests"' });
  assert.equal(b.tool_name, 'Bash');
  assert.equal(b.tool_input.command, 'npm test');

  const g = normalizeAgyTool('grep_search', { Query: '"createAntigravityWatcher"' });
  assert.equal(g.tool_name, 'Grep');

  const defSub = normalizeAgyTool('default_api:define_subagent', {
    Role: '"QA, Test & Build Verifier"',
    TypeName: '"qa-test-specialist"',
    Description: '"Subagent chuyên trách QA & Automated Testing"',
  });
  assert.deepEqual(defSub, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'QA, Test & Build Verifier',
      description: 'Subagent chuyên trách QA & Automated Testing',
    },
  });

  const sub = normalizeAgyTool('default_api:invoke_subagent', {
    TypeName: '"qa-test-specialist"',
    Prompt: '"Chạy unit test kiểm tra Antigravity và Access"',
  });
  assert.deepEqual(sub, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'qa-test-specialist',
      description: 'Chạy unit test kiểm tra Antigravity và Access',
    },
  });

  const msg = normalizeAgyTool('default_api:send_message', {
    Recipient: '"7d6f2f84-7bc4-4662-aad2-69fdf916e175"',
    Message: '"Báo cáo kết quả unit test pass 100%"',
  });
  assert.deepEqual(msg, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: '7d6f2f84-7bc4-4662-aad2-69fdf916e175',
      description: 'Báo cáo kết quả unit test pass 100%',
    },
  });
});

test('Antigravity: normalizes camelCase hook payloads', () => {
  const p = normalizeAgyHookPayload({
    conversationId: '7d6f2f84-7bc4-4662-aad2-69fdf916e175',
    workspacePaths: ['e:\\WorkOffice'],
    hookEventName: 'PreToolUse',
    modelName: 'gemini-2.5-pro',
    toolCall: {
      name: 'default_api:run_command',
      arguments: { CommandLine: 'npm run build', toolSummary: 'Build bundle' },
    },
  });
  assert.equal(p.isAgy, true);
  assert.equal(p.session_id, '7d6f2f84-7bc4-4662-aad2-69fdf916e175');
  assert.equal(p.cwd, 'e:\\WorkOffice');
  assert.equal(p.hook_event_name, 'PreToolUse');
  assert.equal(p.tool_name, 'Bash');
  assert.equal(p.tool_input.command, 'npm run build');
});

test('Antigravity: parses task.md checklist items and transcript log', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-office-agy-'));
  try {
    await fsp.writeFile(
      path.join(tmpDir, 'task.md'),
      '# Kế hoạch\n- [x] Khởi tạo mã nguồn\n- [/] Xây dựng Brain Watcher\n- [ ] Kiểm thử tự động\n',
      'utf8',
    );
    const todos = await readAgyTodos(tmpDir);
    assert.equal(todos.length, 3);
    assert.equal(todos[0].status, 'done');
    assert.equal(todos[1].status, 'doing');
    assert.equal(todos[2].status, 'todo');

    const req = extractUserRequest('Active Workspaces:\n- e:\\WorkOffice\n<USER_REQUEST>\nXây dựng Work Office cho Antigravity\n</USER_REQUEST>');
    assert.equal(req, 'Xây dựng Work Office cho Antigravity');

    const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
    const chunk = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-10-30T11:00:00Z',
        content: '<USER_REQUEST>\nXây dựng Work Office cho Antigravity\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-10-30T11:00:05Z',
        content: 'Đã khởi tạo thành công.',
        tool_calls: [
          {
            id: 'call_1',
            name: 'read_file',
            args: { Path: '"e:\\\\WorkOffice\\\\\\\\package.json"' },
          },
        ],
      }),
    ].join('\n');
    await fsp.writeFile(transcriptFile, chunk, 'utf8');
    const log = await readAgyLog(transcriptFile, (tool, input) => ({ type: 'read', label: tool, desc: input.file_path }));
    assert.equal(log.length, 3);
    assert.equal(log[0].role, 'user');
    assert.equal(log[0].text, 'Xây dựng Work Office cho Antigravity');
    assert.equal(log[1].role, 'claude');
    assert.equal(log[2].role, 'tool');
    assert.equal(log[2].label, 'Read');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test('Antigravity: computes dynamic 5h/weekly quota and per-project quota breakdown', () => {
  assert.equal(decodeWorkspaceUri('file:///e%3A/WorkOffice'), 'e:\\WorkOffice');
  assert.equal(normalizeWorkspacePath('E:/WorkOffice/src'), 'e:\\WorkOffice\\src');

  const now = Date.now();
  const sessions = new Map([
    ['a1', {
      id: '1',
      isAgy: true,
      cwd: 'e:\\WorkOffice',
      status: 'work',
      usage: {
        cost: 2.5,
        ctx: 48000,
        in: 27000,
        out: 12000,
        prompts: 2,
        steps: 3,
      },
      agySteps: [
        { ts: now - 10 * 60_000, kind: 'prompt', inp: 500, out: 0, cr: 0, cost: 0.01, tools: 0 },
        { ts: now - 9 * 60_000, kind: 'step', inp: 15000, out: 6000, cr: 0, cost: 1.2, tools: 4 },
        { ts: now - 3 * 60_000, kind: 'prompt', inp: 400, out: 0, cr: 0, cost: 0.01, tools: 0 },
        { ts: now - 2 * 60_000, kind: 'step', inp: 12000, out: 6000, cr: 0, cost: 1.3, tools: 3 },
      ],
    }],
    ['a2', {
      id: '2',
      isAgy: true,
      cwd: 'e:\\BioKit',
      status: 'rest',
      usage: {
        cost: 1.1,
        ctx: 22000,
        in: 8000,
        out: 4000,
        prompts: 1,
        steps: 1,
      },
      agySteps: [
        { ts: now - 30 * 60_000, kind: 'prompt', inp: 300, out: 0, cr: 0, cost: 0.01, tools: 0 },
        { ts: now - 29 * 60_000, kind: 'step', inp: 8000, out: 4000, cr: 0, cost: 1.1, tools: 2 },
      ],
    }],
  ]);

  const q = computeAgyQuota(sessions);
  assert.ok(q.pct > 0, '5h quota pct should be > 0');
  assert.ok(q.weekPct > 0, '7d quota pct should be > 0');
  assert.equal(q.prompts5h, 3);
  assert.equal(q.steps5h, 3);
  assert.equal(q.projects.length, 2);
  assert.equal(q.projects[0].name, 'WorkOffice');
  assert.equal(q.projects[1].name, 'BioKit');
  assert.ok(q.projects[0].pct >= q.projects[1].pct);
});

test('Windows GPU: parses nvidia-smi CSV output accurately', () => {
  const g = parseNvidiaSmi('NVIDIA GeForce RTX 3060, 28, 3420, 12288, 54, 68.5\n');
  assert.ok(g);
  assert.equal(g.name, 'NVIDIA GeForce RTX 3060');
  assert.equal(g.shortName, 'RTX 3060');
  assert.equal(g.percent, 28);
  assert.equal(g.vramPct, 28);
  assert.equal(g.temp, 54);
  assert.equal(g.power, 68.5);
});

test('Remote Access Manager: approves Trợ lý Giám đốc, scopes Workspaces, and toggles pre-execution task approval', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-office-access-'));
  try {
    const access = createAccessManager({ dataDir: tmpDir });
    assert.equal(access.state.requireTaskApproval, true);

    const fakeReq = { headers: { cookie: '' }, socket: { remoteAddress: '100.88.12.34' } };
    const reqMember = access.createOrUpdateRequest(fakeReq, {
      name: 'Minh Anh',
      role: 'Trợ lý Giám đốc',
      note: 'Hỗ trợ điều phối task',
    });
    assert.equal(reqMember.status, 'pending');
    assert.equal(reqMember.role, 'Trợ lý Giám đốc');

    // Approve with access only to e:\WorkOffice (not e:\BioKit)
    const approved = access.approveMember(reqMember.id, {
      name: 'Minh Anh',
      role: 'Trợ lý Giám đốc',
      allowedWorkspaces: ['e:\\WorkOffice'],
    });
    assert.equal(approved.status, 'approved');
    assert.equal(access.canSeeWorkspace(approved, 'e:\\WorkOffice'), true);
    assert.equal(access.canSeeWorkspace(approved, 'e:\\WorkOffice\\server'), true);
    assert.equal(access.canSeeWorkspace(approved, 'e:\\BioKit'), false);

    // Queue a remote task while requireTaskApproval is ON
    assert.equal(access.effectiveRequireApproval(approved), true);
    const queued = access.queueTask(approved, {
      dir: 'e:\\WorkOffice',
      targetName: 'WorkOffice',
      text: 'Kiểm tra quota dự án',
    });
    assert.equal(access.state.pendingTasks.length, 1);

    const resolved = access.resolveTask(queued.id, 'approve', 'Kiểm tra quota dự án ngay');
    assert.equal(resolved.text, 'Kiểm tra quota dự án ngay');
    assert.equal(access.state.pendingTasks.length, 0);

    // Toggle requireTaskApproval OFF
    access.setRequireTaskApproval(false);
    assert.equal(access.effectiveRequireApproval(approved), false);
    access.setRequireTaskApproval(true);

    // PIN login creates Phó Giám đốc (Director Device 1) with full workspace access & no task approval required
    const vpReq1 = {
      headers: { cookie: '', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' },
      socket: { remoteAddress: '100.88.12.10' },
    };
    const vp1 = access.createDirectorDeviceMember(vpReq1);
    assert.equal(vp1.name, 'Phó Giám đốc');
    assert.equal(vp1.role, 'Phó Giám đốc');
    assert.equal(vp1.isDirectorDevice, true);
    assert.equal(vp1.status, 'approved');
    assert.deepEqual(vp1.allowedWorkspaces, ['*']);
    assert.equal(vp1.requireApproval, false);
    assert.equal(access.effectiveRequireApproval(vp1), false);
    assert.equal(access.canSeeWorkspace(vp1, 'e:\\BioKit'), true);

    // Second PIN login from another device creates Phó Giám đốc 2
    const vpReq2 = {
      headers: { cookie: '', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120.0.0.0' },
      socket: { remoteAddress: '100.88.12.11' },
    };
    const vp2 = access.createDirectorDeviceMember(vpReq2);
    assert.equal(vp2.name, 'Phó Giám đốc 2');
    assert.equal(vp2.role, 'Phó Giám đốc');
    assert.equal(vp2.isDirectorDevice, true);
    assert.deepEqual(vp2.allowedWorkspaces, ['*']);
    assert.equal(vp2.requireApproval, false);

    // Unapproved pending request should NOT appear in getApprovedTeamMembers
    const pendingReq = { headers: { cookie: '' }, socket: { remoteAddress: '100.88.12.99' } };
    access.createOrUpdateRequest(pendingReq, { name: 'Khách Chờ Duyệt', role: 'Trợ lý Giám đốc' });

    // getApprovedTeamMembers returns approved Phó Giám đốc & Trợ lý Giám đốc for 3D Chibi rendering
    const team = access.getApprovedTeamMembers();
    assert.equal(team.length, 3);
    assert.ok(team.every((m) => m.status === 'approved' && m.secret === undefined));
    const names = team.map((m) => m.name);
    assert.ok(names.includes('Phó Giám đốc'));
    assert.ok(names.includes('Phó Giám đốc 2'));
    assert.ok(names.includes('Minh Anh'));
    const roles = team.map((m) => m.role);
    assert.ok(roles.includes('Phó Giám đốc'));
    assert.ok(roles.includes('Trợ lý Giám đốc'));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});

test('Antigravity: normalizes ask_question and implementation_plan.md feedback tools for Focus-to-Approve modal', () => {
  const ask = normalizeAgyTool('default_api:ask_question', {
    questions: [
      {
        question: 'Bạn muốn hiển thị hộp thoại duyệt ở đâu?',
        is_multi_select: false,
        options: ['Phương án A: Hộp thoại nổi ở giữa', 'Phương án B: Ngăn kéo bên phải'],
      },
    ],
  });
  assert.equal(ask.tool_name, 'AskUserQuestion');
  assert.equal(ask.requestFeedback, true);
  assert.equal(ask.tool_input.questions.length, 1);
  assert.equal(ask.tool_input.questions[0].question, 'Bạn muốn hiển thị hộp thoại duyệt ở đâu?');
  assert.equal(ask.tool_input.questions[0].multi, false);
  assert.deepEqual(ask.tool_input.questions[0].options, [
    { label: 'Phương án A: Hộp thoại nổi ở giữa', description: '' },
    { label: 'Phương án B: Ngăn kéo bên phải', description: '' },
  ]);

  const plan = normalizeAgyTool('default_api:write_file', {
    Path: 'C:\\Users\\dev\\.gemini\\antigravity\\brain\\conv-1\\implementation_plan.md',
    ArtifactMetadata: {
      Summary: 'Kế hoạch thiết kế Focus-to-Approve',
      UserFacing: true,
      RequestFeedback: true,
    },
  });
  assert.equal(plan.tool_name, 'Write');
  assert.equal(plan.isPlanFile, true);
  assert.equal(plan.requestFeedback, true);
  assert.equal(plan.artifactSummary, 'Kế hoạch thiết kế Focus-to-Approve');
});

test('Antigravity: computes per-account quota for auto-switch and preserves AI model in queued tasks', async () => {
  const now = Date.now();
  const sessions = new Map([
    ['a1', {
      id: '1',
      isAgy: true,
      agyAccount: '',
      cwd: 'e:\\WorkOffice',
      status: 'work',
      agySteps: [
        { ts: now - 5 * 60_000, kind: 'prompt', inp: 1000, out: 0, cr: 0, cost: 0.02, tools: 0, acct: '' },
        { ts: now - 4 * 60_000, kind: 'step', inp: 5000000, out: 1000000, cr: 0, cost: 2.0, tools: 5, acct: '' },
      ],
    }],
    ['a2', {
      id: '2',
      isAgy: true,
      agyAccount: 'du-phong-1',
      cwd: 'e:\\WorkOffice',
      status: 'rest',
      agySteps: [
        { ts: now - 2 * 60_000, kind: 'prompt', inp: 500, out: 0, cr: 0, cost: 0.01, tools: 0, account: 'du-phong-1' },
        { ts: now - 1 * 60_000, kind: 'step', inp: 4000, out: 1500, cr: 0, cost: 0.3, tools: 1, account: 'du-phong-1' },
      ],
    }],
  ]);

  const qMain = computeAgyQuota(sessions, null, '');
  const qBackup = computeAgyQuota(sessions, null, 'du-phong-1');
  const qEmpty = computeAgyQuota(sessions, null, 'du-phong-2');
  assert.equal(qMain.prompts5h, 1);
  assert.equal(qMain.steps5h, 1);
  assert.equal(qBackup.prompts5h, 1);
  assert.equal(qBackup.steps5h, 1);
  assert.ok(qMain.pct > qBackup.pct, 'Main account with higher token/tool usage should have higher 5h quota pct');
  assert.equal(qEmpty.pct, 0);
  assert.equal(qEmpty.prompts5h, 0);

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-office-model-'));
  try {
    const access = createAccessManager({ dataDir: tmpDir });
    const item = access.queueTask({ id: 'm1', name: 'Trợ lý', role: 'Trợ lý Giám đốc' }, {
      dir: 'e:\\WorkOffice',
      sid: '9dd0dfb6-8843-4087-a66b-63f631132aba',
      model: 'claude-sonnet-5-5-high',
      text: 'Kiểm tra tính năng chọn model',
    });
    assert.equal(item.model, 'claude-sonnet-5-5-high');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
});
