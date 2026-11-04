'use client';
/* eslint-disable @next/next/no-img-element */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Link from 'next/link';

/* ─── Types ─── */
interface LiveSession {
  id: string;
  sid?: string;
  name?: string;
  title?: string;
  project?: string;
  dir?: string;
  branch?: string;
  status?: string;
  busy?: boolean;
  model?: string;
  selectedModel?: string;
  ts?: number;
  lastTs?: number;
  updatedAt?: number;
  files?: string[];
  subs?: Array<{ id?: string; name?: string; role?: string; status?: string }>;
}

interface ProjectInfo {
  dir: string;
  rawDir?: string;
  name: string;
  selectedModel?: string;
}

interface TurnMedia {
  mime: string;
  url: string;
  name: string;
}

interface TurnStep {
  kind: 'thinking' | 'tool';
  text?: string;
  toolName?: string;
  type?: string;
  label?: string;
  desc?: string;
  file?: string;
  ts: number;
}

interface TurnFileChanged {
  path: string;
  name: string;
  added: number;
  removed: number;
}

interface ConversationTurn {
  id: string;
  userText: string;
  ts: number;
  media: TurnMedia[];
  steps: TurnStep[];
  responses: Array<{ text: string; ts: number }>;
  filesChanged: TurnFileChanged[];
  workDurationMs: number;
  lastTs: number;
}

interface ConversationArtifact {
  name: string;
  title: string;
  summary: string;
  mtimeMs: number;
  size: number;
  content: string;
}

interface ViewerPermissions {
  isDirector: boolean;
  role: string;
  canStop: boolean;
  canRename: boolean;
  canDelete: boolean;
  canEditFiles: boolean;
  canAddProject: boolean;
  canManageMcp: boolean;
  allowedWorkspaces: string[];
}

interface WorkspaceTreeItem {
  name: string;
  path: string;
  relPath: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  ext: string;
  category: string;
}

interface ConversationDetail {
  ok: boolean;
  id: string;
  sid: string;
  title: string;
  project: string;
  dir: string;
  branch: string;
  status: string;
  busy: boolean;
  model: string;
  selectedModel: string;
  turns: ConversationTurn[];
  artifacts: ConversationArtifact[];
  permissions?: Partial<ViewerPermissions>;
  viewer?: {
    id?: string;
    name?: string;
    role?: string;
    isDirector?: boolean;
    isDirectorDevice?: boolean;
    canEditFiles?: boolean;
    canStopSession?: boolean;
    canEditSession?: boolean;
    canDeleteSession?: boolean;
    allowedWorkspaces?: string[];
  };
}

interface OpenTab {
  key: string;
  kind: 'artifact' | 'file';
  name: string;
  title: string;
  path?: string;
  content: string;
  mtimeMs?: number;
}

interface AttachedImage {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
}

interface McpServerItem {
  name: string;
  command?: string;
  enabled?: boolean;
  status?: string;
  toolsCount?: number;
}

interface LimitsWindow {
  key: string;
  pct?: number;
  resetsAt?: number | null;
  remainingPct?: number;
}

interface LimitsStats {
  claudeGptLeft5hPct?: number;
  claudeGptLeftWeekPct?: number;
}

interface LimitsAccountOther {
  name?: string;
  email?: string;
  label?: string;
  account?: { email?: string; plan?: string };
  windows?: LimitsWindow[];
  stats?: LimitsStats | null;
}

interface LimitsSnapshot {
  email?: string;
  label?: string;
  useAiCredits?: boolean;
  account?: { email?: string; plan?: string };
  auto?: { on?: boolean; pick?: boolean; now?: string };
  windows?: LimitsWindow[];
  five?: LimitsWindow;
  seven?: LimitsWindow;
  fiveHour?: { remainingPct?: number };
  sevenDay?: { remainingPct?: number };
  stats?: LimitsStats | null;
  others?: LimitsAccountOther[];
}

/* ─── Default Fallback Blueprint Artifact (matches Screenshot 2 when viewing demo/empty artifact) ─── */
const DEFAULT_BLUEPRINT_MD = `# UI Redesign Blueprint

> [!IMPORTANT]
> **Critical Requirement**: Ensure all interactive elements maintain a minimum contrast ratio of 4.5:1 against the dark slate background (\`#0e0e12\`) and support full keyboard navigation across the 4-column IDE layout.

| Component | Target File | Visual Token | Status |
| :--- | :--- | :--- | :--- |
| **Top Window Bar** | \`src/components/antigravity/AntigravityIde.tsx\` | \`#0e0e11\` / \`28px\` | \`Verified\` |
| **Left Project Tree** | \`src/components/antigravity/AntigravityIde.tsx\` | \`#121215\` / \`230px\` | \`Active\` |
| **Conversation Stream** | \`src/styles/antigravity.css\` | \`#141418\` / \`510px\` | \`Active\` |
| **Artifact Viewer** | \`server/antigravity.mjs\` | \`#0e0e12\` / \`1fr\` | \`Synced\` |
| **Artifacts Rail** | \`app/antigravity/page.tsx\` | \`#121215\` / \`185px\` | \`Ready\` |

## 1. Architecture & Real-Time Synchronization

- **Conversation Stream (\`/api/antigravity/conversation\`)**: Parses live Antigravity protobuf & brain logs into structured user turns, collapsible tool steps (\`Worked for Xm >\`), assistant Markdown responses, and diff summaries (\`N files changed +A -B\`).
- **Artifact Preview & Editing (\`/api/antigravity/artifact\`)**: Automatically indexes \`implementation_plan.md\`, \`task.md\`, \`walkthrough.md\`, and custom blueprints inside the session brain directory.
- **Direct Task Dispatch (\`/api/tasks\` & \`/api/session/reply\`)**: Supports multimodal image paste (\`Ctrl+V\`), model selection (\`Gemini 4 Argon High\`, \`Claude Opus 4.6\`, \`Claude Sonnet 4.6\`, \`GPT-5.4\`), and \`Turbo\` / \`Planning\` execution modes.
`;

const AVAILABLE_MODELS = [
  'Gemini 4 Argon High',
  'Claude Opus 4.6',
  'Claude Sonnet 4.6',
  'GPT-5.4',
];

/* ─── Helper Functions ─── */
function formatRelativeShort(ts?: number): string {
  if (!ts) return '';
  const diffSec = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function formatDuration(ms?: number, stepCount?: number): string {
  if (!ms || ms < 1000) {
    const estSec = Math.max(2, (stepCount || 1) * 3);
    return estSec >= 60 ? `${Math.floor(estSec / 60)}m ${estSec % 60}s` : `${estSec}s`;
  }
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function extractProjectName(dir?: string, fallback?: string): string {
  if (fallback && fallback.trim() && fallback !== 'Unknown') return fallback.trim();
  if (!dir) return 'WorkOffice_Clone';
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || 'WorkOffice_Clone';
}

/* ─── Stylized Antigravity "A" Arch SVG Icon ─── */
function AntigravityArchLogo({
  className,
  size = 18,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M12 3.2C8.8 3.2 6.2 8.4 3.6 19.2C3.3 20.3 4.5 21 5.4 20.2C7.4 18.4 9.5 16.8 12 16.8C14.5 16.8 16.6 18.4 18.6 20.2C19.5 21 20.7 20.3 20.4 19.2C17.8 8.4 15.2 3.2 12 3.2ZM12 7.6C13.3 7.6 14.7 10.3 15.8 14.3C14.6 13.7 13.3 13.4 12 13.4C10.7 13.4 9.4 13.7 8.2 14.3C9.3 10.3 10.7 7.6 12 7.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* ─── File Language Badge (Matches Antigravity IDE Icons: JS, TS, ⚛, (), {}, 📄) ─── */
const FileLangBadge = React.memo(function FileLangBadge({ name }: { name?: string }) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) {
    return <span className="agy-lang-badge is-react">⚛</span>;
  }
  if (lower.endsWith('.ts')) {
    return <span className="agy-lang-badge is-ts">TS</span>;
  }
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return <span className="agy-lang-badge is-js">JS</span>;
  }
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.less')) {
    return <span className="agy-lang-badge is-css">()</span>;
  }
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
    return <span className="agy-lang-badge is-json">{'{}'}</span>;
  }
  if (lower.endsWith('.ps1') || lower.endsWith('.sh') || lower.endsWith('.cmd')) {
    return <span className="agy-lang-badge is-sh">&gt;_</span>;
  }
  return <span className="agy-lang-badge is-doc">📄</span>;
});

function isOpenableFileRef(str: string): boolean {
  const clean = str.trim().replace(/#L\d+.*$/, '');
  if (!clean || clean.includes(' ')) return false;
  return /\.(tsx|ts|jsx|js|mjs|cjs|css|scss|md|json|html|py|rs|toml|yml|yaml|ps1|sh)$/i.test(
    clean
  );
}

/* ─── Syntax Token Renderer for Code Viewer Lines ─── */
function renderCodeLineTokens(lineText: string): React.ReactNode {
  if (!lineText) return '\u00A0';
  if (lineText.length > 300) return lineText;
  const trimmed = lineText.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return <span className="agy-tok-comment">{lineText}</span>;
  }
  const commentIdx = lineText.indexOf(' //');
  if (commentIdx >= 0) {
    return (
      <>
        {renderCodeLineTokens(lineText.slice(0, commentIdx))}
        <span className="agy-tok-comment">{lineText.slice(commentIdx)}</span>
      </>
    );
  }

  const tokenRe =
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|export|from|const|let|var|function|async|await|return|if|else|for|while|of|in|try|catch|finally|continue|break|switch|case|default|new|typeof|instanceof|void|true|false|null|undefined|interface|type)\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][A-Za-z0-9_$]*)(?=\s*\()/g;

  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = tokenRe.exec(lineText)) !== null) {
    if (m.index > last) {
      out.push(lineText.slice(last, m.index));
    }
    if (m[1]) {
      out.push(
        <span key={k++} className="agy-tok-str">
          {m[1]}
        </span>
      );
    } else if (m[2]) {
      out.push(
        <span key={k++} className="agy-tok-kw">
          {m[2]}
        </span>
      );
    } else if (m[3]) {
      out.push(
        <span key={k++} className="agy-tok-num">
          {m[3]}
        </span>
      );
    } else if (m[4]) {
      out.push(
        <span key={k++} className="agy-tok-fn">
          {m[4]}
        </span>
      );
    }
    last = tokenRe.lastIndex;
  }
  if (last < lineText.length) {
    out.push(lineText.slice(last));
  }
  return out;
}

