// M5 nav app: pick a map, a start mark and a destination; preview the route on a 2D map (the whole
// app on phones without WebXR AR); then follow AR arrows on the floor. The walk can be recorded
// like a scan and joins the map once uploaded (it continues the start mark's scan).
import * as THREE from '../vendor/three.module.min.js';
import { APP_VERSION, parseScan, r3, toLine } from '../common/jsonl.js';
import { mergeMap } from '../common/chain.js';
import { FloorTracker } from '../common/floor.js';
import { DEPTH_COLS, DEPTH_MAX, DEPTH_MIN, DEPTH_ROWS, sampleDepth } from '../common/depth.js';
import { NAV, apply, buildNavMap, headingOf, invert, nextTurn, planRoute, progressOn, sessionToMap, stepsText, turnList } from './navcore.js';
import { Map2D } from './map2d.js';
import * as store from '../scan/store.js';

// ---- config ----
const RECORD_HZ = 10; // same as the scan app, so a nav walk is an ordinary scan
const FLUSH_EVERY_FRAMES = 20;
const FAN_HALF_ANGLE_DEG = 35;
const FAN_YAW_STEPS = 7;
const FAN_PITCHES_DEG = [0, -10, -20, -30];
const DEPTH_EVERY = 2;
const DEPTH_MAX_MS = 25;
const ARROW_SPACING = 0.7; // m between floor chevrons
const ARROWS_AHEAD = 12; // m of route drawn ahead of the walker
const ARROWS_BEHIND = 1;
const MAX_ARROWS = Math.ceil((ARROWS_AHEAD + ARROWS_BEHIND) / ARROW_SPACING) + 2;
const LOOK_AHEAD = 2.5; // m: the banner arrow points at the route this far ahead
const REPLAN_EVERY_S = 3;
const NUDGE_DEG = 2;
const NUDGE_M = 0.2;

