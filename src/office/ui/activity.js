// The activity column and the session list.
import { state } from '../core/state.js';
import { $, el, fmtBytes, fmtClock, hhmm, nowMs } from '../core/env.js';
import { STATUS_LABEL, verb } from './event-text.js';
import { TYPE_ICON, TYPE_TONE, icon } from './icons.js';
import { hoverRing, selRing } from '../interact/rings.js';
import { AGENT_NAME, agentMark, agentOf, awayHooks, colorOf, dn, dnOf, npcs, sessions, subs, workers } from '../people/workers.js';
import { renderLite } from './lite.js';
import { canSessionPerm, deleteSession, openSession, renameSession, renderActivity, renderSessionHead, renderSubs, stopSession, tab, toggleSession } from './session-drawer.js';
import { macSnap } from './mac-drawer.js';
import { queuePlace } from '../interact/place-cards.js';
import { unseenDone } from '../life/your-turn.js';
import { whereabouts } from '../people/outings.js';
import { imageUrl, openImage } from './image-view.js';
import { syncToggles, uiCfg } from './settings.js';
import { resize } from '../scene/renderer.js';
import { t as tr, num } from '../../i18n/index.js';

let feedFilter = 'all';
let query = '';
let toastEl;
let toastTimer;
export function toast(msg, ms = 3400) { toastEl.textContent = msg; toastEl.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms); }
const ATT = new Set(['wait', 'ask', 'fail', 'cired']);
export const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
// Consecutive events from the same session (or subagent) within four minutes share one card; alerts stand alone
// with their actions, so "needs you" never hides inside a group.
const KIND = { cmd: ['bash', 'test', 'testok', 'testfail', 'deploy', 'commit', 'push', 'pull', 'cired', 'cigreen'], edit: ['edit', 'write'], read: ['read', 'grep', 'glob', 'skill'], web: ['web', 'fetch', 'mcp'], agent: ['agent', 'substart', 'substop'] };
const typeFilter = new Set();
const expandedGroups = new Set();
const kindOk = (e) => !typeFilter.size || [...typeFilter].some((k) => KIND[k].includes(e.type));

function catOfEvent(e) {
  const t = e?.type || '';
  if (['read', 'grep', 'glob', 'skill', 'print'].includes(t)) return { cat: 'read', sum: 'read', emoji: '📄' };
  if (['edit', 'write', 'plan'].includes(t)) return { cat: 'edit', sum: 'edit', emoji: '✏️' };
  if (['bash', 'test', 'commit', 'push', 'pull'].includes(t)) return { cat: 'cmd', sum: 'cmd', emoji: '⚡' };
  if (['web', 'fetch', 'mcp'].includes(t)) return { cat: 'web', sum: 'web', emoji: '🌐' };
  if (['agent', 'substart', 'substop'].includes(t)) return { cat: 'agent', sum: 'agent', emoji: '🤖' };
  if (['stop', 'cigreen', 'testok', 'deploy'].includes(t)) return { cat: 'done', sum: 'other', emoji: '✅' };
  if (['wait', 'ask', 'fail', 'cired', 'testfail', 'interrupt'].includes(t)) return { cat: 'warn', sum: 'other', emoji: '⚠️' };
  return { cat: 'step', sum: 'other', emoji: '🔹' };
}

function attachThumb(host, e) {
  if (!e.img) return;
  const th = el('span', 'fg-thumb'), im = el('img');
  im.loading = 'lazy'; im.alt = ''; im.src = imageUrl(e.img);
  im.addEventListener('error', () => { th.remove(); host.classList.remove('has-thumb'); });
  th.dataset.img = e.img; th.dataset.name = e.label || ''; th.title = tr('activity.image.view');
  th.append(im); host.append(th); host.classList.add('has-thumb');
}

