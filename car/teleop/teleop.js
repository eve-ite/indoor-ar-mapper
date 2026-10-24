// Teleop: keyboard / touch joystick -> {"type":"drive","v","w","seq"} over /drive at ~20 Hz.
// v: forward +, w: turn left (counter-clockwise) +. Both -1..1.
// Stops are sent on key release, blur, tab hidden and page hide; the car's own 300 ms deadman
// covers anything that slips through (frozen tab, dropped network, dead server).

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

function send(v, w) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'drive', v: round(v), w: round(w), seq: ++seq }));
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
  const stale = carUp && performance.now() - lastTelemetry > TELEMETRY_STALE_MS;
  $('carPill').className = `pill ${carUp ? (stale ? 'warn' : 'ok') : ''}`;
  $('carPill').textContent = !carUp ? 'car offline' : stale ? 'car silent' : 'car';
}
setInterval(renderPills, 500);

function renderTelemetry(t) {
  const blocked = t.blocked ?? t.dist_cm < 15;
  $('dist').textContent = t.dist_cm == null ? '–' : `${t.dist_cm.toFixed(1)} cm`;
  $('distBox').classList.toggle('bad', !!blocked);
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
