// M2 map viewer: loads a scan JSONL (server list or local file) and draws grid + points + trajectory.
import { parseScan } from '../common/jsonl.js';
import { DEFAULTS, PROFILES, buildGrid, classifyHeight, detectProfile, hitMargin } from '../common/grid.js';
import { TRAV, astar, simplifyPath, traversability } from '../common/trav.js';
import { View3D } from './view3d.js';
import { mergeMap } from '../common/chain.js';
import { floorColors } from './floorcolor.js';

const params = new URLSearchParams(location.search);
const SERVER = (params.get('server') || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

const SLIDERS = ['floorMax', 'wallMin', 'wallMax', 'clearBelow', 'bodyRadius', 'maxRange'];
const PROFILE_KEYS = ['floorMax', 'wallMin', 'wallMax', 'clearBelow', 'bodyRadius'];
const ROUTE_COLOR = '#facc15';
const POINT_COLORS = { floor: '#3b82f6', wall: '#f97316', other: '#9ca3af' };

let scan = null; // { name, header, frames, keyframes, labels, skipped, serverId }
let serverScans = []; // summaries from /api/scans (incl. continues/chain links, simulated)
let serverMaps = []; // from /api/maps: [{ id, name, scans, links, simulated, updated }]
let kind = 'real'; // 'real' | 'sim': real and simulated data are listed completely separately
let currentMap = null; // the map being shown, or null for a single scan
const texts = new Map(); // scan id -> JSONL text (cache)
let labelKey = null; // server id whose viewer-added labels apply (the scan, or the map)
let viewerLabels = []; // labels added in the viewer: [{ name, p: [x, y, z] }] in labelKey's coordinates
let addingLabel = false;
let kfImages = null; // Map "scan/img" -> ImageData, loaded once per scan/map for the photo floor
let photoFloor = null; // RGBA per grid cell, or null
let grid = null;
let gridImage = null;
let trav = null;
let travImage = null;
let view3d = null; // 3D Map view, created the first time Map mode is shown
let mode = 'map'; // 'map' | 'debug'
let detected = null; // { profile, phoneHeight } from detectProfile
let route = { a: null, b: null, path: null, info: '' }; // a/b are world [x, z]
let view = { s: 80, ox: 0, oy: 0 }; // px per meter, screen offset (CSS px)

// ---- loading ----
async function loadLists() {
  try {
    const [scansRes, mapsRes] = await Promise.all([fetch(`${SERVER}/api/scans`), fetch(`${SERVER}/api/maps`)]);
    if (!scansRes.ok) throw new Error(scansRes.status);
    serverScans = await scansRes.json();
    serverMaps = mapsRes.ok ? await mapsRes.json() : [];
  } catch {
    $('scans').textContent = 'server not reachable: drop a file instead';
    serverScans = serverMaps = [];
  }
  renderLists();
}

const ofKind = (list) => list.filter((x) => !!x.simulated === (kind === 'sim'));

function renderLists() {
  for (const b of document.querySelectorAll('#kindTabs button')) b.classList.toggle('active', b.dataset.kind === kind);
  // Map picker
  const maps = ofKind(serverMaps);
  $('mapSelect').replaceChildren(
    ...(!maps.length
      ? [Object.assign(document.createElement('option'), { value: '', textContent: 'no maps yet' })]
      : !currentMap
        ? [Object.assign(document.createElement('option'), { value: '', textContent: '— single scan —' })]
        : []),
    ...maps.map((m) =>
      Object.assign(document.createElement('option'), {
        value: m.id,
        textContent: `${m.name} · ${m.scans.length} scan${m.scans.length > 1 ? 's' : ''}`,
      }),
    ),
  );
  if (currentMap && maps.some((m) => m.id === currentMap.id)) $('mapSelect').value = currentMap.id;
  else if (!currentMap) $('mapSelect').value = '';
  $('renameMap').disabled = !currentMap;
  // Single scans
  const box = $('scans');
  const list = ofKind(serverScans);
  if (!list.length) {
    box.textContent = kind === 'sim' ? 'no simulated scans' : 'no real scans uploaded yet';
    return;
  }
  box.replaceChildren(
    ...list.map((sc) => {
      const b = document.createElement('button');
      b.dataset.id = sc.id;
      b.innerHTML = `<div><span class="sid"></span> <span class="badge"></span></div><div class="meta"></div>`;
      b.querySelector('.sid').textContent = sc.id;
      const badge = b.querySelector('.badge');
      badge.textContent = sc.simulated ? 'SIMULATED' : `REAL${sc.device && sc.device !== 'unknown' ? ' · ' + sc.device : ''}`;
      badge.classList.add(sc.simulated ? 'sim' : 'real');
      b.lastChild.textContent = `${sc.continues ? '↪ ' + sc.continues + ' · ' : ''}${sc.frames} frames · ${sc.points} pts · ${sc.created ? new Date(sc.created).toLocaleString() : ''}`;
      b.classList.toggle('active', !currentMap && scan?.name === sc.id);
      b.onclick = () => loadFromServer(sc.id);
      return b;
    }),
  );
}

async function fetchText(id) {
  if (!texts.has(id)) {
    const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`${id}: ${res.status}`);
    texts.set(id, await res.text());
  }
  return texts.get(id);
}