function lineOf(e) {
  const c = catOfEvent(e);
  const ln = el('span', 'fg-line fi'), ic = el('span', 'fi-ico');
  ic.append(icon(TYPE_ICON[e.type] || 'sparkle')); if (TYPE_TONE[e.type]) ic.dataset.tone = TYPE_TONE[e.type];
  const pill = el('span', 'fi-pill', tr(`activity.cat.${c.cat}`));
  pill.dataset.cat = c.cat;
  ln.append(ic, pill, el('span', 'fg-text', cap(verb(e))));
  attachThumb(ln, e);
  return ln;
}
export function feedRow(e) {
  const li = el('li', 'fr'); if (e.agent) li.dataset.agent = e.agent;
  li.append(lineOf(e), el('time', null, hhmm(e.ts)));
  return li;
}
function groupCard(g, live) {
  const s = sessions.get(g.sess), first = g.items[0];
  const grpKey = `${g.sess}:${g.agent || ''}:${g.items[g.items.length - 1]?.id || first.id}`;
  const isExpanded = expandedGroups.has(grpKey);
  const li = el('li', 'fg' + (live ? ' fg--live' : '') + (isExpanded ? ' is-expanded' : ''));
  li.dataset.grp = grpKey;
  const b = el('div', 'fg-card' + (live ? ' fg--live' : ''));
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  b.dataset.sess = g.sess;
  if (g.agent) b.dataset.agent = g.agent;

  const head = el('div', 'fg-head');
  const dot = el('i', 'fg-dot' + (live ? ' is-live' : ''));
  dot.style.background = live ? 'var(--green)' : (s ? colorOf(s) : '#5E687B');
  head.append(dot, el('b', 'fg-title', dnOf(first)));
  if (g.agent) head.append(el('span', 'fg-agent', tr('activity.subagent')));
  if (live) head.append(el('span', 'fg-live', tr('activity.working')));
  const timeBadge = el('time', 'fg-time-badge', ago(first.ts));
  timeBadge.title = hhmm(first.ts);
  head.append(timeBadge);

  const heroCat = catOfEvent(first);
  const hero = el('div', 'fi fi--hero');
  hero.dataset.cat = heroCat.cat;
  const heroPill = el('span', 'fi-pill', tr(`activity.cat.${heroCat.cat}`));
  heroPill.dataset.cat = heroCat.cat;
  const heroText = el('span', 'fg-text fi-hero-text', cap(verb(first)));
  hero.append(heroPill, heroText);
  attachThumb(hero, first);

  b.append(head, hero);

  const rest = g.items.slice(1);
  if (rest.length > 0) {
    const counts = { read: 0, edit: 0, cmd: 0, web: 0, agent: 0, other: 0 };
    const emojis = { read: '📄', edit: '✏️', cmd: '⚡', web: '🌐', agent: '🤖', other: '🔹' };
    for (const item of rest) {
      const { sum } = catOfEvent(item);
      counts[sum] = (counts[sum] || 0) + 1;
    }
    const summary = el('div', 'fg-summary');
    summary.setAttribute('role', 'button');
    summary.tabIndex = 0;
    summary.setAttribute('aria-expanded', String(isExpanded));
    const chipsWrap = el('div', 'fg-sum-chips');
    for (const k of ['read', 'edit', 'cmd', 'web', 'agent', 'other']) {
      if (!counts[k]) continue;
      const chip = el('span', 'fg-sum-chip', `${emojis[k]} ${counts[k]} ${tr(`activity.sum.${k}`)}`);
      chip.dataset.cat = k;
      chipsWrap.append(chip);
    }
    const toggleLbl = el('span', 'fg-sum-toggle', isExpanded ? tr('activity.collapseSteps') : tr('activity.expandSteps', { n: rest.length }));
    toggleLbl.dataset.count = String(rest.length);
    summary.append(chipsWrap, toggleLbl);

    const moreBox = el('div', 'fg-more fg-lines');
    moreBox.hidden = !isExpanded;
    for (const e of rest) moreBox.append(lineOf(e));
    b.append(summary, moreBox);
  }

  b.title = g.agent ? tr('activity.openSubChat') : tr('activity.openChat');
  li.append(b);
  return li;
}
function alertCard(e) {
  const s = sessions.get(e.sess), wait = e.type !== 'fail';
  const li = el('li', 'fg'), box = el('div', 'fa' + (wait ? ' fa--wait' : ''));
  const head = el('div', 'fa-head'); head.append(icon('alert'), el('b', null, dnOf(e)), el('time', null, hhmm(e.ts)));
  const acts = el('div', 'fa-acts');
  const open = el('button'); open.type = 'button'; open.dataset.sess = e.sess; if (e.agent) open.dataset.agent = e.agent; open.append(icon('monitor'), wait ? tr('activity.openToApprove') : tr('activity.seeError')); acts.append(open);
  if (s?.link) { const a = el('a'); a.href = s.link; a.target = '_blank'; a.rel = 'noopener'; a.append(icon('phone'), tr('activity.openOnPhone')); acts.append(a); }
  box.append(head, el('p', null, cap(verb(e))), acts);
  li.append(box);
  return li;
}
let lastFeedSig = '';
export function renderFeed() {
  const list = $('feed-list');
  const mainFeed = state.feed.filter((e) => !e.agent && !['agent', 'substart', 'substop'].includes(e.type));
  const latest = new Map();
  const latestWait = new Map();
  for (const e of mainFeed) {
    latest.set(e.sess, e.id);
    if (e.type === 'wait' || e.type === 'ask') latestWait.set(e.sess, e.id);
  }
  const isLiveAtt = (e) => {
    if (!ATT.has(e.type)) return false;
    if (e.type === 'wait' || e.type === 'ask') {
      const s = sessions.get(e.sess);
      return s?.status === 'wait' && latestWait.get(e.sess) === e.id;
    }
    return nowMs() - e.ts < 3600e3 && latest.get(e.sess) === e.id;
  };
  const rows = mainFeed.filter((e) => (feedFilter === 'all' || isLiveAtt(e)) && kindOk(e)).slice(-90).reverse();
  const att = mainFeed.filter(isLiveAtt).length;
  const attEl = $('att-count');
  if (attEl) { attEl.hidden = !att; const attStr = String(att); if (attEl.textContent !== attStr) attEl.textContent = attStr; }
  const feedFabCount = $('feed-fab-count'), feedFabBtn = $('feed-expand-fab');
  if (feedFabCount) feedFabCount.textContent = String(att || rows.length);
  if (feedFabBtn) feedFabBtn.dataset.att = String(att);
  const waitSig = [...sessions.values()].filter((s) => s.status === 'wait').map((s) => s.id).join(',');
  const sig = `${feedFilter}|${[...typeFilter].join(',')}|${state.streamer ? 1 : 0}|${att}|${waitSig}|${rows.map((e) => `${e.id}:${e.type}:${e.ts}:${dnOf(e)}`).join(';')}|${[...sessions.values()].filter((s) => s.status === 'work').map((s) => `${s.id}:${latest.get(s.id) || ''}`).join(',')}`;
  if (sig === lastFeedSig) return;
  lastFeedSig = sig;
  list.replaceChildren();
  if (!rows.length) list.append(el('li', 'fi-empty', tr(feedFilter === 'att' ? 'activity.empty.att' : typeFilter.size ? 'activity.empty.type' : 'activity.empty.all')));
  const groups = [];
  for (const e of rows) {
    const g = groups[groups.length - 1], attItem = isLiveAtt(e);
    if (g && !attItem && !g.att && g.sess === e.sess && g.items[g.items.length - 1].ts - e.ts < 240e3) g.items.push(e);
    else groups.push({ sess: e.sess, agent: null, att: attItem, items: [e] });
  }
  for (const g of groups) {
    if (g.att) { list.append(alertCard(g.items[0])); continue; }
    const s = sessions.get(g.sess);
    list.append(groupCard(g, s?.status === 'work' && g.items.some((e) => latest.get(g.sess) === e.id)));
  }
}
let feedQueued = false;
export function queueFeed() { if (feedQueued) return; feedQueued = true; requestAnimationFrame(() => { feedQueued = false; renderFeed(); if (state.selectedId && tab === 'act') renderActivity(); }); }
export function addFeed(e) { state.feed.push(e); if (state.feed.length > 150) state.feed = state.feed.slice(-150); queueFeed(); }
export function openFromRow(b) { if (b.dataset.agent) openSession(b.dataset.sess, { tab: 'subs', agent: b.dataset.agent }); else openSession(b.dataset.sess); }
function setFilter(f) { feedFilter = f; $('flt-all').setAttribute('aria-pressed', String(f === 'all')); $('flt-att').setAttribute('aria-pressed', String(f === 'att')); renderFeed(); }
function ago(ts) {
  const s = (nowMs() - (ts || 0)) / 1000;
  if (s < 3600) return tr('time.min', { n: Math.max(1, Math.floor(s / 60)) });
  if (s < 86400) return tr('time.hour', { n: Math.floor(s / 3600) });
  return tr('time.day', { n: Math.floor(s / 86400) });
}
export const HOME_IDLE_MS = 8 * 3600e3;
export function isAtHome(s) {
  if (!s || s.status !== 'rest' || s.bg?.length) return false;
  const w = workers.get(s.id);
  if (w) {
    if (w.away) return true;
    if (w.homeBound) return false;
  }
  const last = Math.max(s.doneAt || 0, s.lastAt || 0);
  return last > 0 && nowMs() - last >= HOME_IDLE_MS;
}
export function uiStatusOf(s) {
  if (!s) return 'rest';
  if (s.status === 'rest' && isAtHome(s)) return 'home';
  return s.status;
}
export function doingOf(s) {
  if (s.status === 'wait') return { ic: 'alert', text: tr('activity.doing.wait') };
  const where = whereabouts(workers.get(s.id));   // out of the office: at the shop, on the way home…
  if (isAtHome(s)) return { ic: 'zzz', text: tr('activity.doing.atHome', { time: ago(Math.max(s.doneAt || 0, s.lastAt || 0)) }) };
  if (where) return where;
  if (s.status === 'rest' && s.bg?.length) return { ic: 'terminal', text: `${tr('activity.doing.bg', { desc: s.bg[0].desc })}${s.bg.length > 1 ? ` (+${s.bg.length - 1})` : ''}` };
  if (s.status === 'rest') return { ic: 'zzz', text: nowMs() - (s.lastAt || 0) < 90e3 ? tr('activity.doing.justDone') : tr('activity.doing.resting', { time: ago(s.lastAt) }) };
  if (s.last) return { ic: TYPE_ICON[s.last.type] || 'sparkle', text: cap(verb(s.last)) };
  return { ic: 'sparkle', text: tr('activity.doing.working') };
}
const STATUS_RANK = { wait: 0, work: 1, rest: 2, home: 3 };
const order = (a, b) => (STATUS_RANK[uiStatusOf(a)] ?? 2) - (STATUS_RANK[uiStatusOf(b)] ?? 2) || (a.desk - b.desk);
let uiQueued = false;
export function queueUi() {
  if (uiQueued) return; uiQueued = true;
  requestAnimationFrame(() => {
    uiQueued = false; renderRail(); renderHud(); queueFeed(); state.boardDirty = true; queuePlace(); renderLite();
    if (state.selectedId) { renderSessionHead(); if (tab === 'subs' && !state.subView) renderSubs(); }
  });
}
// Rows are keyed by session id and updated in place, so keyboard focus and hover survive live updates. Sessions are
// grouped (needs you → working → idle → at home), each row shows how long the current task has run,
// the session's RAM (from the Mac snapshot, by pid) and a 30-minute activity sparkline.
const railRows = new Map();
const folderEls = new Map();
const foldedFolders = new Set();
let railOrder = '', railFilter = null, restCollapsed = false, homeCollapsed = false;
const GROUPS = [['wait'], ['work'], ['rest'], ['home']];   // labels: activity.group.<key>
let grpEls;
const SVGNS = 'http://www.w3.org/2000/svg';

