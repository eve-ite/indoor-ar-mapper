// M1 scan app: WebXR immersive-ar + local-floor + hit-test "fake lidar", recorded to JSON Lines.
import * as THREE from '../vendor/three.module.min.js';
import { APP_VERSION, r3, toLine } from '../common/jsonl.js';
import { FloorTracker } from '../common/floor.js';
import { CameraGrabber, KeyframeGate, encodeJpeg, intrinsicsFromProjection } from '../common/keyframes.js';
import { DEPTH_COLS, DEPTH_MAX, DEPTH_MIN, DEPTH_ROWS, sampleDepth } from '../common/depth.js';
import * as store from './store.js';

// ---- config ----
const RECORD_HZ = 10;
const FLUSH_EVERY_FRAMES = 20; // IndexedDB write every ~2 s
const FAN_HALF_ANGLE_DEG = 35; // ~camera FOV; wider rays only hit planes seen earlier
const FAN_YAW_STEPS = 7;
// Several rows so the sweep crosses every height between the phone and the floor: a single
// level row at hand height flies over tables (0.75 m) and only ever sees the floor ahead.
const FAN_PITCHES_DEG = [0, -10, -20, -30];
const MAX_VIS_POINTS = 4000;
const HINT_WINDOW_S = 3;
const NO_OBSTACLE_NAG_S = 8; // open aisles legitimately have stretches with nothing in reach
const WALL_MIN_ABOVE_FLOOR = 0.2; // m; matches the viewer's default wall band
const PITCH_LIMIT_DEG = 20; // nag if the camera points further up/down than this
const MAX_SPEED = 0.6; // m/s

const params = new URLSearchParams(location.search);
// Optional upload base URL for when the pages are hosted separately from the server.
const SERVER = (params.get('server') || '').replace(/\/$/, '');
let detectedDevice = 'unknown';
// Depth lidar is opt-in (Settings toggle or ?depth=1) until it's been tried on more phones.
let depthRequested = false; // captured when a scan starts
// Camera keyframes are opt-in (Settings toggle or ?keyframes=1): WebXR camera-access photos with pose.
let kfRequested = false; // captured when a scan starts
let kfOn = false;
let kfBinding = null;
let kfGrabber = null;
const KF_MAX_WIDTH = 960; // px; ~70-110 KB JPEGs (see TEXTURES_FINDINGS.md budget)
const KF_JPEG_Q = 0.8;
const DEPTH_EVERY = 2; // sample depth on every Nth recorded frame (5 Hz)
const DEPTH_MAX_MS = 25; // pause depth sampling if it averages slower than this

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'),
  hint: $('hint'),
  msg: $('msg'),
  start: $('start'),
  stop: $('stop'),
  download: $('download'),
  upload: $('upload'),
  saved: $('saved'),
  depth: $('depthToggle'),
  keyframes: $('kfToggle'),
  device: $('deviceName'),
};

// ---- settings: remembered on this phone; URL params (?depth=1, ?device=...) override ----
const SETTINGS_KEY = 'iam-scan-settings';

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {}
  ui.depth.checked = params.has('depth') ? params.get('depth') === '1' : !!saved.depth;
  ui.keyframes.checked = params.has('keyframes') ? params.get('keyframes') === '1' : !!saved.keyframes;
  ui.device.value = params.get('device') || saved.device || '';
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ depth: ui.depth.checked, keyframes: ui.keyframes.checked, device: ui.device.value.trim() }));
  } catch {}
}

loadSettings();
ui.depth.addEventListener('change', saveSettings);
ui.keyframes.addEventListener('change', saveSettings);
ui.device.addEventListener('change', saveSettings);

