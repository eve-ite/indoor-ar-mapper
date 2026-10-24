// Phase 2 camera test: can this phone give us camera photos + pose + intrinsics during immersive-ar,
// flag-free? Raw WebGL2 (no three.js) so nothing hides what the browser does.
import { r3 } from '../common/jsonl.js';

const MAX_W = 1280; // read back at most this wide (smaller = cheaper readPixels + JPEG)
const JPEG_Q = 0.8;

const $ = (id) => document.getElementById(id);
const say = (t, kind = '') => {
  $('msg').textContent = t;
  $('msg').className = kind;
};

// ---- checklist ----
const CHECKS = [
  ['secure', 'Secure context (HTTPS)'],
  ['xr', 'navigator.xr present'],
  ['ar', "immersive-ar supported"],
  ['binding', 'XRWebGLBinding available'],
  ['session', 'AR session started'],
  ['granted', "'camera-access' granted (enabledFeatures)"],
  ['viewCamera', 'XRView.camera present'],
  ['image', 'getCameraImage() returns a texture'],
  ['readback', 'Pixels read back (shader copy + readPixels)'],
  ['jpeg', 'JPEG encoded'],
  ['hit', 'Hit test (for the red-dot check)'],
  ['fps', 'AR frame rate'],
  ['gum', 'getUserMedia during AR'],
];
const results = {};
const ICON = { pass: '✓', fail: '✗', warn: '!', pending: '·' };

function setCheck(key, state, detail = '') {
  results[key] = { state, detail };
  renderChecks();
}

function renderChecks() {
  $('checks').replaceChildren(
    ...CHECKS.map(([key, label]) => {
      const r = results[key] || { state: 'pending', detail: '' };
      const li = document.createElement('li');
      li.className = r.state;
      li.innerHTML = '<span class="i"></span><span class="l"></span>';
      li.querySelector('.i').textContent = ICON[r.state];
      li.querySelector('.l').textContent = label;
      if (r.detail) {
        const d = document.createElement('span');
        d.className = 'd';
        d.textContent = r.detail;
        li.append(d);
      }
      return li;
    }),
  );
}

// ---- state ----
let session = null, gl = null, binding = null, refSpace = null, hitSource = null;
let prog = null, fbo = null, fboTex = null, fboSize = [0, 0];
let captureRequested = false;
let latestHit = null; // world [x, y, z] of the centre hit
let frames = 0, fps = 0, lastT = null, framesWithCamera = 0, cameraSize = null;
const keyframes = []; // { meta, blob, url }
const env = { ua: navigator.userAgent, at: new Date().toISOString() };

// ---- GL: fullscreen triangle sampling the camera texture ----
function buildProgram() {
  const vs = `#version 300 es
    out vec2 uv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      uv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision mediump float;
    in vec2 uv;
    uniform sampler2D cam;
    out vec4 color;
    void main() { color = vec4(texture(cam, uv).rgb, 1.0); }`;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

function ensureFbo(w, h) {
  if (fbo && fboSize[0] === w && fboSize[1] === h) return;
  if (fbo) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(fboTex);
  }
  fboTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
  fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  fboSize = [w, h];
}

// ---- intrinsics (explainer formulas; image aligned with the view) ----
function intrinsics(P, w, h) {
  return {
    fx: (P[0] * w) / 2,
    fy: (P[5] * h) / 2,
    cx: ((1 - P[8]) * w) / 2,
    cy: h - ((1 - P[9]) * h) / 2, // top-left image rows (JPEG/OpenCV); GL's cy is from the bottom
    skew: (P[4] * w) / 2,
    w,
    h,
  };
}

// World point -> pixel (top-left origin) in the captured image, or null if behind the camera.
function project(world, viewMatrix, K) {
  const m = new DOMMatrix(Array.from(viewMatrix)).inverse(); // world -> camera
  const c = m.transformPoint(new DOMPoint(world[0], world[1], world[2], 1));
  if (c.z >= 0) return null; // camera looks down -Z
  const u = K.fx * (c.x / -c.z) + K.cx;
  const v = K.cy - K.fy * (c.y / -c.z);
  return [u, v];
}

