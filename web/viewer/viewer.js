// M2 map viewer: loads a scan JSONL (server list or local file) and draws grid + points + trajectory.
import { parseScan } from '../common/jsonl.js';
import { DEFAULTS, PROFILES, buildGrid, classifyHeight, detectProfile, hitMargin } from '../common/grid.js';
import { TRAV, astar, simplifyPath, traversability } from '../common/trav.js';
import { View3D } from './view3d.js';

const params = new URLSearchParams(location.search);
const SERVER = (params.get('server') || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

const SLIDERS = ['floorMax', 'wallMin', 'wallMax', 'clearBelow', 'bodyRadius', 'maxRange'];
const PROFILE_KEYS = ['floorMax', 'wallMin', 'wallMax', 'clearBelow', 'bodyRadius'];
const ROUTE_COLOR = '#facc15';
const POINT_COLORS = { floor: '#3b82f6', wall: '#f97316', other: '#9ca3af' };

let scan = null; // { name, header, frames, skipped, stats }
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
async function loadServerList() {
  const box = $('scans');
  try {
    const res = await fetch(`${SERVER}/api/scans`);
    if (!res.ok) throw new Error(res.status);
    const list = await res.json();
    if (!list.length) {
      box.textContent = 'none uploaded yet';
      return;
    }
    box.replaceChildren(
      ...list.map((s) => {
        const b = document.createElement('button');
        b.dataset.id = s.id;
        b.innerHTML = `<div></div><div class="meta"></div>`;
        b.firstChild.textContent = s.id;
        b.lastChild.textContent = `${s.frames} frames · ${s.points} pts · ${s.created ? new Date(s.created).toLocaleString() : ''}`;
        b.onclick = () => loadFromServer(s.id);
        return b;
      }),
    );
  } catch {
    box.textContent = 'server not reachable: drop a file instead';
  }
}

async function loadFromServer(id) {
  try {
    const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    setScan(id, await res.text());
    document.querySelectorAll('#scans button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  } catch (err) {
    $('err').textContent = `Could not load ${id}: ${err.message}`;
  }
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => setScan(file.name, reader.result);
  reader.readAsText(file);
}

function setScan(name, text) {
  $('err').textContent = '';
  const parsed = parseScan(text);
  if (!parsed.frames.length) {
    $('err').textContent = `${name}: no frames found${parsed.header ? '' : ' (and no header)'}`;
    return;
  }
  scan = { name, ...parsed };
  detected = detectProfile(scan.frames);
  route = { a: null, b: null, path: null, info: '' };
  const r = (params.get('route') || '').split(',').map(Number); // ?route=ax,az,bx,bz
  if (r.length === 4 && r.every(isFinite)) route = { a: [r[0], r[1]], b: [r[2], r[3]], path: null, info: '' };
  applyProfile();
  rebuild();
  fit();
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
  gridImage = grid ? renderGridImage(grid) : null;
  trav = grid ? traversability(grid) : null;
  travImage = trav ? renderTravImage(grid, trav) : null;
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
    if (grid) view3d.setMap(grid, trav);
  }
  return view3d;
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
  if (!route.a || route.b) route = { a: pt, b: null, path: null, info: '' };
  else route.b = pt;
  computeRoute();
  draw();
}

function drawDebug(r) {
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
$('profile').addEventListener('change', () => {
  applyProfile();
  rebuild();
});
window.addEventListener('resize', resize);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (grid) gridImage = renderGridImage(grid);
  if (trav) travImage = renderTravImage(grid, trav);
  if (view3d) {
    view3d.applyTheme();
    if (grid) view3d.setMap(grid, trav);
  }
  draw();
});

resize();
loadServerList();
if (params.get('scan')) loadFromServer(params.get('scan'));