// Chrome's reduced UA string says "K" for every Android model; Client Hints have the real one.
async function guessDevice() {
  try {
    const { model } = await navigator.userAgentData.getHighEntropyValues(['model']);
    if (model) return model;
  } catch {}
  const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
  return m && m[1].trim() !== 'K' ? m[1].trim() : 'unknown';
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
let depthOn = false;


// three.js (r170) sees 'depth-sensing' in enabledFeatures and calls the GPU depth API every
// frame. We use the CPU path, where that call throws InvalidStateError, which kills three's
// frame loop before our callback runs (the S23 "froze" ~0.5 s in). Report "no GPU depth" instead.
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
  // One row of per-ray hit % per pitch, left-to-right in yaw.
  const pct = rec.rayHits.map((h) => (rec.frames ? Math.round((100 * h) / rec.frames) : 0));
  const perRay = FAN_PITCHES_DEG.map(
    (p, row) => `\n ${String(p).padStart(3)}°: ` + pct.slice(row * FAN_YAW_STEPS, (row + 1) * FAN_YAW_STEPS).map((v) => String(v).padStart(3)).join(''),
  ).join('');
  ui.status.textContent =
    `REC ${rec.header.session_id}  ${elapsed}s\n` +
    `tracking ${trackingState}  ${Math.round(rec.fps)} fps\n` +
    (depthOn
      ? `depth ${rec.depthPaused ? 'PAUSED (too slow)' : 'ON'}  ${rec.depthMs.toFixed(1)} ms  ${rec.depthPoints} pts\n`
      : `depth off${depthRequested ? ' (not granted)' : ''}\n`) +
    `frames ${rec.frames}  points ${rec.points}  hit ${hitPct}%\n` +
    `per-ray % ${perRay}\n` +
    (kfRequested
      ? kfOn
        ? `photos ${rec.keyframes}${rec.kfStopped ? ' STOPPED' : ''}  ${rec.kfMs.toFixed(0)} ms${rec.kfNoCamera > 30 && !rec.keyframes ? '  (no camera image)' : ''}\n`
        : 'photos off (camera access not granted)\n'
      : '') +
    `saved ${rec.savedFrames}/${rec.frames}`;
}

// ---- session ----
async function startScan() {
  ui.start.disabled = true;
  say('');
  try {
    ensureRenderer();
    const overlayRoot = $('overlay');
    const base = {
      requiredFeatures: ['local-floor', 'hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlayRoot },
    };
    depthRequested = ui.depth.checked;
    kfRequested = ui.keyframes.checked;
    if (depthRequested || kfRequested) {
      const extra = { ...base, optionalFeatures: [...base.optionalFeatures] };
      if (depthRequested) {
        // CPU path only (the GPU sample's shader failed on the S23).
        extra.optionalFeatures.push('depth-sensing');
        extra.depthSensing = { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] };
      }
      if (kfRequested) extra.optionalFeatures.push('camera-access');
      try {
        session = await navigator.xr.requestSession('immersive-ar', extra);
      } catch (err) {
        console.warn('session with depth/camera failed, retrying without:', err);
      }
    }
    if (!session) session = await navigator.xr.requestSession('immersive-ar', base);
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

  // depthUsage throws (InvalidStateError) when depth-sensing wasn't granted.
  depthOn = false;
  try {
    depthOn = depthRequested && session.depthUsage === 'cpu-optimized';
  } catch {}

  // Camera keyframes: granted? (enabledFeatures may be missing on older Chrome: then trust view.camera.)
  kfOn = false;
  if (kfRequested && (!session.enabledFeatures || session.enabledFeatures.includes('camera-access'))) {
    try {
      kfBinding = new XRWebGLBinding(session, renderer.getContext());
      kfGrabber = new CameraGrabber(renderer.getContext(), KF_MAX_WIDTH);
      kfOn = true;
    } catch (err) {
      say(`Camera keyframes unavailable: ${err.message}`, 'warn');
    }
  } else if (kfRequested) {
    say('Camera access not granted: scanning without photos.', 'warn');
  }

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
    device: ui.device.value.trim() || detectedDevice,
    ref_space: 'local-floor',
    start_marker: { p: [0, 0, 0], q: [0, 0, 0, 1] },
    created: new Date().toISOString(),
    app_version: APP_VERSION,
    fan: { rays, origin: 'viewer' }, // [yawDeg, pitchDeg] per hit-test source
    // dpts in frames = depth-map samples (any surface), pts = plane hit-test hits
    depth: depthOn
      ? { usage: session.depthUsage, format: session.depthDataFormat, rows: DEPTH_ROWS, cols: DEPTH_COLS, range: [DEPTH_MIN, DEPTH_MAX] }
      : null,
    // keyframe lines = camera photos: {"type":"keyframe","t","p","q","intrinsics":{fx,fy,cx,cy,w,h},"img"}
    // intrinsics in pixels, top-left origin; p/q = camera pose (view.transform) in local-floor
    keyframes: kfOn ? { max_width: KF_MAX_WIDTH, jpeg_quality: KF_JPEG_Q } : null,
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
    floor: new FloorTracker(),
    lastObstacleT: 0,
    depthFrames: 0,
    depthPoints: 0,
    depthMs: 0,
    depthPaused: false,
    kfGate: new KeyframeGate(),
    keyframes: 0,
    kfPending: 0,
    kfMs: 0,
    kfNoCamera: 0,
    kfStopped: false,
    fps: 0,
    lastFrameTime: null,
    recent: [], // last HINT_WINDOW_S of recorded frames, for the live hint
  };
  showHint('warn', 'Move side to side ↔', 'Let ARCore find the floor before walking off');
  visCount = visHead = 0;
  visGeom.setDrawRange(0, 0);
  await store.startSession(header, headerLine);

  renderer.setAnimationLoop(onXRFrame);
}

