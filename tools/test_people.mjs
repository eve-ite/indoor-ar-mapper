// People test: a person walks across the room (through the scanner's earlier walked path) while
// depth sees them. They must not end up as obstacles, block the walked path, or become walls.
//   python tools/make_synthetic.py scans/person.jsonl   --depth --id person --person --path revisit
//   python tools/make_synthetic.py scans/noperson.jsonl --depth --id noperson --path revisit
//   node tools/test_people.mjs
import { readFileSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { buildGrid } from '../web/common/grid.js';
import { TRAV, traversability } from '../web/common/trav.js';
import { wallMask } from '../web/common/plan.js';

const load = (f) => parseScan(readFileSync(`scans/${f}.jsonl`, 'utf8')).frames;

// The person's path (z = -1.0, x -1.8..1.8) and how much depth actually saw them.
const person = load('person');
let seen = 0;
person.forEach((f) => (f.dpts || []).forEach((h) => { if (Math.abs(h[2] + 1) < 0.3 && h[1] > 0.3 && h[1] < 1.7 && Math.abs(h[0]) < 1.7) seen++; }));

function measure(frames, travOpts = {}) {
  const g = buildGrid(frames);
  const t = traversability(g, travOpts);
  const wm = wallMask(g, t.occ);
  const at = (x, z) => Math.floor((z - g.minZ) / g.cell) * g.w + Math.floor((x - g.minX) / g.cell);
  const frac = (x0, x1, z0, z1, pred) => {
    let n = 0, k = 0;
    for (let x = x0; x < x1; x += 0.05) for (let z = z0; z < z1; z += 0.05) { n++; if (pred(at(x, z))) k++; }
    return +(k / n).toFixed(2);
  };
  return {
    personTrailOcc: frac(-1.5, 1.5, -1.15, -0.85, (i) => t.occ[i]), // obstacle cells left behind
    corridorPassable: frac(-0.15, 0.15, -1.15, -0.85, (i) => t.tier[i] !== TRAV.BLOCKED), // walked path at the crossing
    personAsWall: frac(-1.5, 1.5, -1.15, -0.85, (i) => wm[i]),
    tableBlocked: frac(0.35, 1.25, -2.75, -2.25, (i) => t.tier[i] === TRAV.BLOCKED),
    wallCells: t.occ.reduce((n, v, i) => n + (v && (Math.abs(g.minX + (i % g.w) * g.cell) > 1.8 || g.minZ + ((i / g.w) | 0) * g.cell < -4.3) ? 1 : 0), 0),
  };
}

const base = measure(load('noperson'));
const fixed = measure(person);
const noFix = measure(person, { transientClears: Infinity }); // passer-by rule off
console.log(`depth samples that hit the person: ${seen}`);
console.log('no person (baseline)    ', JSON.stringify(base));
console.log('person, new rules       ', JSON.stringify(fixed));
console.log('person, passer-by rule off', JSON.stringify(noFix));

const ok =
  seen > 30 && // the test is meaningful: depth really saw the person
  (noFix.personTrailOcc > 0.03 || noFix.corridorPassable < 0.8) && // control: without the rule, the person leaves a trail
  fixed.personTrailOcc <= base.personTrailOcc + 0.05 && // trail gone
  fixed.corridorPassable >= 0.95 && // walked path still open
  fixed.personAsWall === 0 &&
  fixed.tableBlocked >= base.tableBlocked - 0.05 && // furniture not eroded
  fixed.wallCells >= base.wallCells * 0.95; // walls not eroded
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
