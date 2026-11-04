import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc',
  '.py', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yml', '.yaml',
  '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.toml', '.ini',
  '.conf', '.cfg', '.log', '.rs', '.go', '.java', '.kt', '.c', '.cpp', '.h',
  '.hpp', '.cs', '.php', '.rb', '.swift', '.dart', '.vue', '.svelte', '.astro',
  '.graphql', '.gql', '.prisma', '.dockerfile', '.gitignore', '.gitattributes',
  '.editorconfig', '.npmrc', '.Lock',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif',
]);

const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
]);

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mov', '.mkv',
]);

const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function normComparePath(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isInsideRoot(targetPath, rootPath) {
  const t = normComparePath(targetPath);
  const r = normComparePath(rootPath);
  if (!t || !r) return false;
  return t === r || t.startsWith(r + '/');
}

function isSensitiveSegment(seg, allowLocalGemini = false) {
  const lower = String(seg || '').toLowerCase();
  if (!lower) return false;
  if (lower === '.git' || lower === 'node_modules') return true;
  if (lower === '.gemini' && !allowLocalGemini) return true;
  if (lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example' && lower !== '.env.sample' && lower !== '.env.template')) {
    return true;
  }
  return false;
}

function hasSensitivePathPart(targetPath, rootPath, allowLocalGemini = false) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const part of parts) {
    if (isSensitiveSegment(part, allowLocalGemini)) return true;
  }
  return false;
}

export function categorizeFile(name, isDir = false) {
  if (isDir) return 'folder';
  const lower = String(name || '').toLowerCase();
  const ext = path.extname(lower);
  if (ext === '.docx' || ext === '.doc') return 'docx';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv') return 'xlsx';
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext) || lower === 'dockerfile' || lower === 'makefile' || lower === 'license' || lower === 'readme') {
    return 'code';
  }
  return 'other';
}

export function resolveAllowedFilePath(rawPath, allowedWorkspaces, opts = {}) {
  const { isLocal = false, viewer = null, access = null } = opts;
  if (!rawPath || typeof rawPath !== 'string') return null;
  let resolved;
  try {
    resolved = path.resolve(rawPath.trim());
  } catch {
    return null;
  }
  const allowLocalGemini = Boolean(isLocal || viewer?.isDirector);
  const baseName = path.basename(resolved);
  if (isSensitiveSegment(baseName, allowLocalGemini)) return null;

  const wsList = Array.isArray(allowedWorkspaces) ? allowedWorkspaces : [];
  for (const ws of wsList) {
    const wsPath = typeof ws === 'string' ? ws : ws?.path;
    if (!wsPath) continue;
    const resolvedWs = path.resolve(wsPath);
    if (isInsideRoot(resolved, resolvedWs)) {
      if (access && !isLocal && !viewer?.isDirector && !access.canSeeWorkspace(viewer, resolvedWs)) {
        continue;
      }
      if (hasSensitivePathPart(resolved, resolvedWs, allowLocalGemini)) {
        return null;
      }
      return {
        fullPath: resolved,
        workspaceRoot: resolvedWs,
        relPath: path.relative(resolvedWs, resolved).replace(/\\/g, '/'),
      };
    }
  }
  return null;
}

