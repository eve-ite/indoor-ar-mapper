// M5 nav core tests: lining a session up with a map, nav walks joining the map, routing, turns.
//   node tools/test_nav.mjs            (uses the real venue chain in scans/ when present, else synthetic)
import { readFileSync, existsSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { mergeMap, transformFrame, apply, invert } from '../web/common/chain.js';
import { buildNavMap, sessionToMap, planRoute, turnList, progressOn, nextTurn, stepsText, startMarks } from '../web/nav/navcore.js';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  ' + info : ''}`);
  if (!ok) failed++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- data: the real 4-scan venue chain if it's here, else the synthetic two-scan chain ----
const REAL = ['a25f7d7c6706', '1e190cf47e68', 'e7edc9e23c68', '399e2d5113f6'];
const SYN = ['chain_a', 'chain_b'];
const ids = REAL.every((id) => existsSync(`scans/${id}.jsonl`)) ? REAL : SYN;
const scans = ids.map((id) => parseScan(readFileSync(`scans/${id}.jsonl`, 'utf8')));
const nudges = Object.fromEntries(scans.filter((s) => s.header?.continues_nudge).map((s) => [s.header.session_id, s.header.continues_nudge]));
const merged = mergeMap(scans, { nudges });
console.log(`map: ${ids.join(', ')} (${merged.frames.length} frames)`);

let t0 = performance.now();
const nav = buildNavMap(scans, merged);
const buildMs = performance.now() - t0;
check('map builds', !!nav, `${nav.grid.w}x${nav.grid.h} cells, profile ${nav.profile}, ${buildMs.toFixed(0)} ms`);
check('one start marker + one end mark per scan', nav.marks.length === ids.length + 1, nav.marks.map((m) => m.name).join(' | '));

// ---- 1. lining up: a session with its own random origin, standing on each mark ----
const R = { yaw: 1.234, tx: 3.21, tz: -7.65 }; // mark-scan-local -> session (an arbitrary new origin)
const rotQ = (yaw, q) => {
  // yaw about +Y applied to q (same as chain.js qMul(qYaw(yaw), q))
  const [bx, by, bz, bw] = q, ay = Math.sin(yaw / 2), aw = Math.cos(yaw / 2);
  return [aw * bx + ay * bz, aw * by + ay * bw, aw * bz - ay * bx, aw * bw - ay * by];
};
let worst = 0;
for (const m of nav.marks) {
  const [sx, sz] = apply(R, m.local.p[0], m.local.p[2]);
  const sessPose = { p: [sx, m.local.p[1], sz], q: rotQ(R.yaw, m.local.q) };
  const T = sessionToMap(m, sessPose);
  // A point 2 m ahead of the mark in the session must land 2 m ahead of the mark on the map.
  const probe = apply(invert(R), sx + 1.5, sz - 2); // a session point, back in mark-local coords
  const want = apply(m.T, probe[0], probe[1]);
  const got = apply(T, sx + 1.5, sz - 2);
  worst = Math.max(worst, Math.hypot(want[0] - got[0], want[1] - got[1]));
}
// (mm-rounded quaternions in the files leave a few mm of yaw rounding over a 2.5 m lever)
check('session -> map lands on the mark (all marks)', worst < 0.005, `max error ${(worst * 1000).toFixed(1)} mm`);

// Nudges mean the same as the viewer's: rotating about the handover point leaves it in place.
{
  const m = nav.marks.at(-1);
  const sessPose = { p: m.local.p, q: m.local.q };
  const T0 = sessionToMap(m, sessPose), T1 = sessionToMap(m, sessPose, { yawDeg: 10 });
  const a = apply(T0, m.local.p[0], m.local.p[2]), b = apply(T1, m.local.p[0], m.local.p[2]);
  check('yaw nudge pivots on the mark', Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 && near(T1.yaw - T0.yaw, Math.PI / 18, 1e-9));
}

// ---- 2. nav walks join the map ----
// A walk from the last scan's end mark, recorded in a fresh session (frames = a copy of the last
// scan's start, moved into session coords). Saved with continues = that scan, mergeMap must put it
// exactly where sessionToMap said.
{
  const m = nav.marks.at(-1);
  const src = scans.at(-1).frames.slice(0, 40);
  // Pretend the walker walked these poses, relative to the mark: session = R ∘ (mark-local).
  const local0 = src[0];
  const walk = src.map((f) => transformFrame(f, R, 0, 0));
  // Re-base so the walk's first frame is exactly on the mark (the "I'm here" tap).
  const fix = { yaw: 0, tx: 0, tz: 0 };
  const sessMark = apply(R, m.local.p[0], m.local.p[2]);
  const first = walk[0];
  fix.tx = sessMark[0] - first.p[0];
  fix.tz = sessMark[1] - first.p[2];
  const walkS = walk.map((f) => transformFrame(f, fix, 0, 0));
  walkS[0] = { ...walkS[0], q: rotQ(R.yaw, m.local.q) };
  const T = sessionToMap(m, { p: walkS[0].p, q: walkS[0].q });
  const navScan = {
    header: { type: 'header', session_id: 'navtest', continues: m.scan, created: new Date(Date.parse(scans.at(-1).header.created) + 600e3).toISOString(), nav: { mark: m.id } },
    frames: walkS,
    labels: [],
    keyframes: [],
  };
  const merged2 = mergeMap([...scans, navScan], { nudges });
  const placed = merged2.frames.slice(-walkS.length);
  let err = 0;
  walkS.forEach((f, k) => {
    const want = apply(T, f.p[0], f.p[2]);
    err = Math.max(err, Math.hypot(want[0] - placed[k].p[0], want[1] - placed[k].p[2]));
  });
  check('nav walk (continues an end mark) joins the map where nav drew it', err < 0.002, `max ${err.toFixed(4)} m`);
  const marks2 = startMarks([...scans, navScan], merged2);
  check('nav walks add no start marks of their own', marks2.length === nav.marks.length);
  void local0;
}

// ---- 3. routing on the map ----
{
  const a = nav.marks[0].p, b = nav.marks.at(-1).p;
  t0 = performance.now();
  const r = planRoute(nav, a, b);
  const ms = performance.now() - t0;
  check('route from the start marker to the last end mark', !r.error, r.error || `${r.length.toFixed(1)} m, ${r.walkedPct}% walked, ${r.pts.length} corners, ${ms.toFixed(0)} ms`);
  if (!r.error) {
    const straight = Math.hypot(a[0] - b[0], a[1] - b[1]);
    check('route is no shorter than the straight line', r.length >= straight - 0.2, `straight ${straight.toFixed(1)} m`);
    const ti = turnList(r.pts);
    check('turn list ends with arrive', ti.turns.at(-1).kind === 'arrive', `${ti.turns.length - 1} turns`);
    console.log('     ' + stepsText(ti, 'the end mark').join(' / '));
  }
  // Every end mark is reachable from the start marker (the chain is one connected walk).
  const unreachable = nav.marks.filter((m) => planRoute(nav, nav.marks[0].p, m.p).error).map((m) => m.name);
  check('every mark is reachable', !unreachable.length, unreachable.join(', '));
}

// ---- 4. turns and progress on a hand-made L ----
{
  // Walk 5 m along -Z, then 4 m along -X (a left turn, facing -Z), then 3 m along -Z (right).
  const pts = [[0, 0], [0, -5], [-4, -5], [-4, -8]];
  const ti = turnList(pts);
  const kinds = ti.turns.map((t) => t.kind).join(',');
  check('L route: left then right then arrive', kinds === 'left,right,arrive', kinds);
  check('turns at the corners', near(ti.turns[0].s, 5, 0.01) && near(ti.turns[1].s, 9, 0.01));
  const p = progressOn(pts, ti.cum, [0.3, -2]);
  check('progress projects onto the route', near(p.s, 2, 0.01) && near(p.off, 0.3, 0.01));
  const n = nextTurn(ti.turns, p.s);
  check('next turn: left in 3 m', n.kind === 'left' && near(n.in, 3, 0.01));
  const back = progressOn([[0, 0], [0, -5], [1, -5], [1, 0]], turnList([[0, 0], [0, -5], [1, -5], [1, 0]]).cum, [0.2, -1], 0);
  check('a route that doubles back stays on the near leg', back.seg === 0, `seg ${back.seg}`);
  const slight = turnList([[0, 0], [0, -5], [-4, -9]]).turns[0].kind;
  check('a ~27° bend is not a turn, 45° is slight', turnList([[0, 0], [0, -5], [-1, -7]]).turns.length === 1 && slight === 'slight-left', slight);
}

console.log(failed ? `FAIL (${failed})` : 'PASS');
process.exit(failed ? 1 : 0);
