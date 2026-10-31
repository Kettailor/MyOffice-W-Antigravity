#!/usr/bin/env node
// A hook runner for Antigravity and Claude Code: POSTs the hook's JSON from stdin to Work Office and prints the reply.
// Never fails the host IDE: when the office isn't running it exits cleanly (printing valid JSON for Antigravity hooks).
//   node hooks/send.mjs http://127.0.0.1:4310/event --async [--agy <EventName>]
//   node hooks/send.mjs http://127.0.0.1:4310/hook/permission [--agy PreToolUse]
const [url, ...flags] = process.argv.slice(2);
const quick = flags.includes('--async');
const agyIdx = flags.indexOf('--agy');
const agyEvent = agyIdx >= 0 ? flags[agyIdx + 1] || 'Event' : '';
const agyFallback = agyEvent === 'Stop' || agyEvent === 'PreToolUse' ? '{"decision":"allow"}' : '{}';

// Antigravity sessions are already tracked in real time via server/antigravity.mjs (SQLite + transcript.jsonl).
// Never block or send Antigravity hook payloads to /hook/permission or /event (prevents blocking Full Turbo and duplicate sessions).
if (agyEvent) {
  process.stdout.write(agyFallback);
  process.exit(0);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let body = Buffer.concat(chunks);
if (agyEvent && body.length) {
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !parsed.hook_event_name) {
      parsed.hook_event_name = agyEvent;
      body = Buffer.from(JSON.stringify(parsed));
    }
  } catch { /* raw body */ }
}

try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(quick ? 2000 : 55000),
  });
  const text = await r.text();
  if (!quick) process.stdout.write(agyEvent ? text.trim() || agyFallback : text);
  else if (agyEvent) process.stdout.write(agyFallback);
} catch {
  if (agyEvent) process.stdout.write(agyFallback);
}