// Minimal pure-Node ZIP reader using zlib.inflateRawSync for .docx and .xlsx
export function readZipEntries(buf) {
  const entries = new Map();
  if (!Buffer.isBuffer(buf) || buf.length < 22) return entries;

  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  const minEocd = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset >= 0) {
    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    let ptr = cdOffset;
    for (let idx = 0; idx < totalEntries && ptr + 46 <= buf.length; idx++) {
      if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
      const compression = buf.readUInt16LE(ptr + 10);
      const compSize = buf.readUInt32LE(ptr + 20);
      const uncompSize = buf.readUInt32LE(ptr + 24);
      const nameLen = buf.readUInt16LE(ptr + 28);
      const extraLen = buf.readUInt16LE(ptr + 30);
      const commentLen = buf.readUInt16LE(ptr + 32);
      const localHeaderOffset = buf.readUInt32LE(ptr + 42);
      const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
      ptr += 46 + nameLen + extraLen + commentLen;

      if (localHeaderOffset + 30 > buf.length) continue;
      if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;
      const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
      const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
      const dataEnd = dataStart + compSize;
      if (dataEnd > buf.length) continue;

      entries.set(name, {
        name,
        compression,
        compSize,
        uncompSize,
        data: buf.subarray(dataStart, dataEnd),
      });
    }
  } else {
    // Fallback: sequential scan of Local File Headers (0x04034b50)
    let ptr = 0;
    while (ptr + 30 <= buf.length) {
      if (buf.readUInt32LE(ptr) !== 0x04034b50) break;
      const flags = buf.readUInt16LE(ptr + 6);
      const compression = buf.readUInt16LE(ptr + 8);
      const compSize = buf.readUInt32LE(ptr + 18);
      const uncompSize = buf.readUInt32LE(ptr + 22);
      const nameLen = buf.readUInt16LE(ptr + 26);
      const extraLen = buf.readUInt16LE(ptr + 28);
      const name = buf.subarray(ptr + 30, ptr + 30 + nameLen).toString('utf8');
      const dataStart = ptr + 30 + nameLen + extraLen;
      if ((flags & 0x08) !== 0 || dataStart + compSize > buf.length) break;
      entries.set(name, {
        name,
        compression,
        compSize,
        uncompSize,
        data: buf.subarray(dataStart, dataStart + compSize),
      });
      ptr = dataStart + compSize;
    }
  }
  return entries;
}

function extractZipText(entries, entryName) {
  const entry = entries.get(entryName);
  if (!entry) return null;
  try {
    if (entry.compression === 0) {
      return entry.data.toString('utf8');
    }
    if (entry.compression === 8) {
      return zlib.inflateRawSync(entry.data).toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseDocxRunHtml(runXml) {
  const rPrMatch = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(runXml);
  const rPr = rPrMatch ? rPrMatch[1] : '';
  const isBold = /<w:b(?:\s|\/|>)/.test(rPr) && !/<w:b\s+w:val="(?:false|0)"/.test(rPr);
  const isItalic = /<w:i(?:\s|\/|>)/.test(rPr) && !/<w:i\s+w:val="(?:false|0)"/.test(rPr);
  const isUnderline = /<w:u(?:\s|\/|>)/.test(rPr) && !/<w:u\s+w:val="none"/.test(rPr);

  let text = '';
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
  let m;
  while ((m = tokenRe.exec(runXml)) !== null) {
    if (m[1] !== undefined) {
      text += decodeXmlEntities(m[1]);
    } else if (m[0].startsWith('<w:tab')) {
      text += '\t';
    } else {
      text += '\n';
    }
  }
  if (!text) return { html: '', text: '' };

  let html = escapeHtml(text).replace(/\n/g, '<br>');
  if (isUnderline) html = `<u>${html}</u>`;
  if (isItalic) html = `<em>${html}</em>`;
  if (isBold) html = `<strong>${html}</strong>`;
  return { html, text };
}

function parseDocxParagraph(pXml) {
  const pStyleMatch = /<w:pStyle\s+w:val="([^"]+)"/.exec(pXml);
  const styleVal = pStyleMatch ? pStyleMatch[1] : '';
  const isList = /<w:numPr\b/.test(pXml);

  const runs = [];
  const plainParts = [];
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = runRe.exec(pXml)) !== null) {
    const r = parseDocxRunHtml(m[1]);
    if (r.html) runs.push(r.html);
    if (r.text) plainParts.push(r.text);
  }

  const innerHtml = runs.join('');
  const plainText = plainParts.join('');
  if (!innerHtml.trim()) return { html: '', text: '' };

  let tag = 'p';
  if (/^Heading1$|^Title$/i.test(styleVal)) tag = 'h1';
  else if (/^Heading2$|^Subtitle$/i.test(styleVal)) tag = 'h2';
  else if (/^Heading3$/i.test(styleVal)) tag = 'h3';
  else if (/^Heading[4-6]$/i.test(styleVal)) tag = 'h4';

  if (isList && tag === 'p') {
    return { html: `<p class="docx-li">• ${innerHtml}</p>`, text: `• ${plainText}` };
  }
  return { html: `<${tag}>${innerHtml}</${tag}>`, text: plainText };
}