const params = new URLSearchParams(location.search);
const SERVER = (params.get('server') || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const ui = {
  mapPick: $('mapPick'),
  startPick: $('startPick'),
  destPick: $('destPick'),
  routeInfo: $('routeInfo'),
  steps: $('steps'),
  msg: $('msg'),
  startAr: $('startAr'),
  record: $('recordToggle'),
  saved: $('saved'),
  fit: $('fitBtn'),
  banner: $('banner'),
  arrow: $('arrow'),
  turnText: $('turnText'),
  info: $('info'),
  here: $('here'),
  nudges: $('nudges'),
  stop: $('stop'),
};

function say(text, kind = '') {
  ui.msg.textContent = text;
  ui.msg.className = kind;
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

// ---- loading a map ----
let maps = [];
let mapInfo = null; // the /api/maps entry
let scans = []; // parsed scans of that map
let nav = null; // buildNavMap result
let route = null; // { pts, turns, cum, length, walkedPct, dest }
let dest = null; // { name, p: [x, z] }
let pin = null; // a destination dropped on the 2D map

const map2d = new Map2D($('map'), {
  onTap: (p) => {
    pin = { name: 'Dropped pin', p };
    renderDestPick('pin');
    pickDest();
  },
});

async function loadMaps() {
  const res = await fetch(`${SERVER}/api/maps`);
  if (!res.ok) throw new Error(`maps: ${res.status}`);
  maps = await res.json();
  const sim = params.get('sim') === '1'; // ?sim=1 lists simulated maps (for testing off-site)
  maps = maps.filter((m) => !!m.simulated === sim);
  ui.mapPick.replaceChildren(...maps.map((m) => Object.assign(document.createElement('option'), { value: m.id, textContent: `${m.name} (${m.scans.length} scans)` })));
  const want = params.get('map');
  if (want && maps.some((m) => m.id === want)) ui.mapPick.value = want;
  if (!maps.length) {
    ui.routeInfo.textContent = sim ? 'no simulated maps on the server' : 'no maps on the server yet: scan one first (or ?sim=1 for simulated ones)';
    return;
  }
  await openMap(ui.mapPick.value);
}

async function openMap(id) {
  const m = maps.find((x) => x.id === id);
  if (!m) return;
  mapInfo = m;
  nav = route = dest = pin = null;
  map2d.setMap(null);
  ui.routeInfo.textContent = `loading ${m.scans.length} scan(s)…`;
  const texts = [];
  for (const sid of m.scans) {
    const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(sid)}`);
    if (!res.ok) throw new Error(`scan ${sid}: ${res.status}`);
    texts.push(await res.text());
    if (mapInfo !== m) return; // another map was picked meanwhile
  }
  let viewerLabels = [];
  try {
    const res = await fetch(`${SERVER}/api/scans/${encodeURIComponent(m.id)}/labels`);
    if (res.ok) viewerLabels = await res.json();
  } catch {}
  ui.routeInfo.textContent = 'building the map…';
  await new Promise((r) => setTimeout(r, 30)); // let the message paint before the heavy part
  scans = texts.map(parseScan);
  // Nudges saved in the scan files are the map's alignment (the viewer's are per-browser).
  const nudges = Object.fromEntries(scans.filter((s) => s.header?.continues_nudge).map((s) => [s.header.session_id, s.header.continues_nudge]));
  const merged = mergeMap(scans, { nudges, links: m.links || {} });
  const t0 = performance.now();
  nav = buildNavMap(scans, merged, viewerLabels.map((l) => ({ ...l, source: 'viewer' })), { profile: params.get('profile') || 'auto' });
  if (!nav) {
    ui.routeInfo.textContent = 'this map has no usable frames';
    return;
  }
  console.log(`nav map ${nav.grid.w}x${nav.grid.h} in ${(performance.now() - t0).toFixed(0)} ms`);
  map2d.setMap(nav);
  ui.startPick.replaceChildren(
    ...nav.marks.map((mk) => Object.assign(document.createElement('option'), { value: mk.id, textContent: mk.hint ? `${mk.name} · ${mk.hint}` : mk.name })),
  );
  // Default start: ?start=<mark id or room name, e.g. 304>, else the first room, else the newest
  // end mark (where the latest scan stopped), else the map start marker.
  const ws = params.get('start');
  const want = ws && nav.marks.find((mk) => mk.id === ws || mk.name === ws || mk.name === `Room ${ws}`);
  ui.startPick.value = (want || nav.marks.find((mk) => mk.kind === 'room') || nav.marks.at(-1)).id;
  renderDestPick(params.get('dest'));
  pickDest();
}

function destinations() {
  const out = nav.labels.map((l, i) => ({ key: `label:${i}`, name: l.name, p: [l.p[0], l.p[2]] }));
  for (const mk of nav.marks) if (mk.kind !== 'room') out.push({ key: `mark:${mk.id}`, name: mk.name, p: mk.p }); // rooms are listed as labels already
  if (pin) out.push({ key: 'pin', name: pin.name, p: pin.p });
  return out;
}

function renderDestPick(select) {
  const list = destinations();
  ui.destPick.replaceChildren(...list.map((d) => Object.assign(document.createElement('option'), { value: d.key, textContent: d.name })));
  const byName = select && list.find((d) => d.key === select || d.name === select);
  // Default: a room other than the one we start at, else any other place.
  const from = startMark();
  const away = (d) => !from || Math.hypot(d.p[0] - from.p[0], d.p[1] - from.p[1]) > 2;
  ui.destPick.value = byName ? byName.key : list.find((d) => d.key.startsWith('label:') && away(d))?.key ?? list.find(away)?.key ?? list[0]?.key;
}

const startMark = () => nav?.marks.find((mk) => mk.id === ui.startPick.value) || null;

// Route preview from the start mark (2D), or from where the walker is (AR, after lining up).
function pickDest() {
  if (!nav) return;
  dest = destinations().find((d) => d.key === ui.destPick.value) || null;
  const mk = startMark();
  map2d.start = mk;
  map2d.dest = dest;
  route = dest && mk ? makeRoute(mk.p, dest) : null;
  map2d.route = route?.pts || null;
  map2d.draw();
  ui.steps.replaceChildren(...(route ? stepsText(route, dest.name) : []).map((s) => Object.assign(document.createElement('li'), { textContent: s })));
  ui.startAr.disabled = !arSupported || !mk || !route;
}

function makeRoute(from, d) {
  const r = planRoute(nav, from, d.p);
  if (r.error) {
    ui.routeInfo.textContent = r.error;
    return null;
  }
  const ti = turnList(r.pts);
  ui.routeInfo.textContent = `${Math.round(r.length)} m · ~${Math.max(1, Math.round(r.length / 1.1 / 60))} min walk`;
  return { ...r, ...ti, dest: d };
}

ui.mapPick.addEventListener('change', () => openMap(ui.mapPick.value).catch(showErr));
ui.startPick.addEventListener('change', pickDest);
ui.destPick.addEventListener('change', pickDest);
ui.fit.onclick = () => {
  map2d.fitTo = map2d.fitTo === 'route' ? 'map' : 'route';
  ui.fit.textContent = map2d.fitTo === 'route' ? 'Whole map' : 'Fit route';
  map2d.draw();
};
const showErr = (err) => {
  console.error(err);
  say(`Couldn't load the map: ${err.message}`, 'bad');
};

// ---- AR ----
let arSupported = false;
let session = null;
let renderer = null;
let hitSources = [];
let depthOn = false;
let ar = null; // per-session state

// three.js r170 calls the GPU depth API every frame when 'depth-sensing' is on; on our CPU-depth
// session that throws and kills the frame loop (same patch as the scan app).
if (window.XRWebGLBinding?.prototype.getDepthInformation) {
  const gpuDepth = XRWebGLBinding.prototype.getDepthInformation;
  XRWebGLBinding.prototype.getDepthInformation = function (view) {
    try {
      return gpuDepth.call(this, view);
    } catch {
      return null;
    }
  };
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
// Everything route-related is built in map coordinates inside routeGroup; the group's transform is
// map -> session (from lining up + nudges), and its y follows the tracked floor.
const routeGroup = new THREE.Group();
routeGroup.visible = false;
scene.add(routeGroup);

const chevronGeom = (() => {
  // Flat chevron on the floor pointing along -Z, ~40 cm wide (tip at shape +Y).
  const s = new THREE.Shape();
  s.moveTo(0, 0.22);
  s.lineTo(0.2, -0.06);
  s.lineTo(0.2, -0.16);
  s.lineTo(0, 0.08);
  s.lineTo(-0.2, -0.16);
  s.lineTo(-0.2, -0.06);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2); // shape's +Y -> -Z (forward), lying flat, facing up
  return g;
})();
const chevrons = new THREE.InstancedMesh(
  chevronGeom,
  new THREE.MeshBasicMaterial({ color: 0xf2b84b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }),
  MAX_ARROWS,
);
chevrons.count = 0;
chevrons.renderOrder = 2;
routeGroup.add(chevrons);

const goalMarker = (() => {
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xef6b6b, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 12).translate(0, 0.8, 0), new THREE.MeshBasicMaterial({ color: 0xef6b6b, transparent: true, opacity: 0.7 }));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 12).translate(0, 1.7, 0), new THREE.MeshBasicMaterial({ color: 0xef6b6b }));
  g.add(ring, pole, ball);
  return g;
})();
routeGroup.add(goalMarker);

function ensureRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.domElement.style.display = 'none';
  document.body.appendChild(renderer.domElement);
  return renderer;
}

function fanRays() {
  const rays = [];
  for (const pitchDeg of FAN_PITCHES_DEG) {
    for (let i = 0; i < FAN_YAW_STEPS; i++) rays.push([-FAN_HALF_ANGLE_DEG + (2 * FAN_HALF_ANGLE_DEG * i) / (FAN_YAW_STEPS - 1), pitchDeg]);
  }
  return rays;
}
function rayDir([yawDeg, pitchDeg]) {
  const a = THREE.MathUtils.degToRad(yawDeg), b = THREE.MathUtils.degToRad(pitchDeg);
  return { x: Math.sin(a) * Math.cos(b), y: Math.sin(b), z: -Math.cos(a) * Math.cos(b), w: 0 };
}

async function startAr() {
  const mk = startMark();
  if (!mk || !route) return;
  ui.startAr.disabled = true;
  say('');
  const wantDepth = params.get('depth') === '1'; // opt-in, like the scan app
  try {
    ensureRenderer();
    const base = { requiredFeatures: ['local-floor', 'hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: $('overlay') } };
    if (wantDepth) {
      try {
        session = await navigator.xr.requestSession('immersive-ar', {
          ...base,
          optionalFeatures: [...base.optionalFeatures, 'depth-sensing'],
          depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
        });
      } catch (err) {
        console.warn('session with depth failed, retrying without:', err);
      }
    }
    if (!session) session = await navigator.xr.requestSession('immersive-ar', base);
  } catch (err) {
    say(`Could not start AR: ${err.message}`, 'bad');
    ui.startAr.disabled = false;
    return;
  }
  document.body.classList.add('in-ar');
  session.addEventListener('end', onSessionEnd);
  await renderer.xr.setSession(session);
  depthOn = false;
  try {
    depthOn = wantDepth && session.depthUsage === 'cpu-optimized';
  } catch {}
  const viewerSpace = await session.requestReferenceSpace('viewer');
  const rays = fanRays();
  hitSources = await Promise.all(rays.map((r) => session.requestHitTestSource({ space: viewerSpace, offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, rayDir(r)) })));

  ar = {
    mark: mk,
    dest: route.dest,
    rays,
    floor: new FloorTracker(),
    T: null, // session -> map, once lined up
    nudge: { yawDeg: 0, dx: 0, dz: 0 },
    alignPose: null, // session pose at "I'm on the mark"
    alignRequested: false,
    route, // replaced on re-plan
    seg: 0,
    s: 0,
    offSince: null,
    lastReplan: -Infinity,
    arrowsAt: null, // route s the chevrons were laid out for
    arrived: false,
    lost: false,
    lastQ: null, // latest camera orientation (session)
    t0: null,
    t: 0,
    lastRecT: -Infinity,
    rec: null,
  };
  routeGroup.visible = false;
  ui.here.hidden = false;
  ui.nudges.hidden = true;
  alignBanner();
  setArrowAngle(null);
  renderer.setAnimationLoop(onXRFrame);
}

function alignBanner() {
  const mk = ar.mark;
  if (mk.kind === 'room') {
    banner('warn', `Stand at ${mk.name}, ${mk.hint}`, `Where you stood when you labelled it, phone upright. Move it side to side until the floor is found, then tap "I'm here".`);
  } else {
    banner('warn', 'Stand on the start mark', `${mk.name}. Phone upright, facing the way the scan faced there. Move it side to side until the floor is found, then tap "I'm here".`);
  }
}

function banner(kind, text, detail = '') {
  ui.banner.className = kind;
  ui.turnText.replaceChildren(text);
  if (detail) ui.turnText.append(Object.assign(document.createElement('small'), { textContent: detail }));
}

// Banner arrow: rotation in degrees (0 = straight ahead, + = to the right), null = hidden.
function setArrowAngle(deg) {
  ui.arrow.style.visibility = deg === null ? 'hidden' : 'visible';
  if (deg !== null) ui.arrow.style.transform = `rotate(${deg.toFixed(0)}deg)`;
}

const yawOfQ = (o) => Math.atan2(2 * (o.x * o.z + o.w * o.y), 1 - 2 * (o.x * o.x + o.y * o.y)); // = chain.js yawOf

function onXRFrame(time, frame) {
  renderer.render(scene, camera);
  if (!frame || !ar) return;
  if (ar.t0 === null) ar.t0 = time;
  const t = (ar.t = (time - ar.t0) / 1000);
  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    ar.lost = true;
    banner('bad', 'Tracking lost', 'Go slowly back to where you just were and point at something textured');
    return;
  }
  const pos = pose.transform.position, ori = pose.transform.orientation;
  ar.lastQ = ori;
  if (ar.lost && !ar.T) alignBanner();
  ar.lost = false;
  const sessP = [pos.x, pos.y, pos.z], sessQ = [ori.x, ori.y, ori.z, ori.w];

  // Hit-test fan: floor height for the arrows, and the walk's recording.
  const pts = [];
  for (const src of hitSources) {
    const hp = frame.getHitTestResults(src)[0]?.getPose(refSpace);
    if (hp) pts.push([r3(hp.transform.position.x), r3(hp.transform.position.y), r3(hp.transform.position.z)]);
  }
  const floorY = ar.floor.update(pos.y, pts);

  // Line up on the first frame after the tap, and record from exactly that pose (frame 0 of the
  // walk = the handover pose, as in a Continue scan).
  if (ar.alignRequested && !ar.T) {
    ar.alignRequested = false;
    ar.alignPose = { p: sessP, q: sessQ };
    ar.T = sessionToMap(ar.mark, ar.alignPose, ar.nudge);
    routeGroup.visible = true;
    ui.here.hidden = true;
    ui.nudges.hidden = false;
    if (ui.record.checked) startRecording();
    ar.lastRecT = -Infinity;
  }

  if (ar.T) {
    // routeGroup: map -> session = invert(T). Rotation about +Y matches chain.js apply().
    const Ti = invert(ar.T);
    routeGroup.rotation.y = Ti.yaw;
    routeGroup.position.set(Ti.tx, floorY + 0.01, Ti.tz);
    const me = apply(ar.T, pos.x, pos.z);
    const yawMap = yawOfQ(ori) + ar.T.yaw;
    guide(me, yawMap, t);
  }

  if (ar.rec && t - ar.lastRecT >= 1 / RECORD_HZ) {
    ar.lastRecT = t;
    let dpts = null;
    if (depthOn && !ar.rec.depthPaused && ar.rec.frames % DEPTH_EVERY === 0) {
      const t1 = performance.now();
      dpts = sampleDepth(frame, pose.views[0]);
      const ms = performance.now() - t1;
      ar.rec.depthMs = ar.rec.depthMs ? ar.rec.depthMs + 0.2 * (ms - ar.rec.depthMs) : ms;
      if (ar.rec.depthMs > DEPTH_MAX_MS) ar.rec.depthPaused = true;
    }
    recordFrame(t, sessP, sessQ, pts, dpts, pose.emulatedPosition ? 'limited' : 'normal');
  }
}

