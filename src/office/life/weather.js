// Real weather outside (Open-Meteo).
import * as THREE from 'three';
import { state } from '../core/state.js';
import { $, hhmm, rand, reduceMotion, officeNow } from '../core/env.js';
import { scene } from '../scene/renderer.js';
import { hemi, sun } from '../scene/lights.js';
import { quality, onQualityChange } from '../scene/quality.js';
import { LAY } from '../world/layout.js';
import { rainKit } from './rain.js';
import { night } from '../world/room-update.js';
import { sfx } from '../audio/sfx.js';
import { t as tr } from '../../i18n/index.js';

/* ---------- real weather outside: Open-Meteo (free, no key). Off until you pick a city, cached 30 minutes.
   Rain falls around the office (never inside the room), clouds dim the sun, storms flash, fog closes in.
   Idea from cubicle-crew (MIT, weather.js). ---------- */
// City names are proper nouns and stay as written, except Ho Chi Minh City, whose "TP." (city) prefix is translated.
const WX_CITIES = { hn: ['Hà Nội', 21.03, 105.85], hcm: [null, 10.78, 106.7], dn: ['Đà Nẵng', 16.05, 108.2], hue: ['Huế', 16.46, 107.59],
  hp: ['Hải Phòng', 20.86, 106.68], ct: ['Cần Thơ', 10.03, 105.78], dl: ['Đà Lạt', 11.94, 108.44], nt: ['Nha Trang', 12.24, 109.19] };
const WX_CACHE_KEY = 'office-wx-cache-v1';
const WX_TTL_MS = 30 * 60_000;
const wxCache = new Map();
try {
  const raw = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || '{}');
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) if (v && typeof v === 'object') wxCache.set(k, v);
  }
} catch { /* storage blocked */ }
function saveWxCache() {
  try { localStorage.setItem(WX_CACHE_KEY, JSON.stringify(Object.fromEntries(wxCache))); } catch { /* ignore */ }
}

const cityName = (k) => WX_CITIES[k][0] ?? tr('life.weather.' + k);
const WX_TEXT = (c) => tr('life.weather.' + (c === 0 ? 'clear' : c <= 2 ? 'partly' : c === 3 ? 'cloudy' : c <= 48 ? 'fog' : c <= 57 ? 'drizzle' : c <= 67 ? 'rain' : c <= 77 ? 'snow' : c <= 82 ? 'showers' : 'storm'));
const WX_ICON = (c) => (c === 0 ? (night ? '🌙' : '☀️') : c <= 2 ? (night ? '☁️' : '🌤') : c === 3 ? '☁️' : c <= 48 ? '🌫' : c <= 67 ? '🌧' : c <= 77 ? '❄️' : c <= 82 ? '🌦' : '⛈');
export const wx = { city: '', code: null, temp: null, cloud: 0, rain: 0, storm: false, fog: false, wind: 8, humidity: 75, isDay: 1, at: 0, flashAt: 0, flash: 0 };
export const wxChip = () => (wx.city && wx.code != null ? ` · ${WX_ICON(wx.code)} ${Math.round(wx.temp)}°` : '');

let wxDebounce = null;
let wxAbort = null;

function applyWxEntry(entry) {
  if (!entry) return;
  Object.assign(wx, {
    code: entry.code,
    temp: entry.temp,
    cloud: entry.cloud ?? 0,
    rain: entry.rain ?? 0,
    storm: !!entry.storm,
    fog: !!entry.fog,
    wind: entry.wind ?? 8,
    humidity: entry.humidity ?? 75,
    isDay: entry.isDay ?? 1,
    at: entry.at || Date.now(),
  });
  applyWeather();
}

function parseCur(cur) {
  const code = cur.weather_code ?? 0;
  return {
    code,
    temp: cur.temperature_2m ?? 26,
    cloud: (cur.cloud_cover ?? 0) / 100,
    storm: code >= 95,
    fog: code === 45 || code === 48,
    rain: code >= 95 ? 1 : (code >= 80 && code <= 82) ? 0.55 + (code - 80) * 0.2 : (code >= 61 && code <= 67) ? 0.35 + (code - 61) * 0.12 : (code >= 51 && code <= 57) ? 0.18 : 0,
    wind: cur.wind_speed_10m ?? 8,
    humidity: cur.relative_humidity_2m ?? 75,
    isDay: cur.is_day ?? 1,
    at: Date.now(),
  };
}