function parseDocxTable(tblXml) {
  const rowsHtml = [];
  const rowsText = [];
  const trRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
  let trMatch;
  let rowIndex = 0;
  while ((trMatch = trRe.exec(tblXml)) !== null) {
    const trInner = trMatch[1];
    const cellsHtml = [];
    const cellsText = [];
    const tcRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
    let tcMatch;
    while ((tcMatch = tcRe.exec(trInner)) !== null) {
      const tcInner = tcMatch[1];
      const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
      let pMatch;
      const cellPartsHtml = [];
      const cellPartsText = [];
      while ((pMatch = pRe.exec(tcInner)) !== null) {
        const p = parseDocxParagraph(pMatch[1]);
        if (p.html) cellPartsHtml.push(p.html.replace(/^<p>|<\/p>$/g, ''));
        if (p.text) cellPartsText.push(p.text);
      }
      const cellTag = rowIndex === 0 ? 'th' : 'td';
      cellsHtml.push(`<${cellTag}>${cellPartsHtml.join('<br>')}</${cellTag}>`);
      cellsText.push(cellPartsText.join(' '));
    }
    if (cellsHtml.length > 0) {
      rowsHtml.push(`<tr>${cellsHtml.join('')}</tr>`);
      rowsText.push(cellsText.join('\t'));
      rowIndex++;
    }
  }
  if (!rowsHtml.length) return { html: '', text: '' };
  return {
    html: `<table class="docx-table"><tbody>${rowsHtml.join('')}</tbody></table>`,
    text: rowsText.join('\n'),
  };
}

export function parseDocxBuffer(buf) {
  const entries = readZipEntries(buf);
  const xml = extractZipText(entries, 'word/document.xml');
  if (!xml) {
    return { html: '<p>Không thể đọc nội dung word/document.xml</p>', text: '' };
  }

  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  const htmlBlocks = [];
  const textBlocks = [];
  const blockRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = blockRe.exec(bodyXml)) !== null) {
    const token = m[0];
    if (token.startsWith('<w:tbl')) {
      const tbl = parseDocxTable(token);
      if (tbl.html) htmlBlocks.push(tbl.html);
      if (tbl.text) textBlocks.push(tbl.text);
    } else {
      const p = parseDocxParagraph(token);
      if (p.html) htmlBlocks.push(p.html);
      if (p.text) textBlocks.push(p.text);
    }
  }

  return {
    html: `<div class="docx-preview">${htmlBlocks.join('\n')}</div>`,
    text: textBlocks.join('\n'),
  };
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, idx - 1);
}