// Follow the route: progress, off-route re-plan, chevrons, banner.
function guide(me, yawMap, t) {
  let r = ar.route;
  let p = progressOn(r.pts, r.cum, me, ar.seg);
  // Off route for a while: plan again from here (rarely, it's a full A*).
  if (p.off > NAV.offRoute) ar.offSince ??= t;
  else ar.offSince = null;
  if (ar.offSince !== null && t - ar.offSince > NAV.offRouteS && t - ar.lastReplan > REPLAN_EVERY_S) {
    ar.lastReplan = t;
    const nr = planRoute(nav, me, ar.dest.p);
    if (!nr.error) {
      ar.route = r = { ...nr, ...turnList(nr.pts), dest: ar.dest };
      ar.seg = 0;
      ar.arrowsAt = null;
      ar.offSince = null;
      p = progressOn(r.pts, r.cum, me, 0);
    }
  }
  ar.seg = p.seg;
  ar.s = p.s;
  const left = Math.max(0, r.length - p.s);
  const toGoal = Math.hypot(me[0] - ar.dest.p[0], me[1] - ar.dest.p[1]);
  if (!ar.arrived && (toGoal < NAV.arrive || left < NAV.arrive * 0.5)) ar.arrived = true;

  if (ar.arrowsAt === null || Math.abs(p.s - ar.arrowsAt) > ARROW_SPACING / 2) layoutChevrons(r, p.s);
  const g = r.pts.at(-1);
  goalMarker.position.set(g[0], 0, g[1]);

  // Banner arrow: toward the route point LOOK_AHEAD m on (or the goal), relative to where we face.
  const aim = pointAt(r, Math.min(r.length, p.s + LOOK_AHEAD));
  const rel = Math.atan2(Math.sin(headingOf(me, aim) - yawMap), Math.cos(headingOf(me, aim) - yawMap)); // + = left
  if (ar.arrived) {
    banner('ok', `You've arrived: ${ar.dest.name}`, ar.rec ? 'Tap Stop to save this walk.' : 'Tap Stop to finish.');
    setArrowAngle(null);
  } else if (p.off > NAV.offRoute) {
    banner('warn', 'Back to the arrows', `${p.off.toFixed(1)} m off the route${ar.offSince !== null ? ', re-planning soon' : ''}`);
    setArrowAngle((-rel * 180) / Math.PI);
  } else {
    const n = nextTurn(r.turns, p.s);
    if (Math.abs(rel) > (100 * Math.PI) / 180) banner('warn', 'Turn around', `${Math.round(left)} m to ${ar.dest.name}`);
    else if (n.kind === 'arrive') banner('ok', `${ar.dest.name} in ${Math.round(n.in)} m`, 'Follow the arrows');
    else banner('ok', n.in < 2 ? n.text + ' now' : `${n.text} in ${Math.round(n.in)} m`, `${Math.round(left)} m to ${ar.dest.name}`);
    setArrowAngle((-rel * 180) / Math.PI);
  }
  ui.info.textContent =
    `to ${ar.dest.name}: ${Math.round(left)} m · route ${Math.round(r.length)} m\n` +
    `from ${ar.mark.name}` +
    (ar.nudge.yawDeg || ar.nudge.dx || ar.nudge.dz ? `  nudge ${ar.nudge.yawDeg}° ${r3(ar.nudge.dx)},${r3(ar.nudge.dz)} m` : '') +
    (ar.rec ? `\nREC ${ar.rec.header.session_id} · ${ar.rec.frames} frames${depthOn ? ' · depth' : ''}` : '');
}