async function fetchWeather(targetCity = wx.city, force = false) {
  const c = WX_CITIES[targetCity];
  if (!c) return;
  const cached = wxCache.get(targetCity);
  if (!force && cached && Date.now() - (cached.at || 0) < WX_TTL_MS) {
    if (wx.city === targetCity) applyWxEntry(cached);
    return;
  }
  if (cached && wx.city === targetCity && wx.code == null) applyWxEntry(cached);
  if (wxAbort) wxAbort.abort();
  const ctrl = new AbortController();
  wxAbort = ctrl;
  try {
    let cur = null;
    try {
      const rApi = await fetch(`/api/weather?city=${encodeURIComponent(targetCity)}`, { signal: ctrl.signal, cache: 'no-store' });
      if (rApi.ok) {
        const jApi = await rApi.json();
        cur = jApi?.current || null;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
    if (!cur) {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c[1]}&longitude=${c[2]}&current=temperature_2m,relative_humidity_2m,is_day,weather_code,precipitation,cloud_cover,wind_speed_10m&timezone=auto`, { signal: ctrl.signal });
      const j = await r.json();
      cur = j?.current || null;
    }
    if (!cur) return;
    const entry = parseCur(cur);
    wxCache.set(targetCity, entry);
    saveWxCache();
    if (wx.city === targetCity) applyWxEntry(entry);
  } catch (e) {
    if (e?.name === 'AbortError') return;
    if (!wxCache.has(targetCity)) $('wx-now').textContent = tr('life.weather.failed');
  }
}

function requestWeather(city, force = false) {
  clearTimeout(wxDebounce);
  if (wxAbort) { wxAbort.abort(); wxAbort = null; }
  if (!city || !WX_CITIES[city]) {
    wx.city = '';
    wx.code = null;
    applyWeather();
    return;
  }
  const cached = wxCache.get(city);
  if (!force && cached && Date.now() - (cached.at || 0) < WX_TTL_MS) {
    applyWxEntry(cached);
    return;
  }
  if (cached) applyWxEntry(cached);
  else $('wx-now').textContent = tr('life.weather.loading');
  wxDebounce = setTimeout(() => fetchWeather(city, force), 300);
}

let rain = null;
const RING_SEGS = 8;
const MAX_RIPPLES = 60;
function outdoorPoint(range = 42) {
  let x, z;
  do {
    x = rand(-range, range);
    z = rand(-range, range);
  } while (x > LAY.box.x0 - 0.6 && x < LAY.box.x1 + 0.6 && z > LAY.box.z0 - 0.6 && z < LAY.box.z1 + 0.6);
  return [x, z];
}
function rainLines() {
  const N = 3600, pos = new Float32Array(N * 6), seed = new Float32Array(N * 3);
  const spot = (i) => {
    const [x, z] = outdoorPoint(42);
    seed[i * 3] = x; seed[i * 3 + 1] = rand(0, 26); seed[i * 3 + 2] = z;
  };
  for (let i = 0; i < N; i++) spot(i);
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat1 = new THREE.LineBasicMaterial({ color: '#CFE4FA', transparent: true, opacity: 0.5, depthWrite: false });
  const lines = new THREE.LineSegments(geo, mat1);
  lines.frustumCulled = false; lines.userData.dynamic = true; lines.userData.noCollide = true; scene.add(lines);

  // Secondary fine mist / streetlamp-lit rain layer for High quality
  const N2 = 1200, pos2 = new Float32Array(N2 * 6), seed2 = new Float32Array(N2 * 3);
  const spot2 = (i) => {
    const [x, z] = outdoorPoint(34);
    seed2[i * 3] = x; seed2[i * 3 + 1] = rand(0, 22); seed2[i * 3 + 2] = z;
  };
  for (let i = 0; i < N2; i++) spot2(i);
  const geo2 = new THREE.BufferGeometry(); geo2.setAttribute('position', new THREE.BufferAttribute(pos2, 3));
  const mat2 = new THREE.LineBasicMaterial({ color: '#FFD18C', transparent: true, opacity: 0.32, depthWrite: false });
  const mistLines = new THREE.LineSegments(geo2, mat2);
  mistLines.frustumCulled = false; mistLines.userData.dynamic = true; mistLines.userData.noCollide = true; scene.add(mistLines);

  // Ground splash ripples (1 draw call for up to 60 octagonal rings)
  const rPos = new Float32Array(MAX_RIPPLES * RING_SEGS * 2 * 3);
  const rSeed = new Float32Array(MAX_RIPPLES * 3); // x, z, phase (0..1)
  const spotRipple = (i) => {
    const [x, z] = outdoorPoint(26);
    rSeed[i * 3] = x; rSeed[i * 3 + 1] = z; rSeed[i * 3 + 2] = rand(0, 1);
  };
  for (let i = 0; i < MAX_RIPPLES; i++) spotRipple(i);
  const rGeo = new THREE.BufferGeometry(); rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
  const rMat = new THREE.LineBasicMaterial({ color: '#D8ECFF', transparent: true, opacity: 0.45, depthWrite: false });
  const ripples = new THREE.LineSegments(rGeo, rMat);
  ripples.frustumCulled = false; ripples.userData.dynamic = true; ripples.userData.noCollide = true; scene.add(ripples);

  return { lines, geo, pos, seed, N, spot, mat1, mistLines, geo2, pos2, seed2, N2, spot2, mat2, ripples, rGeo, rPos, rSeed, rMat, spotRipple, count: 0, count2: 0, rCount: 0 };
}

export function applyWeather() {
  const on = !!WX_CITIES[wx.city] && wx.code != null;
  for (const b of document.querySelectorAll('[data-wx]')) b.setAttribute('aria-pressed', String(b.dataset.wx === (wx.city || '')));
  if (wx.city && wx.code != null) {
    const extra = [];
    if (wx.humidity != null) extra.push(tr('life.weather.humidity', { pct: Math.round(wx.humidity) }));
    if (wx.wind != null) extra.push(tr('life.weather.wind', { kmh: Math.round(wx.wind) }));
    $('wx-now').textContent = `${cityName(wx.city)} · ${Math.round(wx.temp)}° · ${WX_TEXT(wx.code)}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
  } else if (!wx.city) {
    $('wx-now').textContent = tr('life.weather.off');
  }
  const dim = on ? Math.min(0.55, wx.cloud * 0.35 + wx.rain * 0.3) : 0;
  sun.intensity = (night ? 0.55 : 1.35) * (1 - dim);
  // (the base: core/loop.js adds how far the camera has backed off at a low angle)
  const fogBase = [on && wx.fog ? 14 : on && wx.rain ? 30 : 40, on && wx.fog ? 52 : on && wx.rain ? 78 : 96], extra = scene.fog.extra || 0;
  scene.fog.base = fogBase; scene.fog.near = fogBase[0] + extra; scene.fog.far = fogBase[1] + extra;
  const lvl = quality?.level || 'high';
  if (on && wx.rain > 0) {
    rain ||= rainLines();
    const maxDrops = lvl === 'low' ? 600 : lvl === 'medium' ? 1800 : 3600;
    rain.count = Math.max(80, Math.round(maxDrops * wx.rain));
    rain.lines.visible = true;
    rain.mat1.color.set(night ? '#7EB0F5' : '#CFE4FA');
    rain.mat1.opacity = night ? (lvl === 'high' ? 0.64 : 0.58) : (lvl === 'high' ? 0.52 : 0.45);

    if (lvl === 'high') {
      rain.count2 = Math.max(40, Math.round(rain.N2 * wx.rain));
      rain.mistLines.visible = true;
      rain.mat2.color.set(night ? '#FFD18C' : '#E2F0FF');
      rain.mat2.opacity = night ? 0.36 : 0.28;
    } else {
      rain.count2 = 0;
      rain.mistLines.visible = false;
    }

    if (lvl === 'low') {
      rain.rCount = 0;
      rain.ripples.visible = false;
    } else {
      const maxR = lvl === 'medium' ? 24 : MAX_RIPPLES;
      rain.rCount = Math.max(6, Math.round(maxR * wx.rain));
      rain.ripples.visible = true;
      rain.rMat.color.set(night ? '#8AB8FF' : '#D8ECFF');
      rain.rMat.opacity = night ? 0.58 : 0.42;
    }
  } else if (rain) {
    rain.lines.visible = false;
    rain.mistLines.visible = false;
    rain.ripples.visible = false;
  }
  rainKit.visible = on && wx.rain > 0;
  $('clock').textContent = hhmm(officeNow().getTime()) + wxChip();
}

export function updateWeather(dt) {
  const lvl = quality?.level || 'high';
  const windX = Math.min(0.28, (wx.wind || 8) * 0.008) + (lvl === 'high' ? Math.sin(state.sim * 1.8) * 0.03 : 0);
  const windZ = 0.02 + Math.min(0.12, (wx.wind || 8) * 0.003);
  if (rain?.lines.visible) {
    const { pos, seed, count } = rain, fall = (15.5 + (wx.wind || 8) * 0.12) * dt, len = lvl === 'high' ? 0.62 : 0.55;
    for (let i = 0; i < count; i++) {
      let y = seed[i * 3 + 1] - fall;
      if (y < -0.3) { rain.spot(i); y = 26; }
      seed[i * 3 + 1] = y;
      const x = seed[i * 3], z = seed[i * 3 + 2], k = i * 6;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
      pos[k + 3] = x + windX; pos[k + 4] = y + len; pos[k + 5] = z + windZ;
    }
    rain.geo.setDrawRange(0, count * 2);
    rain.geo.attributes.position.needsUpdate = true;
  }
  if (rain?.mistLines.visible && rain.count2 > 0) {
    const { pos2, seed2, count2 } = rain, fall2 = 12.5 * dt, len2 = 0.38;
    for (let i = 0; i < count2; i++) {
      let y = seed2[i * 3 + 1] - fall2;
      if (y < -0.2) { rain.spot2(i); y = 22; }
      seed2[i * 3 + 1] = y;
      const x = seed2[i * 3], z = seed2[i * 3 + 2], k = i * 6;
      pos2[k] = x; pos2[k + 1] = y; pos2[k + 2] = z;
      pos2[k + 3] = x + windX * 1.25; pos2[k + 4] = y + len2; pos2[k + 5] = z + windZ * 1.25;
    }
    rain.geo2.setDrawRange(0, count2 * 2);
    rain.geo2.attributes.position.needsUpdate = true;
  }
  if (rain?.ripples.visible && rain.rCount > 0) {
    const { rPos, rSeed, rCount } = rain;
    for (let i = 0; i < rCount; i++) {
      let ph = rSeed[i * 3 + 2] + dt * (1.7 + (i % 5) * 0.22);
      if (ph >= 1) { rain.spotRipple(i); ph = 0; }
      rSeed[i * 3 + 2] = ph;
      const cx = rSeed[i * 3], cz = rSeed[i * 3 + 1];
      const rad = ph < 0.85 ? 0.03 + ph * 0.28 : 0.268 * (1 - (ph - 0.85) / 0.15);
      const base = i * RING_SEGS * 6;
      for (let s = 0; s < RING_SEGS; s++) {
        const a0 = (s / RING_SEGS) * Math.PI * 2, a1 = ((s + 1) / RING_SEGS) * Math.PI * 2;
        const idx = base + s * 6;
        rPos[idx] = cx + Math.cos(a0) * rad;
        rPos[idx + 1] = 0.018;
        rPos[idx + 2] = cz + Math.sin(a0) * rad;
        rPos[idx + 3] = cx + Math.cos(a1) * rad;
        rPos[idx + 4] = 0.018;
        rPos[idx + 5] = cz + Math.sin(a1) * rad;
      }
    }
    rain.rGeo.setDrawRange(0, rCount * RING_SEGS * 2);
    rain.rGeo.attributes.position.needsUpdate = true;
  }
  if (wx.storm && WX_CITIES[wx.city] && !reduceMotion) {   // a flash now and then, the thunder a moment later
    if (!wx.flashAt) wx.flashAt = state.sim + rand(6, 20);
    if (state.sim > wx.flashAt) { wx.flash = lvl === 'high' ? 0.48 : 0.35; wx.flashAt = state.sim + rand(8, 25); setTimeout(() => sfx.play('thunder'), rand(400, 1600)); }
  }
  if (wx.flash > 0) {
    wx.flash -= dt;
    const pulse = wx.flash > 0.36 || (wx.flash > 0.22 && wx.flash < 0.29) || (wx.flash > 0.08 && wx.flash < 0.14);
    hemi.intensity = (night ? 0.18 : 0.25) + (pulse ? (lvl === 'high' ? 3.8 : 3.0) : 0);
    if (wx.flash <= 0) hemi.intensity = night ? 0.18 : 0.25;
  }
}

export function setup() {
  try { wx.city = localStorage.getItem('office-wx') || ''; } catch { /* storage blocked */ }
  for (const b of document.querySelectorAll('[data-wx]')) b.setAttribute('aria-pressed', String(b.dataset.wx === wx.city));
  onQualityChange(() => applyWeather());
  // Settings → Real weather: one chip per city, "Off" first
  $('wx-cities').addEventListener('click', (e) => {
    const b = e.target.closest('[data-wx]'); if (!b) return;
    const nextCity = b.dataset.wx || '';
    if (nextCity === wx.city && wx.code != null) return;
    wx.city = nextCity;
    wx.code = null;
    for (const x of document.querySelectorAll('[data-wx]')) x.setAttribute('aria-pressed', String(x === b));
    try { localStorage.setItem('office-wx', wx.city); } catch { /* storage blocked */ }
    requestWeather(wx.city, false);
  });
  if (wx.city) requestWeather(wx.city, false);
  setInterval(() => { if (wx.city && !document.hidden) fetchWeather(wx.city, true); }, WX_TTL_MS);
}