// ---- session ----
async function start() {
  $('start').disabled = true;
  say('');
  try {
    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true });
    if (!gl) throw new Error('no WebGL2');
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['camera-access', 'hit-test', 'dom-overlay'],
      domOverlay: { root: $('overlay') },
    });
  } catch (err) {
    setCheck('session', 'fail', err.message);
    $('start').disabled = false;
    return;
  }
  setCheck('session', 'pass');
  const enabled = session.enabledFeatures;
  if (!enabled) setCheck('granted', 'warn', 'enabledFeatures not exposed; see XRView.camera row');
  else setCheck('granted', enabled.includes('camera-access') ? 'pass' : 'fail', `enabled: ${[...enabled].join(', ')}`);

  document.body.classList.add('in-ar');
  session.addEventListener('end', onEnd);
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  refSpace = await session.requestReferenceSpace('local-floor');
  try {
    binding = new XRWebGLBinding(session, gl);
  } catch (err) {
    binding = null;
    setCheck('binding', 'fail', err.message);
  }
  try {
    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });
  } catch (err) {
    setCheck('hit', 'fail', err.message);
  }
  try {
    prog = buildProgram();
  } catch (err) {
    setCheck('readback', 'fail', err.message);
  }
  frames = framesWithCamera = 0;
  session.requestAnimationFrame(onFrame);
}

function onFrame(time, frame) {
  session.requestAnimationFrame(onFrame);
  if (lastT !== null) fps = fps ? fps + 0.05 * (1000 / (time - lastT) - fps) : 1000 / (time - lastT);
  lastT = time;
  frames++;

  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;
  const view = pose.views[0];
  const camera = 'camera' in view ? view.camera : undefined;
  if (camera) {
    framesWithCamera++;
    cameraSize = [camera.width, camera.height];
    if (!results.viewCamera || results.viewCamera.state !== 'pass') setCheck('viewCamera', 'pass', `${camera.width}×${camera.height} texels`);
  } else if (frames === 90) {
    setCheck('viewCamera', 'fail', camera === undefined ? 'XRView has no camera attribute (API missing)' : 'view.camera is null');
  }

  if (hitSource) {
    const r = frame.getHitTestResults(hitSource);
    const hp = r.length && r[0].getPose(refSpace);
    latestHit = hp ? [hp.transform.position.x, hp.transform.position.y, hp.transform.position.z] : null;
    if (latestHit && (!results.hit || results.hit.state !== 'pass')) setCheck('hit', 'pass');
  }
  if (frames % 60 === 0) setCheck('fps', fps >= 25 ? 'pass' : 'warn', `${fps.toFixed(0)} fps (with camera-access ${camera ? 'on' : 'off'})`);

  if (captureRequested) {
    captureRequested = false;
    if (!camera || !binding || !prog) {
      say('Can’t capture: ' + (!camera ? 'no XRView.camera' : !binding ? 'no XRWebGLBinding' : 'shader failed'), 'bad');
    } else {
      captureNow(view, camera, layer);
    }
  }

  $('live').textContent =
    `fps ${fps.toFixed(0)}  camera ${cameraSize ? cameraSize.join('×') : 'none'} (${framesWithCamera}/${frames} frames)\n` +
    `hit ${latestHit ? latestHit.map((v) => v.toFixed(2)).join(', ') : 'none (move a bit)'}\n` +
    `keyframes ${keyframes.length}`;
}