// One scan on its own (its own coordinates).
async function loadFromServer(id) {
  try {
    const text = await fetchText(id);
    currentMap = null;
    $('chain').hidden = true;
    labelKey = id;
    setScan(id, text, id);
    loadViewerLabels();
    renderLists();
  } catch (err) {
    $('err').textContent = `Could not load ${id}: ${err.message}`;
  }
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    labelKey = null; // local file: viewer labels can't be saved
    viewerLabels = [];
    setScan(file.name, reader.result);
    renderLabels();
    currentMap = null;
    $('chain').hidden = true;
    renderLists();
  };
  reader.readAsText(file);
}

function setScan(name, text, serverId = null) {
  setParsed(name, { ...parseScan(text), serverId });
}

// keepView: re-render in place (used while nudging a chain) instead of resetting route + camera.
const isSimulated = (h) => !!h && (h.simulated || h.device === 'synthetic');

function setParsed(name, parsed, { keepView = false } = {}) {
  $('err').textContent = '';
  const chip = $('dataKind');
  const sim = isSimulated(parsed.header);
  chip.hidden = !parsed.header;
  chip.textContent = sim ? 'SIMULATED DATA' : `REAL SCAN${parsed.header?.device && parsed.header.device !== 'unknown' ? ' · ' + parsed.header.device : ''}`;
  chip.className = sim ? 'sim' : 'real';
  if (!parsed.frames.length) {
    $('err').textContent = `${name}: no frames found${parsed.header ? '' : ' (and no header)'}`;
    return;
  }
  scan = { name, ...parsed }; // parsed.serverId is set for a single scan from the server
  if (!keepView) {
    kfImages = null;
    photoFloor = null;
    setupPhotos();
  }
  // keepView (nudging a map): same photos, new positions; rebuild() re-projects the photo floor.
  else syncPhotos3d();
  detected = detectProfile(scan.frames);
  if (!keepView) {
    route = { a: null, b: null, path: null, info: '' };
    const r = (params.get('route') || '').split(',').map(Number); // ?route=ax,az,bx,bz
    if (r.length === 4 && r.every(isFinite)) route = { a: [r[0], r[1]], b: [r[2], r[3]], path: null, info: '' };
  }
  applyProfile();
  rebuild();
  if (!keepView) fit();
  renderLabels();
}

// ---- scan chains: scans started where the previous one ended ----
const NUDGE_KEY = 'iam-chain-nudges';
const loadNudges = () => {
  try {
    return JSON.parse(localStorage.getItem(NUDGE_KEY)) || {};
  } catch {
    return {};
  }
};
const saveNudges = (n) => {
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(n));
  } catch {}
};

// ---- maps: one location = one or more scans, placed by their "continues" links ----
// keepView: re-render in place (nudging) instead of resetting the camera/route.
async function openMap(id, { keepView = false } = {}) {
  const m = serverMaps.find((x) => x.id === id);
  if (!m) return;
  currentMap = m;
  $('mapNote').textContent = `loading ${m.scans.length} scan(s)…`;
  const list = [];
  for (const sid of m.scans) {
    list.push(await fetchText(sid));
    if (currentMap !== m) return; // another map/scan was opened meanwhile
  }
  const parsed = list.map(parseScan);
  // Nudges saved in the scan files (continues_nudge) are the defaults; this browser's slider tweaks win.
  const fileNudges = Object.fromEntries(parsed.filter((p) => p.header?.continues_nudge).map((p) => [p.header.session_id, p.header.continues_nudge]));
  const nudges = { ...fileNudges, ...loadNudges() };
  const merged = mergeMap(parsed, { refine: $('autoAlign').checked, nudges, links: m.links || {} });
  setParsed(m.name, { header: parsed[0].header, frames: merged.frames, keyframes: merged.keyframes, labels: merged.labels, skipped: 0 }, { keepView });
  if (labelKey !== m.id) {
    labelKey = m.id; // viewer labels for a map live under the map's id, in its coordinates
    loadViewerLabels();
  }
  $('mapNote').textContent = `${m.scans.length} scan(s) · last scanned ${new Date(m.updated).toLocaleString()}`;
  // Alignment panel: one entry per link (scan continuing another)
  $('chain').hidden = !merged.links.length;
  if (merged.links.length) {
    const keep = $('chainLink').value;
    $('chainList').textContent = merged.links.map((l) => `${l.parent} → ${l.id}`).join('\n');
    $('chainLink').replaceChildren(...merged.links.map((l) => Object.assign(document.createElement('option'), { value: l.id, textContent: `${l.parent} → ${l.id}` })));
    if (merged.links.some((l) => l.id === keep)) $('chainLink').value = keep;
    syncNudgeSliders();
    const nudged = (sid) => (nudges[sid] && (nudges[sid].yawDeg || nudges[sid].dx || nudges[sid].dz) ? ' + manual nudge' : '');
    $('chainInfo').textContent = merged.links
      .map((l) => {
        if (!l.refine) return `${l.id}: placed by floor mark${nudged(l.id)}`;
        if (l.refine.used) {
          const c = l.refine.correction;
          return `${l.id}: auto-aligned (${c.yawDeg}°, ${c.dx} m, ${c.dz} m)${nudged(l.id)}`;
        }
        return `${l.id}: kept floor-mark placement (${l.refine.reason})${nudged(l.id)}`;
      })
      .join('\n');
  }
  renderLists();
}

