// M1 scan app: WebXR immersive-ar + local-floor + hit-test "fake lidar", recorded to JSON Lines.
import * as THREE from '../vendor/three.module.min.js';
import { APP_VERSION, r3, toLine } from '../common/jsonl.js';
import * as store from './store.js';

// ---- config ----
const RECORD_HZ = 10;
const FLUSH_EVERY_FRAMES = 20; // IndexedDB write every ~2 s
const FAN_HALF_ANGLE_DEG = 35; // ~camera FOV; wider rays only hit planes seen earlier
const FAN_YAW_STEPS = 7;
const FAN_PITCHES_DEG = [0, -25];
const MAX_VIS_POINTS = 4000;

const params = new URLSearchParams(location.search);
// Optional upload base URL for when the pages are hosted separately from the server.
const SERVER = (params.get('server') || '').replace(/\/$/, '');
const DEVICE = params.get('device') || guessDevice();

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'),
  msg: $('msg'),
  start: $('start'),
  stop: $('stop'),
  download: $('download'),
  upload: $('upload'),
  saved: $('saved'),
};

function guessDevice() {
  const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
  return m ? m[1].trim() : 'unknown';
}

function say(text, kind = '') {
  ui.msg.textContent = text;
  ui.msg.className = kind;
}

function randomId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Ray directions in viewer space (-Z is forward, +Y up).
function fanRays() {
  const rays = [];
  for (const pitchDeg of FAN_PITCHES_DEG) {
    for (let i = 0; i < FAN_YAW_STEPS; i++) {
      const yawDeg = -FAN_HALF_ANGLE_DEG + (2 * FAN_HALF_ANGLE_DEG * i) / (FAN_YAW_STEPS - 1);
      rays.push([yawDeg, pitchDeg]);
    }
  }
  return rays;
}

function rayDir([yawDeg, pitchDeg]) {
  const a = THREE.MathUtils.degToRad(yawDeg);
  const b = THREE.MathUtils.degToRad(pitchDeg);
  return { x: Math.sin(a) * Math.cos(b), y: Math.sin(b), z: -Math.cos(a) * Math.cos(b), w: 0 };
}

// ---- recording state ----
let rec = null; // { header, lines[], pending, frames, points, t0, lastT, rayHits[], rayTries }
let lastScan = null; // { id, text }
let session = null;
let hitSources = [];

// ---- three.js (only needed to drive the XR frame loop + show coverage dots) ----
// Created on first Start so a WebGL failure can't break the page before it can explain itself.
let renderer = null;

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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera();
const visPositions = new Float32Array(MAX_VIS_POINTS * 3);
const visGeom = new THREE.BufferGeometry();
visGeom.setAttribute('position', new THREE.BufferAttribute(visPositions, 3));
visGeom.setDrawRange(0, 0);
scene.add(new THREE.Points(visGeom, new THREE.PointsMaterial({ color: 0x2bc4a8, size: 0.03 })));
let visCount = 0;
let visHead = 0;

function addVisPoint(x, y, z) {
  visPositions.set([x, y, z], visHead * 3);
  visHead = (visHead + 1) % MAX_VIS_POINTS;
  visCount = Math.min(visCount + 1, MAX_VIS_POINTS);
  visGeom.setDrawRange(0, visCount);
  visGeom.attributes.position.needsUpdate = true;
}

// ---- status ----
let trackingState = '-';

function renderStatus() {
  if (!rec) {
    ui.status.textContent = lastScan
      ? `last scan: ${lastScan.id}\nframes ${lastScan.frames}  points ${lastScan.points}`
      : 'ready';
    return;
  }
  const elapsed = rec.lastT.toFixed(1);
  const hitPct = rec.rayTries ? Math.round((100 * rec.points) / rec.rayTries) : 0;
  const perRay = rec.rayTries
    ? rec.rayHits.map((h) => Math.round((100 * h * rec.rays.length) / rec.rayTries)).join(' ')
    : '';
  ui.status.textContent =
    `REC ${rec.header.session_id}  ${elapsed}s\n` +
    `tracking ${trackingState}\n` +
    `frames ${rec.frames}  points ${rec.points}  hit ${hitPct}%\n` +
    `per-ray % ${perRay}\n` +
    `saved ${rec.savedFrames}/${rec.frames}`;
}