// Runs inside the XR frame: the camera texture is only valid here.
function captureNow(view, camera, layer) {
  const t0 = performance.now();
  let tex;
  try {
    tex = binding.getCameraImage(camera);
  } catch (err) {
    setCheck('image', 'fail', err.message);
    return;
  }
  if (!tex) {
    setCheck('image', 'fail', 'returned null');
    return;
  }
  setCheck('image', 'pass');

  const W = camera.width, H = camera.height;
  const w = Math.min(W, MAX_W), h = Math.round((H * w) / W);
  ensureFbo(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(gl.getUniformLocation(prog, 'cam'), 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const err = gl.getError();
  const readMs = performance.now() - t0;
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  const vp = layer.getViewport(view);
  gl.viewport(vp.x, vp.y, vp.width, vp.height);
  if (err) {
    setCheck('readback', 'fail', `GL error 0x${err.toString(16)}`);
    return;
  }
  let sum = 0;
  for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
  setCheck('readback', sum > 0 ? 'pass' : 'warn', `${readMs.toFixed(1)} ms for ${w}×${h}${sum > 0 ? '' : ' (image is all black?)'}`);

  const K = intrinsics(view.projectionMatrix, w, h);
  const tf = view.transform;
  const meta = {
    type: 'keyframe',
    name: `kf_${String(keyframes.length).padStart(4, '0')}.jpg`,
    t: r3(performance.now() / 1000),
    p: [tf.position.x, tf.position.y, tf.position.z].map(r3),
    q: [tf.orientation.x, tf.orientation.y, tf.orientation.z, tf.orientation.w].map((v) => Math.round(v * 1e5) / 1e5),
    matrix: Array.from(tf.matrix).map((v) => Math.round(v * 1e5) / 1e5), // camera-to-world, column-major
    projection: Array.from(view.projectionMatrix).map((v) => Math.round(v * 1e5) / 1e5),
    intrinsics: Object.fromEntries(Object.entries(K).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    camera_texels: [W, H],
    readback_ms: r3(readMs),
    hit_world: latestHit && latestHit.map(r3),
  };
  meta.hit_px = latestHit ? project(latestHit, tf.matrix, K) : null;
  encode(px, w, h, meta); // async, outside the frame
}

async function encode(px, w, h, meta) {
  const t0 = performance.now();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row); // GL rows are bottom-up
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', JPEG_Q));
  meta.encode_ms = r3(performance.now() - t0);
  meta.bytes = blob.size;
  setCheck('jpeg', 'pass', `${(blob.size / 1024).toFixed(0)} KB, ${meta.encode_ms.toFixed(0)} ms`);
  keyframes.push({ meta, blob, url: URL.createObjectURL(blob) });
  say(`Captured ${meta.name}`, 'ok');
  renderKeyframes();
}

function renderKeyframes() {
  $('kfs').replaceChildren(
    ...keyframes
      .slice()
      .reverse()
      .map(({ meta, url }) => {
        const card = document.createElement('div');
        card.className = 'kf';
        const wrap = document.createElement('div');
        wrap.className = 'img';
        const img = document.createElement('img');
        img.src = url;
        wrap.append(img);
        if (meta.hit_px) {
          const dot = document.createElement('div');
          dot.className = 'dot';
          dot.style.left = `${(100 * meta.hit_px[0]) / meta.intrinsics.w}%`;
          dot.style.top = `${(100 * meta.hit_px[1]) / meta.intrinsics.h}%`;
          wrap.append(dot);
        }
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify({ ...meta, matrix: '…', projection: '…' }, null, 1);
        card.append(wrap, pre);
        return card;
      }),
  );
}

async function tryGetUserMedia() {
  setCheck('gum', 'pending', 'trying…');
  const before = frames;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const s = stream.getVideoTracks()[0]?.getSettings() || {};
    stream.getTracks().forEach((t) => t.stop());
    await new Promise((r) => setTimeout(r, 1500));
    const alive = session && frames > before + 10;
    setCheck('gum', 'warn', `granted ${s.width}×${s.height}; AR ${alive ? 'kept running' : 'STALLED or ended'}`);
  } catch (err) {
    setCheck('gum', 'fail', `${err.name}: ${err.message}`);
  }
}

function onEnd() {
  session = null;
  hitSource = null;
  document.body.classList.remove('in-ar');
  $('start').disabled = false;
  $('upload').disabled = false;
  renderKeyframes();
}

// ---- send results (+ keyframes) to the laptop server ----
async function upload() {
  const id = `camtest_${Date.now()}`;
  const server = (new URLSearchParams(location.search).get('server') || '').replace(/\/$/, '');
  const put = async (name, body, type) => {
    const r = await fetch(`${server}/api/camtest/${id}/${name}`, { method: 'PUT', headers: { 'Content-Type': type }, body });
    if (!r.ok) throw new Error(`${name}: ${r.status}`);
  };
  try {
    say('Sending…');
    const report = { env, cameraSize, fps: r3(fps), results, keyframes: keyframes.map((k) => k.meta) };
    await put('report.json', JSON.stringify(report, null, 1), 'application/json');
    for (const k of keyframes) await put(k.meta.name, k.blob, 'image/jpeg');
    say(`Sent ${keyframes.length} keyframes as ${id} ✓`, 'ok');
  } catch (err) {
    say(`Send failed: ${err.message}`, 'bad');
  }
}

// ---- init ----
$('start').onclick = () => start().catch((e) => say(e.message, 'bad'));
$('capture').onclick = () => {
  captureRequested = true;
};
$('gum').onclick = tryGetUserMedia;
$('stop').onclick = () => session?.end();
$('upload').onclick = upload;

async function init() {
  renderChecks();
  setCheck('secure', window.isSecureContext ? 'pass' : 'fail', window.isSecureContext ? '' : 'open via the https tunnel URL');
  setCheck('binding', 'XRWebGLBinding' in window ? 'pass' : 'fail', 'XRWebGLBinding' in window ? '' : 'needed for getCameraImage');
  if (!navigator.xr) return setCheck('xr', 'fail', 'needs Chrome on Android');
  setCheck('xr', 'pass');
  const ok = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  setCheck('ar', ok ? 'pass' : 'fail');
  $('start').disabled = !ok;
}
init();