function projInfoOf(s) {
  const raw = String(s?.dir || s?.cwd || '').trim();
  const norm = raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || '__other__';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts[parts.length - 1] || raw || tr('activity.group.otherFolder');
  const parent = parts.length > 1 ? parts.slice(-2, -1)[0] : '';
  const shortPath = parent ? `${parent}/${name}` : (raw || name);
  return { key: norm, name, path: raw || name, shortPath };
}

function saveFoldedFolders() {
  try { localStorage.setItem('office-folded-folders', JSON.stringify([...foldedFolders])); } catch { /* storage blocked */ }
}

function folderGroupEl(info) {
  const li = el('li', 'grp grp--folder');
  li.dataset.folder = info.key;
  const b = el('button', 'grp-btn grp-btn--folder');
  b.type = 'button';
  b.dataset.folder = info.key;
  b.setAttribute('aria-expanded', 'true');
  const ico = el('span', 'grp-folder-ico');
  ico.append(icon('folder'));
  const main = el('span', 'grp-folder-main');
  const title = el('b', 'grp-folder-name', info.name);
  const sub = el('small', 'grp-folder-path', info.path);
  main.append(title, sub);
  const badges = el('span', 'grp-folder-badges');
  const n = el('b', 'grp-count', '0');
  const ch = el('span', 'grp-chev');
  ch.append(icon('chevron'));
  b.append(ico, main, badges, n, ch);
  li.append(b);
  return { li, b, title, sub, badges, n };
}

