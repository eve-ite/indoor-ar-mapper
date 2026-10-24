// Chain merge test: split a synthetic scan in two, re-express the second half in its own (slightly
// wrong) session frame, merge, and measure how well the child lands back on the truth.
//   node tools/test_chain.mjs [scans/synthetic_depth.jsonl]
import { readFileSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { apply, compose, invert, mergeChain, poseToT, transformFrame } from '../web/common/chain.js';

const file = process.argv[2] || 'scans/synthetic_depth.jsonl';
const scan = parseScan(readFileSync(file, 'utf8'));
const cut = Math.floor(scan.frames.length * 0.55);

function run(label, err) {
  // The child really starts at truth[0]'s pose. The parent's last recorded pose is where the user
  // *ended* scan A, which differs from where they then stood for scan B by `err` (imperfect mark).
  const truth = scan.frames.slice(cut - 1);
  const S = poseToT(truth[0].p, truth[0].q);
  const Send = compose(S, err.T); // parent's end pose, off by err from the child's true start
  const last = { ...scan.frames[cut - 1] };
  const qy = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  const pitchPart = [last.q[0], last.q[1], last.q[2], last.q[3]];
  // Rewrite only the parent's final frame pose (position + heading) to Send.
  last.p = [Send.tx, last.p[1], Send.tz];
  last.q = ((a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ])(qy(err.T.yaw), pitchPart);
  const parent = { header: { session_id: 'A' }, frames: [...scan.frames.slice(0, cut - 1), last] };
  // Child coordinates are relative to where its session really started (truth[0]).
  const toChild = invert(S);
  const child = {
    header: { session_id: 'B', continues: 'A' },
    frames: truth.map((f) => transformFrame(f, toChild, err.dy, -truth[0].t)),
  };
  const res = {};
  for (const refine of [false, true]) {
    const m = mergeChain([parent, child], { refine });
    const merged = m.frames.slice(parent.frames.length);
    // Error of the child's obstacle-relevant geometry: positions of all its depth points.
    let sum = 0, n = 0;
    merged.forEach((f, i) => {
      (f.dpts || []).forEach((h, j) => {
        const t = truth[i].dpts[j];
        sum += Math.hypot(h[0] - t[0], h[2] - t[2]);
        n++;
      });
    });
    res[refine ? 'refined' : 'marks only'] = { meanErr: +(sum / n).toFixed(3), info: m.links[0].refine && (m.links[0].refine.used ? m.links[0].refine.correction : m.links[0].refine.reason) };
  }
  console.log(label, JSON.stringify(res));
  return res;
}

const deg = Math.PI / 180;
const perfect = run('perfect placement     ', { T: { yaw: 0, tx: 0, tz: 0 }, dy: 0.04 });
const sloppy = run('4° + 15 cm off the mark', { T: { yaw: 4 * deg, tx: 0.15, tz: -0.1 }, dy: 0.04 });
// Marks-only must be exact for a perfect handover. Auto-align is conservative: it must never make
// a placement worse, and must leave a perfect one alone. (On this plain rectangular room the
// overlap is ambiguous along the walls, so we don't demand it fully fixes the sloppy case.)
const ok =
  perfect['marks only'].meanErr < 0.01 &&
  perfect.refined.meanErr < 0.01 &&
  sloppy['marks only'].meanErr > 0.1 &&
  sloppy.refined.meanErr <= sloppy['marks only'].meanErr;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
