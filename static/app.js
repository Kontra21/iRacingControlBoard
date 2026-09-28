'use strict';

/* =====================================================================================
 * Race Control Board — client
 * ===================================================================================*/

// ---------- tiny DOM helpers ---------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = encodeURIComponent;

// ---------- persistent per-device prefs ---------------------------------------------
function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Browser';
}
const PREF_DEFAULTS = { device: guessDevice(), pin: '', fit: true, minRowH: 44, maxRowH: 150, rowH: 84, fontScale: 1, layout: 'auto', haptics: true, holdMs: 700, page: null, target: null };
const prefs = (() => {
  try { return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('rcb.prefs') || '{}') }; }
  catch { return { ...PREF_DEFAULTS }; }
})();
function savePrefs() { try { localStorage.setItem('rcb.prefs', JSON.stringify(prefs)); } catch {} }
function applyPrefs() {
  document.documentElement.style.setProperty('--row-h', `${prefs.rowH}px`);
  document.documentElement.style.setProperty('--fs', prefs.fontScale);
}

// ---------- app state ----------------------------------------------------------------
const S = {
  config: null,
  status: { mode: '?', connected: false },
  session: null,
  tel: {},
  log: [],
  logVer: 0,
  vars: [],
  edit: false,
  ws: null,
  wsOk: false,
  authFailed: false,
  pending: new Map(),
  get target() { return prefs.target; },
  set target(v) { prefs.target = v; savePrefs(); },
};

/* =====================================================================================
 * iRacing enums / formatting
 * ===================================================================================*/
const FLAG = {
  checkered: 0x1, white: 0x2, green: 0x4, yellow: 0x8, red: 0x10, blue: 0x20, debris: 0x40, crossed: 0x80,
  yellowWaving: 0x100, oneLapToGreen: 0x200, greenHeld: 0x400, tenToGo: 0x800, fiveToGo: 0x1000,
  randomWaving: 0x2000, caution: 0x4000, cautionWaving: 0x8000, black: 0x10000, disqualify: 0x20000,
  servicible: 0x40000, furled: 0x80000, repair: 0x100000,
  startHidden: 0x10000000, startReady: 0x20000000, startSet: 0x40000000, startGo: 0x80000000,
};
const SESSION_STATES = ['Invalid', 'Get In Car', 'Warmup', 'Parade Laps', 'Racing', 'Checkered', 'Cool Down'];
const PACE_MODES = ['Single File Start', 'Double File Start', 'Single File Restart', 'Double File Restart', 'Not Pacing'];
const TRACK_SURFACES = { '-1': 'Not in World', 0: 'Off Track', 1: 'In Pit Stall', 2: 'Approaching Pits', 3: 'On Track' };

function flagInfo(f) {
  if (f == null) return { text: '—', cls: 'flag-none' };
  const has = (b) => (f & b) !== 0;
  const waving = has(FLAG.cautionWaving) || has(FLAG.yellowWaving) || has(FLAG.randomWaving);
  let r;
  if (has(FLAG.red)) r = { text: 'RED', cls: 'flag-red' };
  else if (has(FLAG.checkered)) r = { text: 'CHECKERED', cls: 'flag-checkered' };
  else if (has(FLAG.caution) || has(FLAG.cautionWaving)) r = { text: 'CAUTION', cls: 'flag-caution' };
  else if (has(FLAG.yellow) || has(FLAG.yellowWaving)) r = { text: 'YELLOW', cls: 'flag-yellow' };
  else if (has(FLAG.white)) r = { text: 'WHITE', cls: 'flag-white' };
  else if (has(FLAG.startSet) || has(FLAG.startReady)) r = { text: 'START READY', cls: 'flag-none' };
  else if (has(FLAG.green) || has(FLAG.startGo)) r = { text: 'GREEN', cls: 'flag-green' };
  else r = { text: 'NO FLAG', cls: 'flag-none' };
  const extras = [];
  if (has(FLAG.oneLapToGreen)) extras.push('1 lap to green');
  if (has(FLAG.greenHeld)) extras.push('green held');
  if (has(FLAG.debris)) extras.push('debris');
  if (has(FLAG.tenToGo)) extras.push('10 to go');
  if (has(FLAG.fiveToGo)) extras.push('5 to go');
  return { ...r, waving, extras };
}

function fmtClock(sec) {
  if (sec == null || sec < 0) return '—';
  if (sec > 86400 * 2) return '∞';
  sec = Math.floor(sec);
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
}
function fmtLap(sec) {
  if (sec == null || sec <= 0) return '—';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return (m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3));
}
const FORMATS = {
  auto: (v, it) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(it.decimals ?? 2)) : Array.isArray(v) ? `[${v.length}]` : String(v),
  text: (v) => String(v),
  int: (v) => String(Math.round(v)),
  float: (v, it) => Number(v).toFixed(it.decimals ?? 1),
  time: fmtClock,
  laptime: fmtLap,
  laps: (v) => (v >= 32767 ? '∞' : v < 0 ? '—' : String(v)),
  pct: (v, it) => `${(v * 100).toFixed(it.decimals ?? 0)}%`,
  position: (v) => (v > 0 ? `P${v}` : '—'),
  bool: (v) => (v ? 'Yes' : 'No'),
  flags: (v) => flagInfo(v).text,
  sessionState: (v) => SESSION_STATES[v] ?? String(v),
  paceMode: (v) => PACE_MODES[v] ?? String(v),
  trackSurface: (v) => TRACK_SURFACES[v] ?? String(v),
  speed: (v, it) => `${(v * 3.6).toFixed(it.decimals ?? 0)}`,
};

/* =====================================================================================
 * Car model: session info + CarIdx telemetry arrays
 * ===================================================================================*/
let carCache = null;
function invalidateCars() { carCache = null; }

function allCars() {
  if (carCache) return carCache;
  const s = S.session;
  if (!s) return (carCache = []);
  const T = S.tel;
  const at = (name, i, dflt = null) => (Array.isArray(T[name]) ? T[name][i] ?? dflt : dflt);
  carCache = s.drivers
    .filter((d) => !d.paceCar && !d.spectator)
    .map((d) => {
      const i = d.idx;
      const lapc = at('CarIdxLapCompleted', i, -1);
      const pct = at('CarIdxLapDistPct', i, -1);
      return {
        ...d,
        pos: at('CarIdxPosition', i, 0),
        cpos: at('CarIdxClassPosition', i, 0),
        lap: at('CarIdxLap', i, -1),
        lapc,
        pct,
        run: lapc >= 0 && pct >= 0 ? lapc + pct : -1,
        pit: !!at('CarIdxOnPitRoad', i, false),
        surf: at('CarIdxTrackSurface', i, -1),
        last: at('CarIdxLastLapTime', i, -1),
        best: at('CarIdxBestLapTime', i, -1),
        flags: at('CarIdxSessionFlags', i, 0) || 0,
      };
    });
  return carCache;
}
function carByIdx(idx) { return idx == null ? null : allCars().find((c) => c.idx === idx) || null; }
function targetCar() { return carByIdx(S.target); }

function sortCars(cars, mode) {
  const arr = cars.slice();
  const byRun = (a, b) => (b.run - a.run) || (a.idx - b.idx);
  if (mode === 'number') arr.sort((a, b) => (parseInt(a.num, 10) || 0) - (parseInt(b.num, 10) || 0) || a.num.localeCompare(b.num));
  else if (mode === 'running') arr.sort(byRun);
  else if (mode === 'incidents') arr.sort((a, b) => (b.inc ?? 0) - (a.inc ?? 0) || byRun(a, b));
  else if (mode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name));
  else arr.sort((a, b) => ((a.pos || 999) - (b.pos || 999)) || byRun(a, b));
  return arr;
}
function currentSession() {
  const n = S.tel.SessionNum;
  return S.session?.sessions?.find((s) => s.num === n) || null;
}
function carLabel(c) { return c ? `#${c.num} ${c.name}` : ''; }

/* =====================================================================================
 * Telemetry sources for tiles: "VarName", "VarName[target|player|cam|N]", "@derived"
 * ===================================================================================*/
const DERIVED = {
  track: () => [S.session?.track, S.session?.trackConfig].filter(Boolean).join(' — ') || null,
  sessionType: () => currentSession()?.type ?? null,
  sessionName: () => currentSession()?.name ?? null,
  targetName: () => targetCar()?.name ?? null,
  targetNum: () => (targetCar() ? `#${targetCar().num}` : null),
  targetIncidents: () => targetCar()?.inc ?? null,
  targetTeamIncidents: () => targetCar()?.teamInc ?? null,
  camCar: () => carLabel(carByIdx(S.tel.CamCarIdx)) || null,
  leaderLap: () => { const l = sortCars(allCars(), 'position')[0]; return l ? l.lap : null; },
  carsOnPitRoad: () => allCars().filter((c) => c.pit).length,
  carsOnTrack: () => allCars().filter((c) => c.surf >= 0).length,
  carCount: () => allCars().length,
  totalIncidents: () => allCars().reduce((a, c) => a + (c.inc || 0), 0),
  subSessionId: () => S.session?.subSessionId ?? null,
};
function readSource(src) {
  if (!src) return null;
  if (src.startsWith('@')) return DERIVED[src.slice(1)]?.() ?? null;
  const m = /^(\w+)(?:\[(\w+)\])?$/.exec(src.trim());
  if (!m) return null;
  let v = S.tel[m[1]];
  if (m[2] != null && Array.isArray(v)) {
    const k = m[2];
    const idx = k === 'target' ? S.target : k === 'player' ? S.tel.PlayerCarIdx : k === 'cam' ? S.tel.CamCarIdx : parseInt(k, 10);
    v = idx == null || Number.isNaN(idx) ? null : v[idx];
  }
  return v ?? null;
}
function sourceVarName(src) {
  const m = src && !src.startsWith('@') && /^(\w+)/.exec(src.trim());
  return m ? m[1] : null;
}