/* ─── Rich Markdown Renderer (supports Callouts, Tables, Code Blocks, File Links) ─── */
const MarkdownRenderer = React.memo(function MarkdownRenderer({
  markdown,
  isArtifact = false,
  onOpenFile,
}: {
  markdown: string;
  isArtifact?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const blocks = useMemo(() => {
    const renderInline = (text: string, keyPrefix: string): React.ReactNode[] => {
      const nodes: React.ReactNode[] = [];
      // Tokenize inline code `...`, markdown links [label](url), bold **...**, italic *...*
      const tokenRegex =
        /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      let idx = 0;

      while ((match = tokenRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          nodes.push(text.slice(lastIndex, match.index));
        }
        const token = match[0];
        if (token.startsWith('`') && token.endsWith('`')) {
          const inner = token.slice(1, -1);
          const isOpenable = isOpenableFileRef(inner);
          const isPathLike =
            isOpenable ||
            inner.includes('/') ||
            inner.includes('.') ||
            inner.startsWith('#');
          nodes.push(
            <code
              key={`${keyPrefix}-c-${idx++}`}
              className={`agy-inline-code ${isPathLike ? 'is-blue' : ''} ${
                isOpenable ? 'is-file-pill' : ''
              }`}
              onClick={() => {
                if (onOpenFile && isOpenable) {
                  onOpenFile(inner);
                }
              }}
              style={
                isOpenable && onOpenFile ? { cursor: 'pointer' } : undefined
              }
            >
              {isOpenable && <FileLangBadge name={inner} />}
              <span>{inner}</span>
            </code>
          );
        } else if (token.startsWith('[')) {
          const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
          if (linkMatch) {
            const [, label, rawUrl] = linkMatch;
            const cleanLabel = label.replace(/^`|`$/g, '');
            const isFileLink =
              rawUrl.startsWith('file://') ||
              rawUrl.startsWith('/') ||
              /^[a-zA-Z]:[/\\]/.test(rawUrl) ||
              isOpenableFileRef(rawUrl) ||
              isOpenableFileRef(cleanLabel);

            if (isFileLink && onOpenFile) {
              const filePath = rawUrl
                .replace(/^file:\/\/\/?/i, '')
                .replace(/#L\d+.*$/, '');
              nodes.push(
                <span
                  key={`${keyPrefix}-l-${idx++}`}
                  className="agy-file-pill-link"
                  onClick={() => onOpenFile(filePath)}
                  title={`Open ${filePath}`}
                >
                  <FileLangBadge name={cleanLabel || filePath} />
                  <span>{cleanLabel}</span>
                </span>
              );
            } else {
              nodes.push(
                <a
                  key={`${keyPrefix}-a-${idx++}`}
                  href={rawUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="agy-file-link"
                >
                  {cleanLabel}
                </a>
              );
            }
          } else {
            nodes.push(token);
          }
        } else if (token.startsWith('**') && token.endsWith('**')) {
          nodes.push(
            <strong key={`${keyPrefix}-b-${idx++}`}>{token.slice(2, -2)}</strong>
          );
        } else if (token.startsWith('*') && token.endsWith('*')) {
          nodes.push(
            <em key={`${keyPrefix}-i-${idx++}`}>{token.slice(1, -1)}</em>
          );
        }
        lastIndex = tokenRegex.lastIndex;
      }

      if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
      }
      return nodes;
    };

    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const parsed: React.ReactNode[] = [];
    let i = 0;
    let blockKey = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i++;
        continue;
      }

      // 1. Fenced code block ```
      if (line.trim().startsWith('```')) {
        const lang = line.trim().slice(3).trim() || 'code';
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing ```
        const codeText = codeLines.join('\n');
        const currentIdx = blockKey++;
        parsed.push(
          <div key={`cb-${currentIdx}`} className="agy-codeblock">
            <div className="agy-codeblock-hdr">
              <span>{lang}</span>
              <button
                type="button"
                className="agy-codeblock-copy"
                onClick={() => {
                  navigator.clipboard?.writeText(codeText);
                  setCopiedIdx(currentIdx);
                  setTimeout(() => setCopiedIdx(null), 1500);
                }}
              >
                {copiedIdx === currentIdx ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <pre className="agy-codeblock-pre">
              <code>{codeText}</code>
            </pre>
          </div>
        );
        continue;
      }

      // 2. GitHub Alert Callout or Blockquote (> [!IMPORTANT], > [!NOTE], etc.)
      if (line.trim().startsWith('>')) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        const firstLine = (quoteLines[0] || '').trim();
        const alertMatch = /^\[!(IMPORTANT|NOTE|TIP|WARNING|CAUTION)\]/i.exec(
          firstLine
        );
        if (alertMatch) {
          const alertType = alertMatch[1].toUpperCase();
          const bodyLines = [
            firstLine.replace(/^\[!(IMPORTANT|NOTE|TIP|WARNING|CAUTION)\]\s*/i, ''),
            ...quoteLines.slice(1),
          ].filter((l) => l.trim().length > 0);
          const typeClass =
            alertType === 'IMPORTANT'
              ? 'is-important'
              : alertType === 'NOTE'
              ? 'is-note'
              : alertType === 'TIP'
              ? 'is-tip'
              : alertType === 'WARNING'
              ? 'is-warning'
              : 'is-caution';
          const iconMap: Record<string, string> = {
            IMPORTANT: '🟣',
            NOTE: 'ℹ️',
            TIP: '💡',
            WARNING: '⚠️',
            CAUTION: '🛑',
          };
          const currentIdx = blockKey++;
          parsed.push(
            <div
              key={`callout-${currentIdx}`}
              className={`agy-callout ${typeClass}`}
            >
              <div className="agy-callout-title">
                <span>{iconMap[alertType] || '•'}</span>
                <span>{alertType}</span>
              </div>
              <div>
                {bodyLines.map((bl, bi) => (
                  <p key={bi} style={{ margin: bi > 0 ? '4px 0 0' : 0 }}>
                    {renderInline(bl, `co-${currentIdx}-${bi}`)}
                  </p>
                ))}
              </div>
            </div>
          );
        } else {
          const currentIdx = blockKey++;
          parsed.push(
            <div key={`quote-${currentIdx}`} className="agy-callout is-note">
              {quoteLines.map((ql, qi) => (
                <p key={qi} style={{ margin: qi > 0 ? '4px 0 0' : 0 }}>
                  {renderInline(ql, `q-${currentIdx}-${qi}`)}
                </p>
              ))}
            </div>
          );
        }
        continue;
      }

      // 3. Markdown Table (| col1 | col2 |)
      if (
        line.trim().startsWith('|') &&
        i + 1 < lines.length &&
        /^\s*\|[\s:-]+\|/.test(lines[i + 1])
      ) {
        const parseRow = (rowStr: string) =>
          rowStr
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((c) => c.trim());

        const headers = parseRow(lines[i]);
        i += 2; // skip header & separator row
        const rows: string[][] = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        const currentIdx = blockKey++;
        parsed.push(
          <div key={`tbl-${currentIdx}`} className="agy-table-wrap">
            <table className="agy-table">
              <thead>
                <tr>
                  {headers.map((h, hi) => (
                    <th key={hi}>{renderInline(h, `th-${currentIdx}-${hi}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((cell, ci) => (
                      <td key={ci}>
                        {renderInline(cell, `td-${currentIdx}-${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // 4. Headings (#, ##, ###)
      const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line.trim());
      if (headingMatch) {
        const level = headingMatch[1].length;
        const text = headingMatch[2];
        const currentIdx = blockKey++;
        if (level === 1) {
          parsed.push(
            <h1 key={`h1-${currentIdx}`}>
              {renderInline(text, `h1-${currentIdx}`)}
            </h1>
          );
        } else if (level === 2) {
          parsed.push(
            <h2 key={`h2-${currentIdx}`}>
              {renderInline(text, `h2-${currentIdx}`)}
            </h2>
          );
        } else {
          parsed.push(
            <h3 key={`h3-${currentIdx}`}>
              {renderInline(text, `h3-${currentIdx}`)}
            </h3>
          );
        }
        i++;
        continue;
      }

      // 5. Unordered or Ordered Lists
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const isOrdered = /^\s*\d+\.\s+/.test(line);
        const items: string[] = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
          i++;
        }
        const currentIdx = blockKey++;
        const ListTag = isOrdered ? 'ol' : 'ul';
        parsed.push(
          <ListTag key={`lst-${currentIdx}`}>
            {items.map((item, li) => {
              // Task list checkbox support: [x] or [ ]
              const taskMatch = /^\[([ xX/])\]\s+(.+)$/.exec(item);
              if (taskMatch) {
                const state = taskMatch[1].toLowerCase();
                const label = taskMatch[2];
                return (
                  <li key={li} style={{ listStyle: 'none', marginLeft: '-14px' }}>
                    <span style={{ marginRight: '6px' }}>
                      {state === 'x' ? '✅' : state === '/' ? '🔄' : '⬜'}
                    </span>
                    {renderInline(label, `li-${currentIdx}-${li}`)}
                  </li>
                );
              }
              return (
                <li key={li}>
                  {renderInline(item, `li-${currentIdx}-${li}`)}
                </li>
              );
            })}
          </ListTag>
        );
        continue;
      }

      // 6. Standard Paragraph
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].trim().startsWith('```') &&
        !lines[i].trim().startsWith('>') &&
        !lines[i].trim().startsWith('#') &&
        !lines[i].trim().startsWith('|') &&
        !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      const currentIdx = blockKey++;
      parsed.push(
        <p key={`p-${currentIdx}`}>
          {renderInline(paraLines.join(' '), `p-${currentIdx}`)}
        </p>
      );
    }

    return parsed;
  }, [markdown, copiedIdx, onOpenFile]);

  return (
    <div className={`agy-md ${isArtifact ? 'agy-artifact-md' : ''}`}>
      {blocks}
    </div>
  );
});

/* ─── Main Antigravity IDE Component ─── */
export default function AntigravityIde() {
  /* ─── Layout & Navigation State ─── */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Default: when entering a conversation, NO file or preview pane is open until user opens one
  const [rightPaneOpen, setRightPaneOpen] = useState(false);
  const [rightPaneMaximized, setRightPaneMaximized] = useState(false);
  const [artifactsRailOpen, setArtifactsRailOpen] = useState(true);
  const [rightRailMode, setRightRailMode] = useState<'workspace' | 'artifacts'>('workspace');

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [historyStack, setHistoryStack] = useState<Array<string | null>>([null]);
  const [historyIdx, setHistoryIdx] = useState<number>(0);

  /* ─── Search & Filter State ─── */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterActiveOnly, setFilterActiveOnly] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  /* ─── Data & Permission State from Backend APIs ─── */
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [viewerName, setViewerName] = useState<string>('Kiệt');
  const [viewerPerms, setViewerPerms] = useState<ViewerPermissions>({
    isDirector: true,
    role: 'Giám đốc',
    canStop: true,
    canRename: true,
    canDelete: true,
    canEditFiles: true,
    canAddProject: true,
    canManageMcp: true,
    allowedWorkspaces: ['*'],
  });
  const [quota5h, setQuota5h] = useState<string>('100%');
  const [quota7d, setQuota7d] = useState<string>('100%');
  const [limitsData, setLimitsData] = useState<LimitsSnapshot | null>(null);
  const [newAccountInput, setNewAccountInput] = useState<string>('');
  const [addingAccountBusy, setAddingAccountBusy] = useState<boolean>(false);
  const [editingAccountSlug, setEditingAccountSlug] = useState<string | null>(null);
  const [editingAccountLabel, setEditingAccountLabel] = useState<string>('');
  const [mcpServers, setMcpServers] = useState<McpServerItem[]>([]);
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [loadingConv, setLoadingConv] = useState(false);

  /* ─── Composer State ─── */
  const [selectedProjectDir, setSelectedProjectDir] = useState<string>('e:\\MyProject');
  const [selectedBranch, setSelectedBranch] = useState<string>('main');
  const [selectedModel, setSelectedModel] = useState<string>('Gemini 4 Argon High');
  const [execMode, setExecMode] = useState<'Turbo' | 'Planning'>('Turbo');
  const [promptText, setPromptText] = useState<string>('');
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [isSending, setIsSending] = useState(false);

  /* ─── Turn & Step Expansion State ─── */
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null);
  const [feedbackState, setFeedbackState] = useState<Record<string, 'up' | 'down'>>({});

  /* ─── Right Artifact / File Viewer & Workspace Explorer State ─── */
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string>('');
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [isEditingDoc, setIsEditingDoc] = useState(false);
  const [editDocContent, setEditDocContent] = useState('');
  const [isSavingDoc, setIsSavingDoc] = useState(false);
  const [wsTreeByDir, setWsTreeByDir] = useState<Record<string, WorkspaceTreeItem[]>>({});
  const [expandedWsDirs, setExpandedWsDirs] = useState<Record<string, boolean>>({});
  const [wsRootExpanded, setWsRootExpanded] = useState(true);

  /* ─── Modals State ─── */
  const [activeModal, setActiveModal] = useState<
    | null
    | 'automations'
    | 'customizations'
    | 'settings'
    | 'quota'
    | 'addProject'
    | 'renameSession'
    | 'renameFile'
  >(null);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectFolder, setNewProjectFolder] = useState('');
  const [renameText, setRenameText] = useState('');
  const [targetFileForAction, setTargetFileForAction] = useState<string>('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const convStreamRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const liveFetchingRef = useRef(false);
  const convFetchingRef = useRef(false);
  const lastTasksFetchRef = useRef(0);

  /* ─── Navigate Session with Back/Forward History ─── */
  const selectSession = useCallback(
    (id: string | null, pushHistory = true) => {
      setActiveSessionId(id);
      setIsEditingDoc(false);
      setSelectedLine(null);
      // Requirement: By default when entering a conversation, do NOT open any file
      setRightPaneOpen(false);
      setRightPaneMaximized(false);
      setOpenTabs([]);
      setActiveTabKey('');
      if (!id) {
        setConversation(null);
      }
      if (pushHistory) {
        setHistoryStack((prev) => {
          const sliced = prev.slice(0, historyIdx + 1);
          if (sliced[sliced.length - 1] === id) return sliced;
          return [...sliced, id];
        });
        setHistoryIdx((prev) => prev + 1);
      }
    },
    [historyIdx]
  );

  const goBack = () => {
    if (historyIdx > 0) {
      const nextIdx = historyIdx - 1;
      const targetId = historyStack[nextIdx] ?? null;
      setHistoryIdx(nextIdx);
      setActiveSessionId(targetId);
      setRightPaneOpen(false);
      setRightPaneMaximized(false);
      setOpenTabs([]);
      setActiveTabKey('');
      setSelectedLine(null);
      if (!targetId) setConversation(null);
    }
  };

  const goForward = () => {
    if (historyIdx < historyStack.length - 1) {
      const nextIdx = historyIdx + 1;
      const targetId = historyStack[nextIdx] ?? null;
      setHistoryIdx(nextIdx);
      setActiveSessionId(targetId);
      setRightPaneOpen(false);
      setRightPaneMaximized(false);
      setOpenTabs([]);
      setActiveTabKey('');
      setSelectedLine(null);
      if (!targetId) setConversation(null);
    }
  };

  const applyLimitsSnapshot = useCallback((lim: LimitsSnapshot | null | undefined) => {
    if (!lim || typeof lim !== 'object') return;
    setLimitsData(lim);
    const activeSlug = lim.auto?.on || lim.auto?.pick ? lim.auto?.now || '' : '';
    const activeOther = activeSlug
      ? (lim.others || []).find((o: LimitsAccountOther) => o.name === activeSlug)
      : null;
    const wins = activeOther ? activeOther.windows || [] : lim.windows || [];
    const w5 = wins.find((w: LimitsWindow) => w.key === 'session' || w.key === '5h') || lim.five;
    const w7 = wins.find((w: LimitsWindow) => w.key === 'weekly' || w.key === '7d') || lim.seven;
    if (w5 && typeof w5.pct === 'number') {
      const used5 = Math.max(0, Math.min(100, Math.round(w5.pct)));
      setQuota5h(`${Math.max(0, 100 - used5)}%`);
    } else if (lim.fiveHour?.remainingPct !== undefined) {
      setQuota5h(`${Math.round(lim.fiveHour.remainingPct)}%`);
    }
    if (w7 && typeof w7.pct === 'number') {
      const used7 = Math.max(0, Math.min(100, Math.round(w7.pct)));
      setQuota7d(`${Math.max(0, 100 - used7)}%`);
    } else if (lim.sevenDay?.remainingPct !== undefined) {
      setQuota7d(`${Math.round(lim.sevenDay.remainingPct)}%`);
    }
  }, []);

  /* ─── Poll `/api/live` & `/api/tasks` (Adaptive & Visibility-Aware) ─── */
  const fetchLiveAndTasks = useCallback(async (forceTasks = false) => {
    if (!forceTasks && typeof document !== 'undefined' && document.hidden) {
      return;
    }
    if (liveFetchingRef.current) return;
    liveFetchingRef.current = true;
    try {
      const now = Date.now();
      const shouldFetchTasks =
        forceTasks || now - lastTasksFetchRef.current >= 15000;
      if (shouldFetchTasks) {
        lastTasksFetchRef.current = now;
      }

      const [liveRes, tasksRes] = await Promise.all([
        fetch('/api/live', { cache: 'no-store' }),
        shouldFetchTasks
          ? fetch('/api/tasks', { cache: 'no-store' })
          : Promise.resolve(null),
      ]);

      if (liveRes.ok) {
        const liveData = await liveRes.json();
        const snap = liveData?.msgs?.[0] || liveData;
        if (Array.isArray(snap?.sessions)) {
          setSessions(snap.sessions);
        }
        if (snap?.viewer) {
          const v = snap.viewer;
          if (v.name && v.name !== 'Director' && v.name !== 'Giám đốc') {
            setViewerName(v.name);
          }
          const isDir = Boolean(
            v.isLocal || v.isDirector || v.isDirectorDevice || v.role === 'Phó Giám đốc' || v.role === 'Giám đốc'
          );
          setViewerPerms((prev) => ({
            ...prev,
            isDirector: isDir,
            role: v.role || (isDir ? 'Giám đốc' : 'Trợ lý Giám đốc'),
            canStop: isDir || Boolean(v.canStopSession ?? v.sessionPerms?.stop ?? true),
            canRename: isDir || Boolean(v.canEditSession ?? v.sessionPerms?.edit ?? true),
            canDelete: isDir || Boolean(v.canDeleteSession ?? v.sessionPerms?.delete ?? false),
            canEditFiles: isDir || Boolean(v.canEditFiles),
            canManageMcp: isDir,
            allowedWorkspaces: isDir
              ? ['*']
              : Array.isArray(v.allowedWorkspaces)
              ? v.allowedWorkspaces
              : prev.allowedWorkspaces,
          }));
        }
        if (snap?.limits) {
          applyLimitsSnapshot(snap.limits);
        }
        if (Array.isArray(snap?.mcp)) {
          setMcpServers(snap.mcp);
        }
      }

      if (tasksRes && tasksRes.ok) {
        const tasksData = await tasksRes.json();
        if (tasksData?.viewer) {
          const v = tasksData.viewer;
          const isDir = Boolean(
            v.isDirector || v.isDirectorDevice || v.role === 'Phó Giám đốc' || v.role === 'Giám đốc'
          );
          setViewerPerms((prev) => ({
            ...prev,
            isDirector: isDir,
            role: v.role || prev.role,
            canStop: isDir || Boolean(v.canStopSession ?? v.sessionPerms?.stop ?? prev.canStop),
            canRename: isDir || Boolean(v.canEditSession ?? v.sessionPerms?.edit ?? prev.canRename),
            canDelete: isDir || Boolean(v.canDeleteSession ?? v.sessionPerms?.delete ?? prev.canDelete),
            canEditFiles: isDir || Boolean(v.canEditFiles ?? prev.canEditFiles),
            canAddProject: isDir || Boolean(tasksData.allowed && (v.canEditSession ?? true)),
            allowedWorkspaces: isDir
              ? ['*']
              : Array.isArray(v.allowedWorkspaces)
              ? v.allowedWorkspaces
              : prev.allowedWorkspaces,
          }));
        }
        if (Array.isArray(tasksData?.projects)) {
          setProjects(tasksData.projects);
          if (tasksData.projects.length > 0) {
            setSelectedProjectDir((prev) => {
              const firstRaw = tasksData.projects[0].rawDir || tasksData.projects[0].dir;
              if (!prev) return firstRaw;
              // If user is restricted and current selectedProjectDir is not in allowed projects, switch to first allowed
              if (
                tasksData.scopedByMember &&
                !tasksData.projects.some(
                  (p: ProjectInfo) =>
                    (p.rawDir || p.dir).toLowerCase() === prev.toLowerCase()
                )
              ) {
                return firstRaw;
              }
              return prev;
            });
          }
        }
      }
    } catch {
      // ignore transient network errors
    } finally {
      liveFetchingRef.current = false;
    }
  }, [applyLimitsSnapshot]);

  useEffect(() => {
    const initTimer = setTimeout(() => {
      void fetchLiveAndTasks(true);
    }, 0);
    const timer = setInterval(() => {
      void fetchLiveAndTasks(false);
    }, 4000);
    const onVisChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void fetchLiveAndTasks(false);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisChange);
    }
    return () => {
      clearTimeout(initTimer);
      clearInterval(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisChange);
      }
    };
  }, [fetchLiveAndTasks]);

  /* ─── Fetch Active Conversation Turns & Artifacts ─── */
  const fetchConversation = useCallback(
    async (sid: string, silent = false) => {
      if (silent && typeof document !== 'undefined' && document.hidden) {
        return;
      }
      if (convFetchingRef.current) return;
      convFetchingRef.current = true;
      if (!silent) setLoadingConv(true);
      try {
        const res = await fetch(
          `/api/antigravity/conversation?id=${encodeURIComponent(sid)}`,
          { cache: 'no-store' }
        );
        if (!res.ok) return;
        const data: ConversationDetail = await res.json();
        if (data && data.ok) {
          setConversation(data);
          if (data.dir) setSelectedProjectDir(data.dir);
          if (data.branch) setSelectedBranch(data.branch);
          if (data.permissions) {
            setViewerPerms((prev) => ({
              ...prev,
              ...data.permissions,
              role: data.viewer?.role || prev.role,
            }));
          }

          // Only update artifacts that are ALREADY open in tabs; never auto-open any tab on load!
          const incomingArtifacts: ConversationArtifact[] = Array.isArray(
            data.artifacts
          )
            ? data.artifacts
            : [];

          if (incomingArtifacts.length > 0) {
            setOpenTabs((prevTabs) => {
              if (prevTabs.length === 0) return prevTabs;
              let changed = false;
              const nextTabs = prevTabs.map((t) => {
                if (t.kind !== 'artifact') return t;
                const found = incomingArtifacts.find(
                  (a) => `artifact:${a.name}` === t.key
                );
                if (found && found.content !== t.content) {
                  changed = true;
                  return {
                    ...t,
                    title: found.title || found.name,
                    content: found.content,
                    mtimeMs: found.mtimeMs,
                  };
                }
                return t;
              });
              return changed ? nextTabs : prevTabs;
            });
          }
        }
      } catch {
        // ignore transient fetch errors
      } finally {
        convFetchingRef.current = false;
        if (!silent) setLoadingConv(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const initTimer = setTimeout(() => {
      void fetchConversation(activeSessionId, false);
    }, 0);
    return () => {
      clearTimeout(initTimer);
    };
  }, [activeSessionId, fetchConversation]);

  const isSessionBusy = Boolean(
    conversation?.busy || conversation?.status === 'work'
  );

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const pollMs = isSessionBusy ? 2500 : 6000;
    const interval = setInterval(() => {
      void fetchConversation(activeSessionId, true);
    }, pollMs);
    const onVisChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void fetchConversation(activeSessionId, true);
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisChange);
    }
    return () => {
      clearInterval(interval);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisChange);
      }
    };
  }, [activeSessionId, isSessionBusy, fetchConversation]);

  /* ─── Group Projects & Conversations for Left Sidebar (Permission-Filtered!) ─── */
  const groupedProjects = useMemo(() => {
    const groups = new Map<
      string,
      { name: string; dir: string; sessions: LiveSession[] }
    >();

    const isDirAllowedForViewer = (dirPath?: string) => {
      if (viewerPerms.isDirector) return true;
      const al = viewerPerms.allowedWorkspaces || [];
      if (al.includes('*')) return true;
      if (!dirPath) return false;
      const normT = dirPath.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
      return al.some((w) => {
        const nw = String(w || '')
          .replace(/\//g, '\\')
          .replace(/\\+$/, '')
          .toLowerCase();
        return nw && (normT === nw || normT.startsWith(`${nw}\\`));
      });
    };

    // Add projects returned by `/api/tasks` (already filtered by server access control)
    for (const p of projects) {
      const rawDir = p.rawDir || p.dir;
      if (!isDirAllowedForViewer(rawDir)) continue;
      const pName = extractProjectName(rawDir, p.name);
      if (!groups.has(pName)) {
        groups.set(pName, { name: pName, dir: rawDir, sessions: [] });
      }
    }

    // Populate with live sessions allowed for this viewer
    for (const s of sessions) {
      if (s.dir && !isDirAllowedForViewer(s.dir)) continue;
      const pName = extractProjectName(s.dir, s.project);
      if (!groups.has(pName)) {
        if (!viewerPerms.isDirector && !isDirAllowedForViewer(s.dir)) continue;
        groups.set(pName, {
          name: pName,
          dir: s.dir || `e:\\${pName}`,
          sessions: [],
        });
      }
      const grp = groups.get(pName)!;
      if (filterActiveOnly && !s.busy && s.status !== 'work' && s.status !== 'wait') {
        continue;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const titleMatch = (s.title || s.name || '').toLowerCase().includes(q);
        const projMatch = pName.toLowerCase().includes(q);
        if (!titleMatch && !projMatch) continue;
      }
      grp.sessions.push(s);
    }

    // Sort sessions inside each group by timestamp descending and keep sidebar compact
    const result = Array.from(groups.values());
    for (const g of result) {
      g.sessions.sort(
        (a, b) =>
          (b.lastTs || b.updatedAt || b.ts || 0) -
          (a.lastTs || a.updatedAt || a.ts || 0)
      );
      if (!searchQuery.trim()) {
        g.sessions = g.sessions.slice(0, 3);
      }
    }
    return result;
  }, [projects, sessions, filterActiveOnly, searchQuery, viewerPerms]);

  /* ─── Workspace File Explorer Tree Loader (`/api/files/list`) ─── */
  const activeWorkspaceRoot = useMemo(() => {
    const raw =
      conversation?.dir ||
      selectedProjectDir ||
      groupedProjects[0]?.dir ||
      'e:\\MyProject';
    return raw.replace(/[/\\]+$/, '');
  }, [conversation?.dir, selectedProjectDir, groupedProjects]);

  const fetchWorkspaceDir = useCallback(async (dirPath: string) => {
    if (!dirPath) return;
    const cleanDir = dirPath.replace(/[/\\]+$/, '');
    try {
      const res = await fetch(
        `/api/files/list?dir=${encodeURIComponent(cleanDir)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok && Array.isArray(data.items)) {
        setWsTreeByDir((prev) => ({
          ...prev,
          [cleanDir]: data.items,
        }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (activeWorkspaceRoot) {
      const timer = setTimeout(() => {
        void fetchWorkspaceDir(activeWorkspaceRoot);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [activeWorkspaceRoot, fetchWorkspaceDir]);

  const toggleWorkspaceFolder = useCallback(
    (folderPath: string) => {
      const clean = folderPath.replace(/[/\\]+$/, '');
      setExpandedWsDirs((prev) => {
        const nextOpen = !prev[clean];
        if (nextOpen && !wsTreeByDir[clean]) {
          void fetchWorkspaceDir(clean);
        }
        return { ...prev, [clean]: nextOpen };
      });
    },
    [wsTreeByDir, fetchWorkspaceDir]
  );

  /* ─── Open Artifact or Workspace File in Right Pane ─── */
  const openArtifactInPane = (art: ConversationArtifact) => {
    const key = `artifact:${art.name}`;
    setOpenTabs((prev) => {
      const exists = prev.some((t) => t.key === key);
      if (exists) {
        return prev.map((t) =>
          t.key === key
            ? { ...t, content: art.content, title: art.title || art.name }
            : t
        );
      }
      return [
        ...prev,
        {
          key,
          kind: 'artifact',
          name: art.name,
          title: art.title || art.name,
          content: art.content,
          mtimeMs: art.mtimeMs,
        },
      ];
    });
    setActiveTabKey(key);
    setSelectedLine(null);
    setRightPaneOpen(true);
    setIsEditingDoc(false);
  };

  const openWorkspaceFileInPane = useCallback(
    async (rawPath: string) => {
      if (!rawPath) return;
      let resolvedPath = rawPath.trim().replace(/#L\d+.*$/, '');
      const baseDir = activeWorkspaceRoot || 'e:\\MyProject';
      if (
        !resolvedPath.startsWith('/') &&
        !/^[a-zA-Z]:[/\\]/.test(resolvedPath)
      ) {
        const sep = baseDir.includes('\\') ? '\\' : '/';
        resolvedPath = `${baseDir.replace(/[/\\]+$/, '')}${sep}${resolvedPath
          .replace(/^[/\\]+/, '')
          .replace(/[\\/]+/g, sep)}`;
      }

      const fileName =
        resolvedPath.replace(/\\/g, '/').split('/').pop() || resolvedPath;
      const key = `file:${resolvedPath}`;

      // Also expand parent folders inside Workspace Explorer Rail so the file is visible & highlighted
      const sep = resolvedPath.includes('\\') ? '\\' : '/';
      const parentDir = resolvedPath.slice(0, resolvedPath.lastIndexOf(sep));
      if (parentDir && parentDir.length >= baseDir.length) {
        setExpandedWsDirs((prev) => ({ ...prev, [parentDir]: true }));
        void fetchWorkspaceDir(parentDir);
      }
      setRightRailMode('workspace');

      try {
        const res = await fetch(
          `/api/files/preview?path=${encodeURIComponent(resolvedPath)}`
        );
        const data = await res.json();
        const content =
          data?.content ??
          data?.text ??
          `// File: ${resolvedPath}\n// (${data?.error || 'Preview unavailable'})`;

        setOpenTabs((prev) => {
          const exists = prev.some((t) => t.key === key);
          if (exists) {
            return prev.map((t) => (t.key === key ? { ...t, content } : t));
          }
          return [
            ...prev,
            {
              key,
              kind: 'file',
              name: fileName,
              title: fileName,
              path: resolvedPath,
              content,
            },
          ];
        });
        setActiveTabKey(key);
        setSelectedLine(null);
        setRightPaneOpen(true);
        setIsEditingDoc(false);
      } catch {
        // fallback
      }
    },
    [activeWorkspaceRoot, fetchWorkspaceDir]
  );

  const activeTab = useMemo(
    () => openTabs.find((t) => t.key === activeTabKey) || openTabs[0] || null,
    [openTabs, activeTabKey]
  );

  /* ─── Line Comment (`C`) & Quote (`Ctrl+L`) Actions in Code Viewer ─── */
  const handleCommentOnLine = useCallback(
    (lineNo: number) => {
      if (!activeTab) return;
      const relRef = `${activeTab.name}#L${lineNo}`;
      setPromptText((prev) =>
        prev ? `${prev}\nComment on \`${relRef}\`: ` : `Comment on \`${relRef}\`: `
      );
      setTimeout(() => composerTextareaRef.current?.focus(), 30);
    },
    [activeTab]
  );

  const handleQuoteLine = useCallback(
    (lineNo: number, lineContent: string) => {
      if (!activeTab) return;
      const snippet = lineContent.trim() || '(empty line)';
      const quoteBlock = `\`${activeTab.name}:${lineNo}\` — \`${snippet}\``;
      setPromptText((prev) =>
        prev ? `${prev}\n${quoteBlock}\n` : `${quoteBlock}\n`
      );
      setTimeout(() => composerTextareaRef.current?.focus(), 30);
    },
    [activeTab]
  );

  /* ─── Workspace File Rename / Delete / Create Folder Actions (Permission-Gated) ─── */
  const handleRenameWorkspaceFile = async () => {
    if (!viewerPerms.canEditFiles || !targetFileForAction || !renameText.trim()) {
      return;
    }
    const res = await fetch('/api/files/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'rename',
        path: targetFileForAction,
        newName: renameText.trim(),
      }),
    });
    if (res.ok) {
      const sep = targetFileForAction.includes('\\') ? '\\' : '/';
      const parentDir = targetFileForAction.slice(
        0,
        targetFileForAction.lastIndexOf(sep)
      );
      setActiveModal(null);
      setTargetFileForAction('');
      void fetchWorkspaceDir(parentDir || activeWorkspaceRoot);
    }
  };

  const handleDeleteWorkspaceFile = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!viewerPerms.canEditFiles) return;
    const res = await fetch('/api/files/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        path: filePath,
      }),
    });
    if (res.ok) {
      const sep = filePath.includes('\\') ? '\\' : '/';
      const parentDir = filePath.slice(0, filePath.lastIndexOf(sep));
      setOpenTabs((prev) => prev.filter((t) => t.path !== filePath));
      void fetchWorkspaceDir(parentDir || activeWorkspaceRoot);
    }
  };

  const closeTab = (key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      if (activeTabKey === key) {
        setActiveTabKey(next[next.length - 1]?.key || '');
      }
      return next;
    });
  };

  /* ─── Save Edited Artifact or Workspace File ─── */
  const handleSaveDocument = async () => {
    if (!activeTab) return;
    setIsSavingDoc(true);
    try {
      if (activeTab.kind === 'artifact' && conversation) {
        const res = await fetch('/api/antigravity/artifact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: conversation.id,
            sid: conversation.sid,
            name: activeTab.name,
            content: editDocContent,
          }),
        });
        if (res.ok) {
          setOpenTabs((prev) =>
            prev.map((t) =>
              t.key === activeTab.key ? { ...t, content: editDocContent } : t
            )
          );
          setIsEditingDoc(false);
        }
      } else if (activeTab.kind === 'file' && activeTab.path) {
        const res = await fetch('/api/files/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'writeText',
            path: activeTab.path,
            content: editDocContent,
          }),
        });
        if (res.ok) {
          setOpenTabs((prev) =>
            prev.map((t) =>
              t.key === activeTab.key ? { ...t, content: editDocContent } : t
            )
          );
          setIsEditingDoc(false);
        }
      }
    } finally {
      setIsSavingDoc(false);
    }
  };

  /* ─── Image Attachment Handlers (`+` button & `Ctrl+V` paste) ─── */
  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    Array.from(fileList).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl) return;
        setAttachedImages((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name || 'image.png',
            mime: file.type,
            dataUrl,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      handleFilesSelected(dt.files);
    }
  };

  /* ─── Send Prompt / Reply Handler ─── */
  const handleSendPrompt = async () => {
    const trimmed = promptText.trim();
    if ((!trimmed && attachedImages.length === 0) || isSending) return;

    setIsSending(true);
    const imagesPayload = attachedImages.map((img) => ({
      name: img.name,
      mime: img.mime,
      dataUrl: img.dataUrl,
    }));

    try {
      if (activeSessionId && conversation) {
        // Reply to active session
        const res = await fetch('/api/session/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: conversation.id || activeSessionId,
            sid: conversation.sid || activeSessionId,
            text: trimmed,
            model: selectedModel,
            images: imagesPayload,
          }),
        });
        if (!res.ok) {
          // Fallback to /api/tasks if session is idle/closed
          await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              dir: conversation.dir || selectedProjectDir,
              sid: conversation.sid || activeSessionId,
              id: conversation.id || activeSessionId,
              text: trimmed,
              model: selectedModel,
              images: imagesPayload,
            }),
          });
        }
        setPromptText('');
        setAttachedImages([]);
        setTimeout(() => {
          fetchConversation(activeSessionId, true);
          convStreamRef.current?.scrollTo({
            top: convStreamRef.current.scrollHeight,
            behavior: 'smooth',
          });
        }, 400);
      } else {
        // Dispatch new conversation task
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dir: selectedProjectDir,
            text: trimmed,
            model: selectedModel,
            images: imagesPayload,
          }),
        });
        const data = await res.json().catch(() => ({}));
        setPromptText('');
        setAttachedImages([]);
        await fetchLiveAndTasks(true);
        if (data?.id || data?.sid) {
          selectSession(data.id || data.sid);
        } else {
          // Select most recent session in selectedProjectDir if available
          const match = sessions.find((s) => s.dir === selectedProjectDir);
          if (match) selectSession(match.id);
        }
      }
    } finally {
      setIsSending(false);
    }
  };

  /* ─── Session Actions (Stop, Rename, Delete, Add Project) ─── */
  const handleStopSession = async () => {
    if (!conversation) return;
    await fetch('/api/session/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversation.id, sid: conversation.sid }),
    });
    fetchConversation(conversation.id, true);
  };

  const handleRenameSession = async () => {
    if (!conversation || !renameText.trim()) return;
    await fetch('/api/session/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: conversation.id,
        sid: conversation.sid,
        title: renameText.trim(),
      }),
    });
    setActiveModal(null);
    fetchConversation(conversation.id, true);
    void fetchLiveAndTasks(true);
  };

  const handleDeleteSession = async () => {
    if (!conversation) return;
    await fetch('/api/session/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: conversation.id, sid: conversation.sid }),
    });
    selectSession(null);
    void fetchLiveAndTasks(true);
  };

  const handleAddProject = async () => {
    if (!newProjectPath.trim()) return;
    await fetch('/api/projects/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dir: newProjectPath.trim(),
        newFolderName: newProjectFolder.trim() || undefined,
        createIfMissing: true,
      }),
    });
    setNewProjectPath('');
    setNewProjectFolder('');
    setActiveModal(null);
    void fetchLiveAndTasks(true);
  };

  const toggleMcpServer = async (srv: McpServerItem) => {
    await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'toggle',
        name: srv.name,
        enabled: !srv.enabled,
      }),
    });
    fetchLiveAndTasks();
  };

  /* ─── Antigravity Quota & Multi-Account Handlers ─── */
  const handleAddAgyAccount = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newAccountInput.trim();
    if (!clean || addingAccountBusy) return;
    setAddingAccountBusy(true);
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      const r = await res.json();
      if (r?.ok) {
        setNewAccountInput('');
        if (r.limits) applyLimitsSnapshot(r.limits);
        else void fetchLiveAndTasks(false);
      }
    } catch {
      // ignore
    } finally {
      setAddingAccountBusy(false);
    }
  };

  const handleUseAgyAccount = async (slug: string) => {
    try {
      const res = await fetch('/api/accounts/use', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug }),
      });
      const r = await res.json();
      if (r?.limits) applyLimitsSnapshot(r.limits);
      else void fetchLiveAndTasks(false);
    } catch {
      // ignore
    }
  };

  const handleRemoveAgyAccount = async (slug: string) => {
    if (!slug) return;
    try {
      const res = await fetch('/api/accounts/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug }),
      });
      const r = await res.json();
      if (r?.limits) applyLimitsSnapshot(r.limits);
      else void fetchLiveAndTasks(false);
    } catch {
      // ignore
    }
  };

  const handleRenameAgyAccount = async (slug: string) => {
    const clean = editingAccountLabel.trim();
    setEditingAccountSlug(null);
    try {
      const res = await fetch('/api/accounts/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: slug, label: clean, email: clean }),
      });
      const r = await res.json();
      if (r?.limits) applyLimitsSnapshot(r.limits);
      else void fetchLiveAndTasks(false);
    } catch {
      // ignore
    }
  };

  const handleToggleAutoSwitch = async (on: boolean) => {
    try {
      const res = await fetch('/api/accounts/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      const r = await res.json();
      if (r?.limits) applyLimitsSnapshot(r.limits);
      else void fetchLiveAndTasks(false);
    } catch {
      // ignore
    }
  };

  const handleToggleAiCredits = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/antigravity/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const r = await res.json();
      if (r?.limits) applyLimitsSnapshot(r.limits);
      else void fetchLiveAndTasks(false);
    } catch {
      // ignore
    }
  };

  const artifactList: ConversationArtifact[] = useMemo(() => {
    if (conversation?.artifacts && conversation.artifacts.length > 0) {
      return conversation.artifacts;
    }
    return [
      {
        name: 'UI Redesign Blueprint.md',
        title: 'UI Redesign Blueprint',
        summary: 'Default blueprint',
        mtimeMs: 0,
        size: DEFAULT_BLUEPRINT_MD.length,
        content: DEFAULT_BLUEPRINT_MD,
      },
    ];
  }, [conversation]);

  const allChangedFiles = useMemo(() => {
    if (!conversation?.turns) return [];
    const map = new Map<string, TurnFileChanged>();
    for (const t of conversation.turns) {
      for (const f of t.filesChanged || []) {
        map.set(f.path, f);
      }
    }
    return Array.from(map.values());
  }, [conversation]);

  /* ─── Recursive Workspace File Tree Renderer (Column 4) ─── */
  const renderWorkspaceTreeNodes = (
    dirPath: string,
    depth = 0
  ): React.ReactNode => {
    const cleanDir = dirPath.replace(/[/\\]+$/, '');
    const items = wsTreeByDir[cleanDir];
    if (!items) {
      return (
        <div
          className="agy-ws-empty"
          style={{ paddingLeft: 18 + depth * 12 }}
        >
          Loading...
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div
          className="agy-ws-empty"
          style={{ paddingLeft: 18 + depth * 12 }}
        >
          Empty folder
        </div>
      );
    }
    return items.map((item) => {
      const cleanItemPath = item.path.replace(/[/\\]+$/, '');
      if (item.isDir) {
        const isOpen = !!expandedWsDirs[cleanItemPath];
        return (
          <div key={cleanItemPath} className="agy-ws-node-group">
            <div
              className="agy-ws-tree-row is-dir"
              style={{ paddingLeft: 12 + depth * 12 }}
              onClick={() => toggleWorkspaceFolder(cleanItemPath)}
              title={item.path}
            >
              <span className="agy-ws-chevron">{isOpen ? '⌄' : '›'}</span>
              <span className="agy-ws-folder-ic">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className="agy-ws-node-name">{item.name}</span>
              {viewerPerms.canEditFiles && (
                <span
                  className="agy-ws-row-actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="agy-ws-act-btn"
                    title="Rename folder"
                    onClick={() => {
                      setTargetFileForAction(item.path);
                      setRenameText(item.name);
                      setActiveModal('renameFile');
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="agy-ws-act-btn is-del"
                    title="Delete folder"
                    onClick={(e) => handleDeleteWorkspaceFile(item.path, e)}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
            {isOpen && renderWorkspaceTreeNodes(cleanItemPath, depth + 1)}
          </div>
        );
      }

      const fileKey = `file:${item.path}`;
      const isSelected =
        activeTab?.key === fileKey ||
        (activeTab?.path &&
          activeTab.path.replace(/\\/g, '/').toLowerCase() ===
            item.path.replace(/\\/g, '/').toLowerCase());
      return (
        <div
          key={cleanItemPath}
          className={`agy-ws-tree-row is-file ${isSelected ? 'is-active' : ''}`}
          style={{ paddingLeft: 20 + depth * 12 }}
          onClick={() => openWorkspaceFileInPane(item.path)}
          title={item.path}
        >
          <FileLangBadge name={item.name} />
          <span className="agy-ws-node-name">{item.name}</span>
          {viewerPerms.canEditFiles && (
            <span
              className="agy-ws-row-actions"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="agy-ws-act-btn"
                title="Rename file"
                onClick={() => {
                  setTargetFileForAction(item.path);
                  setRenameText(item.name);
                  setActiveModal('renameFile');
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="agy-ws-act-btn is-del"
                title="Delete file"
                onClick={(e) => handleDeleteWorkspaceFile(item.path, e)}
              >
                ×
              </button>
            </span>
          )}
        </div>
      );
    });
  };

  return (
    <div
      className="agy-ide-root"
      onClick={() => {
        if (openMenu) setOpenMenu(null);
      }}
    >
      {/* Hidden File Input for Image Attachments */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFilesSelected(e.target.files);
          e.target.value = '';
        }}
      />

      {/* ─── 1. TOP WINDOW BAR (28px height, #0e0e11) ─── */}
      <header className="agy-window-bar">
        <div className="agy-win-left" onClick={(e) => e.stopPropagation()}>
          {/* Antigravity Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="agy-win-menu-item"
              onClick={() =>
                setOpenMenu(openMenu === 'antigravity' ? null : 'antigravity')
              }
            >
              Antigravity
            </button>
            {openMenu === 'antigravity' && (
              <div className="agy-dropdown-menu">
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    selectSession(null);
                    setOpenMenu(null);
                  }}
                >
                  <span>+ New Conversation</span>
                  <span className="agy-dropdown-shortcut">Ctrl+N</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setActiveModal('quota');
                    setOpenMenu(null);
                  }}
                >
                  <span>📊 Antigravity Quota & Accounts</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setActiveModal('settings');
                    setOpenMenu(null);
                  }}
                >
                  <span>⚙️ Settings</span>
                  <span className="agy-dropdown-shortcut">Ctrl+,</span>
                </button>
                <div className="agy-dropdown-sep" />
                <Link
                  href="/"
                  className="agy-dropdown-item"
                  style={{ textDecoration: 'none' }}
                >
                  <span>🏢 Return to 3D Work Office</span>
                </Link>
              </div>
            )}
          </div>

          {/* Workspace Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="agy-win-menu-item"
              onClick={() =>
                setOpenMenu(openMenu === 'workspace' ? null : 'workspace')
              }
            >
              Workspace
            </button>
            {openMenu === 'workspace' && (
              <div className="agy-dropdown-menu">
                {viewerPerms.canAddProject && (
                  <button
                    type="button"
                    className="agy-dropdown-item"
                    onClick={() => {
                      setActiveModal('addProject');
                      setOpenMenu(null);
                    }}
                  >
                    <span>📁+ Add Project Folder...</span>
                  </button>
                )}
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setActiveModal('automations');
                    setOpenMenu(null);
                  }}
                >
                  <span>🕒 Automations & Queue</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setActiveModal('customizations');
                    setOpenMenu(null);
                  }}
                >
                  <span>🧩 MCP Customizations</span>
                </button>
              </div>
            )}
          </div>

          {/* View Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="agy-win-menu-item"
              onClick={() => setOpenMenu(openMenu === 'view' ? null : 'view')}
            >
              View
            </button>
            {openMenu === 'view' && (
              <div className="agy-dropdown-menu">
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setSidebarCollapsed((v) => !v);
                    setOpenMenu(null);
                  }}
                >
                  <span>◧ Toggle Left Sidebar</span>
                  <span className="agy-dropdown-shortcut">Ctrl+B</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setRightPaneOpen((v) => !v);
                    setOpenMenu(null);
                  }}
                >
                  <span>◨ Toggle Artifact Preview Pane</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setArtifactsRailOpen((v) => !v);
                    setOpenMenu(null);
                  }}
                >
                  <span>▥ Toggle Far-Right Artifacts Rail</span>
                </button>
              </div>
            )}
          </div>

          {/* Window Menu */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="agy-win-menu-item"
              onClick={() =>
                setOpenMenu(openMenu === 'window' ? null : 'window')
              }
            >
              Window
            </button>
            {openMenu === 'window' && (
              <div className="agy-dropdown-menu">
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    setRightPaneMaximized((v) => !v);
                    setOpenMenu(null);
                  }}
                >
                  <span>⛶ Maximize / Restore Artifact Pane</span>
                </button>
                <button
                  type="button"
                  className="agy-dropdown-item"
                  onClick={() => {
                    fetchLiveAndTasks();
                    if (activeSessionId) fetchConversation(activeSessionId, false);
                    setOpenMenu(null);
                  }}
                >
                  <span>↻ Force Sync Live State</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="agy-win-right">
          {/* Sleek Pill Link back to 3D Work Office */}
          <Link href="/" className="agy-win-office-link" title="Switch to 3D Work Office">
            <span>🏢</span>
            <span>3D Work Office</span>
          </Link>

          {/* Live Status + Quota Indicator (Click to manage Quota & Accounts) */}
          <button
            type="button"
            className="agy-win-quota"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
            title="Bấm để xem Hạn mức gói Antigravity & Quản lý Tài khoản"
            onClick={() => setActiveModal('quota')}
          >
            <span className="agy-win-live-dot" />
            <span>5h: {quota5h}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span>7d: {quota7d}</span>
          </button>

          {/* Window Controls */}
          <div className="agy-win-controls">
            <button
              type="button"
              className="agy-win-ctrl-btn"
              title="Minimize Sidebar"
              onClick={() => setSidebarCollapsed((v) => !v)}
            >
              ─
            </button>
            <button
              type="button"
              className="agy-win-ctrl-btn"
              title="Toggle Fullscreen"
              onClick={() => {
                if (!document.fullscreenElement) {
                  document.documentElement.requestFullscreen?.().catch(() => {});
                } else {
                  document.exitFullscreen?.().catch(() => {});
                }
              }}
            >
              □
            </button>
            <Link
              href="/"
              className="agy-win-ctrl-btn is-close"
              title="Close IDE & Return to 3D Office"
              style={{ textDecoration: 'none' }}
            >
              ×
            </Link>
          </div>
        </div>
      </header>

      {/* ─── MAIN WORKSPACE BODY ─── */}
      <div className="agy-workspace">
        {/* ─── 2. LEFT SIDEBAR (230px wide, #121215) ─── */}
        <aside
          className={`agy-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}
        >
          {/* Brand & Navigation Row */}
          <div className="agy-sb-top-row">
            <div className="agy-sb-brand" onClick={() => selectSession(null)} style={{ cursor: 'pointer' }}>
              <AntigravityArchLogo className="agy-sb-logo-svg" size={18} />
              <button
                type="button"
                className="agy-sb-icon-btn"
                title="Collapse Sidebar"
                onClick={(e) => {
                  e.stopPropagation();
                  setSidebarCollapsed(true);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2.5" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
            </div>

            <div className="agy-sb-nav-btns">
              <button
                type="button"
                className="agy-sb-icon-btn"
                title="Back"
                disabled={historyIdx <= 0}
                onClick={goBack}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                type="button"
                className="agy-sb-icon-btn"
                title="Forward"
                disabled={historyIdx >= historyStack.length - 1}
                onClick={goForward}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
              <button
                type="button"
                className={`agy-sb-icon-btn ${searchOpen ? 'is-active' : ''}`}
                title="Search Projects & Conversations"
                onClick={() => setSearchOpen((v) => !v)}
              >
                <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="7.5" />
                  <path d="M20 20l-3.8-3.8" />
                </svg>
              </button>
            </div>
          </div>

          {/* Inline Search Filter */}
          {searchOpen && (
            <div className="agy-sb-search-wrap">
              <input
                type="text"
                className="agy-sb-search-input"
                placeholder="Filter projects or chats..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}

          {/* + New Conversation Button */}
          <button
            type="button"
            className={`agy-new-conv-btn ${
              activeSessionId === null ? 'is-active' : ''
            }`}
            onClick={() => selectSession(null)}
          >
            <span style={{ fontSize: '15px', lineHeight: 1, color: '#a1a1aa' }}>+</span>
            <span>New Conversation</span>
          </button>

          {/* Nav Items: Automations & Customizations */}
          <div className="agy-sb-nav-list">
            <button
              type="button"
              className="agy-sb-nav-item"
              onClick={() => setActiveModal('automations')}
            >
              <span className="agy-sb-nav-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15.5 14" />
                </svg>
              </span>
              <span>Automations</span>
            </button>
            <button
              type="button"
              className="agy-sb-nav-item"
              onClick={() => setActiveModal('customizations')}
            >
              <span className="agy-sb-nav-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="7" rx="1.5" />
                  <rect x="3" y="14" width="18" height="6" rx="1.5" />
                </svg>
              </span>
              <span>Customizations</span>
            </button>
          </div>

          {/* Projects Section Header */}
          <div className="agy-sb-projects-hdr">
            <span>Projects</span>
            <div className="agy-sb-projects-actions">
              <button
                type="button"
                className={`agy-sb-icon-btn ${filterActiveOnly ? 'is-active' : ''}`}
                title="Filter active conversations"
                onClick={() => setFilterActiveOnly((v) => !v)}
              >
                <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="7" y1="12" x2="17" y2="12" />
                  <line x1="10" y1="18" x2="14" y2="18" />
                </svg>
              </button>
              {viewerPerms.canAddProject && (
                <button
                  type="button"
                  className="agy-sb-icon-btn"
                  title="Add Project Folder"
                  onClick={() => setActiveModal('addProject')}
                >
                  <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    <line x1="12" y1="11" x2="12" y2="17" />
                    <line x1="9" y1="14" x2="15" y2="14" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Projects & Conversations Tree */}
          <div className="agy-sb-projects-scroll">
            {groupedProjects.map((proj) => {
              const isCollapsed = !!collapsedProjects[proj.name];
              return (
                <div key={proj.name} className="agy-proj-group">
                  <div
                    className="agy-proj-folder-row"
                    onClick={() => {
                      setSelectedProjectDir(proj.dir);
                      setCollapsedProjects((prev) => ({
                        ...prev,
                        [proj.name]: !prev[proj.name],
                      }));
                    }}
                  >
                    <span className="agy-proj-folder-icon">
                      <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                    </span>
                    <span className="agy-proj-folder-name">{proj.name}</span>
                  </div>

                  {!isCollapsed && (
                    <div className="agy-proj-conv-list">
                      {proj.sessions.length === 0 ? (
                        <div className="agy-conv-empty">No conversations</div>
                      ) : (
                        proj.sessions.map((sess) => {
                          const isSelected = activeSessionId === sess.id;
                          const isBusy =
                            sess.busy ||
                            sess.status === 'work' ||
                            sess.status === 'wait';
                          const relTime = formatRelativeShort(
                            sess.lastTs || sess.updatedAt || sess.ts
                          );
                          return (
                            <div
                              key={sess.id}
                              className={`agy-conv-row ${
                                isSelected ? 'is-active' : ''
                              }`}
                              onClick={() => selectSession(sess.id)}
                              title={sess.title || sess.name || sess.id}
                            >
                              <span className="agy-conv-title">
                                {sess.title || sess.name || 'Untitled Session'}
                              </span>
                              <span className="agy-conv-meta">
                                {isBusy && <span className="agy-conv-dot" />}
                                {relTime && (
                                  <span className="agy-conv-time">{relTime}</span>
                                )}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Bottom Sidebar Footer */}
          <div className="agy-sb-footer">
            <button
              type="button"
              className="agy-sb-settings-btn"
              onClick={() => setActiveModal('settings')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </aside>

        {/* ─── 3. MODE A: EMPTY / + NEW CONVERSATION HERO STATE (Matches Screenshot 1) ─── */}
        {activeSessionId === null ? (
          <main className="agy-hero-canvas">
            {sidebarCollapsed && (
              <button
                type="button"
                className="agy-sb-icon-btn"
                style={{ position: 'absolute', top: 12, left: 12, zIndex: 10 }}
                title="Expand Sidebar"
                onClick={() => setSidebarCollapsed(false)}
              >
                ◧
              </button>
            )}

            {/* Center Watermark & Greeting */}
            <div className="agy-hero-center">
              <AntigravityArchLogo className="agy-hero-watermark" size={64} />
              <h1 className="agy-hero-greeting">
                Hi {viewerName}, what can we get done today?
              </h1>
            </div>

            {/* Bottom-Centered Composer Card */}
            <div className="agy-hero-composer-wrap">
              <div className="agy-hero-composer-card">
                {/* Context Header Bar inside Card */}
                <div className="agy-composer-ctx-bar">
                  <div className="agy-composer-ctx-left">
                    <label className="agy-ctx-pill" title="Select Project Folder">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <select
                        value={selectedProjectDir}
                        onChange={(e) => setSelectedProjectDir(e.target.value)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'inherit',
                          font: 'inherit',
                          outline: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        {groupedProjects.map((gp) => (
                          <option
                            key={gp.name}
                            value={gp.dir}
                            style={{ background: '#18181f', color: '#e4e4e7' }}
                          >
                            {gp.name}
                          </option>
                        ))}
                      </select>
                      <span style={{ opacity: 0.6 }}>⌄</span>
                    </label>

                    <button
                      type="button"
                      className="agy-ctx-pill"
                      title="Git Branch"
                      onClick={() =>
                        setSelectedBranch((b) =>
                          b === 'main' ? 'master' : 'main'
                        )
                      }
                    >
                      <span>⑂</span>
                      <span>{selectedBranch}</span>
                      <span style={{ opacity: 0.6 }}>⌄</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    className="agy-ctx-terminal-btn"
                    title="Open Workspace Automations"
                    onClick={() => setActiveModal('automations')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </button>
                </div>

                {/* Inner Prompt Box */}
                <div className="agy-prompt-box" onPaste={handlePaste}>
                  {attachedImages.length > 0 && (
                    <div className="agy-prompt-media-row">
                      {attachedImages.map((img) => (
                        <div key={img.id} className="agy-prompt-thumb">
                          <img src={img.dataUrl} alt={img.name} />
                          <button
                            type="button"
                            className="agy-prompt-thumb-rm"
                            onClick={() =>
                              setAttachedImages((prev) =>
                                prev.filter((x) => x.id !== img.id)
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <textarea
                    className="agy-prompt-textarea"
                    placeholder="Ask anything, @ to mention, / for actions"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendPrompt();
                      }
                    }}
                  />

                  <div className="agy-prompt-toolbar">
                    <div className="agy-prompt-tools-left">
                      <button
                        type="button"
                        className="agy-prompt-plus-btn"
                        title="Attach Image (or Ctrl+V)"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        +
                      </button>

                      <label className="agy-prompt-pill" title="Select AI Model">
                        <select
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'inherit',
                            font: 'inherit',
                            outline: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {AVAILABLE_MODELS.map((m) => (
                            <option
                              key={m}
                              value={m}
                              style={{ background: '#18181f', color: '#e4e4e7' }}
                            >
                              {m}
                            </option>
                          ))}
                        </select>
                        <span style={{ fontSize: '10px', opacity: 0.6 }}>⌃</span>
                      </label>
                    </div>

                    <div className="agy-prompt-tools-right">
                      <button
                        type="button"
                        className="agy-prompt-pill"
                        title="Toggle Execution Mode (Turbo / Planning)"
                        onClick={() =>
                          setExecMode((m) =>
                            m === 'Turbo' ? 'Planning' : 'Turbo'
                          )
                        }
                      >
                        <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        <span>{execMode}</span>
                        <span style={{ fontSize: '10px', opacity: 0.6 }}>⌃</span>
                      </button>

                      <button
                        type="button"
                        className="agy-prompt-mic-btn"
                        title="Voice Input"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="23" />
                          <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className={`agy-prompt-send-btn ${
                          promptText.trim() || attachedImages.length > 0
                            ? 'is-ready'
                            : ''
                        }`}
                        disabled={
                          isSending ||
                          (!promptText.trim() && attachedImages.length === 0)
                        }
                        onClick={handleSendPrompt}
                        title="Send (Enter)"
                      >
                        →
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </main>
        ) : (
          /* ─── 4. MODE B: ACTIVE CONVERSATION SPLIT VIEW (Matches Screenshot 2) ─── */
          <div className="agy-active-split">
            {/* ─── COLUMN 2: CENTER CONVERSATION STREAM ─── */}
            {!rightPaneMaximized && (
              <section
                className={`agy-conv-col ${
                  !rightPaneOpen ? 'is-expanded' : ''
                }`}
              >
                {/* Header (40px height) */}
                <div className="agy-conv-hdr">
                  <div className="agy-conv-hdr-title">
                    {sidebarCollapsed && (
                      <button
                        type="button"
                        className="agy-sb-icon-btn"
                        onClick={() => setSidebarCollapsed(false)}
                        title="Expand Sidebar"
                      >
                        ◧
                      </button>
                    )}
                    <span className="agy-conv-hdr-proj">
                      {conversation?.project ||
                        extractProjectName(conversation?.dir)}
                    </span>
                    <span className="agy-conv-hdr-sep">/</span>
                    <span className="agy-conv-hdr-name">
                      {conversation?.title || 'Active Conversation'}
                    </span>
                  </div>

                  <div
                    className="agy-conv-hdr-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {conversation?.busy && (
                      <span
                        className="agy-live-dot-badge"
                        title="Agent is working"
                      >
                        ● Live
                      </span>
                    )}

                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        className="agy-sb-icon-btn"
                        title="Session Actions"
                        onClick={() =>
                          setOpenMenu(
                            openMenu === 'sessionMenu' ? null : 'sessionMenu'
                          )
                        }
                      >
                        ⋮
                      </button>
                      {openMenu === 'sessionMenu' && (
                        <div
                          className="agy-dropdown-menu"
                          style={{ right: 0, left: 'auto' }}
                        >
                          {viewerPerms.canRename ? (
                            <button
                              type="button"
                              className="agy-dropdown-item"
                              onClick={() => {
                                setRenameText(conversation?.title || '');
                                setActiveModal('renameSession');
                                setOpenMenu(null);
                              }}
                            >
                              <span>✏️ Rename Conversation</span>
                            </button>
                          ) : (
                            <div
                              className="agy-dropdown-item"
                              style={{ opacity: 0.45, cursor: 'not-allowed' }}
                            >
                              <span>🔒 Rename Conversation (No permission)</span>
                            </div>
                          )}

                          {viewerPerms.canStop ? (
                            <button
                              type="button"
                              className="agy-dropdown-item"
                              onClick={() => {
                                handleStopSession();
                                setOpenMenu(null);
                              }}
                            >
                              <span>⏹️ Stop Running Task</span>
                            </button>
                          ) : (
                            <div
                              className="agy-dropdown-item"
                              style={{ opacity: 0.45, cursor: 'not-allowed' }}
                            >
                              <span>🔒 Stop Task (No permission)</span>
                            </div>
                          )}

                          <div className="agy-dropdown-sep" />

                          {viewerPerms.canDelete ? (
                            <button
                              type="button"
                              className="agy-dropdown-item"
                              style={{ color: '#f87171' }}
                              onClick={() => {
                                handleDeleteSession();
                                setOpenMenu(null);
                              }}
                            >
                              <span>🗑️ Delete Session</span>
                            </button>
                          ) : (
                            <div
                              className="agy-dropdown-item"
                              style={{ opacity: 0.45, cursor: 'not-allowed' }}
                            >
                              <span>🔒 Delete Session (No permission)</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`agy-sb-icon-btn ${
                        rightPaneOpen ? 'is-active' : ''
                      }`}
                      title="Toggle Workspace Files & Artifact Viewer"
                      onClick={() => setRightPaneOpen((v) => !v)}
                    >
                      ◨
                    </button>
                  </div>
                </div>

                {/* Scrollable Conversation Turns */}
                <div ref={convStreamRef} className="agy-conv-stream">
                  {loadingConv && !conversation ? (
                    <div
                      style={{
                        color: '#71717a',
                        fontSize: '12.5px',
                        padding: '24px 0',
                        textAlign: 'center',
                      }}
                    >
                      Loading conversation turns...
                    </div>
                  ) : conversation?.turns && conversation.turns.length > 0 ? (
                    conversation.turns.map((turn, tIdx) => {
                      const isStepsOpen = !!expandedSteps[turn.id];
                      const isFilesOpen = !!expandedFiles[turn.id];
                      const totalAdded = (turn.filesChanged || []).reduce(
                        (acc, f) => acc + (f.added || 0),
                        0
                      );
                      const totalRemoved = (turn.filesChanged || []).reduce(
                        (acc, f) => acc + (f.removed || 0),
                        0
                      );
                      const isLastTurn =
                        tIdx === (conversation.turns?.length || 1) - 1;
                      const combinedResponse = (turn.responses || [])
                        .map((r) => r.text)
                        .join('\n\n');

                      return (
                        <div key={turn.id || tIdx} className="agy-turn">
                          {/* User Media Thumbnails */}
                          {turn.media && turn.media.length > 0 && (
                            <div className="agy-turn-user-Wrap">
                              <div className="agy-turn-media-grid">
                                {turn.media.map((m, mi) => (
                                  <img
                                    key={mi}
                                    src={m.url}
                                    alt={m.name || 'attachment'}
                                    className="agy-turn-media-img"
                                    onClick={() => setLightboxUrl(m.url)}
                                  />
                                ))}
                              </div>
                            </div>
                          )}

                          {/* User Message Bubble */}
                          {turn.userText && (
                            <div className="agy-turn-user-Wrap">
                              <div className="agy-turn-user-bubble">
                                {turn.userText}
                              </div>
                            </div>
                          )}

                          {/* Collapsible Worked / Thinking Row */}
                          {turn.steps && turn.steps.length > 0 && (
                            <div>
                              <button
                                type="button"
                                className="agy-turn-work-toggle"
                                onClick={() =>
                                  setExpandedSteps((prev) => ({
                                    ...prev,
                                    [turn.id]: !prev[turn.id],
                                  }))
                                }
                              >
                                <span>
                                  Worked for{' '}
                                  {formatDuration(
                                    turn.workDurationMs,
                                    turn.steps.length
                                  )}
                                </span>
                                <span
                                  className={`agy-turn-work-chevron ${
                                    isStepsOpen ? 'is-open' : ''
                                  }`}
                                >
                                  ›
                                </span>
                              </button>

                              {isStepsOpen && (
                                <div className="agy-turn-steps-list">
                                  {turn.steps.map((st, si) => {
                                    const icon =
                                      st.kind === 'thinking'
                                        ? '💭'
                                        : st.type === 'edit' ||
                                          st.toolName?.includes('edit') ||
                                          st.toolName?.includes('write')
                                        ? '✏️'
                                        : st.type === 'cmd' ||
                                          st.toolName?.includes('command')
                                        ? '⚡'
                                        : '📄';
                                    return (
                                      <div
                                        key={si}
                                        className="agy-turn-step-item"
                                      >
                                        <span className="agy-turn-step-icon">
                                          {icon}
                                        </span>
                                        <span className="agy-turn-step-desc">
                                          {st.label ||
                                            st.desc ||
                                            st.text ||
                                            st.toolName ||
                                            'Completed step'}
                                          {st.file && (
                                            <span
                                              className="agy-file-link"
                                              style={{ marginLeft: 6 }}
                                              onClick={() =>
                                                openWorkspaceFileInPane(
                                                  st.file!
                                                )
                                              }
                                            >
                                              {st.file
                                                .replace(/\\/g, '/')
                                                .split('/')
                                                .pop()}
                                            </span>
                                          )}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Assistant Markdown Response */}
                          {combinedResponse && (
                            <MarkdownRenderer
                              markdown={combinedResponse}
                              onOpenFile={openWorkspaceFileInPane}
                            />
                          )}

                          {/* File Changes Bar (Matches Screenshot 2: `4 files changed +252 -59 >` + `Review`) */}
                          {turn.filesChanged &&
                            turn.filesChanged.length > 0 && (
                              <div>
                                <div
                                  className="agy-files-changed-card"
                                  onClick={() =>
                                    setExpandedFiles((prev) => ({
                                      ...prev,
                                      [turn.id]: !prev[turn.id],
                                    }))
                                  }
                                >
                                  <div className="agy-files-changed-left">
                                    <span>
                                      {turn.filesChanged.length}{' '}
                                      {turn.filesChanged.length === 1
                                        ? 'file'
                                        : 'files'}{' '}
                                      changed
                                    </span>
                                    <span className="agy-diff-add">
                                      +{totalAdded}
                                    </span>
                                    <span className="agy-diff-del">
                                      -{totalRemoved}
                                    </span>
                                    <span style={{ opacity: 0.6 }}>
                                      {isFilesOpen ? '⌄' : '›'}
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    className="agy-review-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const firstFile =
                                        turn.filesChanged[0]?.path;
                                      if (firstFile) {
                                        openWorkspaceFileInPane(firstFile);
                                      }
                                    }}
                                  >
                                    <span>📄</span>
                                    <span>Review</span>
                                  </button>
                                </div>

                                {isFilesOpen && (
                                  <div className="agy-files-expanded-list">
                                    {turn.filesChanged.map((fc, fi) => (
                                      <div
                                        key={fi}
                                        className="agy-file-changed-row"
                                        onClick={() =>
                                          openWorkspaceFileInPane(fc.path)
                                        }
                                      >
                                        <span className="agy-file-changed-name">
                                          📄 {fc.name || fc.path}
                                        </span>
                                        <span
                                          style={{
                                            display: 'flex',
                                            gap: 6,
                                            fontSize: 11,
                                          }}
                                        >
                                          <span className="agy-diff-add">
                                            +{fc.added}
                                          </span>
                                          <span className="agy-diff-del">
                                            -{fc.removed}
                                          </span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                          {/* Turn Footer (`1 task running` on left, `<relativeTime> ago` + Copy/Thumbs up/down on right) */}
                          <div className="agy-turn-footer">
                            <div>
                              {isLastTurn && conversation.busy && (
                                <span className="agy-turn-running">
                                  <span className="agy-win-live-dot" />
                                  <span>1 task running</span>
                                </span>
                              )}
                            </div>

                            <div className="agy-turn-meta-right">
                              <span>
                                {formatRelativeShort(turn.lastTs || turn.ts)}{' '}
                                ago
                              </span>
                              <button
                                type="button"
                                className="agy-turn-act-btn"
                                title="Copy response"
                                onClick={() => {
                                  navigator.clipboard?.writeText(
                                    combinedResponse || turn.userText
                                  );
                                  setCopiedTurnId(turn.id);
                                  setTimeout(() => setCopiedTurnId(null), 1500);
                                }}
                              >
                                {copiedTurnId === turn.id ? '✓' : '📋'}
                              </button>
                              <button
                                type="button"
                                className="agy-turn-act-btn"
                                title="Helpful"
                                style={{
                                  color:
                                    feedbackState[turn.id] === 'up'
                                      ? '#4ade80'
                                      : undefined,
                                }}
                                onClick={() =>
                                  setFeedbackState((p) => ({
                                    ...p,
                                    [turn.id]: 'up',
                                  }))
                                }
                              >
                                👍
                              </button>
                              <button
                                type="button"
                                className="agy-turn-act-btn"
                                title="Not helpful"
                                style={{
                                  color:
                                    feedbackState[turn.id] === 'down'
                                      ? '#f87171'
                                      : undefined,
                                }}
                                onClick={() =>
                                  setFeedbackState((p) => ({
                                    ...p,
                                    [turn.id]: 'down',
                                  }))
                                }
                              >
                                👎
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="agy-turn">
                      <MarkdownRenderer
                        markdown={DEFAULT_BLUEPRINT_MD}
                        onOpenFile={openWorkspaceFileInPane}
                      />
                    </div>
                  )}
                </div>

                {/* Bottom Floating Composer */}
                <div className="agy-conv-composer" onPaste={handlePaste}>
                  {attachedImages.length > 0 && (
                    <div className="agy-prompt-media-row">
                      {attachedImages.map((img) => (
                        <div key={img.id} className="agy-prompt-thumb">
                          <img src={img.dataUrl} alt={img.name} />
                          <button
                            type="button"
                            className="agy-prompt-thumb-rm"
                            onClick={() =>
                              setAttachedImages((prev) =>
                                prev.filter((x) => x.id !== img.id)
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <textarea
                    ref={composerTextareaRef}
                    className="agy-prompt-textarea"
                    style={{ minHeight: 38 }}
                    placeholder="Ask anything, @ to mention, / for actions"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendPrompt();
                      }
                    }}
                  />

                  <div className="agy-prompt-toolbar">
                    <div className="agy-prompt-tools-left">
                      <button
                        type="button"
                        className="agy-prompt-plus-btn"
                        title="Attach Image"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        +
                      </button>

                      <label className="agy-prompt-pill">
                        <select
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'inherit',
                            font: 'inherit',
                            outline: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          {AVAILABLE_MODELS.map((m) => (
                            <option
                              key={m}
                              value={m}
                              style={{ background: '#18181f', color: '#e4e4e7' }}
                            >
                              {m}
                            </option>
                          ))}
                        </select>
                        <span style={{ fontSize: '10px', opacity: 0.6 }}>⌃</span>
                      </label>
                    </div>

                    <div className="agy-prompt-tools-right">
                      <button
                        type="button"
                        className="agy-prompt-pill"
                        onClick={() =>
                          setExecMode((m) =>
                            m === 'Turbo' ? 'Planning' : 'Turbo'
                          )
                        }
                      >
                        <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                        <span>{execMode}</span>
                        <span style={{ fontSize: '10px', opacity: 0.6 }}>⌃</span>
                      </button>

                      <button
                        type="button"
                        className="agy-prompt-mic-btn"
                        title="Voice Input"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="23" />
                          <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className="agy-prompt-send-btn is-ready"
                        disabled={
                          isSending ||
                          (!promptText.trim() && attachedImages.length === 0)
                        }
                        onClick={handleSendPrompt}
                        title="Send Reply"
                      >
                        →
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {/* ─── COLUMN 3: RIGHT ARTIFACT / CODE FILE PREVIEW PANE ─── */}
            {rightPaneOpen && (
              <section className="agy-viewer-col">
                {/* Top Tab Bar (38px height) */}
                <div className="agy-viewer-tabbar">
                  <div className="agy-viewer-tabs">
                    {openTabs.map((tab) => {
                      const isActive =
                        (activeTab && activeTab.key === tab.key) || false;
                      return (
                        <div
                          key={tab.key}
                          className={`agy-viewer-tab ${
                            isActive ? 'is-active' : ''
                          }`}
                          onClick={() => {
                            setActiveTabKey(tab.key);
                            setSelectedLine(null);
                            setIsEditingDoc(false);
                          }}
                        >
                          <span className="agy-viewer-tab-icon">
                            {tab.kind === 'artifact' ? (
                              '📄'
                            ) : (
                              <FileLangBadge name={tab.name} />
                            )}
                          </span>
                          <span className="agy-viewer-tab-title">
                            {tab.title}
                          </span>
                          <button
                            type="button"
                            className="agy-viewer-tab-close"
                            onClick={(e) => closeTab(tab.key, e)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="agy-viewer-tab-add"
                      title="Open Artifact in Tab"
                      onClick={() => {
                        if (artifactList.length > 0) {
                          openArtifactInPane(artifactList[0]);
                        }
                      }}
                    >
                      +
                    </button>
                  </div>

                  <div className="agy-viewer-win-btns">
                    <button
                      type="button"
                      className="agy-sb-icon-btn"
                      title={
                        rightPaneMaximized ? 'Restore Split View' : 'Maximize'
                      }
                      onClick={() => setRightPaneMaximized((v) => !v)}
                    >
                      ⛶
                    </button>
                    <button
                      type="button"
                      className="agy-sb-icon-btn"
                      title="Close Viewer Pane"
                      onClick={() => {
                        setRightPaneMaximized(false);
                        setRightPaneOpen(false);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>

                {/* Document / File Breadcrumb Sub-header (Matches `e: › WorkOffice_Clone › server › JS antigravity.mjs` in Screenshot) */}
                {activeTab && (
                  <div className="agy-viewer-subhdr">
                    <div className="agy-viewer-breadcrumb">
                      {activeTab.kind === 'file' && activeTab.path ? (
                        (() => {
                          const segs = activeTab.path
                            .replace(/\\/g, '/')
                            .split('/')
                            .filter(Boolean);
                          return segs.map((seg, sIdx) => {
                            const isLast = sIdx === segs.length - 1;
                            return (
                              <React.Fragment key={sIdx}>
                                {sIdx > 0 && (
                                  <span className="agy-bc-sep">›</span>
                                )}
                                <span
                                  className={`agy-bc-seg ${
                                    isLast ? 'is-last' : ''
                                  }`}
                                >
                                  {isLast && <FileLangBadge name={seg} />}
                                  <span>{seg}</span>
                                </span>
                              </React.Fragment>
                            );
                          });
                        })()
                      ) : (
                        <span className="agy-bc-seg is-last">
                          <span>{activeTab.title}</span>
                        </span>
                      )}
                    </div>

                    <div className="agy-viewer-doc-actions">
                      {isEditingDoc ? (
                        <>
                          <button
                            type="button"
                            className="agy-review-btn"
                            disabled={isSavingDoc || !viewerPerms.canEditFiles}
                            onClick={handleSaveDocument}
                          >
                            {isSavingDoc ? 'Saving...' : '💾 Save'}
                          </button>
                          <button
                            type="button"
                            className="agy-sb-icon-btn"
                            onClick={() => setIsEditingDoc(false)}
                            title="Cancel Edit"
                          >
                            ×
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="agy-sb-icon-btn"
                            title="Copy Document Content"
                            onClick={() =>
                              navigator.clipboard?.writeText(activeTab.content)
                            }
                          >
                            ⋮
                          </button>
                          {viewerPerms.canEditFiles ? (
                            <button
                              type="button"
                              className="agy-sb-icon-btn"
                              title="Edit File / Artifact"
                              onClick={() => {
                                setEditDocContent(activeTab.content);
                                setIsEditingDoc(true);
                              }}
                            >
                              ≡
                            </button>
                          ) : (
                            <span
                              className="agy-readonly-pill"
                              title="Read-only permission for your role"
                            >
                              🔒 Read-only
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Document / Code Content Body */}
                <div
                  className={`agy-viewer-body ${
                    activeTab &&
                    activeTab.kind === 'file' &&
                    !activeTab.name.toLowerCase().endsWith('.md') &&
                    !isEditingDoc
                      ? 'is-code-view'
                      : ''
                  }`}
                >
                  {!activeTab ? (
                    <div
                      style={{
                        color: '#71717a',
                        fontSize: '13px',
                        textAlign: 'center',
                        paddingTop: 64,
                      }}
                    >
                      Select a file from the{' '}
                      <strong style={{ color: '#d4d4d8' }}>Workspace</strong> tree
                      on the right or click any file in the conversation to view.
                    </div>
                  ) : isEditingDoc ? (
                    <textarea
                      className="agy-raw-editor"
                      value={editDocContent}
                      onChange={(e) => setEditDocContent(e.target.value)}
                    />
                  ) : activeTab.kind === 'artifact' ||
                    activeTab.name.toLowerCase().endsWith('.md') ? (
                    <MarkdownRenderer
                      markdown={activeTab.content}
                      isArtifact
                      onOpenFile={openWorkspaceFileInPane}
                    />
                  ) : (
                    /* Antigravity Native Line-Numbered Code Viewer with Active Line Highlight & `Comment C` / `Quote Ctrl+L` Pills */
                    <div className="agy-code-editor-view">
                      {String(activeTab.content || '')
                        .replace(/\r\n/g, '\n')
                        .split('\n')
                        .map((lineText, idx) => {
                          const lineNo = idx + 1;
                          const isLineSelected = selectedLine === lineNo;
                          return (
                            <div
                              key={lineNo}
                              className={`agy-code-line ${
                                isLineSelected ? 'is-selected' : ''
                              }`}
                              onClick={() => setSelectedLine(lineNo)}
                            >
                              <span className="agy-code-gutter">{lineNo}</span>
                              <span className="agy-code-text">
                                {renderCodeLineTokens(lineText)}
                              </span>
                              {isLineSelected && (
                                <div
                                  className="agy-code-line-actions"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className="agy-line-action-pill"
                                    onClick={() => handleCommentOnLine(lineNo)}
                                  >
                                    <span>Comment</span>
                                    <kbd>C</kbd>
                                  </button>
                                  <button
                                    type="button"
                                    className="agy-line-action-pill"
                                    onClick={() =>
                                      handleQuoteLine(lineNo, lineText)
                                    }
                                  >
                                    <span>Quote</span>
                                    <kbd>Ctrl+L</kbd>
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* ─── COLUMN 4: FAR-RIGHT WORKSPACE / ARTIFACTS EXPLORER SIDEBAR (Matches Screenshot `Workspace ⌄`) ─── */}
            {rightPaneOpen && artifactsRailOpen && (
              <aside className="agy-artifacts-rail">
                {/* Top Mode Switcher Header: `Workspace ⌄` vs `Artifacts` */}
                <div className="agy-ws-rail-top">
                  <button
                    type="button"
                    className="agy-ws-mode-switcher"
                    onClick={() =>
                      setRightRailMode((m) =>
                        m === 'workspace' ? 'artifacts' : 'workspace'
                      )
                    }
                    title="Switch between Workspace File Explorer and Session Artifacts"
                  >
                    <span>
                      {rightRailMode === 'workspace' ? 'Workspace' : 'Artifacts'}
                    </span>
                    <span style={{ opacity: 0.65, fontSize: 11 }}>⌄</span>
                  </button>

                  <div className="agy-ws-rail-top-btns">
                    <button
                      type="button"
                      className={`agy-ws-tab-mini ${
                        rightRailMode === 'workspace' ? 'is-active' : ''
                      }`}
                      onClick={() => setRightRailMode('workspace')}
                      title="Workspace Files"
                    >
                      📁
                    </button>
                    <button
                      type="button"
                      className={`agy-ws-tab-mini ${
                        rightRailMode === 'artifacts' ? 'is-active' : ''
                      }`}
                      onClick={() => setRightRailMode('artifacts')}
                      title="Conversation Artifacts"
                    >
                      📄
                    </button>
                  </div>
                </div>

                {rightRailMode === 'workspace' ? (
                  <div className="agy-ws-tree-scroll">
                    {/* Workspace Root Folder Header (`⌄ 📂 WorkOffice_Clone`) */}
                    <div
                      className="agy-ws-tree-row is-root"
                      onClick={() => setWsRootExpanded((v) => !v)}
                      title={activeWorkspaceRoot}
                    >
                      <span className="agy-ws-chevron">
                        {wsRootExpanded ? '⌄' : '›'}
                      </span>
                      <span className="agy-ws-folder-ic">
                        <svg
                          width="13.5"
                          height="13.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </span>
                      <span className="agy-ws-node-name">
                        {extractProjectName(activeWorkspaceRoot)}
                      </span>
                    </div>

                    {wsRootExpanded &&
                      renderWorkspaceTreeNodes(activeWorkspaceRoot, 0)}
                  </div>
                ) : (
                  <div className="agy-artifacts-rail-list">
                    <div className="agy-artifacts-rail-hdr">Artifacts</div>
                    {artifactList.map((art) => {
                      const key = `artifact:${art.name}`;
                      const isSelected = activeTab?.key === key;
                      const icon = art.name.includes('task')
                        ? '📋'
                        : art.name.includes('plan')
                        ? '📐'
                        : art.name.includes('walkthrough')
                        ? '📝'
                        : '📄';
                      return (
                        <div
                          key={art.name}
                          className={`agy-artifact-rail-item ${
                            isSelected ? 'is-active' : ''
                          }`}
                          onClick={() => openArtifactInPane(art)}
                          title={art.title || art.name}
                        >
                          <span className="agy-artifact-rail-icon">{icon}</span>
                          <span className="agy-artifact-rail-name">
                            {art.title || art.name}
                          </span>
                        </div>
                      );
                    })}

                    {allChangedFiles.length > 0 && (
                      <>
                        <div
                          className="agy-artifacts-rail-hdr"
                          style={{ marginTop: 12, paddingLeft: 8 }}
                        >
                          Files Changed
                        </div>
                        {allChangedFiles.map((fc) => {
                          const key = `file:${fc.path}`;
                          const isSelected = activeTab?.key === key;
                          return (
                            <div
                              key={fc.path}
                              className={`agy-artifact-rail-item ${
                                isSelected ? 'is-active' : ''
                              }`}
                              onClick={() => openWorkspaceFileInPane(fc.path)}
                              title={fc.path}
                            >
                              <FileLangBadge name={fc.name || fc.path} />
                              <span className="agy-artifact-rail-name">
                                {fc.name ||
                                  fc.path.replace(/\\/g, '/').split('/').pop()}
                              </span>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </aside>
            )}
          </div>
        )}
      </div>

      {/* ─── MODALS (Automations, Customizations, Settings, Add Project, Rename) ─── */}
      {activeModal && (
        <div
          className="agy-modal-backdrop"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="agy-modal-card"
            style={
              activeModal === 'quota'
                ? { maxWidth: 680, width: '94vw', maxHeight: '88vh', overflowY: 'auto' }
                : undefined
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div className="agy-modal-hdr">
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {activeModal === 'automations' && '🕒 Automations & Active Queue'}
                {activeModal === 'customizations' && '🧩 MCP Servers & Skills'}
                {activeModal === 'settings' && '⚙️ Antigravity IDE Settings & Access'}
                {activeModal === 'quota' && (
                  <>
                    <span style={{ fontSize: 18, fontWeight: 600, color: '#f4f4f5' }}>
                      Models &amp; Usage
                    </span>
                    <button
                      type="button"
                      className="agy-sb-icon-btn"
                      title="Refresh model quota"
                      onClick={() => void fetchLiveAndTasks(true)}
                      style={{ marginLeft: 2 }}
                    >
                      ↻
                    </button>
                  </>
                )}
                {activeModal === 'addProject' && '📁+ Add Project Folder'}
                {activeModal === 'renameSession' && '✏️ Rename Conversation'}
                {activeModal === 'renameFile' && '✏️ Rename File / Folder'}
              </span>
              <button
                type="button"
                className="agy-sb-icon-btn"
                onClick={() => setActiveModal(null)}
              >
                ×
              </button>
            </div>

            <div className="agy-modal-body">
              {activeModal === 'automations' && (
                <div>
                  <p style={{ marginTop: 0, color: '#a1a1aa' }}>
                    Live sessions and background automations synchronized with
                    Work Office 3D:
                  </p>
                  {sessions.length === 0 ? (
                    <div className="agy-conv-empty">No active sessions.</div>
                  ) : (
                    sessions.slice(0, 12).map((s) => (
                      <div key={s.id} className="agy-modal-list-item">
                        <div>
                          <div style={{ fontWeight: 600, color: '#e4e4e7' }}>
                            {s.title || s.name || s.id}
                          </div>
                          <div style={{ fontSize: 11, color: '#71717a' }}>
                            {extractProjectName(s.dir, s.project)} ·{' '}
                            {s.status || 'idle'}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="agy-review-btn"
                          onClick={() => {
                            selectSession(s.id);
                            setActiveModal(null);
                          }}
                        >
                          Open
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeModal === 'customizations' && (
                <div>
                  <p style={{ marginTop: 0, color: '#a1a1aa' }}>
                    Connected Model Context Protocol (MCP) servers:
                  </p>
                  {mcpServers.length === 0 ? (
                    <div className="agy-conv-empty">
                      No MCP servers reported by /api/mcp.
                    </div>
                  ) : (
                    mcpServers.map((srv) => (
                      <div key={srv.name} className="agy-modal-list-item">
                        <div>
                          <div style={{ fontWeight: 600, color: '#e4e4e7' }}>
                            🔌 {srv.name}
                          </div>
                          <div style={{ fontSize: 11, color: '#71717a' }}>
                            {srv.status || (srv.enabled ? 'Enabled' : 'Disabled')}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="agy-review-btn"
                          onClick={() => toggleMcpServer(srv)}
                        >
                          {srv.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeModal === 'settings' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="agy-modal-list-item">
                    <span>Current Viewer & Role</span>
                    <strong style={{ color: '#f4f4f5' }}>
                      {viewerName} ({viewerPerms.role})
                    </strong>
                  </div>
                  <div className="agy-modal-list-item">
                    <span>File & Session Permissions</span>
                    <strong
                      style={{
                        color: viewerPerms.isDirector ? '#4ade80' : '#fbbf24',
                        fontSize: 11.5,
                      }}
                    >
                      {[
                        viewerPerms.canEditFiles ? 'Edit/Save/Delete Files' : 'Read-Only Files',
                        viewerPerms.canRename ? 'Rename' : null,
                        viewerPerms.canStop ? 'Stop' : null,
                        viewerPerms.canDelete ? 'Delete Session' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </strong>
                  </div>
                  <div className="agy-modal-list-item">
                    <span>Allowed Project Workspaces</span>
                    <strong style={{ color: '#93c5fd', fontSize: 11.5 }}>
                      {viewerPerms.isDirector
                        ? 'All Workspaces (Full Access)'
                        : viewerPerms.allowedWorkspaces.length > 0
                        ? viewerPerms.allowedWorkspaces
                            .map((w) => extractProjectName(w))
                            .join(', ')
                        : 'Assigned Sessions Only'}
                    </strong>
                  </div>
                  <div className="agy-modal-list-item">
                    <span>Default Model</span>
                    <strong style={{ color: '#60a5fa' }}>{selectedModel}</strong>
                  </div>
                  <div className="agy-modal-list-item">
                    <span>Execution Mode</span>
                    <strong style={{ color: '#c084fc' }}>{execMode}</strong>
                  </div>
                  <div className="agy-modal-list-item">
                    <span>Quota Remaining (5h / 7d)</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <strong style={{ color: '#4ade80' }}>
                        {quota5h} / {quota7d}
                      </strong>
                      {viewerPerms.isDirector && (
                        <button
                          type="button"
                          className="agy-review-btn"
                          onClick={() => setActiveModal('quota')}
                        >
                          Quản lý Tài khoản
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeModal === 'quota' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {(() => {
                    const activeSlug =
                      limitsData?.auto?.on || limitsData?.auto?.pick
                        ? limitsData?.auto?.now || ''
                        : '';
                    const mainAccount = {
                      slug: '',
                      email:
                        limitsData?.email ||
                        limitsData?.account?.email ||
                        limitsData?.label ||
                        'Tài khoản chính',
                      label:
                        limitsData?.label ||
                        limitsData?.email ||
                        'Tài khoản chính',
                      plan: limitsData?.account?.plan || 'Google AI Ultra',
                      windows: limitsData?.windows || [],
                      stats: limitsData?.stats || null,
                    };
                    const otherAccounts = (limitsData?.others || []).map((o: LimitsAccountOther) => ({
                      slug: o.name || '',
                      email: o.email || o.label || o.name || '',
                      label: o.label || o.email || o.name || '',
                      plan: o.account?.plan || 'Google AI Ultra',
                      windows: o.windows || [],
                      stats: o.stats || null,
                    }));
                    const allAccounts = [mainAccount, ...otherAccounts];
                    const currentAcc =
                      allAccounts.find((a) => a.slug === activeSlug) || mainAccount;

                    const w5 = (currentAcc.windows || []).find(
                      (w: LimitsWindow) => w.key === 'session' || w.key === '5h'
                    );
                    const w7 = (currentAcc.windows || []).find(
                      (w: LimitsWindow) => w.key === 'weekly' || w.key === '7d'
                    );
                    const used5 = w5 && typeof w5.pct === 'number' ? Math.max(0, Math.min(100, Math.round(w5.pct))) : 0;
                    const used7 = w7 && typeof w7.pct === 'number' ? Math.max(0, Math.min(100, Math.round(w7.pct))) : 0;
                    const left5 = Math.max(0, 100 - used5);
                    const left7 = Math.max(0, 100 - used7);
                    const cgLeft5 = currentAcc.stats?.claudeGptLeft5hPct ?? 100;
                    const cgLeft7 = currentAcc.stats?.claudeGptLeftWeekPct ?? 100;
                    const useAiCredits = Boolean(limitsData?.useAiCredits);

                    const formatRefreshCountdown = (resetsAt?: number | null, isWeekly = false) => {
                      if (!resetsAt) {
                        return isWeekly ? '6 days, 5 hours' : '1 hour, 41 minutes';
                      }
                      const diffMs = Math.max(0, resetsAt - Date.now());
                      const totalMins = Math.max(1, Math.round(diffMs / 60000));
                      const days = Math.floor(totalMins / (24 * 60));
                      const hours = Math.floor((totalMins % (24 * 60)) / 60);
                      const mins = totalMins % 60;
                      if (days > 0) {
                        return `${days} ${days === 1 ? 'day' : 'days'}, ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
                      }
                      if (hours > 0) {
                        return `${hours} ${hours === 1 ? 'hour' : 'hours'}, ${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
                      }
                      return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
                    };

                    const renderQuotaRing = (pctRemaining: number) => {
                      const r = 13;
                      const c = 2 * Math.PI * r;
                      const clamped = Math.max(0, Math.min(100, pctRemaining));
                      const dashOffset = c * (1 - clamped / 100);
                      const strokeColor =
                        clamped <= 10 ? '#ef4444' : clamped <= 25 ? '#f59e0b' : '#4ade80';
                      return (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <span style={{ fontSize: 15, fontWeight: 700, color: '#fafafa' }}>
                            {clamped}%
                          </span>
                          <svg width="32" height="32" viewBox="0 0 32 32">
                            <circle
                              cx="16"
                              cy="16"
                              r={r}
                              fill="none"
                              stroke="#27272a"
                              strokeWidth="3.2"
                            />
                            <circle
                              cx="16"
                              cy="16"
                              r={r}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth="3.2"
                              strokeLinecap="round"
                              strokeDasharray={c}
                              strokeDashoffset={dashOffset}
                              transform="rotate(-90 16 16)"
                            />
                          </svg>
                        </div>
                      );
                    };

                    return (
                      <>
                        <div style={{ color: '#a1a1aa', fontSize: 13, marginTop: -6 }}>
                          Manage your model quota and credits.
                        </div>

                        {/* 1. Plan Section */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f4f4f5' }}>
                            Plan
                          </div>
                          <div
                            style={{
                              border: '1px solid #27272a',
                              background: '#111114',
                              borderRadius: 10,
                              padding: '14px 16px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 12,
                            }}
                          >
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                Your Plan: {currentAcc.plan || 'Google AI Ultra'}
                              </div>
                              <div style={{ fontSize: 12.5, color: '#a1a1aa', marginTop: 3 }}>
                                You are subscribed to the best Google AI plan.
                              </div>
                            </div>
                            <span
                              style={{
                                fontSize: 11.5,
                                padding: '4px 10px',
                                borderRadius: 999,
                                background: 'rgba(74, 222, 128, 0.14)',
                                color: '#4ade80',
                                fontWeight: 600,
                              }}
                            >
                              {currentAcc.email}
                            </span>
                          </div>
                        </div>

                        {/* 2. Model Credits Section */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f4f4f5' }}>
                            Model Credits
                          </div>
                          <div
                            style={{
                              border: '1px solid #27272a',
                              background: '#111114',
                              borderRadius: 10,
                              padding: '14px 16px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 16,
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                Enable AI Credit Overages
                              </div>
                              <div
                                style={{
                                  fontSize: 12.5,
                                  color: '#a1a1aa',
                                  marginTop: 4,
                                  lineHeight: 1.45,
                                }}
                              >
                                When toggled on, Antigravity will use your AI credits to fulfill
                                model requests once you&apos;re out of model quota. Antigravity
                                will always use your model quota first before using AI credits.
                              </div>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={useAiCredits}
                              disabled={!viewerPerms.isDirector}
                              onClick={() => void handleToggleAiCredits(!useAiCredits)}
                              style={{
                                width: 44,
                                height: 24,
                                borderRadius: 999,
                                background: useAiCredits ? '#4ade80' : '#27272a',
                                border: '1px solid #3f3f46',
                                padding: 2,
                                cursor: viewerPerms.isDirector ? 'pointer' : 'default',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: useAiCredits ? 'flex-end' : 'flex-start',
                                transition: 'background 0.15s ease',
                                flexShrink: 0,
                              }}
                            >
                              <span
                                style={{
                                  width: 18,
                                  height: 18,
                                  borderRadius: '50%',
                                  background: '#fafafa',
                                  display: 'block',
                                }}
                              />
                            </button>
                          </div>
                        </div>

                        {/* 3. Gemini Models Section */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div
                            style={{
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: '#f4f4f5',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <span>Gemini Models</span>
                            <span
                              style={{
                                fontSize: 11,
                                color: '#71717a',
                                border: '1px solid #3f3f46',
                                borderRadius: '50%',
                                width: 15,
                                height: 15,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              title="Includes Gemini 3.1 Pro, Gemini 3 Flash, and Gemini 4 Argon"
                            >
                              i
                            </span>
                          </div>
                          <div
                            style={{
                              border: '1px solid #27272a',
                              background: '#111114',
                              borderRadius: 10,
                              overflow: 'hidden',
                            }}
                          >
                            {/* Weekly Limit Remaining */}
                            <div
                              style={{
                                padding: '14px 16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                borderBottom: '1px solid #222226',
                              }}
                            >
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                  Weekly Limit Remaining
                                </div>
                                <div style={{ fontSize: 12.5, color: '#a1a1aa', marginTop: 3 }}>
                                  {left7 < 100
                                    ? `You have used some of your weekly limit, it will fully refresh in ${formatRefreshCountdown(w7?.resetsAt, true)}.`
                                    : 'You have 100% of your weekly limit remaining.'}
                                </div>
                              </div>
                              {renderQuotaRing(left7)}
                            </div>

                            {/* Five Hour Limit Remaining */}
                            <div
                              style={{
                                padding: '14px 16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                              }}
                            >
                              <div>
                                <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                  Five Hour Limit Remaining
                                </div>
                                <div style={{ fontSize: 12.5, color: '#a1a1aa', marginTop: 3 }}>
                                  {left5 < 100
                                    ? `You have used some of your 5-hour limit, it will fully refresh in ${formatRefreshCountdown(w5?.resetsAt, false)}.`
                                    : 'You have 100% of your 5-hour limit remaining.'}
                                </div>
                              </div>
                              {renderQuotaRing(left5)}
                            </div>
                          </div>
                        </div>

                        {/* 4. Claude and GPT models Section */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div
                            style={{
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: '#f4f4f5',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                          >
                            <span>Claude and GPT models</span>
                            <span
                              style={{
                                fontSize: 11,
                                color: '#71717a',
                                border: '1px solid #3f3f46',
                                borderRadius: '50%',
                                width: 15,
                                height: 15,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                              title="Includes Claude Sonnet/Opus and GPT models in Antigravity"
                            >
                              i
                            </span>
                          </div>
                          <div
                            style={{
                              border: '1px solid #27272a',
                              background: '#111114',
                              borderRadius: 10,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                padding: '14px 16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                borderBottom: '1px solid #222226',
                              }}
                            >
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                Weekly Limit Remaining
                              </div>
                              {renderQuotaRing(cgLeft7)}
                            </div>
                            <div
                              style={{
                                padding: '14px 16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                              }}
                            >
                              <div style={{ fontSize: 14, fontWeight: 600, color: '#fafafa' }}>
                                Five Hour Limit Remaining
                              </div>
                              {renderQuotaRing(cgLeft5)}
                            </div>
                          </div>
                        </div>

                        {/* 5. Multi-Account Management Section */}
                        <div
                          style={{
                            borderTop: '1px solid #27272a',
                            paddingTop: 14,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                          }}
                        >
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f4f4f5' }}>
                            Accounts &amp; Auto-Switch ({allAccounts.length})
                          </div>

                          {allAccounts.map((acc) => {
                            const isActive = activeSlug === acc.slug;
                            const isEditing = editingAccountSlug === acc.slug;
                            const aw5 = (acc.windows || []).find(
                              (w: LimitsWindow) => w.key === 'session' || w.key === '5h'
                            );
                            const aw7 = (acc.windows || []).find(
                              (w: LimitsWindow) => w.key === 'weekly' || w.key === '7d'
                            );
                            const aLeft5 = aw5 ? Math.max(0, 100 - Math.round(aw5.pct || 0)) : 100;
                            const aLeft7 = aw7 ? Math.max(0, 100 - Math.round(aw7.pct || 0)) : 100;

                            return (
                              <div
                                key={acc.slug || '__main__'}
                                style={{
                                  border: isActive
                                    ? '1px solid rgba(74, 222, 128, 0.45)'
                                    : '1px solid #27272a',
                                  background: isActive
                                    ? 'rgba(20, 83, 45, 0.14)'
                                    : '#111114',
                                  borderRadius: 10,
                                  padding: '10px 14px',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 10,
                                  flexWrap: 'wrap',
                                }}
                              >
                                {isEditing ? (
                                  <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                                    <input
                                      type="text"
                                      className="agy-sb-search-input"
                                      value={editingAccountLabel}
                                      maxLength={64}
                                      placeholder="Nhập Email hoặc tên tài khoản..."
                                      onChange={(e) => setEditingAccountLabel(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleRenameAgyAccount(acc.slug);
                                        if (e.key === 'Escape') setEditingAccountSlug(null);
                                      }}
                                    />
                                    <button
                                      type="button"
                                      className="agy-review-btn"
                                      onClick={() => void handleRenameAgyAccount(acc.slug)}
                                    >
                                      Lưu
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <strong style={{ color: '#f4f4f5', fontSize: 13 }}>
                                      📧 {acc.email || acc.label}
                                    </strong>
                                    <span style={{ fontSize: 11.5, color: '#a1a1aa' }}>
                                      (5h: {aLeft5}% · Weekly: {aLeft7}%)
                                    </span>
                                    {viewerPerms.isDirector && (
                                      <button
                                        type="button"
                                        className="agy-ws-act-btn"
                                        title="Đổi tên / Email hiển thị"
                                        onClick={() => {
                                          setEditingAccountSlug(acc.slug);
                                          setEditingAccountLabel(acc.email || acc.label);
                                        }}
                                      >
                                        ✏️
                                      </button>
                                    )}
                                  </div>
                                )}

                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {isActive ? (
                                    <span
                                      style={{
                                        fontSize: 11,
                                        padding: '2px 8px',
                                        borderRadius: 999,
                                        background: 'rgba(74, 222, 128, 0.18)',
                                        color: '#4ade80',
                                        fontWeight: 600,
                                      }}
                                    >
                                      Đang dùng
                                    </span>
                                  ) : (
                                    viewerPerms.isDirector && (
                                      <button
                                        type="button"
                                        className="agy-review-btn"
                                        onClick={() => void handleUseAgyAccount(acc.slug)}
                                      >
                                        Dùng
                                      </button>
                                    )
                                  )}
                                  {acc.slug && viewerPerms.isDirector && (
                                    <button
                                      type="button"
                                      className="agy-ws-act-btn is-del"
                                      title="Xóa tài khoản phụ này"
                                      onClick={() => void handleRemoveAgyAccount(acc.slug)}
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}

                          {viewerPerms.isDirector && (
                            <>
                              <div className="agy-modal-list-item">
                                <div>
                                  <div style={{ fontWeight: 600, color: '#e4e4e7', fontSize: 12.5 }}>
                                    🔄 Tự đổi tài khoản khi hết lượt
                                  </div>
                                  <div style={{ fontSize: 11, color: '#71717a' }}>
                                    Tự động chuyển sang tài khoản kế tiếp khi hạn mức chạm 0%.
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="agy-review-btn"
                                  onClick={() =>
                                    void handleToggleAutoSwitch(!limitsData?.auto?.on)
                                  }
                                >
                                  {limitsData?.auto?.on ? 'Đang Bật' : 'Đang Tắt'}
                                </button>
                              </div>

                              <form
                                onSubmit={handleAddAgyAccount}
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 8,
                                }}
                              >
                                <div style={{ display: 'flex', gap: 8 }}>
                                  <input
                                    type="text"
                                    className="agy-sb-search-input"
                                    maxLength={64}
                                    placeholder="Nhập Email Google dự phòng (VD: email2@gmail.com)"
                                    value={newAccountInput}
                                    onChange={(e) => setNewAccountInput(e.target.value)}
                                  />
                                  <button
                                    type="submit"
                                    className="agy-review-btn"
                                    disabled={addingAccountBusy || !newAccountInput.trim()}
                                    style={{ whiteSpace: 'nowrap', padding: '0 14px' }}
                                  >
                                    {addingAccountBusy ? 'Đang thêm...' : '+ Thêm tài khoản'}
                                  </button>
                                </div>
                              </form>
                            </>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}

              {activeModal === 'addProject' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ fontSize: 12, color: '#a1a1aa' }}>
                    Parent or Full Project Directory Path:
                  </label>
                  <input
                    type="text"
                    className="agy-sb-search-input"
                    placeholder="e.g. e:\MyNewProject"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                  />
                  <label style={{ fontSize: 12, color: '#a1a1aa' }}>
                    Optional New Subfolder Name:
                  </label>
                  <input
                    type="text"
                    className="agy-sb-search-input"
                    placeholder="Optional subfolder..."
                    value={newProjectFolder}
                    onChange={(e) => setNewProjectFolder(e.target.value)}
                  />
                  <button
                    type="button"
                    className="agy-restart-pill"
                    style={{ alignSelf: 'flex-end', padding: '6px 14px' }}
                    onClick={handleAddProject}
                  >
                    Add Project
                  </button>
                </div>
              )}

              {activeModal === 'renameSession' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ fontSize: 12, color: '#a1a1aa' }}>
                    New Conversation Title:
                  </label>
                  <input
                    type="text"
                    className="agy-sb-search-input"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                  />
                  <button
                    type="button"
                    className="agy-restart-pill"
                    style={{ alignSelf: 'flex-end', padding: '6px 14px' }}
                    onClick={handleRenameSession}
                  >
                    Save Title
                  </button>
                </div>
              )}

              {activeModal === 'renameFile' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <label style={{ fontSize: 12, color: '#a1a1aa' }}>
                    Target Path: <code style={{ color: '#93c5fd' }}>{targetFileForAction}</code>
                  </label>
                  <label style={{ fontSize: 12, color: '#a1a1aa' }}>
                    New File / Folder Name:
                  </label>
                  <input
                    type="text"
                    className="agy-sb-search-input"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameWorkspaceFile();
                    }}
                  />
                  <button
                    type="button"
                    className="agy-restart-pill"
                    style={{ alignSelf: 'flex-end', padding: '6px 14px' }}
                    onClick={handleRenameWorkspaceFile}
                  >
                    Rename
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Image Lightbox */}
      {lightboxUrl && (
        <div
          className="agy-modal-backdrop"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt="Full preview"
            style={{
              maxWidth: '90vw',
              maxHeight: '88vh',
              borderRadius: 10,
              border: '1px solid #2b2b36',
            }}
          />
        </div>
      )}
    </div>
  );
}