export function parseXlsxBuffer(buf, maxRows = 500, maxCols = 50) {
  const entries = readZipEntries(buf);
  const sharedStrings = [];
  const ssXml = extractZipText(entries, 'xl/sharedStrings.xml');
  if (ssXml) {
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRe.exec(ssXml)) !== null) {
      const siInner = siMatch[1];
      const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let tMatch;
      let combined = '';
      while ((tMatch = tRe.exec(siInner)) !== null) {
        combined += decodeXmlEntities(tMatch[1]);
      }
      sharedStrings.push(combined);
    }
  }

  const sheetDefs = [];
  const wbXml = extractZipText(entries, 'xl/workbook.xml');
  const relsXml = extractZipText(entries, 'xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (relsXml) {
    const relRe = /<Relationship\b[^>]*>/g;
    let rm;
    while ((rm = relRe.exec(relsXml)) !== null) {
      const tag = rm[0];
      const idM = /\bId="([^"]+)"/.exec(tag);
      const targetM = /\bTarget="([^"]+)"/.exec(tag);
      if (idM && targetM) {
        let target = targetM[1].replace(/^\/+/, '');
        if (!target.startsWith('xl/')) target = `xl/${target}`;
        relMap.set(idM[1], target);
      }
    }
  }

  if (wbXml) {
    const sheetRe = /<sheet\b[^>]*>/g;
    let sm;
    let idx = 1;
    while ((sm = sheetRe.exec(wbXml)) !== null) {
      const tag = sm[0];
      const nameM = /\bname="([^"]+)"/.exec(tag);
      const rIdM = /\br:id="([^"]+)"/.exec(tag);
      const name = nameM ? decodeXmlEntities(nameM[1]) : `Sheet${idx}`;
      const rId = rIdM ? rIdM[1] : '';
      const entryPath = (rId && relMap.get(rId)) || `xl/worksheets/sheet${idx}.xml`;
      sheetDefs.push({ name, entryPath });
      idx++;
    }
  }

  if (!sheetDefs.length) {
    for (const key of entries.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(key)) {
        sheetDefs.push({ name: path.basename(key, '.xml'), entryPath: key });
      }
    }
  }

  const sheets = [];
  for (const def of sheetDefs) {
    const sheetXml = extractZipText(entries, def.entryPath);
    if (!sheetXml) continue;

    const rows = [];
    let maxColSeen = 0;
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRe.exec(sheetXml)) !== null && rows.length < maxRows) {
      const rowInner = rowMatch[1];
      const rowArr = [];
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let cellMatch;
      let fallbackCol = 0;
      while ((cellMatch = cellRe.exec(rowInner)) !== null) {
        const attrs = cellMatch[1] || '';
        const cellInner = cellMatch[2] || '';
        const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
        const typeM = /\bt="([^"]+)"/.exec(attrs);
        const colIdx = refM ? colLettersToIndex(refM[1]) : fallbackCol;
        fallbackCol = colIdx + 1;
        if (colIdx >= maxCols) continue;

        const cellType = typeM ? typeM[1] : '';
        let val = '';
        if (cellType === 'inlineStr') {
          const isT = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(cellInner);
          if (isT) val = decodeXmlEntities(isT[1]);
        } else {
          const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellInner);
          const rawVal = vMatch ? decodeXmlEntities(vMatch[1]) : '';
          if (cellType === 's') {
            const ssIdx = parseInt(rawVal, 10);
            val = Number.isFinite(ssIdx) && sharedStrings[ssIdx] !== undefined ? sharedStrings[ssIdx] : rawVal;
          } else if (cellType === 'b') {
            val = rawVal === '1' ? 'TRUE' : 'FALSE';
          } else {
            val = rawVal;
          }
        }
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = val;
        if (colIdx + 1 > maxColSeen) maxColSeen = colIdx + 1;
      }
      rows.push(rowArr);
    }

    const normalizedCols = Math.min(maxCols, Math.max(maxColSeen, 1));
    for (const r of rows) {
      while (r.length < normalizedCols) r.push('');
    }
    sheets.push({ name: def.name, rows });
  }

  return sheets;
}

export function parseDelimitedText(text, delimiter = ',', maxRows = 500, maxCols = 50) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line && rows.length > 0 && line === lines[lines.length - 1]) continue;
    if (rows.length >= maxRows) break;
    const row = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        if (row.length < maxCols) row.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (row.length < maxCols) row.push(cur);
    rows.push(row);
  }
  return [{ name: 'Sheet1', rows }];
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') return '';
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

