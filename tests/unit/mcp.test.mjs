import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpManager, maskSecret } from '../../server/mcp.mjs';

function makeTempDirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'workoffice-mcp-test-'));
  const dataDir = path.join(base, 'data');
  const geminiRootDir = path.join(base, '.gemini');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(geminiRootDir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(geminiRootDir, 'antigravity'), { recursive: true });
  return { base, dataDir, geminiRootDir };
}

test('MCP Manager: upsert, toggle, duplicate, import/export, toggleAll, delete, and tool scanning', () => {
  const { base, dataDir, geminiRootDir } = makeTempDirs();
  try {
    // Seed a tool schema and instructions.md for "figma"
    const figmaToolsDir = path.join(geminiRootDir, 'antigravity', 'mcp', 'figma');
    fs.mkdirSync(figmaToolsDir, { recursive: true });
    fs.writeFileSync(
      path.join(figmaToolsDir, 'get_figma_data.json'),
      JSON.stringify({
        name: 'get_figma_data',
        description: 'Fetch Figma file layout and node structure',
        parameters: {
          type: 'object',
          properties: {
            fileKey: { type: 'string', description: 'Figma file key' },
            nodeId: { type: 'string', description: 'Optional node ID' },
          },
          required: ['fileKey'],
        },
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(figmaToolsDir, 'instructions.md'), '# Figma MCP Guide', 'utf8');

    const mgr = createMcpManager({ dataDir, geminiRootDir });

    // 1. Add a stdio server
    const rAddStdio = mgr.upsertServer({
      name: 'figma',
      title: 'Figma Design MCP',
      desc: 'Inspect Figma files',
      transport: 'stdio',
      command: 'npx',
      args: '-y figma-developer-mcp --stdio',
      env: { FIGMA_API_KEY: 'figd_secret_1234567890' },
      enabled: true,
    });
    assert.equal(rAddStdio.ok, true);

    // 2. Add a remote HTTP server
    const rAddHttp = mgr.upsertServer({
      name: 'stitch',
      transport: 'http',
      serverUrl: 'https://stitch.googleapis.com/mcp',
      headers: { 'X-Goog-Api-Key': 'AIzaSyTestKey123456789' },
      enabled: true,
    });
    assert.equal(rAddHttp.ok, true);

    let list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.total, 2);
    assert.equal(list.summary.enabled, 2);
    assert.equal(list.summary.disabled, 0);
    assert.equal(list.summary.totalTools, 1);

    const figmaSrv = list.servers.find((s) => s.name === 'figma');
    assert.ok(figmaSrv);
    assert.equal(figmaSrv.title, 'Figma Design MCP');
    assert.equal(figmaSrv.toolsCount, 1);
    assert.equal(figmaSrv.tools[0].params.length, 2);
    assert.equal(figmaSrv.instructions, '# Figma MCP Guide');
    assert.equal(figmaSrv.maskedEnv.FIGMA_API_KEY, maskSecret('figd_secret_1234567890'));

    // 3. Toggle "figma" OFF and verify it stays disabled across reloads
    const rToggleOff = mgr.toggleServer('figma', false);
    assert.equal(rToggleOff.ok, true);
    assert.equal(rToggleOff.enabled, false);

    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.total, 2);
    assert.equal(list.summary.enabled, 1);
    assert.equal(list.summary.disabled, 1);
    assert.equal(list.servers.find((s) => s.name === 'figma').enabled, false);

    // 4. Toggle "figma" back ON
    const rToggleOn = mgr.toggleServer('figma', true);
    assert.equal(rToggleOn.ok, true);
    assert.equal(rToggleOn.enabled, true);
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.enabled, 2);

    // 5. Duplicate "stitch"
    const rDup = mgr.duplicateServer('stitch');
    assert.equal(rDup.ok, true);
    assert.equal(rDup.name, 'stitch-copy');
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.total, 3);

    // 6. Toggle all OFF then ON
    mgr.toggleAllServers(false);
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.enabled, 0);
    assert.equal(list.summary.disabled, 3);

    mgr.toggleAllServers(true);
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.enabled, 3);
    assert.equal(list.summary.disabled, 0);

    // 7. Import JSON
    const rImport = mgr.importJson(
      JSON.stringify({
        mcpServers: {
          memory: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-memory'],
          },
        },
      }),
    );
    assert.equal(rImport.ok, true);
    assert.equal(rImport.count, 1);
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.total, 4);

    // 8. Delete "stitch-copy"
    const rDel = mgr.deleteServer('stitch-copy');
    assert.equal(rDel.ok, true);
    list = mgr.listServers({ isFullDirector: true });
    assert.equal(list.summary.total, 3);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