function syncNudgeSliders() {
  const id = $('chainLink').value;
  const fromFile = texts.has(id) ? parseScan(texts.get(id)).header?.continues_nudge : null;
  const n = loadNudges()[id] || fromFile || {};
  for (const [k, def] of [['nudgeYaw', 'yawDeg'], ['nudgeDx', 'dx'], ['nudgeDz', 'dz']]) {
    $(k).value = n[def] ?? 0;
    $(`${k}V`).textContent = $(k).value;
  }
}

let nudgeTimer = null;
function onNudge() {
  const all = loadNudges();
  all[$('chainLink').value] = { yawDeg: +$('nudgeYaw').value, dx: +$('nudgeDx').value, dz: +$('nudgeDz').value };
  saveNudges(all);
  for (const k of ['nudgeYaw', 'nudgeDx', 'nudgeDz']) $(`${k}V`).textContent = $(k).value;
  clearTimeout(nudgeTimer);
  if (currentMap) nudgeTimer = setTimeout(() => openMap(currentMap.id, { keepView: true }).catch(showChainErr), 120);
}

const showChainErr = (err) => ($('chainInfo').textContent = `Couldn't build the map: ${err.message}`);

// New map from existing scans (e.g. scanned before the app had map picking)
function showNewMapForm() {
  $('newMapForm').hidden = false;
  $('newMapName').value = '';
  const list = ofKind(serverScans).slice().sort((a, b) => ((a.created || '') < (b.created || '') ? -1 : 1));
  $('newMapScans').replaceChildren(
    ...list.map((sc) => {
      const l = document.createElement('label');
      l.innerHTML = '<input type="checkbox" /> <span></span>';
      l.querySelector('input').value = sc.id;
      l.querySelector('span').textContent = `${sc.id} · ${sc.created ? new Date(sc.created).toLocaleString() : ''}`;
      return l;
    }),
  );
  $('newMapName').focus();
}