// ---- session ----
async function startScan() {
  ui.start.disabled = true;
  say('');
  try {
    ensureRenderer();
    const overlayRoot = $('overlay');
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor', 'hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayRoot },
    });
  } catch (err) {
    say(`Could not start AR: ${err.message}`, 'bad');
    ui.start.disabled = false;
    return;
  }

  document.body.classList.add('in-ar');
  ui.start.hidden = true;
  ui.stop.hidden = false;
  if (!session.domOverlayState) say('No DOM overlay: press Android Back to stop.', 'warn');

  session.addEventListener('end', onSessionEnd);
  await renderer.xr.setSession(session);

  const viewerSpace = await session.requestReferenceSpace('viewer');
  const rays = fanRays();
  hitSources = await Promise.all(
    rays.map((r) =>
      session.requestHitTestSource({
        space: viewerSpace,
        offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, rayDir(r)),
      }),
    ),
  );

  const header = {
    type: 'header',
    session_id: randomId(),
    device: DEVICE,
    ref_space: 'local-floor',
    start_marker: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    created: new Date().toISOString(),
    app_version: APP_VERSION,
    fan: { rays, origin: 'viewer' }, // [yawDeg, pitchDeg] per hit-test source
  };
  const headerLine = toLine(header);
  rec = {
    header,
    rays,
    lines: [headerLine],
    pending: '',
    pendingFrames: 0,
    frames: 0,
    savedFrames: 0,
    points: 0,
    rayHits: rays.map(() => 0),
    rayTries: 0,
    t0: null,
    lastT: 0,
    lastRecT: -Infinity,
  };
  visCount = visHead = 0;
  visGeom.setDrawRange(0, 0);
  await store.startSession(header, headerLine);

  renderer.setAnimationLoop(onXRFrame);
}

function onXRFrame(time, frame) {
  renderer.render(scene, camera);
  if (!frame || !rec) return;

  if (rec.t0 === null) rec.t0 = time;
  const t = (time - rec.t0) / 1000;
  rec.lastT = t;

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    trackingState = 'lost';
    renderStatus();
    return;
  }
  trackingState = pose.emulatedPosition ? 'limited' : 'normal';

  if (t - rec.lastRecT < 1 / RECORD_HZ) return;
  rec.lastRecT = t;

  const pos = pose.transform.position;
  const ori = pose.transform.orientation;
  const pts = [];
  hitSources.forEach((src, i) => {
    const results = frame.getHitTestResults(src);
    if (!results.length) return;
    const hp = results[0].getPose(refSpace);
    if (!hp) return;
    const h = hp.transform.position;
    pts.push([r3(h.x), r3(h.y), r3(h.z)]);
    rec.rayHits[i]++;
    addVisPoint(h.x, h.y, h.z);
  });
  rec.rayTries += hitSources.length;

  const line = toLine({
    type: 'frame',
    t: r3(t),
    p: [r3(pos.x), r3(pos.y), r3(pos.z)],
    q: [r3(ori.x), r3(ori.y), r3(ori.z), r3(ori.w)],
    tracking: trackingState,
    pts,
  });
  rec.lines.push(line);
  rec.pending += line;
  rec.pendingFrames++;
  rec.frames++;
  rec.points += pts.length;

  if (rec.pendingFrames >= FLUSH_EVERY_FRAMES) flush();
  renderStatus();
}

function flush() {
  if (!rec || !rec.pending) return;
  const text = rec.pending;
  const frames = rec.frames;
  rec.pending = '';
  rec.pendingFrames = 0;
  store.appendChunk(rec.header.session_id, text, frames).then(() => {
    if (rec && rec.frames >= frames) rec.savedFrames = Math.max(rec.savedFrames, frames);
  });
}

function stopScan() {
  if (session) session.end(); // onSessionEnd does the rest
}