// Point at distance s along the route.
function pointAt(r, s) {
  let k = 0;
  while (k < r.pts.length - 2 && r.cum[k + 1] < s) k++;
  const a = r.pts[k], b = r.pts[k + 1] || a;
  const L = r.cum[k + 1] - r.cum[k] || 1;
  const u = Math.max(0, Math.min(1, (s - r.cum[k]) / L));
  return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), UP = new THREE.Vector3(0, 1, 0);
function layoutChevrons(r, s) {
  ar.arrowsAt = s;
  let n = 0;
  const from = Math.max(0, Math.ceil((s - ARROWS_BEHIND) / ARROW_SPACING) * ARROW_SPACING);
  for (let d = from; d < Math.min(r.length - 0.3, s + ARROWS_AHEAD) && n < MAX_ARROWS; d += ARROW_SPACING) {
    const a = pointAt(r, d), b = pointAt(r, Math.min(r.length, d + 0.3));
    tmpQ.setFromAxisAngle(UP, headingOf(a, b));
    tmpP.set(a[0], 0, a[1]);
    chevrons.setMatrixAt(n++, tmpM.compose(tmpP, tmpQ, ONE));
  }
  chevrons.count = n;
  chevrons.instanceMatrix.needsUpdate = true;
}

// Nudges, as seen by the walker: turn the arrows left/right, or shift them ahead/back.
// (A nudge moves session -> map; the arrows move the opposite way.)
function nudge(kind) {
  if (!ar?.T) return;
  const n = ar.nudge;
  if (kind === 'L') n.yawDeg -= NUDGE_DEG;
  else if (kind === 'R') n.yawDeg += NUDGE_DEG;
  else {
    // Ahead/back along the walker's current heading, in the mark scan's coordinates (where nudges live).
    const yawLocal = ar.T.yaw - ar.mark.T.yaw + (ar.lastQ ? yawOfQ(ar.lastQ) : 0);
    const k = kind === 'F' ? -NUDGE_M : NUDGE_M;
    n.dx = r3(n.dx + k * -Math.sin(yawLocal));
    n.dz = r3(n.dz + k * -Math.cos(yawLocal));
  }
  ar.T = sessionToMap(ar.mark, ar.alignPose, n);
  ar.arrowsAt = null;
  // A walk from the map start marker is written in map coordinates, so nudges apply from now on;
  // one continuing a scan keeps session coordinates and saves the nudge in its header.
}
$('nudgeL').onclick = () => nudge('L');
$('nudgeR').onclick = () => nudge('R');
$('nudgeF').onclick = () => nudge('F');
$('nudgeB').onclick = () => nudge('B');

