// Teleop: keyboard / touch joystick -> {"type":"drive","v","w","seq"} at ~20 Hz.
// v: forward +, w: turn left (counter-clockwise) +. Both -1..1.
// Two links to the car:
//   Bluetooth (primary): direct to the car with Web Bluetooth, no server involved.
//   Server (secondary):  WebSocket /drive -> server relay -> car's WiFi WebSocket.
// When Bluetooth is connected it carries the commands; otherwise the server link does.
// Stops are sent on key release, blur, tab hidden and page hide; the car's own 300 ms deadman
// (and its stop-on-disconnect) covers anything that slips through.
import { BleCar, bleSupported } from './ble.js';

const SEND_HZ = 20;
const TELEMETRY_STALE_MS = 1000;

const params = new URLSearchParams(location.search);
// Optional server override, e.g. ?server=https://xyz.trycloudflare.com
const base = params.get('server') ? new URL(params.get('server')) : location;
const WS_URL = `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/drive`;

const $ = (id) => document.getElementById(id);

// ---- connection ----
let ws = null;
let serverUp = false;
let carUp = false;
let lastTelemetry = 0;
let seq = 0;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    serverUp = true;
    renderPills();
  };
  ws.onclose = () => {
    serverUp = false;
    carUp = false;
    renderPills();
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'car_status') {
      carUp = !!msg.connected;
      renderPills();
    } else if (msg.type === 'telemetry') {
      lastTelemetry = performance.now();
      carUp = true;
      renderTelemetry(msg);
    }
  };
}

// ---- Bluetooth link ----
const ble = new BleCar({
  onLine: (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === 'telemetry') {
      lastTelemetry = performance.now();
      renderTelemetry(msg);
    }
  },
  onDisconnect: () => {
    $('bleBtn').textContent = 'Connect Bluetooth';
    renderPills();
  },
});

$('bleBtn').addEventListener('click', async () => {
  if (ble.connected) return ble.disconnect();
  if (!bleSupported()) {
    $('bleNote').textContent = 'No Web Bluetooth in this browser: use Chrome or Edge (Brave disables it).';
    return;
  }
  $('bleNote').textContent = 'pick "mapper-car"…';
  try {
    await ble.connect();
    $('bleBtn').textContent = 'Disconnect Bluetooth';
    $('bleNote').textContent = '';
  } catch (err) {
    $('bleNote').textContent = `Bluetooth: ${err.message}`;
  }
  renderPills();
});

// Live top-speed tuning: the car clamps it to 50..1200 and remembers it.
$('rateBtn').addEventListener('click', () => {
  const msg = { type: 'set' };
  for (const [id, key] of [['rate', 'max_step_rate'], ['accel', 'accel'], ['decel', 'decel']]) {
    const x = parseFloat($(id).value);
    if (x > 0) msg[key] = x;
  }
  if (Object.keys(msg).length === 1) return;
  const line = JSON.stringify(msg);
  if (ble.connected) ble.send(line);
  else if (ws?.readyState === WebSocket.OPEN) ws.send(line);
});

function send(v, w) {
  const line = JSON.stringify({ type: 'drive', v: round(v), w: round(w), seq: ++seq });
  if (ble.connected) ble.send(line);
  else if (ws?.readyState === WebSocket.OPEN) ws.send(line);
}

const round = (x) => Math.round(x * 1000) / 1000;

// ---- input: keys + joystick -> (v, w) ----
const KEYS = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
const held = new Set();
let joy = null; // {v, w} while the joystick is held

function command() {
  const speed = parseFloat($('speed').value);
  if (joy) return { v: joy.v * speed, w: joy.w * speed };
  const v = (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0);
  const w = (held.has('left') ? 1 : 0) - (held.has('right') ? 1 : 0);
  return { v: v * speed, w: w * speed };
}

const active = () => joy !== null || held.size > 0;

// Send while input is held; when it's released, send a few stops (cheap insurance on a lossy link).
let stopsToSend = 0;
setInterval(() => {
  if (active()) {
    const { v, w } = command();
    send(v, w);
  } else if (stopsToSend > 0) {
    send(0, 0);
    stopsToSend--;
  }
  renderCmd();
}, 1000 / SEND_HZ);