export function syncRailToolbar() {
  const byFolder = uiCfg.groupByFolder !== false;
  const showPath = uiCfg.railShowPath !== false;
  const showMetrics = uiCfg.railShowMetrics !== false;
  const expandIdle = uiCfg.railExpandIdle !== false;
  for (const btn of document.querySelectorAll('[data-rail-group]')) {
    const on = (btn.dataset.railGroup === 'folder') === byFolder;
    btn.setAttribute('aria-pressed', String(on));
    btn.classList.toggle('is-on', on);
  }
  const cfgMap = { groupByFolder: byFolder, showPath, showMetrics, expandIdle };
  for (const tgl of document.querySelectorAll('[data-rail-cfg]')) {
    const k = tgl.dataset.railCfg;
    if (k in cfgMap) tgl.setAttribute('aria-checked', String(Boolean(cfgMap[k])));
  }
  const rail = $('rail-list');
  if (rail) {
    rail.classList.toggle('rail--by-folder', byFolder);
    rail.classList.toggle('rail--hide-path', !showPath);
    rail.classList.toggle('rail--hide-metrics', !showMetrics);
  }
}
function sparkEl() {
  const svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 45 14'); svg.setAttribute('class', 'spark'); svg.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 15; i++) { const r = document.createElementNS(SVGNS, 'rect'); r.setAttribute('x', i * 3); r.setAttribute('width', 2); r.setAttribute('y', 13); r.setAttribute('height', 1); r.setAttribute('rx', 0.6); svg.append(r); }
  return svg;
}
function sparkOf(id) { const now = nowMs(), b = new Array(15).fill(0); for (const e of state.feed) { if (e.sess !== id) continue; const k = Math.floor((now - e.ts) / 120e3); if (k >= 0 && k < 15) b[14 - k]++; } return b; }
function setSpark(svg, counts) {
  const max = Math.max(1, ...counts);
  counts.forEach((c, i) => { const h = c ? 2 + Math.round((c / max) * 11) : 1, r = svg.children[i]; r.setAttribute('y', 14 - h); r.setAttribute('height', h); r.classList.toggle('on', c > 0); });
}
const metaTime = (s) => (s.status === 'work' && s.taskStart ? fmtClock((nowMs() - s.taskStart) / 1000) : s.status === 'wait' ? tr('activity.waitingFor', { time: ago(s.lastAt) }) : ago(s.lastAt));
function railRow(s) {
  const li = el('li', 'ri-li sess-item');
  const b = el('button', 'ri sess'); b.type = 'button'; b.dataset.sess = s.id;
  const av = el('span', 'av'), avTxt = el('span', 'av-txt'); av.append(avTxt, el('i', 'av-st')); avTxt.append(agentMark(agentOf(s))); av.title = AGENT_NAME[agentOf(s)];
  const main = el('span', 'ri-main'), top = el('span', 'ri-top'), name = el('span', 'ri-name'), subline = el('span', 'ri-subline');
  const doing = el('span', 'ri-doing');
  const dIco = el('span', 'ri-dico'), dTxt = el('span', 'ri-dtxt'), subPill = el('span', 'ri-sub-pill');
  subPill.hidden = true;
  doing.append(dIco, dTxt, subPill);
  top.append(name);
  main.append(top, subline);
  const meta = el('span', 'ri-meta'), stBadge = el('span', 'ri-st-badge pill'), time = el('span', 'ri-time'), ram = el('span', 'ri-ram'), spark = sparkEl();
  const stop = el('button', 'ri-stop', '⏹');
  stop.type = 'button';
  stop.title = tr('drawer.stop.title');
  stop.setAttribute('aria-label', tr('drawer.stop.title'));
  stop.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stop.disabled = true;
    await stopSession(sessions.get(s.id) || s);
    stop.disabled = false;
  });
  const edit = el('button', 'ri-edit', '✏️');
  edit.type = 'button';
  edit.title = tr('drawer.rename.title');
  edit.setAttribute('aria-label', tr('drawer.rename.title'));
  edit.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const curSess = sessions.get(s.id) || s;
    const current = dn(curSess);
    const f = el('form', 'ri-rename-form');
    const inp = el('input', 'ri-rename-in');
    inp.type = 'text';
    inp.maxLength = 75;
    inp.value = current;
    inp.placeholder = curSess.name || tr('drawer.rename.placeholder');
    inp.autocomplete = 'off';
    f.append(inp);
    name.replaceWith(f);
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const val = inp.value.trim();
      f.replaceWith(name);
      const rowRef = railRows.get(s.id);
      if (rowRef) rowRef.nameKey = '';
      if (save && val !== current) {
        await renameSession(curSess, val);
      }
      renderRail();
    };
    f.addEventListener('submit', (e) => { e.preventDefault(); e.stopPropagation(); finish(true); });
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    inp.focus();
    inp.select();
  });
  const del = el('button', 'ri-del', '×');
  del.type = 'button';
  del.title = tr('drawer.delete.title');
  del.setAttribute('aria-label', tr('drawer.delete.title'));
  let delTimer = 0;
  del.addEventListener('click', async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!del.classList.contains('is-confirm')) {
      del.classList.add('is-confirm');
      del.textContent = tr('drawer.delete.shortConfirm');
      clearTimeout(delTimer);
      delTimer = setTimeout(() => {
        del.classList.remove('is-confirm');
        del.textContent = '×';
      }, 4000);
      return;
    }
    clearTimeout(delTimer);
    del.disabled = true;
    await deleteSession(sessions.get(s.id) || s);
  });
  const actions = el('span', 'ri-actions');
  actions.append(stop, edit, del);
  meta.append(stBadge, time, actions);
  const foot = el('span', 'ri-foot');
  const countsEl = el('span', 'ri-counts');
  const telem = el('span', 'ri-telem');
  const ctxPct = el('span', 'ri-ctx-pct');
  telem.append(ctxPct, ram, spark);
  foot.append(countsEl, telem);
  const ctx = el('span', 'ri-ctx'), ctxB = el('b'); ctx.append(ctxB);
  b.append(av, main, meta, doing, foot, ctx);
  const subList = el('ul', 'ri-subs sub-list'); subList.hidden = true;
  li.append(b, subList);
  const c = el('button', 'chip'); c.type = 'button'; c.dataset.sess = s.id;
  const cd = el('i'), cn = el('span'), cs = el('small');
  c.append(cd, cn, cs);
  return { li, b, av, avTxt, top, subline, name, stBadge, doing, subPill, foot, countsEl, ctxPct, ctx, ctxB, nameKey: '', dIco, dIcoName: '', dTxt, time, ram, spark, stop, edit, del, subList, subSig: '', c, cd, cn, cs };
}
function subRow(s, x) {
  const li = el('li');
  const b = el('button', 'ri-sub'); b.type = 'button'; b.dataset.sess = s.id; b.dataset.agent = x.id;
  b.append(icon('sparkle'), el('b', null, `${x.type}${x.desc ? ' · ' + x.desc : ''}`), el('span', null, x.last ? cap(verb(x.last)) : tr('activity.starting')));
  li.append(b);
  return li;
}
export function renderRail() {
  syncRailToolbar();
  const byFolder = uiCfg.groupByFolder !== false;
  const expandIdle = uiCfg.railExpandIdle !== false;
  const all = [...sessions.values()].sort(order);
  const q = query.trim().toLowerCase();
  const rail = $('rail-list'), chips = $('chips');
  const ram = new Map((macSnap?.claude || []).map((c) => [c.pid, c.mem]));
  const count = { wait: 0, work: 0, rest: 0, home: 0 };
  const folderMap = new Map();
  for (const [id, r] of railRows) if (!sessions.has(id)) { r.li.remove(); r.c.remove(); railRows.delete(id); }
  for (const s of all) {
    const stKey = uiStatusOf(s);
    count[stKey] = (count[stKey] || 0) + 1;
    const pInfo = projInfoOf(s);
    let fBucket = folderMap.get(pInfo.key);
    if (!fBucket) {
      fBucket = { info: pInfo, items: [], wait: 0, work: 0, rest: 0, home: 0, visibleCount: 0, lastAt: 0 };
      folderMap.set(pInfo.key, fBucket);
    }
    fBucket.items.push(s);
    fBucket[stKey] = (fBucket[stKey] || 0) + 1;
    fBucket.lastAt = Math.max(fBucket.lastAt, s.lastAt || 0, s.taskStart || 0);

    let r = railRows.get(s.id);
    if (!r) { r = railRow(s); railRows.set(s.id, r); }
    const color = colorOf(s), cur = String(s.id === state.selectedId);
    r.b.dataset.status = stKey; r.b.dataset.done = unseenDone.has(s.id) ? '1' : ''; r.b.setAttribute('aria-current', cur);
    r.b.style.setProperty('--c', color);
    r.av.style.setProperty('--c', color);
    if (r.stBadge) {
      r.stBadge.dataset.status = stKey;
      const stTxt = STATUS_LABEL[stKey] || '';
      if (r.stBadge.textContent !== stTxt) r.stBadge.textContent = stTxt;
    }
    { const k = agentOf(s); if (r.avTxt.firstChild?.dataset?.agent !== k) { r.avTxt.replaceChildren(agentMark(k)); r.av.title = AGENT_NAME[k]; } }
    const nk = dn(s) + '|' + (s.dir || '') + '|' + (s.origin || '') + (s.link ? '|rc' : '');
    if (r.nameKey !== nk) {
      r.nameKey = nk;
      r.name.textContent = dn(s);
      r.top.querySelector('.ri-rc')?.remove();
      r.subline.replaceChildren();
      const pj = el('span', 'ri-proj', `📁 ${pInfo.name}`);
      pj.title = s.origin ? tr('activity.runsIn', { dir: pInfo.path, origin: s.origin }) : pInfo.path;
      r.subline.append(pj);
      if (s.origin) {
        const orig = el('span', 'ri-origin', s.origin);
        r.subline.append(orig);
      }
      if (s.link) { const rc = el('span', 'ri-rc'); rc.title = tr('activity.remoteOn'); rc.append(icon('phone')); r.top.append(rc); }
    }
    r.b.title = `${dn(s)}${s.title ? ` (${s.name})` : ''} · ${pInfo.path}`;
    const d = doingOf(s);
    if (r.dIcoName !== d.ic) { r.dIcoName = d.ic; r.dIco.replaceChildren(icon(d.ic)); }
    if (r.dTxt.textContent !== d.text) r.dTxt.textContent = d.text;
    r.time.textContent = metaTime(s);
    const mem = ram.get(s.pid); r.ram.textContent = mem ? fmtBytes(mem) : ''; r.ram.title = mem ? tr('activity.ramTitle') : '';
    setSpark(r.spark, sparkOf(s.id));
    const u = s.usage, f = u && u.ctxMax ? Math.min(1, u.ctx / u.ctxMax) : 0;
    const pctNum = u && u.ctxMax ? Math.round(f * 100) : 0;
    r.ctx.hidden = !u; r.ctxB.style.width = `${pctNum}%`; r.ctxB.className = f > 0.85 ? 'hi' : f > 0.6 ? 'mid' : '';
    r.ctx.title = u ? tr('activity.ctxTitle', { used: fmtTok(u.ctx), max: fmtTok(u.ctxMax), cost: fmtUsd(u.cost) }) : '';
    if (r.ctxPct) {
      r.ctxPct.hidden = !u;
      r.ctxPct.textContent = u ? `CTX ${pctNum}%` : '';
      r.ctxPct.className = 'ri-ctx-pct' + (f > 0.85 ? ' hi' : f > 0.6 ? ' mid' : '');
    }
    if (r.countsEl) {
      const rd = s.counts?.read || 0, ed = s.counts?.edit || 0, cm = s.counts?.cmd || 0;
      const parts = [];
      if (rd) parts.push(`📄 ${rd}`);
      if (ed) parts.push(`✏️ ${ed}`);
      if (cm) parts.push(`⚡ ${cm}`);
      r.countsEl.textContent = parts.join(' · ');
    }
    const isBusy = s.status === 'work' || s.status === 'wait' || Boolean(s.busy) || (Array.isArray(s.subs) && s.subs.length > 0);
    if (r.stop) r.stop.hidden = !(canSessionPerm('stop', s) && isBusy);
    if (r.edit) r.edit.hidden = !canSessionPerm('edit', s);
    if (r.del) r.del.hidden = !canSessionPerm('delete', s);
    const subsNow = s.subs || [];
    if (r.subPill) {
      r.subPill.hidden = !subsNow.length;
      if (subsNow.length) r.subPill.textContent = `🤖 ${subsNow.length}`;
    }
    const sig = subsNow.map((x) => `${x.id}:${x.last?.label || ''}:${x.desc}`).join('|');
    if (sig !== r.subSig) { r.subSig = sig; r.subList.replaceChildren(...subsNow.map((x) => subRow(s, x))); }
    r.subList.hidden = !subsNow.length;
    const match = !q || s.name.toLowerCase().includes(q) || String(s.title || '').toLowerCase().includes(q) || String(s.dir || '').toLowerCase().includes(q) || pInfo.name.toLowerCase().includes(q);
    const statusOk = !railFilter || stKey === railFilter;
    let folded = false;
    if (!q) {
      if (byFolder) {
        folded = foldedFolders.has(pInfo.key);
      } else if (!expandIdle) {
        folded = (stKey === 'rest' && restCollapsed && railFilter !== 'rest') || (stKey === 'home' && homeCollapsed && railFilter !== 'home');
      }
    }
    if (match && statusOk) fBucket.visibleCount++;
    r.li.hidden = !match || !statusOk || folded;
    r.c.dataset.status = stKey; r.c.setAttribute('aria-current', cur); r.cd.style.background = color;
    if (r.cn.textContent !== dn(s)) r.cn.textContent = dn(s);
    r.cs.textContent = STATUS_LABEL[stKey];
  }
  const sortedFolders = [...folderMap.values()].sort((a, b) => {
    if ((b.wait > 0) !== (a.wait > 0)) return b.wait - a.wait;
    if ((b.work > 0) !== (a.work > 0)) return b.work - a.work;
    if (b.lastAt !== a.lastAt) return b.lastAt - a.lastAt;
    return a.info.name.localeCompare(b.info.name);
  });
  for (const [k, fg] of folderEls) {
    if (!folderMap.has(k)) { fg.li.remove(); folderEls.delete(k); }
  }
  for (const fb of sortedFolders) {
    let fg = folderEls.get(fb.info.key);
    if (!fg) { fg = folderGroupEl(fb.info); folderEls.set(fb.info.key, fg); }
    fg.title.textContent = fb.info.name;
    fg.sub.textContent = fb.info.shortPath;
    fg.b.title = fb.info.path;
    fg.n.textContent = String(fb.visibleCount || fb.items.length);
    const bSig = `${fb.wait}:${fb.work}`;
    if (fg.b.dataset.bsig !== bSig) {
      fg.b.dataset.bsig = bSig;
      fg.badges.replaceChildren();
      if (fb.wait > 0) {
        const p = el('span', 'grp-pill grp-pill--wait', `${fb.wait}`);
        p.prepend(el('i'));
        fg.badges.append(p);
      }
      if (fb.work > 0) {
        const p = el('span', 'grp-pill grp-pill--work', `${fb.work}`);
        p.prepend(el('i'));
        fg.badges.append(p);
      }
    }
    const isOpen = !foldedFolders.has(fb.info.key) || !!q;
    fg.b.setAttribute('aria-expanded', String(isOpen));
    fg.li.hidden = !byFolder || fb.visibleCount === 0;
  }
  for (const [k] of GROUPS) {
    const g = grpEls[k];
    g.n.textContent = count[k] || 0;
    g.li.hidden = byFolder || !count[k] || (railFilter && railFilter !== k);
  }
  grpEls.rest.b.setAttribute('aria-expanded', String(expandIdle || !restCollapsed || !!q || railFilter === 'rest'));
  if (grpEls.home) grpEls.home.b.setAttribute('aria-expanded', String(expandIdle || !homeCollapsed || !!q || railFilter === 'home'));
  for (const k of ['work', 'wait', 'rest', 'home']) { const elSt = $('st-' + k); if (elSt) elSt.textContent = count[k] || 0; }
  const fabCount = $('rail-fab-count'), fabBtn = $('rail-expand-fab');
  if (fabCount) fabCount.textContent = String((count.work || 0) + (count.wait || 0) + (count.rest || 0) || all.length);
  if (fabBtn) {
    fabBtn.dataset.work = String(count.work || 0);
    fabBtn.dataset.wait = String(count.wait || 0);
  }
  document.querySelector('.st[data-st="wait"]').classList.toggle('has', !!count.wait);
  const ord = `${byFolder ? 'F' : 'S'}|${sortedFolders.map((fb) => `${fb.info.key}:${fb.items.map((s) => s.id + uiStatusOf(s)).join(',')}`).join(';')}`;
  if (ord !== railOrder) {
    railOrder = ord;
    if (byFolder) {
      for (const [k] of GROUPS) grpEls[k].li.remove();
      for (const fb of sortedFolders) {
        const fg = folderEls.get(fb.info.key);
        if (fg) rail.append(fg.li);
        for (const s of fb.items) rail.append(railRows.get(s.id).li);
      }
    } else {
      for (const fg of folderEls.values()) fg.li.remove();
      for (const [k] of GROUPS) {
        rail.append(grpEls[k].li);
        for (const s of all) if (uiStatusOf(s) === k) rail.append(railRows.get(s.id).li);
      }
    }
    for (const s of all) chips.append(railRows.get(s.id).c);
  }
  $('empty').hidden = all.length > 0 || !state.connectedOnce;
  for (const w of workers.values()) w.tagEl.classList.toggle('tag--on', w.id === state.selectedId);
}
function onListClick(ev) {
  if (ev.target.closest('.ri-stop') || ev.target.closest('.ri-del') || ev.target.closest('.ri-edit') || ev.target.closest('.ri-rename-form')) return;
  const g = ev.target.closest('.grp-btn');
  if (g) {
    if (g.dataset.folder) {
      const fk = g.dataset.folder;
      if (foldedFolders.has(fk)) foldedFolders.delete(fk);
      else foldedFolders.add(fk);
      saveFoldedFolders();
      renderRail();
      return;
    }
    if (g.dataset.g === 'rest') {
      uiCfg.railExpandIdle = false;
      restCollapsed = !restCollapsed;
      try { localStorage.setItem('office-rest-folded', restCollapsed ? '1' : '0'); } catch { /* storage blocked */ }
      renderRail();
    } else if (g.dataset.g === 'home') {
      uiCfg.railExpandIdle = false;
      homeCollapsed = !homeCollapsed;
      try { localStorage.setItem('office-home-folded', homeCollapsed ? '1' : '0'); } catch { /* storage blocked */ }
      renderRail();
    }
    return;
  }
  const b = ev.target.closest('[data-sess]'); if (!b) return; if (b.dataset.agent) openFromRow(b); else toggleSession(b.dataset.sess);
}
export const fmtTok = (n) => (n >= 1e6 ? `${num(n / 1e6, 1)}M` : `${Math.round(n / 1000)}k`);
export const fmtUsd = (v) => `$${v >= 100 ? Math.round(v) : v.toFixed(2)}`;
let lastKpiSig = '';
export function renderKpi() {
  const list = [...sessions.values()];
  const runningSubs = list.reduce((a, s) => a + (s.subs?.length || 0), 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStartMs = startOfToday.getTime();
  const sessSubsToday = list.reduce((a, s) => {
    if (typeof s.usage?.subsToday === 'number' && s.usage.subsToday > 0) return a + s.usage.subsToday;
    const active = s.subs?.length || 0;
    const doneToday = (s.doneSubs || []).filter((d) => (d.endedAt || d.startedAt || 0) >= todayStartMs).length;
    return a + active + doneToday;
  }, 0);
  const subCount = Math.max(runningSubs, state.stats.subs || 0, sessSubsToday);

  const statsTools = (state.stats.read || 0) + (state.stats.edit || 0) + (state.stats.cmd || 0) + (state.stats.web || 0);
  const sessToolsToday = list.reduce((a, s) => a + (s.usage?.toolsToday || 0), 0);
  const toolsCount = Math.max(statsTools, sessToolsToday);

  const sessStepsToday = list.reduce((a, s) => a + (s.usage?.stepsToday || 0), 0);
  const stepsCount = Math.max(state.stats.steps || 0, sessStepsToday, state.feed.length);

  const hasTodayCost = (typeof state.stats.cost === 'number' && state.stats.cost > 0)
    || list.some((s) => typeof s.usage?.costToday === 'number');
  const rawCost = hasTodayCost
    ? Math.max(
      state.stats.cost || 0,
      list.reduce((a, s) => a + (typeof s.usage?.costToday === 'number' ? s.usage.costToday : 0), 0),
    )
    : list.filter((s) => !isAtHome(s)).reduce((a, s) => a + (s.usage?.cost || 0), 0);
  const costStr = fmtUsd(rawCost);

  const kpiSig = `${stepsCount}|${toolsCount}|${subCount}:${runningSubs}|${costStr}`;
  if (kpiSig === lastKpiSig) return;
  lastKpiSig = kpiSig;
  const host = $('feed-stats') || $('kpi');
  if (!host) return;
  const cards = [
    { key: 'steps', ic: 'sparkle', val: num(stepsCount) },
    { key: 'tools', ic: 'terminal', val: num(toolsCount) },
    { key: 'subs', ic: 'users', val: num(subCount), live: runningSubs > 0 },
    { key: 'cost', ic: 'coin', val: costStr, isCost: true },
  ];
  host.replaceChildren(...cards.map(({ key, ic, val, isCost, live }) => {
    const label = tr(`activity.kpi.${key}`);
    const d = el('div', isCost ? 'kpi kpi--cost' : 'kpi');
    d.dataset.kpi = key;
    if (live) d.classList.add('is-live');
    const main = el('div', 'kpi-main');
    const topRow = el('div', 'kpi-top');
    const b = el('b', 'kpi-val', val);
    if (isCost) b.prepend(el('small', null, '≈'));
    topRow.append(b);
    if (live) {
      const livePill = el('span', 'kpi-live-dot');
      topRow.append(livePill);
    }
    main.append(topRow, el('span', 'kpi-lbl', label));
    const i = el('span', 'kpi-ic');
    i.append(icon(ic));
    d.append(main, i);
    d.title = isCost ? `${label}: ${val} — ${tr('activity.costTitle')}` : `${tr('activity.kpiToday', { label })}: ${val}`;
    return d;
  }));
}
export function renderHud() {
  const list = [...sessions.values()];
  const waiting = list.filter((s) => s.status === 'wait').length;
  const subCount = list.reduce((a, s) => a + (s.subs?.length || 0), 0);
  const folderCount = new Set(list.map((s) => projInfoOf(s).key)).size;
  const actText = list.length
    ? tr('activity.sessions', { n: list.length })
      + (folderCount ? ` · ${tr('activity.projectsCount', { n: folderCount })}` : '')
      + (subCount ? ` · ${tr('activity.subsRunning', { n: subCount })}` : '')
    : tr('activity.noSessions');
  const actEl = $('active-count');
  if (actEl && actEl.textContent !== actText) actEl.textContent = actText;
  renderKpi();
  const bellDot = $('bell-dot');
  if (bellDot && bellDot.hidden !== !waiting) bellDot.hidden = !waiting;
  const yours = waiting + unseenDone.size;
  const wantTitle = yours ? tr('activity.docTitle', { n: yours }) : 'My Office';
  if (document.title !== wantTitle) document.title = wantTitle;
}
const markers = { get length() { return workers.size + subs.size + npcs.length + (state.selectedId ? 1 : 0) + (state.hovered ? 1 : 0); } };
export function updateMarkers(t) {
  if (!markers.length) return;
  const sel = state.selectedId ? workers.get(state.selectedId) : null;
  selRing.visible = !!sel;
  if (sel) { selRing.position.set(sel.pos.x, 0.03 + sel.gy(), sel.pos.y); selRing.scale.setScalar(1 + Math.sin(t * 4) * 0.06); }
  hoverRing.visible = !!state.hovered && state.hovered !== sel && !!state.hovered.root.parent;
  if (hoverRing.visible) { hoverRing.position.set(state.hovered.pos.x, 0.025 + state.hovered.gy(), state.hovered.pos.y); hoverRing.scale.setScalar(state.hovered.sub ? 0.8 : 1); }
  const isNameAllowed = (w) => {
    if (w.isSub || w.sub) return uiCfg.subNames !== false;
    if (w.isDeptAmbient || w.deptStaff || w.staff || (w.id && String(w.id).startsWith('__') && w.id !== '__director' && w.id !== '__co_director')) {
      return uiCfg.staffNames !== false;
    }
    return uiCfg.chibiNames !== false;
  };
  for (const w of workers.values()) {
    const s = sessions.get(w.id);
    const nameAllowed = isNameAllowed(w);
    const show = nameAllowed && w.root.visible;
    if (w.tagObj.visible !== show) w.tagObj.visible = show;
    const wait = s?.status === 'wait';
    if (w.tagEl.classList.contains('tag--wait') !== wait) w.tagEl.classList.toggle('tag--wait', wait);
  }
  for (const w of subs.values()) {
    if (!w?.tagObj) continue;
    const show = isNameAllowed(w) && w.root.visible;
    if (w.tagObj.visible !== show) w.tagObj.visible = show;
  }
  for (const w of npcs) {
    if (!w?.tagObj) continue;
    const show = isNameAllowed(w) && w.root.visible;
    if (w.tagObj.visible !== show) w.tagObj.visible = show;
  }
}

export function setup() {
  /* ---------- UI: activity column, session list, chips ---------- */
  state.stats = {};
  state.feed = [];
  state.selectedId = null;
  state.isLocal = false;
  state.hovered = null; state.hoverAt = 0;
  toastEl = $('toast');
  $('type-chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-k]'); if (!b) return;
    if (typeFilter.has(b.dataset.k)) typeFilter.delete(b.dataset.k); else typeFilter.add(b.dataset.k);
    b.setAttribute('aria-pressed', String(typeFilter.has(b.dataset.k))); renderFeed();
  });
  $('feed-list').addEventListener('click', (ev) => {
    const sum = ev.target.closest('.fg-summary');
    if (sum) {
      ev.preventDefault();
      ev.stopPropagation();
      const fg = sum.closest('.fg');
      const more = fg?.querySelector('.fg-more');
      const toggleEl = sum.querySelector('.fg-sum-toggle');
      if (fg && more) {
        const exp = more.hidden;
        more.hidden = !exp;
        fg.classList.toggle('is-expanded', exp);
        sum.setAttribute('aria-expanded', String(exp));
        if (fg.dataset.grp) {
          if (exp) expandedGroups.add(fg.dataset.grp);
          else expandedGroups.delete(fg.dataset.grp);
        }
        if (toggleEl) {
          const n = Number(toggleEl.dataset.count) || more.children.length;
          toggleEl.textContent = exp ? tr('activity.collapseSteps') : tr('activity.expandSteps', { n });
        }
      }
      return;
    }
    const im = ev.target.closest('[data-img]');
    if (im) { const b = im.closest('[data-sess]'); openImage(im.dataset.img, im.dataset.name, (b && sessions.get(b.dataset.sess)?.name) || ''); return; }
    const b = ev.target.closest('[data-sess]'); if (b) openFromRow(b);
  });
  $('flt-all').addEventListener('click', () => setFilter('all'));
  $('flt-att').addEventListener('click', () => setFilter('att'));
  try { restCollapsed = localStorage.getItem('office-rest-folded') === '1'; } catch { /* storage blocked */ }
  try { homeCollapsed = localStorage.getItem('office-home-folded') === '1'; } catch { /* storage blocked */ }
  try {
    const rawFolded = JSON.parse(localStorage.getItem('office-folded-folders') || '[]');
    if (Array.isArray(rawFolded)) for (const k of rawFolded) if (k) foldedFolders.add(String(k));
  } catch { /* storage blocked */ }
  for (const btn of document.querySelectorAll('[data-rail-group]')) {
    btn.addEventListener('click', () => {
      uiCfg.groupByFolder = btn.dataset.railGroup === 'folder';
      railOrder = '';
      syncToggles();
      renderRail();
    });
  }
  $('rail-fold-all')?.addEventListener('click', () => {
    if (uiCfg.groupByFolder !== false) {
      const allKeys = [...folderEls.keys()];
      if (foldedFolders.size > 0) {
        foldedFolders.clear();
      } else {
        for (const k of allKeys) foldedFolders.add(k);
      }
      saveFoldedFolders();
    } else {
      const anyFolded = (!uiCfg.railExpandIdle) && (restCollapsed || homeCollapsed);
      if (anyFolded) {
        uiCfg.railExpandIdle = true;
        restCollapsed = false;
        homeCollapsed = false;
      } else {
        uiCfg.railExpandIdle = false;
        restCollapsed = true;
        homeCollapsed = true;
      }
      try {
        localStorage.setItem('office-rest-folded', restCollapsed ? '1' : '0');
        localStorage.setItem('office-home-folded', homeCollapsed ? '1' : '0');
      } catch { /* storage blocked */ }
    }
    renderRail();
  });
  const cfgBtn = $('rail-cfg-btn'), cfgPop = $('rail-cfg-pop');
  if (cfgBtn && cfgPop) {
    const toggleCfgPop = (open = cfgPop.hidden) => {
      cfgPop.hidden = !open;
      cfgBtn.setAttribute('aria-expanded', String(open));
      cfgBtn.classList.toggle('is-on', open);
    };
    cfgBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCfgPop();
    });
    cfgPop.addEventListener('click', (e) => {
      e.stopPropagation();
      const tgl = e.target.closest('[data-rail-cfg]');
      if (!tgl) return;
      const k = tgl.dataset.railCfg;
      const next = tgl.getAttribute('aria-checked') !== 'true';
      if (k === 'groupByFolder') {
        uiCfg.groupByFolder = next;
        railOrder = '';
        syncToggles();
      } else if (k === 'showPath') {
        uiCfg.railShowPath = next;
      } else if (k === 'showMetrics') {
        uiCfg.railShowMetrics = next;
      } else if (k === 'expandIdle') {
        uiCfg.railExpandIdle = next;
        if (next) {
          restCollapsed = false;
          homeCollapsed = false;
        }
      }
      renderRail();
    });
    document.addEventListener('click', (e) => {
      if (!cfgPop.hidden && !e.target.closest('#rail-cfg-pop, #rail-cfg-btn')) toggleCfgPop(false);
    });
  }
  syncRailToolbar();
  const appEl = $('app');
  const setRailCollapsed = (collapsed) => {
    if (!appEl) return;
    appEl.classList.toggle('rail-collapsed', collapsed);
    $('rail-toggle')?.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('office-rail-collapsed', collapsed ? '1' : '0'); } catch { /* storage blocked */ }
    resize();
    setTimeout(() => { resize(); window.dispatchEvent(new Event('resize')); }, 260);
  };
  try {
    if (localStorage.getItem('office-rail-collapsed') === '1') {
      appEl?.classList.add('rail-collapsed');
      $('rail-toggle')?.setAttribute('aria-expanded', 'false');
    }
  } catch { /* storage blocked */ }
  $('rail-toggle')?.addEventListener('click', () => setRailCollapsed(!appEl?.classList.contains('rail-collapsed')));
  $('rail-expand-fab')?.addEventListener('click', () => setRailCollapsed(false));
  const setFeedCollapsed = (collapsed) => {
    if (!appEl) return;
    appEl.classList.toggle('feed-collapsed', collapsed);
    $('feed-collapse-btn')?.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('office-feed-collapsed', collapsed ? '1' : '0'); } catch { /* storage blocked */ }
    resize();
    setTimeout(() => { resize(); window.dispatchEvent(new Event('resize')); }, 260);
  };
  try {
    if (localStorage.getItem('office-feed-collapsed') === '1') {
      appEl?.classList.add('feed-collapsed');
      $('feed-collapse-btn')?.setAttribute('aria-expanded', 'false');
    }
  } catch { /* storage blocked */ }
  $('feed-collapse-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setFeedCollapsed(!appEl?.classList.contains('feed-collapsed'));
  });
  $('feed-expand-fab')?.addEventListener('click', () => setFeedCollapsed(false));
  grpEls = Object.fromEntries(GROUPS.map(([k]) => {
    const li = el('li', 'grp'); li.dataset.g = k;
    const b = el('button', 'grp-btn'); b.type = 'button'; b.dataset.g = k;
    const n = el('b'); b.append(el('span', null, tr(`activity.group.${k}`)), n);
    if (k === 'rest' || k === 'home') { const ch = el('span', 'grp-chev'); ch.append(icon('chevron')); b.append(ch); } else b.disabled = true;
    li.append(b); return [k, { li, b, n }];
  }));
  $('rail-list').addEventListener('click', onListClick);
  $('chips').addEventListener('click', onListClick);
  $('sess-search').addEventListener('input', (e) => { query = e.target.value; renderRail(); });
  document.querySelector('.st-row').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-st]'); if (!b) return;
    railFilter = railFilter === b.dataset.st ? null : b.dataset.st;
    for (const x of document.querySelectorAll('.st')) x.setAttribute('aria-pressed', String(x.dataset.st === railFilter));
    renderRail();
  });
  awayHooks.change = () => queueUi();
  // running timers tick every second without re-rendering the list
  let tick = 0;
  setInterval(() => {
    tick = (tick + 1) % 5;
    let statusChanged = false;
    for (const [id, r] of railRows) {
      const s = sessions.get(id);
      if (!s) continue;
      if (s.status !== 'rest' || tick === 0) r.time.textContent = metaTime(s);
      if (tick === 0) {
        if (r.b.dataset.status !== uiStatusOf(s)) statusChanged = true;
        else if (s.status === 'rest') {
          const d = doingOf(s);
          if (r.dIcoName !== d.ic) { r.dIcoName = d.ic; r.dIco.replaceChildren(icon(d.ic)); }
          if (r.dTxt.textContent !== d.text) r.dTxt.textContent = d.text;
        }
      }
    }
    if (statusChanged) renderRail();
  }, 1000);
}