// ---- recording the walk (joins the map once uploaded) ----
// From an end mark: an ordinary Continue scan of that mark's scan (session coordinates; the
// viewer's nudge sliders and auto-align work on it). From the map start marker there is no scan
// to continue, so the walk is written straight in map coordinates and is placed as-is.
function startRecording() {
  const mk = ar.mark;
  const parent = scans.find((s) => s.header?.session_id === mk.scan);
  const continuing = mk.kind === 'end';
  const header = {
    type: 'header',
    session_id: randomId(),
    map: { id: mapInfo.id, name: mapInfo.name },
    ...(continuing
      ? { continues: mk.scan, continues_end: { p: mk.local.p, q: mk.local.q }, chain: parent?.header?.chain || mk.scan }
      : {}),
    nav: { mark: mk.id, dest: ar.dest.name, coords: continuing ? 'session' : 'map' },
    device: params.get('device') || 'unknown',
    ref_space: 'local-floor',
    start_marker: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    created: new Date().toISOString(),
    app_version: APP_VERSION,
    fan: { rays: ar.rays, origin: 'viewer' },
    depth: depthOn ? { usage: session.depthUsage, format: session.depthDataFormat, rows: DEPTH_ROWS, cols: DEPTH_COLS, range: [DEPTH_MIN, DEPTH_MAX] } : null,
    keyframes: null,
  };
  const line = toLine(header);
  ar.rec = { header, lines: [line], pending: '', pendingFrames: 0, frames: 0, points: 0, t0: ar.t, depthMs: 0, depthPaused: false, mapCoords: !continuing };
  store.startSession(header, line);
}