async function onSessionEnd() {
  renderer?.setAnimationLoop(null);
  hitSources.forEach((s) => s.cancel && s.cancel());
  hitSources = [];
  session = null;
  document.body.classList.remove('in-ar');
  ui.stop.hidden = true;
  ui.start.hidden = false;
  ui.start.disabled = false;

  if (rec) {
    const statsLine = toLine({
      type: 'stats',
      frames: rec.frames,
      points: rec.points,
      ray_tries: rec.rayTries,
      ray_hits: rec.rayHits,
      duration: r3(rec.lastT),
    });
    rec.lines.push(statsLine);
    rec.pending += statsLine;
    const id = rec.header.session_id;
    const done = rec;
    flush();
    await store.updateSession(id, { done: true, frames: done.frames });
    lastScan = { id, text: done.lines.join(''), frames: done.frames, points: done.points };
    rec = null;
    say(done.frames ? `Scan ${id} saved on phone (${done.frames} frames).` : 'Scan was empty.', done.frames ? '' : 'warn');
  }
  ui.download.disabled = ui.upload.disabled = !lastScan;
  renderStatus();
  refreshSaved();
}

// ---- download / upload ----
function downloadText(id, text) {
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `scan-${id}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function uploadText(id, text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    say(`Uploading ${id} (try ${attempt}/3)…`);
    try {
      const res = await fetch(`${SERVER}/api/scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body: text,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const info = await res.json();
      await store.updateSession(id, { uploaded: true });
      say(`Uploaded ${id}: ${info.frames} frames, ${info.points} points.`);
      refreshSaved();
      return true;
    } catch (err) {
      say(`Upload failed: ${err.message}`, 'warn');
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  say('Upload failed 3 times. Scan is still on the phone: try again later, or Download and copy over USB.', 'bad');
  return false;
}

async function refreshSaved() {
  const sessions = await store.listSessions();
  ui.saved.replaceChildren(
    ...sessions.map((s) => {
      const row = document.createElement('div');
      row.className = 'saved-item';
      const name = document.createElement('span');
      name.className = 'name';
      const flags = [s.done ? '' : 'unfinished', s.uploaded ? 'uploaded' : ''].filter(Boolean).join(', ');
      name.textContent = `${s.session_id} · ${s.frames}f ${flags ? '· ' + flags : ''}`;
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = fn;
        return b;
      };
      const getText = () => store.loadText(s.session_id);
      row.append(
        name,
        mk('⬇', async () => downloadText(s.session_id, await getText())),
        mk('⬆', async () => uploadText(s.session_id, await getText())),
        mk('✕', async () => {
          if (confirm(`Delete scan ${s.session_id} from this phone?`)) {
            await store.deleteSession(s.session_id);
            refreshSaved();
          }
        }),
      );
      return row;
    }),
  );
  if (!sessions.length) ui.saved.textContent = 'none yet';
}

// ---- wiring ----
ui.start.onclick = startScan;
ui.stop.onclick = stopScan;
ui.download.onclick = () => lastScan && downloadText(lastScan.id, lastScan.text);
ui.upload.onclick = () => lastScan && uploadText(lastScan.id, lastScan.text);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.hidden && flush());

async function init() {
  refreshSaved();
  if (!window.isSecureContext) {
    ui.status.textContent = 'not a secure context';
    say('WebXR needs HTTPS. Open this page through the cloudflared https:// URL.', 'bad');
    return;
  }
  if (!navigator.xr) {
    ui.status.textContent = 'no WebXR';
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    say(ios ? 'iPhone Safari has no WebXR AR yet (fallback mode TBD). Use an Android phone with Chrome.' : 'This browser has no WebXR. Use Chrome on Android.', 'bad');
    return;
  }
  const ok = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (!ok) {
    ui.status.textContent = 'immersive-ar not supported';
    say('AR sessions are not supported here. Needs Chrome on an ARCore phone.', 'bad');
    return;
  }
  ui.start.disabled = false;
  renderStatus();
}

init().catch((err) => say(`Startup error: ${err.message}`, 'bad'));