async function createMap() {
  const name = $('newMapName').value.trim();
  const scans = [...document.querySelectorAll('#newMapScans input:checked')].map((i) => i.value);
  if (!name || !scans.length) return ($('mapNote').textContent = 'Give the map a name and tick at least one scan.');
  const res = await fetch(`${SERVER}/api/maps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, scans, chain_in_order: $('newMapChain').checked }),
  });
  if (!res.ok) return ($('mapNote').textContent = `Couldn't create the map: ${await res.text()}`);
  const { id } = await res.json();
  $('newMapForm').hidden = true;
  await loadLists();
  openMap(id).catch(showChainErr);
}

async function renameMap() {
  if (!currentMap) return;
  const name = (prompt('Map name:', currentMap.name) || '').trim();
  if (!name || name === currentMap.name) return;
  const res = await fetch(`${SERVER}/api/maps/${encodeURIComponent(currentMap.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return ($('mapNote').textContent = `Couldn't rename: ${await res.text()}`);
  const id = currentMap.id;
  await loadLists();
  currentMap = serverMaps.find((m) => m.id === id) || currentMap;
  if (scan) {
    scan.name = name;
    renderStats();
  }
  renderLists();
}

// Default view: ?scan= or ?map= if given, else the newest map of this kind, else its newest scan.
async function openDefault() {
  const maps = ofKind(serverMaps), scans = ofKind(serverScans);
  if (maps.length) return openMap(maps[0].id);
  if (scans.length) return loadFromServer(scans[0].id);
  scan = null;
  currentMap = null;
  draw();
}

// ---- grid ----
function opts() {
  const o = {};
  for (const k of SLIDERS) o[k] = parseFloat($(k).value);
  return o;
}

// Sets the profile-dependent sliders: the chosen profile, or the detected one on Auto.
function applyProfile() {
  const choice = $('profile').value;
  const name = choice === 'auto' ? detected?.profile ?? 'person' : choice;
  const prof = PROFILES[name];
  for (const k of PROFILE_KEYS) {
    $(k).value = prof[k];
    $(`${k}V`).textContent = $(k).value;
  }
  $('profileNote').textContent = detected
    ? `auto-detected: ${PROFILES[detected.profile].label} (phone ${detected.phoneHeight.toFixed(2)} m above floor)`
    : '';
}

function rebuild() {
  if (!scan) return;
  grid = buildGrid(scan.frames, opts());
  trav = grid ? traversability(grid) : null;
  gridImage = travImage = null; // 2D debug images are built on demand (drawDebug), not in Map mode
  if (photoFloor) recolorFloor(); // grid changed: re-project (images are cached)
  if (view3d && grid) view3d.setMap(grid, trav);
  computeRoute();
  renderStats();
  draw();
}

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// One pixel per cell; scaled up with smoothing off when drawn.
function renderGridImage(g) {
  const off = document.createElement('canvas');
  off.width = g.w;
  off.height = g.h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(g.w, g.h);
  const occ = hexToRgb(cssColor('--fg'));
  const free = hexToRgb(cssColor('--accent'));
  for (let i = 0; i < g.L.length; i++) {
    const l = g.L[i];
    if (l === 0) continue;
    const p = 1 / (1 + Math.exp(-l));
    const j = i * 4;
    if (p > 0.5) {
      img.data.set(occ, j);
      img.data[j + 3] = Math.round(255 * Math.min(1, (p - 0.5) * 2.2));
    } else {
      img.data.set(free, j);
      img.data[j + 3] = Math.round(90 * Math.min(1, (0.5 - p) * 2.2));
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}

function renderTravImage(g, t) {
  const off = document.createElement('canvas');
  off.width = g.w;
  off.height = g.h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(g.w, g.h);
  const accent = hexToRgb(cssColor('--accent'));
  const occ = hexToRgb(cssColor('--fg'));
  for (let i = 0; i < t.tier.length; i++) {
    const j = i * 4;
    if (t.tier[i] === TRAV.WALKED) {
      img.data.set(accent, j);
      img.data[j + 3] = 220;
    } else if (t.tier[i] === TRAV.SEEN) {
      img.data.set(accent, j);
      img.data[j + 3] = 70;
    } else if (t.occ[i]) {
      img.data.set(occ, j);
      img.data[j + 3] = 200;
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}

// ---- test route (A*) ----
function toCellIndex([x, z]) {
  const cx = Math.floor((x - grid.minX) / grid.cell), cz = Math.floor((z - grid.minZ) / grid.cell);
  if (cx < 0 || cz < 0 || cx >= grid.w || cz >= grid.h) return -1;
  return cz * grid.w + cx;
}

function computeRoute() {
  route.path = null;
  route.info = '';
  if (!grid || !route.a || !route.b) return;
  const a = toCellIndex(route.a), b = toCellIndex(route.b);
  if (a < 0 || b < 0 || !isFinite(trav.cost[a]) || !isFinite(trav.cost[b])) {
    route.info = 'that spot is blocked or unscanned: pick open floor';
    return;
  }
  const path = astar(trav.cost, grid.w, grid.h, a, b);
  if (!path) {
    route.info = 'no route through known-passable cells';
    return;
  }
  route.path = path;
  let len = 0, walkedLen = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1], q = path[i];
    const diag = (p % grid.w) !== (q % grid.w) && ((p / grid.w) | 0) !== ((q / grid.w) | 0);
    const d = (diag ? Math.SQRT2 : 1) * grid.cell;
    len += d;
    if (trav.tier[q] === TRAV.WALKED) walkedLen += d;
  }
  route.info = `route ${len.toFixed(1)} m, ${Math.round((100 * walkedLen) / (len || 1))}% on walked paths`;
}

function renderStats() {
  const f = scan.frames;
  const pts = f.reduce((n, fr) => n + (fr.pts?.length || 0), 0);
  const dpts = f.reduce((n, fr) => n + (fr.dpts?.length || 0), 0);
  const tracking = {};
  for (const fr of f) tracking[fr.tracking] = (tracking[fr.tracking] || 0) + 1;
  let len = 0;
  for (let i = 1; i < f.length; i++) len += Math.hypot(f[i].p[0] - f[i - 1].p[0], f[i].p[2] - f[i - 1].p[2]);
  const h = scan.header || {};
  const lines = [
    `file      ${scan.name}`,
    `device    ${h.device ?? '?'}`,
    `created   ${h.created ?? '?'}`,
    `frames    ${f.length}${scan.skipped ? `  (skipped ${scan.skipped} bad lines)` : ''}`,
    `duration  ${(f.at(-1).t ?? 0).toFixed(1)} s`,
    `path      ${len.toFixed(1)} m`,
    `points    ${pts} plane${dpts ? `  + ${dpts} depth` : '  (no depth in this scan)'}`,
    `tracking  ${Object.entries(tracking).map(([k, v]) => `${k}:${v}`).join(' ')}`,
  ];
  if (grid) {
    const c = grid.counts;
    if (trav) {
      const n = [0, 0, 0];
      trav.tier.forEach((v) => n[v]++);
      const m2 = grid.cell * grid.cell;
      lines.push(`walked    ${(n[TRAV.WALKED] * m2).toFixed(1)} m²  floor seen ${(n[TRAV.SEEN] * m2).toFixed(1)} m²`);
    }
    lines.push(
      `grid      ${grid.w}×${grid.h} @ ${grid.cell * 100} cm`,
      `extent    ${(grid.w * grid.cell).toFixed(1)} × ${(grid.h * grid.cell).toFixed(1)} m`,
      `hits      floor ${c.floor}  wall ${c.wall}  ignored ${c.ignored}`,
      `floor y   ${Math.min(...grid.floors).toFixed(2)} .. ${Math.max(...grid.floors).toFixed(2)} m (tracked)`,
    );
    if (c.floor + c.wall && c.wall / (c.floor + c.wall) < 0.05) {
      lines.push('', '⚠ almost no wall hits: phone tilted down,', '  or ARCore found no wall planes');
    }
  }
  $('stats').textContent = lines.join('\n');
}

// ---- drawing ----
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fit() {
  if (!grid) return;
  if (mode === 'map') return ensure3d().fit();
  const r = canvas.getBoundingClientRect();
  const wm = grid.w * grid.cell;
  const hm = grid.h * grid.cell;
  view.s = Math.min(r.width / wm, r.height / hm) * 0.92;
  view.ox = (r.width - wm * view.s) / 2 - grid.minX * view.s;
  view.oy = (r.height - hm * view.s) / 2 - grid.minZ * view.s;
  draw();
}

// World X/Z -> screen. +X right, +Z down, so forward (-Z) points up.
const sx = (x) => view.ox + x * view.s;
const sy = (z) => view.oy + z * view.s;

function draw() {
  $('routeInfo').textContent = route.info || (route.a ? 'click a destination' : 'click the map twice to test a route');
  if (mode === 'map') return sync3dRoute();
  const r = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  if (scan) drawDebug(r);
  drawScaleBar(r);
}

// ---- 3D map ----
function ensure3d() {
  if (!view3d) {
    view3d = new View3D($('view3d'), cssColor);
    view3d.onPick = (x, z) => addRoutePoint([x, z]);
    view3d.setFloorPlan($('floorPlan').checked);
    view3d.setFloorColors(photoFloor);
    if (grid) view3d.setMap(grid, trav);
    view3d.setLabels(allLabels());
    syncPhotos3d();
  }
  return view3d;
}

// ---- camera keyframes (textures branch) ----
// A photo's own scan: maps tag every keyframe with the scan it came from (names repeat across scans).
const kfScan = (kf) => kf.scan || scan?.serverId || null;
const kfKey = (kf) => `${kfScan(kf)}/${kf.img}`;
const kfUrl = (kf) => (kfScan(kf) ? `${SERVER}/api/scans/${encodeURIComponent(kfScan(kf))}/kf/${kf.img}` : null);

function setupPhotos() {
  const n = scan.keyframes?.length || 0;
  $('photos').hidden = !n;
  if (!n) {
    view3d?.setKeyframes(null);
    view3d?.setFloorColors(null);
    return;
  }
  $('photoFloor').checked = false;
  const loadable = scan.keyframes.some((kf) => kfScan(kf));
  $('photoNote').textContent = loadable
    ? `${n} photos${currentMap ? ' in this map' : ' in this scan'}`
    : `${n} photos listed, but images only load for scans opened from the server list`;
  $('photoFloor').disabled = !loadable;
  const zip = $('nerfLink');
  zip.hidden = !scan.serverId; // export is per scan (open a single scan to download it)
  if (scan.serverId) zip.href = `${SERVER}/api/scans/${encodeURIComponent(scan.serverId)}/nerfstudio.zip`;
  syncPhotos3d();
}

function syncPhotos3d() {
  if (!view3d || !scan) return;
  view3d.setKeyframes(scan.keyframes, kfUrl);
  view3d.showKeyframes($('showPhotos').checked);
}

async function loadKfImages() {
  if (kfImages) return kfImages;
  const out = new Map();
  let done = 0;
  const queue = [...scan.keyframes];
  const worker = async () => {
    for (let kf = queue.shift(); kf; kf = queue.shift()) {
      try {
        const res = await fetch(kfUrl(kf));
        if (!res.ok) throw new Error(res.status);
        const bmp = await createImageBitmap(await res.blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = c.getContext('2d');
        cx.drawImage(bmp, 0, 0);
        out.set(kfKey(kf), cx.getImageData(0, 0, bmp.width, bmp.height));
      } catch (err) {
        console.warn('photo', kf.img, err);
      }
      $('photoNote').textContent = `loading photos ${++done}/${scan.keyframes.length}…`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  kfImages = out;
  return out;
}

// Floor height at time t: the tracked floor of the nearest recorded frame.
function floorAt(t) {
  const f = scan.frames;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return grid.floors[lo];
}

function recolorFloor() {
  const t0 = performance.now();
  const kfs = scan.keyframes.map((kf) => ({ ...kf, image: kfImages.get(kfKey(kf)) }));
  photoFloor = floorColors(grid, trav, kfs, floorAt);
  let n = 0;
  for (let i = 3; i < photoFloor.length; i += 4) if (photoFloor[i]) n++;
  $('photoNote').textContent = `floor coloured from ${kfImages.size} photos: ${(n * grid.cell * grid.cell).toFixed(1)} m² (${(performance.now() - t0).toFixed(0)} ms)`;
  view3d?.setFloorColors(photoFloor);
}

async function togglePhotoFloor() {
  if ($('photoFloor').checked) {
    await loadKfImages();
    recolorFloor();
  } else {
    photoFloor = null;
    view3d?.setFloorColors(null);
    $('photoNote').textContent = `${scan.keyframes.length} photos in this scan`;
  }
  if (view3d && grid) view3d.setMap(grid, trav);
}

// Route in world coords: string-pulled cell path, exact clicked endpoints (the tube smooths it).
function routeWorldPoints() {
  if (!route.path) return null;
  const cells = simplifyPath(route.path, trav.cost, grid.w);
  const pts = cells.map((i) => [grid.minX + ((i % grid.w) + 0.5) * grid.cell, grid.minZ + (((i / grid.w) | 0) + 0.5) * grid.cell]);
  pts[0] = route.a;
  pts[pts.length - 1] = route.b;
  return pts;
}

function sync3dRoute() {
  if (view3d) view3d.setRoute(routeWorldPoints(), route.a, route.b);
}

function addRoutePoint(pt) {
  if (!grid) return;
  if (addingLabel) return placeLabel(pt);
  if (!route.a || route.b) route = { a: pt, b: null, path: null, info: '' };
  else route.b = pt;
  computeRoute();
  draw();
}

function drawDebug(r) {
  if ($('mapMode').value === 'trav') travImage ??= trav && renderTravImage(grid, trav);
  else gridImage ??= grid && renderGridImage(grid);
  const layerImage = $('mapMode').value === 'trav' ? travImage : gridImage;
  if ($('showGrid').checked && layerImage) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layerImage, sx(grid.minX), sy(grid.minZ), grid.w * grid.cell * view.s, grid.h * grid.cell * view.s);
  }

  if ($('showPts').checked) {
    const o = { ...DEFAULTS, ...opts() };
    const size = Math.max(1.5, Math.min(4, view.s * 0.025));
    for (const cls of ['other', 'floor', 'wall']) {
      ctx.fillStyle = POINT_COLORS[cls];
      ctx.globalAlpha = cls === 'wall' ? 0.8 : 0.45;
      for (const [i, f] of scan.frames.entries()) {
        const floor = grid ? grid.floors[i] : 0;
        for (const [hits, isDepth] of [[f.pts, false], [f.dpts, true]]) {
          for (const h of hits || []) {
            if (classifyHeight(h[1] - floor, o, hitMargin(f, h, isDepth, o)) !== cls) continue;
            ctx.fillRect(sx(h[0]) - size / 2, sy(h[2]) - size / 2, size, size);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  if ($('showTraj').checked) {
    ctx.strokeStyle = '#e11d48';
    ctx.lineWidth = 2;
    ctx.beginPath();
    scan.frames.forEach((f, i) => (i ? ctx.lineTo(sx(f.p[0]), sy(f.p[2])) : ctx.moveTo(sx(f.p[0]), sy(f.p[2]))));
    ctx.stroke();
    const last = scan.frames.at(-1);
    drawHeading(last);
  }

  drawRoute();
  drawStartMarker();
  drawLabels2d();
}

// ---- room labels ----
const allLabels = () => [
  ...(scan?.labels || []).map((l) => ({ ...l, source: 'scan' })),
  ...viewerLabels.map((l, i) => ({ ...l, source: 'viewer', index: i })),
];

async function loadViewerLabels() {
  viewerLabels = [];
  if (labelKey) {
    try {
      const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(labelKey)}/labels`);
      if (res.ok) viewerLabels = await res.json();
    } catch {}
  }
  renderLabels();
}

async function saveViewerLabels() {
  if (!labelKey) return ($('labelNote').textContent = 'Labels on a dropped file are not saved (open it from the server list).');
  try {
    const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(labelKey)}/labels`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(viewerLabels),
    });
    if (!res.ok) throw new Error(res.status);
  } catch (err) {
    $('labelNote').textContent = `Couldn't save labels: ${err.message}`;
  }
}

function placeLabel([x, z]) {
  addingLabel = false;
  $('addLabel').classList.remove('active');
  const name = (prompt('Name for this spot (e.g. 2101, Judging room):') || '').trim();
  if (!name) return;
  viewerLabels.push({ name: name.slice(0, 80), p: [Math.round(x * 1000) / 1000, 0, Math.round(z * 1000) / 1000] });
  renderLabels();
  saveViewerLabels();
}

// Route from point A (if set) or the start marker to a label.
function routeTo(l) {
  const from = route.a && !route.b ? route.a : [0, 0];
  route = { a: from, b: [l.p[0], l.p[2]], path: null, info: '' };
  computeRoute();
  draw();
  if (route.path) $('routeInfo').textContent = `to ${l.name}: ${route.info}`;
}

function renderLabels() {
  const list = allLabels();
  view3d?.setLabels(list);
  const box = $('labels');
  box.replaceChildren(
    ...list.map((l) => {
      const row = document.createElement('div');
      row.className = 'label-row';
      const name = document.createElement('span');
      name.textContent = l.name;
      name.title = l.source === 'scan' ? 'labelled while scanning' : 'added in the viewer';
      const go = Object.assign(document.createElement('button'), { textContent: 'Route here', type: 'button' });
      go.onclick = () => routeTo(l);
      row.append(name, go);
      if (l.source === 'viewer') {
        const del = Object.assign(document.createElement('button'), { textContent: '✕', type: 'button', title: 'Remove label' });
        del.onclick = () => {
          viewerLabels.splice(l.index, 1);
          renderLabels();
          saveViewerLabels();
        };
        row.append(del);
      }
      return row;
    }),
  );
  if (!list.length) box.textContent = 'No rooms labelled yet.';
  if (mode === 'debug') draw();
}

function drawLabels2d() {
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const l of allLabels()) {
    const x = sx(l.p[0]), y = sy(l.p[2]);
    const tw = ctx.measureText(l.name).width;
    ctx.fillStyle = cssColor('--accent');
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(x + 7, y - 9, tw + 10, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(l.name, x + 12, y + 0.5);
  }
  ctx.textBaseline = 'alphabetic';
}

// Heading arrow at the latest pose: rotate viewer forward (0,0,-1) by q, project to X/Z.
function drawHeading(f) {
  const [x, y, z, w] = f.q;
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  const n = Math.hypot(fx, fz) || 1;
  const L = 18;
  const px = sx(f.p[0]), py = sy(f.p[2]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + (fx / n) * L, py + (fz / n) * L);
  ctx.stroke();
  ctx.fillStyle = '#e11d48';
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fill();
}

function drawRoute() {
  const cellCenter = (i) => [grid.minX + ((i % grid.w) + 0.5) * grid.cell, grid.minZ + (((i / grid.w) | 0) + 0.5) * grid.cell];
  if (route.path) {
    ctx.strokeStyle = ROUTE_COLOR;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    route.path.forEach((i, k) => {
      const [x, z] = cellCenter(i);
      k ? ctx.lineTo(sx(x), sy(z)) : ctx.moveTo(sx(x), sy(z));
    });
    ctx.stroke();
  }
  for (const [pt, label] of [[route.a, 'A'], [route.b, 'B']]) {
    if (!pt) continue;
    ctx.fillStyle = ROUTE_COLOR;
    ctx.beginPath();
    ctx.arc(sx(pt[0]), sy(pt[1]), 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b2026';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, sx(pt[0]), sy(pt[1]) + 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }
}

function drawStartMarker() {
  const x = sx(0), y = sy(0), k = 8;
  ctx.strokeStyle = cssColor('--accent');
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k);
  ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k);
  ctx.stroke();
}

function drawScaleBar(r) {
  const meters = [0.1, 0.25, 0.5, 1, 2, 5, 10].find((m) => m * view.s >= 60) ?? 10;
  const len = meters * view.s;
  const x = 16, y = r.height - 20;
  ctx.strokeStyle = ctx.fillStyle = cssColor('--muted');
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 5);
  ctx.stroke();
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(meters >= 1 ? `${meters} m` : `${meters * 100} cm`, x + len + 6, y);
}

// ---- interaction ----
// Zoom by factor k around screen point (mx, my).
function zoomAt(mx, my, k) {
  view.ox = mx - (mx - view.ox) * k;
  view.oy = my - (my - view.oy) * k;
  view.s *= k;
  draw();
}

let drag = null;
const touches = new Map(); // pointerId -> {x, y}, for pinch zoom
let pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (touches.size === 2) {
    const [a, b] = [...touches.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    drag = null;
  } else if (touches.size === 1) {
    drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false };
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const r = canvas.getBoundingClientRect();
    zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, d / pinch.d);
    pinch.d = d;
    return;
  }
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
  view.ox = drag.ox + e.clientX - drag.x;
  view.oy = drag.oy + e.clientY - drag.y;
  draw();
});
canvas.addEventListener('pointercancel', (e) => {
  touches.delete(e.pointerId);
  pinch = null;
  drag = null;
});
canvas.addEventListener('pointerup', (e) => {
  touches.delete(e.pointerId);
  if (pinch) {
    if (touches.size < 2) pinch = null;
    return;
  }
  const click = drag && !drag.moved;
  drag = null;
  if (!click || !grid) return;
  const r = canvas.getBoundingClientRect();
  addRoutePoint([(e.clientX - r.left - view.ox) / view.s, (e.clientY - r.top - view.oy) / view.s]);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  zoomAt(mx, my, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
const zoomCenter = (k) => {
  const r = canvas.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, k);
};
$('zoomIn').onclick = () => (mode === 'map' ? ensure3d().zoom(1.4) : zoomCenter(1.4));
$('zoomOut').onclick = () => (mode === 'map' ? ensure3d().zoom(1 / 1.4) : zoomCenter(1 / 1.4));
$('zoomFit').onclick = fit;
$('topDown').onclick = () => ensure3d().topDown();
$('addLabel').onclick = () => {
  addingLabel = !addingLabel;
  $('addLabel').classList.toggle('active', addingLabel);
  $('labelNote').textContent = addingLabel ? 'Click the spot on the map (e.g. the doorway).' : '';
};
try {
  $('floorPlan').checked = localStorage.getItem('iam-floor-plan') === '1';
} catch {}
$('floorPlan').onchange = () => {
  try {
    localStorage.setItem('iam-floor-plan', $('floorPlan').checked ? '1' : '0');
  } catch {}
  if (view3d) {
    view3d.setFloorPlan($('floorPlan').checked);
    if (grid) view3d.setMap(grid, trav);
  }
};
$('showPhotos').onchange = () => view3d?.showKeyframes($('showPhotos').checked);
$('photoFloor').onchange = () => togglePhotoFloor().catch((e) => ($('photoNote').textContent = e.message));

// ---- Map / Debug mode (remembered) ----
function setMode(m) {
  mode = m === 'debug' ? 'debug' : 'map';
  document.body.classList.toggle('mode-map', mode === 'map');
  document.body.classList.toggle('mode-debug', mode === 'debug');
  if (mode === 'map') {
    const first = !view3d;
    ensure3d();
    if (first && grid) view3d.fit();
  } else {
    resize(); // the 2D canvas had no size while hidden
    if (grid) fit();
  }
  for (const b of document.querySelectorAll('#modeSwitch button')) b.classList.toggle('active', b.dataset.mode === mode);
  try {
    localStorage.setItem('iam-viewer-mode', mode);
  } catch {}
  draw();
}
for (const b of document.querySelectorAll('#modeSwitch button')) b.onclick = () => setMode(b.dataset.mode);
let savedMode = null;
try {
  savedMode = localStorage.getItem('iam-viewer-mode');
} catch {}
setMode(params.get('mode') || savedMode || 'map');
canvas.addEventListener('dblclick', fit);

const drop = $('drop');
drop.onclick = () => $('file').click();
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
document.addEventListener('drop', (e) => e.dataTransfer.files[0] && loadFile(e.dataTransfer.files[0]));

for (const k of SLIDERS) {
  const input = $(k), out = $(`${k}V`);
  input.value = DEFAULTS[k];
  out.textContent = input.value;
  input.addEventListener('input', () => {
    out.textContent = input.value;
    rebuild();
  });
}
for (const id of ['showGrid', 'showPts', 'showTraj', 'mapMode']) $(id).addEventListener('change', draw);
for (const b of document.querySelectorAll('#kindTabs button')) {
  b.onclick = () => {
    if (kind === b.dataset.kind) return;
    kind = b.dataset.kind;
    currentMap = null;
    renderLists();
    openDefault().catch(showChainErr);
  };
}
$('mapSelect').addEventListener('change', () => $('mapSelect').value && openMap($('mapSelect').value).catch(showChainErr));
$('renameMap').onclick = () => renameMap().catch(showChainErr);
$('newMap').onclick = showNewMapForm;
$('newMapCancel').onclick = () => ($('newMapForm').hidden = true);
$('newMapCreate').onclick = () => createMap().catch(showChainErr);
$('autoAlign').addEventListener('change', () => currentMap && openMap(currentMap.id, { keepView: true }).catch(showChainErr));
$('chainLink').addEventListener('change', syncNudgeSliders);
for (const k of ['nudgeYaw', 'nudgeDx', 'nudgeDz']) $(k).addEventListener('input', onNudge);
$('nudgeReset').addEventListener('click', () => {
  const all = loadNudges();
  delete all[$('chainLink').value];
  saveNudges(all);
  syncNudgeSliders();
  if (currentMap) openMap(currentMap.id, { keepView: true }).catch(showChainErr);
});
$('profile').addEventListener('change', () => {
  applyProfile();
  rebuild();
});
window.addEventListener('resize', resize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  gridImage = travImage = null; // rebuilt in the new colours on the next debug draw
  if (view3d) {
    view3d.applyTheme();
    if (grid) view3d.setMap(grid, trav);
  }
  draw();
});

resize();
loadLists().then(() => {
  const want = (x) => serverScans.find((sc) => sc.id === x) || serverMaps.find((m) => m.id === x);
  if (params.get('map') && want(params.get('map'))) {
    kind = serverMaps.find((m) => m.id === params.get('map')).simulated ? 'sim' : 'real';
    renderLists();
    return openMap(params.get('map'));
  }
  if (params.get('scan') && want(params.get('scan'))) {
    kind = serverScans.find((sc) => sc.id === params.get('scan')).simulated ? 'sim' : 'real';
    renderLists();
    return loadFromServer(params.get('scan'));
  }
  return openDefault();
});