function recordFrame(t, p, q, pts, dpts, tracking) {
  const rec = ar.rec;
  let P = p, Q = q, H = pts, D = dpts;
  if (rec.mapCoords) {
    // Session -> map: rotate about +Y by T.yaw, then translate (heights stay as they are).
    const T = ar.T;
    const mp = (h) => {
      const [x, z] = apply(T, h[0], h[2]);
      return [r3(x), h[1], r3(z)];
    };
    P = mp(p);
    const s = Math.sin(T.yaw / 2), c = Math.cos(T.yaw / 2);
    Q = [c * q[0] + s * q[2], c * q[1] + s * q[3], c * q[2] - s * q[0], c * q[3] - s * q[1]];
    H = pts.map(mp);
    D = dpts && dpts.map(mp);
  }
  const line = toLine({
    type: 'frame',
    t: r3(t - rec.t0),
    p: P.map(r3),
    q: Q.map(r3),
    tracking,
    pts: H,
    ...(D ? { dpts: D } : {}),
  });
  rec.lines.push(line);
  rec.pending += line;
  rec.frames++;
  rec.points += H.length;
  if (++rec.pendingFrames >= FLUSH_EVERY_FRAMES) flush();
}

function flush() {
  const rec = ar?.rec;
  if (!rec?.pending) return;
  const text = rec.pending;
  rec.pending = '';
  rec.pendingFrames = 0;
  store.appendChunk(rec.header.session_id, text, rec.frames);
}

