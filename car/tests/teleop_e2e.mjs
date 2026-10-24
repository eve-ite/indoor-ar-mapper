// Browser end-to-end: real teleop page in headless Chrome, real server, mock car.
// Holds W (real key events via DevTools), checks the mock moves, then closes the tab and times
// the mock's stop. Run from the repo root:  node car/tests/teleop_e2e.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PY = path.join(ROOT, 'server', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8791, CDP = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failed = 0;

function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  p.events = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('{')) try { p.events.push(JSON.parse(line)); } catch {}
    }
  });
  procs.push(p);
  return p;
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

async function main() {
  if (!existsSync(PY)) throw new Error(`no venv python at ${PY}; run uv sync in server/`);
  run(PY, ['-m', 'uvicorn', 'main:app', '--port', String(PORT), '--log-level', 'warning'], { cwd: path.join(ROOT, 'server') });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/teleop/`).catch(() => null))?.ok, 10000);
  const mock = run(PY, [path.join(ROOT, 'car', 'mock_car.py'), '--url', `ws://127.0.0.1:${PORT}/car`, '--wall', '2']);
  await waitFor(() => mock.events.some((e) => e.event === 'connected'), 10000);

  run(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${process.env.TEMP || '/tmp'}/teleop-e2e`, 'about:blank']);
  const targets = await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP}/json`).catch(() => null))?.json(), 10000);
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg.result), pending.delete(msg.id);
  };
  const cdp = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/teleop/` });
  const carOk = await waitFor(() => evalJs(`document.getElementById('carPill').className.includes('ok')`), 8000);
  check('teleop shows server + car connected', !!carOk);

  const steps = () => evalJs(`+document.getElementById('ls').textContent || 0`);
  const s0 = await steps();
  const key = (type) => cdp('Input.dispatchKeyEvent', { type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await key('keyDown');
  await sleep(1200);
  const s1 = await steps();
  check('holding W drives the mock forward', s1 - s0 > 500, `left steps ${s0} -> ${s1}`);
  const moving = mock.events.filter((e) => e.event === 'move').length > 0;
  check('mock reported moving', moving);

  const tUp = Date.now() / 1000; // before sending: the stop can land before CDP acks the key
  await key('keyUp');
  const stopUp = await waitFor(() => mock.events.find((e) => e.event === 'stop' && e.t >= tUp), 2000);
  check('releasing W stops the car', !!stopUp && stopUp.t - tUp < 0.35, stopUp ? `${Math.round((stopUp.t - tUp) * 1000)} ms (${stopUp.reason})` : 'no stop');

  await key('keyDown');
  await sleep(600);
  const tClose = Date.now() / 1000;
  await fetch(`http://127.0.0.1:${CDP}/json/close/${page.id}`);
  const stopClose = await waitFor(() => mock.events.find((e) => e.event === 'stop' && e.t >= tClose), 2000);
  check('closing the tab stops the car', !!stopClose && stopClose.t - tClose < 0.35, stopClose ? `${Math.round((stopClose.t - tClose) * 1000)} ms (${stopClose.reason})` : 'no stop');
}

main()
  .catch((e) => {
    console.error(e);
    failed++;
  })
  .finally(() => {
    for (const p of procs) p.kill();
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    setTimeout(() => process.exit(failed ? 1 : 0), 300);
  });