function onXRFrame(time, frame) {
  renderer.render(scene, camera);
  if (!frame || !rec) return;

  if (rec.t0 === null) rec.t0 = time;
  if (rec.lastFrameTime !== null && time > rec.lastFrameTime) {
    const inst = 1000 / (time - rec.lastFrameTime);
    rec.fps = rec.fps ? rec.fps + 0.05 * (inst - rec.fps) : inst;
  }
  rec.lastFrameTime = time;
  const t = (time - rec.t0) / 1000;
  rec.lastT = t;

  const refSpace = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(refSpace);
  if (!pose) {
    trackingState = 'lost';
    showHint('bad', 'Tracking lost', 'Go slowly back to where you just were and point at something textured');
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

  let dpts = null;
  if (depthOn && !rec.depthPaused && rec.frames % DEPTH_EVERY === 0) {
    const t0 = performance.now();
    dpts = sampleDepth(frame, pose.views[0]);
    const ms = performance.now() - t0;
    rec.depthMs = rec.depthMs ? rec.depthMs + 0.2 * (ms - rec.depthMs) : ms;
    if (rec.depthMs > DEPTH_MAX_MS) rec.depthPaused = true;
  }
  if (dpts) {
    rec.depthFrames++;
    rec.depthPoints += dpts.length;
    for (const d of dpts) addVisPoint(d[0], d[1], d[2]);
  }

  // Floor from plane hits only: they're exact, depth samples are noisy.
  const floorY = rec.floor.update(pos.y, pts);
  const walls = [...pts, ...(dpts || [])].filter((h) => h[1] - floorY >= WALL_MIN_ABOVE_FLOOR).length;
  rec.recent.push({ t, x: pos.x, z: pos.z, hits: pts.length + (dpts?.length || 0), walls });
  while (rec.recent.length && rec.recent[0].t < t - HINT_WINDOW_S) rec.recent.shift();
  updateHint(ori);

  const line = toLine({
    type: 'frame',
    t: r3(t),
    p: [r3(pos.x), r3(pos.y), r3(pos.z)],
    q: [r3(ori.x), r3(ori.y), r3(ori.z), r3(ori.w)],
    tracking: trackingState,
    pts,
    ...(dpts ? { dpts } : {}),
  });
  rec.lines.push(line);
  rec.pending += line;
  rec.pendingFrames++;
  rec.frames++;
  rec.points += pts.length;

  if (kfOn && !rec.kfStopped) maybeKeyframe(pose, t);

  if (rec.pendingFrames >= FLUSH_EVERY_FRAMES) flush();
  renderStatus();
}

// Grab a camera photo when the gate says we've moved/turned enough and aren't swinging.
// Runs inside the XR frame (the camera texture is only valid there); encoding + storage are async.
function maybeKeyframe(pose, t) {
  const view = pose.views[0];
  const cam = view.camera;
  if (!cam) {
    rec.kfNoCamera++;
    return;
  }
  const tf = view.transform;
  const p = [tf.position.x, tf.position.y, tf.position.z];
  const q = [tf.orientation.x, tf.orientation.y, tf.orientation.z, tf.orientation.w];
  if (rec.kfPending >= 2 || !rec.kfGate.check(t, p, q)) return; // don't pile up encodes

  const t0 = performance.now();
  let shot = null;
  try {
    shot = kfGrabber.grab(kfBinding, cam);
  } catch (err) {
    rec.kfStopped = true;
    say(`Keyframes stopped: ${err.message}`, 'warn');
  } finally {
    renderer.resetState(); // we changed GL state behind three.js's back
  }
  if (!shot) return;
  const ms = performance.now() - t0;
  rec.kfMs = rec.kfMs ? rec.kfMs + 0.3 * (ms - rec.kfMs) : ms;
  rec.kfGate.taken(t, p, q);

  const name = `kf_${String(rec.keyframes).padStart(4, '0')}.jpg`;
  rec.keyframes++;
  const K = intrinsicsFromProjection(view.projectionMatrix, shot.w, shot.h);
  const meta = {
    type: 'keyframe',
    t: r3(t),
    p: p.map(r3),
    q: q.map((v) => Math.round(v * 1e5) / 1e5),
    intrinsics: Object.fromEntries(Object.entries(K).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    img: name,
  };
  const r = rec;
  r.kfPending++;
  encodeJpeg(shot.px, shot.w, shot.h, KF_JPEG_Q)
    .then((blob) => store.putKeyframe(r.header.session_id, name, blob))
    .then((ok) => {
      if (!ok) {
        r.kfStopped = true;
        say('Phone storage full: photos stopped (the scan itself continues).', 'warn');
        return;
      }
      const line = toLine(meta); // written only once the photo is safely stored
      r.lines.push(line);
      r.pending += line;
    })
    .catch((err) => say(`Photo failed: ${err.message}`, 'warn'))
    .finally(() => r.kfPending--);
}

// ---- live hint: one instruction at a time, most urgent first ----
function showHint(kind, text, detail = '') {
  ui.hint.hidden = false;
  ui.hint.className = kind;
  ui.hint.innerHTML = '';
  ui.hint.append(text);
  if (detail) {
    const s = document.createElement('small');
    s.textContent = detail;
    ui.hint.append(s);
  }
}

// Camera pitch in degrees: viewer forward (0,0,-1) rotated by q; negative = looking down.
function pitchDeg({ x, y, z, w }) {
  const fy = -2 * (y * z - w * x);
  return THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, fy))));
}