/* =====================================================================================
 * Templates: {car} {name} {team} {pos} {idx} {class} {input:Label=default}
 * ===================================================================================*/
const TOKEN_RE = /\{(\w+)(?::([^}=]*))?(?:=([^}]*))?\}/g;
const CAR_TOKENS = ['car', 'name', 'team', 'pos', 'cpos', 'idx', 'class', 'abbrev', 'initials', 'lap', 'inc', 'userId'];
function stringsIn(obj, out = []) {
  if (typeof obj === 'string') out.push(obj);
  else if (obj && typeof obj === 'object') Object.values(obj).forEach((v) => stringsIn(v, out));
  return out;
}
function itemNeedsCar(item) {
  return stringsIn(item.actions || []).some((s) => [...s.matchAll(TOKEN_RE)].some((m) => CAR_TOKENS.includes(m[1])));
}
function collectInputs(actions) {
  const seen = new Map();
  for (const s of stringsIn(actions)) {
    for (const m of s.matchAll(TOKEN_RE)) {
      if (m[1] !== 'input') continue;
      const label = (m[2] || 'Value').trim();
      if (!seen.has(label)) seen.set(label, m[3] ?? '');
    }
  }
  return [...seen].map(([label, def]) => ({ label, def }));
}
function fillTemplate(str, values) {
  const c = targetCar();
  return str.replace(TOKEN_RE, (all, key, label, def) => {
    if (key === 'input') return values[(label || 'Value').trim()] ?? def ?? '';
    if (!CAR_TOKENS.includes(key)) return all;
    if (!c) return '';
    switch (key) {
      case 'car': return c.num;
      case 'name': return c.name;
      case 'team': return c.team;
      case 'pos': return c.pos || '';
      case 'cpos': return c.cpos || '';
      case 'idx': return c.idx;
      case 'class': return c.classShort;
      case 'abbrev': return c.abbrev;
      case 'initials': return c.initials;
      case 'lap': return c.lap;
      case 'inc': return c.inc ?? '';
      case 'userId': return c.userId ?? '';
    }
    return all;
  });
}
function resolveActions(actions, values) {
  const walk = (o) => typeof o === 'string' ? fillTemplate(o, values)
    : Array.isArray(o) ? o.map(walk)
    : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)])) : o;
  return walk(clone(actions));
}
function describeAction(a) {
  switch (a.type) {
    case 'chat': return a.text;
    case 'macro': return `Chat macro ${a.n}`;
    case 'camera': return a.mode === 'position' ? `Camera → P${a.position} ${a.group || ''}` : `Camera → ${/^\d+$/.test(a.car) ? '#' : ''}${a.car} ${a.group || '(current group)'}`;
    case 'replay': return `Replay: ${a.op}${a.mode ? ' ' + a.mode : ''}${a.speed != null ? ' ' + a.speed + 'x' : ''}`;
    case 'broadcast': return `Broadcast ${a.msg} (${a.var1}, ${a.var2}${a.var3 != null ? ', ' + a.var3 : ''})`;
    case 'delay': return `Wait ${a.ms} ms`;
  }
  return JSON.stringify(a);
}

/* =====================================================================================
 * WebSocket
 * ===================================================================================*/