function stopNow() {
  held.clear();
  joy = null;
  resetKnob();
  send(0, 0);
  stopsToSend = 3;
  renderKeys();
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    return stopNow();
  }
  const k = KEYS[e.code];
  if (!k) return;
  e.preventDefault();
  if (!held.has(k)) {
    held.add(k);
    const { v, w } = command();
    send(v, w); // respond immediately, don't wait for the next tick
    renderKeys();
  }
});
window.addEventListener('keyup', (e) => {
  const k = KEYS[e.code];
  if (!k) return;
  held.delete(k);
  if (!active()) stopNow();
  else renderKeys();
});
window.addEventListener('blur', stopNow);
document.addEventListener('visibilitychange', () => document.hidden && stopNow());
window.addEventListener('pagehide', stopNow);
$('stop').addEventListener('pointerdown', stopNow);
$('speed').addEventListener('input', () => ($('speedV').textContent = `${Math.round($('speed').value * 100)}%`));

// Touch/mouse joystick: up = forward, left = turn left.
const pad = $('joy'), knob = $('knob');
function joyFrom(e) {
  const r = pad.getBoundingClientRect();
  const R = r.width / 2;
  let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
  const m = Math.hypot(dx, dy);
  if (m > 1) (dx /= m), (dy /= m);
  knob.style.transform = `translate(${dx * (R - 35)}px, ${dy * (R - 35)}px)`;
  const dead = (x) => (Math.abs(x) < 0.12 ? 0 : x);
  joy = { v: dead(-dy), w: dead(-dx) };
}
function resetKnob() {
  knob.style.transform = '';
}
pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  joyFrom(e);
});
pad.addEventListener('pointermove', (e) => joy && joyFrom(e));
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  pad.addEventListener(ev, () => joy && stopNow());
}

// ---- rendering ----
function renderPills() {
  $('srvPill').className = `pill ${serverUp ? 'ok' : ''}`;
  $('srvPill').textContent = serverUp ? 'server' : 'server offline';
  const up = ble.connected || carUp;
  const via = ble.connected ? 'Bluetooth' : 'wifi';
  const stale = up && performance.now() - lastTelemetry > TELEMETRY_STALE_MS;
  $('carPill').className = `pill ${up ? (stale ? 'warn' : 'ok') : ''}`;
  $('carPill').textContent = !up ? 'car offline' : stale ? `car silent (${via})` : `car (${via})`;
}
setInterval(renderPills, 500);

function renderTelemetry(t) {
  if (t.max_step_rate != null) {
    const mps = t.steps_per_rev ? (t.max_step_rate / t.steps_per_rev) * Math.PI * 0.065 : null;
    $('rateNow').textContent =
      `car: ${t.step_mode ?? ''} step, ${t.max_step_rate} steps/s${mps ? ` ≈ ${(mps * 100).toFixed(1)} cm/s` : ''}` +
      (t.accel != null ? `, accel ${t.accel}, decel ${t.decel}` : '');
    if (!$('rate').value) $('rate').value = t.max_step_rate;
    if (!$('accel').value && t.accel != null) $('accel').value = t.accel;
    if (!$('decel').value && t.decel != null) $('decel').value = t.decel;
  }
  const blocked = t.blocked ?? t.dist_cm < 15;
  // us: "ok" (distance), "clear" (nothing in range), "no_echo" (sensor missing: no forward protection)
  $('dist').textContent =
    t.dist_cm != null ? `${t.dist_cm.toFixed(1)} cm` : t.us === 'clear' ? 'clear (>4 m)' : t.us === 'no_echo' ? 'NO ECHO: check sensor' : '–';
  $('distBox').classList.toggle('bad', !!blocked || t.us === 'no_echo');
  $('ir').textContent = t.ir_blocked ? 'blocked' : 'clear';
  $('irBox').classList.toggle('bad', !!t.ir_blocked);
  $('ls').textContent = t.left_steps;
  $('rs').textContent = t.right_steps;
  $('yaw').textContent = t.yaw_rate == null ? '–' : `${t.yaw_rate.toFixed(2)} rad/s`;
  $('link').textContent = `${t.rssi ?? '–'} dBm · ${Math.round((t.uptime_ms ?? 0) / 1000)} s`;
}

function renderKeys() {
  for (const k of ['up', 'down', 'left', 'right']) {
    document.querySelector(`#keys .${k}`).classList.toggle('on', held.has(k));
  }
}

function renderCmd() {
  const { v, w } = active() ? command() : { v: 0, w: 0 };
  $('cmd').textContent = `v ${v.toFixed(2)} · w ${w.toFixed(2)}`;
}

connect();
renderPills();