export async function handleFilesApi(req, res, url, ctx) {
  const { viewer, isLocal, access, getWorkspaces, readJson, json } = ctx;
  const canEditFiles = Boolean(isLocal || viewer?.isDirector || viewer?.canEditFiles);
  const allWorkspaces = typeof getWorkspaces === 'function' ? getWorkspaces() : [];
  const allowedWorkspaces = allWorkspaces.filter((ws) => {
    const p = typeof ws === 'string' ? ws : ws?.path;
    if (!p) return false;
    return isLocal || viewer?.isDirector || (access && access.canSeeWorkspace(viewer, p));
  });

  // 1. GET /api/files/workspaces
  if (url.pathname === '/api/files/workspaces' && req.method === 'GET') {
    const workspaces = allowedWorkspaces.map((ws) => {
      const p = path.resolve(typeof ws === 'string' ? ws : ws.path);
      const name = (typeof ws === 'object' && ws.name) ? ws.name : (path.basename(p) || p);
      return {
        path: p,
        name,
        canEdit: canEditFiles,
      };
    });
    json(res, { ok: true, canEditFiles, workspaces });
    return true;
  }

  // 2. GET /api/files/list?dir=<path>
  if (url.pathname === '/api/files/list' && req.method === 'GET') {
    const rawDir = url.searchParams.get('dir') || (allowedWorkspaces[0]?.path ?? allowedWorkspaces[0] ?? '');
    const resolved = resolveAllowedFilePath(rawDir, allowedWorkspaces, { isLocal, viewer, access });
    if (!resolved) {
      json(res, { ok: false, error: 'forbidden_or_invalid_path' }, 403);
      return true;
    }
    try {
      const stat = await fsp.stat(resolved.fullPath);
      if (!stat.isDirectory()) {
        json(res, { ok: false, error: 'not_a_directory' }, 400);
        return true;
      }
      const allowLocalGemini = Boolean(isLocal || viewer?.isDirector);
      const dirents = await fsp.readdir(resolved.fullPath, { withFileTypes: true });
      const items = [];
      for (const d of dirents) {
        if (isSensitiveSegment(d.name, allowLocalGemini)) continue;
        const itemPath = path.join(resolved.fullPath, d.name);
        let itemStat = null;
        try {
          itemStat = await fsp.stat(itemPath);
        } catch {
          continue;
        }
        const isDir = itemStat.isDirectory();
        const ext = isDir ? '' : path.extname(d.name).toLowerCase();
        items.push({
          name: d.name,
          path: itemPath,
          relPath: path.relative(resolved.workspaceRoot, itemPath).replace(/\\/g, '/'),
          isDir,
          size: isDir ? 0 : itemStat.size,
          mtimeMs: itemStat.mtimeMs,
          ext,
          category: categorizeFile(d.name, isDir),
        });
      }
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      json(res, {
        ok: true,
        dir: resolved.fullPath,
        workspaceRoot: resolved.workspaceRoot,
        relDir: resolved.relPath,
        canEdit: canEditFiles,
        items,
      });
    } catch (err) {
      json(res, { ok: false, error: err?.message || 'readdir_failed' }, 404);
    }
    return true;
  }

  // 3. GET /api/files/preview?path=<path>
  if (url.pathname === '/api/files/preview' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path') || '';
    const resolved = resolveAllowedFilePath(rawPath, allowedWorkspaces, { isLocal, viewer, access });
    if (!resolved) {
      json(res, { ok: false, error: 'forbidden_or_invalid_path' }, 403);
      return true;
    }
    try {
      const stat = await fsp.stat(resolved.fullPath);
      if (!stat.isFile()) {
        json(res, { ok: false, error: 'not_a_file' }, 400);
        return true;
      }
      const name = path.basename(resolved.fullPath);
      const ext = path.extname(name).toLowerCase();
      const cat = categorizeFile(name, false);

      if (ext === '.docx') {
        const buf = await fsp.readFile(resolved.fullPath);
        const { html, text } = parseDocxBuffer(buf);
        json(res, {
          ok: true,
          kind: 'docx',
          name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          html,
          text,
        });
        return true;
      }

      if (ext === '.xlsx' || ext === '.csv' || ext === '.tsv') {
        let sheets = [];
        if (ext === '.xlsx') {
          const buf = await fsp.readFile(resolved.fullPath);
          sheets = parseXlsxBuffer(buf, 500, 50);
        } else {
          const maxRead = Math.min(stat.size, 2 * 1024 * 1024);
          const fh = await fsp.open(resolved.fullPath, 'r');
          try {
            const buf = Buffer.alloc(maxRead);
            await fh.read(buf, 0, maxRead, 0);
            sheets = parseDelimitedText(buf.toString('utf8'), ext === '.tsv' ? '\t' : ',', 500, 50);
          } finally {
            await fh.close();
          }
        }
        json(res, {
          ok: true,
          kind: 'xlsx',
          name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sheets,
        });
        return true;
      }

      if (ext === '.pdf' || IMAGE_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) {
        const mediaType = ext === '.pdf'
          ? 'pdf'
          : IMAGE_EXTENSIONS.has(ext)
            ? 'image'
            : VIDEO_EXTENSIONS.has(ext)
              ? 'video'
              : 'audio';
        json(res, {
          ok: true,
          kind: 'media',
          mediaType,
          name,
          ext,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        return true;
      }

      // Default to text/code if known text extension or small file without NUL bytes
      const maxBytes = 512 * 1024;
      const readLen = Math.min(stat.size, maxBytes);
      const fh = await fsp.open(resolved.fullPath, 'r');
      let buf;
      try {
        buf = Buffer.alloc(readLen);
        await fh.read(buf, 0, readLen, 0);
      } finally {
        await fh.close();
      }
      const isBinary = cat === 'other' && buf.subarray(0, Math.min(buf.length, 4096)).includes(0);
      if (isBinary) {
        json(res, {
          ok: true,
          kind: 'binary',
          name,
          ext,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
        return true;
      }
      json(res, {
        ok: true,
        kind: 'text',
        name,
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        content: buf.toString('utf8'),
        truncated: stat.size > maxBytes,
      });
    } catch (err) {
      json(res, { ok: false, error: err?.message || 'preview_failed' }, 404);
    }
    return true;
  }

  // 4. GET /api/files/raw?path=<path>&download=0|1
  if (url.pathname === '/api/files/raw' && req.method === 'GET') {
    const rawPath = url.searchParams.get('path') || '';
    const download = url.searchParams.get('download') === '1';
    const resolved = resolveAllowedFilePath(rawPath, allowedWorkspaces, { isLocal, viewer, access });
    if (!resolved) {
      res.writeHead(403).end('Forbidden');
      return true;
    }
    try {
      const stat = await fsp.stat(resolved.fullPath);
      if (!stat.isFile()) {
        res.writeHead(400).end('Not a file');
        return true;
      }
      const name = path.basename(resolved.fullPath);
      const ext = path.extname(name).toLowerCase();
      const contentType = MIME_MAP[ext] || 'application/octet-stream';
      const dispType = download ? 'attachment' : 'inline';
      const encodedName = encodeURIComponent(name);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Content-Disposition': `${dispType}; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'no-cache',
      });
      const stream = fs.createReadStream(resolved.fullPath);
      stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      stream.pipe(res);
    } catch {
      res.writeHead(404).end('Not found');
    }
    return true;
  }

  // 5. POST /api/files/upload
  if (url.pathname === '/api/files/upload' && req.method === 'POST') {
    if (!canEditFiles) {
      json(res, { ok: false, error: 'permission_denied' }, 403);
      return true;
    }
    const b = await readJson(req, 50 * 1024 * 1024);
    const rawDir = String(b?.dir || '');
    const resolvedDir = resolveAllowedFilePath(rawDir, allowedWorkspaces, { isLocal, viewer, access });
    if (!resolvedDir) {
      json(res, { ok: false, error: 'forbidden_or_invalid_dir' }, 403);
      return true;
    }
    const files = Array.isArray(b?.files) ? b.files : [];
    if (!files.length) {
      json(res, { ok: false, error: 'no_files' }, 400);
      return true;
    }
    const saved = [];
    try {
      const allowLocalGemini = Boolean(isLocal || viewer?.isDirector);
      for (const f of files.slice(0, 25)) {
        const cleanName = sanitizeFileName(f?.name);
        if (!cleanName || isSensitiveSegment(cleanName, allowLocalGemini)) continue;
        const targetPath = path.join(resolvedDir.fullPath, cleanName);
        if (!isInsideRoot(targetPath, resolvedDir.workspaceRoot)) continue;
        let b64 = String(f?.contentBase64 || f?.dataUrl || '');
        const commaIdx = b64.indexOf(',');
        if (b64.startsWith('data:') && commaIdx >= 0) {
          b64 = b64.slice(commaIdx + 1);
        }
        const buf = Buffer.from(b64, 'base64');
        await fsp.writeFile(targetPath, buf);
        saved.push({ name: cleanName, path: targetPath, size: buf.length });
      }
      json(res, { ok: true, saved });
    } catch (err) {
      json(res, { ok: false, error: err?.message || 'upload_failed' }, 500);
    }
    return true;
  }

  // 6. POST /api/files/action
  if (url.pathname === '/api/files/action' && req.method === 'POST') {
    if (!canEditFiles) {
      json(res, { ok: false, error: 'permission_denied' }, 403);
      return true;
    }
    const b = await readJson(req, 10 * 1024 * 1024);
    const action = String(b?.action || '');
    const rawPath = String(b?.path || b?.dir || '');
    const resolved = resolveAllowedFilePath(rawPath, allowedWorkspaces, { isLocal, viewer, access });
    if (!resolved) {
      json(res, { ok: false, error: 'forbidden_or_invalid_path' }, 403);
      return true;
    }
    const allowLocalGemini = Boolean(isLocal || viewer?.isDirector);

    try {
      if (action === 'mkdir') {
        const folderName = sanitizeFileName(b?.newName || b?.name || '');
        const targetDir = folderName ? path.join(resolved.fullPath, folderName) : resolved.fullPath;
        if (isSensitiveSegment(path.basename(targetDir), allowLocalGemini) || !isInsideRoot(targetDir, resolved.workspaceRoot)) {
          json(res, { ok: false, error: 'invalid_folder_name' }, 400);
          return true;
        }
        await fsp.mkdir(targetDir, { recursive: true });
        json(res, { ok: true, path: targetDir });
        return true;
      }

      if (action === 'rename') {
        const newName = sanitizeFileName(b?.newName || b?.name || '');
        if (!newName || isSensitiveSegment(newName, allowLocalGemini)) {
          json(res, { ok: false, error: 'invalid_new_name' }, 400);
          return true;
        }
        if (normComparePath(resolved.fullPath) === normComparePath(resolved.workspaceRoot)) {
          json(res, { ok: false, error: 'cannot_rename_workspace_root' }, 400);
          return true;
        }
        const destPath = path.join(path.dirname(resolved.fullPath), newName);
        if (!isInsideRoot(destPath, resolved.workspaceRoot)) {
          json(res, { ok: false, error: 'invalid_destination' }, 400);
          return true;
        }
        await fsp.rename(resolved.fullPath, destPath);
        json(res, { ok: true, path: destPath, name: newName });
        return true;
      }

      if (action === 'delete') {
        if (normComparePath(resolved.fullPath) === normComparePath(resolved.workspaceRoot)) {
          json(res, { ok: false, error: 'cannot_delete_workspace_root' }, 400);
          return true;
        }
        await fsp.rm(resolved.fullPath, { recursive: true, force: false });
        json(res, { ok: true, deleted: resolved.fullPath });
        return true;
      }

      if (action === 'writeText') {
        const content = typeof b?.content === 'string' ? b.content : '';
        await fsp.writeFile(resolved.fullPath, content, 'utf8');
        const st = await fsp.stat(resolved.fullPath);
        json(res, { ok: true, path: resolved.fullPath, size: st.size, mtimeMs: st.mtimeMs });
        return true;
      }

      json(res, { ok: false, error: 'unknown_action' }, 400);
    } catch (err) {
      json(res, { ok: false, error: err?.message || 'action_failed' }, 500);
    }
    return true;
  }

  return false;
}