let backoff = 500;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?device=${esc(prefs.device)}&pin=${esc(prefs.pin || '')}`);
  S.ws = ws;
  ws.onopen = () => { S.wsOk = true; backoff = 500; schedule(); };
  ws.onclose = () => {
    S.wsOk = false;
    for (const [id, p] of S.pending) finishRun(id, false, 'Connection lost');
    schedule();
    if (!S.authFailed) setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.7, 5000);
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onMessage(m);
  };
}
function send(obj) {
  if (!S.ws || S.ws.readyState !== 1) return false;
  S.ws.send(JSON.stringify(obj));
  return true;
}

function onMessage(m) {
  switch (m.t) {
    case 'hello':
      S.authFailed = false;
      S.config = m.config;
      S.status = m.status;
      S.session = m.session;
      S.log = m.log || [];
      S.logVer++;
      invalidateCars();
      renderAll();
      sendSubs();
      fetchVars();
      break;
    case 'auth':
      if (!m.ok) { S.authFailed = true; openPinPrompt(); }
      break;
    case 'status':
      S.status = m;
      if (!m.connected) { S.tel = {}; invalidateCars(); }
      else fetchVars();
      schedule();
      break;
    case 'session':
      S.session = m.d;
      invalidateCars();
      updateDatalists();
      schedule();
      break;
    case 'tel':
      Object.assign(S.tel, m.d);
      invalidateCars();
      schedule();
      break;
    case 'config': {
      // Keep our own object when it's just the echo of our save: rendered items hold references into it
      if (JSON.stringify(m.config) !== JSON.stringify(S.config)) {
        S.config = m.config;
        renderBoard();
        renderTabs();
        sendSubs();
        if (m.by && m.by !== prefs.device) toast(`Layout updated by ${m.by}`);
      }
      break;
    }
    case 'log':
      S.log.push(m.entry);
      if (S.log.length > 250) S.log.shift();
      S.logVer++;
      schedule();
      break;
    case 'logCleared':
      S.log = [];
      S.logVer++;
      schedule();
      break;
    case 'result':
      finishRun(m.id, m.ok, m.error);
      break;
    case 'error':
      toast(m.error, 'bad');
      break;
  }
}

function sendSubs() {
  const vars = new Set();
  for (const p of S.config?.pages || []) {
    for (const it of p.items || []) {
      if (it.type === 'tile') { const v = sourceVarName(it.source); if (v) vars.add(v); }
    }
  }
  send({ t: 'sub', vars: [...vars] });
}

async function fetchVars() {
  try {
    const r = await fetch('/api/vars', { headers: { 'X-Pin': prefs.pin || '' } });
    if (r.ok) { S.vars = await r.json(); updateDatalists(); }
  } catch {}
}

function saveConfig() {
  if (!send({ t: 'saveConfig', config: S.config })) toast('Not connected — change not saved', 'bad');
  sendSubs();
}

/* =====================================================================================
 * Update loop
 * ===================================================================================*/
let dyn = [];          // per-render update callbacks
const sheetDyn = new Set(); // update callbacks owned by open sheets
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    updateTopbar();
    for (const fn of [...dyn, ...sheetDyn]) { try { fn(); } catch (e) { console.error(e); } }
  });
}

/* =====================================================================================
 * Rendering
 * ===================================================================================*/
function pages() { return S.config?.pages || []; }
function currentPage() {
  const ps = pages();
  if (S.edit && prefs.page === DRIVER_SHEET_ID && S.config) return driverSheetPage();
  return ps.find((p) => p.id === prefs.page) || ps[0] || null;
}

// The popup shown when tapping a driver. Stored in config like a page so it's edited the same way.
const DRIVER_SHEET_ID = '__driver';
const DEFAULT_DRIVER_SHEET = {
  id: DRIVER_SHEET_ID, name: 'Driver popup', columns: { narrow: 3, wide: 4 },
  items: [
    { id: 'd-wave', type: 'button', label: 'Wave Around', icon: '↻', color: '#2563eb', w: 1, h: 1, actions: [{ type: 'chat', text: '!waveby #{car}' }] },
    { id: 'd-eol', type: 'button', label: 'End of Line', icon: '⤓', color: '#7c3aed', w: 1, h: 1, actions: [{ type: 'chat', text: '!eol #{car}' }] },
    { id: 'd-cam', type: 'button', label: 'Watch Car', icon: '◉', color: '#0891b2', w: 1, h: 1, actions: [{ type: 'camera', mode: 'car', car: '{car}', group: '', camera: 0 }] },
    { id: 'd-dt', type: 'button', label: 'Drive-Through', icon: '⚑', color: '#1f2937', w: 1, h: 1, actions: [{ type: 'chat', text: '!black #{car} D' }] },
    { id: 'd-sh', type: 'button', label: 'Stop & Hold', icon: '⏱', color: '#1f2937', w: 1, h: 1, actions: [{ type: 'chat', text: '!black #{car} {input:Seconds=10}' }] },
    { id: 'd-clr', type: 'button', label: 'Clear Penalty', icon: '✓', color: '#059669', w: 1, h: 1, actions: [{ type: 'chat', text: '!clear #{car}' }] },
    { id: 'd-mute', type: 'button', label: 'Mute', icon: '🔇', color: '#475569', w: 1, h: 1, actions: [{ type: 'chat', text: '!nchat #{car}' }] },
    { id: 'd-unmute', type: 'button', label: 'Unmute', icon: '🔈', color: '#475569', w: 1, h: 1, actions: [{ type: 'chat', text: '!chat #{car}' }] },
    { id: 'd-blk', type: 'button', label: 'Black Flag', sub: 'custom', icon: '⚑', color: '#1f2937', w: 1, h: 1, actions: [{ type: 'chat', text: '!black #{car} {input:Penalty (seconds, L# laps, or D)=D}' }] },
    { id: 'd-dq', type: 'button', label: 'Disqualify', sub: 'hold', icon: '✕', color: '#b91c1c', w: 1, h: 1, confirm: true, hold: true, actions: [{ type: 'chat', text: '!dq #{car}' }] },
    { id: 'd-rm', type: 'button', label: 'Remove', sub: 'hold', icon: '⏏', color: '#7f1d1d', w: 1, h: 1, confirm: true, hold: true, actions: [{ type: 'chat', text: '!remove #{car}' }] },
  ],
};
function driverSheetPage() {
  if (!S.config.driverSheet) S.config.driverSheet = clone(DEFAULT_DRIVER_SHEET);
  return S.config.driverSheet;
}
function isWide() {
  return prefs.layout === 'wide' || (prefs.layout !== 'narrow' && window.innerWidth >= 700);
}
function pageCols(p) {
  const c = p?.columns || {};
  return Math.max(1, Math.min(12, parseInt(isWide() ? c.wide : c.narrow, 10) || (isWide() ? 6 : 3)));
}

function renderAll() {
  applyPrefs();
  renderTabs();
  renderBoard();
  updateDatalists();
  schedule();
}

function renderTabs() {
  const nav = $('#tabs');
  const cur = currentPage();
  nav.replaceChildren(
    ...pages().map((p) => h('button', {
      class: 'tab' + (p === cur ? ' active' : ''), type: 'button',
      onclick: () => {
        if (S.edit && p === cur) return openPageEditor(p);
        prefs.page = p.id; savePrefs(); renderTabs(); renderBoard();
      },
    }, p.name || 'Page', S.edit && p === cur ? ' ✎' : '')),
    ...(S.edit ? [
      h('button', { class: 'tab add', type: 'button', title: 'Add page', onclick: addPage }, '+'),
      h('button', {
        class: 'tab driver-tab' + (cur?.id === DRIVER_SHEET_ID ? ' active' : ''), type: 'button',
        onclick: () => {
          if (cur?.id === DRIVER_SHEET_ID) return openPageEditor(cur);
          prefs.page = DRIVER_SHEET_ID; savePrefs(); renderTabs(); renderBoard();
        },
      }, '👤 Driver popup', cur?.id === DRIVER_SHEET_ID ? ' ✎' : ''),
    ] : []),
  );
  nav.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderBoard() {
  const board = $('#board');
  dyn = [];
  const page = currentPage();
  if (!page) {
    board.replaceChildren(h('div', { class: 'empty-page' }, S.config ? 'No pages yet — tap ✎ then + to add one.' : 'Connecting…'));
    return;
  }
  const cols = pageCols(page);
  const grid = h('div', { class: 'grid' + (S.edit ? ' editing' : ''), style: `--cols:${cols}` });
  page.items.forEach((item, index) => {
    const { cell, update } = renderCell(item, index, cols);
    if (update) dyn.push(update);
    if (S.edit) cell.append(editOverlay(item, cell));
    grid.append(cell);
  });
  if (S.edit) {
    grid.append(h('div', { class: 'cell', style: 'grid-column: span 1' },
      h('button', { class: 'add-cell', type: 'button', title: 'Add item', onclick: openAddItem }, '+')));
  } else if (!page.items.length) {
    board.replaceChildren(h('div', { class: 'empty-page' }, 'This page is empty — tap ✎ to add buttons.'));
    return;
  }
  board.replaceChildren(grid);
  fitBoard();
  schedule();
}

function renderCell(item, index, cols) {
  const w = Math.max(1, Math.min(cols, parseInt(item.w, 10) || 1));
  const hgt = Math.max(1, Math.min(20, parseInt(item.h, 10) || 1));
  const cell = h('div', { class: 'cell item-cell', 'data-index': index, style: `grid-column: span ${w}; grid-row: span ${hgt}` });
  let r;
  try { r = renderItem(item); } catch (e) { console.error(e); r = { el: h('div', { class: 'panel tile' }, 'Error') }; }
  cell.append(r.el);
  return { cell, update: r.update };
}

// Size rows so the whole page fits the screen (within the device's min/max row height).
function fitBoard() {
  const board = $('#board');
  const grid = board.querySelector('.grid');
  if (!grid) return;
  if (!prefs.fit) { grid.style.removeProperty('--row-h'); return; }
  const bs = getComputedStyle(board);
  const avail = board.clientHeight - parseFloat(bs.paddingTop) - parseFloat(bs.paddingBottom);
  const gs = getComputedStyle(grid);
  const rows = gs.gridTemplateRows.split(' ').filter((t) => t && t !== 'none').length;
  if (!rows || avail <= 0) return;
  const gap = parseFloat(gs.rowGap) || 0;
  const fit = Math.floor((avail - gap * (rows - 1)) / rows);
  const rowH = Math.max(prefs.minRowH || 30, Math.min(prefs.maxRowH || 400, fit));
  if (grid.style.getPropertyValue('--row-h') !== `${rowH}px`) grid.style.setProperty('--row-h', `${rowH}px`);
}

function renderItem(item) {
  switch (item.type) {
    case 'button': return renderButton(item);
    case 'tile': return renderTile(item);
    case 'drivers': return renderDriversWidget(item);
    case 'target': return renderTargetCard(item);
    case 'flag': return renderFlag(item);
    case 'log': return renderLog(item);
    case 'label': return { el: h('div', { class: 'label-item' }, item.label || '') };
  }
  return { el: h('div', { class: 'panel tile' }, h('span', { class: 't-label' }, `Unknown: ${item.type}`)) };
}

// ---------- button --------------------------------------------------------------------
function renderButton(item) {
  const el = h('button', {
    class: 'btn' + ((item.h || 1) > 1 ? ' tall' : ''), type: 'button',
    style: `--c:${item.color || '#334155'};--fg:${item.textColor || '#ffffff'}`,
  },
  item.icon ? h('span', { class: 'btn-icon' }, item.icon) : null,
  h('span', { class: 'btn-label' }, item.label || ''),
  item.sub ? h('span', { class: 'btn-sub' }, item.sub) : null,
  h('span', { class: 'hold-fill' }));
  const needsCar = itemNeedsCar(item);
  if (!S.edit) bindPress(el, item);
  return { el, update: needsCar ? () => el.classList.toggle('needs-target', !targetCar()) : null };
}

function bindPress(el, item) {
  let timer = null;
  const holdMs = parseInt(item.holdMs, 10) || prefs.holdMs;
  const reset = () => { el.classList.remove('pressed', 'holding'); };
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.classList.add('pressed');
    if (item.hold) {
      el.style.setProperty('--hold', `${holdMs}ms`);
      requestAnimationFrame(() => el.classList.add('holding'));
      timer = setTimeout(() => { timer = null; reset(); buzz(40); trigger(item, el); }, holdMs);
    }
  });
  el.addEventListener('pointerup', () => {
    const wasPressed = el.classList.contains('pressed');
    reset();
    if (item.hold) {
      if (timer) { clearTimeout(timer); timer = null; toast('Press and hold to activate'); }
      return;
    }
    if (wasPressed) { buzz(15); trigger(item, el); }
  });
  const cancel = () => { reset(); if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
}

function buzz(ms) { if (prefs.haptics && navigator.vibrate) try { navigator.vibrate(ms); } catch {} }

async function trigger(item, el) {
  const actions = item.actions || [];
  if (!actions.length) return toast('This button has no actions yet — edit it with ✎');
  if (!S.wsOk) return toast('Not connected to the server', 'bad');
  if (itemNeedsCar(item) && !targetCar()) {
    toast('Pick a target car first');
    return openPicker(() => trigger(item, el));
  }
  let values = {};
  const inputs = collectInputs(actions);
  if (inputs.length) {
    values = await openInputs(item, inputs);
    if (!values) return;
  }
  const resolved = resolveActions(actions, values);
  if (item.confirm && !(await openConfirm(item, resolved))) return;
  runActions(item, resolved, el);
}

function runActions(item, actions, el) {
  const id = uid();
  el?.classList.add('busy');
  const timeout = setTimeout(() => finishRun(id, false, 'No response from server'), 20000);
  const summary = actions.filter((a) => a.type !== 'delay').map(describeAction).join(' → ');
  S.pending.set(id, { el, item, timeout, summary });
  if (!send({ t: 'run', id, label: item.label || item.type, actions })) finishRun(id, false, 'Not connected');
}
function finishRun(id, ok, error) {
  const p = S.pending.get(id);
  if (!p) return;
  S.pending.delete(id);
  clearTimeout(p.timeout);
  const el = p.el;
  if (el) {
    el.classList.remove('busy', 'ok', 'fail');
    void el.offsetWidth;
    el.classList.add(ok ? 'ok' : 'fail');
    setTimeout(() => el.classList.remove('ok', 'fail'), 900);
  }
  if (!ok) { toast(`${p.item.label || 'Command'}: ${error || 'failed'}`, 'bad'); buzz([60, 60, 60]); }
  else if (p.summary) toast(`✓ ${p.summary}`, 'ok');
}

// ---------- tile ----------------------------------------------------------------------
function renderTile(item) {
  const val = h('div', { class: 't-value' }, '—');
  const el = h('div', { class: 'panel tile' + ((item.h || 1) > 1 ? ' tall' : ''), style: item.color ? `border-color:${item.color}` : null },
    h('div', { class: 't-label' }, item.label || item.source || ''), val);
  let last;
  return {
    el,
    update: () => {
      const v = readSource(item.source);
      let text = '—';
      if (v != null && v !== '') {
        try { text = (FORMATS[item.format] || FORMATS.auto)(v, item); } catch { text = String(v); }
        if (text !== '—' && item.suffix) text += item.suffix;
      }
      if (text !== last) { val.textContent = text; last = text; }
      if (item.color) val.style.color = item.color;
    },
  };
}

// ---------- flag ----------------------------------------------------------------------
function renderFlag() {
  const main = h('div', { class: 'f-main' });
  const sub = h('div', { class: 'f-sub' });
  const el = h('div', { class: 'panel flag-panel' }, main, sub);
  return {
    el,
    update: () => {
      const f = flagInfo(S.tel.SessionFlags);
      el.className = `panel flag-panel ${f.cls}${f.waving ? ' waving' : ''}`;
      main.textContent = f.text;
      const parts = [];
      if (S.tel.SessionState != null) parts.push(SESSION_STATES[S.tel.SessionState]);
      if (S.tel.PaceMode != null && S.tel.PaceMode !== 4) parts.push(PACE_MODES[S.tel.PaceMode]);
      if (S.tel.SessionLapsRemainEx != null && S.tel.SessionLapsRemainEx < 32767) parts.push(`${S.tel.SessionLapsRemainEx} laps left`);
      parts.push(...(f.extras || []));
      sub.textContent = parts.filter(Boolean).join(' · ');
    },
  };
}

// ---------- driver list ---------------------------------------------------------------
function numBadge(c) {
  return h('span', { class: 'num-badge', style: `--cls:${c?.classColor || '#fff'}` }, c ? c.num : '?');
}
function carTags(c) {
  const tags = [];
  if (c.flags & FLAG.disqualify) tags.push(['DQ', 'dq']);
  else if (c.flags & FLAG.black) tags.push(['BLACK', 'blk']);
  if (c.flags & FLAG.repair) tags.push(['REPAIR', 'off']);
  if (c.pit) tags.push([c.surf === 1 ? 'STALL' : 'PIT', 'pit']);
  else if (c.surf === 0) tags.push(['OFF', 'off']);
  if (c.idx === S.tel.CamCarIdx) tags.push(['CAM', 'cam']);
  return tags;
}

function driverList({ sort = 'position', onSelect, showSearch = true }) {
  const list = h('div', { class: 'dl-list' });
  const rows = new Map();
  let query = '';
  let sortMode = sort;
  const search = h('input', { type: 'search', placeholder: 'Search # / name…', oninput: (e) => { query = e.target.value.trim().toLowerCase(); update(); } });
  const sortSel = h('select', { onchange: (e) => { sortMode = e.target.value; update(); } },
    [['position', 'Pos'], ['running', 'Track'], ['number', 'Car #'], ['incidents', 'Inc'], ['name', 'Name']]
      .map(([v, l]) => h('option', { value: v, selected: v === sortMode }, l)));
  const head = showSearch ? h('div', { class: 'dl-head' }, search, sortSel) : null;

  function makeRow(idx) {
    const r = {
      pos: h('span', { class: 'd-pos' }),
      badge: h('span', { class: 'num-badge' }),
      name: h('div', { class: 'd-name' }),
      meta: h('div', { class: 'd-meta' }),
      tags: h('span', { class: 'd-tags' }),
      key: '',
    };
    r.el = h('button', { class: 'drow', type: 'button', onclick: () => onSelect(idx) },
      r.pos, r.badge, h('div', { class: 'd-info' }, r.name, r.meta), r.tags);
    return r;
  }
  function update() {
    let cars = sortCars(allCars(), sortMode);
    if (query) cars = cars.filter((c) => c.num.includes(query.replace('#', '')) || c.name.toLowerCase().includes(query) || c.team.toLowerCase().includes(query));
    const seen = new Set();
    cars.forEach((c, i) => {
      seen.add(c.idx);
      let r = rows.get(c.idx);
      if (!r) { r = makeRow(c.idx); rows.set(c.idx, r); }
      const tags = carTags(c);
      const key = [c.pos, c.num, c.name, c.classColor, c.lap, c.last, c.best, c.inc, c.surf, c.pit, c.flags, S.target === c.idx, S.tel.CamCarIdx === c.idx, c.classShort, c.car].join('|');
      if (key !== r.key) {
        r.key = key;
        r.pos.textContent = c.pos > 0 ? c.pos : '—';
        r.badge.textContent = c.num;
        r.badge.style.setProperty('--cls', c.classColor);
        r.name.textContent = c.name;
        const meta = [c.classShort || c.car, c.lap >= 0 ? `L${c.lap}` : null, c.last > 0 ? fmtLap(c.last) : null, c.best > 0 ? `best ${fmtLap(c.best)}` : null];
        r.meta.textContent = meta.filter(Boolean).join(' · ');
        r.tags.replaceChildren(
          ...tags.map(([t, cls]) => h('span', { class: `tag ${cls}` }, t)),
          ...(c.inc != null ? [h('span', { class: 'tag inc' + (c.inc >= 8 ? ' hi' : '') }, `${c.inc}x`)] : []),
        );
        r.el.classList.toggle('sel', S.target === c.idx);
        r.el.classList.toggle('gone', c.surf < 0);
      }
      if (list.children[i] !== r.el) list.insertBefore(r.el, list.children[i] || null);
    });
    for (const [idx, r] of rows) if (!seen.has(idx)) { r.el.remove(); rows.delete(idx); }
    if (!cars.length && !list.querySelector('.muted')) {
      list.replaceChildren(h('div', { class: 'muted', style: 'padding:20px;text-align:center' }, S.session ? 'No matching cars' : 'No session data yet'));
    } else if (cars.length) list.querySelector(':scope > .muted')?.remove();
  }
  return { head, list, search, update };
}

function renderDriversWidget(item) {
  const dl = driverList({
    sort: item.sort || 'position',
    onSelect: (idx) => {
      buzz(10);
      if (item.tap === 'select') { S.target = S.target === idx && item.toggle ? null : idx; schedule(); return; }
      S.target = idx;
      schedule();
      openDriverSheet();
    },
  });
  const el = h('div', { class: 'panel drivers' }, dl.head, dl.list);
  return { el, update: dl.update };
}

function openDriverSheet() {
  const page = driverSheetPage();
  const cols = pageCols(page);
  const card = renderTargetCard();
  const grid = h('div', { class: 'grid sheet-grid', style: `--cols:${cols}` });
  const updates = [card.update];
  page.items.forEach((item, i) => {
    const { cell, update } = renderCell(item, i, cols);
    if (update) updates.push(update);
    grid.append(cell);
  });
  const upd = () => updates.forEach((f) => f());
  sheetDyn.add(upd);
  openSheet({
    title: 'Driver actions',
    body: [h('div', { class: 'sheet-card' }, card.el), page.items.length ? grid : h('p', { class: 'hint' }, 'No buttons yet — tap Customize.')],
    foot: (c) => [
      h('button', { type: 'button', onclick: () => { c(); prefs.page = DRIVER_SHEET_ID; savePrefs(); setEdit(true); } }, 'Customize'),
      h('button', { type: 'button', class: 'primary', onclick: c }, 'Done'),
    ],
    onClose: () => sheetDyn.delete(upd),
  });
  upd();
}

// ---------- target card ---------------------------------------------------------------
function cycleTarget(dir) {
  const cars = sortCars(allCars(), 'position');
  if (!cars.length) return;
  const i = cars.findIndex((c) => c.idx === S.target);
  const n = cars[(i + dir + cars.length) % cars.length];
  S.target = n.idx;
  buzz(10);
  schedule();
}
function renderTargetCard() {
  const main = h('button', { class: 'tc-main', type: 'button', onclick: () => openPicker() });
  const el = h('div', { class: 'panel target-card' }, main,
    h('div', { class: 'tc-side' },
      h('button', { type: 'button', title: 'Previous position', onclick: () => cycleTarget(-1) }, '▲'),
      h('button', { type: 'button', title: 'Target the car on camera', onclick: () => { if (S.tel.CamCarIdx != null && carByIdx(S.tel.CamCarIdx)) { S.target = S.tel.CamCarIdx; schedule(); } else toast('No camera car'); } }, '◉'),
      h('button', { type: 'button', title: 'Next position', onclick: () => cycleTarget(1) }, '▼')));
  let lastKey = null;
  return {
    el,
    update: () => {
      const c = targetCar();
      const key = c ? [c.idx, c.num, c.name, c.pos, c.cpos, c.lap, c.last, c.best, c.inc, c.pit, c.surf, c.flags, S.tel.CamCarIdx].join('|') : 'none';
      if (key === lastKey) return;
      lastKey = key;
      if (!c) {
        main.replaceChildren(h('div', { class: 'tc-info' }, h('div', { class: 'tc-empty' }, 'No target car'), h('div', { class: 'tc-meta' }, 'Tap here to pick a driver')));
        return;
      }
      main.replaceChildren(numBadge(c), h('div', { class: 'tc-info' },
        h('div', { class: 'tc-name' }, c.name),
        h('div', { class: 'tc-meta' }, [c.team !== c.name ? c.team : null, c.car, c.classShort, c.license, c.irating ? `${c.irating} iR` : null].filter(Boolean).join(' · ')),
        h('div', { class: 'tc-stats' },
          h('span', {}, h('b', {}, c.pos > 0 ? `P${c.pos}` : '—'), c.cpos > 0 && c.classShort ? ` (${c.classShort} P${c.cpos})` : ''),
          h('span', {}, 'Lap ', h('b', {}, c.lap >= 0 ? c.lap : '—')),
          h('span', {}, 'Last ', h('b', {}, fmtLap(c.last))),
          h('span', {}, 'Inc ', h('b', {}, c.inc ?? '—', 'x')),
          ...carTags(c).map(([t, cls]) => h('span', { class: `tag ${cls}` }, t)))));
    },
  };
}

// ---------- log -----------------------------------------------------------------------
function logRows(limit) {
  return S.log.slice(-limit).reverse().map((e) => h('div', { class: 'log-row' + (e.ok ? '' : ' bad') },
    h('span', { class: 'l-time' }, new Date(e.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    h('span', { class: 'l-dev' }, e.device),
    h('span', { class: 'l-text' }, e.text, e.ok ? '' : ` — ${e.error}`)));
}
function renderLog() {
  const list = h('div', { class: 'log-list' });
  const el = h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, 'Command log'), list);
  let ver = -1;
  return {
    el,
    update: () => {
      if (ver === S.logVer) return;
      ver = S.logVer;
      list.replaceChildren(...(S.log.length ? logRows(100) : [h('div', { class: 'muted', style: 'padding:14px' }, 'No commands sent yet')]));
    },
  };
}

// ---------- top bar -------------------------------------------------------------------
function updateTopbar() {
  const conn = $('#conn');
  let cls = 'conn', text;
  if (!S.wsOk) { text = S.authFailed ? 'PIN required' : 'Reconnecting…'; }
  else if (S.status.mode === 'demo') { cls += ' demo'; text = 'DEMO'; }
  else if (S.status.connected) { cls += ' ok'; text = S.session?.track || 'iRacing'; }
  else { cls += ' warn'; text = 'Sim not running'; }
  conn.className = cls;
  $('#connText').textContent = text;

  const f = flagInfo(S.status.connected ? S.tel.SessionFlags : null);
  const chip = $('#flagChip');
  chip.className = `flag-chip ${f.cls}${f.waving ? ' waving' : ''}`;
  chip.textContent = f.text;

  const tc = $('#targetChip');
  const c = targetCar();
  tc.classList.toggle('empty', !c);
  if (c) {
    const txt = `${c.pos > 0 ? 'P' + c.pos + ' ' : ''}${c.name}`;
    const key = c.num + txt + c.classColor;
    if (tc.dataset.key !== key) {
      tc.dataset.key = key;
      tc.replaceChildren(numBadge(c), h('span', {}, txt));
    }
  } else if (tc.dataset.key !== '') {
    tc.dataset.key = '';
    tc.textContent = 'Select car';
  }
}

function updateDatalists() {
  const vl = $('#varList');
  const derived = Object.keys(DERIVED).map((k) => h('option', { value: '@' + k }, 'derived'));
  const vars = S.vars.map((v) => h('option', { value: v.name + (v.name.startsWith('CarIdx') ? '[target]' : '') }, `${v.desc}${v.unit ? ' (' + v.unit + ')' : ''}`));
  vl.replaceChildren(...derived, ...vars);
  $('#camList').replaceChildren(...(S.session?.cameras || []).map((c) => h('option', { value: c.name })));
  $('#chatList').replaceChildren(...CHAT_SUGGESTIONS.map((s) => h('option', { value: s })));
}

const CHAT_SUGGESTIONS = [
  '!waveby #{car}', '!eol #{car}', '!black #{car} D', '!black #{car} {input:Seconds=10}', '!black #{car} L{input:Laps=1}',
  '!clear #{car}', '!clearall', '!dq #{car}', '!remove #{car}', '!yellow', '!pitclose', '!pitopen', '!pacelaps {input:Laps=2}',
  '!advance', '!chat', '!nchat', '!chat #{car}', '!nchat #{car}', '!admin #{car}', '!nadmin #{car}', '{input:Message}',
];

/* =====================================================================================
 * Sheets (modal dialogs)
 * ===================================================================================*/
function openSheet({ title, body, foot, wide, flush, onClose }) {
  const root = $('#sheets');
  const sheet = h('div', { class: 'sheet' + (wide ? ' wide' : '') });
  const back = h('div', { class: 'backdrop' }, sheet);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape' && root.lastElementChild === back) close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) back.dataset.down = '1'; });
  back.addEventListener('click', (e) => { if (e.target === back && back.dataset.down) close(); delete back.dataset.down; });
  sheet.append(
    h('div', { class: 'sheet-head' }, title, h('button', { class: 'x', type: 'button', onclick: close, title: 'Close' }, '✕')),
    h('div', { class: 'sheet-body' + (flush ? ' flush' : '') }, body),
  );
  if (foot) sheet.append(h('div', { class: 'sheet-foot' }, typeof foot === 'function' ? foot(close) : foot));
  root.append(back);
  return close;
}

function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 4000 : 2200);
}

// ---------- pickers / prompts ---------------------------------------------------------
function openPicker(then) {
  const dl = driverList({
    sort: 'position',
    onSelect: (idx) => { S.target = idx; buzz(10); close(); schedule(); if (then) setTimeout(then, 50); },
  });
  const close = openSheet({
    title: 'Target car',
    flush: true,
    body: [dl.head, dl.list],
    foot: (c) => [h('button', { type: 'button', onclick: () => { S.target = null; c(); schedule(); } }, 'Clear target'), h('button', { type: 'button', onclick: c }, 'Cancel')],
    onClose: () => sheetDyn.delete(dl.update),
  });
  sheetDyn.add(dl.update);
  dl.update();
  if (window.innerWidth >= 700) dl.search.focus();
}

function targetLine() {
  const c = targetCar();
  return c ? h('div', { class: 'confirm-target' }, numBadge(c), h('span', {}, c.name, c.pos > 0 ? h('span', { class: 'muted' }, ` · P${c.pos}`) : '')) : null;
}

function openInputs(item, inputs) {
  return new Promise((resolve) => {
    const values = {};
    let done = false;
    const fields = inputs.map((inp, i) => {
      values[inp.label] = inp.def;
      const input = h('input', {
        type: 'text', value: inp.def, autocomplete: 'off', autocapitalize: 'off',
        oninput: (e) => { values[inp.label] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') submit(); },
      });
      if (i === 0) setTimeout(() => { input.focus(); input.select(); }, 60);
      return h('label', { class: 'field' }, h('span', {}, inp.label), input);
    });
    const submit = () => { done = true; close(); resolve(values); };
    const close = openSheet({
      title: item.label || 'Input',
      body: [targetLine(), ...fields],
      foot: (c) => [h('button', { type: 'button', onclick: c }, 'Cancel'), h('button', { type: 'button', class: 'primary', onclick: submit }, item.confirm ? 'Next' : 'Send')],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

function openConfirm(item, actions) {
  return new Promise((resolve) => {
    let result = false;
    const close = openSheet({
      title: `${item.icon ? item.icon + ' ' : ''}${item.label || 'Confirm'}`,
      body: [
        itemNeedsCar(item) ? targetLine() : null,
        h('ul', { class: 'preview-list' }, actions.filter((a) => a.type !== 'delay').map((a) => h('li', {}, describeAction(a)))),
      ],
      foot: (c) => [
        h('button', { type: 'button', onclick: c }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', style: `background:${item.color || ''};border-color:${item.color || ''};color:${item.textColor || '#fff'}`, onclick: () => { result = true; c(); } }, 'Send'),
      ],
      onClose: () => resolve(result),
    });
  });
}

function openPinPrompt() {
  let val = prefs.pin || '';
  const input = h('input', { type: 'password', inputmode: 'numeric', value: val, oninput: (e) => { val = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') go(); } });
  setTimeout(() => input.focus(), 60);
  const go = () => { prefs.pin = val; savePrefs(); close(); S.authFailed = false; connect(); };
  const close = openSheet({
    title: 'Enter PIN',
    body: [h('p', { class: 'hint' }, 'This board is protected with a PIN (set in Settings on another device, or in data/config.json on the PC).'), h('label', { class: 'field' }, h('span', {}, 'PIN'), input)],
    foot: [h('button', { type: 'button', class: 'primary', onclick: () => go() }, 'Connect')],
  });
}

/* =====================================================================================
 * Menu, settings, prefs, import/export, log
 * ===================================================================================*/
function openMenu() {
  const item = (label, sub, fn) => h('button', { type: 'button', onclick: () => { close(); fn(); } }, label, h('small', {}, sub));
  const close = openSheet({
    title: 'Menu',
    body: h('div', { class: 'menu-list' },
      item('✎  Edit layout', 'Add, move and configure buttons, tiles and pages', () => setEdit(true)),
      item('👤  Driver popup buttons', 'Choose what appears when you tap a driver', () => { prefs.page = DRIVER_SHEET_ID; savePrefs(); setEdit(true); }),
      item('📱  This device', `Button size, text size, layout — ${prefs.device}`, openPrefs),
      item('⚙  Server settings', 'PIN, chat typing method & timing, telemetry rate', openSettings),
      item('📜  Command log', `${S.log.length} entries`, openLogSheet),
      item('⇄  Import / export layout', 'Back up or share your board as JSON', openImportExport),
      item('↻  Reload', 'Reload this page', () => location.reload())),
  });
}

function setEdit(on) {
  S.edit = on;
  if (!on && prefs.page === DRIVER_SHEET_ID) { prefs.page = pages()[0]?.id ?? null; savePrefs(); }
  $('#editBtn').classList.toggle('on', on);
  $('#editBar').hidden = !on;
  renderTabs();
  renderBoard();
}

// form helpers bound to an object
function fText(obj, key, label, attrs = {}, hint) {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'text', value: obj[key] ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...attrs, oninput: (e) => { obj[key] = e.target.value; } }),
    hint ? h('small', {}, hint) : null);
}
function fNum(obj, key, label, { min, max, step, hint } = {}) {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('input', { type: 'number', inputmode: 'decimal', value: obj[key] ?? '', min, max, step, oninput: (e) => { obj[key] = e.target.value === '' ? undefined : Number(e.target.value); } }),
    hint ? h('small', {}, hint) : null);
}
function fSel(obj, key, label, options, onchange, hint) {
  return h('label', { class: 'field' }, h('span', {}, label),
    h('select', { onchange: (e) => { obj[key] = e.target.value; onchange?.(); } },
      options.map(([v, l]) => h('option', { value: v, selected: String(obj[key] ?? '') === String(v) }, l))),
    hint ? h('small', {}, hint) : null);
}
function fChk(obj, key, label) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => { obj[key] = e.target.checked; } }), label);
}
const SWATCHES = ['#2563eb', '#0891b2', '#0d9488', '#059669', '#16a34a', '#65a30d', '#eab308', '#ea580c', '#dc2626', '#b91c1c', '#db2777', '#9333ea', '#7c3aed', '#475569', '#334155', '#1f2937'];
function fColor(obj, key, label, { allowNone } = {}) {
  const wrap = h('div', { class: 'swatches' });
  const draw = () => {
    wrap.replaceChildren(
      ...(allowNone ? [h('button', { type: 'button', class: 'swatch' + (!obj[key] ? ' sel' : ''), style: 'background:var(--panel2)', title: 'None', onclick: () => { delete obj[key]; draw(); } }, '∅')] : []),
      ...SWATCHES.map((c) => h('button', { type: 'button', class: 'swatch' + (obj[key] === c ? ' sel' : ''), style: `background:${c}`, onclick: () => { obj[key] = c; draw(); } })),
      h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(obj[key] || '') ? obj[key] : '#334155', oninput: (e) => { obj[key] = e.target.value; }, onchange: draw }),
    );
  };
  draw();
  return h('div', { class: 'field' }, h('span', {}, label), wrap);
}

function openPrefs() {
  const d = { ...prefs };
  openSheet({
    title: 'This device',
    body: [
      fText(d, 'device', 'Device name', {}, 'Shown in the command log'),
      fChk(d, 'fit', 'Fit each page to the screen (no scrolling)'),
      h('div', { class: 'row' },
        fNum(d, 'minRowH', 'Min row height (px)', { min: 24, max: 200 }),
        fNum(d, 'maxRowH', 'Max row height (px)', { min: 40, max: 400 })),
      fNum(d, 'rowH', 'Row height when not fitting (px)', { min: 30, max: 240, step: 2 }),
      fNum(d, 'fontScale', 'Text scale', { min: 0.6, max: 2, step: 0.05 }),
      fSel(d, 'layout', 'Column layout', [['auto', 'Auto (by screen width)'], ['narrow', 'Always narrow (phone)'], ['wide', 'Always wide (tablet)']]),
      fNum(d, 'holdMs', 'Hold-to-fire duration (ms)', { min: 200, max: 3000, step: 50 }),
      fChk(d, 'haptics', 'Vibrate on press (Android)'),
      fText(d, 'pin', 'PIN used to connect', { type: 'password' }),
    ],
    foot: (c) => [h('button', { type: 'button', onclick: c }, 'Cancel'), h('button', {
      type: 'button', class: 'primary', onclick: () => {
        const reconnect = d.device !== prefs.device || d.pin !== prefs.pin;
        Object.assign(prefs, d); savePrefs(); applyPrefs(); renderBoard(); c();
        if (reconnect) S.ws?.close();
      },
    }, 'Save')],
  });
}

function openSettings() {
  if (!S.config) return;
  const d = { ...S.config.settings };
  openSheet({
    title: 'Server settings',
    body: [
      h('div', { class: 'section-title' }, 'Access'),
      fText(d, 'pin', 'PIN (blank = none)', { type: 'password' }, 'Required by every device that connects. This device will switch to the new PIN automatically.'),
      fChk(d, 'lanOnly', 'Only allow private/LAN addresses'),
      h('div', { class: 'section-title' }, 'Chat commands'),
      h('p', { class: 'hint' }, 'Admin commands (', h('span', { class: 'code' }, '!waveby'), ', ', h('span', { class: 'code' }, '!black'), ' …) are typed into iRacing chat. ',
        '"Focus & type" briefly brings iRacing to the front and types like a keyboard (most reliable). "Background" posts characters to the window without focusing it.'),
      fSel(d, 'chatMethod', 'Typing method', [['sendinput', 'Focus & type (recommended)'], ['postmessage', 'Background (no focus change)']]),
      h('div', { class: 'row' },
        fNum(d, 'chatOpenDelayMs', 'Open delay ms', { min: 0, max: 2000 }),
        fNum(d, 'chatCharDelayMs', 'Per-char ms', { min: 0, max: 200 }),
        fNum(d, 'chatSubmitDelayMs', 'Submit delay ms', { min: 0, max: 2000 })),
      fChk(d, 'restoreFocus', 'Give focus back to the previous window afterwards'),
      h('div', { class: 'section-title' }, 'Telemetry'),
      fNum(d, 'telemetryHz', 'Updates per second', { min: 1, max: 30 }),
    ],
    foot: (c) => [h('button', { type: 'button', onclick: c }, 'Cancel'), h('button', {
      type: 'button', class: 'primary', onclick: () => {
        const pinChanged = (d.pin || '') !== (S.config.settings.pin || '');
        S.config.settings = d;
        saveConfig();
        if (pinChanged) { prefs.pin = d.pin || ''; savePrefs(); }
        c(); toast('Settings saved', 'ok');
      },
    }, 'Save')],
  });
}

function openLogSheet() {
  const list = h('div', { class: 'log-list' });
  const draw = () => list.replaceChildren(...(S.log.length ? logRows(250) : [h('div', { class: 'muted', style: 'padding:14px' }, 'Empty')]));
  draw();
  let ver = S.logVer;
  const upd = () => { if (ver !== S.logVer) { ver = S.logVer; draw(); } };
  sheetDyn.add(upd);
  openSheet({
    title: 'Command log', flush: true, body: list,
    foot: (c) => [h('button', { type: 'button', class: 'danger', onclick: () => send({ t: 'clearLog' }) }, 'Clear'), h('button', { type: 'button', onclick: c }, 'Close')],
    onClose: () => sheetDyn.delete(upd),
  });
}

function openImportExport() {
  const ta = h('textarea', { spellcheck: 'false', value: JSON.stringify({ ...S.config, settings: { ...S.config.settings, pin: '' } }, null, 2) });
  openSheet({
    title: 'Import / export layout', wide: true,
    body: [
      h('p', { class: 'hint' }, 'Copy this JSON to back up or share your board (the PIN is left out). Paste a layout and tap Import to replace the current one on every device.'),
      h('label', { class: 'field' }, h('span', {}, 'Layout JSON'), ta),
    ],
    foot: (c) => [
      h('button', { type: 'button', onclick: () => { ta.select(); navigator.clipboard?.writeText(ta.value).then(() => toast('Copied', 'ok'), () => document.execCommand('copy')); } }, 'Copy'),
      h('button', {
        type: 'button', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([ta.value], { type: 'application/json' })), download: 'race-control-layout.json' });
          a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
      }, 'Download'),
      h('button', {
        type: 'button', class: 'primary', onclick: () => {
          let cfg;
          try { cfg = JSON.parse(ta.value); } catch (e) { return toast(`Invalid JSON: ${e.message}`, 'bad'); }
          if (!Array.isArray(cfg.pages)) return toast('Layout must have a "pages" array', 'bad');
          cfg.settings = { ...S.config.settings, ...(cfg.settings || {}), pin: S.config.settings.pin };
          S.config = cfg; saveConfig(); renderAll(); c(); toast('Layout imported', 'ok');
        },
      }, 'Import'),
    ],
  });
}

/* =====================================================================================
 * Layout editing
 * ===================================================================================*/
function editOverlay(item, cell) {
  const handle = h('span', { class: 'handle', title: 'Drag to move' }, '⠿');
  handle.addEventListener('pointerdown', (e) => startDrag(e, item, cell, handle));
  handle.addEventListener('click', (e) => e.stopPropagation());
  return h('div', { class: 'edit-overlay', onclick: () => openItemEditor(item) }, handle, h('span', { class: 'gear' }, '✎'));
}

function startDrag(e, item, cell, handle) {
  e.preventDefault();
  e.stopPropagation();
  handle.setPointerCapture(e.pointerId);
  const board = $('#board');
  const startX = e.clientX, startY = e.clientY, startScroll = board.scrollTop;
  const cells = [...board.querySelectorAll('.cell')].filter((c) => c !== cell);
  let over = null, lastY = startY, scrollTimer = null;
  cell.classList.add('dragging');

  const findOver = (x, y) => cells.find((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) || null;
  const position = (x, y) => {
    cell.style.transform = `translate(${x - startX}px, ${y - startY + board.scrollTop - startScroll}px)`;
    const t = findOver(x, y);
    if (t !== over) { over?.classList.remove('drop-target'); over = t; over?.classList.add('drop-target'); }
  };
  const move = (ev) => {
    lastY = ev.clientY;
    position(ev.clientX, ev.clientY);
    const r = board.getBoundingClientRect();
    clearInterval(scrollTimer);
    const dir = ev.clientY < r.top + 60 ? -1 : ev.clientY > r.bottom - 60 ? 1 : 0;
    if (dir) scrollTimer = setInterval(() => { board.scrollTop += dir * 12; position(ev.clientX, lastY); }, 16);
  };
  const up = () => {
    clearInterval(scrollTimer);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    cell.classList.remove('dragging');
    cell.style.transform = '';
    over?.classList.remove('drop-target');
    if (over) {
      const items = currentPage().items;
      const from = items.findIndex((x) => x.id === item.id);
      const toAttr = over.dataset.index;
      const to = toAttr == null ? items.length - 1 : parseInt(toAttr, 10);
      if (from >= 0) {
        const [moved] = items.splice(from, 1);
        items.splice(Math.min(to, items.length), 0, moved);
        saveConfig();
      }
      renderBoard();
    }
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function addPage() {
  const d = { name: '' };
  openSheet({
    title: 'New page',
    body: [fText(d, 'name', 'Page name', { placeholder: 'e.g. Restarts' })],
    foot: (c) => [h('button', { type: 'button', onclick: c }, 'Cancel'), h('button', {
      type: 'button', class: 'primary', onclick: () => {
        const p = { id: uid(), name: d.name.trim() || 'Page', columns: { narrow: 3, wide: 6 }, items: [] };
        S.config.pages.push(p);
        prefs.page = p.id; savePrefs();
        saveConfig(); renderTabs(); renderBoard(); c();
      },
    }, 'Add')],
  });
}

function openPageEditor(page) {
  const d = { name: page.name, narrow: page.columns?.narrow ?? 3, wide: page.columns?.wide ?? 6 };
  const ps = S.config.pages;
  const isSheet = page.id === DRIVER_SHEET_ID;
  const move = (dir, c) => {
    const i = ps.indexOf(page), j = i + dir;
    if (j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    saveConfig(); renderTabs(); c();
  };
  openSheet({
    title: isSheet ? 'Driver popup' : 'Page settings',
    body: [
      isSheet ? h('p', { class: 'hint' }, 'These buttons appear when you tap a driver in a driver list. They act on that driver ({car}).') : fText(d, 'name', 'Name'),
      h('div', { class: 'row' },
        fNum(d, 'narrow', 'Columns on phone', { min: 1, max: 12 }),
        fNum(d, 'wide', 'Columns on tablet', { min: 1, max: 12 })),
      h('p', { class: 'hint' }, 'Item widths larger than the column count are clamped, so a width-6 item fills the row on a 3-column phone layout too.'),
    ],
    foot: (c) => [
      ...(isSheet ? [] : [
      h('button', { type: 'button', class: 'ghost', onclick: () => move(-1, c) }, '◀'),
      h('button', { type: 'button', class: 'ghost', onclick: () => move(1, c) }, '▶'),
      h('button', {
        type: 'button', class: 'danger', onclick: async () => {
          const ok = await openConfirm({ label: `Delete page "${page.name}"?`, color: '#b91c1c' }, [{ type: 'chat', text: `${page.items.length} item(s) will be removed` }]);
          if (!ok) return;
          S.config.pages = ps.filter((p) => p !== page);
          saveConfig(); renderTabs(); renderBoard(); c();
        },
      }, 'Delete')]),
      h('button', {
        type: 'button', class: 'primary', onclick: () => {
          if (!isSheet) page.name = d.name.trim() || 'Page';
          page.columns = { narrow: d.narrow || 3, wide: d.wide || 6 };
          saveConfig(); renderTabs(); renderBoard(); c();
        },
      }, 'Save'),
    ],
  });
}

// ---------- presets for "add item" ----------------------------------------------------
const chatBtn = (label, icon, color, text, extra = {}) => ({ type: 'button', label, icon, color, w: 1, h: 1, confirm: false, actions: [{ type: 'chat', text }], ...extra });
const camBtn = (label, icon, car, group) => ({ type: 'button', label, icon, color: '#0e7490', w: 1, h: 1, actions: [{ type: 'camera', mode: 'car', car, group, camera: 0 }] });
const replayBtn = (label, icon, a) => ({ type: 'button', label, icon, color: '#334155', w: 1, h: 1, actions: [{ type: 'replay', ...a }] });
const tile = (label, source, format, extra = {}) => ({ type: 'tile', label, source, format, w: 1, h: 1, ...extra });
const PRESETS = [
  ['Blank', [
    { type: 'button', label: 'Button', icon: '', color: '#334155', w: 1, h: 1, actions: [] },
    { type: 'tile', label: 'Tile', source: '', format: 'auto', w: 1, h: 1 },
    { type: 'label', label: 'Section', w: 12, h: 1 },
  ]],
  ['Widgets', [
    { type: 'target', w: 12, h: 2, _desc: 'Target car card' },
    { type: 'drivers', w: 12, h: 8, sort: 'position', _desc: 'Driver list / picker' },
    { type: 'flag', w: 12, h: 2, _desc: 'Session flag' },
    { type: 'log', w: 12, h: 4, _desc: 'Command log' },
  ]],
  ['Race control', [
    chatBtn('Wave Around', '↻', '#2563eb', '!waveby #{car}'),
    chatBtn('End of Line', '⤓', '#7c3aed', '!eol #{car}'),
    chatBtn('Drive-Through', '⚑', '#1f2937', '!black #{car} D'),
    chatBtn('Stop & Hold', '⏱', '#1f2937', '!black #{car} {input:Seconds=10}'),
    chatBtn('Hold Laps', '⚑', '#1f2937', '!black #{car} L{input:Laps=1}'),
    chatBtn('Clear Penalty', '✓', '#059669', '!clear #{car}', { confirm: false }),
    chatBtn('Clear All', '✓✓', '#0d9488', '!clearall'),
    chatBtn('Disqualify', '✕', '#b91c1c', '!dq #{car}', { hold: true, confirm: true, sub: 'hold' }),
    chatBtn('Remove', '⏏', '#7f1d1d', '!remove #{car}', { hold: true, confirm: true, sub: 'hold' }),
    chatBtn('Caution', '⚠', '#eab308', '!yellow', { textColor: '#111111' }),
    chatBtn('Close Pits', '⛔', '#ea580c', '!pitclose'),
    chatBtn('Open Pits', '⇥', '#16a34a', '!pitopen'),
    chatBtn('Pace Laps', '#', '#475569', '!pacelaps {input:Laps=2}'),
    chatBtn('Advance', '⏭', '#9333ea', '!advance', { hold: true, confirm: true }),
    chatBtn('Message', '✉', '#475569', '{input:Message}', { confirm: false }),
    chatBtn('Mute Driver', '🔇', '#475569', '!nchat #{car}'),
    chatBtn('Unmute Driver', '🔈', '#475569', '!chat #{car}', { confirm: false }),
    { type: 'button', label: 'Chat Macro', icon: 'M', color: '#475569', w: 1, h: 1, actions: [{ type: 'macro', n: 1 }] },
  ]],
  ['Camera & replay', [
    camBtn('Watch Car', '◉', '{car}', ''),
    camBtn('TV1', '📺', '{car}', 'TV1'),
    camBtn('Cockpit', '🎥', '{car}', 'Cockpit'),
    camBtn('Chase', '🎥', '{car}', 'Chase'),
    camBtn('Leader', '①', 'leader', ''),
    camBtn('Incident', '💥', 'incident', ''),
    replayBtn('Prev Incident', '⏮', { op: 'search', mode: 'prevIncident' }),
    replayBtn('Next Incident', '⏭', { op: 'search', mode: 'nextIncident' }),
    replayBtn('Pause', '⏸', { op: 'pause' }),
    replayBtn('Play', '▶', { op: 'play' }),
    replayBtn('Rewind', '⏪', { op: 'speed', speed: -4, slow: false }),
    replayBtn('Fast Fwd', '⏩', { op: 'speed', speed: 4, slow: false }),
    replayBtn('Slow-mo', '🐢', { op: 'speed', speed: 2, slow: true }),
    replayBtn('Prev Lap', '↶', { op: 'search', mode: 'prevLap' }),
    replayBtn('Next Lap', '↷', { op: 'search', mode: 'nextLap' }),
    replayBtn('Go Live', '●', { op: 'live' }),
  ]],
  ['Telemetry tiles', [
    tile('Laps Left', 'SessionLapsRemainEx', 'laps'),
    tile('Time Left', 'SessionTimeRemain', 'time'),
    tile('Session', '@sessionType', 'text'),
    tile('State', 'SessionState', 'sessionState'),
    tile('Pace Mode', 'PaceMode', 'paceMode'),
    tile('Leader Lap', '@leaderLap', 'int'),
    tile('On Pit Road', '@carsOnPitRoad', 'int'),
    tile('Cars', '@carsOnTrack', 'int'),
    tile('Incidents', '@totalIncidents', 'int', { suffix: 'x' }),
    tile('On Camera', '@camCar', 'text', { w: 2 }),
    tile('Air', 'AirTemp', 'float', { decimals: 1, suffix: '°C' }),
    tile('Track', 'TrackTempCrew', 'float', { decimals: 1, suffix: '°C' }),
    tile('Target Pos', 'CarIdxPosition[target]', 'position'),
    tile('Target Last', 'CarIdxLastLapTime[target]', 'laptime'),
    tile('Target Best', 'CarIdxBestLapTime[target]', 'laptime'),
    tile('Target Inc', '@targetIncidents', 'text', { suffix: 'x' }),
    tile('Track Pos', 'CarIdxLapDistPct[target]', 'pct'),
  ]],
];
const TYPE_NAMES = { button: 'Button', tile: 'Telemetry tile', drivers: 'Driver list', target: 'Target car', flag: 'Flag', log: 'Command log', label: 'Section label' };

function openAddItem() {
  const body = [];
  for (const [group, list] of PRESETS) {
    body.push(h('div', { class: 'preset-group' }, group));
    body.push(h('div', { class: 'preset-grid' }, list.map((p) => {
      const pick = () => {
        close();
        const item = clone(p);
        delete item._desc;
        item.id = uid();
        openItemEditor(item, true);
      };
      if (p.type === 'button') {
        return h('button', { type: 'button', class: 'btn', style: `--c:${p.color};--fg:${p.textColor || '#fff'}`, onclick: pick },
          p.icon ? h('span', { class: 'btn-icon' }, p.icon) : null, h('span', { class: 'btn-label' }, p.label));
      }
      return h('button', { type: 'button', class: 'pbox', onclick: pick }, p.label || TYPE_NAMES[p.type], h('small', {}, p._desc || (p.source ? p.source : TYPE_NAMES[p.type])));
    })));
  }
  const close = openSheet({ title: 'Add to page', body, wide: true });
}

// ---------- item editor ---------------------------------------------------------------
const ACTION_TYPES = [['chat', 'Chat / admin command'], ['camera', 'Camera'], ['replay', 'Replay'], ['macro', 'Chat macro (1-15)'], ['delay', 'Wait'], ['broadcast', 'Raw SDK broadcast']];
const ACTION_DEFAULTS = {
  chat: { text: '' }, macro: { n: 1 }, camera: { mode: 'car', car: '{car}', group: '', camera: 0 },
  replay: { op: 'play' }, broadcast: { msg: 0, var1: 0, var2: 0 }, delay: { ms: 250 },
};
const REPLAY_SEARCH = [['prevIncident', 'Previous incident'], ['nextIncident', 'Next incident'], ['prevLap', 'Previous lap'], ['nextLap', 'Next lap'], ['prevFrame', 'Previous frame'], ['nextFrame', 'Next frame'], ['prevSession', 'Previous session'], ['nextSession', 'Next session'], ['toStart', 'To start'], ['toEnd', 'To end']];

function actionsEditor(draft) {
  draft.actions = draft.actions || [];
  const wrap = h('div');
  const draw = () => {
    wrap.replaceChildren(
      ...draft.actions.map((a, i) => actionCard(a, i)),
      h('button', { type: 'button', class: 'pill-btn', style: 'width:100%', onclick: () => { draft.actions.push(clone(ACTION_DEFAULTS.chat)); draft.actions.at(-1).type = 'chat'; draw(); } }, '+ Add action'),
    );
  };
  const actionCard = (a, i) => {
    const body = h('div');
    const drawBody = () => body.replaceChildren(...actionFields(a, drawBody));
    drawBody();
    return h('div', { class: 'action-card' },
      h('div', { class: 'a-head' },
        h('select', {
          onchange: (e) => { draft.actions[i] = { type: e.target.value, ...clone(ACTION_DEFAULTS[e.target.value]) }; draw(); },
        }, ACTION_TYPES.map(([v, l]) => h('option', { value: v, selected: a.type === v }, l))),
        h('button', { type: 'button', class: 'mini', title: 'Move up', onclick: () => { if (i > 0) { [draft.actions[i - 1], draft.actions[i]] = [draft.actions[i], draft.actions[i - 1]]; draw(); } } }, '↑'),
        h('button', { type: 'button', class: 'mini', title: 'Move down', onclick: () => { if (i < draft.actions.length - 1) { [draft.actions[i + 1], draft.actions[i]] = [draft.actions[i], draft.actions[i + 1]]; draw(); } } }, '↓'),
        h('button', { type: 'button', class: 'mini', title: 'Remove', onclick: () => { draft.actions.splice(i, 1); draw(); } }, '✕')),
      body);
  };
  draw();
  return wrap;
}

function actionFields(a, redraw) {
  switch (a.type) {
    case 'chat':
      return [fText(a, 'text', 'Text to send', { list: 'chatList', placeholder: '!waveby #{car}' },
        'Tokens: {car} {name} {team} {pos} {class} · ask when pressed: {input:Seconds=10}')];
    case 'macro':
      return [fNum(a, 'n', 'Macro number', { min: 1, max: 15 })];
    case 'camera':
      return [
        fSel(a, 'mode', 'Focus', [['car', 'Car number'], ['position', 'Race position']], redraw),
        a.mode === 'position'
          ? fNum(a, 'position', 'Position', { min: 1, max: 64 })
          : fText(a, 'car', 'Car', {}, '{car} = target car, a number like 42, or leader / incident / exiting'),
        h('div', { class: 'row' },
          fText(a, 'group', 'Camera group', { list: 'camList', placeholder: '(keep current)' }),
          fNum(a, 'camera', 'Camera #', { min: 0, max: 20 })),
      ];
    case 'replay': {
      const out = [fSel(a, 'op', 'Replay command', [['play', 'Play'], ['pause', 'Pause'], ['speed', 'Set speed'], ['search', 'Jump'], ['live', 'Go live']], redraw)];
      if (a.op === 'speed') out.push(h('div', { class: 'row' }, fNum(a, 'speed', 'Speed (negative = rewind)', { min: -16, max: 16 }), h('div', { class: 'field' }, h('span', {}, ' '), fChk(a, 'slow', 'Slow-motion (1/speed)'))));
      if (a.op === 'search') { a.mode = a.mode || 'nextIncident'; out.push(fSel(a, 'mode', 'Jump to', REPLAY_SEARCH)); }
      return out;
    }
    case 'delay':
      return [fNum(a, 'ms', 'Milliseconds', { min: 0, max: 10000, step: 50 })];
    case 'broadcast':
      return [h('div', { class: 'row' }, fNum(a, 'msg', 'Msg'), fNum(a, 'var1', 'var1'), fNum(a, 'var2', 'var2'), fNum(a, 'var3', 'var3 (opt)')),
        h('p', { class: 'hint' }, 'Sends irsdk_broadcastMsg(msg, var1, var2[, var3]) directly — see the iRacing SDK docs.')];
  }
  return [];
}

function openItemEditor(item, isNew = false) {
  const draft = clone(item);
  const page = currentPage();
  const body = h('div');
  let jsonMode = false;
  const cols = pageCols(page);

  const draw = () => {
    if (jsonMode) {
      const ta = h('textarea', { spellcheck: 'false', value: JSON.stringify(draft, null, 2), oninput: (e) => { try { const v = JSON.parse(e.target.value); Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, v); ta.style.borderColor = ''; } catch { ta.style.borderColor = 'var(--bad)'; } } });
      body.replaceChildren(h('label', { class: 'field' }, h('span', {}, 'Item JSON'), ta));
      return;
    }
    const f = [];
    const size = h('div', { class: 'row' },
      fNum(draft, 'w', `Width (cols, this page has ${cols})`, { min: 1, max: 12 }),
      fNum(draft, 'h', 'Height (rows)', { min: 1, max: 20 }));
    switch (draft.type) {
      case 'button':
        f.push(h('div', { class: 'row' }, fText(draft, 'label', 'Label'), fText(draft, 'icon', 'Icon (emoji / text)', { style: 'max-width:120px' })));
        f.push(fText(draft, 'sub', 'Small caption'));
        f.push(size);
        f.push(fColor(draft, 'color', 'Button colour'));
        f.push(fColor(draft, 'textColor', 'Text colour', { allowNone: true }));
        f.push(fChk(draft, 'confirm', 'Ask for confirmation (shows the exact command)'));
        f.push(fChk(draft, 'hold', 'Press and hold to fire (prevents accidental taps)'));
        f.push(h('div', { class: 'section-title' }, 'Actions (run in order)'));
        f.push(actionsEditor(draft));
        break;
      case 'tile':
        f.push(fText(draft, 'label', 'Label'));
        f.push(fText(draft, 'source', 'Telemetry source', { list: 'varList', placeholder: 'SessionLapsRemainEx' },
          'Any iRacing variable. Per-car arrays take an index: CarIdxPosition[target], [cam], [player] or [5]. Derived values start with @.'));
        f.push(h('div', { class: 'row' },
          fSel(draft, 'format', 'Format', Object.keys(FORMATS).map((k) => [k, k])),
          fNum(draft, 'decimals', 'Decimals', { min: 0, max: 6 }),
          fText(draft, 'suffix', 'Suffix')));
        f.push(size);
        f.push(fColor(draft, 'color', 'Accent colour', { allowNone: true }));
        break;
      case 'drivers':
        f.push(fSel(draft, 'sort', 'Default sort', [['position', 'Position'], ['running', 'Track order'], ['number', 'Car number'], ['incidents', 'Incidents'], ['name', 'Name']]));
        f.push(fSel(draft, 'tap', 'Tapping a driver', [['actions', 'Opens the driver popup'], ['select', 'Just selects them as target']]));
        f.push(fChk(draft, 'toggle', 'In select mode, tapping the selected driver clears the target'));
        f.push(size);
        break;
      case 'label':
        f.push(fText(draft, 'label', 'Text'));
        f.push(size);
        break;
      default:
        f.push(size);
    }
    body.replaceChildren(...f);
  };
  draw();

  const commit = () => {
    const items = page.items;
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = draft; else items.push(draft);
    saveConfig();
    renderBoard();
  };
  openSheet({
    title: `${isNew ? 'Add' : 'Edit'} ${TYPE_NAMES[draft.type] || draft.type}`,
    wide: true,
    body,
    foot: (c) => [
      h('button', { type: 'button', class: 'ghost', onclick: (e) => { jsonMode = !jsonMode; e.target.textContent = jsonMode ? 'Form' : '{ }'; draw(); } }, '{ }'),
      !isNew ? h('button', { type: 'button', class: 'danger', onclick: () => { page.items = page.items.filter((x) => x.id !== item.id); saveConfig(); renderBoard(); c(); } }, 'Delete') : null,
      !isNew ? h('button', { type: 'button', onclick: () => { const copy = clone(draft); copy.id = uid(); const i = page.items.findIndex((x) => x.id === item.id); page.items.splice(i + 1, 0, copy); saveConfig(); renderBoard(); c(); } }, 'Duplicate') : null,
      h('button', { type: 'button', onclick: c }, 'Cancel'),
      h('button', { type: 'button', class: 'primary', onclick: () => { commit(); c(); } }, isNew ? 'Add' : 'Save'),
    ],
  });
}

/* =====================================================================================
 * Boot
 * ===================================================================================*/
$('#menuBtn').addEventListener('click', openMenu);
$('#editBtn').addEventListener('click', () => setEdit(!S.edit));
$('#editDone').addEventListener('click', () => setEdit(false));
$('#targetChip').addEventListener('click', () => openPicker());
let lastWide = isWide();
window.addEventListener('resize', () => { if (isWide() !== lastWide) { lastWide = isWide(); renderBoard(); } });
new ResizeObserver(() => fitBoard()).observe($('#board'));
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS pinch-zoom
// URL overrides, handy for per-device bookmarks: ?layout=narrow&page=drivers&target=5
{
  const q = new URLSearchParams(location.search);
  if (['auto', 'narrow', 'wide'].includes(q.get('layout'))) prefs.layout = q.get('layout');
  if (q.get('page')) prefs.page = q.get('page');
  if (q.get('target') && !Number.isNaN(parseInt(q.get('target'), 10))) prefs.target = parseInt(q.get('target'), 10);
  savePrefs();
}
applyPrefs();
renderAll();
connect();
