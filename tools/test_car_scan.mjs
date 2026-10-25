// M4 car-scan test: a scan from a phone riding on the car (~0.2 m up) must be detected as a car
// scan and give a usable map: walls and the table found, and a route around the table.
//   python tools/make_synthetic.py scans/car_depth.jsonl --depth --car --id car_depth
//   python tools/make_synthetic.py scans/synthetic_depth.jsonl --depth     (handheld, to compare)
//   node tools/test_car_scan.mjs
import { readFileSync } from 'fs';
import { parseScan } from '../web/common/jsonl.js';
import { PROFILES, buildGrid, detectProfile } from '../web/common/grid.js';
import { astar, traversability } from '../web/common/trav.js';

const ROOM = [-2, -4.5, 2, 0.5]; // x0, z0, x1, z1 (make_synthetic.py)
const TABLE = [0.3, -2.8, 1.3, -2.2];

function stats(file) {
  const scan = parseScan(readFileSync(`scans/${file}.jsonl`, 'utf8'));
  const det = detectProfile(scan.frames);
  const g = buildGrid(scan.frames, PROFILES[det.profile]);
  const t = traversability(g);
  const idx = (x, z) => Math.floor((z - g.minZ) / g.cell) * g.w + Math.floor((x - g.minX) / g.cell);
  // Wall coverage: share of 10 cm steps along the room's walls with an obstacle within 10 cm.
  let n = 0, hit = 0;
  const near = (x, z) => {
    for (let dz = -0.1; dz <= 0.1; dz += 0.05) for (let dx = -0.1; dx <= 0.1; dx += 0.05) if (t.occ[idx(x + dx, z + dz)]) return true;
    return false;
  };
  for (let x = ROOM[0] + 0.3; x <= ROOM[2] - 0.3; x += 0.1) for (const z of [ROOM[1], ROOM[3]]) (n++, near(x, z) && hit++);
  for (let z = ROOM[1] + 0.3; z <= ROOM[3] - 0.3; z += 0.1) for (const x of [ROOM[0], ROOM[2]]) (n++, near(x, z) && hit++);
  // Table: from car height only its sides are seen (never the top), so what matters is that
  // routing can't go through it: obstacle faces + never-seen-through inside = blocked.
  let tn = 0, tblocked = 0;
  for (let x = TABLE[0] + 0.1; x < TABLE[2] - 0.05; x += 0.05) for (let z = TABLE[1] + 0.1; z < TABLE[3] - 0.05; z += 0.05) (tn++, !isFinite(t.cost[idx(x, z)]) && tblocked++);
  // Route from the start marker to the far corner, around the table.
  const path = astar(t.cost, g.w, g.h, idx(0, -0.2), idx(-1.2, -3.8));
  return { profile: det.profile, height: +det.phoneHeight.toFixed(2), walls: +(hit / n).toFixed(2), tableBlocked: +(tblocked / tn).toFixed(2), route: !!path };
}

const car = stats('car_depth');
const hand = stats('synthetic_depth');
console.log('car     ', JSON.stringify(car));
console.log('handheld', JSON.stringify(hand));
const ok =
  car.profile === 'car' &&
  Math.abs(car.height - 0.2) < 0.05 &&
  hand.profile === 'person' &&
  car.walls > 0.6 && // the walls are mapped from car height too
  car.tableBlocked > 0.95 && // the car can't be routed through the table
  car.route;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