async function finishRecording(done) {
  const rec = done.rec;
  rec.lines.push(toLine({ type: 'stats', frames: rec.frames, points: rec.points, duration: r3(done.t - rec.t0) }));
  // The nudge is only final now: put it in the header (mergeMap reads continues_nudge from there).
  const n = done.nudge;
  if (!rec.mapCoords && (n.yawDeg || n.dx || n.dz)) rec.header.continues_nudge = { ...n };
  rec.lines[0] = toLine(rec.header);
  const text = rec.lines.join('');
  const id = rec.header.session_id;
  // Re-save the whole walk (the stored header predates the nudge).
  await store.deleteSession(id);
  if (rec.frames < 5) return say('The walk was too short to keep.', 'warn');
  await store.startSession(rec.header, text);
  await store.updateSession(id, { done: true, frames: rec.frames });
  await uploadWalk(id, text);
}

async function uploadWalk(id, text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    say(`Uploading walk ${id} (try ${attempt}/3)…`);
    try {
      const res = await fetch(`${SERVER}/api/scans`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: text });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      await store.updateSession(id, { uploaded: true });
      say(`Walk ${id} added to ${mapInfo.name}.`);
      refreshSaved();
      return true;
    } catch (err) {
      say(`Upload failed: ${err.message}`, 'warn');
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  say(`Upload failed 3 times. The walk is saved on this phone: tap ⬆ below when the network is back (or upload it from the scan app).`, 'bad');
  refreshSaved();
  return false;
}

// Walks not uploaded yet (nav walks share the scan app's on-phone store, so it lists them too).
async function refreshSaved() {
  const list = (await store.listSessions()).filter((s) => !s.uploaded);
  const rows = [];
  for (const s of list) {
    const text = await store.loadText(s.session_id);
    if (!text || !parseScan(text.slice(0, text.indexOf('\n') + 1)).header?.nav) continue;
    const row = document.createElement('div');
    row.textContent = `${s.session_id} · ${s.frames} frames${s.done ? '' : ' · unfinished'} `;
    const up = Object.assign(document.createElement('button'), { textContent: '⬆', type: 'button' });
    up.style.cssText = 'font-size:14px;padding:6px 10px;border-radius:8px';
    up.onclick = () => uploadWalk(s.session_id, text);
    row.append(up);
    rows.push(row);
  }
  ui.saved.replaceChildren(...rows);
  if (!rows.length) ui.saved.textContent = 'none';
}

async function onSessionEnd() {
  renderer?.setAnimationLoop(null);
  hitSources.forEach((s) => s.cancel && s.cancel());
  hitSources = [];
  session = null;
  document.body.classList.remove('in-ar');
  routeGroup.visible = false;
  const done = ar;
  ar = null;
  ui.startAr.disabled = !route;
  if (done?.rec) {
    // finishRecording re-saves the whole walk, so no final flush is needed.
    await finishRecording(done).catch((err) => say(`Saving the walk failed: ${err.message}`, 'bad'));
  }
}

ui.here.onclick = () => {
  if (!ar) return;
  if (!ar.floor.seen) return banner('warn', 'Floor not found yet', 'Move the phone side to side a little, then tap again');
  ar.alignRequested = true;
};
ui.stop.onclick = () => session?.end();
ui.startAr.onclick = () =>
  startAr().catch((err) => {
    console.error(err);
    session?.end();
    say(`AR failed: ${err.message}`, 'bad');
  });
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.hidden && flush());

async function init() {
  refreshSaved();
  const maps = loadMaps(); // the map and steps work without AR, so don't wait on the AR check
  if (window.isSecureContext && navigator.xr) {
    const timeout = new Promise((r) => setTimeout(() => r(false), 4000)); // some browsers never answer
    arSupported = await Promise.race([navigator.xr.isSessionSupported('immersive-ar').catch(() => false), timeout]);
  }
  if (arSupported) {
    pickDest(); // re-enables Start if the map was already loaded
  } else {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    say(
      ios
        ? 'iPhone: no AR arrows here (Safari has no WebXR AR). Follow the map and the steps below.'
        : !window.isSecureContext
          ? 'AR needs HTTPS (open this page through the tunnel). The map and steps still work.'
          : 'No WebXR AR in this browser: follow the map and the steps below (AR arrows need Chrome on an ARCore phone).',
      'warn',
    );
    ui.startAr.textContent = 'AR not available here';
  }
  await maps;
}

init().catch(showErr);