function updateHint(ori) {
  const r = rec.recent;
  const t = r.at(-1).t;
  const span = r.length > 1 ? t - r[0].t : 0;
  const hits = r.reduce((n, f) => n + f.hits, 0);
  const walls = r.reduce((n, f) => n + f.walls, 0);
  if (walls) rec.lastObstacleT = t;
  const speed = span > 0.5 ? Math.hypot(r.at(-1).x - r[0].x, r.at(-1).z - r[0].z) / span : 0;
  const pitch = pitchDeg(ori);

  if (trackingState === 'limited') return showHint('bad', 'Tracking shaky', 'Slow down, more light, aim at textured things');
  if (pitch < -PITCH_LIMIT_DEG) return showHint('warn', 'Tilt the phone up ↑', 'Camera straight ahead, not at the floor, so the rays reach the walls');
  if (pitch > PITCH_LIMIT_DEG) return showHint('warn', 'Tilt the phone down a bit ↓', 'Camera straight ahead');
  if (span < 1) return; // keep the startup hint until we have a window to judge
  if (!hits) return showHint('warn', 'Move side to side ↔', 'ARCore needs to see things shift to find surfaces');
  if (speed > MAX_SPEED) return showHint('warn', 'Slow down', `${speed.toFixed(1)} m/s, aim for under ${MAX_SPEED}`);
  if (t - rec.lastObstacleT > NO_OBSTACLE_NAG_S) {
    return showHint('warn', 'No obstacles seen lately', 'Angle the phone toward the edges (tables, walls, shelves)');
  }
  showHint('ok', 'Looking good ✓', walls ? `${walls} obstacle hits in the last ${HINT_WINDOW_S} s` : 'Floor only right now, that’s fine');
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
  ui.hint.hidden = true;
  ui.stop.hidden = true;
  ui.start.hidden = false;
  ui.start.disabled = false;

  if (rec) {
    for (let i = 0; i < 30 && rec.kfPending > 0; i++) await new Promise((r) => setTimeout(r, 100)); // let photos finish
    const statsLine = toLine({
      type: 'stats',
      frames: rec.frames,
      points: rec.points,
      ray_tries: rec.rayTries,
      ray_hits: rec.rayHits,
      depth_frames: rec.depthFrames,
      depth_points: rec.depthPoints,
      keyframes: rec.keyframes,
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
    const photos = done.keyframes ? `, ${done.keyframes} photos` : '';
    say(done.frames ? `Scan ${id} saved on phone (${done.frames} frames${photos}).` : 'Scan was empty.', done.frames ? '' : 'warn');
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
      await uploadKeyframes(id);
      return true;
    } catch (err) {
      say(`Upload failed: ${err.message}`, 'warn');
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  say('Upload failed 3 times. Scan is still on the phone: try again later, or Download and copy over USB.', 'bad');
  return false;
}

// One PUT per photo, skipping ones the server already has, so a flaky upload resumes.
async function uploadKeyframes(id) {
  const kfs = await store.listKeyframes(id);
  if (!kfs.length) return true;
  let have = new Set();
  try {
    const res = await fetch(`${SERVER}/api/scans/${id}/kf`);
    if (res.ok) have = new Set(await res.json());
  } catch {}
  const todo = kfs.filter((k) => !have.has(k.name));
  let sent = 0;
  for (const k of todo) {
    say(`Uploading photos ${sent + 1}/${todo.length}…`);
    try {
      const res = await fetch(`${SERVER}/api/scans/${id}/kf/${k.name}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: k.blob });
      if (!res.ok) throw new Error(`${res.status}`);
      sent++;
    } catch (err) {
      say(`Photo upload stopped at ${sent}/${todo.length} (${err.message}). Tap ⬆ again later to resume.`, 'warn');
      return false;
    }
  }
  say(`Uploaded ${kfs.length} photos for ${id}.`);
  return true;
}

// Photos to the phone's Downloads (the USB fallback when the tunnel is down).
async function downloadKeyframes(id) {
  const kfs = await store.listKeyframes(id);
  for (const k of kfs) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(k.blob);
    a.download = `scan-${id}-${k.name}`;
    document.body.append(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 300)); // Chrome blocks rapid-fire downloads
  }
  say(`Downloaded ${kfs.length} photos.`);
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
            await store.deleteKeyframes(s.session_id);
            refreshSaved();
          }
        }),
      );
      store.countKeyframes(s.session_id).then((n) => {
        if (!n) return;
        name.textContent += ` · ${n} photos`;
        row.insertBefore(mk('⬇img', () => downloadKeyframes(s.session_id)), row.lastChild);
      });
      return row;
    }),
  );
  if (!sessions.length) ui.saved.textContent = 'none yet';
}

// ---- wiring ----
// An error after the session starts would leave a frozen AR view with no frame loop.
ui.start.onclick = () =>
  startScan().catch((err) => {
    console.error(err);
    session?.end();
    say(`Start failed: ${err.message}`, 'bad');
  });
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
  detectedDevice = await guessDevice();
  ui.device.placeholder = detectedDevice === 'unknown' ? 'e.g. Galaxy S23' : detectedDevice;
  ui.start.disabled = false;
  renderStatus();
}

init().catch((err) => say(`Startup error: ${err.message}`, 'bad'));
